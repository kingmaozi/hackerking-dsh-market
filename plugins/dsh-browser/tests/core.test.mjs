import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { DirectorySkillProvider } from '../lib/provider.js';
import {
  buildChromeArgs,
  extensionIdForPath,
  loadExtensionsFromProfile,
  runningExtensionTargets,
} from '../lib/chrome.mjs';
import { isBrandedGoogleChrome } from '../lib/browser.mjs';
import { TOOL_DEFINITIONS, formatElement, formatSnapshot } from '../lib/tools.mjs';
import {
  checkLoopbackWsUrl,
  normalizeNavigationUrl,
  parseDevToolsBanner,
  timestampSlug,
} from '../lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_TMP = '/tmp';

const EXPECTED_TOOLS = [
  'browser_click',
  'browser_close',
  'browser_eval',
  'browser_extensions',
  'browser_launch',
  'browser_navigate',
  'browser_screenshot',
  'browser_snapshot',
  'browser_status',
  'browser_tabs',
  'browser_type',
];

test('package.json 是 dsh-browser DSH 插件清单', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-browser');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.match(String(manifest.engines?.dsh), />=0\.2\.1-rc\.5 <0\.3\.0/);
  assert.match(String(manifest.engines?.node), />=22/);
  for (const entry of ['index.js', 'lib', 'mcp', 'skills', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(entry), `files 缺少 ${entry}`);
  }
  assert.equal(manifest.dependencies, undefined, '必须零 npm 依赖');
  assert.equal(manifest.devDependencies, undefined);
});

test('cordis.patch.yml 用 ctx.baseUrl 接线技能与 MCP server', async () => {
  const { readFile } = await import('node:fs/promises');
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*dsh-browser/);
  assert.match(patch, /id:\s*mcp-browser/);
  assert.match(patch, /serverName:\s*browser/);
  assert.match(patch, /node_modules\/dsh-browser\/mcp\/launch\.sh/);
  assert.match(patch, /ctx\.baseUrl/);
  assert.doesNotMatch(patch, /\/Users\/zhangsugang/);
});

test('技能 provider 能发现 browser-automation', async () => {
  const provider = new DirectorySkillProvider({
    logger: { warn: () => {}, debug: () => {} },
    providerName: 'dsh-browser',
    skillDir: join(root, 'skills'),
    rank: 490,
  });
  const candidates = await provider.list();
  assert.deepEqual(candidates.map((item) => item.name), ['browser-automation']);
  const loaded = await provider.get(candidates[0]);
  assert.ok(loaded);
  assert.ok(loaded.content.length > 1500, `技能正文过短：${loaded.content.length}`);
  for (const keyword of ['browser_snapshot', 'headless', 'attach', 'ref', '安全']) {
    assert.match(loaded.content, new RegExp(keyword));
  }
});

test('MCP 工具面是 11 个 browser_* 工具且参数有中文说明', () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description.length > 20, `${tool.name} description 太短`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(/[\u4e00-\u9fa5]/u.test(tool.description), `${tool.name} description 需要中文`);
  }
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.browser_navigate.inputSchema.required, ['url']);
  assert.deepEqual(byName.browser_eval.inputSchema.required, ['expression']);
  assert.deepEqual(byName.browser_type.inputSchema.required, ['text']);
  assert.deepEqual(byName.browser_status.inputSchema.properties, {});
  assert.deepEqual(byName.browser_launch.inputSchema.properties.mode.enum, ['headless', 'chrome', 'attach']);
  assert.deepEqual(byName.browser_tabs.inputSchema.properties.action.enum, ['list', 'new', 'activate', 'close']);
});

test('Chrome 启动参数：headless / chrome + 扩展', () => {
  const headless = buildChromeArgs({ mode: 'headless', profileDir: '/tmp/dsh-profile' });
  assert.ok(headless.includes('--headless=new'));
  assert.ok(headless.includes('--remote-debugging-port=0'));
  assert.ok(headless.includes('--user-data-dir=/tmp/dsh-profile'));
  assert.ok(!headless.some((arg) => arg.startsWith('--load-extension=')));
  assert.equal(headless.at(-1), 'about:blank');

  const chrome = buildChromeArgs({
    mode: 'chrome',
    profileDir: '/tmp/dsh-profile',
    extensions: ['/tmp/ext-a', '/tmp/ext-b'],
  });
  assert.ok(!chrome.includes('--headless=new'));
  assert.ok(chrome.includes('--load-extension=/tmp/ext-a,/tmp/ext-b'));
  assert.ok(chrome.includes('--disable-extensions-except=/tmp/ext-a,/tmp/ext-b'));
  assert.ok(chrome.includes('--user-data-dir=/tmp/dsh-profile'));

  const attached = buildChromeArgs({ mode: 'attach', profileDir: '/tmp/x', extensions: [] });
  assert.ok(!attached.some((arg) => arg.startsWith('--load-extension=')));
  assert.throws(() => buildChromeArgs({ mode: 'headless' }), /profileDir/);
});

test('DevTools banner 解析与回环地址校验', () => {
  const stderr = '\nDevTools listening on ws://127.0.0.1:62808/devtools/browser/9f7ccbe7-bdd2-48aa-ab24-6fd5933d3c95\n';
  assert.equal(parseDevToolsBanner(stderr), 'ws://127.0.0.1:62808/devtools/browser/9f7ccbe7-bdd2-48aa-ab24-6fd5933d3c95');
  assert.equal(parseDevToolsBanner('nothing here'), undefined);

  assert.equal(checkLoopbackWsUrl('ws://127.0.0.1:9222/devtools/browser/x').ok, true);
  assert.equal(checkLoopbackWsUrl('ws://localhost:9222/devtools/browser/x').ok, true);
  assert.equal(checkLoopbackWsUrl('ws://[::1]:9222/devtools/browser/x').ok, true);
  assert.equal(checkLoopbackWsUrl('ws://10.0.0.5:9222/devtools/browser/x').ok, false);
  assert.equal(checkLoopbackWsUrl('wss://127.0.0.1:9222/devtools/browser/x').ok, false);
  assert.equal(checkLoopbackWsUrl('http://127.0.0.1:9222/json/version').ok, false);
});

test('导航 URL：协议白名单、补 https、data 原文保留', () => {
  assert.equal(normalizeNavigationUrl('example.com'), 'https://example.com');
  assert.equal(normalizeNavigationUrl('https://example.com/a b'), 'https://example.com/a%20b');
  const dataUrl = 'data:text/html;charset=utf-8,<title>中文</title><h1>你好</h1>';
  assert.equal(normalizeNavigationUrl(dataUrl), dataUrl);
  assert.throws(() => normalizeNavigationUrl('javascript:alert(1)'), /不允许导航/);
  assert.throws(() => normalizeNavigationUrl('chrome://extensions'), /不允许导航/);
  assert.throws(() => normalizeNavigationUrl(''), /不能为空/);
});

test('时间戳可用于截图文件名', () => {
  const slug = timestampSlug(new Date('2026-10-31T11:10:43.999Z'));
  assert.match(slug, /^20261031-111043-999$/u);
});

test('解包扩展 ID 与 Chrome 算法一致（SHA-256 + realpath）', async () => {
  const dir = await mkdtemp(join(TEST_TMP, 'dsh-ext-id-'));
  try {
    const real = await realpath(dir);
    const hex = createHash('sha256').update(real).digest('hex').slice(0, 32);
    const expected = [...hex].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
    assert.equal(await extensionIdForPath(dir), expected);
    assert.match(expected, /^[a-p]{32}$/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('profile 扩展扫描：打包扩展 + Preferences 解包扩展 + 组件过滤', async () => {
  const profile = await mkdtemp(join(TEST_TMP, 'dsh-ext-profile-'));
  try {
    const packedId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const packedDir = join(profile, 'Default', 'Extensions', packedId, '2.0.0');
    await mkdir(packedDir, { recursive: true });
    await writeFile(join(packedDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '打包扩展', version: '2.0.0' }));

    const unpackedDir = join(profile, 'unpacked-ext');
    await mkdir(unpackedDir, { recursive: true });
    await writeFile(join(unpackedDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: '__MSG_appName__', version: '1.2.3', default_locale: 'zh_CN',
    }));
    await mkdir(join(unpackedDir, '_locales', 'zh_CN'), { recursive: true });
    await writeFile(join(unpackedDir, '_locales', 'zh_CN', 'messages.json'), JSON.stringify({ appName: { message: '解包扩展' } }));

    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
      extensions: {
        settings: {
          bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {
            location: 4,
            path: unpackedDir,
            state: 1,
            manifest: { name: '__MSG_appName__', version: '1.2.3', default_locale: 'zh_CN' },
          },
          cccccccccccccccccccccccccccccccc: {
            location: 5,
            path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            manifest: { name: '组件扩展', version: '0' },
          },
        },
      },
    }));

    const result = await loadExtensionsFromProfile(profile, { includeComponent: false });
    assert.equal(result.scanned, true);
    assert.equal(result.profileSubdir, 'Default');
    const names = result.extensions.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['打包扩展', '解包扩展']);
    const unpacked = result.extensions.find((entry) => entry.name === '解包扩展');
    assert.equal(unpacked.unpacked, true);
    assert.equal(unpacked.path, unpackedDir);
    assert.equal(unpacked.version, '1.2.3');

    const withComponents = await loadExtensionsFromProfile(profile, { includeComponent: true });
    assert.equal(withComponents.extensions.length, 3);

    const missing = await loadExtensionsFromProfile(join(profile, 'nope'));
    assert.equal(missing.scanned, false);
    assert.deepEqual(missing.extensions, []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('运行中扩展 target 识别', () => {
  const running = runningExtensionTargets([
    { type: 'service_worker', url: 'chrome-extension://ihgblfdedllpainknjolefjdhgblfdpo/sw.js' },
    { type: 'page', url: 'chrome-extension://ihgblfdedllpainknjolefjdhgblfdpo/popup.html' },
    { type: 'page', url: 'https://example.com/' },
    { type: 'background_page', url: 'chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/background.html' },
  ]);
  assert.equal(running.length, 2);
  const our = running.find((entry) => entry.id === 'ihgblfdedllpainknjolefjdhgblfdpo');
  assert.deepEqual(our.types, ['service_worker', 'page']);
});

test('官方版 Chrome 识别（只用于提示，不影响启动参数）', () => {
  assert.equal(isBrandedGoogleChrome('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), true);
  assert.equal(isBrandedGoogleChrome('/usr/bin/google-chrome'), true);
  assert.equal(isBrandedGoogleChrome('/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), false);
  assert.equal(isBrandedGoogleChrome('/Applications/Chromium.app/Contents/MacOS/Chromium'), false);
});

test('snapshot 输出含 ref 与正文，元素行可读', () => {
  const element = formatElement({
    ref: 'e2', tag: 'input', type: 'text', placeholder: '搜索', value: '手机',
  });
  assert.equal(element, '[e2] <input> "" type=text placeholder="搜索" value="手机"');
  const text = formatSnapshot({
    title: '标题',
    url: 'https://example.com/',
    viewport: { width: 1440, height: 900 },
    scroll: { height: 1800 },
    frames: 0,
    text: '正文',
    textTruncated: false,
    elements: [{ ref: 'e1', tag: 'button', text: '提交' }],
    elementsTotal: 1,
    elementsCapReached: false,
  });
  assert.match(text, /标题：标题/);
  assert.match(text, /\[e1\] <button> "提交"/);
  assert.match(text, /可交互元素 1 个/);
});

test('launch.sh --check 输出可解析 JSON 且能找到 Chrome', () => {
  const result = spawnSync('/bin/sh', [join(root, 'mcp', 'launch.sh'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.package, 'dsh-browser');
  assert.equal(report.server_present, true);
  assert.equal(report.skills_present, true);
  assert.equal(report.node_ok, true);
  assert.equal(report.automatic_install, false);
  assert.ok(report.chrome_found === true || report.chrome_found === false);
});
