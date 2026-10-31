#!/usr/bin/env node
/**
 * dsh-browser MCP server（JSON-RPC over stdio）。
 * stdout 只写 JSON-RPC；所有日志/诊断都写 stderr。
 */
import readline from 'node:readline';
import { BrowserManager } from '../lib/browser.mjs';
import { TOOL_DEFINITIONS, createToolHandlers } from '../lib/tools.mjs';

const SERVER_INFO = { name: 'dsh-browser', version: '0.1.0' };
const SUPPORTED_PROTOCOL = '2025-06-18';

const manager = new BrowserManager();
const handlers = createToolHandlers(manager);

const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  write({ jsonrpc: '2.0', id, result: payload });
}

function error(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function textContent(text) {
  return [{ type: 'text', text: String(text) }];
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    result(id, {
      protocolVersion: typeof requested === 'string' && requested !== '' ? requested : SUPPORTED_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        '本机浏览器自动化（零依赖 CDP）。默认 headless（临时 profile，不碰你日常 Chrome）；chrome 模式开可见窗口并可加载扩展；attach 连接 127.0.0.1:9222 的 Chrome。' +
        '典型流程：browser_navigate → browser_snapshot（拿到 e1/e2 ref）→ browser_click / browser_type → browser_screenshot。' +
        'ref 只对当前页面有效，页面变化后重新快照。不要用本插件读 cookie/凭据，不要批量上传，browser_eval 只写短表达式。',
    });
    return;
  }

  if (method === 'ping') {
    result(id, {});
    return;
  }

  if (method === 'tools/list') {
    result(id, { tools: TOOL_DEFINITIONS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = handlers[name];
    if (handler === undefined) {
      result(id, { content: textContent(`未知工具：${name}。可用工具：${TOOL_NAMES.join('、')}`), isError: true });
      return;
    }
    try {
      const text = await handler(args);
      result(id, { content: textContent(text), isError: false });
    } catch (toolError) {
      const message = toolError?.message ?? String(toolError);
      result(id, { content: textContent(`执行失败：${message}`), isError: true });
    }
    return;
  }

  if (method === 'resources/list') {
    result(id, { resources: [] });
    return;
  }

  if (method === 'prompts/list') {
    result(id, { prompts: [] });
    return;
  }

  error(id, -32601, `不支持的方法：${method}`);
}

let queue = Promise.resolve();
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[dsh-browser] 收到 ${signal}，正在关闭 Chrome…\n`);
  try {
    manager.disposeSync();
  } catch (disposeError) {
    process.stderr.write(`[dsh-browser] 关闭清理失败：${disposeError?.message ?? disposeError}\n`);
  }
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    error(null, -32700, 'JSON 解析失败');
    return;
  }
  if (message.id === undefined || message.id === null) {
    // 通知不需要响应。
    return;
  }
  queue = queue.then(() => handleRequest(message)).catch((requestError) => {
    error(message.id, -32603, `内部错误：${requestError?.message ?? requestError}`);
  });
});

rl.on('close', () => shutdown('stdin 关闭'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[dsh-browser] unhandledRejection: ${reason?.stack ?? reason}\n`);
});
