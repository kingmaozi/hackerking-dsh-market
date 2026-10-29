/**
 * 运行服务：持久化检查点、幂等、revision 冲突、分页、取消与恢复。
 * 状态保存在 ~/.agent-reach/briking/runs/<runId>/，目录 0700、文件 0600。
 */

import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { validatePlan, validateClaim, RUN_STATES, TIER_BUDGETS } from "./contracts.mjs";
import { createBudget, createContext, executeBatch, mergeUsage, statusToCoverage } from "./scheduler.mjs";
import { mergeEvidence, summarizeCoverage } from "./evidence.mjs";
import { expandPlan, TIER_BASE_SEARCH } from "./planner.mjs";
import { deriveExpansionQueries } from "./auto-extend.mjs";
import { createCache, accountScope } from "./cache.mjs";
import { credentialHint } from "./credentials.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";

const PAGE_SIZE = 12;

function runDir(root, runId) {
  return join(root, runId);
}

function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) {
    const err = new Error("runId 格式不合法");
    err.code = "invalid_input";
    throw err;
  }
  return runId;
}

export function createRunService(deps) {
  const {
    registry,
    credentials = {},
    storageRoot = join(homedir(), ".agent-reach", "briking", "runs"),
    now = () => Date.now(),
    availability = {},
    transport = null,
    maxParallelRuns = 2,
    cache = createCache(),
  } = deps;

  const active = new Map();
  // 同一 requestKey 的并发 start 共享同一个在途 Promise，保证幂等不被并发击穿。
  const inflightStarts = new Map();

  function dirFor(runId) {
    return runDir(storageRoot, assertSafeRunId(runId));
  }

  function load(runId) {
    const dir = dirFor(runId);
    const file = join(dir, "snapshot.json");
    if (!existsSync(file)) {
      const err = new Error(`运行不存在: ${runId}`);
      err.code = "invalid_input";
      throw err;
    }
    return JSON.parse(readFileSync(file, "utf8"));
  }

  function save(snapshot) {
    const dir = dirFor(snapshot.runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "snapshot.json");
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    // 相同 revision 也拒绝：并发写（如 cancel 与在途收尾）必须显式处理冲突，不能静默覆盖。
    if (previous && previous.revision >= snapshot.revision) {
      const err = new Error(`revision 冲突：已存在 revision ${previous.revision}（本次写入 ${snapshot.revision}）`);
      err.code = "invalid_input";
      throw err;
    }
    writeJsonAtomic(file, snapshot);
    return snapshot;
  }

  function makeSnapshot(plan, runId) {
    const budget = createBudget(plan.tier, plan.budget);
    const expanded = expandPlan(plan, registry, availability);
    const snapshot = {
      schemaVersion: 1,
      runId,
      revision: 1,
      state: "running",
      tier: plan.tier,
      reason: plan.reason || "",
      query: plan.query,
      costPolicy: plan.costPolicy,
      includeSocial: plan.includeSocial,
      requestedAt: plan.requestedAt,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      rounds: 0,
      pendingTasks: expanded.tasks,
      readFreshness: expanded.readFreshness,
      coverage: expanded.audit,
      usage: { calls: 0, readUrls: 0, byProvider: {} },
      // 实际出站记账（含重试），与 provider 自报 usage 并行维护，取大者做跨轮播种。
      budgetUsed: { calls: 0, readUrls: 0 },
      budgetLimits: budget.limits,
      evidence: [],
      claims: [],
      warnings: [],
      startedAt: now(),
    };
    return snapshot;
  }

  function appendCoverage(snapshot, provider, status, reason = "") {
    const existing = snapshot.coverage.find((c) => c.provider === provider);
    if (existing) {
      existing.status = status;
      // 结果状态不再保留"待执行"占位原因；有真实原因时才覆盖。
      if (existing.status !== "pending" && !reason && existing.reason === "待执行") existing.reason = "";
      else if (reason) existing.reason = reason;
      existing.status = status;
      return;
    }
    snapshot.coverage.push({ provider, status, reason });
  }

  /** provider 自报用量按档位上限截断：误报不能永久挤占后续轮次预算。 */
  function clampOutcomeUsage(out, limits) {
    const usage = out?.usage;
    if (!usage) return out;
    const calls = Number.isFinite(usage.calls) ? Math.min(usage.calls, limits.maxCalls) : 0;
    const readUrls = Number.isFinite(usage.readUrls) ? Math.min(usage.readUrls, limits.maxReadUrls) : 0;
    return { ...out, usage: { ...usage, calls, readUrls } };
  }

  /** 跨轮预算播种：取 provider 自报与实际出站记账的较大者（重试不再漏计）。 */
  function effectiveUsed(snapshot) {
    return {
      calls: Math.max(snapshot.usage?.calls ?? 0, snapshot.budgetUsed?.calls ?? 0),
      readUrls: Math.max(snapshot.usage?.readUrls ?? 0, snapshot.budgetUsed?.readUrls ?? 0),
    };
  }

  async function runBatch(snapshot, tasks, options = {}) {
    const budget = createBudget(snapshot.tier, {});
    budget.limits = { ...snapshot.budgetLimits };
    // 恢复时把已用额度计入，避免 resume 重置预算。
    const used = effectiveUsed(snapshot);
    budget.used.calls = used.calls;
    budget.used.readUrls = used.readUrls;
    budget.used.rounds = snapshot.rounds;
    const controller = new AbortController();
    const ctx = createContext({
      budget,
      signal: controller.signal,
      registry,
      transport,
      credentials,
      now,
      cache,
    });
    const startedAt = now();
    ctx.deadline = startedAt + snapshot.budgetLimits.activeMs;
    active.set(snapshot.runId, { controller, ctx, cancelled: false });

    const evidence = [];
    const warnings = [];
    let outcome = null;
    try {
      outcome = await executeBatch(tasks, ctx, (task, out) => {
        mergeUsage(snapshot.usage, task.provider, clampOutcomeUsage(out, snapshot.budgetLimits));
        appendCoverage(snapshot, task.provider, statusToCoverage(out), out.error?.message || "");
        if (out.warnings?.length) warnings.push(...out.warnings.map((w) => `${task.provider}: ${w}`));
        if (out.evidence?.length) {
          evidence.push(...out.evidence);
          snapshot.evidence = mergeEvidence([...snapshot.evidence, ...out.evidence]);
        }
      }, {
        // 缓存按账号分区：不同凭据的结果互不串用。
        accountScope: (id) => accountScope(id, credentialHint(credentials, id)),
      });
      return { outcome, evidence, warnings, skipped: outcome.skippedTasks };
    } finally {
      // 实际出站记账持久化：跨轮播种时使用，provider 自报少算的重试不再漏计。
      snapshot.budgetUsed = { calls: budget.used.calls, readUrls: budget.used.readUrls };
      const entry = active.get(snapshot.runId);
      if (entry?.cancelled && outcome) outcome.cancelledByUser = true;
      active.delete(snapshot.runId);
    }
  }

  /**
   * 运行在执行期间被取消：把在途批次已产出的证据/警告/用量并入磁盘上的
   * cancelled 快照（不丢数据），但绝不把状态复活成 awaiting_host/partial。
   */
  function mergeIntoCancelled(snapshot) {
    // 与 cancel 的写可能互相冲突：读最新磁盘快照合并，冲突时重试。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const onDisk = load(snapshot.runId);
      onDisk.state = "cancelled";
      onDisk.evidence = mergeEvidence([...(onDisk.evidence || []), ...snapshot.evidence]);
      // 待执行队列同步到内存侧的最新视图（宿主任务保留、已执行任务移除）。
      if (Array.isArray(snapshot.pendingTasks)) onDisk.pendingTasks = snapshot.pendingTasks;
      const mergedWarnings = [...(onDisk.warnings || [])];
      for (const w of snapshot.warnings || []) {
        if (!mergedWarnings.includes(w)) mergedWarnings.push(w);
      }
      onDisk.warnings = mergedWarnings.slice(0, 50);
      onDisk.usage = snapshot.usage;
      onDisk.budgetUsed = snapshot.budgetUsed;
      onDisk.coverage = snapshot.coverage;
      onDisk.revision += 1;
      onDisk.updatedAt = new Date(now()).toISOString();
      try {
        save(onDisk);
        return onDisk;
      } catch (err) {
        if (err.code === "invalid_input" && /revision/.test(err.message)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /** 收尾保存：若运行已被取消则走 mergeIntoCancelled，否则正常落盘。 */
  function finishRound(snapshot, outcome) {
    if (outcome.cancelledByUser) return mergeIntoCancelled(snapshot);
    snapshot.revision += 1;
    snapshot.state = outcome.stoppedEarly ? "partial" : "awaiting_host";
    snapshot.updatedAt = new Date(now()).toISOString();
    snapshot.idleSince = now();
    try {
      save(snapshot);
    } catch (err) {
      // 与并发 cancel 的写冲突：磁盘已是更新状态，按取消合并处理。
      if (err.code === "invalid_input" && /revision/.test(err.message)) {
        const onDisk = load(snapshot.runId);
        if (onDisk.state === "cancelled") return mergeIntoCancelled(snapshot);
      }
      throw err;
    }
    return snapshot;
  }

  async function startOnce(plan, requestKey) {
    const existing = findRunByRequestKey(storageRoot, requestKey);
    if (existing) {
      const snapshot = load(existing);
      if (snapshot.query !== plan.query || snapshot.tier !== plan.tier) {
        const err = new Error("requestKey 已用于不同输入；请使用新的 requestKey");
        err.code = "invalid_input";
        throw err;
      }
      return snapshot;
    }

    const runId = randomUUID();
    const snapshot = makeSnapshot(plan, runId);
    snapshot.requestKey = requestKey;
    save(snapshot);

    // 宿主执行的任务（浏览器 AI 源）不在 MCP 内执行：保留在 pendingTasks 由主会话处理。
    const allTasks = snapshot.pendingTasks;
    const tasks = allTasks.filter((t) => !t.hostExecuted);
    const hostTasks = allTasks.filter((t) => t.hostExecuted);
    snapshot.pendingTasks = hostTasks;
    let { outcome } = await runBatchAndMerge(snapshot, tasks);
    snapshot.rounds = 1;
    if (outcome.stoppedEarly) {
      // 提前停止时保留宿主任务：被跳过的 MCP 任务与浏览器 AI 任务都留在待执行队列。
      snapshot.pendingTasks = [...tasks.filter((t) => outcome.skippedTasks.includes(t.id)), ...hostTasks];
    }

    // 深度档：首轮后自动延伸——从证据提取关键词生成扩展查询，继续跑到
    // 轮次/预算/总时效上限或无新增证据为止。宿主仍可用 advance 追加方向。
    if (snapshot.tier === "deep" && !outcome.stoppedEarly && !outcome.cancelledByUser) {
      outcome = await autoExtendDeep(snapshot, outcome);
    }
    return finishRound(snapshot, outcome);
  }

  /** 一批任务执行并把证据/警告/用量并入快照（rounds 由调用方维护）。 */
  async function runBatchAndMerge(snapshot, tasks) {
    const { outcome, warnings } = await runBatch(snapshot, tasks);
    if (warnings.length) snapshot.warnings.push(...warnings);
    if (outcome.stoppedEarly) {
      snapshot.warnings.push(`运行提前停止: ${outcome.stopReason}（未执行 ${outcome.skipped} 个任务）`);
    }
    return { outcome };
  }

  /** 深度档自动延伸：关键词扩展搜索 + 排名靠前证据的正文读取。 */
  async function autoExtendDeep(snapshot, outcome) {
    const usedQueries = new Set([snapshot.query.trim().toLowerCase().replace(/\s+/g, " ")]);
    snapshot.expansions = [];
    const readBodies = new Set(
      (snapshot.evidence || []).filter((e) => e.excerptType === "body").map((e) => e.canonicalUrl)
    );
    const skipReadDomains = /(^|\.)(x\.com|twitter\.com|weixin\.sogou\.com)$/;
    while (snapshot.rounds < snapshot.budgetLimits.maxRounds) {
      // 总时效：整个 start 共享 activeMs，不给每轮单独重置。
      if (now() - snapshot.startedAt >= snapshot.budgetLimits.activeMs) break;
      const used = effectiveUsed(snapshot);
      if (used.calls + 4 > snapshot.budgetLimits.maxCalls) break;

      const queries = deriveExpansionQueries(snapshot.query, snapshot.evidence, { usedQueries, round: snapshot.rounds + 1 });
      const tasks = buildExpansionTasks(snapshot, queries, readBodies, skipReadDomains);
      if (!tasks.length) break;

      const beforeCount = snapshot.evidence.length;
      snapshot.warnings.push(`深度档自动延伸第 ${snapshot.rounds + 1} 轮：${queries.join("；") || "正文读取"}`);
      snapshot.expansions.push({ round: snapshot.rounds + 1, queries, taskCount: tasks.length });
      const r = await runBatchAndMerge(snapshot, tasks);
      outcome = r.outcome;
      snapshot.rounds += 1;
      for (const t of tasks.filter((t) => t.operation === "read")) {
        for (const u of t.input.urls || []) readBodies.add(u);
      }
      if (outcome.stoppedEarly) {
        snapshot.pendingTasks = [...(snapshot.pendingTasks || []), ...tasks.filter((t) => outcome.skippedTasks.includes(t.id))];
        break;
      }
      if (outcome.cancelledByUser) break;
      // 没有新增证据说明已收敛，不再消耗预算。
      if (snapshot.evidence.length <= beforeCount) {
        snapshot.warnings.push(`第 ${snapshot.rounds} 轮无新增证据，自动延伸收敛停止`);
        break;
      }
    }
    return outcome;
  }

  /** 扩展任务编排：每条查询轮换两个搜索渠道；另读 top 未读 URL 的正文。 */
  function buildExpansionTasks(snapshot, queries, readBodies, skipReadDomains) {
    const pool = ["tavily", "exa", "parallel", "tinyfish", "firecrawl", "weixin"].filter((id) => registry.get(id));
    const tasks = [];
    const round = snapshot.rounds + 1;
    queries.forEach((q, i) => {
      if (!pool.length) return;
      const pair = [pool[(i * 2 + round) % pool.length], pool[(i * 2 + 1 + round) % pool.length]];
      for (const p of new Set(pair)) {
        tasks.push({ id: `auto-r${round}-${p}-${i}`, provider: p, operation: "search", input: { query: q, limit: 5 } });
      }
    });
    // 正文读取：排名靠前、未读过、非社交/跳转域名的 URL，受 readUrls 剩余预算约束。
    const readProvider = ["jina", "tinyfish", "firecrawl"].find((id) => registry.get(id)?.capabilities?.includes("read"));
    if (readProvider) {
      const remaining = snapshot.budgetLimits.maxReadUrls - effectiveUsed(snapshot).readUrls;
      const urls = [];
      for (const e of snapshot.evidence || []) {
        const u = e.canonicalUrl;
        if (!u || readBodies.has(u) || skipReadDomains.test(u)) continue;
        urls.push(u);
        if (urls.length >= Math.min(3, Math.max(0, remaining))) break;
      }
      if (urls.length) {
        tasks.unshift({ id: `auto-r${round}-read`, provider: readProvider, operation: "read", input: { urls } });
      }
    }
    return tasks;
  }

  return {
    cacheStats() {
      return cache.stats();
    },

    describe() {
      // 与 planner/契约保持同源，不再手工维护一份会过期的清单。
      return {
        schemaVersion: 1,
        tiers: {
          fast: { providers: [...TIER_BASE_SEARCH.fast, "x"], concurrency: TIER_BUDGETS.fast.maxConcurrency },
          wide: { providers: [...TIER_BASE_SEARCH.wide, "x"], concurrency: TIER_BUDGETS.wide.maxConcurrency },
          deep: {
            providers: [...TIER_BASE_SEARCH.deep, "x"],
            concurrency: TIER_BUDGETS.deep.maxConcurrency,
            note: "deep 另有按需领域渠道与多轮推进；3.2.0 起不再自动派发浏览器 AI 源",
          },
        },
        storageRoot,
        states: RUN_STATES,
      };
    },

    async start(planInput, requestKey) {
      const plan = validatePlan(planInput);
      if (typeof requestKey !== "string" || !requestKey.trim() || requestKey.length > 128) {
        const err = new Error("requestKey 必须是非空字符串（1–128 字符），用于幂等");
        err.code = "invalid_input";
        throw err;
      }
      const inflight = inflightStarts.get(requestKey);
      if (inflight) return inflight;
      const promise = startOnce(plan, requestKey).finally(() => {
        if (inflightStarts.get(requestKey) === promise) inflightStarts.delete(requestKey);
      });
      inflightStarts.set(requestKey, promise);
      return promise;
    },

    async get(runId, cursor) {
      const snapshot = load(runId);
      const offset = parseCursor(cursor, runId, snapshot.revision);
      const evidence = snapshot.evidence.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + evidence.length;
      // 剩余预算按"provider 自报与实际出站记账"的较大者计算，重试不再隐身。
      const used = effectiveUsed(snapshot);
      return {
        ...snapshot,
        evidence,
        pendingTasks: snapshot.pendingTasks,
        nextCursor: nextOffset < snapshot.evidence.length ? encodeCursor(runId, snapshot.revision, nextOffset) : null,
        remaining: {
          remainingCalls: Math.max(0, snapshot.budgetLimits.maxCalls - used.calls),
          remainingReadUrls: Math.max(0, snapshot.budgetLimits.maxReadUrls - used.readUrls),
          remainingRounds: Math.max(0, snapshot.budgetLimits.maxRounds - snapshot.rounds),
        },
        coverageSummary: summarizeCoverage(snapshot.evidence, snapshot.coverage),
      };
    },

    async advance(runId, revision, tasks, claims, requestKey) {
      const snapshot = load(runId);
      if (snapshot.revision !== revision) {
        const err = new Error(`revision 不匹配：当前 ${snapshot.revision}，收到 ${revision}`);
        err.code = "invalid_input";
        throw err;
      }
      if (!["awaiting_host", "partial", "interrupted"].includes(snapshot.state)) {
        const err = new Error(`运行状态为 ${snapshot.state}，不能继续推进`);
        err.code = "invalid_input";
        throw err;
      }
      if (snapshot.rounds + 1 > snapshot.budgetLimits.maxRounds) {
        const err = new Error(`已达轮次上限 ${snapshot.budgetLimits.maxRounds}`);
        err.code = "budget";
        throw err;
      }
      const evidenceIds = new Set(snapshot.evidence.map((e) => e.id));
      const validatedClaims = (claims || []).map((c) => validateClaim(c, evidenceIds));
      const validatedTasks = (tasks || []).map((t) => {
        const { validateTask } = contractsRef;
        const vt = validateTask(t);
        // hostExecuted 是宿主内部标记，不在公共契约里：校验后透传保留。
        if (t.hostExecuted === true) vt.hostExecuted = true;
        return vt;
      });
      // 宿主任务（浏览器 AI 源）不能由 MCP 执行：剥离出来与既有待执行宿主任务合并。
      const hostFromInput = validatedTasks.filter((t) => t.hostExecuted);
      const mcpTasks = validatedTasks.filter((t) => !t.hostExecuted);
      const mergedHost = [...(snapshot.pendingTasks || []).filter((t) => t.hostExecuted)];
      for (const t of hostFromInput) {
        if (!mergedHost.some((h) => h.id === t.id)) mergedHost.push(t);
      }
      if (hostFromInput.length) {
        snapshot.warnings.push(`advance 传入 ${hostFromInput.length} 个宿主任务已保留在待执行队列（MCP 不执行浏览器任务）`);
      }

      snapshot.state = "running";
      snapshot.revision += 1;
      save(snapshot);

      const { outcome, warnings } = await runBatch(snapshot, mcpTasks);
      if (warnings.length) snapshot.warnings.push(...warnings);
      if (validatedClaims.length) snapshot.claims = [...snapshot.claims, ...validatedClaims];
      snapshot.rounds += 1;
      if (outcome.stoppedEarly) {
        snapshot.warnings.push(`运行提前停止: ${outcome.stopReason}（未执行 ${outcome.skipped} 个任务）`);
        snapshot.pendingTasks = [...mcpTasks.filter((t) => outcome.skippedTasks.includes(t.id)), ...mergedHost];
      } else {
        snapshot.pendingTasks = mergedHost;
      }
      return finishRound(snapshot, outcome);
    },

    async resume(runId, revision, requestKey) {
      const snapshot = load(runId);
      if (snapshot.revision !== revision) {
        const err = new Error(`revision 不匹配：当前 ${snapshot.revision}，收到 ${revision}`);
        err.code = "invalid_input";
        throw err;
      }
      if (snapshot.state !== "interrupted" && snapshot.state !== "partial") {
        const err = new Error(`运行状态为 ${snapshot.state}，无需恢复`);
        err.code = "invalid_input";
        throw err;
      }
      const allPending = snapshot.pendingTasks || [];
      const tasks = allPending.filter((t) => !t.hostExecuted);
      const hostTasks = allPending.filter((t) => t.hostExecuted);
      snapshot.state = "running";
      snapshot.revision += 1;
      save(snapshot);
      const { outcome, warnings } = await runBatch(snapshot, tasks);
      if (warnings.length) snapshot.warnings.push(...warnings);
      const remaining = outcome.stoppedEarly ? tasks.filter((t) => outcome.skippedTasks.includes(t.id)) : [];
      snapshot.pendingTasks = [...remaining, ...hostTasks];
      return finishRound(snapshot, outcome);
    },

    async cancel(runId) {
      const entry = active.get(runId);
      if (entry) {
        // 先标记再中止：在途批次的收尾能识别"已被取消"，不再复活状态。
        entry.cancelled = true;
        entry.ctx.abort(new Error("cancelled by user"));
        entry.controller.abort(new Error("cancelled by user"));
      }
      // 与在途收尾的写冲突时重试：读取最新 revision 后再落 cancelled。
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = load(runId);
        if (snapshot.state === "completed" || snapshot.state === "cancelled") {
          const err = new Error(`运行状态为 ${snapshot.state}，无需取消`);
          err.code = "invalid_input";
          throw err;
        }
        snapshot.state = "cancelled";
        snapshot.revision += 1;
        snapshot.updatedAt = new Date(now()).toISOString();
        try {
          save(snapshot);
          return snapshot;
        } catch (err) {
          if (err.code === "invalid_input" && /revision/.test(err.message)) {
            lastErr = err;
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    },

    async finalize(runId, revision, claims) {
      const snapshot = load(runId);
      if (snapshot.revision !== revision) {
        const err = new Error(`revision 不匹配：当前 ${snapshot.revision}，收到 ${revision}`);
        err.code = "invalid_input";
        throw err;
      }
      if (snapshot.state === "running") {
        const err = new Error("运行仍在执行，不能结束");
        err.code = "invalid_input";
        throw err;
      }
      const evidenceIds = new Set(snapshot.evidence.map((e) => e.id));
      const validatedClaims = (claims || []).map((c) => validateClaim(c, evidenceIds));
      if (validatedClaims.length) snapshot.claims = validatedClaims;
      const hasErrors = snapshot.coverage.some((c) => c.status === "error" || c.status === "unavailable");
      snapshot.state = snapshot.state === "cancelled" ? "cancelled" : (hasErrors ? "partial" : "completed");
      snapshot.revision += 1;
      snapshot.updatedAt = new Date(now()).toISOString();
      save(snapshot);
      return snapshot;
    },

    markInterrupted() {
      if (!existsSync(storageRoot)) return 0;
      let count = 0;
      for (const id of readdirSync(storageRoot)) {
        try {
          const snapshot = load(id);
          if (snapshot.state === "running") {
            snapshot.state = "interrupted";
            snapshot.revision += 1;
            snapshot.warnings = [...(snapshot.warnings || []), "进程重启：上一轮执行被标记为中断，未自动重发"];
            save(snapshot);
            count += 1;
          }
        } catch {}
      }
      return count;
    },

    cleanupOlderThan(days = 7, { apply = false } = {}) {
      if (!existsSync(storageRoot)) return { removed: [], candidates: [] };
      const cutoff = now() - days * 24 * 3600 * 1000;
      const candidates = [];
      for (const id of readdirSync(storageRoot)) {
        const dir = join(storageRoot, id);
        try {
          const snapshot = load(id);
          const ts = Date.parse(snapshot.updatedAt || snapshot.createdAt);
          if (Number.isFinite(ts) && ts < cutoff) candidates.push(id);
        } catch {}
        if (apply && candidates.includes(id)) {
          // 只删本插件标记目录；符号链接不跟随。
          rmSync(dir, { recursive: true, force: true });
        }
      }
      return { removed: apply ? candidates : [], candidates };
    },
  };
}

// 延迟引入，避免循环依赖问题。
import * as contractsRef from "./contracts.mjs";

function encodeCursor(runId, revision, offset) {
  return Buffer.from(JSON.stringify({ runId, revision, offset })).toString("base64url");
}

function parseCursor(cursor, runId, revision) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (parsed.runId !== runId || parsed.revision !== revision) return 0;
    return Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    const err = new Error("cursor 无效");
    err.code = "invalid_input";
    throw err;
  }
}

function findRunByRequestKey(storageRoot, requestKey) {
  if (!existsSync(storageRoot)) return null;
  for (const id of readdirSync(storageRoot)) {
    const file = join(storageRoot, id, "snapshot.json");
    if (!existsSync(file)) continue;
    try {
      const snapshot = JSON.parse(readFileSync(file, "utf8"));
      if (snapshot.requestKey === requestKey) return id;
    } catch {}
  }
  return null;
}
