/**
 * Scrapfly：单页正文提取（账号额度，key 以查询参数传递）。
 * 限制：默认关闭 render_js 与 ASP、cost_budget 固定小值；不改用宽泛升级或绕过访问控制；错误信息一律脱敏。
 */

import { requestJson, redact, errorFrom, assertSafeUserUrl } from "../core/transport.mjs";
import { makeEvidence } from "../core/evidence.mjs";

const SCRAPE_URL = "https://api.scrapfly.io/scrape";
const TIMEOUT_MS = 30_000;
const DEFAULT_COST_BUDGET = 1;
const MAX_COST_BUDGET = 5;
const MIN_TEXT_CHARS = 200;

function usage(calls = 1, readUrls = 0) {
  return { calls, readUrls, credits: null, unit: null, currency: null, amount: null };
}

function failure(err, attempted = true, warnings = []) {
  const e = errorFrom(err, "upstream");
  const sent = attempted && !["budget", "security", "invalid_input"].includes(e.code);
  return {
    status: "error",
    evidence: [],
    warnings,
    usage: usage(sent ? 1 : 0, 0),
    error: {
      code: e.code,
      message: redact(e.message).slice(0, 300),
      ...(Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}),
    },
  };
}

/** 只从 deps.credentials.scrapfly 取 key；不读凭据文件、不打印。 */
function readKey(credentials) {
  const raw = credentials?.scrapfly;
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

/** key 走查询参数，redact() 之外再把 key 本身整体抹掉，避免截断或变体泄露。 */
function scrub(message, key) {
  let s = redact(message);
  if (key && key.length >= 4) s = s.split(key).join("[REDACTED]");
  return s;
}

function looksLikeHtml(text) {
  return /<(?:html|body|div|p|span|a|article|main|section)\b/i.test(text);
}

/** 轻量 HTML 转文本：正文证据用可读文本，不做完整渲染。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

async function scrapeOne(url, ctx, config) {
  const params = new URLSearchParams({ url, key: config.key, cost_budget: String(config.costBudget) });
  // 默认不开启渲染与 ASP；只有显式配置才附加，并且成本仍受 cost_budget 约束。
  if (config.renderJs) params.set("render_js", "true");
  if (config.asp) params.set("asp", "true");

  const data = await requestJson(`${SCRAPE_URL}?${params}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    timeoutMs: TIMEOUT_MS,
  }, ctx);

  const result = data?.result ?? {};
  const statusCode = Number(result.status_code);
  if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
    throw Object.assign(new Error(`目标页返回 HTTP ${statusCode}`), { code: "upstream" });
  }
  const raw = String(result.content ?? "").trim();
  if (!raw) return { reason: "未返回正文" };

  const text = looksLikeHtml(raw) ? htmlToText(raw) : raw;
  if (!text) return { reason: "正文为空" };
  const warnings = [];
  if (text.length < MIN_TEXT_CHARS) warnings.push("insufficient_content");

  const record = makeEvidence({
    provider: "scrapfly",
    actualBackend: "scrapfly scrape",
    url: pick(result, ["url"]) || url,
    title: pick(result, ["title"]) || titleFromHtml(raw) || url,
    excerpt: text,
    excerptType: "body",
    kind: "web",
    publishedAt: null,
    warnings,
  });
  if (record.excerpt.length < text.length) record.warnings.push("body_truncated");
  return { evidence: record };
}

async function read(input, ctx, config) {
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
      const result = await scrapeOne(url, ctx, config);
      if (result.evidence) evidence.push(result.evidence);
      else {
        failures += 1;
        warnings.push(`${scrub(url, config.key)}: ${result.reason}`);
      }
    } catch (err) {
      failures += 1;
      lastError = errorFrom(err, "upstream");
      warnings.push(`${scrub(url, config.key)}: ${scrub(lastError.message, config.key).slice(0, 160)}`);
    }
  }

  const batchUsage = usage(urls.length, urls.length);
  if (!evidence.length && failures) {
    return {
      status: "error",
      evidence: [],
      warnings,
      usage: batchUsage,
      // 保留 auth/rate_limit 等码，供调度层冷却与重试判断。
      error: { code: lastError?.code ?? "upstream", message: `${failures}/${urls.length} 个 URL 读取失败` },
    };
  }
  return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: batchUsage };
}

export function createProvider(deps = {}) {
  const credentials = deps.credentials ?? {};
  const settings = deps.settings?.scrapfly ?? {};
  const keyOf = () => readKey(credentials);
  const costBudget = Math.min(Math.max(Number(settings.costBudget) || DEFAULT_COST_BUDGET, 1), MAX_COST_BUDGET);
  const availability = () => {
    if (!keyOf()) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 SCRAPFLY_API_KEY：在 ~/.agent-reach/briking/keys.env、providers.json 或环境变量中设置后重试",
      };
    }
    return {
      configured: true,
      installed: null,
      verifiedAt: null,
      health: "unknown",
      reason: `基础抓取（cost_budget=${costBudget}，render_js=${settings.renderJs === true ? "on" : "off"}，asp=${settings.asp === true ? "on" : "off"}）`,
    };
  };

  return {
    id: "scrapfly",
    capabilities: ["read"],
    billing: "account",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      const key = keyOf();
      if (!key) return failure(Object.assign(new Error("未配置 SCRAPFLY_API_KEY"), { code: "unavailable" }), false);
      try {
        if (task.operation === "read") {
          return await read(task.input, ctx, {
            key,
            costBudget,
            renderJs: settings.renderJs === true,
            asp: settings.asp === true,
          });
        }
        return failure(Object.assign(new Error(`scrapfly 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      } catch (err) {
        // 兜底再抹一次 key：错误消息可能包含带 key 的请求地址。
        return failure(Object.assign(new Error(scrub(err?.message || String(err), key)), { code: err?.code }), true);
      }
    },
  };
}
