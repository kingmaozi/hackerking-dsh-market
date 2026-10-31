#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const launchScript = join(pluginRoot, 'mcp', 'launch.sh');

function parseArgs(argv) {
  const options = { dryRun: false, codexHome: process.env.CODEX_HOME || join(homedir(), '.codex') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--codex-home') options.codexHome = resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`用法：node bin/install-codex.mjs [--dry-run] [--codex-home ~/.codex]

把 bri-product-library MCP 服务写入 Codex 的 config.toml。
修改前会自动备份为 config.toml.bak-<时间戳>。`);
  process.exit(0);
}

const configPath = join(options.codexHome, 'config.toml');

const section = `[mcp_servers.bri_product_library]
command = "/bin/sh"
args = ["${launchScript}"]
startup_timeout_sec = 20
`;

let existing = '';
try {
  existing = await readFile(configPath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const header = '[mcp_servers.bri_product_library]';
const pattern = new RegExp(`\\[mcp_servers\\.bri_product_library\\][\\s\\S]*?(?=\\n\\[|$)`);
let updated;
if (pattern.test(existing)) {
  updated = existing.replace(pattern, section.trimEnd());
} else {
  const separator = existing.trim().length > 0 ? '\n\n' : '';
  updated = `${existing.trimEnd()}${separator}${section}`;
}

if (options.dryRun) {
  console.log(`将写入 ${configPath}：\n`);
  console.log(section);
  process.exit(0);
}

await mkdir(options.codexHome, { recursive: true });
if (existing) {
  const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(configPath, backup);
  console.log(`已备份原配置：${backup}`);
}
await writeFile(configPath, `${updated.trimEnd()}\n`, 'utf8');

console.log(`已写入 Codex MCP 配置：${configPath}`);
console.log('');
console.log('验证：');
console.log('  codex mcp list');
console.log('  codex');
console.log('  > 用 bri_product_library 搜索“纳宝帝”');
console.log('');
console.log('如果 Codex 正在运行，请重启后再验证。');
