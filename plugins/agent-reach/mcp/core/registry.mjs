/**
 * 渠道注册表：唯一可信来源，声明每个渠道的能力、计费属性和配置要求。
 * 未完成适配器标记 unavailable，不假装空结果。
 */

import { PROVIDER_IDS } from "./contracts.mjs";
import * as tavily from "../providers/tavily.mjs";
import * as exa from "../providers/exa.mjs";
import * as jina from "../providers/jina.mjs";
import * as parallel from "../providers/parallel.mjs";
import * as tinyfish from "../providers/tinyfish.mjs";
import * as firecrawl from "../providers/firecrawl.mjs";
import * as valyu from "../providers/valyu.mjs";
import * as scrapfly from "../providers/scrapfly.mjs";
import * as community from "../providers/community.mjs";
import * as academic from "../providers/academic.mjs";
import * as externalResearch from "../providers/external-research.mjs";

export const REGISTRY_SCHEMA_VERSION = 1;

/** 领域领域标签用于三档选择与深度覆盖审计。 */
export const CHANNEL_META = {
  tavily: { domain: "web", region: "global+zh", strength: "中文网页与新闻检索" },
  exa: { domain: "web", region: "global", strength: "英文技术、代码与语义检索" },
  jina: { domain: "web", region: "global", strength: "检索结果与网页正文（Jina Reader/Search）" },
  parallel: { domain: "web", region: "global", strength: "匿名免 key 基础检索" },
  tinyfish: { domain: "web", region: "global", strength: "免费检索与批量正文/PDF" },
  firecrawl: { domain: "web", region: "global", strength: "搜索与站点正文提取" },
  valyu: { domain: "academic", region: "global", strength: "网页与专业数据检索" },
  scrapfly: { domain: "web", region: "global", strength: "难页面提取与按需渲染" },
  x: { domain: "social", region: "global", strength: "当事人动态与即时讨论" },
  github: { domain: "code", region: "global", strength: "仓库、代码与 issue" },
  reddit: { domain: "social", region: "global", strength: "英文社区真实经验" },
  v2ex: { domain: "social", region: "zh", strength: "中文技术社区" },
  weixin: { domain: "social", region: "zh", strength: "微信公众号文章（搜狗微信，免登录）" },
  bilibili: { domain: "video", region: "zh", strength: "中文视频演示与评测" },
  youtube: { domain: "video", region: "global", strength: "长视频与字幕" },
  rss: { domain: "web", region: "global", strength: "固定信息源更新" },
  arxiv: { domain: "academic", region: "global", strength: "预印本" },
  crossref: { domain: "academic", region: "global", strength: "DOI 与元数据" },
  pubmed: { domain: "academic", region: "global", strength: "医学文献元数据" },
  doubao: { domain: "web", region: "zh", strength: "桌面豆包联网（显式调用，需授权）" },
  tinyfish_research: { domain: "research", region: "global", strength: "外部研究报告（钱包计费，需授权）" },
  valyu_research: { domain: "research", region: "global", strength: "外部深度研究（付费，需授权）" },
};

export function createRegistry(deps = {}) {
  const map = new Map();
  const register = (raw) => {
    if (!raw || !raw.id) return;
    if (!PROVIDER_IDS.includes(raw.id)) {
      throw new Error(`注册了未知 provider id: ${raw.id}`);
    }
    map.set(raw.id, normalizeProvider(raw));
  };
  const factories = [tavily, exa, jina, parallel, tinyfish, firecrawl, valyu, scrapfly, community, academic, externalResearch];
  for (const mod of factories) {
    try {
      if (typeof mod.createProviders === "function") {
        for (const p of mod.createProviders(deps)) register(p);
      } else if (typeof mod.createProvider === "function") {
        register(mod.createProvider(deps));
      } else if (typeof mod.createAcademicProviders === "function") {
        for (const p of mod.createAcademicProviders(deps)) register(p);
      } else if (typeof mod.createCommunityProviders === "function") {
        for (const p of mod.createCommunityProviders(deps)) register(p);
      } else if (typeof mod.createExternalResearchProviders === "function") {
        for (const p of mod.createExternalResearchProviders(deps)) register(p);
      }
    } catch (err) {
      deps.onRegisterError?.(mod, err);
    }
  }
  return map;
}

/** 统一 provider 接口：补齐 checkAvailability，缺失能力不外泄。 */
export function normalizeProvider(raw) {
  const provider = { ...raw };
  if (typeof provider.checkAvailability !== "function") {
    provider.checkAvailability = typeof provider.probe === "function"
      ? (ctx, task) => provider.probe(task, ctx)
      : async () => ({ configured: null, installed: null, verifiedAt: null, health: "unknown", reason: "该渠道未提供可用性探测" });
  }
  if (typeof provider.probe !== "function") {
    provider.probe = (task, ctx) => provider.checkAvailability(ctx, task);
  }
  if (!Array.isArray(provider.capabilities)) provider.capabilities = [];
  return provider;
}

export function describeRegistry(registry, credentialsStatus = {}, credentialStatusFn = null) {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    tierBudgets: {
      fast: { concurrency: 6, calls: 12, readUrls: 3, rounds: 1 },
      wide: { concurrency: 6, calls: 40, readUrls: 12, rounds: 2 },
      deep: { concurrency: 6, calls: 100, readUrls: 30, rounds: 3 },
    },
    providers: [...registry.values()].map((p) => {
      const status = credentialStatusFn ? credentialStatusFn(p.id, credentialsStatus) : null;
      return {
        id: p.id,
        capabilities: p.capabilities,
        billing: p.billing,
        ...(CHANNEL_META[p.id] || {}),
        ...(status ? { configured: status.configured, reason: status.reason ?? null } : { configured: null }),
      };
    }),
  };
}
