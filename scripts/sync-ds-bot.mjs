#!/usr/bin/env node
// 把 ds-bot（DS Bot）的最新 npm 发布版同步进市场索引 index.json。
//
// 依据：npm 的 dist-tags.latest 是上游认可的当前版本；该版本 tarball 内的 README
// 写着 “Tested with dsh `<version>`”，据此设定 engines.dsh 下限。读不到这行就
// 直接失败退出（退出码 2），不猜兼容范围——市场宁可暂时不列新版本，也不能把一个
// 没验证过的 DSH 版本范围推给用户。
//
// 用法：node scripts/sync-ds-bot.mjs [--check]
//   --check 只报告是否有新版本，不写文件。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = 'ds-bot';
const INDEX = 'index.json';
const README = 'README.md';
const KEEP_VERSIONS = 3;
const checkOnly = process.argv.includes('--check');

/** 读 npm 包的完整元数据。 */
async function registryDoc() {
  // 取完整文档（带 time）：abbreviated 文档没有发布时间，会让 publishTimestamp 退化成“现在”。
  const res = await fetch(`https://registry.npmjs.org/${PKG}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  return res.json();
}

/** 下载 tarball 并读出包内 README.md 的文本。 */
async function readmeOf(tarballUrl) {
  const res = await fetch(tarballUrl);
  if (!res.ok) throw new Error(`tarball responded ${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-'));
  try {
    const file = join(dir, 'pkg.tgz');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', file, '-C', dir], { stdio: 'inherit' });
    return readFileSync(join(dir, 'package', 'README.md'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 README 的 “Tested with dsh `X`” 取测试过的 DSH 版本。 */
function testedDsh(readme) {
  const match = /Tested with dsh\s+`([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)`/i.exec(readme);
  return match?.[1];
}

/** 按 SemVer 优先序比较两个版本号（本仓库只用得到数字段与 prerelease 段）。 */
function compareVersions(left, right) {
  const parse = (text) => {
    const [core, pre = ''] = text.split('-');
    return { parts: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const one = a.pre[i];
    const two = b.pre[i];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numeric = /^\d+$/u.test(one) && /^\d+$/u.test(two);
    const diff = numeric ? Number(one) - Number(two) : one.localeCompare(two, 'en');
    if (diff !== 0) return diff;
  }
  return 0;
}

function main() {
  return (async () => {
    const doc = await registryDoc();
    const latest = doc['dist-tags']?.latest;
    if (typeof latest !== 'string') throw new Error('registry has no dist-tags.latest');

    const index = JSON.parse(readFileSync(INDEX, 'utf8'));
    const plugin = index.plugins.find((entry) => entry.name === PKG);
    if (plugin === undefined) throw new Error(`${PKG} is missing from ${INDEX}`);

    if (plugin.versions.some((entry) => entry.version === latest)) {
      console.log(`up to date: ${PKG}@${latest}`);
      return 0;
    }

    const meta = doc.versions?.[latest];
    if (meta === undefined) throw new Error(`registry has no manifest for ${latest}`);
    const readme = await readmeOf(meta.dist.tarball);
    const dsh = testedDsh(readme);
    if (dsh === undefined) {
      console.error(`cannot read "Tested with dsh \`X\`" from the README of ${PKG}@${latest}; refusing to guess engines.dsh`);
      return 2;
    }

    const published = Date.parse(doc.time?.[latest] ?? '');
    const publishTimestamp = Number.isFinite(published) ? Math.floor(published / 1000) : Math.floor(Date.now() / 1000);
    const entry = { version: latest, publishTimestamp, source: { type: 'npm' }, engines: { dsh: `>=${dsh} <0.3.0-0` } };

    console.log(`${checkOnly ? 'would add' : 'adding'} ${PKG}@${latest} (engines.dsh ${entry.engines.dsh})`);
    if (checkOnly) return 0;

    plugin.versions = [entry, ...plugin.versions]
      .filter((one, at, all) => all.findIndex((other) => other.version === one.version) === at)
      .sort((left, right) => compareVersions(right.version, left.version))
      .slice(0, KEEP_VERSIONS);
    writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);

    const shown = plugin.versions.map((one) => one.version).join(' / ');
    const readmeText = readFileSync(README, 'utf8');
    const row = /(\| `ds-bot` \| )([^|]+)( \|)/u;
    if (!row.test(readmeText)) throw new Error(`cannot find the ds-bot row in ${README}`);
    writeFileSync(README, readmeText.replace(row, `$1${shown}$3`));
    console.log(`index.json and README.md now list ${shown}`);
    return 0;
  })();
}

main().then((code) => process.exit(code ?? 0), (error) => {
  console.error(`sync-ds-bot: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
