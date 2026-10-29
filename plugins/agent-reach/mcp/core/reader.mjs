/**
 * 阅读层：批量取正文、时效控制、正文预算、有限回退。
 * 优先免 key 通道；回退链每级都记账，不无限升级。
 */

import { makeEvidence, mergeEvidence, normalizeUrl } from "./evidence.mjs";
import { assertSafeUserUrl } from "./transport.mjs";

const MAX_BODY_CHARS = 200_000;

function truncateBody(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_BODY_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_BODY_CHARS), truncated: true };
}

/**
 * 阅读顺序按需求分层：
 * - needsPdf：批量抓取渠道优先（TinyFish 支持 PDF 与按需渲染）。
 * - freshness=live：先用可显式要求实时抓取的渠道（TinyFish ttl=0），避免命中缓存。
 * - 默认：Jina Reader 最轻量（可匿名），失败再逐级回退。
 */
export function readerOrder(registry, options = {}) {
  const { freshness = "recent", needsPdf = false } = options;
  if (needsPdf) return ["tinyfish", "firecrawl", "jina", "scrapfly"];
  if (freshness === "live") return ["tinyfish", "jina", "firecrawl", "scrapfly"];
  return ["jina", "tinyfish", "firecrawl", "scrapfly"];
}

function evidenceFromText({ url, title, text, provider, actualBackend, freshness, truncated, warnings = [] }) {
  return makeEvidence({
    provider,
    actualBackend,
    url,
    title,
    excerpt: truncateBody(text).text,
    excerptType: "body",
    kind: "web",
    publishedAt: null,
    warnings: [...warnings, ...(truncated ? ["body_truncated"] : []), ...(freshness === "live" ? [] : [])],
  });
}

/**
 * 读取选中的 URL。返回 Outcome 形状；单个 URL 失败不影响其他 URL。
 */
export async function readSelected(urls, freshness, ctx, options = {}) {
  const registry = ctx.registry;
  // 先做安全校验，再按规范化地址去重，避免同一页面被重复读取与计费。
  const safe = (urls || []).map((u) => assertSafeUserUrl(u).toString());
  const seenCanonical = new Set();
  const wanted = [];
  for (const url of safe) {
    const canonical = normalizeUrl(url) || url;
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    wanted.push(url);
  }
  wanted.length = Math.min(wanted.length, options.maxUrls ?? 10);
  const evidence = [];
  const warnings = [];
  const byProvider = {};
  let calls = 0;
  let readUrls = 0;
  const attempted = new Set();
  const order = readerOrder(registry, { freshness, needsPdf: options.needsPdf });

  for (const url of wanted) {
    let done = false;
    for (const providerId of order) {
      const provider = registry.get(providerId);
      if (!provider || !provider.capabilities.includes("read")) continue;
      if (attempted.has(`${providerId}|${url}`)) continue;
      attempted.add(`${providerId}|${url}`);
      try {
        const available = typeof provider.checkAvailability === "function" ? await provider.checkAvailability(ctx, null) : null;
        if (available && available.configured === false) continue;
        // 只预检不记账：真实调用次数由 transport 在发出请求时记账，
        // readUrls 在读取成功后才计入，避免回退链预扣费。
        const canAttempt = typeof ctx.checkBudget === "function" ? ctx.checkBudget(1, 1) : true;
        if (!canAttempt) {
          warnings.push(`${url}: 正文读取预算不足`);
          done = true;
          break;
        }
        const task = {
          id: `read-${providerId}-${readUrls}`,
          provider: providerId,
          operation: "read",
          input: { urls: [url], freshness: freshness || "recent" },
        };
        const outcome = await provider.execute(task, ctx, { budget: ctx.budget });
        calls += outcome?.usage?.calls ?? 1;
        byProvider[providerId] = byProvider[providerId] || { calls: 0, readUrls: 0, credits: null, unit: null, currency: null, amount: null };
        byProvider[providerId].calls += outcome?.usage?.calls ?? 1;
        if (outcome?.status === "ok" && outcome.evidence?.length) {
          // 读取成功才计入 readUrls 预算。
          if (typeof ctx.reserve === "function") ctx.reserve(0, 1);
          readUrls += 1;
          byProvider[providerId].readUrls += outcome?.usage?.readUrls ?? 1;
          evidence.push(...outcome.evidence.map((e) => (e.excerptType === "body" ? e : { ...e, excerptType: "body" })));
          if (outcome.warnings?.length) warnings.push(...outcome.warnings.map((w) => `${providerId}: ${w}`));
          done = true;
          break;
        }
        // 正文为空或明显不完整时，记录后继续尝试下一级。
        if (outcome?.error) warnings.push(`${providerId} 读取失败: ${outcome.error.code}`);
        else warnings.push(`${providerId} 未返回可用正文`);
      } catch (err) {
        warnings.push(`${providerId} 读取异常: ${err?.code || err?.name || "error"}`);
      }
    }
    if (!done) warnings.push(`${url}: 所有阅读通道均失败`);
  }

  const merged = mergeEvidence(evidence);
  return {
    status: merged.length ? "ok" : "empty",
    evidence: merged,
    warnings: warnings.slice(0, 30),
    usage: { calls, readUrls, credits: null, unit: null, currency: null, amount: null },
  };
}

export { evidenceFromText, truncateBody };
