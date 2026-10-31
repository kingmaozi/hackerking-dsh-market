import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');

const EXPECTED_TOOLS = [
  'product_brands',
  'product_cache_image',
  'product_categories',
  'product_compare',
  'product_context',
  'product_export',
  'product_image_audit',
  'product_images',
  'product_get',
  'product_search',
  'product_similar',
  'product_stats',
  'product_sync',
].sort();

// 1) skill provider
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'bri-product',
  skillDir: join(root, 'skills'),
  rank: 490,
});
const candidates = await provider.list();
const names = candidates.map((skill) => skill.name);
if (!names.includes('product-library')) {
  console.error(`missing skill: product-library (found: ${names.join(', ') || 'none'})`);
  process.exit(1);
}
const skill = await provider.get(candidates[0]);
if (skill === undefined || skill.content.length < 800) {
  console.error('failed to load product-library');
  process.exit(1);
}
console.log(`OK skills: ${names.join(', ')} (${skill.content.length} chars)`);

// 2) package manifest + launcher diagnostics
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  console.error('package.json is missing dsh.bundle.patch');
  process.exit(1);
}
console.log(`OK manifest: ${manifest.name}@${manifest.version}`);

// 3) MCP handshake + tools/list (offline)
const home = await mkdtemp(join(tmpdir(), 'bri-product-selftest-'));
const child = spawn('/bin/sh', [join(root, 'mcp', 'launch.sh')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, BRI_PRODUCT_LIBRARY_HOME: home },
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

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function textOf(payload) {
  return (payload.result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bri-product-selftest', version: '0.2.0' },
  });
  if (init.result?.serverInfo?.name !== 'bri-product') throw new Error('unexpected serverInfo');
  console.log(`OK mcp: ${init.result.serverInfo.name} ${init.result.serverInfo.version} (proto ${init.result.protocolVersion})`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const list = await request('tools/list', {});
  const tools = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`tool surface mismatch: ${tools.join(',')}`);
  }
  console.log(`OK tools: ${tools.length} (${tools.join(', ')})`);

  if (live) {
    const sync = await request('tools/call', { name: 'product_sync', arguments: { force: true } }, 60000);
    if (sync.result?.isError) throw new Error(`sync failed: ${textOf(sync).slice(0, 300)}`);
    console.log(`OK sync: ${textOf(sync).split('\n')[0]}`);

    const search = await request('tools/call', {
      name: 'product_search',
      arguments: { query: '纳宝帝', limit: 3, offline: true },
    });
    if (search.result?.isError) throw new Error(`search failed: ${textOf(search).slice(0, 300)}`);
    if (!textOf(search).includes('奶酪')) throw new Error('search returned no expected rows');
    console.log('OK search: 纳宝帝 命中');
  } else {
    console.log('SKIP live sync/search (pass --live to hit ai.bri-king.com)');
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (stderr) console.error(stderr.slice(-1200));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(async () => {
    child.kill('SIGTERM');
    await rm(home, { recursive: true, force: true }).catch(() => {});
    process.exit();
  }, 200);
}
