#!/usr/bin/env node
import { formatCompareMarkdown, resolveProducts } from '../lib/catalog.mjs';
import { ensureIndex } from '../lib/sync.mjs';

const selectors = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (selectors.length < 2) {
  console.error('用法：bri-products-compare ID1 ID2 [ID3 ...] 或 "商品名1" "商品名2"');
  process.exit(1);
}

const { index } = await ensureIndex({});
const { products, errors } = resolveProducts(index.products, selectors);
if (errors.length > 0) {
  for (const item of errors) {
    console.error(`- ${item.selector}: ${item.error}`);
    if (item.candidates?.length) {
      console.error(`  候选：${item.candidates.map((c) => `${c.id} ${c.name}`).join('；')}`);
    }
  }
  process.exit(1);
}

console.log(formatCompareMarkdown(products));
