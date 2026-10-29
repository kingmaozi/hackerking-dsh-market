/**
 * TinyFish：Search（免费检索，仍要 key）与 Fetch（批量正文/PDF，免费，仍要 key）。
 * 限制：不含钱包产品 Research/Agent/Browser；Fetch 逐 URL 判失败，不把顶层 200 当整批成功。
 */

import { requestJson, redact, errorFrom, assertSafeUserUrl } from "../core/transport.mjs";
import { makeEvidence } from "../core/evidence.mjs";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const MAX_FETCH_URLS = 10;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
// 官方文档只给出"实时用 0、静态用有界缓存"；recent 折中为 1 小时，不假装精确。
const TTL_BY_FRESHNESS = { live: 0, recent: 3600, static: 86400 };

function usage(calls = 1, readUrls = 0) {
  return { calls, readUrls, credits: null, unit: null, currency: null, amount: null };
}

/** 失败结局：已发出请求记 1 次调用；预算/安全/入参错误不记调用。 */
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

/** 只从 deps.credentials.tinyfish 取 key：支持字符串/字符串数组/apiKey 对象，不读本机凭据文件。 */
function readKey(credentials) {
  const raw = credentials?.tinyfish;
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

function urlOf(item) {
  return pick(item, ["url", "link", "href", "final_url", "source_url"]);
}

function dateOf(item) {
  return pick(item, ["published_at", "publishedAt", "published", "date", "pubdate", "publication_date", "year", "publication_year"]);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function resultArray(data) {
  const candidates = [data, data?.results, data?.items, data?.data, data?.organic_results, data?.data?.results, data?.data?.items];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  return [];
}

function errorText(entry) {
  const raw = entry?.error ?? entry?.error_message ?? entry?.detail;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    const inner = raw.message ?? raw.error ?? raw.detail;
    return typeof inner === "string" && inner.trim() ? inner.trim() : JSON.stringify(raw).slice(0, 200);
  }
  if (entry?.success === false || entry?.status === "error" || entry?.status === "failed") return "上游标记为失败";
  return "";
}

/** domains/after/before 未核实为 TinyFish 直传参数：域名本地过滤，日期仅在结果带日期时过滤并显式告警。 */
function filterItems(items, input, warnings) {
  let out = items;
  if (input.domains?.length) {
    const wanted = input.domains.map((d) => d.toLowerCase().replace(/^www\./, ""));
    out = out.filter((item) => {
      const host = hostOf(urlOf(item));
      return Boolean(host) && wanted.some((d) => host === d || host.endsWith(`.${d}`));
    });
  }
  if (input.after || input.before) {
    warnings.push("time_filter_not_applied");
    const after = input.after ? Date.parse(input.after) : null;
    const before = input.before ? Date.parse(input.before) : null;
    out = out.filter((item) => {
      const raw = dateOf(item);
      const ts = raw ? Date.parse(raw) : NaN;
      if (Number.isNaN(ts)) return true; // 无日期不因此剔除
      if (after !== null && ts < after) return false;
      if (before !== null && ts > before) return false;
      return true;
    });
  }
  return out;
}

async function search(input, ctx, config) {
  const params = new URLSearchParams({ query: input.query });
  if (input.domainType) params.set("domain_type", input.domainType);
  // location/language 无对应输入字段，仅在 deps.settings.tinyfish 显式配置时下推，不猜默认值。
  if (config.location) params.set("location", String(config.location));
  if (config.language) params.set("language", String(config.language));

  const data = await requestJson(`${SEARCH_URL}?${params}`, {
    method: "GET",
    headers: { "X-API-Key": config.key, Accept: "application/json" },
    timeoutMs: SEARCH_TIMEOUT_MS,
  }, ctx);

  const warnings = [];
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const items = filterItems(resultArray(data), input, warnings);
  const evidence = [];

  for (const item of items.slice(0, limit)) {
    const url = urlOf(item);
    if (!url) continue;
    const authors = pick(item, ["authors", "author", "creators"]);
    const year = pick(item, ["year", "published_year", "publication_year", "published_at", "publishedAt", "date"]);
    const snippet = pick(item, ["snippet", "description", "summary", "abstract", "content", "text"]);
    const isPaper = input.domainType === "research_paper" || /paper|preprint|journal/i.test(pick(item, ["type", "category", "source_type"]));
    const meta = isPaper ? [authors, year].filter(Boolean).join(" · ") : "";
    const excerpt = isPaper ? [meta, snippet].filter(Boolean).join(" — ") : snippet;
    const record = makeEvidence({
      provider: "tinyfish",
      actualBackend: "tinyfish search",
      url,
      title: pick(item, ["title", "name", "headline"]) || url,
      excerpt,
      excerptType: "snippet",
      kind: isPaper ? "paper" : "web",
      publishedAt: year || dateOf(item) || null,
    });
    if (!excerpt) record.warnings.push("no_snippet");
    evidence.push(record);
  }

  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usage(1, 0) };
}

async function read(input, ctx, config) {
  const urls = [...new Set(input.urls)].slice(0, MAX_FETCH_URLS);
  for (const url of urls) assertSafeUserUrl(url);
  const freshness = input.freshness ?? "recent";
  const ttl = TTL_BY_FRESHNESS[freshness] ?? TTL_BY_FRESHNESS.recent;
  const warnings = [];

  const data = await requestJson(FETCH_URL, {
    method: "POST",
    headers: { "X-API-Key": config.key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ urls, format: "markdown", ttl }),
    timeoutMs: FETCH_TIMEOUT_MS,
  }, ctx);

  if (data?.status === "error" || data?.success === false) {
    throw Object.assign(new Error(errorText(data) || "TinyFish Fetch 返回失败状态"), { code: "upstream" });
  }

  const evidence = [];
  const covered = new Set();
  let failures = 0;
  const entries = resultArray(data);
  if (!entries.length && Array.isArray(data?.errors) && data.errors.length) {
    // 只剩错误列表时同样按批失败处理，不返回伪成功。
    for (const err of data.errors) {
      failures += 1;
      warnings.push(`${redact(urlOf(err) || "batch")}: ${redact(errorText(err) || "读取失败").slice(0, 160)}`);
    }
  }

  entries.forEach((entry, index) => {
    const url = urlOf(entry) || urls[index] || "";
    if (url) {
      covered.add(url);
      if (urls[index]) covered.add(urls[index]); // 批次按顺序对应，兼容返回最终 URL 的情况
    }
    const label = redact(url || `#${index + 1}`);
    const err = errorText(entry);
    if (err) {
      failures += 1;
      warnings.push(`${label}: ${redact(err).slice(0, 160)}`);
      return;
    }
    const content = pick(entry, ["content", "markdown", "text", "body"]);
    if (!content) {
      failures += 1;
      warnings.push(`${label}: 未返回正文`);
      return;
    }
    const record = makeEvidence({
      provider: "tinyfish",
      actualBackend: "tinyfish fetch",
      url: pick(entry, ["final_url", "url", "link"]) || url,
      title: pick(entry, ["title", "name"]) || url,
      excerpt: content,
      excerptType: "body",
      kind: "web",
      publishedAt: null,
    });
    if (record.excerpt.length < content.length) record.warnings.push("body_truncated");
    evidence.push(record);
  });

  for (const url of urls) if (!covered.has(url)) warnings.push(`${redact(url)}: 未返回结果`);

  const batchUsage = usage(1, urls.length);
  if (!evidence.length && failures) {
    return {
      status: "error",
      evidence: [],
      warnings,
      usage: batchUsage,
      error: { code: "upstream", message: `${failures}/${urls.length} 个 URL 读取失败` },
    };
  }
  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: batchUsage };
}
export function createProvider(deps = {}) {
  const credentials = deps.credentials ?? {};
  const settings = deps.settings?.tinyfish ?? {};
  const keyOf = () => readKey(credentials);
  const availability = () => {
    if (!keyOf()) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 TINYFISH_API_KEY：在 ~/.agent-reach/briking/keys.env、providers.json 或环境变量中设置后重试（Search 与 Fetch 都需要 key）",
      };
    }
    return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: null };
  };

  return {
    id: "tinyfish",
    capabilities: ["search", "read"],
    billing: "account",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      const key = keyOf();
      if (!key) return failure(Object.assign(new Error("未配置 TINYFISH_API_KEY"), { code: "unavailable" }), false);
      try {
        if (task.operation === "search") return await search(task.input, ctx, { ...settings, key });
        if (task.operation === "read") return await read(task.input, ctx, { key });
        return failure(Object.assign(new Error(`tinyfish 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
