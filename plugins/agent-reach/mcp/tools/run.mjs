/**
 * reach_run 工具：三档研究运行的统一入口。
 */

import { jsonResponse, renderEvidenceReport } from "../core/report.mjs";
import { cap } from "../legacy.mjs";

/** 统一包装为 MCP 工具返回结构。 */
const text = (value) => {
  const body = typeof value === "string" ? value : value.text;
  return { content: [{ type: "text", text: cap(body) }] };
};

export const reachRunTool = {
  name: "reach_run",
  description:
    "三档研究运行：fast=四路网页并发+X快速结论；wide=增加更多渠道与关键正文；deep=多轮跨源研究、反例与证据映射。" +
    "op=describe 查看可用渠道与档位；start 启动（自动选择基础渠道）；get 分页读取进度与证据；" +
    "advance 由助手在读取证据后补充下一轮任务与结论；resume 恢复中断；cancel 取消（取消不代表退款）；finalize 结束并提交结论。",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["describe", "start", "get", "advance", "resume", "cancel", "finalize", "report"] },
      plan: {
        type: "object",
        description: "start 时必填。{query, tier, reason, costPolicy, includeSocial, tasks, audit}",
        properties: {
          query: { type: "string" },
          tier: { type: "string", enum: ["fast", "wide", "deep"] },
          reason: { type: "string", description: "为什么选这个档位（一句话）" },
          costPolicy: { type: "string", enum: ["parallel", "save"], default: "parallel" },
          includeSocial: { type: "boolean", default: true },
          tasks: { type: "array", description: "助手补充的领域任务（可选）", items: { type: "object" } },
          audit: { type: "array", items: { type: "object" } },
        },
        required: ["query", "tier"],
      },
      runId: { type: "string" },
      revision: { type: "number", description: "advance/resume/finalize 必填，用于并发冲突检测" },
      tasks: { type: "array", items: { type: "object" }, description: "advance 的第二轮任务" },
      claims: { type: "array", items: { type: "object" }, description: "结论与证据映射：{id,text,supports,contradicts,status}" },
      requestKey: { type: "string", description: "宿主的幂等标识，1–128 字符" },
      cursor: { type: "string", description: "get 分页游标" },
    },
    required: ["op"],
  },
};

export async function callReachRun(service, args = {}) {
  const op = args.op;
  switch (op) {
    case "describe":
      return text(jsonResponse(service.describe()));
    case "start": {
      if (!args.plan) throw Object.assign(new Error("start 需要 plan"), { code: "invalid_input" });
      if (!args.requestKey) throw Object.assign(new Error("start 需要 requestKey 以保证幂等"), { code: "invalid_input" });
      const snapshot = await service.start(args.plan, args.requestKey);
      return text(jsonResponse(summarize(snapshot, { includeEvidence: true })));
    }
    case "get": {
      if (!args.runId) throw Object.assign(new Error("get 需要 runId"), { code: "invalid_input" });
      const snapshot = await service.get(args.runId, args.cursor);
      return text(jsonResponse(snapshot));
    }
    case "advance": {
      requireRunArgs(args, ["runId", "revision", "requestKey"]);
      const snapshot = await service.advance(args.runId, args.revision, args.tasks || [], args.claims || [], args.requestKey);
      return text(jsonResponse(summarize(snapshot, { includeEvidence: true })));
    }
    case "resume": {
      requireRunArgs(args, ["runId", "revision", "requestKey"]);
      const snapshot = await service.resume(args.runId, args.revision, args.requestKey);
      return text(jsonResponse(summarize(snapshot, { includeEvidence: true })));
    }
    case "cancel": {
      requireRunArgs(args, ["runId"]);
      const snapshot = await service.cancel(args.runId);
      return text(jsonResponse({ ...snapshot, note: "取消不代表退款；外部计费任务可能已产生费用" }));
    }
    case "finalize": {
      requireRunArgs(args, ["runId", "revision"]);
      const snapshot = await service.finalize(args.runId, args.revision, args.claims || []);
      return text(jsonResponse(snapshot));
    }
    case "report": {
      requireRunArgs(args, ["runId"]);
      const snapshot = await service.get(args.runId, null);
      return text(renderEvidenceReport(snapshot));
    }
    default:
      throw Object.assign(new Error(`未知 op: ${op}`), { code: "invalid_input" });
  }
}

function requireRunArgs(args, fields) {
  for (const field of fields) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
      throw Object.assign(new Error(`${args.op} 需要 ${field}`), { code: "invalid_input" });
    }
  }
}

/** 返回给宿主的摘要：状态、覆盖、证据与前缀，避免超长。 */
function summarize(snapshot, { includeEvidence = false } = {}) {
  const { evidence = [], ...rest } = snapshot;
  return {
    ...rest,
    evidenceCount: evidence.length,
    ...(includeEvidence ? { evidence } : {}),
  };
}
