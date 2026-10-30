#!/usr/bin/env node
// 用 DSH 官方的格式校验器检查 index.json，避免把不合规的索引推到 main。
// 依赖由 CI 预装：npm i --no-save --no-package-lock @deepseek-ai/dsh-plugin-market-index

import { readFileSync } from 'node:fs';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const INDEX_URL = 'https://raw.githubusercontent.com/kingmaozi/hackerking-dsh-market/main/index.json';
const index = parseMarketIndex(JSON.parse(readFileSync('index.json', 'utf8')), INDEX_URL);
console.log(`index ok: format ${index.format}, ${index.plugins.length} plugins`);
