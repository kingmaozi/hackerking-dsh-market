/**
 * 健康检查：默认离线，分别报告安装/配置/最近调用健康。
 * probe=true 时对目标渠道执行最小探测：只调用 provider.probe，绝不调用 execute。
 * 未探测过即为 unknown，绝不把 which 或认证成功写成搜索健康。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 单渠道探测超时与并发上限（零依赖：分批 + Promise.race）。 */
export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_CONCURRENCY = 4;

export function createHistory(root) {
  const file = join(root, "health-history.json");
  let data = { providers: {} };
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { data = { providers: {} }; }
  }
  return {
    file,
    get(provider) {
      return data.providers[provider] || null;
    },
    record(provider, { ok, latencyMs, note = "" }) {
      const prev = data.providers[provider] || { samples: 0, okSamples: 0, lastOkAt: null, lastErrorAt: null, latencies: [] };
      prev.samples += 1;
      if (ok) {
        prev.okSamples += 1;
        prev.lastOkAt = new Date().toISOString();
        prev.latencies = [...prev.latencies.slice(-49), latencyMs].filter((n) => Number.isFinite(n));
      } else {
        prev.lastErrorAt = new Date().toISOString();
        prev.lastError = note.slice(0, 200);
      }
      data.providers[provider] = prev;
      return prev;
    },
    snapshot() {
      return data;
    },
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

const PROBE_VERDICTS = ["ok", "degraded", "error"];

/**
 * 解析探测目标：
 * - 显式 providers 子集（未知/空 id 记入 warnings，不静默吞掉）
 * - 默认只探测 credentialsStatus 中 configured === true 的渠道
 */
function resolveProbeTargets({ registry, credentialsStatus, providers }) {
  const warnings = [];
  const requested = typeof providers === "string"
    ? [providers]
    : Array.isArray(providers) ? providers : [];
  if (requested.length) {
    const targets = [];
    const seen = new Set();
    for (const raw of requested) {
      const id = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const provider = registry.get(id);
      if (!provider) {
        warnings.push(`未知渠道已忽略: ${id}`);
        continue;
      }
      targets.push(provider);
    }
    return { targets, warnings };
  }
  const targets = [...registry.values()].filter((p) => credentialsStatus?.[p.id]?.configured === true);
  return { targets, warnings };
}

/**
 * 最小探测单个渠道：只调 provider.probe({}, ctx)，超时 5s。
 * 任何异常都收敛为 { ok:false }，绝不抛出。
 */
async function probeOne(provider, { registry, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer = null;
  try {
    const ctx = { registry, signal: controller.signal, deadline: startedAt + timeoutMs };
    const call = Promise.resolve().then(() => provider.probe({}, ctx));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`探测超时（${timeoutMs}ms）`), { code: "timeout" }));
      }, timeoutMs);
    });
    const result = await Promise.race([call, timeout]);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      result: result && typeof result === "object" ? result : {},
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error?.message || String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 分批并发探测（零依赖），单个渠道失败不影响其他渠道。 */
async function runProbes(targets, { registry, concurrency = PROBE_CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = new Map();
  const size = Math.max(1, Number(concurrency) || PROBE_CONCURRENCY);
  for (let i = 0; i < targets.length; i += size) {
    const chunk = targets.slice(i, i + size);
    const settled = await Promise.allSettled(chunk.map((p) => probeOne(p, { registry, timeoutMs })));
    settled.forEach((entry, idx) => {
      results.set(chunk[idx].id, entry.status === "fulfilled"
        ? entry.value
        : { ok: false, latencyMs: 0, error: entry.reason?.message || String(entry.reason) });
    });
  }
  return results;
}

/**
 * 把本次实测结果合并进行：health/verifiedAt/lastError 以本次为准，并落历史样本。
 */
function applyProbeResult(row, probeResult, history) {
  const at = new Date().toISOString();
  let health = "ok";
  let lastError = null;
  if (!probeResult.ok) {
    health = "error";
    lastError = `探测失败: ${probeResult.error}`;
  } else {
    const verdict = probeResult.result?.health;
    if (PROBE_VERDICTS.includes(verdict)) {
      health = verdict;
      if (health === "error") lastError = probeResult.result?.reason || "探测返回不可用";
    } else if (probeResult.result?.configured === false) {
      // 显式指定了未配置渠道：这是明确不可用，不是"未验证"。
      health = "error";
      lastError = probeResult.result?.reason || "渠道未配置";
    }
  }
  const record = history?.record?.(row.id, { ok: health !== "error", latencyMs: probeResult.latencyMs, note: lastError || "" });
  row.health = health;
  row.verifiedAt = at;
  row.lastError = lastError;
  if (record) {
    row.samples = record.samples;
    row.okSamples = record.okSamples;
    row.p50Ms = percentile(record.latencies || [], 50);
    row.p95Ms = percentile(record.latencies || [], 95);
  }
}

function probeNote({ probed, targets, warnings, timeoutMs, concurrency }) {
  if (!targets.length) {
    return `probe=true，但没有可探测的目标渠道（默认只探测已配置渠道，可用 providers 指定）；` +
      "本次未发起任何探测" + (warnings.length ? `；${warnings.join("；")}` : "");
  }
  const parts = [];
  parts.push(`已执行最小探测：${targets.length} 个渠道（单渠道超时 ${timeoutMs}ms，并发 ${concurrency}）`);
  if (probed) {
    const failed = [...probed.values()].filter((r) => !r.ok).length;
    parts.push(failed ? `${failed} 个探测失败，已在对应渠道标注` : "全部探测调用完成");
  }
  parts.push("仅代表本次调用结果");
  if (warnings.length) parts.push(warnings.join("；"));
  return parts.join("；");
}

/**
 * 描述各渠道健康：installed/configured/verifiedAt/health 分开报告。
 * probe=false 时零外部请求；probe=true 时对目标渠道调用 provider.probe（最小探测，不消耗搜索额度以外资源）。
 * @returns {Promise<{probed:boolean, probeCount:number, warnings:string[], note:string, providers:object[]}>}
 */
export async function describeHealth({
  registry,
  credentialsStatus,
  history,
  probe = false,
  providers = null,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  probeConcurrency = PROBE_CONCURRENCY,
} = {}) {
  const { targets, warnings } = probe
    ? resolveProbeTargets({ registry, credentialsStatus, providers })
    : { targets: [], warnings: [] };
  const probed = probe
    ? await runProbes(targets, { registry, concurrency: probeConcurrency, timeoutMs: probeTimeoutMs })
    : new Map();

  const rows = [];
  for (const provider of registry.values()) {
    const status = credentialsStatus[provider.id] || null;
    const record = history?.get(provider.id) || null;
    let health = "unknown";
    let verifiedAt = null;
    if (record?.lastOkAt) {
      health = record.lastErrorAt && Date.parse(record.lastErrorAt) > Date.parse(record.lastOkAt) ? "degraded" : "ok";
      verifiedAt = record.lastOkAt;
    } else if (record?.lastErrorAt) {
      health = "error";
      verifiedAt = record.lastErrorAt;
    }
    const row = {
      id: provider.id,
      billing: provider.billing,
      capabilities: provider.capabilities,
      configured: status ? status.configured : null,
      configNote: status?.reason ?? null,
      health,
      verifiedAt,
      samples: record?.samples ?? 0,
      okSamples: record?.okSamples ?? 0,
      p50Ms: percentile(record?.latencies || [], 50),
      p95Ms: percentile(record?.latencies || [], 95),
      lastError: record?.lastError ?? null,
      probed: probed.has(provider.id),
    };
    if (row.probed) applyProbeResult(row, probed.get(provider.id), history);
    rows.push(row);
  }
  return {
    probed: probe,
    probeCount: targets.length,
    warnings,
    note: probe
      ? probeNote({ probed, targets, warnings, timeoutMs: probeTimeoutMs, concurrency: probeConcurrency })
      : "默认离线体检：仅反映配置与历史调用，不代表当前联网可用",
    providers: rows,
  };
}

export function formatHealthText(health) {
  const lines = ["== 渠道状态 ==", health.note, ""];
  for (const row of health.providers) {
    const configured = row.configured === null ? "?" : row.configured ? "已配置" : "未配置";
    const failedNow = Boolean(health.probed) && row.health === "error";
    const verified = row.verifiedAt
      ? `${failedNow ? "最近失败" : "最近成功"} ${row.verifiedAt.slice(0, 16).replace("T", " ")}`
      : "未验证";
    const latency = row.p95Ms ? `P95 ${row.p95Ms}ms` : "无延迟样本";
    lines.push(`  ${row.id.padEnd(14)} ${configured.padEnd(6)} 健康=${row.health.padEnd(8)} ${verified} · ${latency}`);
    if (row.configNote) lines.push(`    ${row.configNote}`);
    if (failedNow && row.lastError) lines.push(`    ${row.lastError}`);
  }
  lines.push("", "说明: health=unknown 表示尚未验证；未验证不等于可用或不可用。");
  return lines.join("\n");
}
