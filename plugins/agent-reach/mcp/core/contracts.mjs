/**
 * 三档搜索公共契约：档位、预算、参数校验、错误码。
 * 纯函数模块：不联网、不读文件、不读凭据。
 */

export const SCHEMA_VERSION = 1;

export const TIERS = ["fast", "wide", "deep"];
export const COST_POLICIES = ["parallel", "save"];
export const CAPABILITIES = ["search", "read", "research"];

export const PROVIDER_IDS = [
  "tavily", "exa", "jina", "jina_search", "parallel",
  "tinyfish", "firecrawl", "valyu", "scrapfly",
  "x", "github", "reddit", "v2ex", "bilibili", "youtube", "rss", "weixin",
  "arxiv", "crossref", "pubmed", "doubao", "gemini",
  "tinyfish_research", "valyu_research",
];

export const COVERAGE_STATUS = [
  "pending", "used", "empty", "error", "irrelevant",
  "unavailable", "budget_blocked", "user_excluded",
];

export const RUN_STATES = ["running", "awaiting_host", "interrupted", "completed", "partial", "cancelled"];

export const ERROR_CODES = [
  "auth", "rate_limit", "timeout", "unavailable", "budget", "cancelled",
  "network", "protocol", "upstream", "invalid_input", "security",
];

/** 档位默认硬上限。达到上限交付部分结果，不静默扩额。 */
export const TIER_BUDGETS = {
  // 并发 = 四路网页 + 微信 + X，允许同拍启动。
  fast: { maxCalls: 12, maxReadUrls: 3, maxRounds: 1, maxConcurrency: 6, activeMs: 30_000 },
  wide: { maxCalls: 40, maxReadUrls: 12, maxRounds: 2, maxConcurrency: 6, activeMs: 180_000 },
  deep: { maxCalls: 100, maxReadUrls: 30, maxRounds: 3, maxConcurrency: 6, activeMs: 900_000 },
};

export const IDLE_WAIT_MS = 30 * 60 * 1000;

export class ContractError extends Error {
  constructor(message, code = "invalid_input", field = null) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.field = field;
  }
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(field, message) {
  throw new ContractError(`${field}: ${message}`, "invalid_input", field);
}

function requireString(value, field, { min = 1, max = 4000 } = {}) {
  if (typeof value !== "string") fail(field, "必须是字符串");
  const s = value.trim();
  if (s.length < min) fail(field, `长度至少 ${min}`);
  if (value.length > max) fail(field, `长度最多 ${max}`);
  return value;
}

function optionalInt(value, field, { min, max }) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field, "必须是数字");
  if (!Number.isInteger(value)) fail(field, "必须是整数");
  if (min !== undefined && value < min) fail(field, `不能小于 ${min}`);
  if (max !== undefined && value > max) fail(field, `不能大于 ${max}`);
  return value;
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return undefined;
  requireString(value, field, { min: 4, max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) fail(field, "需要 ISO 日期，如 2026-09-13");
  if (Number.isNaN(Date.parse(value))) fail(field, "不是有效日期");
  return value;
}

/** 每个 provider+operation 允许的输入字段白名单；拒绝无关字段透传。 */
export const TASK_INPUT_ALLOWLIST = {
  search: ["query", "limit", "after", "before", "domains", "freshness", "domainType", "sourceIds", "externalDepth", "scope"],
  read: ["urls", "freshness", "limit"],
  research: ["query", "externalDepth", "after", "before", "limit"],
};

const URL_RE = /^https?:\/\/[^\s]+$/i;

export const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata", "instance-data"]);

/** 私网/保留地址判定（IPv4 点分字面量）。 */
export function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a >= 224;
}

function hexPairToIPv4(hiHex, loHex) {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** IPv4-mapped/compatible 的内嵌形态：点分（127.0.0.1）或压缩 hex（7f00:1）。 */
function embeddedIPv4(rest) {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) return rest;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  return m ? hexPairToIPv4(m[1], m[2]) : null;
}

/**
 * 统一的本机/私网判定（contracts 与 transport 共用此实现）：
 * 覆盖 IPv4 字面量、IPv6 环回/链路本地(fe80::/10)/ULA(fc00::/7)/未指定地址(::)，
 * 以及 IPv4-mapped（::ffff:a.b.c.d 与压缩形 ::ffff:7f00:1）和 IPv4-compatible（::a.b.c.d）。
 * 注意：域名解析到私网（DNS rebinding）不在本层防护范围，需在连接层校验。
 */
export function isPrivateHost(host) {
  const bare = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare) return true;
  if (BLOCKED_HOSTS.has(bare)) return true;
  if (isPrivateIPv4(bare)) return true;
  if (!bare.includes(":")) return false;
  // 未指定地址与环回
  if (bare === "::" || bare === "::1") return true;
  // IPv4-mapped：::ffff: 前缀。形态无法解析时按私网拒绝（宁可误拦）。
  if (bare.startsWith("::ffff:")) {
    const v4 = embeddedIPv4(bare.slice(7));
    return v4 ? isPrivateIPv4(v4) : true;
  }
  // IPv4-compatible（已废弃但可路由）：:: 后恰好 32 位
  if (bare.startsWith("::")) {
    const v4 = embeddedIPv4(bare.slice(2));
    if (v4) return isPrivateIPv4(v4);
    return false;
  }
  // 链路本地 fe80::/10（fe80–febf）与 ULA fc00::/7（fc/fd 开头）
  if (/^fe[89ab]/.test(bare)) return true;
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
  return false;
}

function validateUrls(value) {
  if (!Array.isArray(value) || value.length === 0) fail("input.urls", "必须是非空 URL 数组");
  if (value.length > 10) fail("input.urls", "单次最多 10 个 URL");
  for (const u of value) {
    if (typeof u !== "string" || !URL_RE.test(u)) fail("input.urls", `不是 http(s) URL: ${String(u).slice(0, 60)}`);
    if (u.length > 4096) fail("input.urls", "单个 URL 最长 4096 字符");
    // 契约层即拒绝本机/私网，避免不安全地址进入后续链路。
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      fail("input.urls", `无法解析: ${u.slice(0, 60)}`);
    }
    if (parsed.username || parsed.password) fail("input.urls", "URL 不允许包含用户信息");
    if (isPrivateHost(parsed.hostname)) fail("input.urls", `拒绝本机/私网地址: ${parsed.hostname}`);
  }
  return value.map((u) => u);
}

export function validateTaskInput(operation, input) {
  if (!CAPABILITIES.includes(operation)) fail("operation", `必须是 ${CAPABILITIES.join("|")}`);
  if (!isPlainObject(input)) fail("input", "必须是对象");
  const allow = new Set(TASK_INPUT_ALLOWLIST[operation]);
  for (const key of Object.keys(input)) {
    if (!allow.has(key)) fail(`input.${key}`, `不允许用于 ${operation} 操作`);
  }
  const out = {};
  if (operation === "read") {
    out.urls = validateUrls(input.urls);
    out.freshness = validateFreshness(input.freshness);
    const limit = optionalInt(input.limit, "input.limit", { min: 1, max: 10 });
    if (limit !== undefined) out.limit = limit;
    return out;
  }
  requireString(input.query, "input.query", { min: 1, max: 4000 });
  out.query = input.query;
  const limit = optionalInt(input.limit, "input.limit", { min: 1, max: 20 });
  if (limit !== undefined) out.limit = limit;
  const after = optionalDate(input.after, "input.after");
  const before = optionalDate(input.before, "input.before");
  if (after && before && Date.parse(after) > Date.parse(before)) fail("input.after", "不能晚于 input.before");
  if (after) out.after = after;
  if (before) out.before = before;
  if (input.domains !== undefined) {
    if (!Array.isArray(input.domains) || input.domains.some((d) => typeof d !== "string" || !d.trim())) {
      fail("input.domains", "必须是字符串数组");
    }
    if (input.domains.length > 10) fail("input.domains", "最多 10 个域名");
    out.domains = input.domains.map((d) => d.trim());
  }
  const freshness = validateFreshness(input.freshness);
  if (freshness) out.freshness = freshness;
  if (input.domainType !== undefined) {
    if (!["web", "news", "research_paper"].includes(input.domainType)) {
      fail("input.domainType", "必须是 web|news|research_paper");
    }
    out.domainType = input.domainType;
  }
  if (input.sourceIds !== undefined) {
    if (!Array.isArray(input.sourceIds) || input.sourceIds.some((s) => typeof s !== "string")) {
      fail("input.sourceIds", "必须是字符串数组");
    }
    out.sourceIds = input.sourceIds.slice(0, 10);
  }
  if (input.externalDepth !== undefined) {
    if (!["standard", "deep", "max", "fast", "heavy"].includes(input.externalDepth)) {
      fail("input.externalDepth", "必须是 standard|deep|max|fast|heavy");
    }
    out.externalDepth = input.externalDepth;
  }
  if (input.scope !== undefined) {
    if (!["general", "douyin", "both"].includes(input.scope)) fail("input.scope", "必须是 general|douyin|both");
    out.scope = input.scope;
  }
  return out;
}

function validateFreshness(value) {
  if (value === undefined || value === null) return undefined;
  if (!["live", "recent", "static"].includes(value)) fail("input.freshness", "必须是 live|recent|static");
  return value;
}

export function validateTask(value) {
  if (!isPlainObject(value)) fail("task", "必须是对象");
  requireString(value.id, "task.id", { min: 1, max: 128 });
  if (!PROVIDER_IDS.includes(value.provider)) fail("task.provider", `未知 provider: ${String(value.provider)}`);
  if (value.authorizationRef !== undefined) requireString(value.authorizationRef, "task.authorizationRef", { min: 1, max: 128 });
  const input = validateTaskInput(value.operation, value.input);
  const task = { id: value.id, provider: value.provider, operation: value.operation, input };
  if (value.authorizationRef !== undefined) task.authorizationRef = value.authorizationRef;
  return task;
}

export function budgetFor(tier, overrides) {
  if (!TIERS.includes(tier)) fail("tier", `必须是 ${TIERS.join("|")}`);
  const base = { ...TIER_BUDGETS[tier] };
  if (overrides === undefined || overrides === null) return base;
  if (!isPlainObject(overrides)) fail("budget", "必须是对象");
  const keys = ["maxCalls", "maxReadUrls", "maxRounds", "maxConcurrency"];
  for (const key of keys) {
    if (overrides[key] === undefined) continue;
    const v = overrides[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(`budget.${key}`, "必须是正整数");
    // 模型/调用方只能降低默认上限，不能借此扩额。
    if (v > base[key]) fail(`budget.${key}`, `不能超过 ${tier} 档默认上限 ${base[key]}；如需扩容请修改本机配置`);
    base[key] = v;
  }
  return base;
}

export function validatePlan(value) {
  if (!isPlainObject(value)) fail("plan", "必须是对象");
  requireString(value.query, "plan.query", { min: 1, max: 4000 });
  if (!TIERS.includes(value.tier)) fail("plan.tier", `必须是 ${TIERS.join("|")}`);
  const reason = value.reason === undefined ? "" : requireString(value.reason, "plan.reason", { min: 1, max: 500 });
  const costPolicy = value.costPolicy === undefined ? "parallel" : value.costPolicy;
  if (!COST_POLICIES.includes(costPolicy)) fail("plan.costPolicy", `必须是 ${COST_POLICIES.join("|")}`);
  if (value.includeSocial !== undefined && typeof value.includeSocial !== "boolean") {
    fail("plan.includeSocial", "必须是布尔值");
  }
  const includeSocial = value.includeSocial === undefined ? true : value.includeSocial;
  const requestedAt = value.requestedAt === undefined ? new Date().toISOString() : value.requestedAt;
  requireString(requestedAt, "plan.requestedAt", { min: 4, max: 40 });
  if (Number.isNaN(Date.parse(requestedAt))) fail("plan.requestedAt", "不是有效时间");
  const tasks = value.tasks === undefined ? [] : value.tasks;
  if (!Array.isArray(tasks)) fail("plan.tasks", "必须是数组");
  const audit = value.audit === undefined ? [] : value.audit;
  if (!Array.isArray(audit)) fail("plan.audit", "必须是数组");
  const plan = {
    query: value.query,
    tier: value.tier,
    reason,
    costPolicy,
    includeSocial,
    requestedAt: new Date(requestedAt).toISOString(),
    tasks: tasks.map(validateTask),
    audit: audit.map(validateAudit),
  };
  if (value.budget !== undefined) plan.budget = budgetFor(value.tier, value.budget);
  return plan;
}

function validateAudit(value) {
  if (!isPlainObject(value)) fail("audit", "必须是对象");
  if (!PROVIDER_IDS.includes(value.provider)) fail("audit.provider", `未知 provider: ${String(value.provider)}`);
  if (!COVERAGE_STATUS.includes(value.status)) fail("audit.status", `必须是 ${COVERAGE_STATUS.join("|")}`);
  const reason = value.reason === undefined ? "" : String(value.reason).slice(0, 500);
  return { provider: value.provider, status: value.status, reason };
}

export function validateClaim(value, evidenceIds) {
  if (!isPlainObject(value)) fail("claim", "必须是对象");
  requireString(value.id, "claim.id", { min: 1, max: 128 });
  requireString(value.text, "claim.text", { min: 1, max: 4000 });
  const check = (arr, field) => {
    if (arr === undefined) return [];
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) fail(field, "必须是字符串数组");
    for (const id of arr) {
      if (evidenceIds && !evidenceIds.has(id)) fail(field, `引用了不存在的证据 ${id}`);
    }
    return arr.slice(0, 50);
  };
  const supports = check(value.supports, "claim.supports");
  const contradicts = check(value.contradicts, "claim.contradicts");
  const status = value.status === undefined ? "unverified" : value.status;
  if (!["supported", "disputed", "unverified"].includes(status)) {
    fail("claim.status", "必须是 supported|disputed|unverified");
  }
  if (status === "supported" && supports.length === 0) {
    fail("claim.supports", "supported 结论必须至少有一条支持证据");
  }
  return { id: value.id, text: value.text, supports, contradicts, status };
}
