#!/usr/bin/env node
/**
 * selftest.mjs — 不重启 DSH 的验证入口。
 *
 * 覆盖：
 *   1. 插件 apply() 在 mock ctx 上注册 9 个 cua_* 工具（不依赖宿主服务）；
 *   2. 每个工具过真实 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema 与参数方言编译；
 *   3. 参数校验会拒绝缺字段 / 错类型；
 *   4. 动作规划器产出预期 argv（零副作用，不点屏幕）；
 *   5. dry_run 走真实 execute 路径但不发事件；
 *   6. cua_status / cua_screenshot 真跑（本机已授权屏幕录制）；
 *   7. 辅助功能未授权时 cua_click 明确报错（若已授权则跳过，避免误点）。
 *
 * 用法：node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { unlink, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { apply, createTools, createComputerUse, TOOL_NAMES, VERSION, parameterSpecOf } = await import(
  pathToFileURL(join(pluginRoot, 'lib/index.js')).href
);
const { compileParams, validateArgs: localValidateArgs } = await import(
  pathToFileURL(join(pluginRoot, 'lib/schema.js')).href
);
const { pngSize } = await import(pathToFileURL(join(pluginRoot, 'lib/system.js')).href);
const {
  planClick, planDrag, planKey, planMove, planScroll, planType, keyScript, parseKeyCombo,
} = await import(pathToFileURL(join(pluginRoot, 'lib/actions.js')).href);

/** 优先用 profile 里真实的 dsh-tools，退到 /tmp/dshref 的解包副本。 */
async function loadDshTools() {
  const require = createRequire(join(homedir(), '.dsh/profiles/desktop/package.json'));
  const candidates = [
    process.env.DSH_TOOLS_MODULE,
    join(homedir(), '.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
    '/tmp/dshref/tools/package/lib/index.js',
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { module: await import(pathToFileURL(candidate).href), path: candidate };
  }
  try {
    const resolved = require.resolve('@deepseek-ai/dsh-tools');
    return { module: await import(pathToFileURL(resolved).href), path: resolved };
  } catch {
    return { module: undefined, path: '' };
  }
}

const dshTools = await loadDshTools();
const failures = [];
const notes = [];

async function step(label, fn) {
  try {
    const detail = await fn();
    console.log(`✔ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  } catch (error) {
    failures.push({ label, error });
    console.error(`✘ ${label} — ${error?.message ?? error}`);
  }
}

// ------------------------------------------------------------------ mocks ----

const attachments = {
  imageLimits: {
    mediaTypes: ['image/png', 'image/jpeg'],
    maxImageBytes: 16 * 1024 * 1024,
    maxMessageImageBytes: 16 * 1024 * 1024,
    maxImageDimension: 12000,
    maxImagePixels: 60_000_000,
  },
  async saveImage({ data, mediaType, name }) {
    const size = pngSize(data) ?? { width: 0, height: 0 };
    return {
      attachmentId: 'att_selftest_0001',
      mediaType,
      bytes: data.length,
      width: size.width,
      height: size.height,
      name,
    };
  },
};

function makeContext() {
  const registered = [];
  const warnings = [];
  const ctx = {
    logger: {
      info() {},
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    get(service) {
      if (service === 'attachments') return attachments;
      return undefined;
    },
    emit() {},
    tools: {
      register(tool) {
        if (registered.some((item) => item.name === tool.name)) {
          throw new Error(`duplicate tool name ${tool.name}`);
        }
        registered.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, registered, warnings };
}

const { ctx, registered } = makeContext();
await step('apply() 在 mock ctx 上注册全部 cua_* 工具', async () => {
  apply(ctx, {});
  assert.equal(registered.length, TOOL_NAMES.length, `期望 ${TOOL_NAMES.length} 个工具，实际 ${registered.length}`);
  const names = registered.map((tool) => tool.name);
  assert.deepEqual(names, TOOL_NAMES);
  for (const name of names) assert.match(name, /^cua_[a-z_]+$/);
  return `${names.length} 个：${names.join(', ')}`;
});

const byName = new Map(registered.map((tool) => [tool.name, tool]));

await step('每个工具过 DSH 注册校验（output 标准子集 + parameters 已编译）', async () => {
  if (dshTools.module === undefined) {
    notes.push('未找到 @deepseek-ai/dsh-tools，本次跳过 schema 校验（其它用例照跑）');
    return 'skipped（无 dsh-tools）';
  }
  const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema } = dshTools.module;
  for (const tool of registered) {
    assert.equal(typeof tool.output, 'object', `${tool.name}: output 缺失`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render 必须是函数`);
    assertSupportedJsonSchema(tool.output.schema);
    assert.equal(tool.parameters?.type, 'object', `${tool.name}: parameters 必须是标准 object schema（宿主原样透传给 provider）`);
    assertSupportedJsonSchema(tool.parameters);
    // 本地编译结果 == dsh-tools 对同一份作者方言的编译结果
    assert.deepEqual(
      tool.parameters,
      parameterSchemaSpecToJsonSchema(parameterSpecOf(tool.name)),
      `${tool.name}: 与 dsh-tools 编译结果不一致`,
    );
    assert.equal(typeof tool.execute, 'function', `${tool.name}: execute 缺失`);
  }
  return `9 个工具全过，且 parameters 与 dsh-tools 编译结果逐一相等（${dshTools.path.replace(homedir(), '~')}）`;
});

await step('参数校验：缺字段与错类型都会被拒（本地与宿主一致）', async () => {
  const { validateJsonSchemaValue } = dshTools.module ?? {};
  const click = byName.get('cua_click');
  if (validateJsonSchemaValue !== undefined) {
    assert.ok(validateJsonSchemaValue(click.parameters, {}, '').length > 0, '空参数应报缺字段');
    assert.ok(validateJsonSchemaValue(click.parameters, { x: 'a', y: 2 }, '').length > 0, 'x 传字符串应报类型错');
    assert.equal(validateJsonSchemaValue(click.parameters, { x: 10, y: 20 }, '').length, 0, '合法坐标不应报错');
    assert.equal(validateJsonSchemaValue(byName.get('cua_status').parameters, {}, '').length, 0, 'cua_status 无参数');
  }
  assert.ok(localValidateArgs(click.parameters, {}).length > 0, '本地校验器应报缺字段');
  assert.ok(localValidateArgs(click.parameters, { x: 'a', y: 2 }).length > 0, '本地校验器应报类型错');
  assert.equal(localValidateArgs(click.parameters, { x: 10, y: 20 }).length, 0, '本地校验器应放行');
  assert.deepEqual(compileParams({ a: { type: 'number', required: true } }), { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] });
  await assert.rejects(click.execute({}, {}), /invalid arguments/, 'execute 必须自己拒绝非法参数');
  return '6 组断言通过（含 execute 入口拦截）';
});

await step('render() 对样例值都产出内容块', async () => {
  const samples = {
    cua_status: {
      ok: true,
      platform: 'darwin',
      version: VERSION,
      backends: { screenshot: '/usr/sbin/screencapture', pointer: '/opt/homebrew/bin/cliclick', keyboard: '/usr/bin/osascript', clipboard: '/usr/bin/pbcopy', scroll: '/usr/bin/python3', python: '/usr/bin/python3' },
      permissions: { accessibility: 'denied', screenRecording: 'granted', probe: 'pyobjc' },
      displays: [{ id: 4, main: true, x: 0, y: 0, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160, scale: 2 }],
      guidance: ['x'],
    },
    cua_screenshot: {
      ok: true,
      path: '/tmp/x.png',
      width: 1920,
      height: 1080,
      bytes: 1000,
      scale: 2,
      coordinateSpace: 'points',
      display: 1,
      downscaled: true,
      inline: true,
      image: { attachmentId: 'a', mediaType: 'image/png', bytes: 1000, width: 1920, height: 1080, name: 'x.png' },
    },
    cua_windows: {
      ok: true,
      count: 1,
      total: 1,
      windows: [{ owner: 'Finder', title: '', pid: 1, layer: 0, x: 0, y: 0, width: 100, height: 100 }],
    },
  };
  const fallback = { ok: true, action: 'click', pointer: { x: 1, y: 2 }, verified: true };
  for (const tool of registered) {
    const value = samples[tool.name] ?? fallback;
    const blocks = tool.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name}: render 返回空`);
    assert.equal(typeof blocks[0].text, 'string', `${tool.name}: 首块不是 text`);
  }
  const shotBlocks = byName.get('cua_screenshot').output.render({}, samples.cua_screenshot);
  assert.equal(shotBlocks.length, 2, '截图应同时回 text 与 image 两块');
  assert.equal(shotBlocks[1].type, 'image');
  return '9 个 render + 截图双块';
});

await step('动作规划器 argv 正确', async () => {
  assert.deepEqual(planClick({ x: 10.4, y: 20.6 }).commands, ['cliclick c:10,21']);
  assert.deepEqual(planClick({ x: 5, y: 6, clicks: 2 }).commands, ['cliclick dc:5,6']);
  assert.deepEqual(planClick({ x: 5, y: 6, button: 'right' }).commands, ['cliclick rc:5,6']);
  assert.throws(() => planClick({ x: 5, y: 6, button: 'middle' }), /中键/);
  assert.deepEqual(planMove({ x: 3, y: 4 }).commands, ['cliclick m:3,4']);
  assert.equal(planType({ text: 'hello' }).method, 'type');
  assert.equal(planType({ text: '中文输入' }).method, 'paste');
  assert.equal(planType({ text: 'line1\nline2' }).method, 'paste');
  assert.match(planKey({ key: 'cmd+shift+4' }).commands[0], /keystroke "4" using \{command down, shift down\}/);
  assert.match(planKey({ key: 'enter' }).commands[0], /key code 36/);
  assert.equal(planKey({ key: 'tab', repeat: 3 }).commands.length, 3);
  assert.throws(() => planKey({ key: 'cmd+hyper+x' }), /修饰键/);
  const drag = planDrag({ fromX: 0, fromY: 0, toX: 100, toY: 100 });
  assert.match(drag.commands[0], /^cliclick dd:0,0$/);
  assert.match(drag.commands.at(-1), /^cliclick du:100,100$/);
  const scroll = planScroll({ scrollY: 5, scrollX: 0 });
  assert.match(scroll.commands.at(-1), /pyobjc CGEventPost/);
  assert.throws(() => planScroll({ scrollY: 0, scrollX: 0 }), /不能同时为 0/);
  assert.deepEqual(parseKeyCombo('cmd+c'), { key: 'c', char: 'c', modifiers: ['command down'] });
  assert.equal(keyScript('esc'), 'tell application "System Events" to key code 53');
  return '17 组断言通过';
});

await step('dry_run 走真实 execute 但不发事件', async () => {
  const cases = [
    ['cua_click', { x: 100, y: 200, dry_run: true }],
    ['cua_move', { x: 1, y: 2, dry_run: true }],
    ['cua_key', { key: 'cmd+a', dry_run: true }],
    ['cua_scroll', { scrollY: 3, dry_run: true }],
    ['cua_drag', { fromX: 1, fromY: 1, toX: 9, toY: 9, dry_run: true }],
  ];
  for (const [name, args] of cases) {
    const value = await byName.get(name).execute(args, {});
    assert.equal(value.dryRun, true, `${name}: 应返回 dryRun`);
    assert.ok(Array.isArray(value.plan) && value.plan.length > 0, `${name}: plan 为空`);
  }
  return `${cases.length} 个动作 dry_run 通过`;
});

let statusValue;
await step('cua_status 真跑（权限 + 后端 + 显示器）', async () => {
  statusValue = await byName.get('cua_status').execute({}, {});
  assert.equal(statusValue.ok, true);
  assert.equal(statusValue.platform, 'darwin');
  assert.ok(['granted', 'denied', 'unknown'].includes(statusValue.permissions.accessibility));
  assert.ok(['granted', 'denied', 'unknown'].includes(statusValue.permissions.screenRecording));
  assert.ok(statusValue.displays.length >= 1, '至少应探测到一个显示器');
  return `辅助功能=${statusValue.permissions.accessibility} 屏幕录制=${statusValue.permissions.screenRecording} `
    + `显示器=${statusValue.displays.map((item) => `${item.width}x${item.height}@${item.scale}x`).join(',')}`;
});

let screenshotValue;
await step('cua_screenshot 真截屏（落盘 + 内联图片块）', async () => {
  if (statusValue?.permissions.screenRecording === 'denied') {
    await assert.rejects(byName.get('cua_screenshot').execute({}, {}), /屏幕录制/);
    return '未授权屏幕录制：已按预期报授权错误（授权后重跑可得真实截图）';
  }
  screenshotValue = await byName.get('cua_screenshot').execute({ inline: true, max_width: 1280 }, {});
  assert.equal(screenshotValue.ok, true);
  assert.ok(existsSync(screenshotValue.path), `截图未落盘：${screenshotValue.path}`);
  assert.ok(screenshotValue.width > 0 && screenshotValue.height > 0);
  assert.ok(screenshotValue.width <= 1280, `max_width 未生效：${screenshotValue.width}`);
  assert.equal(screenshotValue.downscaled, true);
  assert.equal(screenshotValue.inline, true, `未内联：${screenshotValue.note ?? ''}`);
  const blocks = byName.get('cua_screenshot').output.render({}, screenshotValue);
  assert.equal(blocks[1].type, 'image');
  const bytes = await readFile(screenshotValue.path);
  const size = pngSize(bytes);
  assert.equal(size.width, screenshotValue.width);
  await unlink(screenshotValue.path);

  // 不给 max_width 时应回落到显示器逻辑宽度（本机主屏 1920），而不是保留 3840 物理像素
  const auto = await byName.get('cua_screenshot').execute({ inline: false }, {});
  const logicalWidth = Math.round(statusValue.displays[0].width);
  assert.equal(auto.width, logicalWidth, `默认应缩放到逻辑宽度 ${logicalWidth}，实际 ${auto.width}`);
  await unlink(auto.path);
  return `${screenshotValue.width}x${screenshotValue.height}（scale ${screenshotValue.scale}，${bytes.length} bytes）；默认宽度=${auto.width} → 临时文件已删`;
});

await step('辅助功能闸门：未授权时明确报错，不静默失败', async () => {
  if (statusValue?.permissions.accessibility !== 'denied') {
    return `跳过（当前 accessibility=${statusValue?.permissions.accessibility}，不真点屏幕）`;
  }
  await assert.rejects(byName.get('cua_click').execute({ x: 300, y: 300 }, {}), /辅助功能/);
  await assert.rejects(byName.get('cua_type').execute({ text: 'x' }, {}), /辅助功能/);
  return 'cua_click / cua_type 均已按预期拒绝';
});

let windowsValue;
await step('cua_windows 真跑（pyobjc 窗口枚举）', async () => {
  if (statusValue?.backends.scroll === '') {
    return '跳过（pyobjc 不可用）';
  }
  windowsValue = await byName.get('cua_windows').execute({ limit: 5 }, {});
  assert.equal(windowsValue.ok, true);
  assert.ok(windowsValue.count <= 5);
  assert.ok(windowsValue.total >= windowsValue.count);
  return `${windowsValue.count}/${windowsValue.total} 个窗口，首个：${windowsValue.windows[0]?.owner ?? '—'}`;
});

await step('真实返回值过 output.schema（运行时不会 ToolOutputError）', async () => {
  if (dshTools.module === undefined) return 'skipped（无 dsh-tools）';
  const { validateJsonSchemaValue } = dshTools.module;
  const cases = [
    ['cua_status', statusValue],
    ['cua_screenshot', screenshotValue],
    ['cua_windows', windowsValue],
  ].filter(([, value]) => value !== undefined);
  for (const [name, value] of cases) {
    const violations = validateJsonSchemaValue(byName.get(name).output.schema, value, '');
    assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`);
  }
  return `${cases.length} 个真实结果（status/screenshot/windows）形状合法`;
});

await step('配置归一化与目录约定', async () => {
  const state = createComputerUse(ctx, { maxImageWidth: 1024, inlineImages: false });
  assert.equal(state.settings.maxImageWidth, 1024);
  assert.equal(state.settings.inlineImages, false);
  assert.equal(state.settings.skipPermissionGate, false);
  assert.match(state.settings.captureDir, /computer-use$/);
  assert.equal(createTools(state).length, TOOL_NAMES.length);
  return `captureDir=${state.settings.captureDir}`;
});

// ------------------------------------------------------------------ 汇总 ----

console.log('');
if (notes.length > 0) for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} 项：${failures.map((item) => item.label).join(' | ')}`);
  process.exit(1);
}
console.log(`OK computer-use ${VERSION} 自检通过（${TOOL_NAMES.length} 个工具）`);
if (statusValue !== undefined) {
  const missing = statusValue.guidance.filter((line) => line.includes('缺少「'));
  if (missing.length > 0) {
    console.log('待用户授权/安装：');
    for (const line of missing) console.log(`  - ${line}`);
  }
}
