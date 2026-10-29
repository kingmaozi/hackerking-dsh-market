import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'agent-reach-mcp',
  skillDir: resolve(root, 'skills'),
  rank: 480,
});
const candidates = await provider.list();
const names = candidates.map((skill) => skill.name);
if (!names.includes('agent-reach-mcp')) {
  console.error(`missing skill: agent-reach-mcp (found: ${names.join(', ') || 'none'})`);
  process.exit(1);
}
if (names.includes('agent-reach')) {
  console.error('collision: skill must be named agent-reach-mcp, not agent-reach');
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
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120000);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-reach-selftest', version: '0.1.0' },
  });
  if (init.result?.serverInfo?.name !== 'agent-reach') throw new Error('unexpected serverInfo');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const list = await request('tools/list', {});
  const tools = (list.result?.tools ?? []).map((tool) => tool.name);
  for (const required of ['reach_run', 'reach_status', 'reach_search', 'reach_read', 'reach_github']) {
    if (!tools.includes(required)) throw new Error(`missing tool: ${required}`);
  }
  console.log(`OK mcp tools(${tools.length}): ${tools.sort().join(', ')}`);
  const status = await request('tools/call', { name: 'reach_status', arguments: { op: 'health' } });
  const text = status.result?.content?.[0]?.text ?? '';
  if (!text.includes('渠道状态')) throw new Error('reach_status returned unexpected payload');
  const configured = (text.match(/已配置/g) ?? []).length;
  console.log(`OK reach_status: 离线体检，已配置渠道 ${configured} 个（未联网，不消耗额度）`);
} catch (error) {
  console.error(`FAIL mcp: ${error.message}`);
  if (stderr) console.error(stderr.slice(-1500));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(); }, 150);
}
