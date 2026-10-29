/**
 * Exa 搜索适配器：经本机 mcporter 调用 Exa MCP，多 server 轮询；code 工具不可用时回退 web 搜索。
 * 能力：search（账号计费；key 由 mcporter 侧管理，本模块不接触密钥原文）。
 * 限制：必须已配置 mcporter 与 exa server；输出为文本时尽力解析，解析不到 URL 时如实返回 empty。
 */

import {
  TransportError,
  errorFrom,
  redact,
  runCli as coreRunCli,
} from "../core/transport.mjs";

export const EXA_CALL_TIMEOUT_MS = 90_000;
const CODE_TOKENS = 3000;
const MAX_RESULTS = 20;
/** 工具缺失/限流的输出特征：这类文案是错误，不能当作结果。 */
const TOOL_ERROR_RE = /tool not found|-32602|rate limit/i;
const URL_ONE_RE = /https?:\/\/[^\s<>"'()\[\]，。；、）】]+/;

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

/** server 列表来自 deps.credentials.exaServers（数组或逗号分隔字符串）。 */
function serverList(deps) {
  const raw = credentialValue(deps, "exaServers");
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return [...new Set(arr.map((s) => String(s ?? "").trim()).filter(Boolean))];
}

/** TaskInput 无 mode 字段：约定 sourceIds 含 "code" 时走代码上下文工具。 */
function wantsCodeMode(input) {
  const ids = Array.isArray(input?.sourceIds) ? input.sourceIds : [];
  return ids.some((s) => /^code$/i.test(String(s).trim()));
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

function pickString(...values) {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function usageOf(calls) {
  return { calls, readUrls: 0, credits: null, unit: null, currency: null, amount: null };
}

/** 把 {url,title,excerpt} 记录收敛为 Evidence；同一规范化 URL 只保留一条。 */
function evidenceFrom(records, actualBackend) {
  const seen = new Set();
  const evidence = [];
  for (const record of records) {
    const url = String(record?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const canonicalUrl = normalizeUrl(url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    evidence.push({
      id: `exa:${canonicalUrl}`,
      canonicalUrl,
      originalUrl: url,
      title: String(record.title || "").slice(0, 500),
      provider: "exa",
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

function maybeParseJson(value) {
  const s = String(value ?? "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 从任意 JSON 结构里收集 url/title/excerpt，深度受限。 */
function collectFromJson(node, out, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectFromJson(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const url = pickString(node.url, node.link, node.href, node.uri);
  if (url && /^https?:\/\//i.test(url)) {
    out.push({
      url,
      title: pickString(node.title, node.name, node.headline),
      excerpt: pickString(node.text, node.content, node.snippet, node.description, node.summary),
    });
  }
  for (const key of ["content", "results", "data", "items", "output", "text"]) {
    const child = node[key];
    if (typeof child === "string") {
      const parsed = maybeParseJson(child);
      if (parsed) collectFromJson(parsed, out, depth + 1);
    } else if (child && typeof child === "object") {
      collectFromJson(child, out, depth + 1);
    }
  }
}

/** 纯文本兜底：markdown 链接优先，否则按行取 URL 与相邻标题。 */
function collectFromText(text, out) {
  let lastTitle = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const markdown = [...line.matchAll(/\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/g)];
    if (markdown.length) {
      for (const m of markdown) out.push({ url: m[2], title: m[1] || lastTitle, excerpt: line.slice(0, 500) });
      continue;
    }
    const match = URL_ONE_RE.exec(line);
    if (!match) {
      if (line.length > 1 && line.length <= 200 && !/^[|#>]/.test(line)) lastTitle = line;
      continue;
    }
    const url = match[0].replace(/[.,;:、，。；）】]+$/, "");
    const stripped = line.replace(match[0], " ").replace(/^[\s\-*•\d.)、]+/, "").replace(/[*_`>#|]+/g, " ").trim();
    out.push({ url, title: stripped || lastTitle, excerpt: line.slice(0, 500) });
  }
}

function parseOutput(raw, actualBackend) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const records = [];
  const parsed = maybeParseJson(text);
  if (parsed) collectFromJson(parsed, records);
  if (!records.length) collectFromText(text, records);
  return evidenceFrom(records, actualBackend);
}

export function createProvider(deps = {}) {
  const depsRef = deps || {};
  const runCli = depsRef.transport?.runCli || coreRunCli;
  const bin = depsRef.mcporterBin || "mcporter";

  async function probe() {
    const servers = serverList(depsRef);
    if (!servers.length) {
      return {
        configured: false,
        installed: null,
        verifiedAt: null,
        health: "unknown",
        reason: "未配置 deps.credentials.exaServers（mcporter server 列表为空）",
      };
    }
    return {
      configured: true,
      installed: null,
      verifiedAt: null,
      health: "unknown",
      reason: `mcporter server: ${servers.join(", ")}；probe 不实际调用 mcporter`,
    };
  }

  async function execute(task, ctx) {
    const input = task?.input || {};
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new TransportError("exa.search 需要 input.query", "invalid_input");
    const servers = serverList(depsRef);
    if (!servers.length) {
      throw new TransportError("未配置 Exa mcporter server（deps.credentials.exaServers）", "unavailable");
    }

    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), MAX_RESULTS);
    const codeMode = wantsCodeMode(input);
    const warnings = [];
    const webArgs = `query: ${JSON.stringify(query)}, numResults: ${limit}`;
    let calls = 0;

    const attempt = async (server, tool, argsExpr) => {
      calls += 1;
      try {
        const r = await runCli(bin, ["call", `${server}.${tool}(${argsExpr})`], ctx, {
          timeoutMs: EXA_CALL_TIMEOUT_MS,
        });
        const text = String(r.stdout || "").trim();
        if (!text) return { kind: "error", code: "unavailable", detail: "mcporter 无输出" };
        if (TOOL_ERROR_RE.test(text)) {
          return { kind: "error", code: /rate limit/i.test(text) ? "rate_limit" : "unavailable", detail: text };
        }
        return { kind: "text", text };
      } catch (err) {
        const e = errorFrom(err, "unavailable");
        return { kind: "error", code: e.code, detail: e.message };
      }
    };

    const noteFallback = () => {
      if (!warnings.includes("code_tool_unavailable_fallback")) warnings.push("code_tool_unavailable_fallback");
    };

    let last = null;
    for (const server of servers) {
      if (codeMode) {
        const code = await attempt(server, "get_code_context_exa", `query: ${JSON.stringify(query)}, tokensNum: ${CODE_TOKENS}`);
        if (code.kind === "text") {
          const evidence = parseOutput(code.text, server);
          if (evidence.length) return { status: "ok", evidence, warnings, usage: usageOf(calls) };
          warnings.push(`exa_code_no_url:${server}`);
          return { status: "empty", evidence: [], warnings, usage: usageOf(calls) };
        }
        // code 工具缺失或限流：同一 server 上回退 web 搜索，并如实记录。
        noteFallback();
        last = code;
      }
      const web = await attempt(server, "web_search_exa", webArgs);
      if (web.kind === "text") {
        const evidence = parseOutput(web.text, server);
        if (evidence.length) return { status: "ok", evidence, warnings, usage: usageOf(calls) };
        return { status: "empty", evidence: [], warnings, usage: usageOf(calls) };
      }
      warnings.push(`exa_server_failed:${server}:${web.code}`);
      last = web;
    }

    throw new TransportError(
      `Exa 全部 mcporter server 失败：${redact(last?.detail || "未知错误").slice(0, 300)}`,
      last?.code || "unavailable"
    );
  }

  return { id: "exa", capabilities: ["search"], billing: "account", probe, execute };
}
