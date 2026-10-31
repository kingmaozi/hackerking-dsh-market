/**
 * 12 个 browser_* MCP 工具：JSON Schema + 调用 PlaywrightBrowserManager + 中文文本输出。
 * 文本输出面向模型：关键值（路径/URL/值）单独成行，便于后续工具解析。
 */

export const TOOL_DEFINITIONS = [
  {
    name: 'browser_status',
    description:
      '查看 Playwright 浏览器状态：是否运行、模式（headless/headed/attach）、Playwright 与 Chrome 版本、依赖是否安装、profile、当前页面。不会启动浏览器，也不会读 cookie。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_launch',
    description:
      '启动或切换 Playwright 浏览器。headless（默认，系统 Chrome 无窗口）、headed（可见窗口 + ~/.dsh/playwright-browser/profile 持久 profile）、attach（connectOverCDP 连接 127.0.0.1:9222 的 Chrome）。已在运行时可用 force 重启。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['headless', 'headed', 'attach'], description: '模式，默认取 PLAYWRIGHT_HEADLESS（默认 headless）' },
        headless: { type: 'boolean', description: '同时指定 headless/headed 的便捷参数（未给 mode 时生效）' },
        chrome_path: { type: 'string', description: 'Chrome 可执行文件绝对路径，覆盖 PLAYWRIGHT_CHROME_PATH' },
        attach_port: { type: 'integer', minimum: 1, maximum: 65535, description: 'attach 模式 CDP 端口，默认 9222' },
        profile_dir: { type: 'string', description: 'headed 模式持久 profile 目录' },
        force: { type: 'boolean', description: '已在运行时先关闭再重启' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '启动超时，默认 30000' },
      },
    },
  },
  {
    name: 'browser_navigate',
    description:
      '在当前标签页打开 URL（http/https/file/data/about:）。浏览器没启动时按默认模式自动启动。只导航，不点击、不提交表单。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '目标 URL；没写协议按 https:// 处理' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      '读取当前页面：标题、URL、正文，并给可交互元素打上 e1、e2… 的 ref。返回的 ref 供 browser_click / browser_type 使用；页面变化后 ref 失效，需要重新快照。不穿透跨域 iframe 与 shadow DOM。',
    inputSchema: {
      type: 'object',
      properties: {
        max_elements: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回多少个可交互元素，默认 120' },
        max_text_chars: { type: 'integer', minimum: 200, maximum: 60000, description: '正文最多返回多少字符，默认 4000' },
      },
    },
  },
  {
    name: 'browser_click',
    description:
      '点击元素：优先用 browser_snapshot 的 ref（e1、e2…），也可用 CSS selector。使用 Playwright locator 的可操作性等待（可见、稳定、可点击），超时会中文提示。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素 ref（来自 browser_snapshot），如 e3' },
        selector: { type: 'string', description: 'CSS 选择器；没有 ref 时使用' },
        double_click: { type: 'boolean', description: '双击，默认 false' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '操作超时，默认 30000' },
      },
    },
  },
  {
    name: 'browser_type',
    description:
      '向输入框/文本域/contenteditable 输入文本：优先用 ref，也可用 CSS selector。默认先用 fill 清空原内容；submit=true 时按 Enter（表单里通常就是提交）。不读取密码框内容。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素 ref（来自 browser_snapshot），如 e5' },
        selector: { type: 'string', description: 'CSS 选择器；没有 ref 时使用' },
        text: { type: 'string', description: '要输入的文字' },
        submit: { type: 'boolean', description: '输入后按 Enter，默认 false' },
        clear: { type: 'boolean', description: '输入前清空原内容，默认 true' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '操作超时，默认 30000' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      '截取当前页面 PNG/JPEG 并落盘（默认 ~/.dsh/playwright-browser/shots/），返回绝对路径、字节数、尺寸。full_page=true 截整页。只截当前页面。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出文件绝对路径；省略写到默认截图目录' },
        full_page: { type: 'boolean', description: '截整页，默认 false' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '格式，默认 png' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG 质量，默认 85' },
      },
    },
  },
  {
    name: 'browser_pdf',
    description:
      '把当前页面打印成 PDF（headless 专属；headed/attach 会明确报错）。默认 A4、打印背景、带页边距；返回绝对路径与字节数。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 PDF 绝对路径；省略写到 ~/.dsh/playwright-browser/pdf/' },
        format: { type: 'string', description: '纸张格式，默认 A4（如 Letter、A3）' },
        landscape: { type: 'boolean', description: '横向，默认 false' },
        print_background: { type: 'boolean', description: '打印背景，默认 true' },
      },
    },
  },
  {
    name: 'browser_eval',
    description:
      '在当前页面执行 JavaScript 表达式（Playwright page.evaluate），返回 JSON 结果。适合读 DOM/变量/计算；不要执行死循环或超长任务，不要用来绕过登录或读凭据。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS 表达式，例如 document.title' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '超时毫秒，默认 30000' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_wait',
    description:
      '等待页面条件：selector（默认等可见）、ms（固定等待）、url（等待 URL）、load_state（load/domcontentloaded/networkidle/commit）。至少给一个条件，超时返回中文错误。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        state: { type: 'string', enum: ['visible', 'attached', 'hidden', 'detached'], description: 'selector 的等待状态，默认 visible' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '超时毫秒，默认 30000' },
        ms: { type: 'integer', minimum: 1, maximum: 60000, description: '固定等待毫秒数（最多 60000）' },
        url: { type: 'string', description: '等待 URL（支持 Playwright 的 glob/正则字符串）' },
        load_state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'], description: '等待加载状态' },
      },
    },
  },
  {
    name: 'browser_tabs',
    description:
      '标签页管理：list 列出页面及 pageId（p1、p2…）；new 新建标签页（可带 url）；activate 切到 page_id/index；close 关闭 page_id/index（不能关最后一个）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'activate', 'close'], description: '操作，默认 list' },
        page_id: { type: 'string', description: 'activate/close 需要的 pageId（来自 list）' },
        index: { type: 'integer', minimum: 0, description: 'activate/close 也可用列表序号' },
        url: { type: 'string', description: 'new 时可选的初始 URL' },
      },
    },
  },
  {
    name: 'browser_close',
    description:
      '关闭本插件启动的 Playwright 浏览器；attach 模式只断开 CDP 连接，不关闭用户自己的 Chrome。headed 持久 profile 保留。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function autoNote(result) {
  return result?.autoLaunched === true ? '提示：浏览器之前没启动，本次已按默认模式自动启动。\n' : '';
}

function modeLabel(mode) {
  if (mode === 'headless') return 'headless（无窗口，系统 Chrome）';
  if (mode === 'headed') return 'headed（可见窗口，持久 profile）';
  if (mode === 'attach') return 'attach（connectOverCDP 连接已有 Chrome）';
  return '未启动';
}

function formatPage(page) {
  if (page === null || page === undefined) return '页面：<无>';
  return `页面：${page.title || '(无标题)'}\nURL：${page.url || '(空白页)'}`;
}

export function formatElement(element) {
  const attrs = [];
  if (element.type !== undefined && element.inputType === undefined) attrs.push(`type=${element.type}`);
  if (element.inputType !== undefined) attrs.push(`type=${element.inputType}`);
  if (element.role !== undefined) attrs.push(`role=${element.role}`);
  if (element.label !== undefined) attrs.push(`aria-label=${JSON.stringify(element.label)}`);
  if (element.placeholder !== undefined) attrs.push(`placeholder=${JSON.stringify(element.placeholder)}`);
  if (element.name !== undefined) attrs.push(`name=${JSON.stringify(element.name)}`);
  if (element.href !== undefined) attrs.push(`href=${element.href}`);
  if (element.value !== undefined) attrs.push(`value=${JSON.stringify(element.value)}`);
  if (element.checked !== undefined) attrs.push(`checked=${element.checked}`);
  if (element.selected !== undefined) attrs.push(`selected=${JSON.stringify(element.selected)}`);
  if (element.expanded !== undefined) attrs.push(`expanded=${element.expanded}`);
  if (element.contentEditable === true) attrs.push('contenteditable');
  if (element.disabled === true) attrs.push('disabled');
  const text = element.text === undefined || element.text === '' ? '""' : JSON.stringify(element.text);
  return `[${element.ref}] <${element.tag}> ${text}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}`;
}

export function formatStatus(status) {
  const lines = [];
  lines.push(`浏览器：${status.running ? `运行中（${modeLabel(status.mode)}）` : '未启动'}`);
  if (status.running) {
    lines.push(`接管：${status.owned ? '本插件启动（关闭时会一并退出）' : '外部 Chrome（close 只断开连接）'}`);
    lines.push(`Chrome：${status.browserVersion || '未知'}`);
    lines.push(`页面数：${status.pageCount}`);
    lines.push(`profile：${status.profileDir ?? '（headless 临时 profile）'}`);
    lines.push(formatPage(status.page));
  } else {
    lines.push(`默认模式：${modeLabel(status.config.defaultMode)}`);
    lines.push(`attach 端口：${status.config.attachPort}`);
    lines.push(`headed profile：${status.config.profileDir}`);
    if (status.chrome?.found) lines.push(`Chrome：${status.chrome.path}（${status.chrome.source}）`);
    else lines.push(`Chrome：不可用 —— ${status.chrome?.error ?? '未找到'}`);
  }
  lines.push(`Playwright：${status.playwrightVersion ? `playwright-core ${status.playwrightVersion}` : '不可用'}${status.dependency?.installed ? '（依赖已安装）' : `（${status.dependency?.error ?? '未安装'}）`}`);
  lines.push(`截图目录：${status.shotsDir}`);
  if (!status.running) lines.push('提示：browser_navigate 会自动按默认模式启动；也可显式 browser_launch。PDF 需要 headless 模式。');
  return lines.join('\n');
}

export function formatLaunch(result) {
  if (result.alreadyRunning === true) {
    return `${formatStatus(result)}\n（浏览器已经在运行；如需重启请加 force: true）`;
  }
  const lines = [];
  lines.push(`已启动浏览器：${modeLabel(result.mode)}`);
  lines.push(`Chrome：${result.browserVersion || '未知'}`);
  lines.push(`Playwright：playwright-core ${result.playwrightVersion || '未知'}`);
  lines.push(`Chrome 来源：${result.chromeSource || '未知'}`);
  lines.push(`profile：${result.profileKind}`);
  lines.push(formatPage(result.page));
  if (result.mode === 'headed') lines.push('注意：headed 会打开可见窗口；关闭用 browser_close，profile 会保留以便下次复用登录态。');
  if (result.mode === 'attach') lines.push('注意：attach 操作的是你已有的 Chrome；browser_close 只断开连接。');
  if (result.mode === 'headless') lines.push('注意：headless 使用 Playwright 内部临时 profile，不加载你的登录态。');
  return lines.join('\n');
}

export function formatNavigate(result) {
  const lines = [autoNote(result).trim()];
  lines.push(`已导航：${result.url}`);
  lines.push(`标题：${result.title || '(无标题)'}`);
  lines.push(`HTTP 状态：${result.status ?? '无（file/data 页面）'}`);
  lines.push('加载：完成（load 事件）');
  return lines.filter((line) => line !== '').join('\n');
}

export function formatSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return '页面快照失败：没有返回数据';
  const lines = [];
  lines.push(`标题：${snapshot.title || '(无标题)'}`);
  lines.push(`URL：${snapshot.url}`);
  lines.push(`视口：${snapshot.viewport?.width}×${snapshot.viewport?.height}，滚动高度 ${snapshot.scroll?.height}，iframe ${snapshot.frames} 个`);
  lines.push('');
  lines.push(`正文${snapshot.textTruncated ? '（已截断）' : ''}：`);
  lines.push(String(snapshot.text ?? '').trim() === '' ? '（页面没有可见文本）' : String(snapshot.text).trim());
  lines.push('');
  lines.push(`可交互元素 ${snapshot.elementsTotal} 个${snapshot.elementsCapReached ? '（已达到本次上限）' : ''}：`);
  if (snapshot.elementsTotal === 0) {
    lines.push('（没有可交互元素；可用 browser_eval 进一步检查 DOM）');
  } else {
    for (const element of snapshot.elements) lines.push(formatElement(element));
    lines.push('ref 只在当前页面状态有效；页面变化后请重新 browser_snapshot。');
  }
  return lines.join('\n');
}

export function formatClick(result) {
  const lines = [autoNote(result).trim()];
  lines.push(`已点击：${formatElement({ ...result.clicked, ref: result.clicked?.ref ?? '?' })}`);
  lines.push(`双击：${result.doubleClick === true ? '是' : '否'}`);
  lines.push(formatPage({ url: result.url, title: result.title }));
  lines.push('如页面已变化，需要新 ref 时请重新 browser_snapshot。');
  return lines.filter((line) => line !== '').join('\n');
}

export function formatType(result) {
  const lines = [autoNote(result).trim()];
  const tag = result.element?.tag ?? '?';
  const type = result.element?.inputType ? `[${result.element.inputType}]` : '';
  lines.push(`已输入 ${String(result.requested ?? '').length} 个字符到 <${tag}>${type}`);
  lines.push(`当前值：${JSON.stringify(result.value ?? '')}`);
  lines.push(`提交：${result.submitted ? '已按 Enter' : '未提交（submit=false）'}`);
  lines.push(formatPage({ url: result.url, title: result.title }));
  return lines.filter((line) => line !== '').join('\n');
}

export function formatScreenshot(result) {
  const lines = [autoNote(result).trim()];
  lines.push(`截图已保存：${result.path}`);
  lines.push(`大小：${result.bytes} 字节（${result.bytesText}）`);
  if (result.width !== undefined) lines.push(`尺寸：${result.width}×${result.height}`);
  lines.push(`格式：${result.format}${result.fullPage ? '（整页）' : ''}`);
  if (result.url !== undefined) lines.push(`页面：${result.url}`);
  return lines.filter((line) => line !== '').join('\n');
}

export function formatPdf(result) {
  const lines = [autoNote(result).trim()];
  lines.push(`PDF 已生成：${result.path}`);
  lines.push(`大小：${result.bytes} 字节（${result.bytesText}）`);
  lines.push(`格式：${result.format}${result.landscape ? '（横向）' : ''}`);
  if (result.url !== undefined) lines.push(`页面：${result.url}`);
  return lines.filter((line) => line !== '').join('\n');
}

export function formatEval(result) {
  if (result.ok !== true) return `eval 报错：${result.error}`;
  const lines = [`eval 结果（${result.type}）：`];
  if (result.json !== undefined) lines.push(result.json);
  else if (result.value === undefined) lines.push('undefined');
  else lines.push(String(result.value));
  return lines.join('\n');
}

export function formatWait(result) {
  const lines = [autoNote(result).trim()];
  lines.push(`已等待：${(result.waited ?? []).join('，') || '（无条件）'}`);
  lines.push(formatPage({ url: result.url, title: result.title }));
  return lines.filter((line) => line !== '').join('\n');
}

export function formatTabs(result) {
  if (Array.isArray(result.tabs)) {
    const lines = [`标签页 ${result.tabs.length} 个：`];
    for (const tab of result.tabs) {
      lines.push(`${tab.current ? '*' : ' '} [${tab.index}] ${tab.title || '(无标题)'}\n    ${tab.url}\n    pageId=${tab.pageId}`);
    }
    return lines.join('\n');
  }
  if (result.created !== undefined) {
    return `已新建标签页：${result.created.url}${result.created.title ? `（${result.created.title}）` : ''}\npageId=${result.created.pageId}`;
  }
  if (result.activated !== undefined) {
    return `已切换到标签页：${result.activated.url}\n标题：${result.activated.title || '(无标题)'}\npageId=${result.activated.pageId}`;
  }
  if (result.closed !== undefined) {
    return `已关闭标签页：${result.closed.url}\npageId=${result.closed.pageId}\n剩余页面：${result.pageCount}`;
  }
  return JSON.stringify(result, null, 2);
}

export function formatClose(result) {
  if (result.closed !== true) return result.message ?? '浏览器未运行';
  return result.message;
}

/**
 * 创建工具处理函数表。
 * @param {import('./browser.mjs').PlaywrightBrowserManager} manager
 */
export function createToolHandlers(manager) {
  return {
    browser_status: async () => formatStatus(await manager.status()),
    browser_launch: async (args) => formatLaunch(await manager.launch(args)),
    browser_navigate: async (args) => formatNavigate(await manager.navigate(args.url)),
    browser_snapshot: async (args) => formatSnapshot(await manager.snapshot({
      max_elements: args.max_elements,
      max_text_chars: args.max_text_chars,
    })),
    browser_click: async (args) => formatClick(await manager.click({
      ref: args.ref,
      selector: args.selector,
      double_click: args.double_click,
      timeout_ms: args.timeout_ms,
    })),
    browser_type: async (args) => formatType(await manager.type({
      ref: args.ref,
      selector: args.selector,
      text: args.text,
      submit: args.submit,
      clear: args.clear,
      timeout_ms: args.timeout_ms,
    })),
    browser_screenshot: async (args) => formatScreenshot(await manager.screenshot({
      path: args.path,
      full_page: args.full_page,
      format: args.format,
      quality: args.quality,
    })),
    browser_pdf: async (args) => formatPdf(await manager.pdf({
      path: args.path,
      format: args.format,
      landscape: args.landscape,
      print_background: args.print_background,
    })),
    browser_eval: async (args) => formatEval(await manager.evaluate(args.expression, {
      timeout_ms: args.timeout_ms,
    })),
    browser_wait: async (args) => formatWait(await manager.wait({
      selector: args.selector,
      state: args.state,
      timeout_ms: args.timeout_ms,
      ms: args.ms,
      url: args.url,
      load_state: args.load_state,
    })),
    browser_tabs: async (args) => formatTabs(await manager.tabs({
      action: args.action,
      page_id: args.page_id,
      index: args.index,
      url: args.url,
    })),
    browser_close: async () => formatClose(await manager.close()),
  };
}
