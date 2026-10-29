#!/usr/bin/env node
/**
 * imgen MCP 服务：用本机已登录的 ChatGPT / Codex 账号（OAuth）出图与改图。
 *
 * 与 imgen CLI 共用同一套核心（../lib/*）：读 ~/.codex/auth.json，
 * 必要时用 refresh_token 续期并写回，经 chatgpt.com 的 Codex Responses
 * 端点调用托管 image_generation 工具，图片从 SSE 流里取出。
 *
 * stdout 只承载 JSON-RPC；诊断信息写 stderr。
 */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { ensureValidToken, loadTokens, isTokenExpired, defaultCodexHome } from "../lib/auth.js";
import { generate, edit, usageError, validateSize } from "../lib/images.js";
import { loadOrCreateProfile } from "../lib/fingerprint.js";
import { saveImages, formatQualityNote } from "../lib/output.js";
import { ImpersonatedSession } from "../lib/http.js";

export const SERVER_NAME = "imgen";
export const SERVER_VERSION = "1.2.0";

// DSH 宿主的默认落盘根目录（ZCode 版为 ~/.zcode/imgen）。
// 可用 IMGEN_OUTPUT_HOME 覆盖。
function outputHome(env = process.env) {
  const override = env.IMGEN_OUTPUT_HOME;
  return typeof override === "string" && override.trim() !== ""
    ? resolve(override.trim())
    : join(homedir(), ".dsh", "imgen");
}

const MAX_COUNT = 4;
const MAX_REFERENCES = 5;
const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_EFFORT = "xhigh";
const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
// 实测两路并发同时出图均正常（无 429）；更高并发未验证，故封顶 2。
const CONCURRENCY = 2;

const HEALTH_TOOL = {
  name: "imgen_health",
  description:
    "本机生图体检：Codex/ChatGPT 登录态（OAuth）是否可用、令牌何时到期、TLS 指纹档、原生模块能否加载、默认输出目录。" +
    "不联网、不生成、不消耗额度。出图报错时先跑它。",
  inputSchema: { type: "object", properties: {} },
};

const GENERATE_TOOL = {
  name: "imgen_generate",
  description:
    "用本机已登录的 ChatGPT / Codex 账号生成或编辑图片（文生图 / 图生图），不消耗 API Key。" +
    "给了 reference_images 就是图生图（编辑）。建议先按 imagegen 技能的提示词规格把需求写成英文 prompt 再调用。" +
    "返回：实际保存路径、实际尺寸与实际 quality（后端会静默改写 quality，回执以实际值为准）、编排模型改写后的 prompt，以及图片本体。" +
    "单张约 15–40 秒；count>1 时按张累计耗时，请把 Bash/工具超时设为 300000ms 量级。",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "英文提示词。画幅比例要写进提示词（如 'exact 16:9 aspect ratio'），不要依赖 size。",
      },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description: `输入图路径（1~${MAX_REFERENCES} 张）。给了就是图生图；多张时在 prompt 里按序号标注角色，如 'Image 1: edit target; Image 2: style reference'。`,
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: MAX_COUNT,
        default: 1,
        description: `生成张数（1~${MAX_COUNT}）。>1 时输出文件名自动加 -1/-2 后缀。`,
      },
      out_path: {
        type: "string",
        description: "输出 PNG 路径（推荐给绝对路径，放到用户项目里）。省略则写到 ~/.dsh/imgen/<时间戳>/image.png（可用 IMGEN_OUTPUT_HOME 改根目录）。",
      },
      size: {
        type: "string",
        description: "auto（默认）或 WIDTHxHEIGHT。实测像素基本无效，画幅写进 prompt 更准；非 auto 需满足长边≤3840、16 的倍数、长短边比≤3:1。",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high", "auto"],
        default: "auto",
        description: "正式交付用 medium（后端仍可能降级，看回执）。high 实测从未生效。",
      },
      background: {
        type: "string",
        enum: ["transparent", "opaque", "auto"],
        default: "auto",
        description: "抠图资产用 transparent（返回真 RGBA 透明底）。",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        default: DEFAULT_EFFORT,
        description: "编排模型推理强度，默认 xhigh（实测服务端认这一档）。简单草稿可用 low 加快。",
      },
      model: {
        type: "string",
        default: DEFAULT_MODEL,
        description: `编排模型（负责调用图片工具），默认 ${DEFAULT_MODEL}。不要用 gpt-5.4：ChatGPT 账号会直接 400。`,
      },
    },
    required: ["prompt"],
  },
};

export const TOOLS = [HEALTH_TOOL, GENERATE_TOOL];

// ---------------------------------------------------------------- 工具函数

function maskAccountId(id) {
  if (!id) return "(未知)";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString());
  } catch {
    return null;
  }
}

/** 从 id_token / access_token 里读订阅档位，读不到不算错误。 */
function readPlan(tokens) {
  for (const token of [tokens.id_token, tokens.access_token]) {
    const payload = decodeJwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    const plan = auth?.["chatgpt_plan_type"];
    if (typeof plan === "string" && plan) return plan;
  }
  return null;
}

function formatUtc(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+Z$/, "Z");
  return join(outputHome(), stamp, "image.png");
}

function asPositiveInt(value, fallback, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw usageError(`${label} 需要是 1~${max} 的整数，收到: ${value}`);
  }
  return n;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- 工具实现

export async function imageHealth(args = {}, { home = homedir(), env = process.env } = {}) {
  const codexHome = args.codex_home ? String(args.codex_home) : defaultCodexHome();
  const authFile = join(codexHome, "auth.json");
  const lines = ["imgen 体检（本机 Codex/ChatGPT OAuth 生图）"];

  if (!existsSync(authFile)) {
    lines.push(`- 登录文件: ${authFile} ✗ 不存在`);
    lines.push("- 结论: 不可用。请先在终端跑 `codex login`，再重试。");
    return { text: lines.join("\n"), ok: false };
  }
  lines.push(`- 登录文件: ${authFile} ✓`);

  let tokens;
  try {
    tokens = loadTokens(codexHome);
  } catch (error) {
    lines.push(`- 登录内容: ✗ ${error.message}`);
    return { text: lines.join("\n"), ok: false };
  }

  const expired = isTokenExpired(tokens.access_token);
  const payload = decodeJwtPayload(tokens.access_token);
  const expMs = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  if (expired) {
    lines.push(
      tokens.refresh_token
        ? "- 登录态: access token 已过期（或 5 分钟内到期）——下次可用 refresh_token 自动续期并写回"
        : "- 登录态: access token 已过期且没有 refresh_token ✗ 需要重新 `codex login`",
    );
  } else {
    const left = expMs ? `，剩余约 ${Math.max(0, Math.round((expMs - Date.now()) / 86400000))} 天` : "";
    lines.push(`- 登录态: 有效${expMs ? `（${formatUtc(expMs)} 到期${left}）` : ""}`);
  }
  lines.push(`- 账号: ${maskAccountId(tokens.account_id)}${readPlan(tokens) ? `（订阅档位: ${readPlan(tokens)}）` : ""}`);

  try {
    const profile = loadOrCreateProfile(codexHome);
    const session = new ImpersonatedSession(5, profile.ja3, profile.akamai);
    session.close();
    lines.push(`- TLS 指纹: ${profile.label}（ja3=chrome 系 / akamai=chrome119）· 原生模块 ✓ 可加载`);
  } catch (error) {
    lines.push(`- 原生模块: ✗ ${error.message}`);
    lines.push("  修复：在插件目录执行 `npm install --omit=dev`（@ossiana/node-libcurl 按平台取预编译包；本包内置 darwin-arm64）。");
    return { text: lines.join("\n"), ok: false };
  }

  lines.push(`- 默认输出目录: ${join(outputHome(), "<时间戳>", "image.png")}${process.env.IMGEN_OUTPUT_HOME ? "（IMGEN_OUTPUT_HOME）" : ""}`);
  lines.push("- 后端: chatgpt.com Codex Responses + 托管 image_generation（图片模型服务端锁定，约 1.5MP，无 2K/4K）");
  lines.push("- 计费: 走本机账号订阅额度，不按张计费，不需要 OPENAI_API_KEY");
  return { text: lines.join("\n"), ok: true };
}

export async function imageGenerate(args = {}) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw usageError("prompt 不能为空");
  const count = asPositiveInt(args.count, 1, MAX_COUNT, "count");
  const refs = Array.isArray(args.reference_images) ? args.reference_images.map(String) : [];
  if (refs.length > MAX_REFERENCES) {
    throw usageError(`reference_images 最多 ${MAX_REFERENCES} 张，收到 ${refs.length} 张`);
  }
  const effort = String(args.effort ?? DEFAULT_EFFORT);
  if (!VALID_EFFORT.has(effort)) throw usageError(`effort 只能是 ${[...VALID_EFFORT].join("/")}，收到: ${effort}`);
  const sizeProblem = validateSize(args.size);
  if (sizeProblem) throw usageError(sizeProblem);

  const out = args.out_path ? resolve(String(args.out_path)) : defaultOutPath();
  mkdirSync(dirname(out), { recursive: true });

  const codexHome = args.codex_home ? String(args.codex_home) : defaultCodexHome();
  const { accessToken, accountId } = await ensureValidToken(codexHome);
  const tlsProfile = loadOrCreateProfile(codexHome);
  const sessionId = randomUUID();

  const base = {
    prompt,
    model: String(args.model ?? DEFAULT_MODEL),
    size: String(args.size ?? "auto"),
    quality: String(args.quality ?? "auto"),
    background: String(args.background ?? "auto"),
    effort,
  };
  const isEdit = refs.length > 0;
  if (isEdit && (refs.length < 1 || refs.length > MAX_REFERENCES)) {
    throw usageError(`图生图需要 1~${MAX_REFERENCES} 张输入图，收到 ${refs.length} 张`);
  }

  const attempts = await mapLimit(Array.from({ length: count }, (_, i) => i), CONCURRENCY, async (i) => {
    if (count > 1) process.stderr.write(`[imgen] 生成中 ${i + 1}/${count}\n`);
    try {
      const result = isEdit
        ? await edit(accessToken, accountId, sessionId, tlsProfile, { ...base, imagePaths: refs })
        : await generate(accessToken, accountId, sessionId, tlsProfile, base);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error };
    }
  });

  const succeeded = attempts.filter((a) => a.ok).map((a) => a.result);
  const failures = attempts.map((a, i) => (!a.ok ? { index: i + 1, error: a.error } : null)).filter(Boolean);
  if (!succeeded.length) {
    const first = failures[0]?.error;
    throw new Error(failures.length > 1 ? `${failures.length} 张全部失败：${first?.message}` : first?.message ?? "生成失败");
  }

  const paths = saveImages(succeeded.map((r) => r.b64), out);
  const requestedQuality = base.quality;

  const lines = [];
  lines.push(`✓ 已保存 ${paths.length} 张图片${failures.length ? `（另有 ${failures.length} 张失败）` : ""}：`);
  paths.forEach((p, i) => {
    const r = succeeded[i];
    const notes = [];
    if (r.size) notes.push(r.size);
    const qualityNote = formatQualityNote(requestedQuality, r.quality);
    if (qualityNote) notes.push(qualityNote);
    lines.push(`  ${i + 1}) ${p}${notes.length ? `（${notes.join(" · ")}）` : ""}`);
  });
  const revised = succeeded.map((r) => r.revisedPrompt).filter(Boolean).pop();
  if (revised) lines.push(`编排模型改写后的 prompt：${revised}`);
  for (const f of failures) lines.push(`  ${f.index}) 失败：${f.error?.message ?? f.error}`);

  return {
    text: lines.join("\n"),
    images: succeeded.map((r) => ({ data: r.b64, mimeType: "image/png" })),
    paths,
  };
}

// ---------------------------------------------------------------- MCP 协议

export function buildServer() {
  async function callTool(name, args = {}) {
    if (name === "imgen_health") {
      const health = await imageHealth(args);
      return { content: [{ type: "text", text: health.text }], isError: health.ok ? undefined : true };
    }
    if (name === "imgen_generate") {
      const out = await imageGenerate(args);
      return {
        content: [
          { type: "text", text: out.text },
          ...out.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
        ],
      };
    }
    throw new Error(`未知工具: ${name}`);
  }
  return { tools: TOOLS, callTool };
}

export function startStdio() {
  const server = buildServer();
  const rl = createInterface({ input: process.stdin, terminal: false });
  const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const fail = (id, code, message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return fail(null, -32700, "Parse error");
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return fail(null, -32600, "Invalid Request: 需要 JSON-RPC 请求对象");
    }
    const { id, method, params } = req;
    // 缺 id 的 JSON-RPC notification 一律静默；显式 id:null 仍按请求处理。
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
        respond(id, await server.callTool(params?.name, params?.arguments ?? {}));
      } else {
        fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      console.error(`[imgen-mcp] ${error?.message ?? error}`);
      if (method === "tools/call") {
        respond(id, { content: [{ type: "text", text: `imgen: ${error?.message ?? error}` }], isError: true });
      } else {
        fail(id, -32603, String(error?.message ?? error));
      }
    }
  });
  console.error(`[imgen-mcp] started v${SERVER_VERSION}（工具数 ${server.tools.length}）`);
  return server;
}

/** 直接运行入口判定：macOS 上 /var 是 /private/var 的符号链接，必须比对 realpath。 */
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
