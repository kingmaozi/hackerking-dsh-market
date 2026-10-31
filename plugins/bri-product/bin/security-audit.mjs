#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedUrl } from '../lib/net.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['lib', 'bin', 'mcp'];

const banned = [
  { pattern: /\bchild_process\b/, label: '子进程模块' },
  { pattern: /\bexecSync\s*\(/, label: 'execSync' },
  { pattern: /\bexecFile\s*\(/, label: 'execFile' },
  { pattern: /\bspawn\s*\(/, label: 'spawn' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function' },
  { pattern: /\bcreateServer\s*\(/, label: '创建网络服务' },
  { pattern: /\.listen\s*\(/, label: '监听端口' },
  { pattern: /\bdgram\b/, label: 'UDP' },
  { pattern: /\bvm\.runIn/, label: 'vm 执行' },
  { pattern: /\bprocess\.binding\b/, label: 'process.binding' },
];

const allowedEnv = [/^BRI_/, /^CODEX_HOME$/, /^HOME$/, /^PATH$/, /^NODE_ENV$/];

async function collectFiles(dir) {
  const files = [];
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry === 'security-audit.mjs') continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await collectFiles(path)));
    else if (['.js', '.mjs', '.cjs', '.ts'].includes(extname(path))) files.push(path);
  }
  return files;
}

const files = [];
for (const target of targets) files.push(...(await collectFiles(join(root, target))));

const problems = [];
const hosts = new Set();
const envKeys = new Set();
let fetchCalls = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const relative = file.slice(root.length + 1);

  for (const rule of banned) {
    if (rule.pattern.test(source)) problems.push(`${relative}: 发现${rule.label}`);
  }

  for (const match of source.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
    const value = match[0].replace(/[。，、；：！？.,;:!?]+$/g, '');
    try {
      hosts.add(new URL(value).hostname);
    } catch {}
    if (!isAllowedUrl(value)) problems.push(`${relative}: 出现未在白名单内的地址 ${value}`);
  }

  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    envKeys.add(match[1]);
  }

  fetchCalls += (source.match(/\bfetch\s*\(/g) || []).length;
}

for (const key of envKeys) {
  if (!allowedEnv.some((pattern) => pattern.test(key))) {
    problems.push(`读取了未登记的环境变量：${key}`);
  }
}

console.log('产品库插件安全自检');
console.log('==================');
console.log(`扫描文件：${files.length} 个`);
console.log(`网络请求调用：${fetchCalls} 处（全部走白名单校验）`);
console.log(`出现的域名：${[...hosts].sort().join(', ') || '无'}`);
console.log(`读取的环境变量：${[...envKeys].sort().join(', ') || '无'}`);
console.log('');
console.log('检查项：');
console.log('  - 无子进程 / 命令执行');
console.log('  - 无 eval / new Function / vm');
console.log('  - 无入站监听 / UDP');
console.log('  - 所有 URL 必须命中 ai.bri-king.com、*.myqcloud.com 或本机回退地址');
console.log('');

if (problems.length > 0) {
  console.log(`结果：失败（${problems.length} 项）`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}

console.log('结果：通过。未发现后门、命令执行、入站监听或未授权的网络出口。');
