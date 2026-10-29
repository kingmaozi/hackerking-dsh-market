/**
 * 计划展开：把宿主选择的档位转成确定性基础任务。
 * fast 的四个网页源 + X 不能被用户/宿主删除；未配置源记录不可用并由替补补位。
 */

import { PROVIDER_IDS } from "./contracts.mjs";

/** 各档基础搜索源（顺序即输出次序；并发由 scheduler 控制）。 */
export const TIER_BASE_SEARCH = {
  // 快速档：四路网页 + 微信公开搜索。小红书与浏览器 AI 源不纳入自动路由。
  fast: ["tavily", "exa", "jina", "parallel", "weixin"],
  wide: ["tavily", "exa", "jina", "parallel", "weixin", "tinyfish", "firecrawl"],
  deep: ["tavily", "exa", "jina", "parallel", "weixin", "tinyfish", "firecrawl"],
};

/** 领域配方：按主题补充渠道（宿主决定是否加入，MCP 只做白名单执行）。 */
export const DOMAIN_RECIPES = {
  code: ["github"],
  social_global: ["x", "reddit"],
  community_zh: ["v2ex"],
  video_zh: ["bilibili"],
  video_global: ["youtube"],
  academic: ["valyu", "arxiv", "crossref", "pubmed"],
  // 浏览器 AI 源：由主会话在内置浏览器中执行，MCP 只负责规划与记账。
  ai_zh: ["doubao"],
  ai_global: ["gemini"],
};

/**
 * 必须由宿主在内置浏览器执行的渠道（MCP 侧不启动浏览器）。
 * 3.2.0 起深度档不再自动派发豆包/Gemini（用户要求取消）；该标记仅用于
 * 宿主显式把宿主任务交给 MCP 记账时的识别，不产生自动任务。
 * 已移除小红书：它的搜索结果依赖登录态且详情页需要 token，稳定性不足。
 */
export const HOST_BROWSER_SOURCES = ["doubao", "gemini"];

const READ_FRESHNESS = { fast: "recent", wide: "recent", deep: "recent" };

function makeSearchTask(provider, query, limit, tier, extra = {}) {
  const task = {
    id: `base-${tier}-${provider}`,
    provider,
    operation: "search",
    input: { query, limit, ...extra },
  };
  // 需浏览器登录态的渠道交给宿主执行，MCP 不尝试启动浏览器。
  if (HOST_BROWSER_SOURCES.includes(provider)) {
    task.hostExecuted = true;
  }
  return task;
}

/**
 * 展开基础计划：
 * - 保留 plan.tasks 中宿主补充的领域任务；
 * - 补齐档位基础任务（同 provider 不重复）；
 * - 未配置的渠道保留为不可用记录，并在 fast 用 tinyfish/jina 替补网页槽；
 * - 豆包/外部研究永不自动加入。
 */
export function expandPlan(plan, registry, availability = {}) {
  const tier = plan.tier;
  const base = TIER_BASE_SEARCH[tier] || TIER_BASE_SEARCH.fast;
  const limit = tier === "fast" ? 5 : 8;
  const tasks = [];
  const audit = [];
  const seen = new Set();

  const isConfigured = (id) => {
    const state = availability[id];
    if (state === undefined) return undefined; // 未知：交给 provider 运行时判断
    return Boolean(state?.configured);
  };

  for (const id of base) {
    if (!PROVIDER_IDS.includes(id)) continue;
    const provider = registry.get(id);
    const configured = isConfigured(id);
    if (!provider || configured === false) {
      audit.push({
        provider: id,
        status: configured === false ? "unavailable" : "irrelevant",
        reason: provider ? "未配置凭据" : "适配器未注册",
      });
      continue;
    }
    seen.add(id);
    tasks.push(makeSearchTask(id, plan.query, limit, tier));
  }

  // 极速档：主力网页源不可用时，用已验证的低成本源补位（不冒名顶替）。
  if (tier === "fast") {
    // 网页四路是主力；微信公开搜索不参与替补，缺失时如实标注。
    const missingWeb = ["tavily", "exa", "jina", "parallel"].filter((id) => !seen.has(id));
    const substitutes = ["tinyfish", "firecrawl"].filter((id) => registry.get(id) && !seen.has(id));
    let i = 0;
    for (const missing of missingWeb) {
      if (i >= substitutes.length) break;
      const sub = substitutes[i++];
      if (isConfigured(sub) === false) continue;
      seen.add(sub);
      tasks.push({
        ...makeSearchTask(sub, plan.query, limit, tier),
        id: `sub-${tier}-${sub}-for-${missing}`,
        substituteFor: missing,
      });
      // 替补原因合并到该渠道已有的不可用记录，不产生重复条目。
      const existing = audit.find((a) => a.provider === missing);
      const note = `已由 ${sub} 补位（实际来源会标明）`;
      if (existing) existing.reason = `${existing.reason}；${note}`;
      else audit.push({ provider: missing, status: "unavailable", reason: note });
    }
  }

  // X 三档默认必查，除非用户明确排除社交。
  if (plan.includeSocial && registry.get("x") && !seen.has("x")) {
    const configured = isConfigured("x");
    if (configured !== false) {
      seen.add("x");
      tasks.push({ id: `social-${tier}-x`, provider: "x", operation: "search", input: { query: plan.query, limit: 10 } });
    } else {
      audit.push({ provider: "x", status: "unavailable", reason: "登录态后端未就绪" });
    }
  } else if (!plan.includeSocial) {
    audit.push({ provider: "x", status: "user_excluded", reason: "用户排除了社交渠道" });
  }

  // 宿主补充的领域任务（去重、保持顺序）。
  for (const task of plan.tasks || []) {
    if (seen.has(task.provider)) continue;
    if (!registry.get(task.provider)) {
      audit.push({ provider: task.provider, status: "unavailable", reason: "适配器未注册" });
      continue;
    }
    seen.add(task.provider);
    tasks.push({ ...task, input: { query: plan.query, ...task.input } });
  }

  // 深度档纳入浏览器 AI 源：标记为 host-executed，由主会话在内置浏览器执行。
  // 3.2.0 起深度档不再自动派发浏览器 AI 源（豆包/Gemini）：保留 reach_doubao
  // 手动工具与宿主显式派发能力，自动路由不触发浏览器任务。

  // 深度档必须对每个注册源给出适用性说明。
  if (tier === "deep") {
    for (const id of registry.keys()) {
      if (audit.some((a) => a.provider === id) || seen.has(id)) continue;
      audit.push({ provider: id, status: "irrelevant", reason: "本轮未纳入；如需覆盖请在计划中显式加入" });
    }
  }

  for (const id of seen) {
    if (!audit.some((a) => a.provider === id)) audit.push({ provider: id, status: "pending", reason: "待执行" });
  }

  return { tasks, audit, readFreshness: READ_FRESHNESS[tier] };
}

export function baseSearchProviders(tier) {
  return [...(TIER_BASE_SEARCH[tier] || TIER_BASE_SEARCH.fast)];
}
