/**
 * 系统层：二进制发现、子进程执行、屏幕/权限探测。
 *
 * 后端全部使用 macOS 自带或本机已验证存在的组件，不引入任何第三方二进制：
 *   - 截屏：/usr/sbin/screencapture（系统自带）
 *   - 缩放：/usr/bin/sips（系统自带）
 *   - 指针/文本：cliclick（Homebrew，本机 5.1 已装）
 *   - 键位组合/粘贴：/usr/bin/osascript + System Events（系统自带）
 *   - 滚动/窗口枚举/权限探针：python3 + pyobjc（本机 miniforge 3.13 已验证可 import Quartz）
 *
 * 不用 Swift helper：本机 CLT 26.3（Swift 6.2.4）与 SDK 26.2 不匹配，swiftc 编译
 * 直接失败（详见 plugins/rea/README.md 同一坑位），所以主路径避开编译型 helper。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export const PLATFORM = process.platform;
export const IS_MAC = PLATFORM === 'darwin';

/** 固定的系统二进制候选（先查绝对路径，再回落 PATH）。 */
export const SYSTEM_BINARIES = {
  screencapture: ['/usr/sbin/screencapture', '/usr/bin/screencapture'],
  sips: ['/usr/bin/sips'],
  osascript: ['/usr/bin/osascript'],
  pbcopy: ['/usr/bin/pbcopy'],
  pbpaste: ['/usr/bin/pbpaste'],
  cliclick: ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick', '/usr/bin/cliclick'],
  python3: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'],
};

/** 是否为可执行文件。 */
export function isExecutable(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在候选列表与 PATH 中定位可执行文件。 */
export function which(name, extra = []) {
  const fromPath = typeof process.env.PATH === 'string'
    ? process.env.PATH.split(delimiter).filter(Boolean).map((dir) => join(dir, name))
    : [];
  for (const candidate of [...extra, ...fromPath]) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** 按名字解析二进制：显式配置 > 系统固定路径 > PATH。 */
export function resolveBinary(name, configured) {
  if (isExecutable(configured)) return configured;
  return which(name, SYSTEM_BINARIES[name] ?? []);
}

/**
 * 执行一个子进程并收敛成结构化结果（不抛异常，错误由调用方判定）。
 * @param {string} file 可执行文件绝对路径
 * @param {string[]} args 参数数组（不经过 shell，无注入面）
 * @param {{input?:string, timeoutMs?:number, signal?:AbortSignal, env?:Record<string,string>, maxBuffer?:number}} [options]
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, error?:Error}>}
 */
export function run(file, args, options = {}) {
  const { input, timeoutMs = 20000, signal, env, maxBuffer = 8 * 1024 * 1024 } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env === undefined ? process.env : { ...process.env, ...env },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false, error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let finished = false;
    let timedOut = false;

    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const onAbort = () => kill();
    if (signal !== undefined) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

    const finish = (code, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, ...extra });
    };

    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { kill(); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { kill(); return; }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(-1, { error }));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));

    try {
      if (input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    } catch { /* stdin 已关闭 */ }
  });
}

/** 读取 PNG 尺寸（只解析 IHDR，不依赖图像库）。 */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined;
  if (buffer[0] !== 0x89 || buffer.toString('latin1', 1, 4) !== 'PNG') return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** python3 + pyobjc 探针：滚动、窗口枚举、权限状态都走这里。 */
const PY_STATUS = String.raw`
import json, sys
import Quartz
import ApplicationServices as AS

main = Quartz.CGMainDisplayID()
ids = list(Quartz.CGGetActiveDisplayList(32, None, None)[1])
displays = []
for d in ids:
    b = Quartz.CGDisplayBounds(d)
    mode = Quartz.CGDisplayCopyDisplayMode(d)
    pw = Quartz.CGDisplayModeGetPixelWidth(mode) if mode else 0
    ph = Quartz.CGDisplayModeGetPixelHeight(mode) if mode else 0
    w = float(b.size.width)
    displays.append({
        "id": int(d),
        "main": bool(d == main),
        "x": float(b.origin.x),
        "y": float(b.origin.y),
        "width": w,
        "height": float(b.size.height),
        "pixelWidth": int(pw),
        "pixelHeight": int(ph),
        "scale": (float(pw) / w) if pw and w else 1.0,
    })
displays.sort(key=lambda item: (not item["main"], item["x"]))
print(json.dumps({
    "accessibility": bool(AS.AXIsProcessTrusted()),
    "screenRecording": bool(Quartz.CGPreflightScreenCaptureAccess()),
    "displays": displays,
}))
`;

const PY_WINDOWS = String.raw`
import json, sys
import Quartz

req = json.load(sys.stdin) if not sys.stdin.isatty() else {}
limit = int(req.get("limit") or 40)
options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
raw = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []
items = []
for w in raw:
    d = dict(w)
    b = d.get("kCGWindowBounds") or {}
    width = float(b.get("Width") or 0)
    height = float(b.get("Height") or 0)
    layer = int(d.get("kCGWindowLayer") or 0)
    if width <= 0 or height <= 0:
        continue
    items.append({
        "owner": str(d.get("kCGWindowOwnerName") or ""),
        "title": str(d.get("kCGWindowName") or ""),
        "pid": int(d.get("kCGWindowOwnerPID") or 0),
        "layer": layer,
        "x": float(b.get("X") or 0),
        "y": float(b.get("Y") or 0),
        "width": width,
        "height": height,
    })
items.sort(key=lambda item: (item["layer"], -(item["width"] * item["height"])))
print(json.dumps({"windows": items[:limit], "total": len(items)}))
`;

const PY_SCROLL = String.raw`
import json, sys, time
import Quartz

req = json.load(sys.stdin) if not sys.stdin.isatty() else {}
dy = int(req.get("dy") or 0)
dx = int(req.get("dx") or 0)
steps = max(1, min(80, int(req.get("steps") or 1)))
delay = max(0.0, float(req.get("delayMs") or 0)) / 1000.0
unit = Quartz.kCGScrollEventUnitPixel if req.get("unit") == "pixel" else Quartz.kCGScrollEventUnitLine
for i in range(steps):
    ev = Quartz.CGEventCreateScrollWheelEvent(None, unit, 2, dy, dx)
    if ev is None:
        raise SystemExit("CGEventCreateScrollWheelEvent returned None")
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
    if delay:
        time.sleep(delay)
print(json.dumps({"ok": True, "steps": steps, "dy": dy, "dx": dx}))
`;

/** python 解释器探测结果缓存（键为解释器路径）。 */
const pythonCache = new Map();

/**
 * 找到一个能 import Quartz 的 python3。
 * @param {{pythonPath?:string}} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<{path:string|undefined, pyobjc:boolean, reason?:string}>}
 */
export async function pythonInfo(config, signal) {
  const candidates = [
    config?.pythonPath,
    process.env.CUA_PYTHON3,
    ...SYSTEM_BINARIES.python3,
    which('python3'),
  ].filter((value) => typeof value === 'string' && value.length > 0);

  let firstUsable;
  for (const candidate of [...new Set(candidates)]) {
    if (!isExecutable(candidate)) continue;
    if (pythonCache.has(candidate)) {
      const cached = pythonCache.get(candidate);
      if (cached.pyobjc) return cached;
      firstUsable ??= cached;
      continue;
    }
    const result = await run(candidate, ['-c', 'import Quartz, ApplicationServices; print("pyobjc-ok")'], {
      timeoutMs: 15000,
      signal,
    });
    const info = {
      path: candidate,
      pyobjc: result.code === 0 && result.stdout.includes('pyobjc-ok'),
      reason: result.code === 0 ? undefined : (result.stderr.trim().split('\n').pop() ?? ''),
    };
    pythonCache.set(candidate, info);
    if (info.pyobjc) return info;
    firstUsable ??= info;
  }
  return firstUsable ?? { path: undefined, pyobjc: false, reason: '没有找到可用的 python3' };
}

/**
 * 屏幕与 TCC 权限状态。
 * @returns {Promise<{accessibility:boolean|undefined, screenRecording:boolean|undefined, displays:Array<object>, probe:'pyobjc'|'none', reason?:string}>}
 */
export async function probeSystem(config, signal) {
  const python = await pythonInfo(config, signal);
  if (!python.pyobjc) {
    return {
      accessibility: undefined,
      screenRecording: undefined,
      displays: [],
      probe: 'none',
      reason: python.reason ?? 'python3 缺少 pyobjc',
    };
  }
  const result = await run(python.path, ['-c', PY_STATUS], { timeoutMs: 15000, signal });
  if (result.code !== 0) {
    return {
      accessibility: undefined,
      screenRecording: undefined,
      displays: [],
      probe: 'none',
      reason: result.stderr.trim().split('\n').pop() ?? 'python 状态探针失败',
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    return { ...parsed, probe: 'pyobjc' };
  } catch (error) {
    return {
      accessibility: undefined,
      screenRecording: undefined,
      displays: [],
      probe: 'none',
      reason: `状态探针输出无法解析：${error?.message ?? error}`,
    };
  }
}

/** 枚举屏幕上的窗口（layer 0 通常是普通窗口；标题需要屏幕录制授权才有值）。 */
export async function listWindows(config, options, signal) {
  const python = await pythonInfo(config, signal);
  if (!python.pyobjc) {
    throw new Error(`窗口枚举需要 python3 + pyobjc（${python.reason ?? '未找到'}）。安装：python3 -m pip install --user pyobjc-framework-Quartz`);
  }
  const result = await run(python.path, ['-c', PY_WINDOWS], {
    input: JSON.stringify({ limit: options?.limit ?? 40 }),
    timeoutMs: 20000,
    signal,
  });
  if (result.code !== 0) {
    throw new Error(`窗口枚举失败：${result.stderr.trim().split('\n').pop() ?? `exit=${result.code}`}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

/** 投递滚轮事件（单位：线或像素）。 */
export async function postScroll(config, options, signal) {
  const python = await pythonInfo(config, signal);
  if (!python.pyobjc) {
    throw new Error(`滚动需要 python3 + pyobjc（${python.reason ?? '未找到'}）。安装：python3 -m pip install --user pyobjc-framework-Quartz`);
  }
  const result = await run(python.path, ['-c', PY_SCROLL], {
    input: JSON.stringify(options),
    timeoutMs: 20000,
    signal,
  });
  if (result.code !== 0) {
    throw new Error(`滚动失败：${result.stderr.trim().split('\n').pop() ?? `exit=${result.code}`}`);
  }
}
