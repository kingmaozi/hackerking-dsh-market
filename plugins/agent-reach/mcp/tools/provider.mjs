/**
 * reach_provider 工具：显式只读单渠道调用。
 * 经过与运行相同的校验、预算与安全边界；付费/桌面渠道仍需授权引用。
 */

import { validateTask } from "../core/contracts.mjs";
import { createBudget, createContext } from "../core/scheduler.mjs";
import { cap } from "../legacy.mjs";

export const reachProviderTool = {
  name: "reach_provider",
  description:
    "显式只读单渠道调用（search/read）。用于精确查询与健康探测；" +
    "付费（TinyFish Research / Valyu DeepResearch）与桌面操作（豆包）仍需本机授权引用，不能借此绕过。",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "渠道 id，如 tavily / exa / jina / parallel / tinyfish / firecrawl / valyu / scrapfly / github / x / arxiv",
      },
      operation: { type: "string", enum: ["search", "read"] },
      input: {
        type: "object",
        description: "search 用 {query, limit}；read 用 {urls, freshness}",
      },
      authorizationRef: { type: "string", description: "付费/桌面渠道需要本机授权引用" },
    },
    required: ["provider", "operation", "input"],
  },
};

const text = (value) => ({ content: [{ type: "text", text: cap(value) }] });

/**
 * 执行单渠道调用。registry 必须已注册该 provider。
 */
export async function callReachProvider(registry, args = {}) {
  const provider = registry.get(args.provider);
  if (!provider) {
    throw Object.assign(new Error(`未注册的渠道: ${args.provider}`), { code: "invalid_input" });
  }
  if (!provider.capabilities.includes(args.operation)) {
    throw Object.assign(
      new Error(`${args.provider} 不支持 ${args.operation}（支持: ${provider.capabilities.join("/") || "无"}）`),
      { code: "invalid_input" }
    );
  }
  const task = validateTask({
    id: `provider-${args.provider}-${Date.now()}`,
    provider: args.provider,
    operation: args.operation,
    input: args.input,
    ...(args.authorizationRef ? { authorizationRef: args.authorizationRef } : {}),
  });

  const budget = createBudget("fast", {});
  const ctx = createContext({ budget, registry });

  const availability = typeof provider.checkAvailability === "function"
    ? await provider.checkAvailability(ctx, task)
    : null;
  if (availability && availability.configured === false) {
    throw Object.assign(
      new Error(`${args.provider} 当前不可用: ${availability.reason || "未配置"}`),
      { code: "unavailable" }
    );
  }

  const outcome = await provider.execute(task, ctx, { budget });
  return text(JSON.stringify({
    provider: args.provider,
    operation: args.operation,
    actualBackend: outcome.evidence?.[0]?.actualBackend ?? args.provider,
    status: outcome.status,
    warnings: outcome.warnings ?? [],
    usage: outcome.usage ?? null,
    evidence: outcome.evidence ?? [],
    ...(outcome.error ? { error: outcome.error } : {}),
  }, null, 2));
}
