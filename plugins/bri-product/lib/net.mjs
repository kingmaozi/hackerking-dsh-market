/**
 * 网络出口白名单。
 *
 * 插件只会访问：
 * - ai.bri-king.com（产品库与图床）
 * - *.bri-king.com（未来子域）
 * - *.myqcloud.com（腾讯云 COS 图床）
 * - 本机 127.0.0.1 / localhost（开发回退）
 *
 * 需要新增图床时设置 BRI_PRODUCT_LIBRARY_ALLOWED_HOSTS（逗号分隔，支持 .example.com 后缀）。
 */

const DEFAULT_RULES = [
  'ai.bri-king.com',
  '.bri-king.com',
  '.myqcloud.com',
  '127.0.0.1',
  'localhost',
  '::1',
];

function rules() {
  const extra = String(process.env.BRI_PRODUCT_LIBRARY_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_RULES, ...extra];
}

function hostMatches(hostname, rule) {
  const host = hostname.toLowerCase();
  if (rule.startsWith('.')) {
    const suffix = rule.slice(1);
    return host === suffix || host.endsWith(rule);
  }
  return host === rule;
}

export function isAllowedUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return rules().some((rule) => hostMatches(url.hostname, rule));
  } catch {
    return false;
  }
}

export function assertAllowedUrl(value, label = 'URL') {
  if (!isAllowedUrl(value)) {
    let host = '(无法解析)';
    try {
      host = new URL(String(value)).hostname;
    } catch {}
    throw new Error(
      `${label} 不在允许的域名列表内：${host}。如确需访问，请设置 BRI_PRODUCT_LIBRARY_ALLOWED_HOSTS 扩展白名单。`,
    );
  }
  return String(value);
}

export function allowedHosts() {
  return rules();
}
