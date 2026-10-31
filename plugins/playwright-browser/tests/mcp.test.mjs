import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function startServer(env = {}) {
  const child = spawn('/bin/sh', [join(root, 'mcp', 'launch.sh')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let buffer = '';
  let stderr = '';
  const lines = [];
  const pending = new Map();
  let nextId = 1;
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      lines.push(line);
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (settle !== undefined) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  function request(method, params, timeoutMs = 30000) {
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}\nstderr: ${stderr.slice(-800)}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    child,
    lines,
    stderr: () => stderr,
    request,
    textOf(payload) {
      return (payload.result?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    },
    async stop() {
      child.stdin.end();
      await new Promise((done) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}

test('MCP stdio 握手、tools/list、status 与错误路径', async () => {
  const home = await mkdtemp('/tmp/dsh-pw-mcp-test-');
  const server = startServer({ PLAYWRIGHT_BROWSER_HOME: home, PLAYWRIGHT_PROFILE_DIR: join(home, 'profile') });
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'playwright-browser-test', version: '0.1.0' },
    });
    assert.equal(init.result?.serverInfo?.name, 'playwright-browser');
    assert.equal(init.result?.serverInfo?.version, '0.1.0');
    assert.equal(init.result?.protocolVersion, '2025-06-18');
    assert.match(init.result?.instructions ?? '', /Playwright|playwright/);
    server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const ping = await server.request('ping', {});
    assert.deepEqual(ping.result, {});

    const list = await server.request('tools/list', {});
    const tools = (list.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(tools, [
      'browser_click', 'browser_close', 'browser_eval', 'browser_launch', 'browser_navigate',
      'browser_pdf', 'browser_screenshot', 'browser_snapshot', 'browser_status', 'browser_tabs',
      'browser_type', 'browser_wait',
    ]);
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');

    const status = await server.request('tools/call', { name: 'browser_status', arguments: {} });
    assert.equal(status.result?.isError, false);
    const statusText = server.textOf(status);
    assert.match(statusText, /未启动/);
    assert.match(statusText, /playwright-core 1\.64\.1/);
    assert.match(statusText, /Chrome：/);

    const unknown = await server.request('tools/call', { name: 'browser_foo', arguments: {} });
    assert.equal(unknown.result?.isError, true);
    assert.match(server.textOf(unknown), /未知工具/);

    const badNav = await server.request('tools/call', { name: 'browser_navigate', arguments: { url: 'javascript:alert(1)' } });
    assert.equal(badNav.result?.isError, true);
    assert.match(server.textOf(badNav), /不允许导航/);

    const badWait = await server.request('tools/call', { name: 'browser_wait', arguments: {} });
    assert.equal(badWait.result?.isError, true);
    assert.match(server.textOf(badWait), /至少一个参数/);

    const close = await server.request('tools/call', { name: 'browser_close', arguments: {} });
    assert.equal(close.result?.isError, false);
    assert.match(server.textOf(close), /没有运行/);

    const method = await server.request('resources/subscribe', {});
    assert.equal(method.error?.code, -32601);

    for (const line of server.lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.jsonrpc === '2.0' || parsed.id !== undefined);
    }
    assert.equal(server.stderr().includes('启动 headless 模式浏览器'), false, 'status 不应启动浏览器');
  } finally {
    await server.stop();
    await rm(home, { recursive: true, force: true });
  }
});
