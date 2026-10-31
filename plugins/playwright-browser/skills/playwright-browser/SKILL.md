---
name: playwright-browser
description: 用 Playwright 内核在系统 Google Chrome 里打开网页、点击、填表、等待、截图、导出 PDF、读页面内容（12 个 browser_* 工具，playwright-core 不下载浏览器）。用户提到 Playwright、P 内核浏览器、无头 Chrome、截图、导出 PDF、网页点按钮、填表单、等待元素、浏览器自动化时使用。
whenToUse: 需要真实浏览器渲染（JS 页面/表单/截图/PDF/等待）且偏好 Playwright 语义时
---

# Playwright 浏览器自动化（playwright-browser）

本技能对应 MCP 工具 `mcp__playwright__browser_*`（`serverName: playwright`）。运行依赖只有 `playwright-core`，**不会下载 Chromium**：默认 `channel: 'chrome'` 调用系统 Google Chrome。

## 先选模式

| 模式 | 何时用 | 特点 |
| --- | --- | --- |
| `headless`（默认） | 抓页面、截图、**导出 PDF**、无登录态自动化 | 无窗口，Playwright 内部临时 profile；不碰日常 Chrome |
| `headed` | 需要可见窗口、复用登录态 | 可见窗口，持久 profile `~/.dsh/playwright-browser/profile` |
| `attach` | 你已有 Chrome 开了 `--remote-debugging-port=9222` | `connectOverCDP` 连上去；`browser_close` 只断开，不关闭你的 Chrome |

`browser_launch` 可切换模式（会先关当前实例）。headless 与 headed 都可用 `PLAYWRIGHT_CHROME_PATH` 指定其他 Chromium/Chrome。

## 标准流程

1. `browser_status`：看是否已启动、依赖与 Chrome 是否可用（不启动浏览器）。
2. `browser_navigate {url}`：打开页面；没启动时自动按默认模式启动。
3. `browser_snapshot`：标题、URL、正文、可交互元素 ref（`e1`、`e2`…）。
4. `browser_click {ref}` / `browser_type {ref, text, submit}`：Playwright locator 自动等待可见/稳定/可操作。
5. `browser_wait`：等元素可见（`selector`）、等 URL、等 load_state，或 `ms` 固定等待。
6. `browser_screenshot`：PNG/JPEG 落盘（默认 `~/.dsh/playwright-browser/shots/`）。
7. `browser_pdf`：**仅 headless 可用**，导出 A4 PDF。
8. `browser_eval`：读 DOM/变量/计算结果（短表达式）。
9. `browser_tabs`：`list` / `new` / `activate` / `close`，用 `pageId`（p1、p2…）。
10. `browser_close`：结束；headless 临时 profile 由 Playwright 清理，headed profile 保留。

## ref 规则

- ref 形如 `e1`、`e2`，由最近一次 `browser_snapshot` 打在 DOM 的 `data-dsh-ref` 上。
- 导航/点击后页面变化 → 旧 ref 失效，重新 snapshot 再操作。
- click/type 也支持 CSS `selector`；ref 优先。
- 不穿透跨域 iframe 与 shadow DOM（ref 只覆盖主文档）。

## 与其他浏览器插件的区别

- 本插件是 **Playwright 内核**（locator 自动等待、`page.pdf`、`connectOverCDP`），依赖 `playwright-core`（约 13 MB，安装时从 npm 拉取，不下载浏览器）。
- 若环境不允许安装 npm 依赖，改用零依赖的 `dsh-browser` 插件（CDP 直连）；两者工具名分别在 `mcp__playwright__*` 与 `mcp__browser__*`。

## 安全边界

- `attach` 只连 `127.0.0.1`；不要连接远程 CDP。
- 不读 cookie / Login Data / token；headed 的登录态由 Chrome 自己维护。
- `browser_eval` 只写短表达式；Playwright 无法中断死循环，超时后建议重新导航或关闭浏览器。
- 不要在未确认时做支付、发帖、删除等不可逆操作；不要批量上传/抓取。
- 截图/PDF/eval 只作用于当前标签页。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 启动失败：找不到 Chrome | 安装 Google Chrome，或设置 `PLAYWRIGHT_CHROME_PATH`；`sh mcp/launch.sh --check` 可诊断 |
| 启动失败：Cannot find module 'playwright-core' | 依赖没装好：在 DSH 里重装插件，或检查 `node_modules/playwright-core` 是否存在 |
| `browser_pdf` 报“只支持 headless” | 先 `browser_launch {mode:"headless"}`；headed 的可见 Chrome 不支持 page.pdf |
| attach 连不上 9222 | Chrome 需以 `--remote-debugging-port=9222 --user-data-dir=<非默认目录>` 启动（136+ 不允许默认 profile 开远程调试） |
| 点击/输入超时 | 元素不可见或被遮挡；先用 `browser_wait {selector}` 等可见，或重新 snapshot 拿新 ref |
| 中文 `data:` URL 乱码 | 写全 charset：`data:text/html;charset=utf-8,<h1>中文</h1>` |
| 页面脚本死循环导致 eval 超时 | 重新 navigate，或 `browser_close` 后重开（Playwright 无法终止页面脚本） |

## 不要用它

- 只需要 HTTP 抓取/搜索：用联网搜索工具，不要为静态页启动浏览器。
- 需要操作系统级窗口点击：用桌面操作工具（LCU）。
- 需要 cookie/凭据导出：本插件不提供。
