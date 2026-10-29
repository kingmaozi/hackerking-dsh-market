/**
 * Firecrawl：Search（账号 credits）与 Scrape（单页转 markdown）。
 * 限制：不实现 crawl/agent/interact（高消耗或需额外授权）；success=false 一律按错误处理。
 */

import { requestJson, redact, errorFrom, assertSafeUserUrl } from "../core/transport.mjs";
import { makeEvidence } from "../core/evidence.mjs";

const SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 20_000;
const SCRAPE_TIMEOUT_MS = 30_000;

function usage(calls = 1, readUrls = 0) {
  return { calls, readUrls, credits: null, unit: null, currency: null, amount: null };
}

function failure(err, attempted = true) {
  const e = errorFrom(err, "upstream");
  const sent = attempted && !["budget", "security", "invalid_input"].includes(e.code);
  return {
    status: "error",
    evidence: [],
    warnings: [],
    usage: usage(sent ? 1 : 0, 0),
    error: {
      code: e.code,
      message: redact(e.message).slice(0, 300),
      ...(Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}),
    },
  };
}

/** 只从 deps.credentials.firecrawl 取 key；不读凭据文件、不打印。 */
function readKey(credentials) {
  const raw = credentials?.firecrawl;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw.map((v) => String(v ?? "").trim()).find(Boolean) || "";
  if (raw && typeof raw === "object") {
    for (const field of ["apiKey", "api_key", "key", "token"]) {
      if (typeof raw[field] === "string" && raw[field].trim()) return raw[field].trim();
    }
  }
  return "";
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };
}

/** 上游结构化错误：不回显 key，只保留脱敏后的原因。 */
function upstreamError(data, fallback) {
  const detail = pick(data, ["error", "message", "details", "detail"]) || fallback;
  return Object.assign(new Error(`Firecrawl: ${redact(detail).slice(0, 200)}`), { code: "upstream" });
}

function resultItems(data) {
  const payload = data?.data ?? data?.results ?? data;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const out = [];
    for (const key of ["web", "news", "results", "items"]) {
      if (Array.isArray(payload[key])) out.push(...payload[key]);
    }
    return out;
  }
  return [];
}

/** domains 未核实为 v2 直传参数：本地按域名过滤，不静默丢弃约束。 */
function filterByDomains(items, domains) {
  if (!domains?.length) return items;
  const wanted = domains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  return items.filter((item) => {
    const host = hostOf(pick(item, ["url", "link"]));
    return Boolean(host) && wanted.some((d) => host === d || host.endsWith(`.${d}`));
  });
}

async function search(input, ctx, key) {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const data = await requestJson(SEARCH_URL, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ query: input.query, limit }),
    timeoutMs: SEARCH_TIMEOUT_MS,
  }, ctx);

  if (data?.success === false) throw upstreamError(data, "search 返回 success=false");

  const warnings = [];
  if (input.after || input.before) warnings.push("time_filter_not_applied");
  let items = filterByDomains(resultItems(data), input.domains);
  if (input.after || input.before) {
    // 只在结果自带可解析日期时本地过滤；无日期的结果保留，避免误删。
    const after = input.after ? Date.parse(input.after) : null;
    const before = input.before ? Date.parse(input.before) : null;
    items = items.filter((item) => {
      const raw = pick(item, ["publishedTime", "published_time", "publishedAt", "date"]);
      const ts = raw ? Date.parse(raw) : NaN;
      if (Number.isNaN(ts)) return true;
      if (after !== null && ts < after) return false;
      if (before !== null && ts > before) return false;
      return true;
    });
  }

  const evidence = [];
  for (const item of items.slice(0, limit)) {
    const url = pick(item, ["url", "link"]);
    if (!url) continue;
    const excerpt = pick(item, ["description", "snippet", "summary", "markdown", "content"]);
    const record = makeEvidence({
      provider: "firecrawl",
      actualBackend: "firecrawl search",
      url,
      title: pick(item, ["title", "name"]) || url,
      excerpt,
      excerptType: "snippet",
      kind: "web",
      publishedAt: pick(item, ["publishedTime", "published_time", "publishedAt", "date"]) || null,
    });
    if (!excerpt) record.warnings.push("no_snippet");
    evidence.push(record);
  }

  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usage(1, 0) };
}

async function scrapeOne(url, ctx, key) {
  const data = await requestJson(SCRAPE_URL, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({ url, formats: ["markdown"] }),
    timeoutMs: SCRAPE_TIMEOUT_MS,
  }, ctx);

  if (data?.success === false) throw upstreamError(data, "scrape 返回 success=false");
  const doc = data?.data ?? {};
  const metadata = doc.metadata ?? {};
  const statusCode = Number(metadata.statusCode);
  if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
    throw Object.assign(new Error(`目标页返回 HTTP ${statusCode}`), { code: "upstream" });
  }
  const markdown = String(doc.markdown ?? doc.content ?? "").trim();
  if (!markdown) return { reason: "未提取到正文" };

  const record = makeEvidence({
    provider: "firecrawl",
    actualBackend: "firecrawl scrape",
    url: pick(metadata, ["sourceURL", "url"]) || url,
    title: pick(metadata, ["title"]) || url,
    excerpt: markdown,
    excerptType: "body",
    kind: "web",
    publishedAt: null,
  });
  if (record.excerpt.length < markdown.length) record.warnings.push("body_truncated");
  return { evidence: record };
}

async function read(input, ctx, key) {
  const urls = [...new Set(input.urls)].slice(0, 10);
  const warnings = [];
  const evidence = [];
  let failures = 0;
  let lastError = null;

  for (const url of urls) {
    assertSafeUserUrl(url);
    if (typeof ctx?.deadline === "number" && Date.now() >= ctx.deadline) {
      warnings.push("剩余 URL 因截止时间未读取");
      break;
    }
    try {
      const result = await scrapeOne(url, ctx, key);
      if (result.evidence) evidence.push(result.evidence);
      else {
        failures += 1;
        warnings.push(`${redact(url)}: ${result.reason}`);
      }
    } catch (err) {
      failures += 1;
      lastError = errorFrom(err, "upstream");
      warnings.push(`${redact(url)}: ${redact(lastError.message).slice(0, 160)}`);
    }
  }

  const batchUsage = usage(urls.length, urls.length);
  if (!evidence.length && failures) {
    return {
      status: "error",
      evidence: [],
      warnings,
      usage: batchUsage,
      error: { code: lastError?.code ?? "upstream", message: `${failures}/${urls.length} 个 URL 读取失败` },
    };
  }
  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: batchUsage };
}

export function createProvider(deps = {}) {
  const credentials = deps.credentials ?? {};
  const keyOf = () => readKey(credentials);
  const availability = () => {
    if (!keyOf()) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 FIRECRAWL_API_KEY：在 ~/.agent-reach/briking/keys.env、providers.json 或环境变量中设置后重试",
      };
    }
    return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "账号 credits 余额与消耗以控制台为准" };
  };

  return {
    id: "firecrawl",
    capabilities: ["search", "read"],
    billing: "account",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      const key = keyOf();
      if (!key) return failure(Object.assign(new Error("未配置 FIRECRAWL_API_KEY"), { code: "unavailable" }), false);
      try {
        if (task.operation === "search") return await search(task.input, ctx, key);
        if (task.operation === "read") return await read(task.input, ctx, key);
        return failure(Object.assign(new Error(`firecrawl 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
