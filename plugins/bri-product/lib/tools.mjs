import { extname, join } from 'node:path';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import {
  IMAGE_FIELDS,
  IMAGE_LABELS,
  formatCompareMarkdown,
  resolveProduct,
  resolveProducts,
  searchProducts,
  similarProducts,
  toCsv,
  toMarkdownList,
} from './catalog.mjs';
import {
  getHome,
  getPaths,
  indexStats,
} from './store.mjs';
import { ensureIndex, syncCatalog, DEFAULT_SERVER } from './sync.mjs';
import { assertAllowedUrl } from './net.mjs';
import { auditCoverage, auditRemote, renderAuditReport } from './audit.mjs';

const DEFAULT_CACHE_MB = Number(process.env.BRI_PRODUCT_LIBRARY_CACHE_MB || 200);
const MAX_EXPORT = 1000;

function imageList(product) {
  return IMAGE_FIELDS.filter((field) => product.images?.[field]).map((field) => ({
    field,
    label: IMAGE_LABELS[field],
    url: product.images[field],
    thumb: product.thumbs?.[field] || product.images[field],
  }));
}

function compact(product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    processed: Boolean(product.processed),
    localOnly: Boolean(product.localOnly),
    thumb: product.thumbs?.package_front || product.images?.package_front || '',
  };
}

function renderSearch(result) {
  const lines = [
    `找到 ${result.total} 个商品${result.items.length < result.total ? `，显示 ${result.offset + 1}-${result.offset + result.items.length}` : ''}${result.query ? `（关键词：${result.query}）` : ''}。`,
    '',
  ];
  if (result.items.length === 0) {
    lines.push('没有匹配的商品。可以换关键词，或先用 `product_brands` / `product_categories` 查看可筛选范围。');
    return lines.join('\n');
  }
  lines.push('| ID | 商品 | 品牌 | 分类 | 状态 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const product of result.items) {
    lines.push(
      `| ${product.id} | ${product.name} | ${product.brand || '-'} | ${product.category || '-'} | ${product.localOnly ? '本地独有' : '在库'} |`,
    );
  }
  lines.push('');
  lines.push('需要图片或做图时，用 `product_get` / `product_images` / `product_context` 带上 ID 继续。');
  return lines.join('\n');
}

function renderProduct(product) {
  const images = imageList(product);
  const lines = [
    `# ${product.name}（ID ${product.id}）`,
    '',
    `- 品牌：${product.brand || '-'}`,
    `- 分类：${product.category || '-'}`,
    `- 已渲染：${product.processed ? '是' : '否'}`,
    `- 本地独有：${product.localOnly ? '是（服务器已无此商品，本地保留）' : '否'}`,
    '',
    '## 图片',
    '',
  ];
  if (images.length === 0) lines.push('- 无图片');
  for (const image of images) {
    lines.push(`- ${image.label}：${image.url}`);
    if (image.thumb && image.thumb !== image.url) lines.push(`  - 缩略图：${image.thumb}`);
  }
  return lines.join('\n');
}

function renderContext(product) {
  const images = imageList(product);
  const lines = [
    '【商品上下文】',
    `商品：${product.name}`,
    `ID：${product.id}`,
    `品牌：${product.brand || '-'}`,
    `分类：${product.category || '-'}`,
    '',
    '参考图（可直接作为图生图 reference_images）：',
  ];
  if (images.length === 0) lines.push('- 无');
  for (const image of images) lines.push(`- ${image.label}：${image.url}`);
  lines.push('');
  lines.push('建议：做图前先确认要保留的包装元素（品牌名、净含量、口味、配料表），再用 imgen 等生图工具生成。');
  return lines.join('\n');
}

async function currentIndex(args = {}) {
  const home = getHome();
  const { index, meta, sync } = await ensureIndex({
    home,
    allowSync: args.offline !== true,
    timeoutMs: Number(args.timeout_ms) || 25000,
  });
  return { index, meta, sync, home };
}

export const toolHandlers = {
  async product_sync(args = {}) {
    const report = await syncCatalog({
      force: args.force === true,
      maxAgeMs: Number(args.max_age_hours || 6) * 60 * 60 * 1000,
      server: args.server || undefined,
      timeoutMs: Number(args.timeout_ms) || 20000,
    });
    if (report.skipped) {
      return `产品库仍然新鲜，跳过同步。上次同步：${report.lastSyncAt}，共 ${report.total} 个商品。`;
    }
    const lines = [
      `同步完成：共 ${report.total} 个商品，新增 ${report.added}，更新 ${report.updated}，未变 ${report.unchanged}，本地独有 ${report.localOnly}。`,
      `来源：${report.source}`,
      `耗时：${report.durationMs} ms`,
    ];
    if (report.changes.added.length > 0) {
      lines.push('', '新增示例：', ...report.changes.added.map((item) => `- ${item.id} ${item.name}`));
    }
    if (report.changes.updated.length > 0) {
      lines.push('', '更新示例：', ...report.changes.updated.map((item) => `- ${item.id} ${item.name}`));
    }
    if (report.changes.localOnly.length > 0) {
      lines.push(
        '',
        '本地独有（服务器没有，已保留）：',
        ...report.changes.localOnly.map((item) => `- ${item.id} ${item.name}`),
      );
    }
    return lines.join('\n');
  },

  async product_search(args = {}) {
    const { index, sync } = await currentIndex(args);
    const result = searchProducts(index.products, {
      query: args.query || '',
      brand: args.brand || '',
      category: args.category || '',
      limit: args.limit ?? 10,
      offset: args.offset ?? 0,
    });
    const prefix = sync?.error ? `（提示：自动同步失败，使用本地缓存：${sync.error}）\n\n` : '';
    return `${prefix}${renderSearch(result)}`;
  },

  async product_get(args = {}) {
    const { index, sync } = await currentIndex(args);
    const selector = args.id ?? args.name;
    const resolved = resolveProduct(index.products, selector);
    if (!resolved.product) {
      const candidates = resolved.candidates?.length
        ? `\n候选：${resolved.candidates.map((item) => `${item.id} ${item.name}`).join('；')}`
        : '';
      throw new Error(`${resolved.error}${candidates}`);
    }
    const prefix = sync?.error ? `（提示：自动同步失败，使用本地缓存：${sync.error}）\n\n` : '';
    return `${prefix}${renderProduct(resolved.product)}`;
  },

  async product_images(args = {}) {
    const { index } = await currentIndex(args);
    const selector = args.id ?? args.name;
    const resolved = resolveProduct(index.products, selector);
    if (!resolved.product) throw new Error(resolved.error);
    const product = resolved.product;
    const wanted = Array.isArray(args.fields) && args.fields.length > 0
      ? args.fields.filter((field) => IMAGE_FIELDS.includes(field))
      : IMAGE_FIELDS;
    const lines = [`# ${product.name}（ID ${product.id}）图片`, ''];
    for (const field of wanted) {
      const url = product.images?.[field];
      const thumb = product.thumbs?.[field];
      if (!url) {
        lines.push(`- ${IMAGE_LABELS[field]}：无`);
        continue;
      }
      lines.push(`- ${IMAGE_LABELS[field]}：${url}`);
      if (thumb && thumb !== url) lines.push(`  - 缩略图：${thumb}`);
    }
    lines.push('', '图片均为远程地址，不占本地空间；需要目视检查时用 `product_cache_image` 只缓存单张。');
    return lines.join('\n');
  },

  async product_compare(args = {}) {
    const { index } = await currentIndex(args);
    const selectors = [];
    if (Array.isArray(args.ids)) selectors.push(...args.ids);
    if (Array.isArray(args.names)) selectors.push(...args.names);
    if (Array.isArray(args.items)) selectors.push(...args.items);
    if (selectors.length < 2) throw new Error('对比至少需要 2 个商品（用 ids 或 names 传入）');
    if (selectors.length > 10) throw new Error('一次最多对比 10 个商品');

    const { products, errors } = resolveProducts(index.products, selectors);
    if (errors.length > 0) {
      const detail = errors
        .map((item) => {
          const candidates = item.candidates?.length
            ? `（候选：${item.candidates.map((c) => `${c.id} ${c.name}`).join('；')}）`
            : '';
          return `- ${item.selector}：${item.error}${candidates}`;
        })
        .join('\n');
      throw new Error(`有商品无法解析：\n${detail}`);
    }
    if (products.length < 2) throw new Error('解析后不足 2 个商品');
    return formatCompareMarkdown(products);
  },

  async product_context(args = {}) {
    const { index } = await currentIndex(args);
    const selector = args.id ?? args.name;
    const resolved = resolveProduct(index.products, selector);
    if (!resolved.product) throw new Error(resolved.error);
    return renderContext(resolved.product);
  },

  async product_similar(args = {}) {
    const { index } = await currentIndex(args);
    const selector = args.id ?? args.name;
    const resolved = resolveProduct(index.products, selector);
    if (!resolved.product) throw new Error(resolved.error);
    const result = similarProducts(index.products, resolved.product, {
      limit: args.limit ?? 5,
      sameBrandOnly: args.same_brand_only === true,
    });
    const lines = [
      `与「${result.target.name}」（ID ${result.target.id}，${result.target.brand || '无品牌'} / ${result.target.category || '无分类'}）相似的商品共 ${result.total} 个：`,
      '',
    ];
    if (result.items.length === 0) {
      lines.push('没有找到相似商品。');
      return lines.join('\n');
    }
    lines.push('| ID | 商品 | 品牌 | 分类 | 相似度 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const product of result.items) {
      lines.push(
        `| ${product.id} | ${product.name} | ${product.brand || '-'} | ${product.category || '-'} | ${product.score} |`,
      );
    }
    lines.push('', '需要对比时把上面的 ID 传给 `product_compare`。');
    return lines.join('\n');
  },

  async product_brands(args = {}) {
    const { index } = await currentIndex(args);
    const counts = new Map();
    for (const product of index.products) {
      const brand = product.brand || '(未标注)';
      counts.set(brand, (counts.get(brand) || 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = [`共 ${rows.length} 个品牌：`, '', '| 品牌 | 商品数 |', '| --- | --- |'];
    for (const [brand, count] of rows) lines.push(`| ${brand} | ${count} |`);
    return lines.join('\n');
  },

  async product_categories(args = {}) {
    const { index } = await currentIndex(args);
    const counts = new Map();
    for (const product of index.products) {
      const category = product.category || '(未标注)';
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = [`共 ${rows.length} 个分类：`, '', '| 分类 | 商品数 |', '| --- | --- |'];
    for (const [category, count] of rows) lines.push(`| ${category} | ${count} |`);
    return lines.join('\n');
  },

  async product_stats() {
    const home = getHome();
    const { index, meta, sync } = await currentIndex({});
    const sizes = await indexStats(home);
    const cacheBytes = await directorySize(getPaths(home).cache);
    const brands = new Set(index.products.map((p) => p.brand).filter(Boolean));
    const categories = new Set(index.products.map((p) => p.category).filter(Boolean));
    const localOnly = index.products.filter((p) => p.localOnly).length;
    const coverage = auditCoverage(index.products);
    const payload = {
      total: index.products.length,
      brands: brands.size,
      categories: categories.size,
      localOnly,
      images: {
        complete: coverage.complete,
        incomplete: coverage.incomplete,
        completeness: Number((coverage.completeness * 100).toFixed(1)),
        missingByField: coverage.missingByField,
      },
      lastSyncAt: meta.lastSyncAt || null,
      lastError: meta.lastError || null,
      source: index.source || meta.server || null,
      indexBytes: sizes.indexBytes,
      cacheBytes,
      cacheLimitBytes: Math.max(0, DEFAULT_CACHE_MB) * 1024 * 1024,
      home,
      autoSync: sync ? { attempted: true, error: sync.error || null } : null,
    };
    return JSON.stringify(payload, null, 2);
  },

  async product_image_audit(args = {}) {
    const { index } = await currentIndex(args);
    const selector = args.id ?? args.name;
    let products;

    if (selector !== undefined) {
      const resolved = resolveProduct(index.products, selector);
      if (!resolved.product) throw new Error(resolved.error);
      products = [resolved.product];
    } else {
      const result = searchProducts(index.products, {
        query: args.query || '',
        brand: args.brand || '',
        category: args.category || '',
        limit: Number(args.limit) || index.products.length,
        maxLimit: index.products.length,
        offset: 0,
      });
      products = result.items;
    }

    const coverage = auditCoverage(products);
    let remote = null;
    if (args.verify_remote === true) {
      remote = await auditRemote(products, {
        limit: Number(args.remote_limit) || Math.min(50, products.length),
        concurrency: Number(args.concurrency) || 6,
        timeoutMs: Number(args.timeout_ms) || 10000,
      });
    }

    return renderAuditReport(coverage, remote, {
      itemLimit: Number(args.item_limit) || 20,
      brokenLimit: Number(args.broken_limit) || 20,
    });
  },

  async product_export(args = {}) {
    const { index } = await currentIndex(args);
    const result = searchProducts(index.products, {
      query: args.query || '',
      brand: args.brand || '',
      category: args.category || '',
      limit: Math.min(MAX_EXPORT, Math.max(1, Number(args.limit) || 100)),
      maxLimit: MAX_EXPORT,
      offset: 0,
    });
    const format = String(args.format || 'markdown').toLowerCase();
    if (format === 'csv') return toCsv(result.items);
    if (format === 'json') return JSON.stringify(result.items, null, 2);
    if (format === 'markdown') return toMarkdownList(result.items);
    throw new Error(`不支持的导出格式：${format}（可选 markdown / csv / json）`);
  },

  async product_cache_image(args = {}) {
    const { index } = await currentIndex(args);
    const selector = args.id ?? args.name;
    const resolved = resolveProduct(index.products, selector);
    if (!resolved.product) throw new Error(resolved.error);
    const product = resolved.product;
    const field = String(args.field || 'package_front');
    if (!IMAGE_FIELDS.includes(field)) {
      throw new Error(`不支持的图片字段：${field}（可选 ${IMAGE_FIELDS.join(' / ')}）`);
    }
    const url = product.images?.[field];
    if (!url) throw new Error(`${product.name} 没有 ${IMAGE_LABELS[field]} 图片`);

    const home = getHome();
    const paths = await ensureCacheDir(home);
    const basePath = join(paths.cache, `${product.id}-${field}`);

    let usedUrl = url;
    let usedFallback = false;
    let cached;
    try {
      cached = await downloadToCache(url, basePath);
    } catch (primaryError) {
      const candidates = [];
      const original = await resolveOriginalImageUrl({
        product,
        field,
        server: index.source || DEFAULT_SERVER,
      });
      if (original && original !== url) candidates.push(original);
      const thumb = product.thumbs?.[field];
      if (thumb && thumb !== url) candidates.push(thumb);

      for (const candidate of candidates) {
        try {
          cached = await downloadToCache(candidate, basePath);
          usedUrl = candidate;
          usedFallback = true;
          break;
        } catch {}
      }
      if (!cached) throw primaryError;
    }

    const limitBytes = Math.max(0, Number(args.max_cache_mb || DEFAULT_CACHE_MB)) * 1024 * 1024;
    const trimmed = await enforceCacheLimit(paths.cache, limitBytes);
    return JSON.stringify(
      {
        product: compact(product),
        field,
        label: IMAGE_LABELS[field],
        url: usedUrl,
        originalUrl: usedFallback ? url : undefined,
        usedFallback,
        path: cached.path,
        bytes: cached.bytes,
        cacheBytes: trimmed.bytes,
        cacheLimitBytes: limitBytes,
        trimmedFiles: trimmed.removed,
      },
      null,
      2,
    );
  },
};

async function ensureCacheDir(home) {
  const paths = getPaths(home);
  await mkdir(paths.cache, { recursive: true });
  return paths;
}

async function downloadToCache(url, basePath) {
  assertAllowedUrl(url, '图片地址');
  const response = await fetch(url, {
    headers: { 'user-agent': 'bri-product-library/0.1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const extension = extensionFor(contentType, url);
  const path = `${basePath}${extension}`;
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path, buffer);
  return { path, bytes: buffer.length };
}

/**
 * 部分商品的主图 URL 指向已删除的上传文件（404）。
 * 回退到 source=original，通常能拿到 /products/<品牌>/<商品>/original/... 的稳定路径。
 */
async function resolveOriginalImageUrl({ product, field, server }) {
  try {
    const endpoint = `${server}/api/products?search=${encodeURIComponent(product.name)}&pageSize=20&source=original`;
    assertAllowedUrl(endpoint, '回退查询地址');
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json', 'user-agent': 'bri-product-library/0.1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const row = (payload?.data || []).find((item) => Number(item.id) === product.id);
    if (!row) return null;
    const fromImages = (row.images || []).find((item) => item.field === field)?.url;
    return fromImages || row[field] || null;
  } catch {
    return null;
  }
}

function extensionFor(contentType, url) {
  if (contentType.includes('image/webp')) return '.webp';
  if (contentType.includes('image/png')) return '.png';
  if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) return '.jpg';
  if (contentType.includes('image/gif')) return '.gif';
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (['.webp', '.png', '.jpg', '.jpeg', '.gif'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  return '.img';
}

async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (info.isFile()) total += info.size;
    } catch {}
  }
  return total;
}

async function enforceCacheLimit(dir, limitBytes) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return { bytes: 0, removed: 0 };
  }
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      total += info.size;
    } catch {}
  }
  if (total <= limitBytes) return { bytes: total, removed: 0 };

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let removed = 0;
  for (const file of files) {
    if (total <= limitBytes) break;
    try {
      await unlink(file.path);
      total -= file.size;
      removed += 1;
    } catch {}
  }
  return { bytes: total, removed };
}

export function describeProduct(product) {
  return `${product.name}（ID ${product.id}，${product.brand || '无品牌'}）`;
}
