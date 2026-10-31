import { IMAGE_FIELDS, IMAGE_LABELS } from './catalog.mjs';
import { assertAllowedUrl } from './net.mjs';

export function coverageForProduct(product) {
  const fields = IMAGE_FIELDS.map((field) => ({
    field,
    label: IMAGE_LABELS[field],
    present: Boolean(product.images?.[field]),
    url: product.images?.[field] || '',
  }));
  const present = fields.filter((item) => item.present).length;
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    present,
    total: IMAGE_FIELDS.length,
    complete: present === IMAGE_FIELDS.length,
    missing: fields.filter((item) => !item.present).map((item) => item.label),
    fields,
  };
}

export function auditCoverage(products = []) {
  const items = products.map(coverageForProduct);
  const distribution = {};
  const missingByField = Object.fromEntries(IMAGE_FIELDS.map((field) => [field, 0]));

  for (const item of items) {
    distribution[item.present] = (distribution[item.present] || 0) + 1;
    for (const field of item.fields) {
      if (!field.present) missingByField[field.field] += 1;
    }
  }

  const complete = items.filter((item) => item.complete).length;
  return {
    total: items.length,
    complete,
    incomplete: items.length - complete,
    completeness: items.length > 0 ? complete / items.length : 0,
    distribution,
    missingByField,
    items,
  };
}

async function checkUrl(url, timeoutMs) {
  assertAllowedUrl(url, '图片地址');
  const headers = {
    range: 'bytes=0-0',
    'user-agent': 'bri-product-library/0.1.3',
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'HEAD',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }

  if (response.status === 405 || response.status === 501) {
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
    } catch (error) {
      return { ok: false, status: 0, error: error.message };
    }
  }

  if (response.ok || response.status === 416) {
    return { ok: true, status: response.status };
  }
  return { ok: false, status: response.status };
}

/**
 * 远程核验图片是否真的能打开。默认只查前 limit 个商品，避免一次打爆图床。
 */
export async function auditRemote(products = [], options = {}) {
  const {
    concurrency = 6,
    timeoutMs = 10000,
    limit = 50,
  } = options;

  const selected = products.slice(0, Math.max(0, limit));
  const tasks = [];
  for (const product of selected) {
    for (const field of IMAGE_FIELDS) {
      const url = product.images?.[field];
      if (url) tasks.push({ product, field, url });
    }
  }

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      const status = await checkUrl(task.url, timeoutMs);
      results.push({ ...task, ...status });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length || 1) }, () => worker()),
  );

  const broken = results.filter((item) => !item.ok);
  const brokenByProduct = new Map();
  for (const item of broken) {
    if (!brokenByProduct.has(item.product.id)) {
      brokenByProduct.set(item.product.id, {
        id: item.product.id,
        name: item.product.name,
        broken: [],
      });
    }
    brokenByProduct.get(item.product.id).broken.push({
      field: item.field,
      label: IMAGE_LABELS[item.field],
      status: item.status,
      error: item.error || '',
      url: item.url,
    });
  }

  return {
    productsChecked: selected.length,
    imagesChecked: results.length,
    ok: results.length - broken.length,
    broken: broken.length,
    brokenProducts: [...brokenByProduct.values()],
  };
}

export function renderAuditReport(coverage, remote = null, options = {}) {
  const { itemLimit = 20, brokenLimit = 20 } = options;
  const lines = [
    `图片齐全度：${coverage.total} 个商品，五图齐全 ${coverage.complete} 个（${(coverage.completeness * 100).toFixed(1)}%），不齐全 ${coverage.incomplete} 个。`,
    '',
    '缺失统计：',
    ...IMAGE_FIELDS.map(
      (field) => `- ${IMAGE_LABELS[field]}：缺 ${coverage.missingByField[field]} 个`,
    ),
  ];

  const incomplete = coverage.items.filter((item) => !item.complete);
  if (incomplete.length > 0) {
    lines.push('', `不齐全商品（最多列 ${itemLimit} 个）：`, '');
    lines.push('| ID | 商品 | 已有 | 缺失 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of incomplete.slice(0, itemLimit)) {
      lines.push(
        `| ${item.id} | ${item.name} | ${item.present}/${item.total} | ${item.missing.join('、')} |`,
      );
    }
    if (incomplete.length > itemLimit) {
      lines.push('', `……另有 ${incomplete.length - itemLimit} 个未列出。`);
    }
  }

  if (remote) {
    lines.push(
      '',
      `远程核验：检查 ${remote.productsChecked} 个商品、${remote.imagesChecked} 张图，正常 ${remote.ok}，失效 ${remote.broken}。`,
    );
    if (remote.broken > 0) {
      lines.push('', `失效明细（最多列 ${brokenLimit} 条）：`, '');
      lines.push('| 商品 | 字段 | 状态 | URL |');
      lines.push('| --- | --- | --- | --- |');
      let count = 0;
      for (const product of remote.brokenProducts) {
        for (const item of product.broken) {
          if (count >= brokenLimit) break;
          lines.push(
            `| ${product.name}（${product.id}） | ${item.label} | ${item.status || item.error} | ${item.url} |`,
          );
          count += 1;
        }
        if (count >= brokenLimit) break;
      }
      if (remote.broken > brokenLimit) lines.push('', `……另有 ${remote.broken - brokenLimit} 条未列出。`);
    }
  }

  return lines.join('\n');
}
