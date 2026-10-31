/**
 * 纯函数工具：URL 校验、回环地址校验、数值/布尔参数、文本裁剪、Chrome 路径。
 * 不碰浏览器与网络，便于单元测试。
 */

/** 逗号/冒号分隔的列表 → 去空、去重、保序的数组。 */
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * attach 模式的 CDP 端点只允许回环 HTTP。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkLoopbackHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: `只允许 http:// 回环端点，实际是 ${parsed.protocol}` };
  }
  const host = parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '');
  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: `只允许连接回环地址（127.0.0.1 / localhost / ::1），实际是 ${host}` };
  }
  return { ok: true };
}

/** 允许导航的协议白名单。 */
const NAVIGATION_SCHEMES = new Set(['http:', 'https:', 'data:', 'file:', 'about:']);

/**
 * 规范化导航 URL：没有协议时补 https://；拒绝 javascript:/chrome:；
 * data: 保持原文（URL 序列化会百分号编码非 ASCII，导致页面乱码）。
 */
export function normalizeNavigationUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('url 不能为空');
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
    if (parsed.protocol === 'data:') return raw;
    return parsed.href;
  }
  return `https://${raw}`;
}

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
  const iso = date.toISOString();
  const [day, time] = iso.split('T');
  const compactTime = time.replaceAll(':', '').replace('Z', '').replace('.', '-');
  return `${day.replaceAll('-', '')}-${compactTime}`;
}

const REF_PATTERN = /^e\d{1,5}$/u;

export function isElementRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

/** 从 PNG IHDR 读宽高；不是 PNG 返回 undefined。 */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** PLAYWRIGHT_CHROME_PATH 优先，其次 BROWSER_CHROME_PATH。 */
export function chromePathOverride(env = process.env) {
  for (const key of ['PLAYWRIGHT_CHROME_PATH', 'BROWSER_CHROME_PATH']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 默认的 Chrome 候选路径（用于 status / --check 诊断，不用于启动）。 */
export function chromeCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

export const __internal = { REF_PATTERN, LOOPBACK_HOSTS, NAVIGATION_SCHEMES };
