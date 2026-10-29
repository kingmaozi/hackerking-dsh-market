/**
 * Parallel 搜索适配器：公开匿名 MCP 端点（免 key，额度未公布，不做免费额度承诺）。
 * 能力：search；无账号、无钱包。同时导出 parallelSearch(query, numResults) 供 legacy 工具复用。
 * 限制：上游只返回文本，URL 与标题为尽力提取；解析不到任何 URL 时返回 status "empty"。
 */

import {
  TransportError,
  errorFrom,
  redact,
  requestJson as coreRequestJson,
} from "../core/transport.mjs";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

const CALL_TIMEOUT_MS = 45_000;
const MAX_RESULTS = 20;
const URL_ONE_RE = /https?:\/\/[^\s<>"'()\[\]，。；、）】]+/;

function usageOf(calls) {
  return { calls, readUrls: 0, credits: null, unit: null, currency: null, amount: null };
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

/** 清掉 JSON 引号、转义与换行，只保留可读的单行标题。 */
function cleanTitle(value) {
  return String(value ?? "")
    .replace(/^\s*["']+|["']\s*$/g, "")
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从 URL 生成可读兜底标题（域名 + 末段路径）。 */
function readableFallbackTitle(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const clean = decodeURIComponent(seg).replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim();
    return clean ? `${host}: ${clean}`.slice(0, 200) : host;
  } catch {
    return String(url || "").slice(0, 200);
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** JSON 片段或键值噪声不能当作标题。 */
function looksLikeJsonNoise(line) {
  // 任意 JSON 键值行（"results": [ / "title": "x" / key: { ）都不是标题。
  if (/^["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*:\s*[\[{"']?/.test(line)) return true;
  if (/^[{}\[\],]/.test(line)) return true;
  if (!/[\u4e00-\u9fa5a-zA-Z]{3}/.test(line)) return true;
  // 中文或英文实词太少的行（标点/符号为主）也不作标题。
  const words = line.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z]{2,}/g) || [];
  if (words.join("").length < 4) return true;
  return false;
}

/** 从纯文本里的 http(s) URL 与其附近标题提取证据。 */
function collectFromText(text, actualBackend) {
  const records = [];
  let lastTitle = "";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const markdown = [...line.matchAll(/\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/g)];
    if (markdown.length) {
      for (const m of markdown) {
        const title = m[1] && !looksLikeJsonNoise(m[1]) ? m[1] : lastTitle;
        records.push({ url: m[2], title, excerpt: line.slice(0, 500) });
      }
      continue;
    }
    const match = URL_ONE_RE.exec(line);
    if (!match) {
      if (line.length > 1 && line.length <= 200 && !/^[|#>]/.test(line) && !looksLikeJsonNoise(line)) {
        lastTitle = line;
      }
      continue;
    }
    const url = match[0].replace(/[.,;:、，。；）】]+$/, "");
    const stripped = line.replace(match[0], " ").replace(/^[\s\-*•\d.)、]+/, "").replace(/[*_`>#|]+/g, " ").trim();
    const title = stripped && !looksLikeJsonNoise(stripped) ? stripped : lastTitle;
    records.push({ url, title, excerpt: line.slice(0, 500) });
  }

  const seen = new Set();
  const evidence = [];
  for (const record of records) {
    const canonicalUrl = normalizeUrl(record.url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    evidence.push({
      id: `parallel:${canonicalUrl}`,
      canonicalUrl,
      originalUrl: String(record.url),
      // 标题兜底：优先记录里的标题，其次域名+路径，最后原文 URL。
      // 空标题会让下游无法判断来源，必须给可读值。
      title: cleanTitle(record.title)
        ? cleanTitle(record.title).slice(0, 300)
        : readableFallbackTitle(canonicalUrl || record.url),
      provider: "parallel",
      actualBackend,
      kind: "web",
      publishedAt: null,
      fetchedAt: new Date().toISOString(),
      excerpt: String(record.excerpt || "").slice(0, 5000),
      excerptType: "snippet",
      bodyRef: null,
      contentHash: null,
      warnings: [],
      sourceGroup: domainOf(canonicalUrl),
    });
  }
  return evidence;
}

/** MCP result.content[] 里的文本块。 */
function textsFrom(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks
    .filter((c) => c && (c.type === undefined || c.type === "text") && typeof c.text === "string" && c.text.trim())
    .map((c) => c.text);
  if (texts.length) return texts;
  if (result && typeof result === "object") {
    const fallback = JSON.stringify(result);
    return fallback && fallback !== "{}" ? [fallback] : [];
  }
  return [];
}

async function callMcp(query, numResults, requestJson, ctx) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: "web_search", arguments: { objective: query, search_queries: [query] } },
  };
  const data = await requestJson(
    PARALLEL_MCP_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      sse: true,
      timeoutMs: CALL_TIMEOUT_MS,
    },
    ctx
  );
  const result = data?.result;
  if (!result || typeof result !== "object") {
    throw new TransportError(
      `Parallel 未返回 MCP result: ${redact(JSON.stringify(data)).slice(0, 200)}`,
      "protocol"
    );
  }
  const text = textsFrom(result).join("\n\n").trim();
  if (result.isError) {
    throw new TransportError(`Parallel 工具返回错误: ${redact(text).slice(0, 300) || "isError"}`.slice(0, 400), "upstream");
  }
  return { text, evidence: collectFromText(text, "parallel.web_search").slice(0, numResults) };
}

/** legacy 兼容接口：匿名搜索，返回 {text, evidence}；空结果返回空数组而不是抛错。 */
export async function parallelSearch(query, numResults = 5) {
  const q = String(query ?? "").trim();
  if (!q) throw new TransportError("parallel 搜索需要非空 query", "invalid_input");
  const limit = Math.min(Math.max(Number(numResults) || 5, 1), MAX_RESULTS);
  const { text, evidence } = await callMcp(q, limit, coreRequestJson, null);
  return { text, evidence };
}

export function createProvider(deps = {}) {
  const depsRef = deps || {};
  const requestJson = depsRef.transport?.requestJson || coreRequestJson;

  async function probe() {
    // 匿名免 key：始终可用，但额度与限流策略未公布，不做承诺。
    return {
      configured: true,
      installed: null,
      verifiedAt: null,
      health: "unknown",
      reason: "匿名免 key，额度未公布",
    };
  }

  async function execute(task, ctx) {
    const input = task?.input || {};
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new TransportError("parallel.search 需要 input.query", "invalid_input");
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_RESULTS);
    try {
      const { evidence } = await callMcp(query, limit, requestJson, ctx);
      return {
        status: evidence.length ? "ok" : "empty",
        evidence,
        warnings: [],
        usage: usageOf(1),
      };
    } catch (err) {
      throw errorFrom(err, "upstream");
    }
  }

  return { id: "parallel", capabilities: ["search"], billing: "anonymous", probe, execute };
}
