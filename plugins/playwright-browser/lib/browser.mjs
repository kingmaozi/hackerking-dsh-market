/**
 * Playwright 内核浏览器管理器：headless / headed / attach 三种模式。
 *
 * 运行依赖只有 playwright-core（不下载浏览器），默认 channel: 'chrome'
 * 调用系统 Google Chrome；可用 PLAYWRIGHT_CHROME_PATH / BROWSER_CHROME_PATH 覆盖。
 *
 * 安全边界：
 *   - attach 只连 127.0.0.1 的 CDP；
 *   - 不读 cookie / 凭据文件（headed 持久 profile 由 Chrome 自己管理）；
 *   - headless 用 Playwright 内部临时 profile，不碰用户日常 Chrome；
 *   - 只关闭自己启动的浏览器；attach 只断开连接。
 */
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { snapshotExpression } from './dom.mjs';
import {
  JPEG_SIGNATURE,
  PNG_SIGNATURE,
  booleanFlag,
  checkLoopbackHttpUrl,
  chromeCandidates,
  chromePathOverride,
  clampInt,
  formatBytes,
  isElementRef,
  normalizeNavigationUrl,
  pngDimensions,
  positiveInt,
  timestampSlug,
  truncate,
} from './util.mjs';

const PKG = 'playwright-browser';
const MODES = ['headless', 'headed', 'attach'];
const MODE_ALIASES = {
  headless: 'headless',
  无头: 'headless',
  headed: 'headed',
  chrome: 'headed',
  visible: 'headed',
  有头: 'headed',
  可见: 'headed',
  attach: 'attach',
  连接: 'attach',
};

function log(message) {
  // stdout 属于 JSON-RPC，日志只能进 stderr。
  process.stderr.write(`[${PKG}] ${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function normalizeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const mode = MODE_ALIASES[raw] ?? raw;
  if (!MODES.includes(mode)) throw new Error(`未知模式：${value}（只支持 headless / headed / attach）`);
  return mode;
}

function timeoutOf(value, fallback) {
  return positiveInt(value, fallback, { min: 1000, max: 300000 });
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolvePromise, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isPlaywrightTimeout(error) {
  return error?.name === 'TimeoutError' || /Timeout \d+ms exceeded/u.test(String(error?.message ?? ''));
}

function describePlaywrightError(error, contextText) {
  if (isPlaywrightTimeout(error)) {
    return `${contextText}超时：${error.message}。请确认元素在页面上且可操作；页面变化后重新 browser_snapshot。`;
  }
  const message = String(error?.message ?? error);
  return `${contextText}失败：${message.split('\n').slice(0, 3).join(' ')}`;
}

const require = createRequire(import.meta.url);

let chromiumPromise;
async function loadChromium() {
  if (chromiumPromise === undefined) {
    chromiumPromise = import('playwright-core')
      .then((module) => module.chromium)
      .catch((error) => {
        chromiumPromise = undefined;
        throw new Error(
          `无法加载 playwright-core：${error?.message ?? error}。` +
            '请确认 DSH 安装插件时依赖已成功安装（本插件不下载浏览器，默认使用系统 Google Chrome）。',
        );
      });
  }
  return chromiumPromise;
}

function playwrightCoreInfo() {
  try {
    const path = require.resolve('playwright-core/package.json');
    const manifest = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    return { installed: true, version: manifest.version, path };
  } catch (error) {
    return { installed: false, error: error?.message ?? String(error) };
  }
}

export class PlaywrightBrowserManager {
  constructor(options = {}) {
    this.home = options.home ?? process.env.PLAYWRIGHT_BROWSER_HOME ?? join(homedir(), '.dsh', 'playwright-browser');
    this.shotsDir = options.shotsDir ?? join(this.home, 'shots');
    this.defaultHeadless = booleanFlag(
      options.headless ?? process.env.PLAYWRIGHT_HEADLESS,
      true,
    );
    this.chromeOverride = options.chromePath ?? chromePathOverride();
    this.profileDir = resolve(options.profileDir ?? process.env.PLAYWRIGHT_PROFILE_DIR ?? join(this.home, 'profile'));
    this.attachPort = positiveInt(options.attachPort ?? process.env.PLAYWRIGHT_ATTACH_PORT, 9222, { min: 1, max: 65535 });
    this.timeoutMs = positiveInt(options.timeoutMs ?? process.env.PLAYWRIGHT_TIMEOUT_MS, 30000, { min: 1000, max: 600000 });
    this.launchTimeoutMs = positiveInt(
      options.launchTimeoutMs ?? process.env.PLAYWRIGHT_LAUNCH_TIMEOUT_MS,
      30000,
      { min: 3000, max: 120000 },
    );
    const viewport = String(options.viewport ?? process.env.PLAYWRIGHT_VIEWPORT ?? '1440x900');
    const [width, height] = viewport.split(/[x,]/u).map((value) => positiveInt(value, 0, { min: 200, max: 8000 }));
    this.viewport = { width: width || 1440, height: height || 900 };

    this.state = {
      mode: null,
      browser: null,
      context: null,
      page: null,
      owned: false,
      chromePath: null,
      chromeSource: null,
      browserVersion: null,
      playwrightVersion: null,
      profileDir: null,
      startedAt: null,
      closing: false,
    };
    this._launching = null;
    this._pageIds = new Map();
    this._pageSeq = 0;
  }

  isRunning() {
    const browser = this.state.browser;
    if (browser === null) return false;
    try {
      if (!browser.isConnected()) return false;
    } catch {
      return false;
    }
    const context = this.state.context;
    if (context !== null) {
      try {
        if (context.isClosed()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  configSummary() {
    return {
      defaultHeadless: this.defaultHeadless,
      defaultMode: this.defaultHeadless ? 'headless' : 'headed',
      profileDir: this.profileDir,
      attachPort: this.attachPort,
      home: this.home,
      shotsDir: this.shotsDir,
      timeoutMs: this.timeoutMs,
      viewport: this.viewport,
      chromeOverride: this.chromeOverride ?? null,
      dependency: playwrightCoreInfo(),
    };
  }

  async _systemChromeInfo() {
    if (this.chromeOverride !== undefined) {
      try {
        await access(this.chromeOverride, fsConstants.X_OK);
        return { found: true, path: this.chromeOverride, source: 'PLAYWRIGHT_CHROME_PATH / BROWSER_CHROME_PATH' };
      } catch {
        return { found: false, path: this.chromeOverride, source: 'env', error: `指定的 Chrome 不可执行：${this.chromeOverride}` };
      }
    }
    for (const candidate of chromeCandidates()) {
      try {
        await access(candidate, fsConstants.X_OK);
        return { found: true, path: candidate, source: '系统默认位置' };
      } catch {
        // 继续
      }
    }
    return {
      found: false,
      source: '未找到',
      error: '没有在默认位置找到 Chrome；Playwright 的 channel:"chrome" 需要系统已安装 Google Chrome。可设置 PLAYWRIGHT_CHROME_PATH。',
    };
  }

  async status() {
    const config = this.configSummary();
    const chrome = await this._systemChromeInfo();
    const running = this.isRunning();
    let page = null;
    let pages = 0;
    if (running) {
      page = await this._pageInfoSafe();
      try {
        pages = this.state.context.pages().filter((item) => !item.isClosed()).length;
      } catch {
        pages = 0;
      }
    }
    return {
      running,
      mode: this.state.mode,
      owned: this.state.owned,
      autoLaunched: false,
      browserVersion: this.state.browserVersion,
      playwrightVersion: this.state.playwrightVersion ?? config.dependency.version,
      dependency: config.dependency,
      chrome,
      chromePath: this.state.chromePath ?? (chrome.found ? chrome.path : null),
      profileDir: this.state.profileDir ?? config.profileDir,
      shotsDir: config.shotsDir,
      startedAt: this.state.startedAt,
      page,
      pageCount: pages,
      config,
    };
  }

  async launch(params = {}) {
    let mode;
    if (params.mode !== undefined && params.mode !== null && String(params.mode).trim() !== '') {
      mode = normalizeMode(params.mode);
    } else if (params.headless !== undefined) {
      mode = booleanFlag(params.headless, this.defaultHeadless) ? 'headless' : 'headed';
    } else {
      mode = this.defaultHeadless ? 'headless' : 'headed';
    }
    for (const key of Object.keys(params)) {
      if (['mode', 'headless', 'chrome_path', 'attach_port', 'port', 'profile_dir', 'force', 'timeout_ms', 'extensions'].includes(key)) continue;
      // 未知参数不阻塞，但记日志
      log(`忽略未知 launch 参数：${key}`);
    }
    if (this.isRunning() && this.state.mode === mode && params.force !== true) {
      return { ...(await this.status()), alreadyRunning: true, autoLaunched: false };
    }
    if (this.isRunning()) await this.close();
    if (this._launching !== null) return this._launching;
    this._launching = this._launch(mode, params).finally(() => {
      this._launching = null;
    });
    return this._launching;
  }

  async ensure() {
    if (this.isRunning()) {
      return { launched: false, page: await this._alivePage() };
    }
    const result = await this.launch({});
    return { launched: true, page: await this._alivePage(), mode: result.mode };
  }

  async _alivePage() {
    const page = this.state.page;
    if (page !== null && !page.isClosed()) return page;
    const context = this.state.context;
    if (context === null || context.isClosed()) throw new Error('浏览器 context 已关闭，请重新 browser_launch');
    const pages = context.pages().filter((item) => !item.isClosed());
    const next = pages[0] ?? (await context.newPage());
    this.state.page = next;
    return next;
  }

  async _launch(mode, params) {
    this._reset({ keepPageIds: false });
    if (mode === 'attach') return this._attach(params);

    const chromium = await loadChromium();
    const headless = mode === 'headless';
    const chromePath = params.chrome_path !== undefined && params.chrome_path !== null && String(params.chrome_path).trim() !== ''
      ? resolve(String(params.chrome_path))
      : this.chromeOverride;
    if (chromePath !== undefined) {
      try {
        await access(chromePath, fsConstants.X_OK);
      } catch {
        throw new Error(`Chrome 路径不可执行：${chromePath}（用 PLAYWRIGHT_CHROME_PATH 或 chrome_path 指向 Chrome 二进制）`);
      }
    }
    const launchOptions = {
      headless,
      timeout: timeoutOf(params.timeout_ms, this.launchTimeoutMs),
      args: ['--hide-scrollbars', '--mute-audio', '--disable-features=Translate,MediaRouter'],
    };
    if (chromePath !== undefined) launchOptions.executablePath = chromePath;
    else launchOptions.channel = 'chrome';
    const contextOptions = {
      viewport: this.viewport,
      deviceScaleFactor: 1,
    };

    log(`启动 ${mode} 模式浏览器（${chromePath ?? 'channel: chrome'}）`);
    let browser = null;
    let context = null;
    try {
      if (headless) {
        browser = await chromium.launch(launchOptions);
        context = await browser.newContext(contextOptions);
      } else {
        const profileDir = resolve(params.profile_dir ?? this.profileDir);
        await mkdir(profileDir, { recursive: true, mode: 0o700 });
        context = await chromium.launchPersistentContext(profileDir, {
          ...launchOptions,
          ...contextOptions,
        });
        browser = context.browser();
        this.state.profileDir = profileDir;
      }
    } catch (error) {
      if (browser !== null) await browser.close().catch(() => {});
      throw new Error(
        `启动 ${mode} 模式浏览器失败：${error?.message ?? error}。` +
          '默认使用系统 Google Chrome（channel: "chrome"）；若未安装 Chrome 或想用其他 Chromium，请设置 PLAYWRIGHT_CHROME_PATH。',
      );
    }

    this.state.mode = mode;
    this.state.browser = browser;
    this.state.context = context;
    this.state.owned = true;
    this.state.chromePath = chromePath ?? null;
    this.state.chromeSource = chromePath === undefined ? 'Playwright channel: chrome（系统安装）' : 'env';
    this.state.playwrightVersion = playwrightCoreInfo().version;
    try {
      this.state.browserVersion = browser?.version?.() ?? null;
    } catch {
      this.state.browserVersion = null;
    }
    if (!headless) this.state.profileDir = resolve(params.profile_dir ?? this.profileDir);
    this.state.startedAt = new Date().toISOString();
    this.state.closing = false;

    const page = await this._alivePage();
    const pageInfo = await this._pageInfoSafe();
    log(`就绪：${mode}，页面 ${pageInfo?.url ?? 'about:blank'}`);
    return {
      alreadyRunning: false,
      autoLaunched: false,
      running: true,
      mode,
      owned: true,
      browserVersion: this.state.browserVersion,
      playwrightVersion: this.state.playwrightVersion,
      chromePath: this.state.chromePath,
      chromeSource: this.state.chromeSource,
      profileDir: this.state.profileDir,
      page: pageInfo,
      profileKind: headless ? '临时（Playwright 内部）' : '持久（headed）',
    };
  }

  async _attach(params) {
    const chromium = await loadChromium();
    const port = positiveInt(params.attach_port ?? params.port ?? this.attachPort, 9222, { min: 1, max: 65535 });
    const endpoint = `http://127.0.0.1:${port}`;
    const loopback = checkLoopbackHttpUrl(endpoint);
    if (!loopback.ok) throw new Error(`拒绝连接非回环 CDP：${loopback.reason}`);
    let browser;
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutOf(params.timeout_ms, this.launchTimeoutMs) });
    } catch (error) {
      throw new Error(
        `无法通过 connectOverCDP 连接 ${endpoint}：${error?.message ?? error}。` +
          `attach 模式要求 Chrome 以 --remote-debugging-port=${port} 启动（Chrome 136+ 必须同时给非默认 --user-data-dir），例如：\n` +
          `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${port} --user-data-dir="$HOME/.dsh/playwright-browser/attach-profile"`,
      );
    }
    const contexts = browser.contexts();
    const context = contexts.find((item) => !item.isClosed()) ?? (await browser.newContext());
    const pages = context.pages().filter((item) => !item.isClosed());
    const page = pages[0] ?? (await context.newPage());
    this.state = {
      ...this.state,
      mode: 'attach',
      browser,
      context,
      page,
      owned: false,
      chromePath: null,
      chromeSource: 'attach（外部 Chrome）',
      browserVersion: (() => {
        try {
          return browser.version();
        } catch {
          return null;
        }
      })(),
      playwrightVersion: playwrightCoreInfo().version,
      profileDir: null,
      startedAt: new Date().toISOString(),
      closing: false,
    };
    this._alivePage();
    const pageInfo = await this._pageInfoSafe();
    log(`已连接 ${endpoint}（${this.state.browserVersion ?? '未知版本'}），页面 ${pageInfo?.url ?? 'about:blank'}`);
    return {
      alreadyRunning: false,
      autoLaunched: false,
      running: true,
      mode: 'attach',
      owned: false,
      browserVersion: this.state.browserVersion,
      playwrightVersion: this.state.playwrightVersion,
      chromePath: null,
      chromeSource: 'attach（外部 Chrome）',
      profileDir: null,
      page: pageInfo,
      profileKind: '外部 Chrome（未知 profile）',
    };
  }

  async _pageInfoSafe() {
    if (!this.isRunning()) return null;
    try {
      const page = await this._alivePage();
      return { url: page.url(), title: await page.title() };
    } catch {
      return null;
    }
  }

  _idFor(page) {
    let id = this._pageIds.get(page);
    if (id === undefined) {
      this._pageSeq += 1;
      id = `p${this._pageSeq}`;
      this._pageIds.set(page, id);
    }
    return id;
  }

  async _requirePage() {
    const { launched } = await this.ensure();
    const page = await this._alivePage();
    return { page, launched };
  }

  async navigate(input, { timeoutMs = 45000 } = {}) {
    const url = normalizeNavigationUrl(input);
    const { page, launched } = await this._requirePage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    } catch (error) {
      throw new Error(describePlaywrightError(error, `导航到 ${url} `));
    }
    const info = await this._pageInfoSafe();
    return {
      requestedUrl: url,
      url: info?.url ?? page.url(),
      title: info?.title ?? '',
      status: response?.status() ?? null,
      loaded: true,
      autoLaunched: launched,
    };
  }

  async snapshot({ max_elements, max_text_chars } = {}) {
    const maxElements = clampInt(max_elements, 120, 1, 500);
    const maxTextChars = clampInt(max_text_chars, 4000, 200, 60000);
    const { page, launched } = await this._requirePage();
    let snapshot;
    try {
      snapshot = await page.evaluate(snapshotExpression({ maxElements, maxTextChars }));
    } catch (error) {
      throw new Error(describePlaywrightError(error, '页面快照'));
    }
    return { ...snapshot, autoLaunched: launched };
  }

  _locatorFor(page, { ref, selector }) {
    const useRef = isElementRef(ref);
    const useSelector = !useRef && typeof selector === 'string' && selector.trim() !== '';
    if (!useRef && !useSelector) {
      if (ref !== undefined && ref !== null && !isElementRef(ref)) {
        throw new Error(`ref 格式不对：${ref}（应形如 e1、e2，来自 browser_snapshot）`);
      }
      throw new Error('需要 ref（来自 browser_snapshot）或非空 CSS selector');
    }
    const locator = useRef
      ? page.locator(`[data-dsh-ref="${ref}"]`).first()
      : page.locator(selector.trim()).first();
    return { locator, useRef, selector: useRef ? null : selector.trim() };
  }

  async _describeLocator(locator) {
    return locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const info = { tag };
      const text = element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '';
      if (text) info.text = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) info.placeholder = placeholder;
      const name = element.getAttribute('name');
      if (name) info.name = name;
      if (tag === 'a') info.href = String(element.getAttribute('href') || '').slice(0, 200);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        info.inputType = tag === 'select' ? 'select' : String(element.type || tag);
        if (element.type !== 'password') {
          const value = String(element.value === undefined ? '' : element.value);
          if (value !== '') info.value = value.slice(0, 100);
        }
      }
      return info;
    });
  }

  async click({ ref, selector, double_click = false, timeout_ms } = {}) {
    const { page, launched } = await this._requirePage();
    const target = this._locatorFor(page, { ref, selector });
    const timeout = timeoutOf(timeout_ms, this.timeoutMs);
    let info;
    try {
      await target.locator.waitFor({ state: 'visible', timeout });
      info = await this._describeLocator(target.locator);
      await target.locator.click({ timeout, clickCount: double_click === true ? 2 : 1 });
    } catch (error) {
      throw new Error(describePlaywrightError(error, `点击 ${target.useRef ? `ref=${ref}` : `selector=${target.selector}`} `));
    }
    await sleep(250);
    const pageInfo = await this._pageInfoSafe();
    return {
      clicked: { ref: target.useRef ? ref : null, selector: target.selector, ...info },
      doubleClick: double_click === true,
      url: pageInfo?.url,
      title: pageInfo?.title,
      autoLaunched: launched,
    };
  }

  async type({ ref, selector, text, submit = false, clear = true, timeout_ms } = {}) {
    const value = text === undefined || text === null ? '' : String(text);
    if (value.length > 20000) throw new Error(`要输入的文字太长（${value.length} 字符，上限 20000）`);
    const { page, launched } = await this._requirePage();
    const target = this._locatorFor(page, { ref, selector });
    const timeout = timeoutOf(timeout_ms, this.timeoutMs);
    let info;
    try {
      await target.locator.waitFor({ state: 'visible', timeout });
      info = await this._describeLocator(target.locator);
      if (clear !== false) {
        await target.locator.fill(value, { timeout });
      } else {
        await target.locator.focus({ timeout });
        if (value !== '') await page.keyboard.insertText(value);
      }
      if (submit === true) await target.locator.press('Enter', { timeout });
    } catch (error) {
      throw new Error(describePlaywrightError(error, `输入到 ${target.useRef ? `ref=${ref}` : `selector=${target.selector}`} `));
    }
    await sleep(150);
    let readValue;
    try {
      readValue = await target.locator.inputValue({ timeout: 3000 });
    } catch {
      try {
        readValue = await target.locator.textContent({ timeout: 3000 });
      } catch {
        readValue = undefined;
      }
    }
    const pageInfo = await this._pageInfoSafe();
    return {
      element: info,
      requested: value,
      value: readValue,
      submitted: submit === true,
      url: pageInfo?.url,
      title: pageInfo?.title,
      autoLaunched: launched,
    };
  }

  async screenshot({ path, full_page = false, format = 'png', quality } = {}) {
    const shotFormat = String(format ?? 'png').toLowerCase();
    if (!['png', 'jpeg'].includes(shotFormat)) throw new Error(`不支持的截图格式：${format}（只支持 png / jpeg）`);
    const { page, launched } = await this._requirePage();
    const outputPath = path !== undefined && path !== null && String(path).trim() !== ''
      ? resolve(String(path))
      : join(this.shotsDir, `shot-${timestampSlug()}.${shotFormat === 'jpeg' ? 'jpg' : 'png'}`);
    await mkdir(dirname(outputPath), { recursive: true });
    const options = { path: outputPath, fullPage: full_page === true, type: shotFormat };
    if (shotFormat === 'jpeg') options.quality = clampInt(quality, 85, 1, 100);
    let buffer;
    try {
      buffer = await page.screenshot(options);
    } catch (error) {
      throw new Error(describePlaywrightError(error, '页面截图'));
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Playwright 返回了空截图');
    const isPng = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    const isJpeg = buffer.subarray(0, 3).equals(JPEG_SIGNATURE);
    if (shotFormat === 'png' && !isPng) throw new Error(`截图数据不是合法 PNG（前 8 字节：${buffer.subarray(0, 8).toString('hex')}）`);
    if (shotFormat === 'jpeg' && !isJpeg) throw new Error(`截图数据不是合法 JPEG（前 3 字节：${buffer.subarray(0, 3).toString('hex')}）`);
    const dimensions = shotFormat === 'png' ? pngDimensions(buffer) : undefined;
    return {
      path: outputPath,
      bytes: buffer.length,
      bytesText: formatBytes(buffer.length),
      format: shotFormat,
      width: dimensions?.width,
      height: dimensions?.height,
      fullPage: full_page === true,
      url: (await this._pageInfoSafe())?.url,
      autoLaunched: launched,
    };
  }

  async pdf({ path, format = 'A4', landscape = false, print_background = true } = {}) {
    if (!this.isRunning()) await this.launch({ mode: 'headless' });
    if (this.state.mode !== 'headless') {
      throw new Error(
        `browser_pdf 只支持 headless 模式（当前是 ${this.state.mode ?? '未启动'}）。` +
          'Playwright 的 page.pdf 在 headed/attach 的可见 Chrome 上不可用；请先 browser_launch {mode:"headless"}。',
      );
    }
    const { page, launched } = await this._requirePage();
    const outputPath = path !== undefined && path !== null && String(path).trim() !== ''
      ? resolve(String(path))
      : join(this.home, 'pdf', `page-${timestampSlug()}.pdf`);
    await mkdir(dirname(outputPath), { recursive: true });
    let buffer;
    try {
      buffer = await page.pdf({
        path: outputPath,
        format: String(format ?? 'A4'),
        landscape: landscape === true,
        printBackground: print_background !== false,
        margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' },
      });
    } catch (error) {
      throw new Error(describePlaywrightError(error, '生成 PDF'));
    }
    if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error('Playwright 返回的 PDF 数据不合法（缺少 %PDF 头）');
    }
    return {
      path: outputPath,
      bytes: buffer.length,
      bytesText: formatBytes(buffer.length),
      format: String(format ?? 'A4'),
      landscape: landscape === true,
      url: (await this._pageInfoSafe())?.url,
      autoLaunched: launched,
    };
  }

  async evaluate(expression, { timeout_ms } = {}) {
    if (typeof expression !== 'string' || expression.trim() === '') throw new Error('expression 不能为空');
    if (expression.length > 100000) throw new Error(`expression 太长（${expression.length} 字符，上限 100000）`);
    const timeoutMs = timeoutOf(timeout_ms, Math.max(30000, this.timeoutMs));
    const { page, launched } = await this._requirePage();
    let value;
    try {
      value = await withTimeout(
        page.evaluate(expression),
        timeoutMs,
        `eval 超时（${timeoutMs}ms）。Playwright 无法中断页面脚本；若页面在执行死循环，请重新导航或 browser_close 后重开。`,
      );
    } catch (error) {
      if (error?.name === 'TimeoutError' || /^eval 超时/u.test(String(error?.message))) throw error;
      return {
        ok: false,
        error: truncate(String(error?.message ?? error), 2000),
        autoLaunched: launched,
      };
    }
    let serialized;
    let type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (value !== undefined) {
      try {
        serialized = JSON.stringify(value);
      } catch {
        serialized = String(value);
      }
      if (serialized !== undefined && serialized.length > 100000) serialized = `${serialized.slice(0, 100000)}…（已截断）`;
    }
    return {
      ok: true,
      type,
      value,
      json: serialized,
      autoLaunched: launched,
    };
  }

  async wait({ selector, timeout_ms, ms, url, load_state, state = 'visible' } = {}) {
    const hasSelector = typeof selector === 'string' && selector.trim() !== '';
    const hasMs = ms !== undefined && ms !== null;
    const hasUrl = typeof url === 'string' && url.trim() !== '';
    const hasLoadState = typeof load_state === 'string' && load_state.trim() !== '';
    if (!hasSelector && !hasMs && !hasUrl && !hasLoadState) {
      throw new Error('browser_wait 需要 selector、ms、url、load_state 中至少一个参数');
    }
    const timeout = timeoutOf(timeout_ms, this.timeoutMs);
    const { page, launched } = await this._requirePage();
    const waited = [];
    try {
      if (hasMs) {
        const duration = positiveInt(ms, 1000, { min: 1, max: 60000 });
        await page.waitForTimeout(duration);
        waited.push(`等待 ${duration}ms`);
      }
      if (hasLoadState) {
        const allowed = ['load', 'domcontentloaded', 'networkidle', 'commit'];
        if (!allowed.includes(load_state)) throw new Error(`load_state 只支持 ${allowed.join(' / ')}`);
        await page.waitForLoadState(load_state, { timeout });
        waited.push(`load_state=${load_state}`);
      }
      if (hasSelector) {
        const allowedStates = ['attached', 'detached', 'visible', 'hidden'];
        const waitState = allowedStates.includes(String(state)) ? String(state) : 'visible';
        await page.locator(selector.trim()).first().waitFor({ state: waitState, timeout });
        waited.push(`selector=${selector.trim()}（${waitState}）`);
      }
      if (hasUrl) {
        await page.waitForURL(url.trim(), { timeout, waitUntil: 'load' });
        waited.push(`url=${url.trim()}`);
      }
    } catch (error) {
      throw new Error(describePlaywrightError(error, `等待（${waited.join('，') || '条件'}）`));
    }
    const pageInfo = await this._pageInfoSafe();
    return {
      waited,
      url: pageInfo?.url,
      title: pageInfo?.title,
      autoLaunched: launched,
    };
  }

  async tabs({ action = 'list', page_id, index, url } = {}) {
    const normalized = String(action ?? 'list').toLowerCase();
    const { page, launched } = await this._requirePage();
    const context = this.state.context;
    const listPages = () => context.pages().filter((item) => !item.isClosed());

    if (normalized === 'list') {
      const pages = listPages();
      const tabs = await Promise.all(pages.map(async (item, position) => ({
        index: position,
        pageId: this._idFor(item),
        url: item.url(),
        title: await item.title().catch(() => ''),
        current: item === this.state.page,
      })));
      return { tabs, pageCount: pages.length, autoLaunched: launched };
    }
    if (normalized === 'new') {
      const targetUrl = url === undefined || url === null || String(url).trim() === ''
        ? 'about:blank'
        : normalizeNavigationUrl(String(url));
      const newPage = await context.newPage();
      if (targetUrl !== 'about:blank') {
        try {
          await newPage.goto(targetUrl, { waitUntil: 'load', timeout: 45000 });
        } catch (error) {
          await newPage.close().catch(() => {});
          throw new Error(describePlaywrightError(error, `新标签页导航到 ${targetUrl} `));
        }
      }
      this.state.page = newPage;
      return {
        created: {
          pageId: this._idFor(newPage),
          url: newPage.url(),
          title: await newPage.title().catch(() => ''),
        },
        autoLaunched: launched,
      };
    }
    if (normalized === 'activate') {
      const target = this._findPage({ page_id, index });
      if (target === undefined) throw new Error('activate 需要 page_id（来自 browser_tabs list）或 index');
      await target.bringToFront();
      this.state.page = target;
      return {
        activated: { pageId: this._idFor(target), url: target.url(), title: await target.title().catch(() => '') },
        autoLaunched: launched,
      };
    }
    if (normalized === 'close') {
      const target = this._findPage({ page_id, index });
      if (target === undefined) throw new Error('close 需要 page_id（来自 browser_tabs list）或 index');
      const pages = listPages();
      if (pages.length <= 1) throw new Error('这是最后一个标签页；请改用 browser_close 关闭浏览器');
      const closedId = this._idFor(target);
      const closedUrl = target.url();
      await target.close();
      this._pageIds.delete(target);
      if (target === this.state.page) {
        const remaining = listPages();
        this.state.page = remaining[0] ?? (await context.newPage());
      }
      return {
        closed: { pageId: closedId, url: closedUrl },
        pageCount: listPages().length,
        autoLaunched: launched,
      };
    }
    throw new Error(`未知 tabs action：${action}（支持 list / new / activate / close）`);
  }

  _findPage({ page_id, index }) {
    const pages = this.state.context.pages().filter((item) => !item.isClosed());
    if (page_id !== undefined && page_id !== null) {
      for (const item of pages) {
        if (this._pageIds.get(item) === page_id) return item;
      }
      return undefined;
    }
    if (index !== undefined && index !== null) {
      const position = Number(index);
      if (Number.isInteger(position) && position >= 0 && position < pages.length) return pages[position];
      return undefined;
    }
    return undefined;
  }

  async close() {
    const wasRunning = this.isRunning();
    const browser = this.state.browser;
    const context = this.state.context;
    const owned = this.state.owned;
    const mode = this.state.mode;
    if (!wasRunning && browser === null) {
      return { closed: false, message: '浏览器本来就没有运行' };
    }
    this.state.closing = true;
    if (mode === 'attach') {
      // 只断开连接，不关闭外部 Chrome，也不 close 用户的 context。
      if (browser !== null) {
        await withTimeout(browser.close(), 8000, '断开 CDP 连接超时').catch(() => {});
      }
    } else {
      if (context !== null) {
        await withTimeout(context.close(), 8000, '关闭浏览器 context 超时').catch(() => {});
      }
      if (browser !== null && browser.isConnected()) {
        await withTimeout(browser.close(), 8000, '关闭浏览器超时').catch(() => {});
      }
    }
    this._reset({ keepPageIds: false });
    log(`已关闭浏览器（${owned ? 'owned' : 'attach，仅断开'}）`);
    return {
      closed: true,
      owned,
      mode,
      message: owned
        ? mode === 'headed'
          ? '已关闭本插件启动的 Chrome（headed 持久 profile 保留）'
          : '已关闭本插件启动的 Chrome（headless 临时 profile 已由 Playwright 清理）'
        : 'attach 模式：只断开了 CDP 连接，没有关闭你的 Chrome',
    };
  }

  _reset({ keepPageIds = false } = {}) {
    this.state.mode = null;
    this.state.browser = null;
    this.state.context = null;
    this.state.page = null;
    this.state.owned = false;
    this.state.chromePath = null;
    this.state.chromeSource = null;
    this.state.browserVersion = null;
    this.state.profileDir = null;
    this.state.startedAt = null;
    this.state.closing = false;
    if (!keepPageIds) {
      this._pageIds.clear();
      this._pageSeq = 0;
    }
  }

  /** 进程退出兜底：尽力关闭（异步，server 里 await 有上限）。 */
  async dispose() {
    if (this.state.browser === null) return;
    try {
      await withTimeout(this.close(), 5000, '关闭超时').catch(() => {});
    } catch {
      // ignore
    }
  }
}

export { MODES, normalizeMode, log, playwrightCoreInfo };
