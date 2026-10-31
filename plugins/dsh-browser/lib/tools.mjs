/**
 * 11 个 browser_* MCP 工具：JSON Schema 定义 + 调用 BrowserManager + 中文文本输出。
 * 文本输出面向模型：关键值单独成行（路径、URL、值），方便后续工具解析。
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'browser_status',
    description:
      '查看浏览器状态：是否已启动、模式（headless/chrome/attach）、Chrome 版本、CDP 端口、profile 位置、当前页面。不会启动浏览器，也不会读 cookie。第一次用浏览器前可先查。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_launch',
    description:
      '启动或切换浏览器。默认 headless（临时 profile、不可见）；chrome 模式开可见窗口并用 ~/.dsh/browser/chrome-profile 持久 profile（可加载扩展）；attach 模式连接 127.0.0.1:9222 上已开启远程调试的 Chrome。已在运行时可 force 重启。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['headless', 'chrome', 'attach'], description: '运行模式，默认取 BROWSER_MODE 或 headless' },
        chrome_path: { type: 'string', description: 'Chrome 二进制绝对路径，覆盖自动发现' },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'chrome 模式下要加载的解包扩展目录（绝对路径，需含 manifest.json）',
        },
        profile_dir: { type: 'string', description: 'chrome 模式的持久 profile 目录；attach 模式只用于扩展清单扫描' },
        port: { type: 'integer', description: 'attach 模式的 CDP 端口，默认 9222' },
        force: { type: 'boolean', description: '已在运行时先关闭再重启' },
      },
    },
  },
  {
    name: 'browser_navigate',
    description:
      '在当前标签页打开 URL（http/https/file/data/about:）。浏览器没启动时会按默认模式自动启动。只做导航，不点击、不提交表单。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL；没写协议时按 https:// 处理' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      '读取当前页面：标题、URL、正文文本，并给可交互元素（链接/按钮/输入框等）打上 e1、e2… 的 ref。返回的 ref 供 browser_click / browser_type 使用；页面变化后 ref 会失效，需要重新快照。不能读取跨域 iframe 内部。',
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
      '点击元素：优先用 browser_snapshot 返回的 ref（e1、e2…），也可用 CSS selector。发送真实鼠标事件（不是 JS .click()），会先滚动到可见。点击后页面可能变化，需要新 ref 时重新 browser_snapshot。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素 ref（来自 browser_snapshot），如 e3' },
        selector: { type: 'string', description: 'CSS 选择器；没有 ref 时使用' },
        double_click: { type: 'boolean', description: '双击，默认 false' },
      },
    },
  },
  {
    name: 'browser_type',
    description:
      '向输入框/文本域/contenteditable 输入文本：优先用 ref，也可用 CSS selector。默认先清空原内容；submit=true 时输入后按 Enter（表单里通常就是提交）。不会读取密码框内容。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素 ref（来自 browser_snapshot），如 e5' },
        selector: { type: 'string', description: 'CSS 选择器；没有 ref 时使用' },
        text: { type: 'string', description: '要输入的文字' },
        submit: { type: 'boolean', description: '输入后按 Enter，默认 false' },
        clear: { type: 'boolean', description: '输入前清空原内容，默认 true' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      '截取当前页面 PNG/JPEG 并落盘（默认 ~/.dsh/browser/shots/），返回绝对路径、字节数和尺寸。full_page=true 截整页。只截当前页面，不批量截全部标签页。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出文件绝对路径；省略则写到默认截图目录' },
        full_page: { type: 'boolean', description: '截整页（含滚动区域），默认 false' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG 质量，默认 85' },
      },
    },
  },
  {
    name: 'browser_eval',
    description:
      '在当前页面执行 JavaScript 表达式（Runtime.evaluate，awaitPromise + returnByValue），返回 JSON 结果。适合读 DOM/变量/计算；不要执行死循环或超长任务，不要用来绕过登录或读凭据。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS 表达式，例如 document.title' },
        await_promise: { type: 'boolean', description: '等待 Promise 结果，默认 true' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: '超时毫秒，默认 30000' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_tabs',
    description:
      '标签页管理：list 列出所有页面标签并标出当前页；new 新建标签页（可带 url）；activate 切到指定 target_id；close 关闭指定标签页（不能关最后一个）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'activate', 'close'], description: '操作，默认 list' },
        target_id: { type: 'string', description: 'activate/close 需要的 targetId（来自 list）' },
        url: { type: 'string', description: 'new 时可选的初始 URL' },
      },
    },
  },
  {
    name: 'browser_extensions',
    description:
      '列出 profile 里已安装的扩展（名称/版本/路径/解包或打包），并标出正在运行的扩展。只读 manifest 与 Preferences，不读 cookie/凭据。headless 模式是临时 profile，没有用户扩展；要看扩展请用 chrome 模式并配置 BROWSER_EXTENSIONS。',
    inputSchema: {
      type: 'object',
      properties: {
        include_component: { type: 'boolean', description: '是否包含 Chrome 内置组件扩展，默认 false' },
      },
    },
  },
  {
    name: 'browser_close',
    description:
      '关闭本插件启动的 Chrome 并清理临时 profile；attach 模式只断开 CDP 连接，不关闭用户自己的 Chrome。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function autoNote(result) {
  return result?.autoLaunched === true ? '提示：浏览器之前没启动，本次已按默认模式自动启动。\n' : '';
}

function modeLabel(mode) {
  if (mode === 'headless') return 'headless（无头，临时 profile）';
  if (mode === 'chrome') return 'chrome（可见窗口，持久 profile）';
  if (mode === 'attach') return 'attach（连接已有 Chrome）';
  return '未启动';
}

function formatPage(page) {
  if (page === null || page === undefined) return '页面：<无>';
  return `页面：${page.title || '(无标题)'}\nURL：${page.url || '(空白页)'}`;
}

export function formatElement(element) {
  const attrs = [];
  if (element.type !== undefined) attrs.push(`type=${element.type}`);
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
    lines.push(`Chrome：${status.chromeVersion || '未知'}，CDP 端口 ${status.devtoolsPort}`);
    lines.push(`profile：${status.profileDir}（${status.profileKind}）`);
    lines.push(formatPage(status.page));
  } else {
    lines.push(`默认模式：${modeLabel(status.config.defaultMode)}`);
    lines.push(`attach 端口：${status.config.attachPort}`);
    lines.push(`profile 目录：${status.config.profileDir}（chrome 模式使用；headless 用临时 profile）`);
    const chrome = status.chromeAvailable;
    if (chrome?.path) lines.push(`Chrome：${chrome.path}（${chrome.source}）`);
    else lines.push(`Chrome：不可用 —— ${chrome?.error ?? '未找到'}`);
  }
  lines.push(`截图目录：${status.config.shotsDir}`);
  lines.push(`扩展目录（BROWSER_EXTENSIONS）：${status.config.extensions.length > 0 ? status.config.extensions.join(':') : '未配置'}`);
  if (!status.running) lines.push('提示：调用 browser_navigate 会自动按默认模式启动；也可显式 browser_launch。');
  return lines.join('\n');
}

export function formatLaunch(result) {
  if (result.alreadyRunning === true) {
    return `${formatStatus(result)}\n（浏览器已经在运行；如需重启请加 force: true）`;
  }
  const lines = [];
  lines.push(`已启动浏览器：${modeLabel(result.mode)}`);
  lines.push(`Chrome：${result.chromeVersion || '未知'}`);
  lines.push(`CDP：127.0.0.1:${result.devtoolsPort}`);
  lines.push(`profile：${result.profileDir}（${result.profileKind}）`);
  if (Array.isArray(result.extensions) && result.extensions.length > 0) {
    lines.push(`请求加载扩展：${result.extensions.join('、')}`);
  }
  if (Array.isArray(result.extensionEvidence) && result.extensionEvidence.length > 0) {
    const observed = result.extensionEvidence.filter((entry) => entry.running).length;
    lines.push(`扩展加载证据：${observed}/${result.extensionEvidence.length} 个在 CDP target 里观察到运行（没有后台 worker 的扩展不会出现）`);
    for (const entry of result.extensionEvidence) {
      lines.push(`- id=${entry.id} ${entry.running ? '运行中' : '未观察到'} 路径=${entry.path}`);
    }
  }
  if (typeof result.extensionsWarning === 'string' && result.extensionsWarning !== '') {
    lines.push(`注意：${result.extensionsWarning}`);
  }
  if (result.extensionsIgnoredInHeadless === true) {
    lines.push('注意：headless 模式不加载扩展；需要扩展请用 chrome 模式。');
  }
  lines.push(formatPage(result.page));
  if (result.mode === 'chrome') {
    lines.push('注意：chrome 模式会打开可见窗口；关闭请用 browser_close，避免残留窗口。');
  }
  if (result.mode === 'attach') {
    lines.push('注意：attach 模式操作的是你已有的 Chrome；browser_close 只断开连接。');
  }
  return lines.join('\n');
}

export function formatNavigate(result) {
  const lines = [];
  lines.push(autoNote(result).trim());
  lines.push(`已导航：${result.url}`);
  lines.push(`标题：${result.title || '(无标题)'}`);
  lines.push(`加载：${result.loaded ? `完成（${result.readyState}）` : `未在 15 秒内完成（${result.readyState}），页面可能仍在加载或为长连接页面`}`);
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
  const lines = [];
  lines.push(autoNote(result).trim());
  lines.push(`已点击：${formatElement(result.clicked ?? { ref: '?', tag: '?' })}`);
  lines.push(`坐标：${result.x},${result.y}${result.doubleClick ? '（双击）' : ''}`);
  lines.push(formatPage({ url: result.url, title: result.title }));
  lines.push('如页面已变化，需要新 ref 时请重新 browser_snapshot。');
  return lines.filter((line) => line !== '').join('\n');
}

export function formatType(result) {
  const lines = [];
  lines.push(autoNote(result).trim());
  const tag = result.element?.tag ?? '?';
  const type = result.element?.inputType ? `[${result.element.inputType}]` : '';
  lines.push(`已输入 ${String(result.requested ?? '').length} 个字符到 <${tag}>${type}`);
  lines.push(`当前值：${JSON.stringify(result.value ?? '')}`);
  lines.push(`提交：${result.submitted ? '已按 Enter' : '未提交（submit=false）'}`);
  lines.push(formatPage({ url: result.url, title: result.title }));
  return lines.filter((line) => line !== '').join('\n');
}

export function formatScreenshot(result) {
  const lines = [];
  lines.push(autoNote(result).trim());
  lines.push(`截图已保存：${result.path}`);
  lines.push(`大小：${result.bytes} 字节（${result.bytesText}）`);
  if (result.width !== undefined) lines.push(`尺寸：${result.width}×${result.height}`);
  lines.push(`格式：${result.format}${result.fullPage ? '（整页）' : ''}`);
  if (result.url !== undefined) lines.push(`页面：${result.url}`);
  return lines.filter((line) => line !== '').join('\n');
}

export function formatEval(result) {
  if (result.ok !== true) {
    return `eval 报错：${result.error}`;
  }
  const lines = [];
  lines.push(`eval 结果（${result.type}）：`);
  if (result.json !== undefined) lines.push(result.json);
  else if (result.unserializableValue !== undefined) lines.push(result.unserializableValue);
  else if (result.description !== undefined) lines.push(result.description);
  else lines.push('undefined');
  return lines.join('\n');
}

export function formatTabs(result) {
  if (Array.isArray(result.tabs)) {
    const lines = [`标签页 ${result.tabs.length} 个：`];
    for (const tab of result.tabs) {
      lines.push(`${tab.current ? '*' : ' '} [${tab.index}] ${tab.title || '(无标题)'}\n    ${tab.url}\n    targetId=${tab.targetId}`);
    }
    return lines.join('\n');
  }
  if (result.created !== undefined) {
    return `已新建标签页：${result.created.url}${result.created.title ? `（${result.created.title}）` : ''}\n加载：${result.created.loaded === true ? '完成' : '未等待完成'}\ntargetId=${result.created.targetId}`;
  }
  if (result.activated !== undefined) {
    return `已切换到标签页：${result.activated.url}\n标题：${result.activated.title || '(无标题)'}\ntargetId=${result.activated.targetId}`;
  }
  if (result.closed !== undefined) {
    return `已关闭标签页：${result.closed.url}\ntargetId=${result.closed.targetId}`;
  }
  return JSON.stringify(result, null, 2);
}

export function formatExtensions(result) {
  const lines = [];
  lines.push(`运行状态：${result.running ? `已启动（${modeLabel(result.mode)}）` : '未启动'}`);
  lines.push(`profile：${result.profileDir}（${result.profileKind}）`);
  if (result.scanned !== true) {
    lines.push('profile 目录不存在或还没有 Default 配置：该 profile 尚未被 chrome 模式启动过。');
  } else {
    lines.push(`已安装扩展 ${result.extensions.length} 个（默认不含 Chrome 内置组件；scan 到 ${result.allCount} 个）：`);
    if (result.extensions.length === 0) lines.push('（没有找到用户扩展）');
    for (const extension of result.extensions) {
      lines.push(`- ${extension.name} v${extension.version || '?'}（${extension.locationLabel}${extension.unpacked ? '，解包' : ''}${extension.running ? '，运行中' : ''}）`);
      lines.push(`  id=${extension.id}`);
      if (extension.path) lines.push(`  路径=${extension.path}`);
    }
  }
  if (Array.isArray(result.requested) && result.requested.length > 0) {
    lines.push('本会话请求加载的扩展（chrome 模式）：');
    for (const entry of result.requested) {
      lines.push(`- id=${entry.id} ${entry.running ? '运行中（CDP target 已观察到）' : '未观察到扩展进程'} 路径=${entry.path}`);
    }
    lines.push('说明：只有带 background/service worker 的扩展会出现在 CDP target 列表；没观察到不等于没加载。');
  }
  if (result.runningExtensions.length > 0) {
    lines.push('运行中的扩展 target：');
    for (const running of result.runningExtensions) lines.push(`- ${running.id}（${running.types.join('/')}）`);
  } else if (result.running) {
    lines.push('运行中的扩展 target：无');
  }
  if (result.targetsError !== undefined) lines.push(`读取运行中扩展失败：${result.targetsError}`);
  if (result.mode === 'headless') {
    lines.push('提示：headless 使用临时 profile，不加载用户扩展；需要扩展请用 chrome 模式 + BROWSER_EXTENSIONS。');
  }
  if (result.mode === 'attach') {
    lines.push('提示：attach 模式无法确认外部 Chrome 实际使用的 profile，扩展清单可能与该 Chrome 不一致。');
  }
  return lines.join('\n');
}

export function formatClose(result) {
  if (result.closed !== true) return result.message ?? '浏览器未运行';
  const lines = [result.message];
  if (result.tempProfileRemoved === true) lines.push('已清理临时 profile 目录。');
  return lines.join('\n');
}

/**
 * 创建工具处理函数表。
 * @param {import('./browser.mjs').BrowserManager} manager
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
    })),
    browser_type: async (args) => formatType(await manager.type({
      ref: args.ref,
      selector: args.selector,
      text: args.text,
      submit: args.submit,
      clear: args.clear,
    })),
    browser_screenshot: async (args) => formatScreenshot(await manager.screenshot({
      path: args.path,
      full_page: args.full_page,
      format: args.format,
      quality: args.quality,
    })),
    browser_eval: async (args) => formatEval(await manager.evaluate(args.expression, {
      await_promise: args.await_promise,
      timeout_ms: args.timeout_ms,
    })),
    browser_tabs: async (args) => formatTabs(await manager.tabs({
      action: args.action,
      target_id: args.target_id,
      url: args.url,
    })),
    browser_extensions: async (args) => formatExtensions(await manager.extensions({
      include_component: args.include_component,
    })),
    browser_close: async () => formatClose(await manager.close()),
  };
}

