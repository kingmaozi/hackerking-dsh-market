#!/usr/bin/env node
import { syncCatalog } from '../lib/sync.mjs';

function parseArgs(argv) {
  const options = { force: false, quiet: false, json: false, maxAgeMs: 6 * 60 * 60 * 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force' || arg === '-f') options.force = true;
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--server') options.server = argv[++index];
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--max-age') options.maxAgeMs = parseDuration(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function parseDuration(value) {
  if (!value) return 6 * 60 * 60 * 1000;
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
  if (!match) return 6 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] || 'h').toLowerCase();
  const factors = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * (factors[unit] || factors.h);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`用法：bri-products-sync [--force] [--quiet] [--json] [--max-age 6h] [--server URL]

默认从 https://ai.bri-king.com 同步产品库；公网失败时回退到 http://127.0.0.1:8001。
同步规则：服务器新增/更新会写入本地；服务器没有但本地有的商品保留并标记 localOnly。`);
  process.exit(0);
}

try {
  const report = await syncCatalog({
    force: options.force,
    maxAgeMs: options.maxAgeMs,
    server: options.server,
    timeoutMs: options.timeoutMs,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!options.quiet) {
    if (report.skipped) {
      console.log(`产品库仍新鲜，跳过同步（上次 ${report.lastSyncAt}，${report.total} 个商品）。`);
    } else {
      console.log(
        `同步完成：${report.total} 个商品（新增 ${report.added} / 更新 ${report.updated} / 未变 ${report.unchanged} / 本地独有 ${report.localOnly}），来源 ${report.source}，耗时 ${report.durationMs}ms。`,
      );
    }
  }
} catch (error) {
  if (!options.quiet) console.error(`同步失败：${error.message}`);
  process.exit(1);
}
