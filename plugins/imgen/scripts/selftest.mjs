import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'imgen',
  skillDir: resolve(root, 'skills'),
  rank: 470,
});
const candidates = await provider.list();
if (!candidates.some((skill) => skill.name === 'imgen')) {
  console.error('missing skill: imgen');
  process.exit(1);
}
for (const candidate of candidates) {
  const loaded = await provider.get(candidate);
  if (loaded === undefined || loaded.content.length < 500) {
    console.error(`failed to load ${candidate.name}`);
    process.exit(1);
  }
}
console.log(`OK skills: ${candidates.map((skill) => skill.name).join(', ')}`);

// MCP handshake through the same launcher the host patch uses.
try {
  await access(resolve(root, 'mcp/launch.sh'));
} catch {
  console.error('missing mcp/launch.sh');
  process.exit(1);
}

const child = spawn('/bin/sh', [resolve(root, 'mcp/launch.sh')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});
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

function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'imgen-selftest', version: '0.1.0' },
  });
  if (init.result?.serverInfo?.name !== 'imgen') throw new Error('unexpected serverInfo');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const list = await request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = ['imgen_generate', 'imgen_health'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`tools mismatch: ${names.join(',')}`);
  }
  console.log(`OK mcp tools: ${names.join(', ')}`);
  const health = await request('tools/call', { name: 'imgen_health', arguments: {} });
  const text = health.result?.content?.[0]?.text ?? '';
  const firstLine = text.split('\n')[0] ?? '';
  console.log(`OK imgen_health: ${firstLine}`);
  if (!text.includes('登录文件')) throw new Error('health output missing login section');
  console.log('  提示：imgen_health 不联网，不消耗额度；出图请显式给 out_path。');
} catch (error) {
  console.error(`FAIL mcp: ${error.message}`);
  if (stderr) console.error(stderr.slice(-1500));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(); }, 150);
}
