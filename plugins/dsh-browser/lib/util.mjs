/**
 * 纯函数工具：URL 校验、CDP 回环地址校验、DevTools banner 解析、文本裁剪。
 * 这些函数不碰网络和文件系统，方便单元测试。
 */

/** 逗号/冒号分隔的扩展目录列表 → 绝对路径数组（去空、去重、保序）。 */
export function splitList(value, separator = ':') {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(separator);
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const trimmed = String(item).trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** 从 Chrome stderr 里解析 `DevTools listening on ws://…`。 */
export function parseDevToolsBanner(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(text);
  return match === null ? undefined : match[1];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * CDP WebSocket 只允许回环地址：本插件不连接任何远程调试端点。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkLoopbackWsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { ok: false, reason: `协议必须是 ws/wss，实际是 ${parsed.protocol}` };
  }
  if (parsed.protocol === 'wss:') {
    return { ok: false, reason: '拒绝 wss://：本插件只连本机明文 CDP（127.0.0.1）' };
  }
  const host = parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '');
  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: `只允许连接回环地址（127.0.0.1 / localhost / ::1），实际是 ${host}` };
  }
  return { ok: true };
}

export function formatHttpError(status, body) {
  const snippet = String(body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200);
  return `HTTP ${status}${snippet === '' ? '' : `：${snippet}`}`;
}

/** 允许导航的协议白名单：不执行 javascript:，不打开 chrome:// 内部页。 */
const NAVIGATION_SCHEMES = new Set(['http:', 'https:', 'data:', 'file:', 'about:']);

/**
 * 规范化导航 URL：没有协议时补 https://；拒绝 javascript:/chrome: 等。
 * @returns {string} 可直接交给 Page.navigate 的 URL
 */
export function normalizeNavigationUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('url 不能为空');
  }
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`url 不是合法 URL：${raw}`);
    }
    if (!NAVIGATION_SCHEMES.has(parsed.protocol)) {
      throw new Error(`不允许导航到 ${parsed.protocol} 页面（只支持 http/https/file/data/about:）`);
    }
    // data: 的负载必须原样交给 Chrome：URL 序列化会把非 ASCII 字符百分号编码，
    // 页面再按 UTF-8 解码就会变成乱码（实测中文标题）。
    if (parsed.protocol === 'data:') return raw;
    return parsed.href;
  }
  // 裸域名/路径 → https
  return `https://${raw}`;
}

/** 文本裁剪，追加中文省略提示。 */
export function truncate(text, maxChars, note = '…（已截断）') {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}${note}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function clampInt(value, fallback, min, max) {
  return positiveInt(value, fallback, { min, max });
}

export function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/** `2026-10-31T19:02:25.123Z` → `20261031-190225-123`（文件名安全）。 */
export function timestampSlug(date = new Date()) {
  const iso = date.toISOString(); // 2026-10-31T19:02:25.123Z
  const [day, time] = iso.split('T');
  const compactTime = time.replaceAll(':', '').replace('Z', '').replace('.', '-');
  return `${day.replaceAll('-', '')}-${compactTime}`;
}

const REF_PATTERN = /^e\d{1,5}$/u;

export function isElementRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

/** Chrome 可执行文件不存在等错误的统一中文包装。 */
export function describeSpawnError(error, chromePath) {
  const code = error?.code;
  if (code === 'ENOENT') {
    return `找不到 Chrome 可执行文件：${chromePath}。请安装 Google Chrome，或用 BROWSER_CHROME_PATH 指到 Chrome 二进制（macOS 示例：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome）。`;
  }
  if (code === 'EACCES') {
    return `没有权限执行 Chrome：${chromePath}`;
  }
  return `启动 Chrome 失败（${chromePath}）：${error?.message ?? error}`;
}

export const __internal = { REF_PATTERN, LOOPBACK_HOSTS, NAVIGATION_SCHEMES };
