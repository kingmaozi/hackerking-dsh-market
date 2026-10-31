# playwright-browser — DSH 的 Playwright 内核浏览器插件

用 **Playwright**（`playwright-core`）驱动系统 Google Chrome 的 DSH 插件：12 个 `browser_*` MCP 工具，支持 headless / headed / attach、截图、**导出 PDF**、等待、标签页。运行依赖只有 `playwright-core`（约 13 MB，无 install 脚本、**不会下载 Chromium**），默认 `channel: 'chrome'` 调用本机 Google Chrome。

| 项 | 值 |
| --- | --- |
| 包名 | `playwright-browser` |
| 版本 | `0.1.0` |
| MCP `serverName` | `playwright`（模型侧 `mcp__playwright__browser_*`） |
| 技能 | `playwright-browser` |
| 运行依赖 | `playwright-core@1.64.1`（唯一依赖；无 peerDependencies / devDependencies） |
| 浏览器 | 系统 Google Chrome（默认 `channel: 'chrome'`）；可用 `PLAYWRIGHT_CHROME_PATH` 指向其他 Chrome/Chromium |
| 目标 DSH | `>=0.2.1-rc.5 <0.3.0` |
| Node | `>=22` |
| 许可证 | MIT |

> 与零依赖的 `dsh-browser`（CDP 直连、无需 npm 安装）不同：本插件用 Playwright 的 locator 自动等待、`page.pdf`、`connectOverCDP`，安装时会从 npm 拉取 `playwright-core`。

## 1. 三种模式

| 模式 | 启动方式 | profile | 适用 |
| --- | --- | --- | --- |
| `headless`（默认） | `chromium.launch({ channel: 'chrome', headless: true })` | Playwright 内部临时 profile | 抓页面、截图、**PDF**、无登录态自动化 |
| `headed` | `launchPersistentContext(profile)`，可见窗口 | `~/.dsh/playwright-browser/profile`（可改） | 需要可见窗口、复用登录态 |
| `attach` | `chromium.connectOverCDP('http://127.0.0.1:9222')` | 外部 Chrome 自己的 profile | 复用已开 `--remote-debugging-port` 的 Chrome |

- 三种模式都不会使用用户日常 Chrome 的默认 profile 启动 headless 实例。
- `browser_pdf` **只在 headless 模式可用**；headed/attach 会返回中文说明。
- `browser_close`：headless/headed 关闭本插件启动的浏览器（headed profile 保留）；attach 只断开 CDP，不关闭你的 Chrome。

## 2. 12 个工具

| 工具 | 作用 |
| --- | --- |
| `browser_status` | 状态：模式、Playwright/Chrome 版本、依赖是否安装、页面；**不启动**浏览器 |
| `browser_launch` | 启动/切换 `headless` / `headed` / `attach`，可指定 Chrome 路径、profile、端口、超时 |
| `browser_navigate` | 导航当前页（http/https/file/data/about:），未启动时自动启动 |
| `browser_snapshot` | 标题/URL/正文 + 可交互元素 ref（`e1`、`e2`…，写入 `data-dsh-ref`） |
| `browser_click` | Playwright locator 点击（ref 或 CSS selector），自动等待可操作 |
| `browser_type` | `fill` 清空输入 + 可选 `Enter` 提交（支持 contenteditable） |
| `browser_screenshot` | PNG/JPEG 落盘，返回路径/字节数/尺寸；`full_page` 整页 |
| `browser_pdf` | **headless 专属**：`page.pdf` 导出 PDF（A4/Letter、横向、打印背景） |
| `browser_eval` | `page.evaluate` 执行短 JS，返回 JSON |
| `browser_wait` | 等 `selector`（visible/attached/hidden/detached）、`ms`、`url`、`load_state` |
| `browser_tabs` | `list` / `new` / `activate` / `close`，用 `pageId`（p1、p2…）或 `index` |
| `browser_close` | 关闭浏览器（attach 只断开） |

典型流程：`browser_navigate` → `browser_snapshot`（拿 ref）→ `browser_click` / `browser_type` → `browser_screenshot` / `browser_pdf`。ref 只对当前页面状态有效，页面变化后重新快照。

## 3. DSH 接线

`cordis.patch.yml` 插入两行：

1. `playwright-browser`：技能 provider（`index.js` → `lib/provider.js`），只读加载 `skills/`。
2. `mcp-playwright`：`@deepseek-ai/dsh-mcp-client`，stdio 启动 `mcp/launch.sh`，`serverName: playwright`。

包路径用 `ctx.baseUrl` 解析，不写死机器路径：

```yaml
!!js "decodeURIComponent(new URL('node_modules/playwright-browser/mcp/launch.sh', ctx.baseUrl).pathname)"
```

## 4. 安装

```sh
# 工作区根目录
python3 scripts/build_playwright_package.py
# → release/playwright-browser-0.1.0.tgz + .sha256 + playwright-browser-0.1.0.manifest.json
```

DSH Desktop：侧栏 **插件 → 添加插件 → 安装第三方插件**，填 tarball 绝对路径，安装并启用，重启 DSH。安装时宿主会用 pnpm 从 npm 拉取 `playwright-core@1.64.1`（无 build script，不会触发浏览器下载）。新会话里应出现 `mcp__playwright__*` 工具与 `playwright-browser` 技能。

命令行（仅测试 profile）：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-playwright-test "$DSH" plugin --profile headless add /绝对路径/release/playwright-browser-0.1.0.tgz
```

## 5. 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PLAYWRIGHT_CHROME_PATH` | 系统 Chrome | Chrome/Chromium 可执行文件；优先级高于 `BROWSER_CHROME_PATH` |
| `BROWSER_CHROME_PATH` | — | 兼容写法，次优先 |
| `PLAYWRIGHT_HEADLESS` | `1` | 默认模式：`1` headless，`0` headed |
| `PLAYWRIGHT_PROFILE_DIR` | `~/.dsh/playwright-browser/profile` | headed 持久 profile |
| `PLAYWRIGHT_ATTACH_PORT` | `9222` | attach 模式 CDP 端口 |
| `PLAYWRIGHT_BROWSER_HOME` | `~/.dsh/playwright-browser` | 截图/PDF 根目录 |
| `PLAYWRIGHT_TIMEOUT_MS` | `30000` | 操作默认超时 |
| `PLAYWRIGHT_LAUNCH_TIMEOUT_MS` | `30000` | 启动/连接超时 |
| `PLAYWRIGHT_VIEWPORT` | `1440x900` | 视口尺寸 |
| `PLAYWRIGHT_NODE_BIN` | 自动探测 | 启动器优先使用的 node（需 ≥22；也接受 `BROWSER_NODE_BIN`） |

## 6. 自检与测试

```sh
cd playwright-plugin
sh mcp/launch.sh --check          # 一行 JSON：node / playwright-core / Chrome 诊断
node scripts/selftest.mjs         # 离线：技能、manifest、依赖、启动器、MCP 握手、tools/list、status
node scripts/selftest.mjs --live  # 真实 headless Chrome：data:/file:// + click/type/wait/screenshot/pdf/eval/tabs
node --test tests/*.test.mjs      # 单元 + MCP + 真实 headless/headed/attach 集成
```

实测环境（2026-10-31）：macOS arm64、Google Chrome 156.0.8078.79、Node v26.12.1、playwright-core 1.64.1、DSH 0.2.1-rc.5。原始输出见 [Playwright浏览器插件](../docs/Playwright浏览器插件.md)。

## 7. 安全边界

- attach 只连 `127.0.0.1` 的 CDP；拒绝非回环地址。
- 不读 cookie / `Login Data` / token / 凭据文件；headed 登录态由 Chrome 自己维护。
- headless 使用 Playwright 内部临时 profile；不会用日常 Chrome profile 启动。
- 只关闭自己启动的浏览器；attach 只断开连接。
- `browser_eval` 只用于短表达式；Playwright 无法中断死循环，超时后需重新导航或关闭浏览器。
- 截图/PDF/eval 只作用于当前标签页；不上传任何数据。

## 8. 已知限制

- 单 MCP server 实例只管理一个 Playwright 浏览器/连接；工具调用串行。
- `snapshot`/`click`/`type` 不穿透跨域 iframe 与 shadow DOM（ref 只覆盖主文档）。
- PDF 仅 headless：headed/attach 的 `page.pdf` 被 Playwright 禁用，插件会中文报错。
- `data:` URL 含中文需显式 `charset=utf-8`。
- Playwright 无法终止页面里的同步死循环；eval 超时只能重新导航/重开。
- 未做下载拦截、网络请求拦截/改写、多浏览器并行、cookie 导入导出；Windows/Linux 未实测。
- 安装需要网络（从 npm 拉取 playwright-core）；离线环境请改用零依赖 `dsh-browser`。

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| 没有 `mcp__playwright__*` | `sh mcp/launch.sh --check`；查看 DSH 日志里 `mcp-playwright` 的 stderr |
| `Cannot find module 'playwright-core'` | 依赖没装好：重装插件，或检查 profile 的 `node_modules/playwright-core` |
| 找不到 Chrome | 安装 Google Chrome，或设 `PLAYWRIGHT_CHROME_PATH` |
| PDF 报“只支持 headless” | `browser_launch {mode:"headless"}` 后再试 |
| attach 连不上 9222 | Chrome 需 `--remote-debugging-port=9222 --user-data-dir=<非默认目录>` 启动（136+ 限制） |
| 点击/输入超时 | 用 `browser_wait {selector}` 等可见；重新 `browser_snapshot` 拿新 ref |
| 安装时 pnpm 提示 build script | playwright-core 没有 install 脚本；若宿主提示其他依赖脚本，按 DSH 提示处理，不影响本插件启动 |

## 10. 目录

```text
playwright-plugin/
  package.json / cordis.patch.yml / index.js
  lib/          browser.mjs（Playwright 管理）、tools.mjs（12 工具）、dom.mjs（页面快照脚本）、
                util.mjs、provider.js / frontmatter.js（技能）
  mcp/          launch.sh（自找 node + 依赖/Chrome 诊断）、server.mjs（JSON-RPC stdio）
  skills/playwright-browser/SKILL.md
  scripts/selftest.mjs
  tests/        core.test.mjs、mcp.test.mjs、live.test.mjs
```

构建：工作区根目录 `scripts/build_playwright_package.py` → `release/playwright-browser-0.1.0.tgz`（确定性 tar：`mtime=0`、`uid/gid=0`、按 `files` 白名单，不打包 `node_modules`）。
