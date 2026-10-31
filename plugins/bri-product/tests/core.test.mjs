import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentHash,
  diffCatalog,
  formatCompareMarkdown,
  normalizeProduct,
  resolveProduct,
  searchProducts,
  similarProducts,
  toCsv,
} from '../lib/catalog.mjs';
import { syncCatalog } from '../lib/sync.mjs';
import { loadIndex } from '../lib/store.mjs';
import { assertAllowedUrl, isAllowedUrl } from '../lib/net.mjs';
import { auditCoverage, coverageForProduct } from '../lib/audit.mjs';

function rawProduct(overrides = {}) {
  return {
    id: 1,
    name: '奶酪芝士玉米棒160g',
    brand: '纳宝帝',
    category: '膨化食品',
    is_processed: true,
    images: [
      { field: 'package_front', url: 'https://cdn.example.com/front.jpg?v=aaa', thumb: 'https://cdn.example.com/front.webp?v=aaa' },
      { field: 'package_side', url: 'https://cdn.example.com/side.jpg?v=aaa', thumb: 'https://cdn.example.com/side.webp?v=aaa' },
    ],
    ...overrides,
  };
}

test('normalizeProduct extracts image and thumb URLs', () => {
  const product = normalizeProduct(rawProduct());
  assert.equal(product.id, 1);
  assert.equal(product.name, '奶酪芝士玉米棒160g');
  assert.equal(product.images.package_front, 'https://cdn.example.com/front.jpg?v=aaa');
  assert.equal(product.thumbs.package_front, 'https://cdn.example.com/front.webp?v=aaa');
  assert.equal(product.images.ingredient_list, undefined);
});

test('contentHash ignores cache-bust version', () => {
  const a = normalizeProduct(rawProduct());
  const b = normalizeProduct(rawProduct({ images: [
    { field: 'package_front', url: 'https://cdn.example.com/front.jpg?v=bbb', thumb: 'https://cdn.example.com/front.webp?v=bbb' },
    { field: 'package_side', url: 'https://cdn.example.com/side.jpg?v=bbb', thumb: 'https://cdn.example.com/side.webp?v=bbb' },
  ] }));
  assert.equal(contentHash(a), contentHash(b));
});

test('contentHash changes when product content changes', () => {
  const a = normalizeProduct(rawProduct());
  const b = normalizeProduct(rawProduct({ name: '新名字' }));
  assert.notEqual(contentHash(a), contentHash(b));
});

test('diffCatalog adds, updates, keeps local-only and never deletes', () => {
  const original = normalizeProduct(rawProduct({ id: 1, name: '旧名字' }));
  const localOnly = normalizeProduct(rawProduct({ id: 99, name: '本地独有' }));
  const incoming = normalizeProduct(rawProduct({ id: 1, name: '新名字' }));
  const fresh = normalizeProduct(rawProduct({ id: 2, name: '新增商品' }));

  const { products, changes } = diffCatalog([original, localOnly], [incoming, fresh], '2026-10-31T00:00:00.000Z');

  assert.equal(products.length, 3);
  assert.equal(changes.added.length, 1);
  assert.equal(changes.updated.length, 1);
  assert.equal(changes.localOnly.length, 1);

  const kept = products.find((item) => item.id === 99);
  assert.equal(kept.localOnly, true);
  assert.equal(kept.name, '本地独有');

  const updated = products.find((item) => item.id === 1);
  assert.equal(updated.name, '新名字');
  assert.equal(updated.localOnly, false);
});

test('searchProducts ranks exact name before partial matches and filters brand', () => {
  const products = [
    normalizeProduct(rawProduct({ id: 1, name: '奶酪芝士玉米棒160g' })),
    normalizeProduct(rawProduct({ id: 2, name: '奶酪味薯片' })),
    normalizeProduct(rawProduct({ id: 3, name: '巧克力玉米棒', brand: '其他' })),
  ];

  const result = searchProducts(products, { query: '奶酪', limit: 10 });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].id, 1);
  assert.equal(result.items[1].id, 2);

  const filtered = searchProducts(products, { query: '', brand: '纳宝帝', limit: 10 });
  assert.equal(filtered.total, 2);
});

test('resolveProduct handles id, unique name and ambiguity', () => {
  const products = [
    normalizeProduct(rawProduct({ id: 1, name: '同名商品' })),
    normalizeProduct(rawProduct({ id: 2, name: '同名商品' })),
    normalizeProduct(rawProduct({ id: 3, name: '唯一商品' })),
  ];

  assert.equal(resolveProduct(products, 3).product.id, 3);
  assert.equal(resolveProduct(products, '唯一商品').product.id, 3);
  assert.match(resolveProduct(products, '同名商品').error, /匹配到 2 个商品/);
});

test('formatCompareMarkdown includes both products and image links', () => {
  const a = normalizeProduct(rawProduct({ id: 1, name: '商品A' }));
  const b = normalizeProduct(rawProduct({ id: 2, name: '商品B' }));
  const markdown = formatCompareMarkdown([a, b]);
  assert.match(markdown, /商品A/);
  assert.match(markdown, /商品B/);
  assert.match(markdown, /包装正面/);
  assert.match(markdown, /cdn\.example\.com/);
});

test('similarProducts prefers same brand and category', () => {
  const products = [
    normalizeProduct(rawProduct({ id: 1, name: '纳宝帝奶酪玉米棒160g', brand: '纳宝帝', category: '膨化食品' })),
    normalizeProduct(rawProduct({ id: 2, name: '纳宝帝巧克力玉米棒160g', brand: '纳宝帝', category: '膨化食品' })),
    normalizeProduct(rawProduct({ id: 3, name: '其他品牌奶酪薯片', brand: '其他', category: '膨化食品' })),
    normalizeProduct(rawProduct({ id: 4, name: '纳宝帝奶酪威化', brand: '纳宝帝', category: '饼干糕点' })),
  ];

  const result = similarProducts(products, products[0], { limit: 3 });
  assert.equal(result.items[0].id, 2);
  assert.ok(result.items.every((item) => item.id !== 1));

  const sameBrand = similarProducts(products, products[0], { limit: 5, sameBrandOnly: true });
  assert.ok(sameBrand.items.every((item) => item.brand === '纳宝帝'));
});

test('network allowlist only permits bri-king, COS and local fallback', () => {
  assert.equal(isAllowedUrl('https://ai.bri-king.com/api/products'), true);
  assert.equal(isAllowedUrl('https://product-images-1254409121.cos.ap-shanghai.myqcloud.com/a.jpg'), true);
  assert.equal(isAllowedUrl('http://127.0.0.1:8001/api/products'), true);
  assert.equal(isAllowedUrl('http://localhost:8001/api/products'), true);
  assert.equal(isAllowedUrl('https://evil.example.com/steal'), false);
  assert.equal(isAllowedUrl('file:///etc/passwd'), false);
  assert.throws(() => assertAllowedUrl('https://evil.example.com/x'), /不在允许的域名列表内/);
});

test('auditCoverage reports missing image fields per product', () => {
  const allFields = ['package_front', 'package_side', 'package_middle', 'ingredient_list', 'product_inner'];
  const complete = normalizeProduct(rawProduct({
    id: 1,
    images: allFields.map((field) => ({
      field,
      url: `https://cdn.example.com/${field}.jpg`,
      thumb: `https://cdn.example.com/${field}.webp`,
    })),
  }));
  const partial = normalizeProduct(rawProduct({
    id: 2,
    images: [{ field: 'package_front', url: 'https://cdn.example.com/front.jpg' }],
  }));

  const one = coverageForProduct(partial);
  assert.equal(one.present, 1);
  assert.equal(one.complete, false);
  assert.ok(one.missing.includes('包装侧面'));

  const report = auditCoverage([complete, partial]);
  assert.equal(report.total, 2);
  assert.equal(report.complete, 1);
  assert.equal(report.incomplete, 1);
  assert.equal(report.missingByField.package_side, 1);
});

test('toCsv escapes commas and quotes', () => {
  const product = normalizeProduct(rawProduct({ name: '带,逗号"商品' }));
  const csv = toCsv([product]);
  assert.match(csv, /"带,逗号""商品"/);
});

test('syncCatalog is incremental and preserves local-only products', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bri-product-library-test-'));
  try {
    const rows = [rawProduct({ id: 1, name: '商品一' }), rawProduct({ id: 2, name: '商品二' })];
    let payload = rows;
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ success: true, total: payload.length, data: payload }),
    });

    const first = await syncCatalog({ force: true, home, fetchImpl, server: 'https://fake.example' });
    assert.equal(first.added, 2);
    assert.equal(first.total, 2);

    const second = await syncCatalog({ force: true, home, fetchImpl, server: 'https://fake.example' });
    assert.equal(second.unchanged, 2);
    assert.equal(second.added, 0);

    // 手动模拟一条本地独有商品
    const index = await loadIndex(home);
    index.products.push({
      ...normalizeProduct(rawProduct({ id: 99, name: '本地独有' })),
      contentHash: 'local-hash',
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      localOnly: false,
    });
    const { saveIndex } = await import('../lib/store.mjs');
    await saveIndex(index, home);

    payload = [rawProduct({ id: 1, name: '商品一改名' }), rawProduct({ id: 2, name: '商品二' })];
    const third = await syncCatalog({ force: true, home, fetchImpl, server: 'https://fake.example' });
    assert.equal(third.updated, 1);
    assert.equal(third.localOnly, 1);

    const finalIndex = await loadIndex(home);
    assert.equal(finalIndex.products.length, 3);
    assert.equal(finalIndex.products.find((item) => item.id === 99).localOnly, true);
    assert.equal(finalIndex.products.find((item) => item.id === 1).name, '商品一改名');

    const meta = JSON.parse(await readFile(join(home, 'meta.json'), 'utf8'));
    assert.equal(meta.lastError, null);
    assert.equal(meta.counts.total, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
