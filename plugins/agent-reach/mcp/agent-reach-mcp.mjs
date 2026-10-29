/**
 * 新 MCP 入口：旧工具兼容层 + 三档运行工具。
 * stdout 只承载 JSON-RPC；诊断写 stderr。
 */

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { legacyTools, callLegacyTool, cap } from "./legacy.mjs";
import { createRegistry, describeRegistry } from "./core/registry.mjs";
import { loadCredentials, credentialStatus } from "./core/credentials.mjs";
import { createRunService } from "./core/runs.mjs";
import { createAuthorizer, loadAuthorizations } from "./core/authorization.mjs";
import { createHistory, describeHealth, formatHealthText } from "./core/health.mjs";
import { reachRunTool, callReachRun } from "./tools/run.mjs";
import { reachProviderTool, callReachProvider } from "./tools/provider.mjs";
import { zcodeCompatTools, legacySocialInputSchema, callZcodeCompat } from "./tools/zcode-compat.mjs";
import { redact } from "./core/transport.mjs";

export const SERVER_NAME = "agent-reach";
export const SERVER_VERSION = "3.3.0";

export function buildServer({ home = homedir(), env = process.env, registryOverrides = null } = {}) {
  const credentials = loadCredentials({ home, env });
  const credStatus = credentialStatus(credentials);
  const authorizations = loadAuthorizations({ home });
  const authorize = createAuthorizer(authorizations);

  const registry = registryOverrides || createRegistry({
    credentials,
    authorize,
    transport: null,
    onRegisterError: (mod, err) => {
      console.error(`[agent-reach-mcp] provider 注册失败: ${redact(err.message)}`);
    },
  });

  const runsRoot = join(home, ".agent-reach", "briking", "runs");
  const history = createHistory(home ? join(home, ".agent-reach", "briking") : runsRoot);

  const availability = {};
  for (const [id, status] of Object.entries(credStatus)) {
    availability[id] = { configured: status.configured, reason: status.reason };
  }

  const service = createRunService({
    registry,
    credentials,
    storageRoot: runsRoot,
    availability,
  });

  const tools = [
    reachRunTool,
    reachProviderTool,
    {
      name: "reach_status",
      description: "可信体检：分别报告各渠道的安装/配置/最近调用健康与延迟。默认离线不消耗额度；probe=true 时对目标渠道执行最小探测（只调用渠道 probe，不发起搜索），可消耗额度。",
      inputSchema: {
        type: "object",
        properties: {
          probe: { type: "boolean", default: false, description: "true 时对已配置渠道执行最小联网探测（会消耗额度）" },
          providers: { type: "array", items: { type: "string" }, description: "限定探测的渠道" },
        },
      },
    },
    ...legacyTools.map((tool) => tool.name === "reach_social" ? {
      ...tool,
      description: "Twitter 默认或明确 search 仅返回 iab 浏览器任务交接，不执行搜索；其他 action 与 Reddit 保留原后端。为旧调用保留 xhs 输入，但 3.3.0 已移除小红书能力：返回明确 unsupported/capability_removed 错误，不调用后端。",
      inputSchema: legacySocialInputSchema,
    } : tool.name === "reach_doubao" ? {
      ...tool,
      description: "豆包网页搜索任务交接（不是搜索结果）：scope=general 通用、douyin 使用内置抖音来源、both 内置多源一次检索；不打开抖音站点。返回 browser_action_required；主会话须加载 browser-automation（Playwright）或 cua_* 在已登录浏览器复用任务标签并核实来源，完成或报告阻塞。",
    } : tool),
    ...zcodeCompatTools,
  ];

  async function callTool(name, args = {}) {
    const compat = callZcodeCompat(name, args);
    if (compat !== null) return compat;
    if (name === "reach_run") return callReachRun(service, args);
    if (name === "reach_provider") return callReachProvider(registry, args);
    if (name === "reach_status") {
      const health = await describeHealth({
        registry,
        credentialsStatus: credStatus,
        history,
        probe: Boolean(args.probe),
        providers: args.providers ?? null,
      });
      return { content: [{ type: "text", text: formatHealthText(health) }] };
    }
    const out = await callLegacyTool(name, args);
    return { content: [{ type: "text", text: cap(out) }] };
  }

  return { registry, credentials, credStatus, service, tools, callTool, describe: () => describeRegistry(registry, credStatus, (id) => credStatus[id] || { configured: null }) };
}


export function startStdio() {
  const server = buildServer();
  const rl = createInterface({ input: process.stdin, terminal: false });
  const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return fail(null, -32700, "Parse error");
    }
    // 合法 JSON 但不是请求对象（null / 数组 / 标量）：不得让解构抛错拖垮进程。
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return fail(null, -32600, "Invalid Request: 需要 JSON-RPC 请求对象");
    }
    const { id, method, params } = req;
    // JSON-RPC notification（缺 id 字段）不得产生任何响应：notifications/initialized、
    // notifications/cancelled 与未知 notification 一律静默；显式 id:null 仍按请求处理。
    if (!Object.prototype.hasOwnProperty.call(req, "id")) return;
    try {
      if (method === "initialize") {
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      } else if (method === "notifications/initialized") {
        // no-op
      } else if (method === "tools/list") {
        respond(id, { tools: server.tools });
      } else if (method === "tools/call") {
        respond(id, await server.callTool(params.name, params.arguments ?? {}));
      } else {
        fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      console.error(`[agent-reach-mcp] ${redact(error.message)}`);
      if (method === "tools/call") {
        respond(id, { content: [{ type: "text", text: cap(`agent-reach: ${redact(error.message)}`) }], isError: true });
      } else {
        fail(id, -32603, redact(error.message));
      }
    }
  });
  console.error(`[agent-reach-mcp] started v${SERVER_VERSION}（工具数 ${server.tools.length}）`);
  return server;
}

/**
 * 判断是否为直接运行入口。
 * 不能用字符串比较：macOS 的 /var 是 /private/var 的符号链接，
 * 经符号链接路径启动时 argv[1] 与 import.meta.url 不一致，会导致服务静默不启动。
 */
export function isMainEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(new URL(moduleUrl))).href;
  } catch {
    try {
      return new URL(moduleUrl).href === pathToFileURL(argv1).href;
    } catch {
      return false;
    }
  }
}

if (isMainEntry()) startStdio();
