/**
 * 内置浏览器 AI 源（豆包 / Gemini）页面内脚本。
 *
 * 设计约束（与市场版一致）：
 * - 只在宿主主会话的内置浏览器运行时导入（ZCode Browser Use / MiniMax Code 内置浏览器）；不要放进 stdio MCP 进程。
 * - 页面函数必须是纯函数：evaluate 会序列化源码，不能捕获闭包变量。
 * - 不读取 cookie / localStorage / 签名请求；只做导航、输入、点击与正文提取。
 */

/** 豆包链接是 link.wtturl.cn 包装，真实地址在 target 参数。 */
export function decodeDoubaoLink(href) {
  try {
    const url = new URL(href);
    if (/wtturl\.cn$/.test(url.hostname)) {
      const target = url.searchParams.get("target");
      if (target) return decodeURIComponent(target);
    }
    return href;
  } catch {
    return href;
  }
}

/** 各站点的编辑器选择器。Gemini 用 Quill（div.ql-editor），豆包用裸 contenteditable。 */
const EDITOR_SELECTOR = {
  doubao: '[contenteditable="true"]',
  gemini: 'div.ql-editor',
};

const PAGE = {
  /** 豆包：写入输入框并用官方发送按钮提交（Enter 不可靠）。 */
  doubaoSubmit: (query) => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return { ok: false, reason: "editor-not-ready" };
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, query);
    if ((el.textContent || "").length < query.length) return { ok: false, reason: "write-failed" };
    const btn = document.querySelector("#flow-end-msg-send");
    if (!btn || btn.disabled) return { ok: false, reason: "send-unavailable" };
    btn.click();
    return { ok: true, len: (el.textContent || "").length };
  },

  /** Gemini：写入并点击发送按钮。 */
  geminiSubmit: (query) => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return { ok: false, reason: "editor-not-ready" };
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, query);
    if ((el.textContent || "").length < query.length) return { ok: false, reason: "write-failed" };
    const btn = [...document.querySelectorAll('button[aria-label="发送"],button[aria-label*="发送"],button[aria-label*="Send"]')]
      .find((b) => !b.disabled && b.getClientRects().length);
    if (!btn) return { ok: false, reason: "send-unavailable" };
    btn.click();
    return { ok: true, len: (el.textContent || "").length };
  },

  /** 判定 AI 回答是否生成完成：正文长度稳定且已包含用户问题片段。 */
  aiStatus: (fragment) => {
    const main = document.querySelector("main") || document.body;
    const text = main.innerText || "";
    return {
      len: text.length,
      hasFragment: text.includes(fragment),
      generating: /正在生成|停止生成|Stop responding/i.test(text),
      tail: text.slice(-400),
    };
  },

  /** 提取结果：有限正文 + 外链，排除侧边历史。 */
  extractAnswer: (fragment) => {
    const main = document.querySelector("main") || document.body;
    const text = main.innerText || "";
    const idx = text.indexOf(fragment);
    const answer = idx >= 0 ? text.slice(idx + fragment.length) : text.slice(-3000);
    const links = [...main.querySelectorAll("a[href]")]
      .filter((a) => /^https?:$/.test(a.protocol))
      .map((a) => a.href);
    return {
      answer: answer.trim().slice(0, 6000),
      links: [...new Set(links)].slice(0, 12),
      capturedAt: new Date().toISOString(),
    };
  },
};

export const AI_SOURCES = {
  doubao: { submit: PAGE.doubaoSubmit, url: "https://www.doubao.com/chat/" },
  gemini: { submit: PAGE.geminiSubmit, url: "https://gemini.google.com/app" },
};

export const PAGE_FUNCTIONS = PAGE;

/** 提交并采集单个 AI 源。返回结构化证据，标签页清理由调用方负责。 */
/**
 * 用真实键盘输入并回车提交。
 *
 * 实测（ZCode 内置浏览器，2026-09-13）：
 * - `execCommand('insertText')` + 点击发送按钮：页面显示已写入且按钮可点，
 *   但框架状态未更新，点击无效、不创建会话。
 * - Playwright 真实键盘输入 + Enter：可靠创建会话（豆包跳转到 /chat/<id>）。
 * 因此这里统一用真实键盘事件，不依赖页面内 execCommand。
 */
async function submitByKeyboard(tab, source, query) {
  const selector = EDITOR_SELECTOR[source] || '[contenteditable="true"]';
  const editor = tab.playwright.locator(selector).first();
  if ((await editor.count()) < 1) return { ok: false, reason: "editor-not-found" };

  // 先聚焦并清空，再用真实键盘输入（execCommand 不会让框架更新状态）。
  await tab.playwright.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.focus();
  }, selector);
  for (const key of ["Meta+a", "Delete"]) {
    try { await editor.press(key); } catch {}
  }
  try {
    await editor.type(query, { delay: 25 });
  } catch {
    // 定位器不可交互时退回焦点注入（Angular/Quill 组件常见）。
    await tab.playwright.evaluate((sel, text) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      el.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = text;
      el.appendChild(p);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }, selector, query);
  }

  const typed = await tab.playwright.evaluate(
    (sel) => (document.querySelector(sel)?.textContent || "").trim(),
    selector
  );
  if (typed.length < query.length * 0.8) return { ok: false, reason: "write-failed" };

  await tab.playwright.waitForTimeout(1200);
  // 提交策略：先试发送按钮（对 Quill 更可靠），再退回 Enter。
  const clicked = await tab.playwright.evaluate(() =>
    Boolean(
      (() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => /^(发送|Send)$/i.test((x.getAttribute("aria-label") || "").trim()) && !x.disabled && x.getClientRects().length
        );
        if (!b) return false;
        b.click();
        return true;
      })()
    )
  );
  if (!clicked) {
    try { await editor.press("Enter"); } catch {
      try { await tab.dom_cua.keypress({ keys: ["Enter"] }); } catch {}
    }
  }
  return { ok: true, via: clicked ? "send-button" : "enter" };
}

/**
 * 等待 AI 回答稳定。
 * 豆包做多步任务（先检索再生成图表）可能超过 1 分钟，因此默认上限放宽到 150 秒。
 */
export async function waitForAnswer(tab, fragment, { timeoutMs = 150000, settleMs = 5000, minLength = 300 } = {}) {
  const started = Date.now();
  let prev = null;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    await tab.playwright.waitForTimeout(settleMs);
    const cur = await tab.playwright.evaluate(PAGE.aiStatus, fragment);
    const working = /停止生成|正在生成|生成中|先搜索|读取.*技能/i.test(cur.tail || "");
    if (working) { stable = 0; prev = cur; continue; }
    if (prev && cur.len === prev.len && cur.len >= minLength) {
      stable += 1;
      if (stable >= 2) return { ready: true, status: cur };
    } else {
      stable = 0;
    }
    prev = cur;
  }
  return { ready: false, status: prev };
}

export async function queryAiSource(browser, source, query, tabId = null) {
  const conf = AI_SOURCES[source];
  if (!conf) throw new Error(`未知 AI 源: ${source}`);
  const tab = tabId ? await browser.tabs.get(tabId) : await browser.tabs.new();
  const created = !tabId;
  if (created) {
    await tab.goto(conf.url);
    await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
    await tab.playwright.waitForTimeout(3500);
  }
  const submitted = await submitByKeyboard(tab, source, query);
  if (!submitted.ok) {
    return { source, ok: false, reason: submitted.reason, tabId: tab.id, conversationUrl: null };
  }
  const conversationUrl = await tab.url();
  const waited = await waitForAnswer(tab, query.slice(0, 12));
  const raw = await tab.playwright.evaluate(PAGE.extractAnswer, query.slice(0, 12));
  return {
    source,
    ok: Boolean(raw.answer),
    settled: waited.ready,
    answer: raw.answer,
    links: source === "doubao" ? raw.links.map(decodeDoubaoLink) : raw.links,
    tabId: tab.id,
    // 会话在服务端持久化：即使标签被释放，也可用该 URL 重新打开采集。
    conversationUrl,
    createdTab: created,
  };
}

/** 用已持久化的会话 URL 重新采集（标签被释放后的续读路径）。 */
export async function collectFromUrl(browser, source, conversationUrl) {
  const tab = await browser.tabs.new();
  await tab.goto(conversationUrl);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
  await tab.playwright.waitForTimeout(6000);
  const raw = await tab.playwright.evaluate(PAGE.extractAnswer, "");
  return {
    source,
    ok: Boolean(raw.answer),
    answer: raw.answer,
    links: source === "doubao" ? raw.links.map(decodeDoubaoLink) : raw.links,
    tabId: tab.id,
    createdTab: true,
  };
}
