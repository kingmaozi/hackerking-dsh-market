import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 1) skill provider
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'lcu',
  skillDir: resolve(root, 'skills'),
  rank: 490,
});
const candidates = await provider.list();
const names = candidates.map((skill) => skill.name);
if (!names.includes('lcu-computer-use')) {
  console.error(`missing skill: lcu-computer-use (found: ${names.join(', ') || 'none'})`);
  process.exit(1);
}
for (const candidate of candidates) {
  const loaded = await provider.get(candidate);
  if (loaded === undefined || loaded.content.length < 500) {
    console.error(`failed to load ${candidate.name}`);
    process.exit(1);
  }
}
console.log(`OK skills: ${names.join(', ')}`);

// 2) relay ⇄ LCU handshake, tool surface, and a read-only state call
const child = spawn('/bin/sh', [resolve(root, 'mcp/run.sh')], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buffer = '';
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  }
});

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lcu-selftest', version: '0.1.0' },
  });
  if (init.result?.serverInfo?.name !== 'lcu') throw new Error('unexpected serverInfo');
  console.log(`OK mcp: ${init.result.serverInfo.name} ${init.result.serverInfo.version} (proto ${init.result.protocolVersion})`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const list = await request('tools/list', {});
  const tools = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(['js', 'js_reset'])) {
    throw new Error(`tool surface mismatch: ${tools.join(',')}`);
  }
  console.log(`OK tools: ${tools.join(', ')} (turn_ended / js_add_node_module_dir hidden)`);

  const state = await request('tools/call', {
    name: 'js',
    arguments: { code: 'await cua.getState()', timeout_ms: 60000, title: 'selftest: list surfaces' },
  });
  const text = (state.result?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (state.result?.isError === true) throw new Error(`getState failed: ${text.slice(0, 200)}`);
  if (!text.includes('Computer Use')) throw new Error('getState did not return the Computer Use guide');
  const running = (text.match(/"isRunning":true/g) ?? []).length;
  console.log(`OK js(getState): ${text.length} chars of docs + ${running} running apps`);

  const approved = (await import('node:fs')).readFileSync(
    `${process.env.HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`,
    'utf8',
  );
  const ids = JSON.parse(approved).approvedBundleIdentifiers ?? [];
  console.log(`OK approvals: ${ids.length ? ids.join(', ') : '(none — run: lcu apps allow "<App>")'}`);
  console.log('提示：截图/点击能力已就绪；控制未批准的 App 会返回 not approved，需在终端过 Touch ID。');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (stderr) console.error(stderr.slice(-1200));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(); }, 200);
}
