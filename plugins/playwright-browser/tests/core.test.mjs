import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DirectorySkillProvider } from '../lib/provider.js';
import {
  MODES,
  normalizeMode,
  playwrightCoreInfo,
} from '../lib/browser.mjs';
import { TOOL_DEFINITIONS, formatElement, formatSnapshot } from '../lib/tools.mjs';
import {
  PNG_SIGNATURE,
  booleanFlag,
  checkLoopbackHttpUrl,
  chromePathOverride,
  isElementRef,
  normalizeNavigationUrl,
  pngDimensions,
  timestampSlug,
} from '../lib/util.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TOOLS = [
  'browser_click', 'browser_close', 'browser_eval', 'browser_launch', 'browser_navigate',
  'browser_pdf', 'browser_screenshot', 'browser_snapshot', 'browser_status', 'browser_tabs',
  'browser_type', 'browser_wait',
];

test('package.json 是 playwright-browser DSH 插件清单（playwright-core 唯一依赖）', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'playwright-browser');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.match(String(manifest.engines?.dsh), />=0\.2\.1-rc\.5 <0\.3\.0/);
  assert.match(String(manifest.engines?.node), />=22/);
  assert.deepEqual(manifest.dependencies, { 'playwright-core': '1.64.1' });
  assert.equal(manifest.peerDependencies, undefined, '不要 peerDependencies（DSH 0.2.1-rc.5 兼容性）');
  assert.equal(manifest.devDependencies, undefined);
  for (const entry of ['index.js', 'lib', 'mcp', 'skills', 'scripts/selftest.mjs', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(entry), `files 缺少 ${entry}`);
  }
});

test('cordis.patch.yml 用 ctx.baseUrl 接线技能与 MCP server', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*playwright-browser/);
  assert.match(patch, /id:\s*mcp-playwright/);
  assert.match(patch, /serverName:\s*playwright/);
  assert.match(patch, /node_modules\/playwright-browser\/mcp\/launch\.sh/);
  assert.match(patch, /ctx\.baseUrl/);
  assert.doesNotMatch(patch, /\/Users\/zhangsugang/);
});

test('技能 provider 能发现 playwright-browser', async () => {
  const provider = new DirectorySkillProvider({
    logger: { warn: () => {}, debug: () => {} },
    providerName: 'playwright-browser',
    skillDir: join(root, 'skills'),
    rank: 490,
  });
  const candidates = await provider.list();
  assert.deepEqual(candidates.map((item) => item.name), ['playwright-browser']);
  const loaded = await provider.get(candidates[0]);
  assert.ok(loaded);
  assert.ok(loaded.content.length > 1500, `技能正文过短：${loaded.content.length}`);
  for (const keyword of ['browser_pdf', 'playwright-core', 'attach', 'ref', '安全']) {
    assert.match(loaded.content, new RegExp(keyword));
  }
});

test('MCP 工具面是 12 个 browser_* 工具且参数有中文说明', () => {
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
  assert.deepEqual(byName.browser_pdf.inputSchema.properties.format.description, '纸张格式，默认 A4（如 Letter、A3）');
  assert.deepEqual(byName.browser_launch.inputSchema.properties.mode.enum, ['headless', 'headed', 'attach']);
  assert.deepEqual(byName.browser_tabs.inputSchema.properties.action.enum, ['list', 'new', 'activate', 'close']);
  assert.deepEqual(byName.browser_wait.inputSchema.properties.load_state.enum, ['load', 'domcontentloaded', 'networkidle', 'commit']);
  assert.deepEqual(byName.browser_status.inputSchema.properties, {});
});

test('运行依赖 playwright-core 已安装且无 install 脚本', () => {
  const info = playwrightCoreInfo();
  assert.equal(info.installed, true, info.error);
  assert.equal(info.version, '1.64.1');
  const manifest = JSON.parse(spawnSync('node', ['-e', "process.stdout.write(JSON.stringify(require('./node_modules/playwright-core/package.json')))"], {
    cwd: root,
    encoding: 'utf8',
  }).stdout);
  assert.deepEqual(manifest.scripts ?? {}, {});
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(manifest.peerDependencies, undefined);
});

test('模式与 Chrome 路径环境变量', () => {
  assert.deepEqual(MODES, ['headless', 'headed', 'attach']);
  assert.equal(normalizeMode('headless'), 'headless');
  assert.equal(normalizeMode('headed'), 'headed');
  assert.equal(normalizeMode('chrome'), 'headed');
  assert.equal(normalizeMode('可见'), 'headed');
  assert.equal(normalizeMode('attach'), 'attach');
  assert.throws(() => normalizeMode('playwright'), /未知模式/);

  assert.equal(chromePathOverride({ PLAYWRIGHT_CHROME_PATH: '/x/chrome' }), '/x/chrome');
  assert.equal(chromePathOverride({ BROWSER_CHROME_PATH: '/y/chrome' }), '/y/chrome');
  assert.equal(chromePathOverride({ PLAYWRIGHT_CHROME_PATH: '/x/chrome', BROWSER_CHROME_PATH: '/y/chrome' }), '/x/chrome');
  assert.equal(chromePathOverride({}), undefined);
});

test('URL 协议白名单、回环 CDP 校验、data 原文保留', () => {
  assert.equal(normalizeNavigationUrl('example.com'), 'https://example.com');
  const dataUrl = 'data:text/html;charset=utf-8,<title>中文</title>';
  assert.equal(normalizeNavigationUrl(dataUrl), dataUrl);
  assert.throws(() => normalizeNavigationUrl('javascript:alert(1)'), /不允许导航/);
  assert.throws(() => normalizeNavigationUrl('chrome://extensions'), /不允许导航/);

  assert.equal(checkLoopbackHttpUrl('http://127.0.0.1:9222').ok, true);
  assert.equal(checkLoopbackHttpUrl('http://localhost:9222').ok, true);
  assert.equal(checkLoopbackHttpUrl('http://[::1]:9222').ok, true);
  assert.equal(checkLoopbackHttpUrl('http://10.0.0.5:9222').ok, false);
  assert.equal(checkLoopbackHttpUrl('ws://127.0.0.1:9222').ok, false);
  assert.equal(checkLoopbackHttpUrl('https://127.0.0.1:9222').ok, false);
});

test('截图尺寸/时间戳/布尔参数小工具', () => {
  const png = Buffer.alloc(32);
  PNG_SIGNATURE.copy(png, 0);
  png.writeUInt32BE(1440, 16);
  png.writeUInt32BE(900, 20);
  assert.deepEqual(pngDimensions(png), { width: 1440, height: 900 });
  assert.equal(pngDimensions(Buffer.from('not png')), undefined);

  assert.match(timestampSlug(new Date('2026-10-31T11:10:43.999Z')), /^20261031-111043-999$/u);
  assert.equal(booleanFlag('1'), true);
  assert.equal(booleanFlag('0'), false);
  assert.equal(booleanFlag(undefined, true), true);
  assert.equal(isElementRef('e12'), true);
  assert.equal(isElementRef('e12x'), false);
  assert.equal(isElementRef('div'), false);
});

test('snapshot / click 文本输出含 ref 与正文', () => {
  const element = formatElement({ ref: 'e2', tag: 'input', inputType: 'text', placeholder: '搜索', value: '手机' });
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

test('launch.sh --check 输出含 playwright-core 与 Chrome 诊断', () => {
  const result = spawnSync('/bin/sh', [join(root, 'mcp', 'launch.sh'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.package, 'playwright-browser');
  assert.equal(report.server_present, true);
  assert.equal(report.skills_present, true);
  assert.equal(report.node_ok, true);
  assert.equal(report.playwright_installed, true);
  assert.equal(report.playwright_version, '1.64.1');
  assert.equal(report.automatic_install, false);
  assert.ok(report.chrome_found === true || report.chrome_found === false);
});
