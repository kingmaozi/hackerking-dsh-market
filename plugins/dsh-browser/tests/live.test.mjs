import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserManager } from '../lib/browser.mjs';
import { findChromePath } from '../lib/chrome.mjs';
import { parseDevToolsBanner } from '../lib/util.mjs';

let chromePath = null;
try {
  chromePath = (await findChromePath()).path;
} catch {
  chromePath = null;
}

const skipReason = process.env.BROWSER_SKIP_LIVE === '1'
  ? 'BROWSER_SKIP_LIVE=1'
  : chromePath === null
    ? '本机找不到 Chrome，跳过真实浏览器测试'
    : false;

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

test('真实 headless Chrome：快照/点击/输入/截图/eval/标签页/关闭', { skip: skipReason, timeout: 180000 }, async () => {
  const home = await mkdtemp('/tmp/dsh-live-home-');
  const manager = new BrowserManager({ home, shotsDir: join(home, 'shots') });
  const pageDir = await mkdtemp('/tmp/dsh-live-page-');
  let launchedProfile = null;
  try {
    const launch = await manager.launch({ mode: 'headless' });
    launchedProfile = launch.profileDir;
    assert.equal(launch.mode, 'headless');
    assert.equal(launch.owned, true);
    assert.equal(launch.profileKind, '临时');
    assert.ok(launch.chromeVersion.startsWith('Chrome/'), launch.chromeVersion);
    assert.ok(launch.devtoolsPort > 0);

    // 1) data: 页面（带中文，显式 charset）
    const dataPage = dataUrl(`<!doctype html><html><head><title>Headless 测试页</title></head><body>
      <h1>你好</h1><p id="status">idle</p>
      <button id="mark" onclick="document.getElementById('status').textContent='clicked'">点我</button>
      <form onsubmit="event.preventDefault();document.getElementById('status').textContent='已提交:'+document.getElementById('name').value">
        <input id="name" name="name" placeholder="姓名"><button type="submit">提交</button>
      </form></body></html>`);
    const nav = await manager.navigate(dataPage);
    assert.equal(nav.loaded, true);
    assert.equal(nav.title, 'Headless 测试页');

    const snapshot = await manager.snapshot({});
    assert.match(snapshot.text, /idle/);
    assert.equal(snapshot.elementsTotal, 3);
    const markButton = snapshot.elements.find((element) => element.text.includes('点我'));
    const nameInput = snapshot.elements.find((element) => element.placeholder === '姓名');
    assert.ok(markButton !== undefined, '快照应包含「点我」按钮');
    assert.ok(nameInput !== undefined, '快照应包含姓名输入框');
    assert.match(markButton.ref, /^e\d+$/u);

    // 2) 真实鼠标点击 → 页面 JS 改文案
    const click = await manager.click({ ref: markButton.ref });
    assert.equal(click.clicked.ref, markButton.ref);
    assert.equal(await (async () => (await manager.evaluate('document.getElementById("status").textContent')).value)(), 'clicked');

    // 3) 输入 + Enter 提交
    const typed = await manager.type({ ref: nameInput.ref, text: '张三', submit: true });
    assert.equal(typed.value, '张三');
    assert.equal(typed.submitted, true);
    assert.equal((await manager.evaluate('document.getElementById("status").textContent')).value, '已提交:张三');

    // 4) eval 正常 + 异常
    const evalValue = await manager.evaluate('({ title: document.title, buttons: document.querySelectorAll("button").length })');
    assert.equal(evalValue.ok, true);
    assert.equal(evalValue.value.title, 'Headless 测试页');
    assert.equal(evalValue.value.buttons, 2);
    const evalError = await manager.evaluate('(() => { throw new Error("boom"); })()');
    assert.equal(evalError.ok, false);
    assert.match(evalError.error, /boom/);

    // 5) 截图：PNG 落盘 + 尺寸
    const shot = await manager.screenshot({});
    assert.equal(shot.format, 'png');
    assert.equal(shot.width, 1440);
    assert.equal(shot.height, 900);
    assert.ok(shot.bytes > 1000);
    const png = await readFile(shot.path);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // 6) file:// 页面 + 整页截图
    const htmlPath = join(pageDir, 'local.html');
    await writeFile(htmlPath, `<!doctype html><html><head><title>本地文件</title></head><body>
      <h1>本地 HTML</h1><button id="b" onclick="this.textContent='已点'">文件按钮</button>
      <div style="height:1600px">长页面</div></body></html>`, 'utf8');
    const fileNav = await manager.navigate(`file://${htmlPath}`);
    assert.equal(fileNav.loaded, true);
    assert.equal(fileNav.title, '本地文件');
    const fileSnapshot = await manager.snapshot({ max_text_chars: 200 });
    assert.match(fileSnapshot.text, /本地 HTML/);
    const fullShot = await manager.screenshot({ full_page: true });
    assert.ok(fullShot.height > 900, `整页高度应大于视口：${fullShot.height}`);
    const button = fileSnapshot.elements.find((element) => element.text.includes('文件按钮'));
    assert.ok(button !== undefined);
    await manager.click({ ref: button.ref });
    assert.equal((await manager.evaluate('document.getElementById("b").textContent')).value, '已点');

    // 7) 标签页：list / new / activate / close
    const tabsBefore = await manager.tabs({ action: 'list' });
    assert.equal(tabsBefore.tabs.length, 1);
    assert.equal(tabsBefore.tabs[0].current, true);
    const created = await manager.tabs({ action: 'new', url: dataUrl('<title>第二页</title><h1>tab2</h1>') });
    assert.equal(created.created.loaded, true);
    const tabsAfter = await manager.tabs({ action: 'list' });
    assert.equal(tabsAfter.tabs.length, 2);
    const original = tabsAfter.tabs.find((tab) => tab.current === false);
    assert.ok(original !== undefined);
    const activated = await manager.tabs({ action: 'activate', target_id: original.targetId });
    assert.equal(activated.activated.targetId, original.targetId);
    assert.match((await manager.snapshot({})).title, /本地文件/);
    const closed = await manager.tabs({ action: 'close', target_id: created.created.targetId });
    assert.equal(closed.closed.targetId, created.created.targetId);
    assert.equal((await manager.tabs({ action: 'list' })).tabs.length, 1);

    // 8) 扩展清单（headless 临时 profile）
    const extensions = await manager.extensions({});
    assert.equal(extensions.running, true);
    assert.equal(extensions.profileKind, '临时');
    assert.equal(extensions.scanned, true);
    assert.deepEqual(extensions.requested, []);

    // 9) 关闭：临时 profile 删除，进程与 CDP 断开
    const closeResult = await manager.close();
    assert.equal(closeResult.closed, true);
    assert.equal(closeResult.owned, true);
    assert.equal(manager.isRunning(), false);
    assert.equal(existsSync(launchedProfile), false, '临时 profile 应被删除');
  } finally {
    if (manager.isRunning()) await manager.close();
    await rm(home, { recursive: true, force: true });
    await rm(pageDir, { recursive: true, force: true });
  }
});

test('真实 attach 模式：连接外部 Chrome 且 close 不关闭它', { skip: skipReason, timeout: 120000 }, async () => {
  const home = await mkdtemp('/tmp/dsh-attach-home-');
  const profile = join(home, 'external-profile');
  await mkdir(profile, { recursive: true });
  const port = 19222;
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
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
      child.stderr.on('data', () => {
        if (parseDevToolsBanner(stderr) !== undefined) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`外部 Chrome 提前退出 code=${code}：${stderr.slice(-500)}`));
      });
    });

    const manager = new BrowserManager({ home: join(home, 'attach-home') });
    try {
      const launch = await manager.launch({ mode: 'attach', port });
      assert.equal(launch.mode, 'attach');
      assert.equal(launch.owned, false);
      assert.equal(launch.devtoolsPort, port);
      assert.equal(manager.isRunning(), true);

      const nav = await manager.navigate('data:text/html,<title>Attach 页面</title><h1>attach ok</h1>');
      assert.equal(nav.loaded, true);
      assert.match((await manager.snapshot({})).text, /attach ok/);

      const status = await manager.status();
      assert.equal(status.owned, false);
      assert.equal(status.mode, 'attach');

      const closeResult = await manager.close();
      assert.equal(closeResult.closed, true);
      assert.equal(closeResult.owned, false);
      assert.equal(manager.isRunning(), false);
      // attach close 不能杀掉外部 Chrome
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
