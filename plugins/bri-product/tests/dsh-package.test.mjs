import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json declares a DSH bundle patch', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'bri-product');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(String(manifest.engines?.dsh ?? '').includes('>=0.2.1-rc.5'));
  assert.ok(manifest.files.includes('skills'));
});

test('cordis patch wires the skill provider and a portable MCP launcher', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*bri-product/);
  assert.match(patch, /id:\s*mcp-bri-product/);
  assert.match(patch, /serverName:\s*bri_product/);
  assert.match(patch, /node_modules\/bri-product\/mcp\/launch\.sh/);
  assert.match(patch, /ctx\.baseUrl/);
});

test('bundled skill is discoverable and non-trivial', async () => {
  const provider = new DirectorySkillProvider({
    logger: { warn: () => {}, debug: () => {} },
    providerName: 'bri-product',
    skillDir: join(root, 'skills'),
    rank: 490,
  });
  const candidates = await provider.list();
  const names = candidates.map((item) => item.name);
  assert.deepEqual(names, ['product-library']);
  const loaded = await provider.get(candidates[0]);
  assert.ok(loaded);
  assert.ok(loaded.content.length > 800);
  assert.match(loaded.content, /product_context/);
});

test('MCP server exposes the documented 13 tools', async () => {
  const source = await readFile(join(root, 'mcp', 'server.mjs'), 'utf8');
  const names = [...source.matchAll(/name: '(product_[a-z_]+)'/g)].map((match) => match[1]);
  const unique = [...new Set(names)].sort();
  assert.deepEqual(unique, [
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
  ].sort());
});

test('launcher is executable and diagnostics mode exists', async () => {
  const stats = await readdir(root);
  assert.ok(stats.includes('mcp'));
  const launcher = await readFile(join(root, 'mcp', 'launch.sh'), 'utf8');
  assert.match(launcher, /--check/);
  assert.match(launcher, /exec "\$NODE"/);
});
