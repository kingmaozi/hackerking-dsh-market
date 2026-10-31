import { createHash } from 'node:crypto';

export const IMAGE_FIELDS = [
  'package_front',
  'package_side',
  'package_middle',
  'ingredient_list',
  'product_inner',
];

export const IMAGE_LABELS = {
  package_front: '包装正面',
  package_side: '包装侧面',
  package_middle: '中包装',
  ingredient_list: '配料表',
  product_inner: '内物图',
};

export const THUMB_KEY = {
  package_front: 'thumb_front',
  package_side: 'thumb_side',
  package_middle: 'thumb_middle',
  ingredient_list: 'thumb_ingredient',
  product_inner: 'thumb_inner',
};

/** 去掉图床 URL 上的缓存版本号，避免服务器重启导致整库“假更新”。 */
export function stripCacheBust(url) {
  const value = String(url || '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('v');
    return parsed.toString();
  } catch {
    return value
      .replace(/([?&])v=[^&]*/g, '$1')
      .replace(/[?&]$/, '');
  }
}

export function normalizeProduct(raw) {
  const id = Number(raw?.id);
  if (!Number.isFinite(id)) return null;

  const images = {};
  const thumbs = {};
  const rawImages = Array.isArray(raw?.images) ? raw.images : [];

  for (const field of IMAGE_FIELDS) {
    const item = rawImages.find((entry) => entry?.field === field);
    const url = item?.url || raw?.[field] || '';
    const thumb = item?.thumb || raw?.[THUMB_KEY[field]] || url;
    if (url) images[field] = String(url);
    if (thumb) thumbs[field] = String(thumb);
  }

  return {
    id,
    name: cleanText(raw?.name),
    brand: cleanText(raw?.brand),
    category: cleanText(raw?.category),
    processed: Boolean(raw?.is_processed),
    images,
    thumbs,
    localOnly: false,
  };
}

/** 去掉控制字符并限长，避免服务器数据里的终端转义序列污染输出。 */
function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function contentHash(product) {
  const canonical = {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    processed: Boolean(product.processed),
    images: Object.fromEntries(
      IMAGE_FIELDS.map((field) => [field, stripCacheBust(product.images?.[field])]),
    ),
    thumbs: Object.fromEntries(
      IMAGE_FIELDS.map((field) => [field, stripCacheBust(product.thumbs?.[field])]),
    ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function summary(product) {
  return { id: product.id, name: product.name, brand: product.brand };
}

/**
 * 合并服务器目录与本地目录：
 * - 服务器新增 -> 加入
 * - 服务器内容变化 -> 更新
 * - 服务器没有、本地有 -> 保留并标记 localOnly（绝不删除）
 */
export function diffCatalog(existing = [], incoming = [], now = new Date().toISOString()) {
  const existingById = new Map(existing.map((product) => [product.id, product]));
  const incomingIds = new Set();
  const products = [];
  const changes = { added: [], updated: [], unchanged: [], localOnly: [] };

  for (const item of incoming) {
    incomingIds.add(item.id);
    const hash = contentHash(item);
    const previous = existingById.get(item.id);

    if (!previous) {
      products.push({
        ...item,
        contentHash: hash,
        firstSeenAt: now,
        lastSeenAt: now,
        localOnly: false,
      });
      changes.added.push(summary(item));
      continue;
    }

    const merged = {
      ...previous,
      ...item,
      contentHash: hash,
      firstSeenAt: previous.firstSeenAt || now,
      lastSeenAt: now,
      localOnly: false,
    };
    products.push(merged);
    if (previous.contentHash !== hash) changes.updated.push(summary(item));
    else changes.unchanged.push(summary(item));
  }

  for (const previous of existing) {
    if (incomingIds.has(previous.id)) continue;
    products.push({ ...previous, localOnly: true });
    changes.localOnly.push(summary(previous));
  }

  products.sort((a, b) => a.id - b.id);
  return { products, changes };
}

export function searchProducts(products = [], options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const brand = String(options.brand || '').trim().toLowerCase();
  const category = String(options.category || '').trim().toLowerCase();
  const maxLimit = Math.min(10000, Math.max(1, Number(options.maxLimit) || 100));
  const limit = Math.min(maxLimit, Math.max(1, Number(options.limit) || 10));
  const offset = Math.max(0, Number(options.offset) || 0);
  const tokens = query.split(/\s+/).filter(Boolean);

  const scored = [];

  for (const product of products) {
    const name = String(product.name || '').toLowerCase();
    const productBrand = String(product.brand || '').toLowerCase();
    const productCategory = String(product.category || '').toLowerCase();

    if (brand && !productBrand.includes(brand)) continue;
    if (category && !productCategory.includes(category)) continue;

    let score = 0;
    if (!query) {
      score = 1;
    } else {
      if (name === query) score += 1000;
      else if (name.startsWith(query)) score += 800;
      else if (name.includes(query)) score += 600;

      if (productBrand === query) score += 500;
      else if (productBrand.includes(query)) score += 400;

      if (productCategory.includes(query)) score += 300;

      if (score === 0 && tokens.length > 0) {
        const haystack = `${name} ${productBrand} ${productCategory} ${product.id}`;
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        if (hits === tokens.length) score = 100 + hits * 10;
        else if (hits > 0) score = hits * 10;
      }

      if (score === 0) continue;
    }

    scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score || a.product.id - b.product.id);

  return {
    total: scored.length,
    query,
    brand,
    category,
    offset,
    limit,
    items: scored.slice(offset, offset + limit).map((entry) => entry.product),
  };
}

export function resolveProduct(products = [], selector) {
  const raw = String(selector ?? '').trim();
  if (!raw) return { error: '商品选择器为空' };

  if (/^\d+$/.test(raw)) {
    const product = products.find((item) => item.id === Number(raw));
    return product ? { product } : { error: `未找到 ID 为 ${raw} 的商品` };
  }

  const lower = raw.toLowerCase();
  const exact = products.filter((item) => String(item.name).toLowerCase() === lower);
  if (exact.length === 1) return { product: exact[0] };
  if (exact.length > 1) {
    return {
      error: `名称“${raw}”匹配到 ${exact.length} 个商品，请改用 ID`,
      candidates: exact.map(summary),
    };
  }

  const partial = products.filter((item) => String(item.name).toLowerCase().includes(lower));
  if (partial.length === 1) return { product: partial[0] };
  if (partial.length > 1) {
    return {
      error: `名称“${raw}”匹配到 ${partial.length} 个商品，请改用更精确的名称或 ID`,
      candidates: partial.slice(0, 10).map(summary),
    };
  }

  return { error: `未找到商品“${raw}”` };
}

export function resolveProducts(products = [], selectors = []) {
  const resolved = [];
  const errors = [];
  for (const selector of selectors) {
    const result = resolveProduct(products, selector);
    if (result.product) resolved.push(result.product);
    else errors.push({ selector, ...result });
  }
  return { products: resolved, errors };
}

function tokenSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function bigramSet(text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const grams = new Set();
  for (let index = 0; index < cleaned.length - 1; index += 1) {
    grams.add(cleaned.slice(index, index + 2));
  }
  return grams;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** 本地相似商品推荐：同品牌、同分类、名称词元/字符二元组重合度。 */
export function similarProducts(products = [], target, options = {}) {
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 5));
  const sameBrandOnly = options.sameBrandOnly === true;
  const targetTokens = tokenSet(target.name);
  const targetGrams = bigramSet(target.name);
  const scored = [];

  for (const product of products) {
    if (product.id === target.id) continue;
    if (sameBrandOnly && product.brand !== target.brand) continue;

    let score = 0;
    if (target.brand && product.brand === target.brand) score += 5;
    if (target.category && product.category === target.category) score += 2;

    let overlap = 0;
    const tokens = tokenSet(product.name);
    for (const token of targetTokens) if (tokens.has(token)) overlap += 1;
    score += overlap * 2;
    score += jaccard(targetGrams, bigramSet(product.name)) * 4;

    if (score < 3) continue;
    scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score || a.product.id - b.product.id);
  return {
    target,
    total: scored.length,
    items: scored.slice(0, limit).map((entry) => ({ ...entry.product, score: Number(entry.score.toFixed(3)) })),
  };
}

export function formatCompareMarkdown(items = []) {
  if (items.length < 2) throw new Error('对比至少需要 2 个商品');

  const header = ['字段', ...items.map((item, index) => `${index + 1}. ${item.name}（ID ${item.id}）`)];
  const separator = header.map(() => '---');
  const rows = [
    ['品牌', ...items.map((item) => item.brand || '-')],
    ['分类', ...items.map((item) => item.category || '-')],
    ['已渲染', ...items.map((item) => (item.processed ? '是' : '否'))],
    ...IMAGE_FIELDS.map((field) => [
      IMAGE_LABELS[field],
      ...items.map((item) => (item.images?.[field] ? `[图片](${item.images[field]})` : '-')),
    ]),
  ];

  const table = [header, separator, ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');

  const galleries = items
    .map((item, index) => {
      const links = IMAGE_FIELDS.filter((field) => item.images?.[field])
        .map((field) => `- ${IMAGE_LABELS[field]}：${item.images[field]}`)
        .join('\n');
      return `### ${index + 1}. ${item.name}（ID ${item.id}）\n\n${links || '- 无图片'}`;
    })
    .join('\n\n');

  return `${table}\n\n${galleries}`;
}

export function toCsv(products = []) {
  const columns = ['id', 'name', 'brand', 'category', ...IMAGE_FIELDS];
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const product of products) {
    lines.push(
      [
        product.id,
        product.name,
        product.brand,
        product.category,
        ...IMAGE_FIELDS.map((field) => product.images?.[field] || ''),
      ]
        .map(escape)
        .join(','),
    );
  }
  return lines.join('\n');
}

export function toMarkdownList(products = []) {
  const header = '| ID | 商品 | 品牌 | 分类 | 包装正面 |\n| --- | --- | --- | --- | --- |';
  const rows = products.map((product) => {
    const image = product.images?.package_front
      ? `[图](${product.images.package_front})`
      : '-';
    return `| ${product.id} | ${product.name} | ${product.brand || '-'} | ${product.category || '-'} | ${image} |`;
  });
  return [header, ...rows].join('\n');
}
