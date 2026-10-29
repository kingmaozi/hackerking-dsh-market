/**
 * Jina 适配器：s.jina.ai 搜索（必须带 key）与 r.jina.ai 正文读取（可无 key）。
 * 能力：search（账号计费，无 key 不发起请求）、read（匿名可用；带 key 走账号额度）。
 * 限制：搜索结果是正文型片段而非纯摘要；read 只做一次请求，不重复读取已含正文的首条结果。
 */

import {
  TransportError,
  errorFrom,
  redact,
  assertSafeUserUrl,
  requestJson as coreRequestJson,
  requestText as coreRequestText,
} from "../core/transport.mjs";

export const JINA_SEARCH_URL = "https://s.jina.ai/";
export const JINA_READER_URL = "https://r.jina.ai/";

// 实测 Jina Search 成功样本 1.6–12s，但会整段挂起（实测 5 次仅 1 次成功，4 次挂到超时）。
// 超时设 10s：覆盖多数成功样本，且挂起时不至于吃掉 fast 档大半预算。
// 单路失败不影响整轮——其余五路正常返回。
const SEARCH_TIMEOUT_MS = Number(process.env.AGENT_REACH_SOURCE_TIMEOUT_MS) || 10_000;
const READ_TIMEOUT_MS = Number(process.env.AGENT_REACH_READ_TIMEOUT_MS) || 15_000;
const EXCERPT_LIMIT = 5000;

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

function apiKey(deps) {
  const raw = credentialValue(deps, "jina") ?? credentialValue(deps, "jinaKey") ?? credentialValue(deps, "jinaSearch");
  return typeof raw === "string" ? raw.trim() : "";
}

/** 本地轻量规范化：去 fragment 与 utm_*，仅用于生成稳定证据 id。 */
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

function usageOf(calls, readUrls = 0) {
  return { calls, readUrls, credits: null, unit: null, currency: null, amount: null };
}

/** 统一 Evidence 构造；excerpt 超过上限时截断并标注。 */
function makeEvidence({ id, url, provider = "jina", actualBackend, title, excerpt, excerptType, kind = "web", publishedAt = null }) {
  const canonicalUrl = normalizeUrl(url);
  const text = String(excerpt ?? "");
  const warnings = text.length > EXCERPT_LIMIT ? ["excerpt_truncated"] : [];
  const published = publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null;
  return {
    id: `${id || provider}:${canonicalUrl || String(title || "").slice(0, 120)}`,
    canonicalUrl,
    originalUrl: String(url ?? ""),
    title: String(title || "").slice(0, 500),
    provider,
    actualBackend,
    kind,
    publishedAt: published,
    fetchedAt: new Date().toISOString(),
    excerpt: text.slice(0, EXCERPT_LIMIT),
    excerptType,
    bodyRef: null,
    contentHash: null,
    warnings,
    sourceGroup: domainOf(canonicalUrl),
  };
}

/** date 字段尽力解析：ISO、时间戳或可解析字符串。 */
function publishedFrom(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** 搜索结果：data[] 的 title/url/content，content 是正文型片段。 */
function collectSearchRows(data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const seen = new Set();
  const evidence = [];
  for (const row of rows) {
    const url = String(row?.url || row?.link || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const canonicalUrl = normalizeUrl(url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    evidence.push(
      makeEvidence({
        url,
        actualBackend: "jina.search",
        title: row?.title || row?.name || url,
        excerpt: row?.content || row?.description || "",
        excerptType: "body",
        publishedAt: publishedFrom(row?.date || row?.published_at || row?.publishedAt),
      })
    );
  }
  return evidence;
}

/** Reader 返回的 Markdown 通常带 "Title: xxx" 头或首个 # 标题。 */
function titleOf(text, fallbackUrl) {
  const head = String(text).slice(0, 2000);
  const labeled = /^\s*Title:\s*(.+)$/im.exec(head);
  if (labeled && labeled[1].trim()) return labeled[1].trim();
  const heading = /^\s{0,3}#\s+(.+)$/m.exec(head);
  if (heading && heading[1].trim()) return heading[1].trim();
  return fallbackUrl;
}

export function createProvider(deps = {}) {
  const depsRef = deps || {};
  const requestJson = depsRef.transport?.requestJson || coreRequestJson;
  const requestText = depsRef.transport?.requestText || coreRequestText;

  async function probe() {
    const key = apiKey(depsRef);
    if (!key) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 JINA_API_KEY：search 需要 key（不做匿名请求），read 可匿名使用",
      };
    }
    return {
      configured: true,
      installed: null,
      verifiedAt: null,
      health: "unknown",
      reason: "已配置 JINA_API_KEY；probe 不做联网验证",
    };
  }

  async function search(input, ctx) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new TransportError("jina.search 需要 input.query", "invalid_input");
    const key = apiKey(depsRef);
    if (!key) throw new TransportError("Jina 搜索需要 JINA_API_KEY（不发起匿名请求）", "auth");

    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
    const data = await requestJson(
      `${JINA_SEARCH_URL}${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
      ctx
    );
    const evidence = collectSearchRows(data).slice(0, limit);
    return { status: evidence.length ? "ok" : "empty", evidence, warnings: [], usage: usageOf(1) };
  }

  async function read(input, ctx) {
    const urls = Array.isArray(input.urls) ? input.urls : [];
    if (!urls.length) throw new TransportError("jina.read 需要 input.urls", "invalid_input");
    const key = apiKey(depsRef);
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const limit = Math.min(Math.max(Number(input.limit) || urls.length, 1), urls.length);

    const evidence = [];
    const warnings = [];
    let calls = 0;
    let firstError = null;

    for (const url of urls.slice(0, limit)) {
      // 第三方 Reader 会代取目标 URL：沿用 transport 的公开 http(s)/非私网检查。
      try {
        assertSafeUserUrl(url);
      } catch (err) {
        const e = errorFrom(err, "security");
        if (!firstError) firstError = e;
        warnings.push(`jina_read_rejected:${e.code}`);
        continue;
      }
      calls += 1;
      try {
        const res = await requestText(
          `${JINA_READER_URL}${url}`,
          { method: "GET", headers, timeoutMs: READ_TIMEOUT_MS },
          ctx
        );
        const text = res.text;
        if (!text.trim()) {
          warnings.push("jina_read_empty_body");
          continue;
        }
        evidence.push(
          makeEvidence({
            url,
            actualBackend: "jina.reader",
            title: titleOf(text, url),
            excerpt: text,
            excerptType: "body",
          })
        );
      } catch (err) {
        const e = errorFrom(err, "upstream");
        if (!firstError) firstError = e;
        warnings.push(`jina_read_failed:${e.code}:${redact(url).slice(0, 120)}`);
      }
    }

    // 全部失败时不静默返回空；部分失败保留成功结果并记录警告。
    if (!evidence.length && firstError) throw firstError;
    return {
      status: evidence.length ? "ok" : "empty",
      evidence,
      warnings,
      // readUrls 按实际发起的读取尝试计数（失败也占预算）。
      usage: usageOf(calls, calls),
    };
  }

  async function execute(task, ctx) {
    const input = task?.input || {};
    const operation = task?.operation || (Array.isArray(input.urls) && !input.query ? "read" : "search");
    if (operation === "read") return read(input, ctx);
    if (operation === "search") return search(input, ctx);
    throw new TransportError(`jina 不支持 ${operation} 操作（仅 search/read）`, "invalid_input");
  }

  return { id: "jina", capabilities: ["search", "read"], billing: "account", probe, execute };
}
