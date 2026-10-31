/**
 * 浏览器管理器：启动/连接 Chrome（headless / chrome / attach），
 * 维护默认页面的 CDP session，实现 11 个 browser_* 工具背后的操作。
 *
 * 安全边界：
 *   - 只连 127.0.0.1 的 CDP；
 *   - 只杀自己启动的 Chrome（owned），attach 模式只断开连接；
 *   - 只读扩展 manifest/Preferences，不碰 cookie/凭据文件；
 *   - headless 用一次性临时 profile，永不使用用户日常 profile。
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CdpConnection, CdpError } from './cdp.mjs';
import { buildChromeArgs, extensionIdForPath, findChromePath, loadExtensionsFromProfile, runningExtensionTargets } from './chrome.mjs';
import {
  PAGE_INFO_EXPRESSION,
  focusTargetExpression,
  readValueExpression,
  resolveTargetExpression,
  snapshotExpression,
} from './dom.mjs';
import {
  booleanFlag,
  checkLoopbackWsUrl,
  clampInt,
  describeSpawnError,
  formatBytes,
  isElementRef,
  normalizeNavigationUrl,
  parseDevToolsBanner,
  positiveInt,
  splitList,
  timestampSlug,
  truncate,
} from './util.mjs';

const PKG = 'dsh-browser';
const SUPPORTED_MODES = ['headless', 'chrome', 'attach'];

const MODE_ALIASES = {
  headless: 'headless',
  无头: 'headless',
  chrome: 'chrome',
  visible: 'chrome',
  可见: 'chrome',
  attach: 'attach',
  连接: 'attach',
};

function log(message) {
  // MCP 的 stdout 属于 JSON-RPC，所有日志只能进 stderr。
  process.stderr.write(`[${PKG}] ${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function normalizeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const mode = MODE_ALIASES[raw] ?? raw;
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new Error(`未知模式：${value}（只支持 headless / chrome / attach）`);
  }
  return mode;
}

function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(hostname).replace(/^\[/u, '').replace(/\]$/u, ''));
}

function pngDimensions(buffer) {
  if (buffer.length < 24) return undefined;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export class BrowserManager {
  constructor(options = {}) {
    this.home = options.home ?? process.env.BROWSER_HOME ?? join(homedir(), '.dsh', 'browser');
    this.shotsDir = options.shotsDir ?? join(this.home, 'shots');
    this.defaultMode = normalizeMode(options.mode ?? process.env.BROWSER_MODE ?? 'headless');
    this.chromePathOverride = options.chromePath ?? process.env.BROWSER_CHROME_PATH;
    this.profileDir = resolve(options.profileDir ?? process.env.BROWSER_PROFILE_DIR ?? join(this.home, 'chrome-profile'));
    this.extensionDirs = splitList(options.extensions ?? process.env.BROWSER_EXTENSIONS, ':').map((item) => resolve(item));
    this.attachPort = positiveInt(options.attachPort ?? process.env.BROWSER_ATTACH_PORT, 9222, { min: 1, max: 65535 });
    this.timeoutMs = positiveInt(options.timeoutMs ?? process.env.BROWSER_TIMEOUT_MS, 30000, { min: 1000, max: 600000 });
    this.launchTimeoutMs = positiveInt(options.launchTimeoutMs ?? process.env.BROWSER_LAUNCH_TIMEOUT_MS, 25000, { min: 3000, max: 120000 });
    this.windowSize = String(options.windowSize ?? process.env.BROWSER_WINDOW_SIZE ?? '1440,900');

    this.state = {
      mode: null,
      child: null,
      cdp: null,
      wsUrl: null,
      devtoolsPort: null,
      profileDir: null,
      tempProfile: false,
      owned: false,
      chromePath: null,
      chromeSource: null,
      chromeVersion: null,
      protocolVersion: null,
      targetId: null,
      sessionId: null,
      startedAt: null,
      closing: false,
      stderrTail: '',
      lastSnapshotAt: null,
      lastSnapshotUrl: null,
      requestedExtensions: [],
    };
    this._launching = null;
    this._pendingChild = null;
  }

  isRunning() {
    return this.state.cdp !== null && this.state.cdp.closed === false;
  }

  /** 给 status 用的静态配置摘要（不启动浏览器）。 */
  configSummary() {
    return {
      defaultMode: this.defaultMode,
      attachPort: this.attachPort,
      profileDir: this.profileDir,
      extensions: this.extensionDirs,
      home: this.home,
      shotsDir: this.shotsDir,
      timeoutMs: this.timeoutMs,
      windowSize: this.windowSize,
      chromePathOverride: this.chromePathOverride ?? null,
    };
  }

  /** 浏览器状态（不自动启动）。 */
  async status() {
    const config = this.configSummary();
    let chrome = null;
    try {
      chrome = await findChromePath({ override: this.chromePathOverride });
    } catch (error) {
      chrome = { error: error.message };
    }
    const running = this.isRunning();
    let page = null;
    if (running) page = await this._pageInfoSafe();
    return {
      running,
      mode: this.state.mode,
      owned: this.state.owned,
      autoLaunched: false,
      chromePath: this.state.chromePath ?? chrome?.path ?? null,
      chromeSource: this.state.chromeSource ?? chrome?.source ?? null,
      chromeVersion: this.state.chromeVersion,
      protocolVersion: this.state.protocolVersion,
      devtoolsPort: this.state.devtoolsPort,
      profileDir: this.state.profileDir ?? config.profileDir,
      profileKind: this.state.tempProfile ? '临时' : this.state.mode === 'attach' ? '未知（attach）' : this.state.mode === null ? '未启动（默认持久 profile）' : '持久',
      startedAt: this.state.startedAt,
      page,
      chromeAvailable: chrome,
      config,
    };
  }

  /**
   * 启动浏览器；已经在跑时直接返回现状。
   * @param {{mode?: string, force?: boolean, extensions?: string[], profileDir?: string, port?: number}} params
   */
  async launch(params = {}) {
    const mode = normalizeMode(params.mode ?? this.defaultMode);
    if (this.isRunning() && mode === this.state.mode && params.force !== true) {
      return { ...(await this.status()), alreadyRunning: true, autoLaunched: false };
    }
    if (this.isRunning()) await this.close();
    if (this._launching !== null) return this._launching;
    this._launching = this._launch(mode, params).finally(() => {
      this._launching = null;
    });
    return this._launching;
  }

  /** 工具调用前确保浏览器已启动；未启动则按默认模式自动启动。 */
  async ensure() {
    if (this.isRunning()) return { launched: false };
    const result = await this.launch({});
    return { launched: true, mode: result.mode ?? this.state.mode };
  }

  async _reapStale() {
    const child = this.state.child;
    if (child !== null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    const tempForCleanup = this.state.tempProfile ? this.state.profileDir : null;
    this._resetState();
    if (tempForCleanup !== null) await this._cleanupTempProfile(tempForCleanup);
  }

  _resetState() {
    const { child } = this.state;
    this.state = {
      ...this.state,
      mode: null,
      child: null,
      cdp: null,
      wsUrl: null,
      devtoolsPort: null,
      profileDir: null,
      tempProfile: false,
      owned: false,
      chromePath: null,
      chromeSource: null,
      chromeVersion: null,
      protocolVersion: null,
      targetId: null,
      sessionId: null,
      startedAt: null,
      closing: false,
      stderrTail: '',
      requestedExtensions: [],
    };
    return child;
  }

  async _launch(mode, params) {
    await this._reapStale();
    if (mode === 'attach') return this._attach(params);

    const chrome = await findChromePath({ override: params.chrome_path ?? this.chromePathOverride });

    let extensions = [];
    const requestedExtensions = [];
    if (mode === 'chrome') {
      const requested = params.extensions === undefined
        ? this.extensionDirs
        : splitList(params.extensions, ':').map((item) => resolve(item));
      extensions = await this._validateExtensions(requested);
      for (const dir of extensions) {
        requestedExtensions.push({ path: dir, id: await extensionIdForPath(dir) });
      }
    }

    let profileDir;
    let tempProfile;
    if (mode === 'headless') {
      tempProfile = true;
      profileDir = await mkdtemp(join(tmpdir(), 'dsh-browser-headless-'));
    } else {
      tempProfile = false;
      profileDir = resolve(params.profile_dir ?? this.profileDir);
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
    }

    const args = buildChromeArgs({
      mode,
      profileDir,
      port: 0,
      extensions,
      windowSize: this.windowSize,
    });

    log(`启动 ${mode} Chrome：${chrome.path}${extensions.length > 0 ? `（扩展 ${extensions.length} 个）` : ''}`);
    const child = spawn(chrome.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._pendingChild = child;
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.state.stderrTail = `${this.state.stderrTail}${text}`.slice(-4096);
    });

    let wsUrl;
    try {
      wsUrl = await this._waitForBanner(child, chrome.path, mode);
    } catch (error) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      this._pendingChild = null;
      if (tempProfile) await this._cleanupTempProfile(profileDir);
      throw error;
    }

    const loopback = checkLoopbackWsUrl(wsUrl);
    if (!loopback.ok) {
      this._pendingChild = null;
      child.kill('SIGKILL');
      if (tempProfile) await this._cleanupTempProfile(profileDir);
      throw new Error(`Chrome 返回了非回环 CDP 地址（${loopback.reason}）：${wsUrl}`);
    }

    let cdp;
    let version;
    try {
      cdp = await CdpConnection.connect(wsUrl, { timeoutMs: 15000 });
      version = await cdp.send('Browser.getVersion', {}, { timeoutMs: 10000 });
    } catch (error) {
      this._pendingChild = null;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      if (cdp !== undefined) cdp.close();
      if (tempProfile) await this._cleanupTempProfile(profileDir);
      throw new Error(`已启动 Chrome，但连接 CDP 失败：${error.message}`);
    }

    this._pendingChild = null;
    this.state.mode = mode;
    this.state.child = child;
    this.state.cdp = cdp;
    this.state.wsUrl = wsUrl;
    this.state.devtoolsPort = Number(new URL(wsUrl).port);
    this.state.profileDir = profileDir;
    this.state.tempProfile = tempProfile;
    this.state.owned = true;
    this.state.chromePath = chrome.path;
    this.state.chromeSource = chrome.source;
    this.state.chromeVersion = String(version.product ?? '');
    this.state.protocolVersion = String(version.protocolVersion ?? '');
    this.state.startedAt = new Date().toISOString();
    this.state.closing = false;
    this.state.requestedExtensions = requestedExtensions;

    child.on('exit', (code, signal) => {
      if (this.state.child !== child || this.state.closing) return;
      log(`Chrome 意外退出（code=${code}, signal=${signal}）：${truncate(this.state.stderrTail, 600)}`);
      const tempForCleanup = this.state.tempProfile ? this.state.profileDir : null;
      try {
        cdp.close();
      } catch {
        // ignore
      }
      this._resetState();
      if (tempForCleanup !== null) this._cleanupTempProfile(tempForCleanup).catch(() => {});
    });

    try {
      await this._setupDefaultPage({ owned: true });
    } catch (error) {
      await this.close();
      throw new Error(`Chrome 已启动，但初始化默认页面失败：${error.message}`);
    }

    const page = await this._pageInfoSafe();
    let extensionsWarning;
    let extensionEvidence;
    if (mode === 'chrome' && requestedExtensions.length > 0) {
      // 官方版 Chrome 会忽略解包扩展参数；Chrome for Testing / Chromium 正常。
      const flagIgnored = /--disable-extensions-except is not allowed in Google Chrome/u.test(this.state.stderrTail)
        || isBrandedGoogleChrome(chrome.path);
      await sleep(500);
      let runningIds = new Set();
      try {
        const targets = await this.state.cdp.send('Target.getTargets', {}, { timeoutMs: 5000 });
        runningIds = new Set(runningExtensionTargets(targets.targetInfos ?? []).map((entry) => entry.id));
      } catch {
        // 证据缺失不阻塞启动
      }
      extensionEvidence = requestedExtensions.map((entry) => ({
        ...entry,
        running: runningIds.has(entry.id),
      }));
      if (flagIgnored) {
        const observed = extensionEvidence.filter((entry) => entry.running).length;
        extensionsWarning =
          `你使用的是 Google Chrome 官方版：本机 156 实测它忽略 --load-extension / --disable-extensions-except（stderr 也会提示 "not allowed in Google Chrome"），` +
          `本次 ${observed}/${extensionEvidence.length} 个扩展被观察到运行。` +
          '可改用 Chrome for Testing / Chromium，或在这个 chrome 模式窗口打开 chrome://extensions 手动「加载已解压的扩展程序」（会持久保存在该 profile 里）。';
      }
    }
    log(`就绪：${mode} 模式，端口 ${this.state.devtoolsPort}，页面 ${page?.url ?? 'about:blank'}`);
    return {
      alreadyRunning: false,
      autoLaunched: false,
      mismatchedMode: false,
      running: true,
      mode,
      owned: true,
      chromePath: chrome.path,
      chromeVersion: this.state.chromeVersion,
      devtoolsPort: this.state.devtoolsPort,
      profileDir,
      profileKind: tempProfile ? '临时' : '持久',
      extensions,
      extensionsIgnoredInHeadless: mode === 'headless' && (params.extensions !== undefined || this.extensionDirs.length > 0),
      extensionsWarning,
      extensionEvidence,
      page,
    };
  }

  async _validateExtensions(dirs) {
    const valid = [];
    for (const dir of dirs) {
      let info;
      try {
        info = await stat(dir);
      } catch {
        throw new Error(`扩展目录不存在：${dir}（BROWSER_EXTENSIONS 或 browser_launch.extensions 里的路径必须绝对存在）`);
      }
      if (!info.isDirectory()) throw new Error(`扩展路径不是目录：${dir}`);
      try {
        await stat(join(dir, 'manifest.json'));
      } catch {
        throw new Error(`扩展目录里没有 manifest.json：${dir}（--load-extension 需要解包扩展目录）`);
      }
      valid.push(dir);
    }
    return valid;
  }

  _waitForBanner(child, chromePath, mode) {
    return new Promise((resolvePromise, reject) => {
      let buffer = '';
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        child.stderr.removeListener('data', onData);
        child.stdout.removeListener('data', onStdout);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== null) reject(error);
        else resolvePromise(value);
      };
      const inspect = (text) => {
        buffer += text;
        if (buffer.length > 131072) buffer = buffer.slice(-16384);
        const url = parseDevToolsBanner(buffer);
        if (url !== undefined) finish(null, url);
      };
      const onData = (chunk) => inspect(chunk.toString());
      const onStdout = (chunk) => inspect(chunk.toString());
      const onExit = (code, signal) => {
        const stderrTail = truncate(this.state.stderrTail, 1200);
        const hint = mode === 'chrome'
          ? '\n如果已有 Chrome 正在使用同一个 profile，新实例会把命令转发过去并立即退出；请先关闭那个 Chrome，或换一个 BROWSER_PROFILE_DIR。'
          : '';
        finish(new Error(
          `Chrome 启动后立即退出（code=${code}, signal=${signal}），未等到 DevTools 地址。stderr 末尾：\n${stderrTail}${hint}`,
        ));
      };
      const onError = (error) => finish(new Error(describeSpawnError(error, chromePath)));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(
          `等待 Chrome DevTools 地址超时（${this.launchTimeoutMs}ms）。stderr 末尾：\n${truncate(this.state.stderrTail, 1200)}`,
        ));
      }, this.launchTimeoutMs);

      child.stderr.on('data', onData);
      child.stdout.on('data', onStdout);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  async _attach(params) {
    const port = positiveInt(params.port ?? this.attachPort, 9222, { min: 1, max: 65535 });
    const endpoint = `http://127.0.0.1:${port}/json/version`;
    let info;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      info = await response.json();
    } catch (error) {
      throw new Error(
        `无法连接 127.0.0.1:${port} 的 Chrome DevTools（${error.message}）。\n` +
          `attach 模式要求 Chrome 以 --remote-debugging-port=${port} 启动，例如：\n` +
          `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${port} --user-data-dir="$HOME/.dsh/browser/chrome-profile"\n` +
          '注意：Chrome 136+ 不允许对默认用户数据目录开启远程调试，必须显式给 --user-data-dir。',
      );
    }
    const wsUrl = String(info.webSocketDebuggerUrl ?? '');
    const loopback = checkLoopbackWsUrl(wsUrl);
    if (!loopback.ok) throw new Error(`拒绝连接远程 CDP（${loopback.reason}）：${wsUrl}`);
    const cdp = await CdpConnection.connect(wsUrl, { timeoutMs: 15000 });
    const version = await cdp.send('Browser.getVersion', {}, { timeoutMs: 10000 });

    const profileDir = resolve(params.profile_dir ?? this.profileDir);
    this.state = {
      ...this.state,
      mode: 'attach',
      child: null,
      cdp,
      wsUrl,
      devtoolsPort: port,
      profileDir,
      tempProfile: false,
      owned: false,
      chromePath: null,
      chromeSource: 'attach 模式（外部 Chrome）',
      chromeVersion: String(version.product ?? ''),
      protocolVersion: String(version.protocolVersion ?? ''),
      startedAt: new Date().toISOString(),
      closing: false,
    };
    await this._setupDefaultPage({ owned: false });
    const page = await this._pageInfoSafe();
    log(`已连接 127.0.0.1:${port} 的 Chrome（${this.state.chromeVersion}），页面 ${page?.url ?? 'about:blank'}`);
    return {
      alreadyRunning: false,
      autoLaunched: false,
      running: true,
      mode: 'attach',
      owned: false,
      chromePath: null,
      chromeVersion: this.state.chromeVersion,
      devtoolsPort: port,
      profileDir,
      profileKind: '未知（attach）',
      page,
    };
  }

  /** 找到/创建默认页面并 attach（flatten 模式拿 sessionId）。 */
  async _setupDefaultPage({ owned }) {
    const cdp = this.state.cdp;
    const targets = await cdp.send('Target.getTargets', {}, { timeoutMs: 10000 });
    const pages = (targets.targetInfos ?? []).filter((target) => target.type === 'page');
    let target = pages.find((item) => !String(item.url ?? '').startsWith('devtools://'));
    if (target === undefined) {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs: 10000 });
      target = { targetId: created.targetId, url: 'about:blank' };
    }
    await this._attachPage(target.targetId, { owned });
  }

  async _attachPage(targetId, { owned = this.state.owned } = {}) {
    const cdp = this.state.cdp;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: 10000 });
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, { sessionId, timeoutMs: 10000 });
    await cdp.send('Runtime.enable', {}, { sessionId, timeoutMs: 10000 });
    if (owned) {
      try {
        const [width, height] = this.windowSize.split(',').map((value) => positiveInt(value, 1440, { min: 200, max: 8000 }));
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: width ?? 1440,
          height: height ?? 900,
          deviceScaleFactor: 1,
          mobile: false,
        }, { sessionId, timeoutMs: 5000 });
      } catch {
        // 视口覆盖失败不影响主流程
      }
    }
    this.state.targetId = targetId;
    this.state.sessionId = sessionId;
    return sessionId;
  }

  async _ensurePage() {
    const { launched } = await this.ensure();
    const cdp = this.state.cdp;
    let targets;
    try {
      targets = await cdp.send('Target.getTargets', {}, { timeoutMs: 10000 });
    } catch (error) {
      throw new Error(`浏览器连接已失效（${error.message}），请重新 browser_launch 或 browser_close 后重试`);
    }
    const current = (targets.targetInfos ?? []).find((target) => target.targetId === this.state.targetId && target.type === 'page');
    if (current === undefined) {
      await this._setupDefaultPage({ owned: this.state.owned });
    }
    return { launched, sessionId: this.state.sessionId, targetId: this.state.targetId };
  }

  async _withPageRetry(operation) {
    const first = await this._ensurePage();
    try {
      return await operation(first.sessionId, first.launched);
    } catch (error) {
      const message = String(error?.message ?? error);
      const recoverable = /session|target|已关闭|detached|Execution context/i.test(message);
      if (!recoverable) throw error;
      log(`页面 session 失效，重建后重试一次：${message}`);
      this.state.sessionId = null;
      this.state.targetId = null;
      const second = await this._ensurePage();
      return operation(second.sessionId, first.launched);
    }
  }

  async _evaluate(expression, { sessionId, awaitPromise = false, returnByValue = true, timeoutMs = this.timeoutMs, userGesture = true } = {}) {
    const cdp = this.state.cdp;
    return cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture,
      includeCommandLineAPI: false,
    }, { sessionId, timeoutMs });
  }

  async _evalValue(expression, sessionId, timeoutMs = 10000) {
    const { result, exceptionDetails } = await this._evaluate(expression, { sessionId, timeoutMs });
    if (exceptionDetails !== undefined) {
      const description = exceptionDetails.exception?.description ?? exceptionDetails.text ?? '未知页面错误';
      throw new Error(`页面脚本执行失败：${truncate(description, 500)}`);
    }
    return result?.value;
  }

  async _pageInfoSafe() {
    if (!this.isRunning()) return null;
    const sessionId = this.state.sessionId;
    if (sessionId === null) return null;
    try {
      const info = await this._evalValue(PAGE_INFO_EXPRESSION, sessionId, 4000);
      return { url: info?.url, title: info?.title, readyState: info?.readyState };
    } catch {
      try {
        const targets = await this.state.cdp.send('Target.getTargets', {}, { timeoutMs: 4000 });
        const target = (targets.targetInfos ?? []).find((item) => item.targetId === this.state.targetId);
        if (target === undefined) return null;
        return { url: target.url, title: target.title ?? '', readyState: 'unknown' };
      } catch {
        return null;
      }
    }
  }

  async _waitForLoad(sessionId, { timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'unknown';
    while (Date.now() < deadline) {
      try {
        lastState = await this._evalValue('document.readyState', sessionId, 3000);
      } catch {
        // 导航中执行上下文可能被销毁，继续等
      }
      if (lastState === 'complete') return { loaded: true, readyState: lastState };
      await sleep(80);
    }
    return { loaded: false, readyState: lastState };
  }

  /** 导航当前页面。 */
  async navigate(input, { timeoutMs = 45000 } = {}) {
    const url = normalizeNavigationUrl(input);
    const { launched } = await this._ensurePage();
    const { loaded, readyState } = await this._withPageRetry(async (sessionId, wasLaunched) => {
      const cdp = this.state.cdp;
      const result = await cdp.send('Page.navigate', { url }, { sessionId, timeoutMs });
      if (result.errorText !== undefined && result.errorText !== '') {
        throw new Error(`导航失败：${result.errorText}（${url}）`);
      }
      const load = await this._waitForLoad(sessionId, { timeoutMs: 15000 });
      return { ...load, launched: wasLaunched };
    });
    const page = await this._pageInfoSafe();
    return {
      requestedUrl: url,
      url: page?.url ?? url,
      title: page?.title ?? '',
      loaded,
      readyState,
      autoLaunched: launched,
    };
  }

  /** 页面快照：正文 + 可交互元素 ref。 */
  async snapshot({ max_elements, max_text_chars } = {}) {
    const maxElements = clampInt(max_elements, 120, 1, 500);
    const maxTextChars = clampInt(max_text_chars, 4000, 200, 60000);
    const expression = snapshotExpression({ maxElements, maxTextChars });
    const { launched } = await this._ensurePage();
    const snapshot = await this._withPageRetry(async (sessionId) => {
      const { result, exceptionDetails } = await this._evaluate(expression, { sessionId, timeoutMs: 20000 });
      if (exceptionDetails !== undefined) {
        throw new Error(`页面快照失败：${truncate(exceptionDetails.exception?.description ?? exceptionDetails.text ?? '未知错误', 500)}`);
      }
      return result?.value;
    });
    this.state.lastSnapshotAt = new Date().toISOString();
    this.state.lastSnapshotUrl = snapshot?.url ?? null;
    return { ...snapshot, autoLaunched: launched };
  }

  /** 点击元素：ref 优先，其次 CSS selector。真实鼠标事件（非 JS .click()）。 */
  async click({ ref, selector, double_click = false } = {}) {
    const useRef = isElementRef(ref) ? ref : undefined;
    const useSelector = useRef === undefined && typeof selector === 'string' && selector.trim() !== '' ? selector.trim() : undefined;
    if (useRef === undefined && useSelector === undefined) {
      if (ref !== undefined && ref !== null && !isElementRef(ref)) throw new Error(`ref 格式不对：${ref}（应形如 e1、e2，来自 browser_snapshot）`);
      throw new Error('需要 ref（来自 browser_snapshot）或非空 CSS selector');
    }
    const { launched } = await this._ensurePage();
    const { resolved, sessionId } = await this._withPageRetry(async (sessionId) => {
      const target = await this._evalValue(resolveTargetExpression({ selector: useSelector, ref: useRef }), sessionId, 15000);
      return { resolved: target, sessionId };
    });
    if (resolved?.found !== true) throw new Error(resolved?.reason ?? '找不到要点击的元素');
    if (resolved.visible !== true) throw new Error(`元素不可见（可能被遮挡或尺寸为 0）：${JSON.stringify(resolved.info)}`);
    const x = Math.round(resolved.rect.x);
    const y = Math.round(resolved.rect.y);
    const cdp = this.state.cdp;
    const clicks = double_click === true ? 2 : 1;
    for (let index = 1; index <= clicks; index += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, { sessionId });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: index,
      }, { sessionId });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: index,
      }, { sessionId });
      if (clicks > 1) await sleep(60);
    }
    await sleep(250);
    const page = await this._pageInfoSafe();
    return {
      clicked: { ref: useRef ?? null, selector: useSelector ?? null, ...resolved.info },
      x,
      y,
      doubleClick: double_click === true,
      url: page?.url,
      title: page?.title,
      autoLaunched: launched,
    };
  }

  /** 输入文本：聚焦 → insertText →（可选）回车提交。 */
  async type({ ref, selector, text, submit = false, clear = true } = {}) {
    const useRef = isElementRef(ref) ? ref : undefined;
    const useSelector = useRef === undefined && typeof selector === 'string' && selector.trim() !== '' ? selector.trim() : undefined;
    if (useRef === undefined && useSelector === undefined) {
      if (ref !== undefined && ref !== null && !isElementRef(ref)) throw new Error(`ref 格式不对：${ref}（应形如 e1、e2，来自 browser_snapshot）`);
      throw new Error('需要 ref（来自 browser_snapshot）或非空 CSS selector');
    }
    const value = text === undefined || text === null ? '' : String(text);
    if (value.length > 20000) throw new Error(`要输入的文字太长（${value.length} 字符，上限 20000）`);
    const { launched } = await this._ensurePage();
    const sessionId = this.state.sessionId;
    const focus = await this._evalValue(focusTargetExpression({ selector: useSelector, ref: useRef, clear: clear !== false }), sessionId, 15000);
    if (focus?.found !== true) throw new Error(focus?.reason ?? '找不到要输入的元素');
    if (focus.editable !== true) throw new Error(focus?.reason ?? '目标元素不可输入');
    if (value !== '') {
      await this.state.cdp.send('Input.insertText', { text: value }, { sessionId });
    }
    if (submit === true) {
      await this._pressEnter(sessionId);
    }
    await sleep(200);
    const read = await this._evalValue(readValueExpression({ selector: useSelector, ref: useRef }), sessionId, 10000).catch(() => undefined);
    const page = await this._pageInfoSafe();
    return {
      element: { tag: focus.tag, inputType: focus.inputType, contentEditable: focus.contentEditable === true },
      requested: value,
      value: read?.found ? read.value : focus.value,
      submitted: submit === true,
      url: page?.url,
      title: page?.title,
      autoLaunched: launched,
    };
  }

  async _pressEnter(sessionId) {
    const cdp = this.state.cdp;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
      isKeypad: false,
    }, { sessionId });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      isKeypad: false,
    }, { sessionId });
    await sleep(150);
  }

  /** 截图：默认落到 ~/.dsh/browser/shots/，也可指定 path。 */
  async screenshot({ path, full_page = false, format = 'png', quality } = {}) {
    const shotFormat = String(format ?? 'png').toLowerCase();
    if (!['png', 'jpeg'].includes(shotFormat)) throw new Error(`不支持的截图格式：${format}（只支持 png / jpeg）`);
    const { launched } = await this._ensurePage();
    const sessionId = this.state.sessionId;
    const cdp = this.state.cdp;
    const params = { format: shotFormat };
    if (shotFormat === 'jpeg') params.quality = clampInt(quality, 85, 1, 100);
    if (full_page === true) {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, { sessionId, timeoutMs: 10000 });
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size !== undefined) {
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        params.captureBeyondViewport = true;
      }
    }
    const shot = await cdp.send('Page.captureScreenshot', params, { sessionId, timeoutMs: 60000 });
    const buffer = Buffer.from(String(shot.data ?? ''), 'base64');
    if (buffer.length === 0) throw new Error('Chrome 返回了空截图');
    const isPng = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    const isJpeg = buffer.subarray(0, 3).equals(JPEG_SIGNATURE);
    if (shotFormat === 'png' && !isPng) throw new Error(`截图数据不是合法 PNG（前 8 字节：${buffer.subarray(0, 8).toString('hex')}）`);
    if (shotFormat === 'jpeg' && !isJpeg) throw new Error(`截图数据不是合法 JPEG（前 3 字节：${buffer.subarray(0, 3).toString('hex')}）`);
    const outputPath = path !== undefined && path !== null && String(path).trim() !== ''
      ? resolve(String(path))
      : join(this.shotsDir, `shot-${timestampSlug()}.${shotFormat === 'jpeg' ? 'jpg' : 'png'}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
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

  /** 在页面执行 JS 表达式。 */
  async evaluate(expression, { await_promise = true, timeout_ms } = {}) {
    if (typeof expression !== 'string' || expression.trim() === '') throw new Error('expression 不能为空');
    if (expression.length > 100000) throw new Error(`expression 太长（${expression.length} 字符，上限 100000）`);
    const timeoutMs = clampInt(timeout_ms, Math.max(30000, this.timeoutMs), 1000, 300000);
    const { launched } = await this._ensurePage();
    const sessionId = this.state.sessionId;
    let payload;
    try {
      payload = await this._evaluate(expression, {
        sessionId,
        awaitPromise: await_promise !== false,
        returnByValue: true,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof CdpError && /超时/u.test(error.message)) {
        await this.state.cdp.send('Runtime.terminateExecution', {}, { sessionId, timeoutMs: 3000 }).catch(() => {});
        throw new Error(
          `eval 超时（${timeoutMs}ms）。若页面在执行死循环，已尝试 Runtime.terminateExecution；` +
            '请改用更短的表达式或先重新导航页面。',
        );
      }
      throw error;
    }
    if (payload.exceptionDetails !== undefined) {
      const detail = payload.exceptionDetails;
      const description = detail.exception?.description ?? detail.text ?? '未知异常';
      return {
        ok: false,
        error: truncate(description, 2000),
        lineNumber: detail.lineNumber,
        columnNumber: detail.columnNumber,
        autoLaunched: launched,
      };
    }
    const result = payload.result ?? {};
    let value;
    let serialized;
    if (result.value !== undefined) {
      value = result.value;
      try {
        serialized = JSON.stringify(value);
      } catch {
        serialized = String(value);
      }
      if (serialized !== undefined && serialized.length > 100000) serialized = `${serialized.slice(0, 100000)}…（已截断）`;
    }
    return {
      ok: true,
      type: result.type,
      value,
      json: serialized,
      description: result.description,
      unserializableValue: result.unserializableValue,
      autoLaunched: launched,
    };
  }

  /** 标签页管理：list / new / activate / close。 */
  async tabs({ action = 'list', target_id, url } = {}) {
    const normalizedAction = String(action ?? 'list').toLowerCase();
    const { launched } = await this._ensurePage();
    const cdp = this.state.cdp;
    const listTargets = async () => {
      const targets = await cdp.send('Target.getTargets', {}, { timeoutMs: 10000 });
      return (targets.targetInfos ?? []).filter((target) => target.type === 'page');
    };
    if (normalizedAction === 'list') {
      const pages = await listTargets();
      return {
        tabs: pages.map((target, index) => ({
          index,
          targetId: target.targetId,
          url: target.url,
          title: target.title ?? '',
          current: target.targetId === this.state.targetId,
        })),
        autoLaunched: launched,
      };
    }
    if (normalizedAction === 'new') {
      const targetUrl = url === undefined || url === null || String(url).trim() === ''
        ? 'about:blank'
        : normalizeNavigationUrl(String(url));
      const created = await cdp.send('Target.createTarget', { url: targetUrl }, { timeoutMs: 15000 });
      await this._attachPage(created.targetId, { owned: this.state.owned });
      let loaded;
      if (targetUrl !== 'about:blank') loaded = await this._waitForLoad(this.state.sessionId, { timeoutMs: 15000 });
      const page = await this._pageInfoSafe();
      return {
        created: { targetId: created.targetId, url: page?.url ?? targetUrl, title: page?.title ?? '', loaded: loaded?.loaded },
        autoLaunched: launched,
      };
    }
    if (normalizedAction === 'activate') {
      if (typeof target_id !== 'string' || target_id === '') throw new Error('activate 需要 target_id（来自 browser_tabs list）');
      const pages = await listTargets();
      const target = pages.find((item) => item.targetId === target_id);
      if (target === undefined) throw new Error(`没有 target_id=${target_id} 的标签页（可能已关闭，请重新 browser_tabs list）`);
      await cdp.send('Target.activateTarget', { targetId: target_id }, { timeoutMs: 10000 });
      await this._attachPage(target_id, { owned: this.state.owned });
      await cdp.send('Page.bringToFront', {}, { sessionId: this.state.sessionId, timeoutMs: 5000 }).catch(() => {});
      const page = await this._pageInfoSafe();
      return { activated: { targetId: target_id, url: page?.url, title: page?.title }, autoLaunched: launched };
    }
    if (normalizedAction === 'close') {
      if (typeof target_id !== 'string' || target_id === '') throw new Error('close 需要 target_id（来自 browser_tabs list）');
      const pages = await listTargets();
      const target = pages.find((item) => item.targetId === target_id);
      if (target === undefined) throw new Error(`没有 target_id=${target_id} 的标签页（可能已关闭）`);
      if (pages.length === 1) throw new Error('这是最后一个标签页，关闭后浏览器将没有页面；请改用 browser_close 关闭浏览器');
      await cdp.send('Target.closeTarget', { targetId: target_id }, { timeoutMs: 10000 });
      if (target_id === this.state.targetId) {
        this.state.targetId = null;
        this.state.sessionId = null;
      }
      return { closed: { targetId: target_id, url: target.url }, autoLaunched: launched };
    }
    throw new Error(`未知 tabs action：${action}（支持 list / new / activate / close）`);
  }

  /** 扩展清单：扫描 profile（Preferences + Extensions），并标出运行中的扩展。 */
  async extensions({ include_component = false } = {}) {
    const includeComponent = booleanFlag(include_component, false);
    const profileDir = this.state.profileDir ?? this.profileDir;
    const scan = await loadExtensionsFromProfile(profileDir, { includeComponent });
    let running = [];
    let targetsError;
    if (this.isRunning()) {
      try {
        const targets = await this.state.cdp.send('Target.getTargets', {}, { timeoutMs: 5000 });
        running = runningExtensionTargets(targets.targetInfos ?? []);
      } catch (error) {
        targetsError = error.message;
      }
    }
    const runningIds = new Set(running.map((entry) => entry.id));
    const requested = (this.state.requestedExtensions ?? []).map((entry) => ({
      ...entry,
      running: runningIds.has(entry.id),
    }));
    return {
      running: this.isRunning(),
      mode: this.state.mode,
      profileDir,
      profileKind: this.state.tempProfile ? '临时' : this.state.mode === 'attach' ? '未知（attach）' : this.state.mode === null ? '未启动（默认持久 profile）' : '持久',
      scanned: scan.scanned,
      profileSubdir: scan.profileSubdir,
      extensions: scan.extensions.map((entry) => ({ ...entry, running: runningIds.has(entry.id) })),
      requested,
      allCount: scan.allCount ?? scan.extensions.length,
      runningExtensions: running,
      targetsError,
      includeComponent,
      autoLaunched: false,
    };
  }

  /** 关闭浏览器；attach 模式只断开连接。 */
  async close() {
    const wasRunning = this.isRunning();
    const child = this.state.child;
    const owned = this.state.owned;
    const tempProfile = this.state.tempProfile ? this.state.profileDir : null;
    const cdp = this.state.cdp;
    const closedMode = this.state.mode;
    if (!wasRunning && child === null) {
      return { closed: false, message: '浏览器本来就没有运行' };
    }
    this.state.closing = true;
    if (cdp !== null) {
      if (owned) await cdp.send('Browser.close', {}, { timeoutMs: 2000 }).catch(() => {});
      cdp.close();
    }
    if (child !== null && owned) {
      child.kill('SIGTERM');
      const exited = await new Promise((resolvePromise) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolvePromise(true);
          return;
        }
        const timer = setTimeout(() => resolvePromise(false), 2500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolvePromise(true);
        });
      });
      if (!exited) child.kill('SIGKILL');
    }
    this._resetState();
    if (tempProfile !== null) await this._cleanupTempProfile(tempProfile);
    log(`已关闭浏览器（${owned ? 'owned' : 'attach，仅断开'}）`);
    return {
      closed: true,
      owned,
      mode: closedMode,
      tempProfileRemoved: tempProfile !== null,
      message: owned
        ? tempProfile !== null
          ? '已关闭本插件启动的 Chrome 并清理临时 profile'
          : '已关闭本插件启动的 Chrome（持久 profile 保留）'
        : 'attach 模式：只断开了 CDP 连接，没有关闭你的 Chrome',
    };
  }

  async _cleanupTempProfile(profileDir) {
    const base = `${tmpdir()}/`;
    if (!String(profileDir).startsWith(base) || !String(profileDir).includes('dsh-browser-headless-')) {
      log(`拒绝删除非插件临时 profile：${profileDir}`);
      return;
    }
    await rm(profileDir, { recursive: true, force: true }).catch((error) => {
      log(`清理临时 profile 失败（${profileDir}）：${error.message}`);
    });
  }

  /** 进程退出时的同步兜底（不能 await）。 */
  disposeSync() {
    const cdp = this.state.cdp;
    if (cdp !== null) {
      try {
        cdp.close();
      } catch {
        // ignore
      }
    }
    const child = this.state.child;
    if (child !== null && this.state.owned) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    if (this._pendingChild !== null) {
      try {
        this._pendingChild.kill('SIGKILL');
      } catch {
        // ignore
      }
      this._pendingChild = null;
    }
    const tempProfile = this.state.tempProfile ? this.state.profileDir : null;
    if (tempProfile !== null) {
      const base = `${tmpdir()}/`;
      if (String(tempProfile).startsWith(base) && String(tempProfile).includes('dsh-browser-headless-')) {
        try {
          rmSync(tempProfile, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    this.state.child = null;
    this.state.cdp = null;
    this.state.tempProfile = false;
  }
}

/**
 * 判断是否是 Google Chrome 官方版（branded）。本机实测 156 官方版忽略
 * --load-extension / --disable-extensions-except；Chrome for Testing 148 正常加载。
 * 只用于给出准确提示，不影响启动参数。
 */
export function isBrandedGoogleChrome(chromePath) {
  if (typeof chromePath !== 'string' || chromePath === '') return false;
  if (/\/Google Chrome(?: Canary)?\.app\//u.test(chromePath)) return true;
  const base = chromePath.split('/').pop() ?? '';
  return base === 'google-chrome' || base === 'google-chrome-stable';
}

export { SUPPORTED_MODES, normalizeMode, isLoopbackHost, log };
