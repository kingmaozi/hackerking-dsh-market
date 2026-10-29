/**
 * 工具定义层：9 个 `cua_*` 工具的 schema 与执行体。
 *
 * DSH 的注册约束（dsh-tools 0.2.1-rc.2 `ToolRuntime.register`）：
 *   - `output` 必须是 `{ schema, render }`，`render` 是函数；
 *   - `output.schema` 走**标准 JSON-Schema 子集**（对象级 `required: [...]` 数组，
 *     不接受 `type: 'json'`、不接受字段级 `required: true`）；
 *   - `parameters` 走**参数方言**（字段级 `required: true`，由
 *     parameterSchemaSpecToJsonSchema 编译）。
 * 两侧形状不同，别抄串。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IS_MAC,
  listWindows,
  pngSize,
  postScroll,
  probeSystem,
  pythonInfo,
  resolveBinary,
  run,
} from './system.js';
import { planClick, planDrag, planKey, planMove, planScroll, planType } from './actions.js';
import { compileParams, validateArgs } from './schema.js';

export const VERSION = '0.1.0';

/** 工具名 → 作者方言参数表（selftest 用它做「编译结果 == dsh-tools 编译结果」的等价断言）。 */
const parameterSpecs = new Map();

/** 取某个工具的作者方言参数表（仅在 createTools() 跑过之后有值）。 */
export function parameterSpecOf(name) {
  return parameterSpecs.get(name);
}

export const TOOL_NAMES = [
  'cua_status',
  'cua_screenshot',
  'cua_windows',
  'cua_click',
  'cua_move',
  'cua_type',
  'cua_key',
  'cua_scroll',
  'cua_drag',
];

const GUIDANCE = {
  accessibility:
    '缺少「辅助功能」授权：系统设置 → 隐私与安全性 → 辅助功能 → 打开（或用 + 添加）'
    + '/Applications/DeepSeek Harness.app，然后退出并重开 DSH。未授权时 macOS 会静默丢弃'
    + '所有合成鼠标/键盘事件，点按看起来「成功」但界面不动。授权后把 skipPermissionGate 关掉即可正常校验。',
  screenRecording:
    '缺少「屏幕录制」授权：系统设置 → 隐私与安全性 → 屏幕录制 → 打开（或用 + 添加）'
    + '/Applications/DeepSeek Harness.app，然后退出并重开 DSH。未授权时 screencapture 会返回'
    + '「could not create image from display」。',
  cliclick: '缺少 cliclick：`brew install cliclick`（本机已在 /opt/homebrew/bin/cliclick）。',
  automation:
    '缺少「自动化」授权：系统设置 → 隐私与安全性 → 自动化 → 允许 DeepSeek Harness 控制 “System Events”。'
    + '首次调用 cua_key / 粘贴输入时会弹窗，选允许即可；拒绝后 osascript 会报 -1743。',
  pyobjc: '缺少 python3 + pyobjc：`python3 -m pip install --user pyobjc-framework-Quartz`；'
    + '滚动、窗口枚举、权限探针依赖它，缺失时这些工具会明确报错，点击/输入不受影响。',
};

/** 默认配置。 */
export function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    inlineImages: config.inlineImages !== false,
    maxImageWidth: Number.isFinite(config.maxImageWidth) && config.maxImageWidth > 0
      ? Math.round(config.maxImageWidth)
      : 0,
    captureDir: typeof config.captureDir === 'string' && config.captureDir.length > 0
      ? config.captureDir
      : join(tmpdir(), 'computer-use'),
    commandTimeoutMs: Number.isFinite(config.commandTimeoutMs) && config.commandTimeoutMs > 0
      ? Math.round(config.commandTimeoutMs)
      : 20000,
    skipPermissionGate: config.skipPermissionGate === true || process.env.CUA_SKIP_PERMISSION_GATE === '1',
    restoreClipboard: config.restoreClipboard !== false,
    cliclickPath: config.cliclickPath,
    screencapturePath: config.screencapturePath,
    sipsPath: config.sipsPath,
    osascriptPath: config.osascriptPath,
    pythonPath: config.pythonPath,
  };
}

function permissionWord(value) {
  if (value === true) return 'granted';
  if (value === false) return 'denied';
  return 'unknown';
}

/**
 * 建立一次挂载期的共享状态：二进制解析、系统探针缓存、权限闸门。
 * @param {any} ctx 插件上下文（只用 get/logger，便于 mock）
 * @param {object} config 插件配置
 */
export function createComputerUse(ctx, config = {}) {
  const settings = normalizeConfig(config);
  const cache = { system: undefined };
  const warn = (message) => ctx?.logger?.warn?.(message);

  function backends() {
    return {
      screenshot: resolveBinary('screencapture', settings.screencapturePath),
      sips: resolveBinary('sips', settings.sipsPath),
      pointer: resolveBinary('cliclick', settings.cliclickPath),
      keyboard: resolveBinary('osascript', settings.osascriptPath),
      pbcopy: resolveBinary('pbcopy'),
      pbpaste: resolveBinary('pbpaste'),
    };
  }

  async function systemInfo(signal, fresh = false) {
    const now = Date.now();
    if (!fresh && cache.system !== undefined && now - cache.system.at < 5000) return cache.system.value;
    const value = await probeSystem(settings, signal);
    cache.system = { at: now, value };
    return value;
  }

  async function scaleForPoint(point, signal) {
    if (point === undefined) return 1;
    const system = await systemInfo(signal);
    const display = (system.displays ?? []).find((item) => (
      point.x >= item.x && point.x <= item.x + item.width
      && point.y >= item.y && point.y <= item.y + item.height
    ));
    return display?.scale && display.scale > 0 ? display.scale : 1;
  }

  /** pixel 坐标 → 逻辑点坐标（截屏默认已缩放到点，两者 1:1）。 */
  async function toPoints(x, y, space, signal) {
    if (space === undefined || space === 'points') return { x, y };
    if (space !== 'pixels') throw new Error('space 只能是 points 或 pixels');
    const scale = await scaleForPoint({ x, y }, signal);
    return { x: x / scale, y: y / scale };
  }

  async function requirePointer(signal) {
    if (!IS_MAC) throw new Error(`computer-use 只支持 macOS，当前平台 ${process.platform}`);
    const bins = backends();
    if (bins.pointer === undefined) throw new Error(GUIDANCE.cliclick);
    if (settings.skipPermissionGate) return bins;
    const system = await systemInfo(signal, true);
    if (system.accessibility === false) throw new Error(GUIDANCE.accessibility);
    if (system.accessibility === undefined) warn(`[computer-use] 权限探针不可用（${system.reason ?? '未知'}），跳过辅助功能闸门`);
    return bins;
  }

  async function requireScreen(signal) {
    if (!IS_MAC) throw new Error(`computer-use 只支持 macOS，当前平台 ${process.platform}`);
    const bins = backends();
    if (bins.screenshot === undefined) throw new Error('找不到 screencapture（系统自带，正常情况下不该缺失）');
    if (settings.skipPermissionGate) return bins;
    const system = await systemInfo(signal, true);
    if (system.screenRecording === false) throw new Error(GUIDANCE.screenRecording);
    if (system.screenRecording === undefined) warn(`[computer-use] 权限探针不可用（${system.reason ?? '未知'}），跳过屏幕录制闸门`);
    return bins;
  }

  async function pointerPosition(signal) {
    const bins = backends();
    if (bins.pointer === undefined) return undefined;
    const result = await run(bins.pointer, ['p'], { timeoutMs: 5000, signal });
    if (result.code !== 0) return undefined;
    const line = result.stdout.trim().split('\n').filter((item) => /\d/.test(item)).pop();
    const match = /(-?\d+)\s*,\s*(-?\d+)/.exec(line ?? '');
    return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]) };
  }

  async function readClipboard(signal) {
    const bins = backends();
    if (bins.pbpaste === undefined) return '';
    const result = await run(bins.pbpaste, [], { timeoutMs: 5000, signal });
    return result.code === 0 ? result.stdout : '';
  }

  async function executePlan(plan, signal) {
    const bins = backends();
    for (const step of plan.steps) {
      if (step.bin === 'pyobjc-scroll') {
        await postScroll(settings, step.scroll, signal);
        continue;
      }
      const binary = bins[step.bin];
      if (binary === undefined) throw new Error(`缺少可执行文件 ${step.bin}`);
      const result = await run(binary, step.args, {
        input: step.input,
        timeoutMs: settings.commandTimeoutMs,
        signal,
      });
      if (result.code !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').filter(Boolean).slice(-2).join(' ');
        const message = `${step.bin} 执行失败：${detail.length > 0 ? detail : `exit=${result.code}`}`;
        throw new Error(/-1743|Not authorized to send Apple events/i.test(message) ? `${message}\n${GUIDANCE.automation}` : message);
      }
    }
  }

  async function statusOf(signal) {
    const bins = backends();
    const python = await pythonInfo(settings, signal);
    const system = await systemInfo(signal, true);
    const guidance = [];
    if (bins.pointer === undefined) guidance.push(GUIDANCE.cliclick);
    if (python.pyobjc !== true) guidance.push(GUIDANCE.pyobjc);
    if (system.accessibility === false) guidance.push(GUIDANCE.accessibility);
    if (system.screenRecording === false) guidance.push(GUIDANCE.screenRecording);
    if (guidance.length === 0) guidance.push('后端与权限就绪：可以截屏并对指针/键盘发事件。');
    return {
      ok: true,
      platform: process.platform,
      version: VERSION,
      backends: {
        screenshot: bins.screenshot ?? '',
        pointer: bins.pointer ?? '',
        keyboard: bins.keyboard ?? '',
        clipboard: bins.pbcopy ?? '',
        scroll: python.pyobjc === true ? python.path : '',
        python: python.path ?? '',
      },
      permissions: {
        accessibility: permissionWord(system.accessibility),
        screenRecording: permissionWord(system.screenRecording),
        probe: system.probe,
      },
      displays: (system.displays ?? []).map((item) => ({
        id: item.id,
        main: item.main === true,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        pixelWidth: item.pixelWidth,
        pixelHeight: item.pixelHeight,
        scale: item.scale,
      })),
      guidance,
    };
  }

  return {
    settings,
    backends,
    ctx,
    systemInfo,
    toPoints,
    requirePointer,
    requireScreen,
    pointerPosition,
    readClipboard,
    executePlan,
    statusOf,
  };
}

// ---------------------------------------------------------------- schemas ----

/** 动作类工具共用的输出 schema（标准 JSON-Schema 子集）。 */
const ACTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'action'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    dryRun: { type: 'boolean' },
    plan: { type: 'array', items: { type: 'string' } },
    pointer: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
    verified: { type: 'boolean' },
    method: { type: 'string' },
    characters: { type: 'integer' },
    clipboardRestored: { type: 'boolean' },
    warning: { type: 'string' },
    note: { type: 'string' },
  },
};

const POINT_PARAMS = {
  x: { type: 'number', required: true, description: 'x 坐标（默认逻辑点，与截图 1:1）' },
  y: { type: 'number', required: true, description: 'y 坐标（默认逻辑点，与截图 1:1）' },
  space: {
    type: 'string',
    enum: ['points', 'pixels'],
    description: '坐标系：points（默认，截图像素=点）或 pixels（Retina 物理像素，按显示器缩放换算）',
  },
  dry_run: { type: 'boolean', description: '只返回将要执行的命令，不发任何事件（安全预演）' },
};

function textBlock(text) {
  return [{ type: 'text', text }];
}

function actionRender(tool, args, value) {
  if (value?.dryRun === true) {
    return textBlock(`[${tool}] 预演（未执行）：\n${(value.plan ?? []).map((line) => `- ${line}`).join('\n')}`);
  }
  const pieces = [`[${tool}] ok=${value?.ok === true}`];
  if (value?.pointer !== undefined) pieces.push(`指针=(${value.pointer.x}, ${value.pointer.y})`);
  if (value?.verified === false) pieces.push('指针未到目标位置');
  if (value?.method !== undefined) pieces.push(`输入方式=${value.method}`);
  if (value?.characters !== undefined) pieces.push(`字符数=${value.characters}`);
  if (value?.clipboardRestored === true) pieces.push('剪贴板已还原');
  if (value?.warning !== undefined) pieces.push(`警告：${value.warning}`);
  if (value?.note !== undefined) pieces.push(`备注：${value.note}`);
  return textBlock(pieces.join(' '));
}

/** 统一的 dry-run 返回值。 */
function dryRunResult(action, plan) {
  return { ok: true, action, dryRun: true, plan: plan.commands };
}

// ------------------------------------------------------------------ tools ----

/**
 * 构建全部工具定义。
 * @param {ReturnType<typeof createComputerUse>} state
 */
export function createTools(state) {
  const screenshotTool = {
    name: 'cua_screenshot',
    description:
      '截取 macOS 屏幕（默认主显示器整屏，按逻辑点 1:1 缩放），返回图片块与文件路径。'
      + '坐标说明：返回图片的每个像素 = 一个逻辑点，可直接把图上坐标喂给 cua_click/cua_drag（space=points）。'
      + '可选 region 用四个平铺字段 region_x/region_y/region_width/region_height（逻辑点）裁切。',
    parameters: {
      display: { type: 'integer', description: '显示器序号，1=主显示器（默认 1），与系统设置中的排列顺序一致' },
      region_x: { type: 'number', description: '裁切区域左上角 x（逻辑点，全局坐标）' },
      region_y: { type: 'number', description: '裁切区域左上角 y（逻辑点，全局坐标）' },
      region_width: { type: 'number', description: '裁切宽度（逻辑点）' },
      region_height: { type: 'number', description: '裁切高度（逻辑点）' },
      max_width: { type: 'integer', description: '输出图片最大宽度（像素=点）；省略时按显示器逻辑宽度' },
      inline: { type: 'boolean', description: '是否把截图作为图片块回给模型（默认 true；false 只落盘）' },
      path: { type: 'string', description: '落盘路径（默认写到系统临时目录 computer-use/）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'path', 'width', 'height', 'bytes', 'scale', 'coordinateSpace', 'display', 'downscaled', 'inline'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          scale: { type: 'number' },
          coordinateSpace: { type: 'string', enum: ['points'] },
          display: { type: 'integer' },
          downscaled: { type: 'boolean' },
          inline: { type: 'boolean' },
          note: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string', enum: ['image/png'] },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
      render(_args, value) {
        const lines = [
          `<path>${value?.path ?? ''}</path>`,
          `${value?.width ?? 0}x${value?.height ?? 0} px（1 px = 1 逻辑点，scale=${value?.scale ?? 1}，显示器 ${value?.display ?? 1}）`,
          `${value?.bytes ?? 0} bytes${value?.downscaled === true ? '（已从物理像素缩放）' : ''}`,
        ];
        if (value?.note !== undefined) lines.push(`备注：${value.note}`);
        const blocks = textBlock(lines.join('\n'));
        if (value?.image !== undefined) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec?.signal;
      const bins = await state.requireScreen(signal);
      const system = await state.systemInfo(signal, true);
      const display = args.display ?? 1;
      if (!Number.isInteger(display) || display < 1) throw new Error('display 必须是从 1 开始的整数');
      const regionFields = [args.region_x, args.region_y, args.region_width, args.region_height];
      const given = regionFields.filter((value) => typeof value === 'number').length;
      if (given !== 0 && given !== 4) throw new Error('裁切需要同时给 region_x/region_y/region_width/region_height');
      if (given === 4 && (args.region_width <= 0 || args.region_height <= 0)) throw new Error('region_width / region_height 必须为正数');

      const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
      const target = typeof args.path === 'string' && args.path.length > 0
        ? args.path
        : join(state.settings.captureDir, `shot-${stamp}.png`);
      await mkdir(dirname(target), { recursive: true });

      const caps = ['-x', '-t', 'png'];
      if (given === 4) {
        caps.push('-R', `${Math.round(args.region_x)},${Math.round(args.region_y)},${Math.round(args.region_width)},${Math.round(args.region_height)}`);
      } else {
        caps.push('-D', String(display));
      }
      const capture = await run(bins.screenshot, [...caps, target], {
        timeoutMs: state.settings.commandTimeoutMs,
        signal,
      });
      if (capture.code !== 0) {
        const detail = capture.stderr.trim() || capture.stdout.trim() || `exit=${capture.code}`;
        throw new Error(`screencapture 失败：${detail}`
          + (capture.stderr.includes('could not create image')
            ? `\n${GUIDANCE.screenRecording}`
            : ''));
      }

      let bytes = await readFile(target);
      let size = pngSize(bytes);
      if (size === undefined) throw new Error(`截屏输出不是有效 PNG：${target}`);
      const displayInfo = (system.displays ?? [])[display - 1];
      const scale = displayInfo?.scale && displayInfo.scale > 0 ? displayInfo.scale : 1;
      const logicalWidth = given === 4 ? Math.round(args.region_width) : Math.round(size.width / scale);
      const requestedWidth = args.max_width ?? state.settings.maxImageWidth;
      const targetWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? Math.round(requestedWidth) : logicalWidth;
      let downscaled = false;
      if (targetWidth > 0 && size.width > targetWidth && bins.sips !== undefined) {
        const resized = await run(bins.sips, ['-s', 'format', 'png', '--resampleWidth', String(targetWidth), target, '--out', target], {
          timeoutMs: state.settings.commandTimeoutMs,
          signal,
        });
        if (resized.code === 0) {
          bytes = await readFile(target);
          const next = pngSize(bytes);
          if (next !== undefined) {
            size = next;
            downscaled = true;
          }
        }
      }

      let note;
      let image;
      const attachments = state.ctx?.get?.('attachments') ?? state.ctx?.attachments;
      const wantsInline = args.inline !== false && state.settings.inlineImages;
      if (wantsInline && attachments?.saveImage !== undefined) {
        if (!(await routeSupportsImages(state.ctx, exec))) {
          note = '当前模型路由不接受图像输入，截图只落盘；换支持图片的模型可内联。';
        } else {
          try {
            const ref = await attachments.saveImage({
              data: bytes,
              mediaType: 'image/png',
              name: basename(target),
            });
            image = {
              attachmentId: String(ref.attachmentId),
              mediaType: 'image/png',
              bytes: typeof ref.bytes === 'number' ? ref.bytes : bytes.length,
              width: typeof ref.width === 'number' ? ref.width : size.width,
              height: typeof ref.height === 'number' ? ref.height : size.height,
              name: typeof ref.name === 'string' ? ref.name : basename(target),
            };
          } catch (error) {
            note = `内联失败（已保留文件）：${error?.message ?? error}`;
          }
        }
      } else if (wantsInline) {
        note = '当前 profile 没有 attachments 服务，截图只落盘；用 read_image 或文件路径自行查看。';
      }

      return {
        ok: true,
        path: target,
        width: size.width,
        height: size.height,
        bytes: bytes.length,
        scale,
        coordinateSpace: 'points',
        display,
        downscaled,
        inline: image !== undefined,
        ...(note === undefined ? {} : { note }),
        ...(image === undefined ? {} : { image }),
      };
    },
  };

  const statusTool = {
    name: 'cua_status',
    description:
      '体检 computer-use 后端与授权：screencapture / cliclick / osascript / python3+pyobjc 是否可用，'
      + '辅助功能与屏幕录制是否已授权，显示器逻辑尺寸与缩放比。动手前先跑一次。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'platform', 'version', 'backends', 'permissions', 'displays', 'guidance'],
        properties: {
          ok: { type: 'boolean' },
          platform: { type: 'string' },
          version: { type: 'string' },
          backends: {
            type: 'object',
            additionalProperties: false,
            required: ['screenshot', 'pointer', 'keyboard', 'clipboard', 'scroll', 'python'],
            properties: {
              screenshot: { type: 'string' },
              pointer: { type: 'string' },
              keyboard: { type: 'string' },
              clipboard: { type: 'string' },
              scroll: { type: 'string' },
              python: { type: 'string' },
            },
          },
          permissions: {
            type: 'object',
            additionalProperties: false,
            required: ['accessibility', 'screenRecording', 'probe'],
            properties: {
              accessibility: { type: 'string', enum: ['granted', 'denied', 'unknown'] },
              screenRecording: { type: 'string', enum: ['granted', 'denied', 'unknown'] },
              probe: { type: 'string', enum: ['pyobjc', 'none'] },
            },
          },
          displays: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'main', 'x', 'y', 'width', 'height', 'pixelWidth', 'pixelHeight', 'scale'],
              properties: {
                id: { type: 'integer' },
                main: { type: 'boolean' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                pixelWidth: { type: 'integer' },
                pixelHeight: { type: 'integer' },
                scale: { type: 'number' },
              },
            },
          },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const permissions = value?.permissions ?? {};
        const lines = [
          `computer-use ${value?.version ?? ''} @ ${value?.platform ?? ''}`,
          `辅助功能=${permissions.accessibility ?? '?'} 屏幕录制=${permissions.screenRecording ?? '?'}（探针 ${permissions.probe ?? '?'}）`,
          `后端：截图=${value?.backends?.screenshot || '缺失'} 指针=${value?.backends?.pointer || '缺失'} 键盘=${value?.backends?.keyboard || '缺失'} 滚动=${value?.backends?.scroll || '缺失'}`,
          `显示器：${(value?.displays ?? []).map((item) => (
            `${item.main ? '主' : `#${item.id}`} ${item.width}x${item.height}pt @${item.scale}x`
          )).join('；') || '未探测到'}`,
        ];
        for (const item of value?.guidance ?? []) lines.push(`- ${item}`);
        return textBlock(lines.join('\n'));
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return state.statusOf(exec?.signal);
    },
  };

  const windowsTool = {
    name: 'cua_windows',
    description:
      '枚举当前屏幕上的窗口（owner/标题/pid/层级/逻辑点边界），用来定位要点击的坐标。'
      + '窗口标题需要屏幕录制授权才有值；无授权时 title 为空串但几何仍然可用。',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少个窗口（默认 40，上限 200）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'windows'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          total: { type: 'integer' },
          note: { type: 'string' },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['owner', 'title', 'pid', 'layer', 'x', 'y', 'width', 'height'],
              properties: {
                owner: { type: 'string' },
                title: { type: 'string' },
                pid: { type: 'integer' },
                layer: { type: 'integer' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
          },
        },
      },
      render(_args, value) {
        const head = `[cua_windows] ${value?.count ?? 0}/${value?.total ?? 0} 个窗口`;
        const rows = (value?.windows ?? []).slice(0, 20).map((item) => (
          `- ${item.owner}${item.title ? ` — ${item.title}` : ''} @${Math.round(item.x)},${Math.round(item.y)} ${Math.round(item.width)}x${Math.round(item.height)} (pid ${item.pid})`
        ));
        return textBlock([head, ...rows, ...(value?.note ? [`备注：${value.note}`] : [])].join('\n'));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = Math.min(200, Math.max(1, args.limit ?? 40));
      const result = await listWindows(state.settings, { limit }, exec?.signal);
      const system = await state.systemInfo(exec?.signal);
      return {
        ok: true,
        count: result.windows.length,
        total: result.total,
        ...(system.screenRecording === false
          ? { note: '未授权屏幕录制，窗口标题为空；几何与 owner 不受影响。' }
          : {}),
        windows: result.windows,
      };
    },
  };

  const clickTool = {
    name: 'cua_click',
    description: '在指定坐标点击（左键单击/双击/三击或右键单击）。坐标默认逻辑点，与 cua_screenshot 返回的图片 1:1。',
    parameters: {
      ...POINT_PARAMS,
      button: { type: 'string', enum: ['left', 'right'], description: '鼠标键（默认 left；cliclick 无中键命令）' },
      clicks: { type: 'integer', description: '点击次数 1/2/3（仅左键；默认 1）' },
    },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_click', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const point = await state.toPoints(args.x, args.y, args.space, exec?.signal);
      const plan = planClick({ ...point, button: args.button ?? 'left', clicks: args.clicks ?? 1 });
      if (args.dry_run === true) return dryRunResult('click', plan);
      await state.requirePointer(exec?.signal);
      await state.executePlan(plan, exec?.signal);
      const pointer = await state.pointerPosition(exec?.signal);
      const verified = pointer !== undefined
        && Math.abs(pointer.x - plan.point.x) <= 2
        && Math.abs(pointer.y - plan.point.y) <= 2;
      return {
        ok: true,
        action: 'click',
        ...(pointer === undefined ? {} : { pointer }),
        verified,
        ...(verified ? {} : { warning: '指针没有停在目标点，事件可能被系统丢弃（检查辅助功能授权）。' }),
      };
    },
  };

  const moveTool = {
    name: 'cua_move',
    description: '把指针移动到指定坐标（用于悬停/触发 tooltip/准备拖拽）。',
    parameters: { ...POINT_PARAMS },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_move', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const point = await state.toPoints(args.x, args.y, args.space, exec?.signal);
      const plan = planMove(point);
      if (args.dry_run === true) return dryRunResult('move', plan);
      await state.requirePointer(exec?.signal);
      await state.executePlan(plan, exec?.signal);
      const pointer = await state.pointerPosition(exec?.signal);
      return {
        ok: true,
        action: 'move',
        ...(pointer === undefined ? {} : { pointer }),
        verified: pointer !== undefined && Math.abs(pointer.x - plan.point.x) <= 2 && Math.abs(pointer.y - plan.point.y) <= 2,
      };
    },
  };

  const typeTool = {
    name: 'cua_type',
    description:
      '向当前前台窗口输入文本。短 ASCII 走逐字键入；中文/多行/超长文本走剪贴板粘贴（会临时占用剪贴板，默认粘贴后还原）。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
      method: { type: 'string', enum: ['auto', 'type', 'paste'], description: '输入方式（默认 auto）' },
      dry_run: { type: 'boolean', description: '只返回计划命令（不碰剪贴板、不发按键）' },
    },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_type', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const plan = planType({ text: args.text, method: args.method ?? 'auto' });
      if (args.dry_run === true) return dryRunResult('type', plan);
      await state.requirePointer(exec?.signal);
      const previous = plan.method === 'paste' && state.settings.restoreClipboard
        ? await state.readClipboard(exec?.signal)
        : '';
      await state.executePlan(plan, exec?.signal);
      let clipboardRestored = false;
      if (plan.method === 'paste' && state.settings.restoreClipboard && previous.length > 0) {
        const bins = state.backends();
        if (bins.pbcopy !== undefined) {
          const restore = await run(bins.pbcopy, [], { input: previous, timeoutMs: 5000, signal: exec?.signal });
          clipboardRestored = restore.code === 0;
        }
      }
      return {
        ok: true,
        action: 'type',
        method: plan.method,
        characters: [...String(args.text)].length,
        ...(plan.method === 'paste' ? { clipboardRestored } : {}),
      };
    },
  };

  const keyTool = {
    name: 'cua_key',
    description:
      '按键或组合键（System Events）：enter/tab/esc/arrow-up/page-down/f1..f12，或 cmd+shift+4 这类组合。'
      + '首次使用会在系统设置里触发「自动化」授权提示（DeepSeek Harness 控制 System Events），需允许。',
    parameters: {
      key: { type: 'string', required: true, description: '按键或组合，例如 "enter"、"cmd+c"、"cmd+shift+4"' },
      repeat: { type: 'integer', description: '重复次数 1..50（默认 1）' },
      dry_run: { type: 'boolean', description: '只返回计划命令' },
    },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_key', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const plan = planKey({ key: args.key, repeat: args.repeat ?? 1 });
      if (args.dry_run === true) return dryRunResult('press', plan);
      await state.requirePointer(exec?.signal);
      await state.executePlan(plan, exec?.signal);
      return { ok: true, action: 'press', method: plan.key, characters: plan.repeat };
    },
  };

  const scrollTool = {
    name: 'cua_scroll',
    description:
      '滚动（pyobjc 投递滚轮事件）。scrollY 正数 = 向下浏览内容，负数 = 向上；scrollX 正数 = 向右。'
      + '可选先移动指针到 (x, y) 再滚，避免滚到别的窗口。',
    parameters: {
      scrollY: { type: 'integer', description: '垂直滚动量（正=向下；单位由 unit 决定）' },
      scrollX: { type: 'integer', description: '水平滚动量（正=向右）' },
      x: { type: 'number', description: '滚前把指针移到此 x（可选）' },
      y: { type: 'number', description: '滚前把指针移到此 y（可选）' },
      unit: { type: 'string', enum: ['line', 'pixel'], description: '滚动单位（默认 line）' },
      dry_run: { type: 'boolean', description: '只返回计划命令' },
    },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_scroll', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const x = typeof args.x === 'number' ? args.x : undefined;
      const y = typeof args.y === 'number' ? args.y : undefined;
      const plan = planScroll({ x, y, scrollY: args.scrollY ?? 0, scrollX: args.scrollX ?? 0, unit: args.unit ?? 'line' });
      if (args.dry_run === true) return dryRunResult('scroll', plan);
      await state.requirePointer(exec?.signal);
      await state.executePlan(plan, exec?.signal);
      return { ok: true, action: 'scroll', note: 'scrollY 正=向下，scrollX 正=向右；方向异常时取反。' };
    },
  };

  const dragTool = {
    name: 'cua_drag',
    description: '从起点按下、分步移动到终点、抬起（用于拖文件/选文本/拖滑块）。坐标默认逻辑点。',
    parameters: {
      fromX: { type: 'number', required: true, description: '起点 x' },
      fromY: { type: 'number', required: true, description: '起点 y' },
      toX: { type: 'number', required: true, description: '终点 x' },
      toY: { type: 'number', required: true, description: '终点 y' },
      space: { type: 'string', enum: ['points', 'pixels'], description: '坐标系（默认 points）' },
      dry_run: { type: 'boolean', description: '只返回计划命令' },
    },
    output: { schema: ACTION_OUTPUT, render: (args, value) => actionRender('cua_drag', args, value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const from = await state.toPoints(args.fromX, args.fromY, args.space, exec?.signal);
      const to = await state.toPoints(args.toX, args.toY, args.space, exec?.signal);
      const plan = planDrag({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
      if (args.dry_run === true) return dryRunResult('drag', plan);
      await state.requirePointer(exec?.signal);
      await state.executePlan(plan, exec?.signal);
      const pointer = await state.pointerPosition(exec?.signal);
      return {
        ok: true,
        action: 'drag',
        ...(pointer === undefined ? {} : { pointer }),
        verified: pointer !== undefined && Math.abs(pointer.x - to.x) <= 3 && Math.abs(pointer.y - to.y) <= 3,
      };
    },
  };

  const authored = [statusTool, screenshotTool, windowsTool, clickTool, moveTool, typeTool, keyTool, scrollTool, dragTool];

  // 注册前把作者方言编成标准 JSON Schema，并补上参数校验（raw register 不会替你校验）。
  return authored.map((tool) => {
    const spec = tool.parameters ?? {};
    parameterSpecs.set(tool.name, spec);
    const compiled = compileParams(spec);
    if (compiled.type !== 'object') throw new Error(`${tool.name}: parameters 根必须是 object`);
    const execute = tool.execute;
    return {
      ...tool,
      parameters: compiled,
      async execute(args, exec) {
        const violations = validateArgs(compiled, args ?? {});
        if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`);
        return execute(args ?? {}, exec);
      },
    };
  });
}

/** 判断当前模型路由是否声明了图像输入；无法判断时按「支持」处理。 */
async function routeSupportsImages(ctx, exec) {
  try {
    const llm = ctx?.get?.('llm');
    if (llm?.resolveModelInfo === undefined) return true;
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec?.agent?.options?.provider;
    const model = routed?.model ?? exec?.agent?.options?.model;
    if (provider === undefined || model === undefined) return true;
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    if (info?.inputModalities === undefined) return true;
    return info.inputModalities.includes('image');
  } catch {
    return true;
  }
}
