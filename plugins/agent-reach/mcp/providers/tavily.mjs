/**
 * Tavily 网页搜索：中文友好、账号计费。仅 search；不取生成式 answer，只用原始结果作证据；
 * 多 key 轮询（401/429/5xx 换 key，普通 4xx 直接抛），空结果返回 empty 不抛错。
 */

import {
  TransportError,
  errorFrom,
  redact,
  FAST_TIMEOUT_MS,
  requestJson as coreRequestJson,
} from "../core/transport.mjs";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

const MAX_RESULTS = 20;
const ADVANCED_TIMEOUT_MS = 25_000;
/** 只有 key 本身可能失效的错误才换下一个 key；超时/网络/预算/取消不重复尝试。 */
const RETRY_NEXT_KEY = new Set(["auth", "rate_limit", "upstream"]);

let keyCursor = 0;

/** 凭据查询：兼容对象、Map 与 lookup 函数；只读内存注入的凭据，不读本机文件。 */
function credentialValue(deps, name) {
  const store = deps?.credentials;
  if (!store) return undefined;
  try {
    if (typeof store === "function") return store(name);
    if (typeof store.get === "function") {
      const v = store.get(name);
      if (v !== undefined) return v;
    }
  } catch {
    return undefined;
  }
  return store[name];
}

/** 单个 key 或数组/逗号分隔列表统一为字符串数组。 */
function keyList(value) {
  const arr = Array.isArray(value) ? value : String(value ?? "").split(",");
  return arr.map((k) => (typeof k === "string" ? k.trim() : "")).filter(Boolean);
}

/** 本地轻量规范化：去 fragment 与 utm_* 参数，仅用于生成稳定证据 id。 */
function normalizeUrl(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return "";
  let url;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function makeEvidence({ provider, actualBackend, url, title, excerpt }) {
  const canonicalUrl = normalizeUrl(url);
  return {
    id: `${provider}:${canonicalUrl || String(title || "").slice(0, 120)}`,
    canonicalUrl,
    originalUrl: String(url ?? ""),
    title: String(title || "").slice(0, 500),
    provider,
    actualBackend,
    kind: "web",
    publishedAt: null,
    fetchedAt: new Date().toISOString(),
    excerpt: String(excerpt || "").slice(0, 5000),
    excerptType: "snippet",
    bodyRef: null,
    contentHash: null,
    warnings: [],
    sourceGroup: domainOf(canonicalUrl),
  };
}

function usageOf(calls, readUrls = 0) {
  return { calls, readUrls, credits: null, unit: null, currency: null, amount: null };
}

/** 只把 results 转证据；answer 等模型生成字段一律忽略。 */
function collectResults(data) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  const evidence = [];
  const seen = new Set();
  for (const row of rows) {
    const url = String(row?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const canonicalUrl = normalizeUrl(url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    evidence.push(
      makeEvidence({
        provider: "tavily",
        actualBackend: "tavily.search",
        url,
        title: row?.title,
        excerpt: row?.content || row?.snippet || "",
      })
    );
  }
  return evidence;
}

export function createProvider(deps = {}) {
  const depsRef = deps || {};
  const requestJson = depsRef.transport?.requestJson || coreRequestJson;
  const keysOf = () => keyList(credentialValue(depsRef, "tavily") ?? credentialValue(depsRef, "tavilyKeys"));

  async function probe() {
    const keys = keysOf();
    if (!keys.length) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 Tavily API key（deps.credentials.tavily 为空）",
      };
    }
    return {
      configured: true,
      installed: null,
      verifiedAt: null,
      health: "unknown",
      reason: `已配置 ${keys.length} 个 key；probe 不做联网验证`,
    };
  }

  async function execute(task, ctx) {
    const input = task?.input || {};
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new TransportError("tavily.search 需要 input.query", "invalid_input");
    const keys = keysOf();
    if (!keys.length) throw new TransportError("Tavily 未配置 API key", "auth");

    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_RESULTS);
    // deep/max/heavy 才用 advanced；默认 basic 省额度、降延迟。
    const advanced = /^(deep|max|heavy)$/.test(String(input.externalDepth || ""));
    const baseBody = { query, max_results: limit, search_depth: advanced ? "advanced" : "basic" };

    const warnings = [];
    let calls = 0;
    let lastError = null;
    let sawAuth = false;
    let sawRateLimit = false;

    for (let n = 0; n < keys.length; n++) {
      const key = keys[keyCursor++ % keys.length];
      calls += 1;
      let data;
      try {
        data = await requestJson(
          TAVILY_SEARCH_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...baseBody, api_key: key }),
            timeoutMs: advanced ? ADVANCED_TIMEOUT_MS : FAST_TIMEOUT_MS,
          },
          ctx
        );
      } catch (err) {
        const e = errorFrom(err, "upstream");
        if (e.code === "auth") sawAuth = true;
        if (e.code === "rate_limit") sawRateLimit = true;
        if (!RETRY_NEXT_KEY.has(e.code)) throw e;
        lastError = e;
        warnings.push(`tavily_key_failed:${n + 1}:${e.code}`);
        continue;
      }
      const evidence = collectResults(data);
      return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usageOf(calls) };
    }

    const code = sawRateLimit ? "rate_limit" : sawAuth ? "auth" : lastError?.code || "auth";
    const e = new TransportError(
      `Tavily ${keys.length} 个 key 均失败：${redact(lastError?.message || "未知错误").slice(0, 300)}`,
      code
    );
    if (lastError?.retryAfterMs) e.retryAfterMs = lastError.retryAfterMs;
    throw e;
  }

  return { id: "tavily", capabilities: ["search"], billing: "account", probe, execute };
}
