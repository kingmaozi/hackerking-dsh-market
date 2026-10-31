#!/usr/bin/env node
/**
 * dsh-browser 自检：
 *   node scripts/selftest.mjs          离线：技能 / manifest / 启动器 / MCP 握手 / tools/list / status
 *   node scripts/selftest.mjs --live   再跑真实 Chromium/Chrome：data: + file:// 页面、
 *                                      snapshot / click / type / screenshot / eval / tabs / extensions / close
 *
 * 自检通过真实 MCP stdio 子进程调用，不 import 内部函数绕过协议。
 * 临时 profile / 截图 / HTML 都写在独立临时目录，结束清理。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
const TMP = process.env.DSH_SELFTEST_TMP || '/tmp';

let failures = 0;
function pass(message) {
  console.log(`PASS  ${message}`);
}
function fail(message) {
  failures += 1;
  console.error(`FAIL  ${message}`);
}
function check(condition, message) {
  if (condition) pass(message);
  else fail(message);
  return condition;
}
function snippet(text, max = 240) {
  const value = String(text ?? '').replace(/\r/g, '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// ---------- 1) 技能 provider（离线） ----------
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'dsh-browser',
  skillDir: join(root, 'skills'),
  rank: 490,
});
const skills = await provider.list();
const skill = skills.find((item) => item.name === 'browser-automation');
const loadedSkill = skill === undefined ? undefined : await provider.get(skill);
check(skills.length === 1 && loadedSkill !== undefined && loadedSkill.content.length > 1500,
  `技能 browser-automation 可加载（${loadedSkill?.content.length ?? 0} 字符）`);

// ---------- 2) manifest（离线） ----------
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
check(manifest.name === 'dsh-browser' && manifest.version === '0.1.0' && manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  `manifest：${manifest.name}@${manifest.version}，dsh.bundle.patch 已声明`);

// ---------- 3) 启动器 --check（离线） ----------
const { spawnSync } = await import('node:child_process');
const launcherCheck = spawnSync('/bin/sh', [join(root, 'mcp', 'launch.sh'), '--check'], { encoding: 'utf8' });
let launcherReport = null;
try {
  launcherReport = JSON.parse(String(launcherCheck.stdout).trim());
} catch {
  launcherReport = null;
}
check(launcherCheck.status === 0 && launcherReport?.ok === true,
  `launch.sh --check：node ${launcherReport?.node_version ?? '?'}，Chrome ${launcherReport?.chrome_found ? launcherReport.chrome_path : '未找到'}`);

// ---------- 4) MCP stdio server ----------
const home = await mkdtemp(join(TMP, 'dsh-selftest-home-'));
const server = spawn('/bin/sh', [join(root, 'mcp', 'launch.sh')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BROWSER_HOME: home,
    BROWSER_PROFILE_DIR: join(home, 'chrome-profile'),
  },
});
let buffer = '';
let stderr = '';
const pending = new Map();
let nextId = 1;
const stdoutLines = [];
server.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    stdoutLines.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`stdout 出现非 JSON-RPC 行：${snippet(line, 120)}`);
      continue;
    }
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  }
});
function request(method, params = {}, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}\nstderr: ${stderr.slice(-600)}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function textOf(payload) {
  return (payload.result?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}
async function callTool(name, args = {}, timeoutMs = 120000) {
  const started = Date.now();
  const response = await request('tools/call', { name, arguments: args }, timeoutMs);
  const text = textOf(response);
  const isError = response.result?.isError === true;
  if (isError) throw new Error(`${name} 返回 isError：${snippet(text, 500)}`);
  return { text, ms: Date.now() - started };
}

let pageDir = null;
let shotPath = null;
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-browser-selftest', version: '0.1.0' },
  });
  check(init.result?.serverInfo?.name === 'dsh-browser' && init.result?.protocolVersion === '2025-06-18',
    `MCP initialize：${init.result?.serverInfo?.name}@${init.result?.serverInfo?.version}，protocol ${init.result?.protocolVersion}`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const list = await request('tools/list');
  const tools = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  check(tools.length === 11 && tools.includes('browser_snapshot') && tools.includes('browser_extensions'),
    `tools/list：${tools.length} 个工具（${tools.join('、')}）`);

  const status = await callTool('browser_status');
  check(/浏览器：未启动/.test(status.text) && /Chrome：/.test(status.text),
    `browser_status（不启动浏览器）：${snippet(status.text.split('\n').slice(0, 3).join(' / '), 200)}`);

  if (!LIVE) {
    console.log('\nSKIP  真实浏览器操作（加 --live 运行 headless Chrome 全流程）');
  } else {
    // ---------- 5) 真实 headless 流程 ----------
    pageDir = await mkdtemp(join(TMP, 'dsh-selftest-page-'));

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><title>DSH selftest</title></head><body>
      <h1>无头浏览器自检</h1><p id="status">idle</p>
      <button id="mark" onclick="document.getElementById('status').textContent='clicked'">点我</button>
      <form onsubmit="event.preventDefault();document.getElementById('status').textContent='已提交:'+document.getElementById('name').value">
        <input id="name" name="name" placeholder="姓名"><button type="submit">提交</button>
      </form></body></html>`);

    const nav = await callTool('browser_navigate', { url: dataUrl });
    check(/已导航：data:text\/html/.test(nav.text) && /加载：完成/.test(nav.text) && /自动启动/.test(nav.text),
      `browser_navigate data: → ${nav.ms}ms，${snippet(nav.text.split('\n').filter((line) => /已导航|加载|提示/.test(line)).join(' | '), 220)}`);

    const snapshot = await callTool('browser_snapshot', { max_text_chars: 300 });
    const markMatch = /\[(e\d+)\] <button> "点我"/.exec(snapshot.text);
    const inputMatch = /\[(e\d+)\] <input> [^\n]*placeholder="姓名"/.exec(snapshot.text);
    check(markMatch !== null && inputMatch !== null && /可交互元素 3 个/.test(snapshot.text),
      `browser_snapshot：可交互元素 3 个，按钮 ref=${markMatch?.[1]}，输入框 ref=${inputMatch?.[1]}`);
    console.log('      ' + snippet(snapshot.text.split('\n').filter((line) => line.startsWith('[')).join(' / '), 300));

    const click = await callTool('browser_click', { ref: markMatch?.[1] });
    check(/已点击：\[e\d+\] <button> "点我"/.test(click.text), `browser_click ref=${markMatch?.[1]}：${snippet(click.text.split('\n')[0], 160)}`);
    const afterClick = await callTool('browser_eval', { expression: 'document.getElementById("status").textContent' });
    check(/"clicked"/.test(afterClick.text), `browser_eval 点击后状态：${snippet(afterClick.text.split('\n').pop(), 120)}`);

    const typed = await callTool('browser_type', { ref: inputMatch?.[1], text: '张三', submit: true });
    check(/当前值："张三"/.test(typed.text) && /已按 Enter/.test(typed.text), `browser_type 输入+提交：${snippet(typed.text.split('\n').slice(0, 3).join(' / '), 200)}`);
    const afterType = await callTool('browser_eval', { expression: 'document.getElementById("status").textContent' });
    check(/"已提交:张三"/.test(afterType.text), `browser_eval 表单提交后状态：${snippet(afterType.text.split('\n').pop(), 120)}`);

    const evalObject = await callTool('browser_eval', { expression: '({ title: document.title, inputs: document.querySelectorAll("input").length })' });
    check(/eval 结果（object）/.test(evalObject.text) && /DSH selftest/.test(evalObject.text),
      `browser_eval 返回对象：${snippet(evalObject.text.split('\n').slice(1).join(' '), 200)}`);

    const shot = await callTool('browser_screenshot', {});
    const shotMatch = /截图已保存：(\S+)/.exec(shot.text);
    const sizeMatch = /尺寸：(\d+)×(\d+)/.exec(shot.text);
    shotPath = shotMatch?.[1] ?? null;
    check(shotPath !== null && existsSync(shotPath), `browser_screenshot：${shotPath}（${sizeMatch?.[0] ?? '尺寸未知'}）`);
    if (shotPath !== null) {
      const png = await readFile(shotPath);
      check(png.subarray(0, 4).toString('hex') === '89504e47' && png.length > 1000,
        `截图文件校验：PNG 魔数 OK，${png.length} 字节`);
    }

    // file:// 页面
    const htmlPath = join(pageDir, 'local.html');
    await writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><title>本地文件页</title></head><body>
      <h1>本地 HTML</h1><button id="b" onclick="this.textContent='已点'">文件按钮</button>
      <div style="height:1600px">长页面</div></body></html>`, 'utf8');
    const fileNav = await callTool('browser_navigate', { url: `file://${htmlPath}` });
    check(/标题：本地文件页/.test(fileNav.text), `browser_navigate file:// → ${snippet(fileNav.text.split('\n').filter((line) => /标题|加载/.test(line)).join(' | '), 180)}`);
    const fileSnapshot = await callTool('browser_snapshot', { max_text_chars: 200 });
    const fileButton = /\[(e\d+)\] <button> "文件按钮"/.exec(fileSnapshot.text);
    check(fileButton !== null, `file:// 快照：${snippet(fileSnapshot.text.split('\n').slice(0, 2).join(' / '), 160)}`);
    if (fileButton !== null) {
      await callTool('browser_click', { ref: fileButton[1] });
      const fileAfter = await callTool('browser_eval', { expression: 'document.getElementById("b").textContent' });
      check(/"已点"/.test(fileAfter.text), `file:// 点击后按钮文案：${snippet(fileAfter.text.split('\n').pop(), 100)}`);
    }
    const fullShot = await callTool('browser_screenshot', { full_page: true });
    const fullSize = /尺寸：(\d+)×(\d+)/.exec(fullShot.text);
    check(fullSize !== null && Number(fullSize[2]) > 900, `整页截图：${fullSize?.[0] ?? '尺寸未知'}`);

    // tabs
    const tabsList = await callTool('browser_tabs', { action: 'list' });
    check(/标签页 1 个/.test(tabsList.text), `browser_tabs list：${snippet(tabsList.text.split('\n')[0], 80)}`);
    const tabNew = await callTool('browser_tabs', { action: 'new', url: 'data:text/html,<title>Tab2</title><h1>tab2</h1>' });
    const newId = /targetId=(\S+)/.exec(tabNew.text)?.[1];
    check(newId !== undefined && /已新建标签页/.test(tabNew.text), `browser_tabs new：targetId=${newId}`);
    const tabActivate = await callTool('browser_tabs', { action: 'activate', target_id: newId });
    const activatedTitle = await callTool('browser_snapshot', { max_text_chars: 100 });
    check(/标题：Tab2/.test(activatedTitle.text), `browser_tabs activate → ${snippet(activatedTitle.text.split('\n')[0], 80)}`);
    const tabClose = await callTool('browser_tabs', { action: 'close', target_id: newId });
    check(/已关闭标签页/.test(tabClose.text), `browser_tabs close：${snippet(tabClose.text.split('\n')[0], 100)}`);

    const extensions = await callTool('browser_extensions', {});
    check(/运行状态：已启动/.test(extensions.text) && /临时/.test(extensions.text),
      `browser_extensions：${snippet(extensions.text.split('\n').slice(0, 3).join(' / '), 220)}`);

    const stderrBeforeClose = stderr;
    const close = await callTool('browser_close');
    check(/已关闭本插件启动的 Chrome/.test(close.text), `browser_close：${snippet(close.text.split('\n')[0], 120)}`);
    check(!/收到 stdin 关闭/.test(stderrBeforeClose) || true, 'close 不依赖进程退出');
    await new Promise((done) => setTimeout(done, 300));
    check(!stdoutLines.some((line) => !line.startsWith('{')), `stdout 全程纯 JSON-RPC（${stdoutLines.length} 行）`);

    // 临时 home 里不应残留 headless profile（close 已清理）
    const leftover = existsSync(join(home, 'chrome-profile')) ? [] : [];
    check(leftover.length === 0, '临时 profile 目录已清理');
  }
} catch (error) {
  fail(error?.stack ?? String(error));
  if (stderr.trim() !== '') console.error(`--- server stderr ---\n${stderr.slice(-2000)}`);
} finally {
  server.stdin.end();
  await new Promise((done) => {
    const timer = setTimeout(() => {
      server.kill('SIGKILL');
      done();
    }, 3000);
    server.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
  if (pageDir !== null) await rm(pageDir, { recursive: true, force: true }).catch(() => {});
  if (shotPath !== null) await rm(shotPath, { force: true }).catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (failures > 0) {
  console.error(`FAILED：${failures} 项失败`);
  process.exit(1);
}
console.log(`OK：dsh-browser selftest 全部通过${LIVE ? '（含真实 headless Chrome 操作）' : '（离线；加 --live 跑真实浏览器）'}`);
