#!/usr/bin/env node
/**
 * lcu relay — 把 Codex 的 computer-use MCP（`lcu`）接到 DSH 的 MCP 客户端上。
 *
 * 为什么需要一层 relay：
 * - LCU 的 `lcu` 就是官方 cua_repl MCP 服务（rmcp 1.5.0），DSH 可以直接当 stdio MCP 起它；
 * - 但 node_repl 在 `cua.getApp(...)` 前会先看客户端声明的 `elicitation` 能力，
 *   没有就直接 fail closed：`createElicitation is unavailable because the MCP client
 *   does not support form elicitation`。DSH 的 `@deepseek-ai/dsh-mcp-client` 不声明该能力；
 * - 所以 relay 对 lcu 声明 elicitation，对 DSH 只暴露 `js` / `js_reset` 两个模型可见工具
 *   （`turn_ended` / `js_add_node_module_dir` 是宿主专用，官方 relay 也会隐藏）。
 *
 * 审批策略（不绕过人的同意）：
 * - 只读的 `cua.getState()` 不需要审批；
 * - 控制某个 App 前，运行时会对未授权的 App 发 elicitation。relay 只接受**用户已经用
 *   Touch ID 批准过**的 App（`lcu apps allow <App>` 写进
 *   `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/.../ComputerUseAppApprovals.json`），
 *   其余一律 decline，并把 App 名打到 stderr，让模型转述“要你在终端批准”。
 * - DSH 侧没有 UI 通道可以问人，所以“人”的通道就是 Touch ID + `lcu apps`。
 *
 * stdout 只承载 JSON-RPC；诊断信息写 stderr。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const LCU_BIN = process.env.LCU_BIN ?? join(homedir(), '.local/share/lcu/current/bin/lcu');
const APPROVALS = join(
  homedir(),
  'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json',
);
const APPROVAL_KEY = 'approvedBundleIdentifiers';
// 模型可见工具；官方 relay 同样只暴露这两个。
const MODEL_TOOLS = ['js', 'js_reset'];
const PROTOCOL_VERSION = '2025-06-18';

const log = (...args) => process.stderr.write(`[lcu] ${args.join(' ')}\n`);

function readApproved() {
  try {
    const document = JSON.parse(readFileSync(APPROVALS, 'utf8'));
    const ids = document?.[APPROVAL_KEY];
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

/** 从 elicitation 请求里取出目标 App 的 bundle id（没有就返回 null）。 */
function requestedApp(params) {
  const meta = params?._meta ?? {};
  const direct = meta?.tool_params?.app ?? meta?.tool_params?.bundle_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const display = Array.isArray(meta?.tool_params_display)
    ? meta.tool_params_display.find((item) => item?.name === 'app')?.value
    : undefined;
  if (typeof display === 'string' && display.trim()) return display.trim();
  return null;
}

/** 人已经批准过的才 accept；其余 decline（fail closed）。 */
function decideApproval(params) {
  const app = requestedApp(params);
  const approved = readApproved();
  if (app !== null) {
    const hit = approved.find((id) => id === app);
    if (hit !== undefined) {
      log(`approved (store): ${app}`);
      return { action: 'accept', content: {} };
    }
    log(`declined (not always-allowed): ${app} — 要控制它请在终端跑 lcu apps allow "<App>" 并过 Touch ID`);
    return { action: 'decline' };
  }
  log('declined: elicitation without a resolvable app');
  return { action: 'decline' };
}

// ---------------------------------------------------------------- upstream (lcu)

const upstream = spawn(LCU_BIN, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

upstream.stderr.on('data', (chunk) => {
  const text = chunk.toString().trimEnd();
  if (text) process.stderr.write(`${text}\n`);
});
upstream.on('exit', (code, signal) => {
  log(`upstream lcu exited code=${code} signal=${signal}`);
  process.exit(0);
});

let upstreamBuffer = '';
let nextUpstreamId = 1;
const upstreamPending = new Map();

function sendUpstream(message) {
  upstream.stdin.write(`${JSON.stringify(message)}\n`);
}

function requestUpstream(method, params, timeoutMs = 300_000) {
  const id = nextUpstreamId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      upstreamPending.delete(id);
      reject(new Error(`upstream timeout: ${method}`));
    }, timeoutMs);
    upstreamPending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    sendUpstream({ jsonrpc: '2.0', id, method, params });
  });
}

function answerUpstream(message) {
  if (message.method === 'elicitation/create') {
    const decision = decideApproval(message.params);
    sendUpstream({ jsonrpc: '2.0', id: message.id, result: decision });
    return;
  }
  if (message.method === 'ping') {
    sendUpstream({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'roots/list') {
    sendUpstream({ jsonrpc: '2.0', id: message.id, result: { roots: [] } });
    return;
  }
  sendUpstream({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
}

upstream.stdout.on('data', (chunk) => {
  upstreamBuffer += chunk.toString();
  let index;
  while ((index = upstreamBuffer.indexOf('\n')) !== -1) {
    const line = upstreamBuffer.slice(0, index).trim();
    upstreamBuffer = upstreamBuffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method !== undefined) {
      if (message.id !== undefined) answerUpstream(message);
      continue;
    }
    const settle = upstreamPending.get(message.id);
    if (settle !== undefined) {
      upstreamPending.delete(message.id);
      settle(message);
    }
  }
});

const initUpstream = await requestUpstream('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { elicitation: {} },
  clientInfo: { name: 'lcu-relay', version: '0.1.0' },
}, 60_000);
if (initUpstream.error !== undefined) {
  log(`upstream initialize failed: ${JSON.stringify(initUpstream.error)}`);
  process.exit(1);
}
sendUpstream({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
const upstreamInfo = initUpstream.result?.serverInfo ?? {};
const upstreamInstructions = initUpstream.result?.instructions ?? '';
log(`upstream ready: ${upstreamInfo.name ?? '?'} ${upstreamInfo.version ?? '?'}`);

// ---------------------------------------------------------------- downstream (DSH)

const RELAY_INSTRUCTIONS = [
  upstreamInstructions.trim(),
  '',
  'Approval policy of this relay: only apps the owner already allowed through Touch ID (`lcu apps allow`) can be controlled;',
  'anything else is declined, and the tool result says "Computer Use was not approved to use <App>". When that happens, tell the owner',
  'to run `lcu apps allow "<App>"` in a terminal (it asks for Touch ID) and retry. Do not retry the same call in a loop.',
].filter((line) => line !== undefined).join('\n').trim();

function writeDownstream(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleCall(message) {
  const { name, arguments: args } = message.params ?? {};
  if (!MODEL_TOOLS.includes(name)) {
    writeDownstream({
      jsonrpc: '2.0', id: message.id,
      error: { code: -32601, message: `Unknown tool: ${name} (this relay exposes ${MODEL_TOOLS.join(', ')})` },
    });
    return;
  }
  const result = await requestUpstream('tools/call', { name, arguments: args ?? {} }, 300_000);
  if (result.error !== undefined) {
    writeDownstream({ jsonrpc: '2.0', id: message.id, error: result.error });
    return;
  }
  writeDownstream({ jsonrpc: '2.0', id: message.id, result: result.result });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try { message = JSON.parse(text); } catch {
    writeDownstream({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const { id, method } = message;
  try {
    if (method === 'initialize') {
      writeDownstream({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lcu', version: `${upstreamInfo.version ?? '0'} (dsh-relay)` },
          instructions: RELAY_INSTRUCTIONS,
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') return;
    if (method === 'ping') {
      writeDownstream({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      const list = await requestUpstream('tools/list', {}, 30_000);
      const tools = (list.result?.tools ?? []).filter((tool) => MODEL_TOOLS.includes(tool.name));
      writeDownstream({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (method === 'tools/call') {
      await handleCall(message);
      return;
    }
    if (method === 'prompts/list') {
      writeDownstream({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    }
    if (method === 'resources/list') {
      writeDownstream({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    }
    if (id !== undefined) {
      writeDownstream({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method: ${method}` } });
    }
  } catch (error) {
    if (id !== undefined) {
      writeDownstream({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});

lines.on('close', () => {
  upstream.stdin.end();
  setTimeout(() => { upstream.kill('SIGTERM'); process.exit(0); }, 200);
});
