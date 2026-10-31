/**
 * 注入页面的脚本（字符串）。所有函数自带依赖，通过 Function.prototype.toString
 * 序列化后由 Runtime.evaluate 执行，避免手写转义。
 */

/** 页面快照：给可交互元素打 data-dsh-ref，收集正文与元素清单。 */
function pageSnapshot(maxElements, maxTextChars) {
  for (const stale of document.querySelectorAll('[data-dsh-ref]')) stale.removeAttribute('data-dsh-ref');

  const QUERY = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[onclick]',
  ].join(',');

  const clip = function (value, max) {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
  };

  const isVisible = function (el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const elements = [];
  for (const el of document.querySelectorAll(QUERY)) {
    if (elements.length >= maxElements) break;
    if (!isVisible(el)) continue;
    const ref = 'e' + (elements.length + 1);
    el.setAttribute('data-dsh-ref', ref);
    const tag = el.tagName.toLowerCase();
    const entry = { ref: ref, tag: tag };
    const role = el.getAttribute('role');
    if (role) entry.role = role;
    if (el.type) entry.type = String(el.type);
    const name = el.getAttribute('name');
    if (name) entry.name = clip(name, 40);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) entry.placeholder = clip(placeholder, 60);
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) entry.label = clip(ariaLabel, 60);
    const rawText = el.innerText || el.getAttribute('title') || (tag === 'input' ? '' : String(el.value === undefined ? '' : el.value));
    entry.text = clip(rawText, 80);
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) entry.href = clip(href, 160);
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type !== 'password') {
        const value = String(el.value === undefined ? '' : el.value);
        if (value !== '') entry.value = clip(value, 80);
      } else if (String(el.value === undefined ? '' : el.value) !== '') {
        entry.value = '***（password 已隐藏）';
      }
      if (el.type === 'checkbox' || el.type === 'radio') entry.checked = Boolean(el.checked);
      if (tag === 'select') {
        try {
          entry.selected = clip(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '', 60);
        } catch (error) {
          // ignore
        }
      }
    }
    if (el.disabled) entry.disabled = true;
    if (el.getAttribute('aria-expanded') !== null) entry.expanded = el.getAttribute('aria-expanded');
    if (el.isContentEditable) entry.contentEditable = true;
    elements.push(entry);
  }

  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const text = bodyText.length > maxTextChars ? bodyText.slice(0, maxTextChars) : bodyText;
  return {
    url: location.href,
    title: document.title,
    text: text,
    textTruncated: bodyText.length > maxTextChars,
    elements: elements,
    elementsTotal: elements.length,
    elementsCapReached: elements.length >= maxElements,
    frames: document.querySelectorAll('iframe').length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), height: document.documentElement.scrollHeight },
  };
}

/** 解析 ref/selector → 元素信息 + 点击坐标（滚动到可见后测量）。 */
function pageResolveTarget(selector, ref) {
  let el = null;
  if (ref) {
    el = document.querySelector('[data-dsh-ref="' + ref + '"]');
  } else if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (error) {
      return { found: false, reason: 'CSS 选择器不合法：' + String(error && error.message ? error.message : error) };
    }
  } else {
    return { found: false, reason: '需要 ref 或 selector' };
  }
  if (!el) {
    return {
      found: false,
      reason: ref
        ? '页面里没有 ref=' + ref + ' 的元素（页面可能已导航或 DOM 已变化，请重新 browser_snapshot）'
        : '没有匹配选择器的元素：' + selector,
    };
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  const tag = el.tagName.toLowerCase();
  const info = { tag: tag };
  const text = el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  if (text) info.text = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
  if (tag === 'a') info.href = String(el.getAttribute('href') || '').slice(0, 200);
  if (tag === 'input' || tag === 'textarea') {
    info.inputType = String(el.type || tag);
    info.value = el.type === 'password' ? '***' : String(el.value === undefined ? '' : el.value).slice(0, 100);
  }
  return {
    found: true,
    visible: visible,
    rect: {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
    },
    info: info,
  };
}

/** 聚焦输入元素并准备输入（可选择清空）。ref 优先于 selector。 */
function pageFocusTarget(selector, ref, clear) {
  let el = null;
  if (ref) {
    el = document.querySelector('[data-dsh-ref="' + ref + '"]');
  } else if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (error) {
      return { found: false, reason: 'CSS 选择器不合法：' + String(error && error.message ? error.message : error) };
    }
  } else {
    return { found: false, reason: '需要 ref 或 selector' };
  }
  if (!el) {
    return {
      found: false,
      reason: ref
        ? '页面里没有 ref=' + ref + ' 的元素（页面可能已导航或 DOM 已变化，请重新 browser_snapshot）'
        : '没有匹配选择器的元素：' + selector,
    };
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  const tag = el.tagName.toLowerCase();
  const editable = el.isContentEditable || tag === 'input' || tag === 'textarea';
  if (!editable) {
    return { found: true, editable: false, tag: tag, reason: '元素不是可输入控件（input/textarea/contenteditable）' };
  }
  if (clear) {
    if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (typeof el.select === 'function') {
      try {
        el.select();
      } catch (error) {
        // 某些 input 类型不支持 select，忽略
      }
      if (typeof el.setSelectionRange === 'function' && (el.type === 'text' || el.type === 'search' || el.type === 'url' || el.type === 'tel' || el.type === 'email' || el.type === 'password')) {
        try {
          el.setSelectionRange(0, String(el.value || '').length);
        } catch (error) {
          // ignore
        }
      }
    }
  }
  return {
    found: true,
    editable: true,
    tag: tag,
    inputType: String(el.type || tag),
    focused: document.activeElement === el,
    contentEditable: el.isContentEditable,
    value: el.isContentEditable ? String(el.textContent || '') : String(el.value === undefined ? '' : el.value),
  };
}

/** 读取聚焦元素（或 ref/selector）当前值。 */
function pageReadValue(selector, ref) {
  let el = null;
  if (ref) el = document.querySelector('[data-dsh-ref="' + ref + '"]');
  else if (selector) el = document.querySelector(selector);
  if (!el) return { found: false };
  const tag = el.tagName.toLowerCase();
  return {
    found: true,
    tag: tag,
    value: el.isContentEditable ? String(el.textContent || '') : String(el.value === undefined ? '' : el.value),
    focused: document.activeElement === el,
  };
}

export function snapshotExpression({ maxElements = 120, maxTextChars = 4000 } = {}) {
  return `(${pageSnapshot.toString()})(${Number(maxElements)}, ${Number(maxTextChars)})`;
}

export function resolveTargetExpression({ selector, ref } = {}) {
  return `(${pageResolveTarget.toString()})(${JSON.stringify(selector ?? null)}, ${JSON.stringify(ref ?? null)})`;
}

export function focusTargetExpression({ selector, ref, clear = false } = {}) {
  return `(${pageFocusTarget.toString()})(${JSON.stringify(selector ?? null)}, ${JSON.stringify(ref ?? null)}, ${clear === true})`;
}

export function readValueExpression({ selector, ref } = {}) {
  return `(${pageReadValue.toString()})(${JSON.stringify(selector ?? null)}, ${JSON.stringify(ref ?? null)})`;
}

export const PAGE_INFO_EXPRESSION = '({ url: location.href, title: document.title, readyState: document.readyState })';

export const CLEAR_ACTIVE_EXPRESSION = `(() => {
  const el = document.activeElement;
  if (!el) return { found: false };
  if (el.isContentEditable) {
    el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { found: true, cleared: true };
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const value = String(el.value === undefined ? '' : el.value);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    const descriptor = tag === 'textarea' ? textareaSetter : setter;
    if (descriptor && descriptor.set) descriptor.set.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, cleared: true, previousLength: value.length };
  }
  return { found: false };
})()`;
