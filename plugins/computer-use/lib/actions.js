/**
 * 纯规划层：把工具参数翻译成命令行步骤，不执行任何东西。
 * 这样 selftest 可以在不点屏幕的前提下验证每一条动作的 argv。
 */

/** cliclick 支持、且 macOS 键盘映射稳定的按键 → key code。 */
export const KEY_CODES = new Map(Object.entries({
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  'arrow-left': 123,
  right: 124,
  'arrow-right': 124,
  down: 125,
  'arrow-down': 125,
  up: 126,
  'arrow-up': 126,
  home: 115,
  end: 119,
  'page-up': 116,
  'page-down': 121,
  'fwd-delete': 117,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
}));

/** 修饰键别名 → AppleScript 修饰符。 */
const MODIFIERS = new Map(Object.entries({
  cmd: 'command down',
  command: 'command down',
  alt: 'option down',
  option: 'option down',
  opt: 'option down',
  ctrl: 'control down',
  control: 'control down',
  shift: 'shift down',
}));

/** AppleScript 字符串字面量转义。 */
export function appleString(text) {
  return `"${String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** 把 "cmd+shift+4" 解析成修饰符 + 单个按键。 */
export function parseKeyCombo(spec) {
  const raw = String(spec ?? '').trim();
  if (raw.length === 0) throw new Error('key 不能为空，例如 "enter"、"cmd+shift+4"、"tab"');
  const parts = raw.split('+').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`无法解析按键：${raw}`);
  const key = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const mapped = MODIFIERS.get(part.toLowerCase());
    if (mapped === undefined) {
      throw new Error(`不支持的修饰键 "${part}"（可用：cmd/alt/ctrl/shift）`);
    }
    if (!modifiers.includes(mapped)) modifiers.push(mapped);
  }
  const lowered = key.toLowerCase();
  if (KEY_CODES.has(lowered)) return { key, code: KEY_CODES.get(lowered), modifiers };
  if ([...key].length === 1) return { key, char: key, modifiers };
  throw new Error(`不支持的按键 "${key}"；单字符或以下名字可用：${[...KEY_CODES.keys()].join(', ')}`);
}

/** 生成按键的 System Events 脚本。 */
export function keyScript(spec) {
  const parsed = parseKeyCombo(spec);
  const using = parsed.modifiers.length > 0 ? ` using {${parsed.modifiers.join(', ')}}` : '';
  const body = parsed.char !== undefined
    ? `keystroke ${appleString(parsed.char)}`
    : `key code ${parsed.code}`;
  return `tell application "System Events" to ${body}${using}`;
}

/** 生成 Cmd+V 粘贴脚本。 */
export function pasteScript() {
  return 'tell application "System Events" to keystroke "v" using command down';
}

function assertPoint(point, label) {
  for (const axis of ['x', 'y']) {
    const value = point?.[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} 的 ${axis} 必须是有限数字`);
    }
  }
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/**
 * 点击计划。
 * @param {{x:number,y:number,button?:'left'|'right',clicks?:1|2|3}} options
 */
export function planClick(options) {
  const point = assertPoint(options, 'click');
  const button = options.button ?? 'left';
  const clicks = options.clicks ?? 1;
  if (![1, 2, 3].includes(clicks)) throw new Error('clicks 只能是 1、2 或 3');
  let command;
  if (button === 'left') {
    command = clicks === 1 ? `c:${point.x},${point.y}` : clicks === 2 ? `dc:${point.x},${point.y}` : `tc:${point.x},${point.y}`;
  } else if (button === 'right') {
    if (clicks !== 1) throw new Error('右键只支持单击');
    command = `rc:${point.x},${point.y}`;
  } else {
    throw new Error(`不支持的 button "${button}"（cliclick 没有中键命令；可用：left、right）`);
  }
  return {
    point,
    steps: [{ bin: 'cliclick', args: [command] }],
    commands: [`cliclick ${command}`],
    notes: [],
  };
}

/** 移动指针计划。 */
export function planMove(options) {
  const point = assertPoint(options, 'move');
  const command = `m:${point.x},${point.y}`;
  return { point, steps: [{ bin: 'cliclick', args: [command] }], commands: [`cliclick ${command}`], notes: [] };
}

/**
 * 拖拽计划：按下 → 若干中间移动 → 抬起。
 * @param {{fromX:number,fromY:number,toX:number,toY:number}} options
 */
export function planDrag(options) {
  const from = assertPoint({ x: options.fromX, y: options.fromY }, 'drag');
  const to = assertPoint({ x: options.toX, y: options.toY }, 'drag');
  if (from.x === to.x && from.y === to.y) throw new Error('拖拽的起点与终点相同');
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(6, Math.min(24, Math.round(distance / 24)));
  const args = [`dd:${from.x},${from.y}`];
  const commands = [`cliclick dd:${from.x},${from.y}`];
  for (let index = 1; index < steps; index++) {
    const ratio = index / steps;
    const x = Math.round(from.x + (to.x - from.x) * ratio);
    const y = Math.round(from.y + (to.y - from.y) * ratio);
    args.push(`dm:${x},${y}`, 'w:12');
    commands.push(`cliclick dm:${x},${y}`);
  }
  args.push(`du:${to.x},${to.y}`);
  commands.push(`cliclick du:${to.x},${to.y}`);
  return { from, to, steps: [{ bin: 'cliclick', args }], commands, notes: [] };
}

/** 文本输入方式判定：短 ASCII 直接键入，其余走剪贴板粘贴。 */
export function decideTypeMethod(text, requested) {
  if (requested === 'type' || requested === 'paste') return requested;
  if (text.length === 0) return 'type';
  if (text.length > 200) return 'paste';
  if (/[\n\r\t]/.test(text)) return 'paste';
  if (/[^\x20-\x7e]/.test(text)) return 'paste';
  if (/^\s|\s$/.test(text)) return 'paste';
  return 'type';
}

/**
 * 文本输入计划。
 * @param {{text:string, method?:'auto'|'type'|'paste'}} options
 */
export function planType(options) {
  const text = String(options.text ?? '');
  if (text.length === 0) throw new Error('text 不能为空');
  const method = decideTypeMethod(text, options.method);
  if (method === 'type') {
    return {
      method,
      steps: [{ bin: 'cliclick', args: ['-f', '-'], input: `t:${text}\n` }],
      commands: [`cliclick -f - <<< t:${text.length > 40 ? `${text.slice(0, 40)}…` : text}`],
      notes: [],
    };
  }
  return {
    method,
    steps: [
      { bin: 'pbcopy', args: [], input: text },
      { bin: 'osascript', args: ['-e', pasteScript()] },
    ],
    commands: ['pbcopy <<< <text>', 'osascript -e \'tell application "System Events" to keystroke "v" using command down\''],
    notes: [],
  };
}

/**
 * 按键计划。
 * @param {{key:string,repeat?:number}} options
 */
export function planKey(options) {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error('repeat 必须是 1..50 的整数');
  const script = keyScript(options.key);
  const steps = Array.from({ length: repeat }, () => ({ bin: 'osascript', args: ['-e', script] }));
  return {
    key: options.key,
    repeat,
    steps,
    commands: Array.from({ length: repeat }, () => `osascript -e '${script}'`),
    notes: [],
  };
}

/**
 * 滚动计划（滚轮事件由 pyobjc 投递，指针先移到目标位置）。
 * @param {{x?:number,y?:number,scrollY:number,scrollX?:number,unit?:'line'|'pixel'}} options
 */
export function planScroll(options) {
  const scrollY = options.scrollY ?? 0;
  const scrollX = options.scrollX ?? 0;
  if (!Number.isInteger(scrollY) || !Number.isInteger(scrollX)) throw new Error('scrollY / scrollX 必须是整数');
  if (scrollY === 0 && scrollX === 0) throw new Error('scrollY 与 scrollX 不能同时为 0');
  const unit = options.unit ?? 'line';
  if (unit !== 'line' && unit !== 'pixel') throw new Error('unit 只能是 line 或 pixel');
  const steps = [];
  const commands = [];
  if (options.x !== undefined && options.y !== undefined) {
    const point = assertPoint({ x: options.x, y: options.y }, 'scroll');
    steps.push({ bin: 'cliclick', args: [`m:${point.x},${point.y}`] });
    commands.push(`cliclick m:${point.x},${point.y}`);
  }
  const magnitude = Math.max(Math.abs(scrollY), Math.abs(scrollX));
  const batches = Math.max(1, Math.min(12, Math.ceil(magnitude / 10)));
  const perY = Math.trunc(scrollY / batches) || (scrollY > 0 ? 1 : scrollY < 0 ? -1 : 0);
  const perX = Math.trunc(scrollX / batches) || (scrollX > 0 ? 1 : scrollX < 0 ? -1 : 0);
  steps.push({
    bin: 'pyobjc-scroll',
    args: [],
    scroll: { dy: -perY, dx: -perX, steps: batches, unit, delayMs: 12 },
  });
  commands.push(`pyobjc CGEventPost(scroll dy=${-perY} dx=${-perX} × ${batches} ${unit})`);
  return { steps, commands, notes: ['scrollY 正数表示向下浏览内容，scrollX 正数表示向右'] };
}
