---
name: browser-automation
description: 在本机 Chrome 里打开网页、点击、填表、截图、读页面内容、执行短 JS（11 个 browser_* 工具，零依赖 CDP）。用户提到打开网页、访问链接、截图、网页点按钮、填表单、登录后页面操作、检查某个页面长什么样、抓页面文字、浏览器自动化时使用。
whenToUse: 需要真实浏览器渲染（JS 页面/登录态/点击/填表/截图/读 DOM）而不是只抓 HTML 时
---

# 浏览器自动化（dsh-browser）

本技能对应 MCP 工具 `mcp__browser__browser_*`（`serverName: browser`）。插件自带 Chrome 启动与 DevTools Protocol 客户端，**不依赖 Playwright/Puppeteer，不下载浏览器**。

## 先选模式

| 模式 | 何时用 | 特点 |
| --- | --- | --- |
| `headless`（默认） | 只读页面、抓文本、截图、无登录态的自动化 | 无窗口，**临时 profile**，关闭即清理；不碰你日常 Chrome |
| `chrome` | 需要可见窗口、登录态、加载扩展 | 可见窗口，持久 profile `~/.dsh/browser/chrome-profile`；`BROWSER_EXTENSIONS` 可加载解包扩展 |
| `attach` | 你已有一个开了 `--remote-debugging-port=9222` 的 Chrome | 连上去操作，`browser_close` 只断开连接、不关闭你的 Chrome |

`browser_launch` 可以随时切换模式（会先关掉当前实例）。三种模式都只连 `127.0.0.1` 的 CDP。

## 标准流程

1. `browser_status`：确认是否已启动（不启动浏览器）。
2. `browser_navigate {url}`：打开页面；没启动时会自动按默认模式启动。
3. `browser_snapshot`：拿标题、URL、正文和可交互元素列表。**点击/输入优先用这里的 ref（e1、e2…）**。
4. `browser_click {ref}` 或 `browser_type {ref, text, submit}`：真实鼠标/键盘事件，会先滚动到元素可见。
5. `browser_screenshot`：截图落盘，返回绝对路径（默认 `~/.dsh/browser/shots/`）。
6. `browser_eval {expression}`：读 DOM/变量/计算结果，例如 `document.title`、`document.querySelectorAll('h2').length`。
7. `browser_tabs`：列/新建/切换/关闭标签页。
8. `browser_extensions`：列已装扩展（只读 manifest/Preferences，不读 cookie）。
9. `browser_close`：结束。headless 会顺带清理临时 profile；attach 只断开。

## ref 规则（最容易踩的坑）

- ref 形如 `e1`、`e2`，由**最近一次** `browser_snapshot` 打在 DOM 的 `data-dsh-ref` 属性上。
- 导航、点击引发 DOM 变化、或页面自己重渲染后，旧 ref 可能失效 → **重新 snapshot** 再点。
- `click`/`type` 也支持 CSS selector（`selector` 参数）；ref 优先于 selector。
- 不能点进跨域 iframe 内部；shadow DOM 内部元素目前也不会出现在 ref 列表里。

## 安全边界（必须遵守）

- **不要**用本插件读取 cookie、`Login Data`、token 或浏览器凭据文件；插件本身也不读。
- `attach` 模式会操作你已有的（可能已登录）Chrome：只有用户明确要求时才用，不要做支付、发帖、删除类不可逆操作而不确认。
- `browser_eval` 只写短表达式；不要死循环、不要发起批量上传、不要绕过登录/验证码。超时会尝试 `Runtime.terminateExecution`。
- 截图/eval 只作用于当前标签页；不批量抓取多站点、不高频请求。
- headless 默认，绝不使用你日常 Chrome 的 profile 启动无头实例。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 找不到 Chrome | 安装 Google Chrome，或设 `BROWSER_CHROME_PATH`；`sh mcp/launch.sh --check` 可看诊断 |
| `attach` 连不上 9222 | 先以 `--remote-debugging-port=9222 --user-data-dir=<非默认目录>` 启动 Chrome（Chrome 136+ 不允许默认 profile 开远程调试） |
| 端口被占用 / profile 被占用 | 换 `BROWSER_PROFILE_DIR` 或先关掉同 profile 的 Chrome |
| 点击没反应 / ref 找不到 | 重新 `browser_snapshot`；确认元素可见、没有被弹窗遮挡 |
| 输入后值没变 | 有些组件用受控输入，改用 `browser_eval` 派发事件，或先 click 聚焦再 type |
| `chrome` 模式扩展没加载 | 官方版 Chrome（实测 156）忽略 `--load-extension`；改用 Chrome for Testing/Chromium，或在窗口里打开 `chrome://extensions` 手动加载 |
| 中文 `data:` URL 乱码 | 写全 charset：`data:text/html;charset=utf-8,<h1>中文</h1>` |
| headless 截图是白屏 | 页面可能是 canvas/WebGL 或还在加载；先 navigate 等 `加载：完成` 再截图 |

## 不要用它的场景

- 只需要 HTTP 抓取/搜索：用联网搜索工具或 `curl`，不要为静态页启动浏览器。
- 需要操作系统级点击窗口（非网页）：用桌面操作工具（LCU），不是本插件。
- 需要 cookie/登录凭据：本插件不提供，也不应尝试。
