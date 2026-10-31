#!/usr/bin/env node
import { searchProducts, toCsv, toMarkdownList } from '../lib/catalog.mjs';
import { ensureIndex } from '../lib/sync.mjs';

function parseArgs(argv) {
  const options = { query: '', limit: 20, offset: 0, format: 'markdown', offline: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--brand') options.brand = argv[++index];
    else if (arg === '--category') options.category = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--offset') options.offset = Number(argv[++index]);
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--csv') options.format = 'csv';
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  options.query = positional.join(' ').trim();
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`用法：bri-products [关键词] [--brand 品牌] [--category 分类] [--limit 20] [--json|--csv] [--offline]

示例：
  bri-products 纳宝帝 --limit 10
  bri-products 奶酪 --brand 纳宝帝 --json
  bri-products --category 膨化食品 --csv`);
  process.exit(0);
}

const { index, sync } = await ensureIndex({ allowSync: !options.offline });
if (sync?.error) console.error(`提示：自动同步失败，使用本地缓存（${sync.error}）`);

const result = searchProducts(index.products, options);

if (options.format === 'json') {
  console.log(JSON.stringify({ total: result.total, items: result.items }, null, 2));
} else if (options.format === 'csv') {
  console.log(toCsv(result.items));
} else {
  console.log(`共 ${result.total} 个商品${result.items.length < result.total ? `，显示 ${result.offset + 1}-${result.offset + result.items.length}` : ''}。\n`);
  console.log(toMarkdownList(result.items));
}
