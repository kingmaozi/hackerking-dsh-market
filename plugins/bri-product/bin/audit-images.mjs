#!/usr/bin/env node
import { searchProducts } from '../lib/catalog.mjs';
import { auditCoverage, auditRemote, renderAuditReport } from '../lib/audit.mjs';
import { ensureIndex } from '../lib/sync.mjs';

function parseArgs(argv) {
  const options = { remote: false, json: false, limit: 0, remoteLimit: 50, concurrency: 6, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--brand') options.brand = argv[++index];
    else if (arg === '--category') options.category = argv[++index];
    else if (arg === '--query') options.query = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--remote') options.remote = true;
    else if (arg === '--remote-limit') options.remoteLimit = Number(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`用法：bri-products-audit [--brand 品牌] [--category 分类] [--query 关键词] [--limit N] [--remote] [--remote-limit 50] [--json] [--offline]

检查商品五类图片是否齐全。--remote 会额外核验图片 URL 是否真的能打开。`);
  process.exit(0);
}

const { index, sync } = await ensureIndex({ allowSync: !options.offline });
if (sync?.error) console.error(`提示：自动同步失败，使用本地缓存（${sync.error}）`);

const result = searchProducts(index.products, {
  query: options.query || '',
  brand: options.brand || '',
  category: options.category || '',
  limit: options.limit || index.products.length,
  maxLimit: index.products.length,
  offset: 0,
});

const coverage = auditCoverage(result.items);
let remote = null;
if (options.remote) {
  remote = await auditRemote(result.items, {
    limit: options.remoteLimit,
    concurrency: options.concurrency,
  });
}

if (options.json) {
  console.log(JSON.stringify({ coverage, remote }, null, 2));
} else {
  console.log(renderAuditReport(coverage, remote));
}
