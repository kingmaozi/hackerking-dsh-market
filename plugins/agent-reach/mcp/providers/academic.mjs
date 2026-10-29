/**
 * 开放学术源：arXiv（预印本）、Crossref（DOI 元数据）、PubMed（医学文献元数据）。
 * 限制：只提供元数据/摘要，一律 bodyRef=null 且标 metadata_only，不声称读过全文；
 * XML 只解析已知的 entry/item 结构，含 DOCTYPE/ENTITY 的输入直接按 protocol 错误拒绝。
 */

import { requestJson, requestText, redact, errorFrom, TransportError } from "../core/transport.mjs";
import { makeEvidence } from "../core/evidence.mjs";

const ARXIV_URL = "http://export.arxiv.org/api/query";
const CROSSREF_URL = "https://api.crossref.org/works";
const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function limitOf(input) {
  return Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** 将纯文本中的实体解码：Crossref 摘要是内嵌 JATS 文本，常见实体需还原。 */
function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z][\w.-]*);/g, (match, ref) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : match;
  });
}

function stripTags(text) {
  return collapse(decodeEntities(String(text ?? "").replace(/<[^>]+>/g, " ")));
}

/** 未核实为开放源直传参数时显式告警，不静默丢弃用户约束。 */
function noteFilters(input, warnings) {
  if (input.domains?.length) warnings.push("domains_filter_not_applied");
  if (input.after || input.before) warnings.push("time_filter_not_applied");
}

/** after/before 只做本地过滤；无发表时间的记录保留，避免误删。 */
function filterByDate(rows, input, dateOfRow) {
  if (!input.after && !input.before) return rows;
  const after = input.after ? Date.parse(input.after) : null;
  const before = input.before ? Date.parse(input.before) : null;
  return rows.filter((row) => {
    const raw = dateOfRow(row);
    const ts = raw ? Date.parse(raw) : NaN;
    if (Number.isNaN(ts)) return true;
    if (after !== null && ts < after) return false;
    if (before !== null && ts > before) return false;
    return true;
  });
}

/* ---------------- 已知结构 XML 解析 ---------------- */

function localName(name) {
  const raw = String(name ?? "").trim();
  const idx = raw.indexOf(":");
  return (idx === -1 ? raw : raw.slice(idx + 1)).toLowerCase();
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlText(raw) {
  return String(raw).replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z][\w.-]*);/g, (match, ref) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        throw new TransportError(`XML 字符引用无效: ${match}`, "protocol");
      }
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(NAMED_ENTITIES, ref)) return NAMED_ENTITIES[ref];
    throw new TransportError(`XML 未声明实体 ${match}，拒绝解析`, "protocol");
  });
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) attrs[localName(m[1])] = decodeXmlText(m[2] ?? m[3] ?? "");
  return attrs;
}

function appendText(node, raw, isCdata = false) {
  if (node.name === "#root") return;
  node.text += isCdata ? raw : decodeXmlText(raw);
}

/** 手写小解析器：只处理元素、属性、文本与 CDATA；DTD/实体声明一律拒绝。 */
function parseXmlTree(xml) {
  const src = String(xml ?? "");
  if (/<!DOCTYPE/i.test(src) || /<!ENTITY/i.test(src)) {
    throw new TransportError("XML 含 DOCTYPE/ENTITY 声明，拒绝解析", "protocol");
  }
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new TransportError("XML 注释未闭合", "protocol");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new TransportError("CDATA 未闭合", "protocol");
      appendText(stack[stack.length - 1], src.slice(lt + 9, end), true);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new TransportError("XML 声明未闭合", "protocol");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) throw new TransportError("XML 含未支持的声明", "protocol");
    const gt = src.indexOf(">", lt);
    if (gt === -1) throw new TransportError("XML 标签未闭合", "protocol");
    const body = src.slice(lt + 1, gt).trim();
    if (body.startsWith("/")) {
      const name = localName(body.slice(1));
      const node = stack.pop();
      if (!node || node.name !== name) throw new TransportError(`XML 标签不匹配: </${name}>`, "protocol");
    } else {
      const selfClosing = body.endsWith("/");
      const inner = selfClosing ? body.slice(0, -1) : body;
      const space = inner.search(/\s/);
      const name = localName(space === -1 ? inner : inner.slice(0, space));
      if (!name) throw new TransportError("XML 标签名为空", "protocol");
      const node = { name, attrs: parseAttrs(space === -1 ? "" : inner.slice(space)), children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new TransportError("XML 结构未闭合", "protocol");
  return root;
}

function collectRecords(node, names, out = []) {
  for (const child of node.children) {
    if (names.has(child.name)) out.push(child);
    else collectRecords(child, names, out);
  }
  return out;
}

function childText(node, ...names) {
  for (const name of names) {
    const child = node.children.find((c) => c.name === name);
    if (child) {
      const text = collapse(child.text);
      if (text) return text;
    }
  }
  return "";
}

function linkUrl(node) {
  const links = node.children.filter((c) => c.name === "link");
  const chosen = links.find((l) => (l.attrs.rel ?? "alternate") === "alternate" && l.attrs.href)
    ?? links.find((l) => l.attrs.href);
  return chosen?.attrs.href || childText(node, "link", "guid");
}

/** 从已知结构中取出 entry/item 记录；未知结构抛 protocol，不用宽泛正则兜底。 */
export function parseXmlRecords(xml) {
  const tree = parseXmlTree(xml);
  return collectRecords(tree, new Set(["entry", "item"])).map((node) => ({
    id: childText(node, "id", "guid", "identifier"),
    title: childText(node, "title"),
    summary: childText(node, "summary", "abstract", "description"),
    published: childText(node, "published", "updated", "pubdate", "date"),
    doi: childText(node, "doi"),
    journal: childText(node, "journal_ref", "journal", "publication"),
    authors: node.children.filter((c) => c.name === "author").map((a) => childText(a, "name") || collapse(a.text)).filter(Boolean),
    url: linkUrl(node),
  }));
}

function doiUrl(doi, fallbackUrl) {
  const clean = collapse(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (clean) return `https://doi.org/${clean}`;
  return fallbackUrl || "";
}

function formatDateParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const [y, m, d] = parts;
  if (!Number.isInteger(y)) return null;
  if (Number.isInteger(m) && Number.isInteger(d)) return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (Number.isInteger(m)) return `${y}-${String(m).padStart(2, "0")}`;
  return String(y);
}

/** PubMed 日期：只有年份时只写年份，不编造月日。 */
function pubmedDate(doc) {
  const sort = collapse(doc.sortpubdate);
  const sorted = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(sort);
  if (sorted) return `${sorted[1]}-${sorted[2]}-${sorted[3]}`;
  const pub = collapse(doc.pubdate);
  const year = /^(\d{4})/.exec(pub);
  if (!year) return null;
  const month = /^(\d{4})\s+([A-Za-z]{3})/.exec(pub);
  const monthIndex = month ? MONTHS.indexOf(month[2].toLowerCase()) : -1;
  if (monthIndex === -1) return year[1];
  const monthText = String(monthIndex + 1).padStart(2, "0");
  const day = /^(\d{4})\s+[A-Za-z]{3}\s+(\d{1,2})/.exec(pub);
  return day ? `${year[1]}-${monthText}-${String(day[2]).padStart(2, "0")}` : `${year[1]}-${monthText}`;
}

/* ---------------- 三个独立 Provider ---------------- */

function arxivProvider(deps) {
  const availability = () => ({
    configured: true,
    installed: null,
    verifiedAt: null,
    health: "unknown",
    reason: "公开 Atom API，无需 key；请控制请求频率并按官方说明使用",
  });
  return {
    id: "arxiv",
    capabilities: ["search"],
    billing: "anonymous",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      if (task.operation !== "search") {
        return failure(Object.assign(new Error(`arxiv 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      }
      try {
        const limit = limitOf(task.input);
        const params = new URLSearchParams({
          search_query: `all:${task.input.query}`,
          start: "0",
          max_results: String(limit),
        });
        // 官方端点为 http，跟随一次跳转到 https；固定域名，不是用户输入。
        const { text } = await requestText(`${ARXIV_URL}?${params}`, {
          method: "GET",
          headers: { Accept: "application/atom+xml" },
          timeoutMs: TIMEOUT_MS,
          redirect: "follow",
        }, ctx);

        const warnings = [];
        noteFilters(task.input, warnings);
        const records = filterByDate(parseXmlRecords(text), task.input, (r) => r.published).slice(0, limit);
        const evidence = [];
        for (const record of records) {
          const url = doiUrl(record.doi, record.url || record.id);
          if (!url) continue;
          evidence.push(makeEvidence({
            provider: "arxiv",
            actualBackend: "arxiv api",
            url,
            title: record.title || url,
            excerpt: stripTags(record.summary),
            excerptType: "snippet",
            kind: "paper",
            publishedAt: record.published || null,
            warnings: ["preprint", "metadata_only"],
          }));
        }
        return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usage(1, 0) };
      } catch (err) {
        return failure(err);
      }
    },
  };
}

function crossrefProvider(deps) {
  const settings = deps.settings?.academic ?? {};
  const availability = () => ({
    configured: true,
    installed: null,
    verifiedAt: null,
    health: "unknown",
    reason: settings.crossrefMailto
      ? "公开 REST API，无需 key；已配置联系邮箱"
      : "公开 REST API，无需 key；建议在 deps.settings.academic.crossrefMailto 提供联系邮箱",
  });
  return {
    id: "crossref",
    capabilities: ["search"],
    billing: "anonymous",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      if (task.operation !== "search") {
        return failure(Object.assign(new Error(`crossref 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      }
      try {
        const limit = limitOf(task.input);
        const params = new URLSearchParams({ query: task.input.query, rows: String(limit) });
        if (settings.crossrefMailto) params.set("mailto", String(settings.crossrefMailto));
        const data = await requestJson(`${CROSSREF_URL}?${params}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          timeoutMs: TIMEOUT_MS,
        }, ctx);
        if (data?.status && data.status !== "ok") {
          throw Object.assign(new Error(`Crossref 返回状态 ${redact(String(data.status))}`), { code: "upstream" });
        }

        const warnings = [];
        noteFilters(task.input, warnings);
        const items = Array.isArray(data?.message?.items) ? data.message.items : [];
        const rows = items.map((item) => {
          const authors = (Array.isArray(item.author) ? item.author : [])
            .map((a) => collapse([a?.given, a?.family].filter(Boolean).join(" ")) || collapse(a?.name))
            .filter(Boolean);
          const publishedAt = formatDateParts(item.published?.["date-parts"]?.[0])
            ?? formatDateParts(item.issued?.["date-parts"]?.[0])
            ?? null;
          const journal = collapse(Array.isArray(item["container-title"]) ? item["container-title"][0] : item["container-title"]);
          const abstract = stripTags(item.abstract);
          const subtitle = collapse(Array.isArray(item.title) ? item.title[0] : item.title);
          return {
            url: doiUrl(item.DOI, collapse(item.URL)),
            title: subtitle,
            publishedAt,
            // 摘要缺失时保留可核对的元数据行，并继续标 metadata_only。
            excerpt: abstract || [authors.slice(0, 3).join(", "), publishedAt, journal].filter(Boolean).join(" · "),
            warnings: /posted-content|preprint/i.test(String(item.type ?? "")) ? ["preprint", "metadata_only"] : ["metadata_only"],
          };
        });

        const evidence = [];
        for (const row of filterByDate(rows, task.input, (r) => r.publishedAt).slice(0, limit)) {
          if (!row.url) continue;
          evidence.push(makeEvidence({
            provider: "crossref",
            actualBackend: "crossref rest",
            url: row.url,
            title: row.title || row.url,
            excerpt: row.excerpt,
            excerptType: "snippet",
            kind: "paper",
            publishedAt: row.publishedAt,
            warnings: row.warnings,
          }));
        }
        return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usage(1, 0) };
      } catch (err) {
        return failure(err);
      }
    },
  };
}

function pubmedProvider(deps) {
  const settings = deps.settings?.academic ?? {};
  const availability = () => ({
    configured: true,
    installed: null,
    verifiedAt: null,
    health: "unknown",
    reason: "公开 E-utilities，无需 key；建议配置 tool/email（deps.settings.academic.pubmedTool/pubmedEmail）",
  });
  return {
    id: "pubmed",
    capabilities: ["search"],
    billing: "anonymous",
    checkAvailability: availability,
    probe: availability,
    async execute(task, ctx) {
      if (task.operation !== "search") {
        return failure(Object.assign(new Error(`pubmed 不支持 ${task.operation}`), { code: "invalid_input" }), false);
      }
      try {
        const limit = limitOf(task.input);
        const warnings = [];
        noteFilters(task.input, warnings);
        const common = {};
        if (settings.pubmedTool) common.tool = String(settings.pubmedTool);
        if (settings.pubmedEmail) common.email = String(settings.pubmedEmail);

        const searchParams = new URLSearchParams({ db: "pubmed", term: task.input.query, retmode: "json", retmax: String(limit), ...common });
        const searchData = await requestJson(`${ESEARCH_URL}?${searchParams}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          timeoutMs: TIMEOUT_MS,
        }, ctx);
        if (searchData?.esearchresult?.error) {
          throw Object.assign(new Error(`PubMed esearch 错误: ${redact(String(searchData.esearchresult.error)).slice(0, 200)}`), { code: "upstream" });
        }
        const ids = searchData?.esearchresult?.idlist;
        if (!Array.isArray(ids)) throw new TransportError("PubMed esearch 响应缺少 idlist", "protocol");
        if (!ids.length) return { status: "empty", evidence: [], warnings, usage: usage(1, 0) };

        const summaryParams = new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "json", ...common });
        const summaryData = await requestJson(`${ESUMMARY_URL}?${summaryParams}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          timeoutMs: TIMEOUT_MS,
        }, ctx);
        const result = summaryData?.result ?? {};
        const uids = Array.isArray(result.uids) ? result.uids : ids;

        const rows = uids
          .map((uid) => ({ uid, doc: result[uid] }))
          .filter((row) => row.doc)
          .map(({ uid, doc }) => {
            const doi = (Array.isArray(doc.articleids) ? doc.articleids : [])
              .find((a) => String(a?.idtype ?? "").toLowerCase() === "doi")?.value;
            const authors = (Array.isArray(doc.authors) ? doc.authors : []).map((a) => collapse(a?.name)).filter(Boolean);
            const publishedAt = pubmedDate(doc);
            const journal = collapse(doc.fulljournalname || doc.source);
            return {
              // esummary 不含摘要，只给元数据；不把元数据标成全文。PMID 链接作为 DOI 缺失时的回退。
              url: doiUrl(doi, `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(String(uid))}/`),
              title: collapse(doc.title),
              publishedAt,
              excerpt: [authors.slice(0, 3).join(", "), publishedAt, journal].filter(Boolean).join(" · "),
            };
          });

        const evidence = [];
        for (const row of filterByDate(rows, task.input, (r) => r.publishedAt).slice(0, limit)) {
          if (!row.url) continue;
          evidence.push(makeEvidence({
            provider: "pubmed",
            actualBackend: "pubmed eutils",
            url: row.url,
            title: row.title || row.url,
            excerpt: row.excerpt,
            excerptType: "snippet",
            kind: "paper",
            publishedAt: row.publishedAt,
            warnings: ["metadata_only"],
          }));
        }
        return { status: evidence.length ? "ok" : "empty", evidence, warnings, usage: usage(2, 0) };
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createAcademicProviders(deps = {}) {
  return [arxivProvider(deps), crossrefProvider(deps), pubmedProvider(deps)];
}
