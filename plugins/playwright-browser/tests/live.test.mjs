import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PlaywrightBrowserManager } from '../lib/browser.mjs';
import { chromeCandidates, chromePathOverride } from '../lib/util.mjs';

async function canUseChrome() {
  const override = chromePathOverride();
  const candidates = override === undefined ? chromeCandidates() : [override];
  for (const candidate of candidates) {
    try {
      const { access } = await import('node:fs/promises');
      await access(candidate);
      return true;
    } catch {
      // 继续
    }
  }
  return false;
}

const chromeAvailable = await canUseChrome();
const skipReason = process.env.PLAYWRIGHT_SKIP_LIVE === '1'
  ? 'PLAYWRIGHT_SKIP_LIVE=1'
  : chromeAvailable
    ? false
    : '本机找不到系统 Chrome（playwright-core 不下载浏览器），跳过真实浏览器测试';

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Playwright 测试页</title></head><body>
  <h1>Playwright 内核</h1><p id="status">idle</p>
  <button id="mark" onclick="document.getElementById('status').textContent='clicked'">点我</button>
  <form onsubmit="event.preventDefault();document.getElementById('status').textContent='已提交:'+document.getElementById('name').value">
    <input id="name" name="name" placeholder="姓名"><button type="submit">提交</button>
  </form></body></html>`;

test('真实 headless：navigate/snapshot/click/type/wait/screenshot/pdf/eval/tabs/close', { skip: skipReason, timeout: 180000 }, async () => {
  const home = await mkdtemp('/tmp/dsh-pw-live-home-');
  const pageDir = await mkdtemp('/tmp/dsh-pw-live-page-');
  const manager = new PlaywrightBrowserManager({ home, shotsDir: join(home, 'shots') });
  try {
    const launch = await manager.launch({ mode: 'headless' });
    assert.equal(launch.mode, 'headless');
    assert.equal(launch.owned, true);
    assert.ok(/^\d+\.\d+/.test(String(launch.browserVersion)), `Chrome 版本异常：${launch.browserVersion}`);
    assert.equal(launch.playwrightVersion, '1.64.1');
    assert.match(launch.profileKind, /临时/);

    const nav = await manager.navigate(dataUrl(FORM_HTML));
    assert.equal(nav.loaded, true);
    assert.equal(nav.title, 'Playwright 测试页');

    const snapshot = await manager.snapshot({});
    assert.match(snapshot.text, /idle/);
    assert.equal(snapshot.elementsTotal, 3);
    const button = snapshot.elements.find((element) => element.text.includes('点我'));
    const input = snapshot.elements.find((element) => element.placeholder === '姓名');
    assert.ok(button !== undefined && input !== undefined, JSON.stringify(snapshot.elements));
    assert.match(button.ref, /^e\d+$/u);

    await manager.wait({ selector: '#status', timeout_ms: 5000 });
    await manager.click({ ref: button.ref });
    assert.equal((await manager.evaluate('document.getElementById("status").textContent')).value, 'clicked');

    const typed = await manager.type({ ref: input.ref, text: '张三', submit: true });
    assert.equal(typed.value, '张三');
    assert.equal((await manager.evaluate('document.getElementById("status").textContent')).value, '已提交:张三');

    const evalValue = await manager.evaluate('({ title: document.title, inputs: document.querySelectorAll("input").length })');
    assert.equal(evalValue.ok, true);
    assert.equal(evalValue.value.title, 'Playwright 测试页');
    assert.equal(evalValue.value.inputs, 1);
    const evalError = await manager.evaluate('(() => { throw new Error("boom"); })()');
    assert.equal(evalError.ok, false);
    assert.match(evalError.error, /boom/);

    await manager.wait({ ms: 120 });
    await manager.wait({ selector: 'form', state: 'attached' });
    const waited = await manager.wait({ load_state: 'load', timeout_ms: 5000 });
    assert.ok(Array.isArray(waited.waited) && waited.waited.length > 0);

    const shot = await manager.screenshot({});
    assert.equal(shot.format, 'png');
    assert.equal(shot.width, 1440);
    assert.equal(shot.height, 900);
    assert.ok(shot.bytes > 1000);
    const png = await readFile(shot.path);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const pdf = await manager.pdf({});
    assert.equal(pdf.format, 'A4');
    assert.ok(pdf.bytes > 1000);
    const pdfBytes = await readFile(pdf.path);
    assert.equal(pdfBytes.subarray(0, 4).toString('latin1'), '%PDF');

    // file:// 页面 + 整页截图
    const jsonPath = join(pageDir, 'local.html');
    await writeFile(jsonPath, `<!doctype html><html><head><meta charset="utf-8"><title>本地文件页</title></head><body>
      <h1>本地 HTML</h1><button id="b" onclick="this.textContent='已点'">文件按钮</button>
      <div style="height:1600px">长页面</div></body></html>`, 'utf8');
    const fileNav = await manager.navigate(`file://${jsonPath}`);
    assert.equal(fileNav.title, '本地文件页');
    await manager.wait({ selector: '#b', timeout_ms: 5000 });
    const fileSnapshot = await manager.snapshot({ max_text_chars: 200 });
    const fileButton = fileSnapshot.elements.find((element) => element.text.includes('文件按钮'));
    assert.ok(fileButton !== undefined);
    await manager.click({ ref: fileButton.ref });
    assert.equal((await manager.evaluate('document.getElementById("b").textContent')).value, '已点');
    const fullShot = await manager.screenshot({ full_page: true });
    assert.ok(fullShot.height > 900, `整页高度应大于视口：${fullShot.height}`);

    // tabs
    const tabs1 = await manager.tabs({ action: 'list' });
    assert.equal(tabs1.tabs.length, 1);
    const created = await manager.tabs({ action: 'new', url: dataUrl('<title>第二页</title><h1>tab2</h1>') });
    assert.ok(created.created.pageId.startsWith('p'));
    const tabs2 = await manager.tabs({ action: 'list' });
    assert.equal(tabs2.tabs.length, 2);
    const firstPage = tabs2.tabs.find((tab) => tab.current === false);
    assert.ok(firstPage !== undefined);
    const activated = await manager.tabs({ action: 'activate', page_id: firstPage.pageId });
    assert.equal(activated.activated.pageId, firstPage.pageId);
    assert.match((await manager.snapshot({})).title, /本地文件页/);
    const closed = await manager.tabs({ action: 'close', page_id: created.created.pageId });
    assert.equal(closed.closed.pageId, created.created.pageId);
    assert.equal((await manager.tabs({ action: 'list' })).tabs.length, 1);

    const closeResult = await manager.close();
    assert.equal(closeResult.closed, true);
    assert.equal(manager.isRunning(), false);
  } finally {
    if (manager.isRunning()) await manager.close();
    await rm(home, { recursive: true, force: true });
    await rm(pageDir, { recursive: true, force: true });
  }
});

test('真实 headed：可见窗口 + 持久 profile，关闭后 profile 保留', { skip: skipReason, timeout: 120000 }, async () => {
  const home = await mkdtemp('/tmp/dsh-pw-headed-home-');
  const profileDir = join(home, 'profile');
  await mkdir(profileDir, { recursive: true });
  const manager = new PlaywrightBrowserManager({ home, shotsDir: join(home, 'shots') });
  try {
    const launch = await manager.launch({ mode: 'headed', profile_dir: profileDir });
    assert.equal(launch.mode, 'headed');
    assert.equal(launch.owned, true);
    assert.equal(launch.profileKind.startsWith('持久'), true);
    await manager.navigate(dataUrl('<title>headed</title><h1>可见窗口</h1>'));
    assert.equal((await manager.snapshot({})).title, 'headed');
    await assert.rejects(() => manager.pdf({}), /只支持 headless/);
    const closeResult = await manager.close();
    assert.equal(closeResult.closed, true);
    assert.match(closeResult.message, /持久 profile 保留/);
    assert.equal(existsSync(profileDir), true);
  } finally {
    if (manager.isRunning()) await manager.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('真实 attach：connectOverCDP 连接外部 Chrome，close 不关闭它', { skip: skipReason, timeout: 120000 }, async () => {
  const home = await mkdtemp('/tmp/dsh-pw-attach-home-');
  const externalProfile = join(home, 'external-profile');
  await mkdir(externalProfile, { recursive: true });
  const override = chromePathOverride();
  const chromePath = override ?? chromeCandidates()[0];
  const port = 19223;
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${externalProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`外部 Chrome 启动超时：${stderr.slice(-500)}`)), 20000);
      const poll = setInterval(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (response.ok) {
            clearInterval(poll);
            clearTimeout(timer);
            resolvePromise();
          }
        } catch {
          // 继续等
        }
      }, 150);
    });
    const manager = new PlaywrightBrowserManager({ home: join(home, 'attach-home') });
    try {
      const launch = await manager.launch({ mode: 'attach', attach_port: port });
      assert.equal(launch.mode, 'attach');
      assert.equal(launch.owned, false);
      await manager.navigate('data:text/html,<title>attach</title><h1>attach ok</h1>');
      assert.match((await manager.snapshot({})).text, /attach ok/);
      const closeResult = await manager.close();
      assert.equal(closeResult.closed, true);
      assert.equal(closeResult.owned, false);
      assert.equal(manager.isRunning(), false);
      assert.equal(child.exitCode, null, 'attach close 不应关闭外部 Chrome');
    } finally {
      if (manager.isRunning()) await manager.close();
    }
  } finally {
    child.kill('SIGKILL');
    await new Promise((done) => setTimeout(done, 300));
    await rm(home, { recursive: true, force: true });
  }
});
