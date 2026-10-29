/**
 * 证据管理：URL 规范化、去重、稳定 ID、基础排序。
 * 只处理结构，不判断事实真伪。
 */

const TRACKING_PARAMS = [
  /^utm_/i, /^gclid$/i, /^fbclid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^ref$/i, /^ref_src$/i, /^spm$/i, /^from$/i, /^share_source$/i,
];

function stripTracking(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url;
}

/** 规范化：去 fragment 与常见追踪参数，保留有语义的 query 与原始 URL。 */
export function normalizeUrl(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return "";
  let url;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  stripTracking(url);
  let out = url.toString();
  if (out.endsWith("/") && url.pathname === "/") out = out.slice(0, -1);
  return out;
}

function hashId(prefix, key) {
  // 轻量稳定 hash（FNV-1a 64 位混合），仅用于本地去重标识，不用于安全用途。
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${prefix}_${h1.toString(36)}${h2.toString(36)}`;
}

export function evidenceId(provider, canonicalUrl) {
  return hashId("ev", `${provider}|${canonicalUrl}`);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * 规范化发布时间，但保留原始精度：
 * 完整时间戳转 ISO；只有年或年月时保持原样，不用 1 月 1 日凑数。
 */
function normalizePublishedAt(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // 纯年份 / 年月：保留原精度，避免把"2026 年发表"写成具体某天。
  if (/^\d{4}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

/** 把任意 provider 结果收敛为统一 Evidence；缺字段不猜。 */
export function makeEvidence({
  provider,
  actualBackend = provider,
  url,
  title = "",
  excerpt = "",
  excerptType = "snippet",
  kind = "web",
  publishedAt = null,
  fetchedAt = new Date().toISOString(),
  warnings = [],
  bodyRef = null,
  contentHash = null,
  sourceGroup = null,
}) {
  const canonicalUrl = normalizeUrl(url);
  return {
    id: evidenceId(provider, canonicalUrl || String(title)),
    canonicalUrl,
    originalUrl: String(url ?? ""),
    title: String(title || "").slice(0, 500),
    provider,
    actualBackend,
    kind,
    publishedAt: normalizePublishedAt(publishedAt),
    fetchedAt,
    excerpt: String(excerpt || "").slice(0, 5000),
    excerptType,
    bodyRef,
    contentHash,
    warnings: [...new Set(warnings.filter(Boolean))],
    sourceGroup: sourceGroup || domainOf(canonicalUrl),
  };
}

/** 合并去重：同一 URL 保留信息更全的一条，其余只增加来源标记。 */
export function mergeEvidence(items) {
  const byUrl = new Map();
  for (const item of items || []) {
    if (!item || !item.canonicalUrl) continue;
    const existing = byUrl.get(item.canonicalUrl);
    if (!existing) {
      byUrl.set(item.canonicalUrl, { ...item });
      continue;
    }
    const better = (a, b) => (a.excerpt?.length || 0) >= (b.excerpt?.length || 0) ? a : b;
    const winner = better(existing, item);
    const merged = {
      ...winner,
      warnings: [...new Set([...(existing.warnings || []), ...(item.warnings || [])])],
      publishedAt: existing.publishedAt || item.publishedAt,
      excerptType: existing.excerptType === "body" || item.excerptType === "body" ? "body" : winner.excerptType,
    };
    byUrl.set(item.canonicalUrl, merged);
  }
  return [...byUrl.values()];
}

/**
 * 基础相关性排序：实体匹配优先，其次官方域名与时间窗适合度。
 * 不因同一供应商重复返回而抬高可信度。
 */
export function rankEvidence(items, intent = {}) {
  const { entityTerms = [], preferredDomains = [], after = null, before = null } = intent;
  const terms = entityTerms.map((t) => String(t).toLowerCase()).filter(Boolean);
  const preferred = new Set(preferredDomains.map((d) => String(d).toLowerCase().replace(/^www\./, "")));
  const afterTs = after ? Date.parse(after) : null;
  const beforeTs = before ? Date.parse(before) : null;

  const score = (item) => {
    let s = 0;
    const haystack = `${item.title} ${item.excerpt}`.toLowerCase();
    for (const term of terms) if (haystack.includes(term)) s += 3;
    const domain = domainOf(item.canonicalUrl);
    if (preferred.has(domain)) s += 2;
    if (afterTs || beforeTs) {
      const ts = item.publishedAt ? Date.parse(item.publishedAt) : null;
      if (ts === null) s -= 1; // 时间未知在时间题里降权，但不剔除
      else {
        if (afterTs && ts < afterTs) s -= 2;
        if (beforeTs && ts > beforeTs) s -= 2;
      }
    }
    if (item.excerptType === "body") s += 1;
    if (item.warnings?.includes("metadata_only")) s -= 0.5;
    return s;
  };

  const ranked = items
    .map((item, index) => ({ item, index, s: score(item) }))
    .sort((a, b) => (b.s - a.s) || (a.index - b.index));

  // 同等相关性下每域最多 2 条进入首屏，保留其余结果与原始顺序信息。
  const perDomain = new Map();
  const head = [];
  const tail = [];
  for (const entry of ranked) {
    const domain = domainOf(entry.item.canonicalUrl) || "_";
    const count = perDomain.get(domain) || 0;
    if (count < 2) {
      perDomain.set(domain, count + 1);
      head.push(entry.item);
    } else {
      tail.push(entry.item);
    }
  }
  return [...head, ...tail];
}

export function groupByDomain(items) {
  const groups = new Map();
  for (const item of items) {
    const domain = domainOf(item.canonicalUrl) || "_";
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(item);
  }
  return groups;
}

export function summarizeCoverage(evidence, audit) {
  const domains = new Set(evidence.map((e) => domainOf(e.canonicalUrl)).filter(Boolean));
  const byProvider = new Map();
  for (const item of evidence) byProvider.set(item.provider, (byProvider.get(item.provider) || 0) + 1);
  return {
    evidenceCount: evidence.length,
    bodyCount: evidence.filter((e) => e.excerptType === "body").length,
    independentDomains: domains.size,
    byProvider: Object.fromEntries(byProvider),
    providersWithEvidence: [...byProvider.keys()],
    auditCount: audit.length,
  };
}
