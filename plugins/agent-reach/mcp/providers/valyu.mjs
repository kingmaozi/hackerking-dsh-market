/**
 * Valyu：Search（账号额度，x-api-key 认证，不是 Bearer）。
 * 限制：只做检索，不含 DeepResearch（受钱包预算闸门单独控制，本文件不实现）；付费专业库权限按账号为准。
 */

import { requestJson, redact, errorFrom } from "../core/transport.mjs";
import { makeEvidence } from "../core/evidence.mjs";

const SEARCH_URL = "https://api.valyu.ai/v1/search";
const SEARCH_TIMEOUT_MS = 25_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// 只使用已核实的取值；未核实的组合不下推，避免请求被上游拒绝。
const SEARCH_TYPE_BY_DOMAIN = { news: "news", research_paper: "proprietary" };

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

/** 只从 deps.credentials.valyu 取 key；不读凭据文件、不打印。 */
function readKey(credentials) {
  const raw = credentials?.valyu;
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

function resultItems(data) {
  const payload = data?.results ?? data?.data ?? data?.items ?? data;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["results", "items", "documents"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

/**
 * transport 不回传 HTTP 状态码，只能按响应体标记识别 206 部分成功。
 * 命中时保留已得证据并把 budget 警告透传给调用方。
 */
function isPartial(data) {
  return data?.status === 206
    || data?.status_code === 206
    || data?.partial === true
    || data?.budget_exceeded === true
    || data?.warning === "partial_budget";
}

const ACADEMIC_SOURCE_RE = /arxiv|pubmed|biorxiv|medrxiv|journal|academic|paper/i;

/** domains 未核实为直传参数：本地按域名过滤；sourceIds 走已核实的 included_sources。 */
function filterByDomains(items, domains) {
  if (!domains?.length) return items;
  const wanted = domains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  return items.filter((item) => {
    const host = hostOf(pick(item, ["url", "link"]));
    return Boolean(host) && wanted.some((d) => host === d || host.endsWith(`.${d}`));
  });
}

async function search(input, ctx, key) {
  const body = {
    query: input.query,
    max_num_results: Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    search_type: SEARCH_TYPE_BY_DOMAIN[input.domainType] ?? "all",
  };
  if (input.sourceIds?.length) body.included_sources = input.sourceIds;

  const data = await requestJson(SEARCH_URL, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: SEARCH_TIMEOUT_MS,
  }, ctx);

  if (data?.success === false) {
    const detail = pick(data, ["error", "message", "detail"]) || "search 返回 success=false";
    throw Object.assign(new Error(`Valyu: ${redact(detail).slice(0, 200)}`), { code: "upstream" });
  }

  const warnings = [];
  if (isPartial(data)) warnings.push("partial_budget");
  if (input.after || input.before) warnings.push("time_filter_not_applied");
  if (input.domains?.length) warnings.push("domains_filter_applied_locally");

  const items = filterByDomains(resultItems(data), input.domains);
  const evidence = [];
  for (const item of items.slice(0, body.max_num_results)) {
    const url = pick(item, ["url", "link", "source_url"]);
    if (!url) continue;
    const source = pick(item, ["source", "source_type", "type", "category"]);
    const isPaper = Boolean(pick(item, ["doi"])) || ACADEMIC_SOURCE_RE.test(source) || ACADEMIC_SOURCE_RE.test(url);
    const publishedAt = pick(item, ["publication_date", "published_date", "published_at", "publishedAt", "date", "year"]) || null;
    const record = makeEvidence({
      provider: "valyu",
      actualBackend: "valyu search",
      url,
      title: pick(item, ["title", "name", "headline"]) || url,
      excerpt: pick(item, ["content", "description", "snippet", "summary", "abstract", "text"]),
      excerptType: "snippet",
      kind: isPaper ? "paper" : "web",
      publishedAt,
    });
    if (!record.excerpt) record.warnings.push("no_snippet");
    evidence.push(record);
  }

  const resultUsage = usage(1, 0);
  // 费用只采信服务返回的美元字段；没有就保持 null，不用本地估算冒充账单。
  const cost = Number(data?.total_cost_dollars);
  if (Number.isFinite(cost)) {
    resultUsage.amount = cost;
    resultUsage.currency = "USD";
  }

  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: resultUsage };
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
        reason: "未配置 VALYU_API_KEY：在 ~/.agent-reach/briking/keys.env、providers.json 或环境变量中设置后重试（专业数据源与 DeepResearch 另有费用）",
      };
    }
    return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "网页检索已验证；专业数据源权限按账号为准" };
  };

  return {
    id: "valyu",
    capabilities: ["search"],
    billing: "account",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      const key = keyOf();
      if (!key) return failure(Object.assign(new Error("未配置 VALYU_API_KEY"), { code: "unavailable" }), false);
      try {
        if (task.operation === "search") return await search(task.input, ctx, key);
        return failure(Object.assign(new Error(`valyu 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
