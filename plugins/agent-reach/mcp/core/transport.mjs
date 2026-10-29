/**
 * 传输层：有界 HTTP/子进程、取消、结构错误检测、脱敏。
 * 所有出站请求必须先通过 ctx.reserve(1,0) 记账，避免并发超发。
 */

import { execFile } from "node:child_process";

import { isPrivateHost, isPrivateIPv4, BLOCKED_HOSTS } from "./contracts.mjs";

// 统一从 contracts 复出，保持既有导入路径不破。
export { isPrivateHost, isPrivateIPv4 };

export const DEFAULT_TIMEOUT_MS = 15_000;
export const FAST_TIMEOUT_MS = 12_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class TransportError extends Error {
  constructor(message, code = "network", extra = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /\b(?:sk|fc|scp|val|xai|tvly|jina)_[A-Za-z0-9._\-]{8,}/gi,
  /(["']?(?:api[_-]?key|apikey|auth_token|ct0|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,&}]{6,}/gi,
  /([?&](?:api[_-]?key|apikey|key|token|access_token)=)[^&\s"'<>]{4,}/gi,
  /\bCookie:\s*[^\n]{8,}/gi,
];

/** 脱敏：截断也一样适用，避免只截出半段密钥。 */
export function redact(value) {
  let s = String(value ?? "");
  s = s.replace(SECRET_PATTERNS[0], "Bearer [REDACTED]");
  s = s.replace(SECRET_PATTERNS[1], "[REDACTED]");
  s = s.replace(SECRET_PATTERNS[2], "$1[REDACTED]");
  s = s.replace(SECRET_PATTERNS[3], "$1[REDACTED]");
  s = s.replace(SECRET_PATTERNS[4], "Cookie: [REDACTED]");
  return s;
}

/** 私网/保留地址判定（IPv4 字面量）已迁移到 contracts.mjs 的 isPrivateHost，此处保留复出。 */

/** 用户提供的 URL 安全性检查：公开 http(s)、无 userinfo、非私网。 */
export function assertSafeUserUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TransportError(`不是有效 URL: ${String(raw).slice(0, 80)}`, "security");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TransportError(`只允许 http(s) URL: ${url.protocol}`, "security");
  }
  if (url.username || url.password) throw new TransportError("URL 不允许包含用户信息", "security");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) throw new TransportError(`拒绝访问本机/元数据主机: ${host}`, "security");
  if (isPrivateHost(host)) throw new TransportError(`拒绝访问私网/保留地址: ${host}`, "security");
  return url;
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? new Error("cancelled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  return { controller, cleanup };
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  if (status >= 400) return "invalid_input";
  return "upstream";
}

function remainingMs(ctx, fallback) {
  if (ctx && typeof ctx.deadline === "number") return Math.max(1, Math.min(fallback, ctx.deadline - Date.now()));
  return fallback;
}

function reserveOrThrow(ctx, calls = 1, urls = 0) {
  if (!ctx || typeof ctx.reserve !== "function") return;
  if (!ctx.reserve(calls, urls)) {
    throw new TransportError("本次调用预算不足", "budget");
  }
}

async function readBounded(res, limit = MAX_RESPONSE_BYTES) {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    return text.slice(0, limit);
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (size - limit))));
        throw new TransportError(`响应超过 ${limit} 字节上限`, "protocol");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
    try { await body.cancel(); } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function attempt(ctx, url, options, timeoutMs, parse) {
  const { controller, cleanup } = combineSignals(ctx?.signal, remainingMs(ctx, timeoutMs));
  try {
    // 已取消/已超时的信号下不再记账：避免"出生即死"的幽灵呼叫占预算。
    if (controller.signal.aborted) {
      throw new TransportError("请求已取消", "cancelled", { retryable: false });
    }
    reserveOrThrow(ctx, 1, 0);
    const fetchImpl = ctx?.transport?.fetchImpl || fetch;
    let res;
    try {
      res = await fetchImpl(url, { ...options, signal: controller.signal, redirect: options.redirect || "manual" });
    } catch (err) {
      // 统一包装为 TransportError，让重试与统计能区分取消/超时/网络错误。
      if (err?.name === "AbortError") {
        const cancelled = Boolean(ctx?.signal?.aborted);
        const reason = cancelled && ctx.signal.reason?.message ? `（${ctx.signal.reason.message}）` : "";
        throw new TransportError(
          cancelled ? `请求已取消${reason}` : `请求超时（${remainingMs(ctx, timeoutMs)}ms 内未完成）`,
          cancelled ? "cancelled" : "timeout",
          { retryable: !cancelled }
        );
      }
      throw new TransportError(redact(err?.message || String(err)).slice(0, 300), "network", { retryable: true });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new TransportError(`不接受重定向响应 ${res.status}`, "security", { retryable: false });
    }
    if (!res.ok) {
      const code = classifyStatus(res.status);
      let detail = "";
      try { detail = redact((await res.text()).slice(0, 300)); } catch {}
      const err = new TransportError(`HTTP ${res.status} ${detail}`, code, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")),
        retryable: code === "rate_limit" || code === "upstream",
      });
      throw err;
    }
    const raw = await readBounded(res, options.maxBytes || MAX_RESPONSE_BYTES);
    return await parse(raw, res);
  } finally {
    cleanup();
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(60_000, secs * 1000));
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, Math.min(60_000, when - Date.now()));
  return undefined;
}

export function parseJsonStrict(raw, label = "response") {
  const trimmed = String(raw).trim();
  if (!trimmed) throw new TransportError(`${label} 为空`, "protocol");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new TransportError(`${label} 不是完整 JSON（${e.message}）`, "protocol");
  }
}

/** JSON/SSE 混装解析：返回最后一条可解析的 JSON。 */
export function parseJsonOrSse(raw, label = "response") {
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJsonStrict(trimmed, label);
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"));
  let last;
  for (const line of lines) {
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { last = JSON.parse(payload); } catch {}
  }
  if (last === undefined) throw new TransportError(`${label} 未包含可解析 JSON`, "protocol");
  return last;
}

/**
 * 带限次重试的请求：网络错误与 5xx/429 最多重试 1 次（可用 options.retries 覆盖，上限 2）。
 * 每次尝试都重新预留预算；4xx 与协议错误不重试。
 */
async function attemptWithRetry(ctx, url, options, timeoutMs, parse) {
  const maxRetries = Math.min(Math.max(Number(options.retries ?? 1), 0), 2);
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await attempt(ctx, url, options, timeoutMs, parse);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof TransportError
        ? err.retryable === true || err.code === "network" || err.code === "timeout"
        : false;
      if (!retryable || i === maxRetries) throw err;
      // 429 尊重 Retry-After，但不超过剩余运行时间。
      const wait = Math.min(Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 300, 5000);
      if (ctx?.deadline && Date.now() + wait >= ctx.deadline) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function requestJson(url, options = {}, ctx = null) {
  const timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return attemptWithRetry(ctx, url, options, timeout, (raw) => {
    const body = options.sse ? parseJsonOrSse(raw, url) : parseJsonStrict(raw, url);
    // 只把 JSON-RPC 形态的 error 当作协议错误；普通业务响应里的 error 字段
    // （如 {success:false,error:"invalid api key"}）交给适配器按业务语义处理。
    if (isJsonRpcError(body)) {
      const code = Number(body.error.code);
      const retryable = code === -32002 || code === -32603;
      throw new TransportError(
        `上游协议错误: ${redact(body.error.message || JSON.stringify(body.error)).slice(0, 200)}`,
        retryable ? "upstream" : "protocol",
        { retryable }
      );
    }
    return body;
  });
}

/** JSON-RPC 错误：存在 jsonrpc 字段，或 error 是带数字 code 的对象。 */
function isJsonRpcError(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const err = body.error;
  if (!err || typeof err !== "object" || Array.isArray(err)) return false;
  if (body.jsonrpc !== undefined) return true;
  return Number.isFinite(Number(err.code)) && (err.message !== undefined || body.result !== undefined);
}

export async function requestText(url, options = {}, ctx = null) {
  const timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return attemptWithRetry(ctx, url, { ...options, headers: { Accept: "*/*", ...(options.headers || {}) } }, timeout,
    (raw, res) => {
      if (!raw.trim()) throw new TransportError("响应正文为空", "protocol");
      return { text: raw, contentType: res.headers?.get?.("content-type") || "" };
    });
}

/** 子进程调用：参数数组、无 shell 拼接、可取消。 */
export function runCli(bin, args, ctx = null, options = {}) {
  const timeoutMs = remainingMs(ctx, options.timeoutMs || 30_000);
  return new Promise((resolve, reject) => {
    // 已取消的信号不记账、直接拒绝。
    if (ctx?.signal?.aborted) {
      reject(new TransportError("请求已取消", "cancelled"));
      return;
    }
    if (!ctx || typeof ctx.reserve !== "function" || ctx.reserve(1, 0)) {
      // reserve 通过或没有 ctx 时继续
    } else {
      reject(new TransportError("本次调用预算不足", "budget"));
      return;
    }
    const child = execFile(
      bin,
      args.map(String),
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (ctx?.signal) ctx.signal.removeEventListener("abort", onAbort);
        if (err) {
          const code = err.killed ? "timeout" : "unavailable";
          reject(new TransportError(redact(`${bin}: ${stderr || err.message}`).slice(0, 500), code));
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      }
    );
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
    };
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function errorFrom(err, fallback = "upstream") {
  if (err && err.name === "TransportError") return err;
  const code = err?.code && typeof err.code === "string" ? err.code : fallback;
  const known = ["auth", "rate_limit", "timeout", "unavailable", "budget", "cancelled", "network", "protocol", "upstream", "invalid_input", "security"];
  const message = err?.name === "AbortError" ? "请求已取消" : redact(err?.message || String(err));
  return new TransportError(message, known.includes(code) ? code : fallback);
}
