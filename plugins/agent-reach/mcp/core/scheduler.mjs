/**
 * 调度器：真并发、预算原子预留、失败隔离、先完成先返回。
 * 预算只减不增；达到上限返回部分结果，不静默扩额。
 */

import { budgetFor, TIER_BUDGETS } from "./contracts.mjs";
import { withCache } from "./cache.mjs";

export function createBudget(tier, overrides) {
  const limits = budgetFor(tier, overrides);
  return {
    limits,
    used: { calls: 0, readUrls: 0, rounds: 0 },
    reserved: { calls: 0, readUrls: 0 },
    startedAt: Date.now(),
    activeMs: 0,
  };
}

export function budgetSnapshot(budget, startedAt = budget.startedAt) {
  const { limits, used } = budget;
  return {
    maxCalls: limits.maxCalls,
    maxReadUrls: limits.maxReadUrls,
    maxRounds: limits.maxRounds,
    maxConcurrency: limits.maxConcurrency,
    activeMs: limits.activeMs,
    usedCalls: used.calls,
    usedReadUrls: used.readUrls,
    usedRounds: used.rounds,
    remainingCalls: Math.max(0, limits.maxCalls - used.calls - budget.reserved.calls),
    remainingReadUrls: Math.max(0, limits.maxReadUrls - used.readUrls - budget.reserved.readUrls),
    remainingRounds: Math.max(0, limits.maxRounds - used.rounds),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 原子预留：任何 await 之前调用，避免并发超发。
 * 释放 reservation 不代表归还已发出的调用。
 */
export function reserve(budget, calls = 1, urls = 0) {
  const { limits, used, reserved } = budget;
  const need = Math.max(0, Math.trunc(calls));
  const needUrls = Math.max(0, Math.trunc(urls));
  const commit = () => {
    used.calls += need;
    used.readUrls += needUrls;
  };
  if (used.calls + reserved.calls + need > limits.maxCalls) return { ok: false, commit, release: () => {} };
  if (used.readUrls + reserved.readUrls + needUrls > limits.maxReadUrls) return { ok: false, commit, release: () => {} };
  reserved.calls += need;
  reserved.readUrls += needUrls;
  let settled = false;
  return {
    ok: true,
    commit: () => {
      if (settled) return;
      settled = true;
      reserved.calls -= need;
      reserved.readUrls -= needUrls;
      commit();
    },
    release: () => {
      if (settled) return;
      settled = true;
      reserved.calls -= need;
      reserved.readUrls -= needUrls;
    },
  };
}

export function reserveRound(budget) {
  if (budget.used.rounds + 1 > budget.limits.maxRounds) return false;
  budget.used.rounds += 1;
  return true;
}

export function createContext({ budget, signal = null, registry = null, transport = null, credentials = {}, now = () => Date.now(), onEvent = null, cache = null }) {
  const startedAt = Date.now();
  const deadline = startedAt + budget.limits.activeMs;
  const controller = new AbortController();
  const externalSignal = signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    deadline,
    registry,
    transport,
    credentials,
    now,
    startedAt,
    onEvent,
    cache,
    /**
     * 真记账的预算预留：成功即提交，预算只减不增。
     * transport/runCli 在每次真实出站前调用；请求未发出即失败（如预算拒绝本身）不计。
     */
    reserve(calls = 1, urls = 0) {
      const r = reserve(budget, calls, urls);
      if (!r.ok) return false;
      r.commit();
      return true;
    },
    /** 只检查不记账：回退链预检等场景用，避免预扣费。 */
    checkBudget(calls = 1, urls = 0) {
      const r = reserve(budget, calls, urls);
      if (!r.ok) return false;
      r.release();
      return true;
    },
    /** 兼容别名：与 reserve 同义（真记账）。 */
    reserveAndCommit(calls = 1, urls = 0) {
      const r = reserve(budget, calls, urls);
      if (!r.ok) return false;
      r.commit();
      return true;
    },
    budget,
    snapshot: () => budgetSnapshot(budget, startedAt),
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason ?? new Error("cancelled"));
    },
  };
}

/**
 * 调度执行：固定并发上限，逐任务完成立即回调，等待上限与总体截止时间。
 */
export async function executeBatch(tasks, ctx, onResult, options = {}) {
  const concurrency = Number(ctx.budget?.limits?.maxConcurrency ?? 1);
  const results = [];
  const queue = [...tasks];
  const running = new Set();
  let stopped = false;
  const stopReason = options.stopReason || "deadline";
  const deadlineAt = ctx.deadline;

  const timedOut = () => Date.now() >= deadlineAt || ctx.signal.aborted;

  async function runOne(task) {
    const provider = ctx.registry?.get(task.provider) ?? options.providerResolver?.(task.provider);
    const startedAt = Date.now();
    if (!provider) {
      const outcome = errorOutcome("unavailable", `未注册的 provider: ${task.provider}`);
      results.push({ task, outcome, startedAt, endedAt: Date.now() });
      onResult?.(task, outcome, { startedAt, endedAt: Date.now() });
      return;
    }
    if (!provider.capabilities.includes(task.operation)) {
      const outcome = errorOutcome("invalid_input", `${task.provider} 不支持 ${task.operation}`);
      results.push({ task, outcome, startedAt, endedAt: Date.now() });
      onResult?.(task, outcome, { startedAt, endedAt: Date.now() });
      return;
    }
    try {
      const availability = typeof provider.checkAvailability === "function"
        ? await provider.checkAvailability(ctx, task)
        : null;
      if (availability && availability.configured === false) {
        const outcome = errorOutcome("unavailable", availability.reason || "未配置");
        results.push({ task, outcome, startedAt, endedAt: Date.now() });
        onResult?.(task, outcome, { startedAt, endedAt: Date.now() });
        return;
      }
      // 有缓存时复用成功结果；live 请求由缓存层拒绝命中（ttl=0）。
      const outcome = ctx.cache
        ? await withCache(ctx.cache, provider, task, ctx, {
          budget: ctx.budget,
          freshness: options.freshness,
          scope: options.accountScope?.(provider.id),
        })
        : await provider.execute(task, ctx, { budget: ctx.budget });
      const normalized = normalizeOutcome(outcome);
      results.push({ task, outcome: normalized, startedAt, endedAt: Date.now() });
      onResult?.(task, normalized, { startedAt, endedAt: Date.now() });
    } catch (err) {
      const code = err?.code && typeof err.code === "string" ? err.code : "upstream";
      const outcome = errorOutcome(
        ["auth", "rate_limit", "timeout", "unavailable", "budget", "cancelled", "network", "protocol", "upstream", "invalid_input", "security"].includes(code)
          ? code
          : "upstream",
        err?.message || String(err)
      );
      results.push({ task, outcome, startedAt, endedAt: Date.now() });
      onResult?.(task, outcome, { startedAt, endedAt: Date.now() });
    }
  }

  const worker = async () => {
    for (;;) {
      if (stopped || timedOut()) return;
      const task = queue.shift();
      if (!task) return;
      await runOne(task);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, () => worker());
  const watchdog = setInterval(() => {
    if (!timedOut()) return;
    stopped = true;
    // 到达截止时间时主动中止在途请求/子进程，而不是等它们自己超时。
    if (!ctx.signal.aborted) ctx.abort?.(new Error("运行到达截止时间"));
  }, 200);
  watchdog.unref?.();

  try {
    await Promise.all(workers);
  } finally {
    clearInterval(watchdog);
  }

  const skipped = queue.length;
  return {
    results,
    completed: results.length,
    skipped,
    stoppedEarly: stopped || skipped > 0,
    stopReason: stopped || skipped > 0 ? stopReason : null,
    skippedTasks: queue.map((t) => t.id),
  };
}

function errorOutcome(code, message) {
  return {
    status: "error",
    evidence: [],
    warnings: [],
    usage: { calls: 0, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
    error: { code, message: String(message).slice(0, 500) },
  };
}

export function normalizeOutcome(value) {
  if (!value || typeof value !== "object") return errorOutcome("protocol", "provider 返回非对象");
  const status = ["ok", "empty", "error"].includes(value.status) ? value.status : (value.evidence?.length ? "ok" : "empty");
  const usage = value.usage || {};
  return {
    status,
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 20) : [],
    usage: {
      calls: Number.isFinite(usage.calls) ? usage.calls : 0,
      readUrls: Number.isFinite(usage.readUrls) ? usage.readUrls : 0,
      credits: Number.isFinite(usage.credits) ? usage.credits : null,
      unit: usage.unit ?? null,
      currency: usage.currency ?? null,
      amount: Number.isFinite(usage.amount) ? usage.amount : null,
    },
    ...(value.error ? { error: value.error } : {}),
    ...(value.externalRunId ? { externalRunId: value.externalRunId } : {}),
  };
}

export function mergeUsage(target, providerId, outcome) {
  const byProvider = target.byProvider;
  const prev = byProvider[providerId] || { calls: 0, readUrls: 0, credits: null, unit: null, currency: null, amount: null };
  const next = {
    calls: prev.calls + (outcome.usage?.calls || 0),
    readUrls: prev.readUrls + (outcome.usage?.readUrls || 0),
    credits: sumNullable(prev.credits, outcome.usage?.credits),
    unit: prev.unit || outcome.usage?.unit || null,
    currency: prev.currency || outcome.usage?.currency || null,
    amount: sumNullable(prev.amount, outcome.usage?.amount),
  };
  byProvider[providerId] = next;
  target.calls += outcome.usage?.calls || 0;
  target.readUrls += outcome.usage?.readUrls || 0;
  return target;
}

function sumNullable(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a + b;
}

export function statusToCoverage(outcome) {
  if (outcome.status === "ok") return "used";
  if (outcome.status === "empty") return "empty";
  const code = outcome.error?.code;
  if (code === "budget") return "budget_blocked";
  if (code === "unavailable") return "unavailable";
  return "error";
}

export { TIER_BUDGETS };
