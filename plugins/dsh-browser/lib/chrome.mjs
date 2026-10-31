/**
 * Chrome 发现、命令行拼装、profile 内扩展清单扫描。
 * 不读 Cookie / Login Data / 凭据文件；只读 manifest 与 Preferences 里的扩展元数据。
 */
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** macOS 上的常见 Chrome/Chromium/Edge 位置，按优先级排列。 */
export const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

/** Linux 上的常见位置。 */
export const LINUX_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

/** PATH 里按名字查找的二进制名。 */
export const CHROME_BIN_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
];

async function defaultExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 收集所有候选（给错误信息与 --check 用），不判存在。 */
export function chromeCandidates({ override, pathDirs } = {}) {
  const dirs = pathDirs ?? String(process.env.PATH ?? '').split(':').filter(Boolean);
  const candidates = [];
  if (override) candidates.push({ path: override, source: 'BROWSER_CHROME_PATH' });
  for (const path of MAC_CHROME_PATHS) candidates.push({ path, source: 'macOS 默认位置' });
  for (const path of LINUX_CHROME_PATHS) candidates.push({ path, source: 'Linux 默认位置' });
  for (const dir of dirs) {
    for (const name of CHROME_BIN_NAMES) candidates.push({ path: join(dir, name), source: 'PATH' });
  }
  return candidates;
}

/**
 * 按 BROWSER_CHROME_PATH → macOS → Linux → PATH 的顺序找 Chrome。
 * @returns {Promise<{path: string, source: string}>}
 */
export async function findChromePath({ override, exists = defaultExecutable, pathDirs } = {}) {
  const candidates = chromeCandidates({ override, pathDirs });
  for (const candidate of candidates) {
    if (await exists(candidate.path)) return candidate;
  }
  const tried = candidates.slice(0, 12).map((candidate) => `  ${candidate.path}（${candidate.source}）`).join('\n');
  throw new Error(
    `找不到 Chrome/Chromium/Edge 可执行文件。已尝试：\n${tried}\n` +
      '请安装 Google Chrome，或用环境变量 BROWSER_CHROME_PATH 指向 Chrome 二进制。',
  );
}

/**
 * 拼 Chrome 启动参数。
 * headless 用 `--headless=new`；chrome 模式不加 headless 开可见窗口；
 * 扩展只在 chrome 模式加载（headless 模式忽略扩展目录）。
 */
export function buildChromeArgs({
  mode = 'headless',
  profileDir,
  port = 0,
  extensions = [],
  windowSize = '1440,900',
  extraArgs = [],
} = {}) {
  if (typeof profileDir !== 'string' || profileDir === '') throw new Error('buildChromeArgs 需要 profileDir');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`非法调试端口：${port}`);
  const args = [];
  if (mode === 'headless') args.push('--headless=new');
  args.push(
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${windowSize}`,
    '--disable-features=Translate,MediaRouter',
  );
  const extensionDirs = (extensions ?? []).filter((dir) => typeof dir === 'string' && dir !== '');
  if (extensionDirs.length > 0) {
    const joined = extensionDirs.join(',');
    args.push(`--load-extension=${joined}`, `--disable-extensions-except=${joined}`);
  }
  args.push(...extraArgs, 'about:blank');
  return args;
}

/** Chrome 的扩展安装位置枚举（Manifest::Location）。 */
const COMPONENT_LOCATIONS = new Set([1, 5, 10]);
const LOCATION_LABELS = {
  1: '内置',
  2: '外部配置',
  3: '注册表',
  4: '解包',
  5: '组件',
  6: '外部下载',
  7: '策略下载',
  8: '命令行',
  9: '策略',
  10: '外部组件',
};

/** 从 manifest/_locales 解析 `__MSG_xxx__` 形式的名称。 */
export async function resolveLocalizedName(name, extensionDir, defaultLocale) {
  if (typeof name !== 'string' || !name.startsWith('__MSG_')) return name;
  const key = name.slice(6, -2);
  const locales = [defaultLocale, 'en', 'zh_CN', 'zh'].filter((item) => typeof item === 'string' && item !== '');
  for (const locale of locales) {
    const path = join(extensionDir, '_locales', locale, 'messages.json');
    try {
      const messages = JSON.parse(await readFile(path, 'utf8'));
      const entry = messages?.[key];
      if (typeof entry === 'string') return entry;
      if (typeof entry?.message === 'string') return entry.message;
    } catch {
      // 继续尝试下一个 locale
    }
  }
  return name;
}

/** 列出 profile 下真实存在的浏览器配置目录（Default / Profile 1 …）。 */
export async function listProfileSubdirs(profileDir) {
  let entries;
  try {
    entries = await readdir(profileDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/u.test(name))
    .sort((left, right) => (left === 'Default' ? -1 : right === 'Default' ? 1 : left.localeCompare(right)));
  return names;
}

async function readExtensionManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const extensionDir = join(manifestPath, '..');
  const name = await resolveLocalizedName(String(manifest.name ?? ''), extensionDir, manifest.default_locale);
  return {
    name,
    version: String(manifest.version ?? ''),
    manifestVersion: manifest.manifest_version,
    defaultLocale: manifest.default_locale,
    extensionDir,
  };
}

async function scanPackedExtensions(profileSubdirPath, extensions, seen) {
  const root = join(profileSubdirPath, 'Extensions');
  let ids;
  try {
    ids = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const idEntry of ids) {
    if (!idEntry.isDirectory()) continue;
    const id = idEntry.name;
    if (seen.has(id)) continue;
    const idPath = join(root, id);
    let versions;
    try {
      versions = await readdir(idPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory()) continue;
      const manifestPath = join(idPath, versionEntry.name, 'manifest.json');
      try {
        const info = await stat(manifestPath);
        if (!info.isFile()) continue;
        const manifest = await readExtensionManifest(manifestPath);
        seen.add(id);
        extensions.push({
          id,
          name: manifest.name,
          version: manifest.version || versionEntry.name,
          location: null,
          locationLabel: '打包',
          unpacked: false,
          path: join(idPath, versionEntry.name),
          profile: profileSubdirPath,
        });
        break;
      } catch {
        // 跳过损坏的 manifest
      }
    }
  }
}

/** 读取 Preferences 里的 extensions.settings，补充解包/外部扩展信息。 */
async function scanPreferencesExtensions(profileSubdirPath, extensions, seen) {
  const preferencesPath = join(profileSubdirPath, 'Preferences');
  let preferences;
  try {
    preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
  } catch {
    return;
  }
  const settings = preferences?.extensions?.settings;
  if (settings === null || typeof settings !== 'object') return;
  for (const [id, item] of Object.entries(settings)) {
    if (item === null || typeof item !== 'object' || seen.has(id)) continue;
    const locationRaw = Number(item.location);
    const location = Number.isInteger(locationRaw) ? locationRaw : null;
    const manifest = item.manifest ?? {};
    const extensionPath = typeof item.path === 'string' && item.path !== '' ? item.path : '';
    let name = String(manifest.name ?? '');
    if (name.startsWith('__MSG_') && extensionPath !== '') {
      name = await resolveLocalizedName(name, extensionPath, manifest.default_locale);
    }
    const entry = {
      id,
      name: name === '' ? '(未命名)' : name,
      version: String(manifest.version ?? ''),
      location,
      locationLabel: location === null ? '未知' : (LOCATION_LABELS[location] ?? `location ${location}`),
      unpacked: location === 4 || (extensionPath !== '' && location === 8),
      path: extensionPath,
      profile: profileSubdirPath,
      state: Number.isInteger(Number(item.state)) ? Number(item.state) : undefined,
      fromWebstore: item.from_webstore === true,
      component: location !== null && COMPONENT_LOCATIONS.has(location),
    };
    seen.add(id);
    extensions.push(entry);
  }
}

/**
 * 扫描 profile 里的扩展（只读清单，不执行扩展代码）。
 * @returns {Promise<{profileDir: string, profileSubdir: string|undefined, extensions: Array, scanned: boolean}>}
 */
export async function loadExtensionsFromProfile(profileDir, { includeComponent = false } = {}) {
  const subdirs = await listProfileSubdirs(profileDir);
  if (subdirs.length === 0) {
    return { profileDir, profileSubdir: undefined, extensions: [], scanned: false };
  }
  const profileSubdir = subdirs.includes('Default') ? 'Default' : subdirs[0];
  const profileSubdirPath = join(profileDir, profileSubdir);
  const extensions = [];
  const seen = new Set();
  await scanPackedExtensions(profileSubdirPath, extensions, seen);
  await scanPreferencesExtensions(profileSubdirPath, extensions, seen);
  for (const entry of extensions) {
    if (entry.component === undefined) entry.component = entry.location !== null && COMPONENT_LOCATIONS.has(entry.location);
  }
  const filtered = includeComponent ? extensions : extensions.filter((entry) => entry.component !== true);
  filtered.sort((left, right) => left.name.localeCompare(right.name));
  return { profileDir, profileSubdir, extensions: filtered, allCount: extensions.length, scanned: true };
}


/**
 * 计算解包扩展的 Chrome 扩展 ID：对真实路径（realpath）做 SHA-256，
 * 取前 32 个十六进制字符，每个 0-f 映射到 a-p。
 * 实测 Chrome for Testing 148 加载 /tmp/dsh-test-ext（softlink 到 /private/tmp）时，
 * 运行中的 service_worker target id 与 /private/tmp/dsh-test-ext 的计算值一致。
 */
export async function extensionIdForPath(extensionDir) {
  let target = extensionDir;
  try {
    target = await realpath(extensionDir);
  } catch {
    // 路径不可解析时退回原值
  }
  const hex = createHash('sha256').update(target).digest('hex').slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

/** 从 Target.getTargets 结果里提取运行中的扩展（service_worker / background_page / 扩展页面）。 */
export function runningExtensionTargets(targetInfos = []) {
  const map = new Map();
  for (const target of targetInfos) {
    const match = /^chrome-extension:\/\/([a-p]{32})\//u.exec(String(target.url ?? ''));
    if (match === null) continue;
    const id = match[1];
    const current = map.get(id) ?? { id, types: [] };
    current.types.push(target.type);
    map.set(id, current);
  }
  return [...map.values()];
}

export { COMPONENT_LOCATIONS, LOCATION_LABELS };
