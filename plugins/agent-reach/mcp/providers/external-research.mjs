/**
 * 外部研究服务：TinyFish Research 与 Valyu DeepResearch。
 * 默认禁用；必须提供本机授权引用（authorizationRef）才可执行，模型传入 approved=true 无效。
 */

import { makeEvidence } from "../core/evidence.mjs";
import { requestJson, redact } from "../core/transport.mjs";

const TINYFISH_RESEARCH_URL = "https://agent.tinyfish.ai/v1/automation/run-research";

function researchOutcomeFromReport({ provider, actualBackend, report, citations, runId, extraWarnings = [] }) {
  const evidence = [];
  for (const cite of citations || []) {
    const url = cite?.url || cite?.source || cite?.link;
    if (!url) continue;
    evidence.push(makeEvidence({
      provider,
      actualBackend,
      url,
      title: cite.title || cite.name || url,
      excerpt: cite.snippet || cite.quote || "",
      excerptType: "generated",
      kind: "web",
      warnings: ["external_research_citation"],
    }));
  }
  return {
    status: evidence.length || report ? (evidence.length ? "ok" : "empty") : "empty",
    evidence,
    warnings: [
      "external_research: 报告由外部服务生成，引用需抽查原文",
      "external_research: 取消不代表退款",
      ...extraWarnings,
    ],
    usage: { calls: 1, readUrls: 0, credits: null, unit: null, currency: null, amount: null },
    ...(runId ? { externalRunId: runId } : {}),
  };
}

/** 校验授权并在实际派发时消耗一次授权次数；返回消耗失败的告警（无则 null）。 */
function authorizeAndConsume(deps, providerId, task) {
  const authorization = deps.authorize ? deps.authorize(providerId, task) : { ok: false, reason: "缺少授权引用" };
  if (!authorization.ok) {
    const err = new Error(authorization.reason);
    err.code = "budget";
    throw err;
  }
  if (typeof deps.authorize?.consume === "function") {
    const c = deps.authorize.consume(providerId, task);
    // 合并磁盘计数后已用尽：硬阻断；持久化失败：仅告警。
    if (!c.ok && c.exhausted) {
      const err = new Error(c.error);
      err.code = "budget";
      throw err;
    }
    if (!c.ok && c.error) return c.error;
  }
  return null;
}

function tinyfishResearchProvider(deps) {
  return {
    id: "tinyfish_research",
    capabilities: ["research"],
    billing: "wallet",
    // 与调度层统一签名 (ctx, task)：第一参是执行上下文，第二参才是任务。
    async checkAvailability(ctx, task) {
      const configured = Boolean(deps.credentials?.tinyfish);
      if (!configured) return { configured: false, installed: null, verifiedAt: null, health: "unknown", reason: "未配置 TINYFISH_API_KEY" };
      const authorization = deps.authorize ? deps.authorize("tinyfish_research", task) : { ok: false, reason: "缺少授权引用" };
      if (!authorization.ok) return { configured: false, installed: null, verifiedAt: null, health: "unknown", reason: authorization.reason };
      return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "按次计费，费用未知项保持 unknown" };
    },
    async probe(task, ctx) {
      return this.checkAvailability(ctx, task || {});
    },
    async execute(task, ctx) {
      const consumeError = authorizeAndConsume(deps, "tinyfish_research", task);
      const body = {
        query: task.input.query,
        mode: task.input.externalDepth || "deep",
        // 浏览器代理只在授权明确允许时启用。
        ...(deps.authorize("tinyfish_research", task).allowBrowser ? { browser: true } : {}),
      };
      const res = await requestJson(TINYFISH_RESEARCH_URL, {
        method: "POST",
        headers: { "X-API-Key": deps.credentials.tinyfish, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        sse: true,
        timeoutMs: 120_000,
      }, ctx);
      const report = res.final_result?.report || res.report || res.result?.report || null;
      const citations = res.final_result?.citations || res.citations || [];
      const runId = res.research_run_id || res.run_id || res.id || null;
      if (!report && !citations.length) {
        const err = new Error(`TinyFish Research 未返回可用结果: ${redact(JSON.stringify(res)).slice(0, 200)}`);
        err.code = "upstream";
        throw err;
      }
      return researchOutcomeFromReport({
        provider: "tinyfish_research", actualBackend: "tinyfish research", report, citations, runId,
        extraWarnings: consumeError ? [consumeError] : [],
      });
    },
  };
}

function valyuResearchProvider(deps) {
  return {
    id: "valyu_research",
    capabilities: ["research"],
    billing: "wallet",
    // 与调度层统一签名 (ctx, task)：第一参是执行上下文，第二参才是任务。
    async checkAvailability(ctx, task) {
      const configured = Boolean(deps.credentials?.valyu);
      if (!configured) return { configured: false, installed: null, verifiedAt: null, health: "unknown", reason: "未配置 VALYU_API_KEY" };
      const authorization = deps.authorize ? deps.authorize("valyu_research", task) : { ok: false, reason: "缺少授权引用" };
      if (!authorization.ok) return { configured: false, installed: null, verifiedAt: null, health: "unknown", reason: authorization.reason };
      return { configured: true, installed: null, verifiedAt: null, health: "unknown", reason: "按任务定档计费，费用以官方为准" };
    },
    async probe(task, ctx) {
      return this.checkAvailability(ctx, task || {});
    },
    async execute(task, ctx) {
      const consumeError = authorizeAndConsume(deps, "valyu_research", task);
      const res = await requestJson("https://api.valyu.ai/v1/deepresearch", {
        method: "POST",
        headers: { "x-api-key": deps.credentials.valyu, "Content-Type": "application/json" },
        body: JSON.stringify({ query: task.input.query, mode: task.input.externalDepth || "standard" }),
        timeoutMs: 120_000,
      }, ctx);
      const report = res.report || res.output || null;
      const citations = res.citations || res.sources || [];
      if (!report && !citations.length) {
        const err = new Error("Valyu DeepResearch 未返回可用结果（端点与字段以官方当前文档为准）");
        err.code = "upstream";
        throw err;
      }
      return researchOutcomeFromReport({
        provider: "valyu_research", actualBackend: "valyu deepresearch", report, citations, runId: res.task_id || res.id || null,
        extraWarnings: consumeError ? [consumeError] : [],
      });
    },
  };
}

export function createExternalResearchProviders(deps = {}) {
  return [tinyfishResearchProvider(deps), valyuResearchProvider(deps)];
}
