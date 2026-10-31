# dsh-browser — DSH 原生浏览器插件

零 npm 依赖的本机浏览器自动化：用 Node 22+ 自带的全局 `WebSocket` 直连 **Chrome DevTools Protocol**，不引入 Playwright/Puppeteer，也不下载浏览器。给 DSH 提供 11 个 `browser_*` MCP 工具和 `browser-automation` 技能。

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-browser` |
| 版本 | `0.1.0` |
| MCP `serverName` | `browser`（模型侧 `mcp__browser__browser_*`） |
| 技能 | `browser-automation` |
| 目标 DSH | `>=0.2.1-rc.5 <0.3.0`（`engines.dsh`） |
| Node | `>=22`（依赖全局 WebSocket；实测 v26.12.1 / DSH runtime 24） |
| 浏览器 | Google Chrome / Chromium / Edge / Chrome for Testing（自动发现） |
| 依赖 | **0 个 npm 依赖** |
| 许可证 | MIT |

## 1. 三种模式

| 模式 | 启动方式 | profile | 适用 |
| --- | --- | --- | --- |
| `headless`（默认） | `--headless=new --remote-debugging-port=0` | `mkdtemp` 临时 profile，`close` 即删 | 抓页面、截图、无登录态自动化 |
| `chrome` | 可见窗口 + 持久 profile | `~/.dsh/browser/chrome-profile`（可用 `BROWSER_PROFILE_DIR` 改） | 需要登录态、人工接管、加载扩展 |
| `attach` | 不启动，连 `127.0.0.1:<port>/json/version` | 外部 Chrome 自己的 profile | 复用已开 `--remote-debugging-port` 的 Chrome |

- 三种模式都只连**回环地址**的 CDP：非 `127.0.0.1`/`localhost`/`::1` 一律拒绝。
- `headless` 永远用一次性临时 profile，**不会**用用户日常 Chrome profile 启动。
- `chrome` 模式才传 `--load-extension` / `--disable-extensions-except`（`BROWSER_EXTENSIONS`，冒号分隔的解包扩展目录）。
- `browser_close`：`headless`/`chrome` 关闭本插件启动的 Chrome；`attach` 只断开 CDP 连接，不关闭你的 Chrome。

## 2. 11 个工具

| 工具 | 作用 |
| --- | --- |
| `browser_status` | 状态：模式、Chrome 版本、CDP 端口、profile、当前页面；**不启动**浏览器 |
| `browser_launch` | 启动/切换模式（`headless`/`chrome`/`attach`），可指定 Chrome 路径、扩展、profile、端口 |
| `browser_navigate` | 导航当前页（http/https/file/data/about:），未启动时自动启动 |
| `browser_snapshot` | 标题/URL/正文 + 可交互元素 ref（`e1`、`e2`…，写入 DOM 的 `data-dsh-ref`） |
| `browser_click` | 真实鼠标点击（ref 或 CSS selector），先滚动到可见 |
| `browser_type` | 聚焦 + `Input.insertText` 输入，`submit:true` 按 Enter |
| `browser_screenshot` | PNG/JPEG 落盘，返回绝对路径/字节数/尺寸；`full_page` 整页 |
| `browser_eval` | `Runtime.evaluate`（`awaitPromise` + `returnByValue`），短 JS 表达式 |
| `browser_tabs` | `list` / `new` / `activate` / `close` |
| `browser_extensions` | 列 profile 内扩展（名称/版本/路径/解包或打包）+ 运行中扩展 |
| `browser_close` | 关闭浏览器（attach 只断开） |

典型流程：`browser_navigate` → `browser_snapshot`（拿 ref）→ `browser_click` / `browser_type` → `browser_screenshot`。ref 只对当前页面状态有效，页面变化后重新快照。

## 3. DSH 接线

`cordis.patch.yml` 插入两行：

1. `dsh-browser`：技能 provider（`index.js` → `lib/provider.js`），只读加载 `skills/`。
2. `mcp-browser`：`@deepseek-ai/dsh-mcp-client`，stdio 启动 `mcp/launch.sh`，`serverName: browser`。

包路径用 `ctx.baseUrl` 解析，不写死机器路径：

```yaml
!!js "decodeURIComponent(new URL('node_modules/dsh-browser/mcp/launch.sh', ctx.baseUrl).pathname)"
```

## 4. 安装

```sh
# 工作区根目录
python3 scripts/build_browser_package.py
# → release/dsh-browser-0.1.0.tgz + .sha256 + dsh-browser-0.1.0.manifest.json
```

DSH Desktop：侧栏 **插件 → 添加插件 → 安装第三方插件**，填 tarball 绝对路径，安装并启用，重启 DSH。新会话里应出现 `mcp__browser__*` 工具与 `browser-automation` 技能。

命令行（仅测试 profile，不要装进 `desktop`）：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-browser-probe "$DSH" --profile browser-probe --from-default-profile headless
DSH_HOME=/tmp/dsh-browser-probe "$DSH" plugin --profile browser-probe add /绝对路径/release/dsh-browser-0.1.0.tgz
```

## 5. 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `BROWSER_MODE` | `headless` | 默认模式 `headless` / `chrome` / `attach` |
| `BROWSER_CHROME_PATH` | 自动发现 | Chrome 二进制路径（优先于自动发现） |
| `BROWSER_PROFILE_DIR` | `~/.dsh/browser/chrome-profile` | chrome 模式持久 profile；attach 模式仅用于扩展扫描 |
| `BROWSER_EXTENSIONS` | 空 | chrome 模式的解包扩展目录，`:` 分隔 |
| `BROWSER_ATTACH_PORT` | `9222` | attach 模式 CDP 端口 |
| `BROWSER_HOME` | `~/.dsh/browser` | 截图/状态根目录 |
| `BROWSER_TIMEOUT_MS` | `30000` | 单条 CDP 命令默认超时 |
| `BROWSER_LAUNCH_TIMEOUT_MS` | `25000` | 等待 `DevTools listening` 的超时 |
| `BROWSER_WINDOW_SIZE` | `1440,900` | 视口尺寸（本插件启动的浏览器） |
| `BROWSER_NODE_BIN` | 自动探测 | 启动器优先使用的 node（需 ≥22） |

Chrome 发现顺序：`BROWSER_CHROME_PATH` → `/Applications/Google Chrome.app` → Chromium → Edge → Linux 常见路径 → `PATH` 里的 `google-chrome`/`chromium`/`microsoft-edge`。

## 6. 自检与测试

```sh
cd browser-plugin
sh mcp/launch.sh --check          # 一行 JSON：node 版本、包路径、Chrome 是否可用
node scripts/selftest.mjs         # 离线：技能 + manifest + 启动器 + MCP 握手 + tools/list + status
node scripts/selftest.mjs --live  # 真实 headless Chrome：data:/file:// + click/type/screenshot/eval/tabs
node --test tests/*.test.mjs      # 单元 + MCP + 真实 headless/attach 集成测试
```

实测环境（2026-10-31）：macOS arm64、Google Chrome 156.0.8078.79、Node v26.12.1、DSH 0.2.1-rc.5。真实结果与原始输出见 [浏览器插件实现](../docs/浏览器插件实现.md)。

## 7. 安全边界

- 只连 `127.0.0.1` 的 CDP，拒绝 `wss://` 与非回环地址；不监听入站端口。
- 不读 cookie / `Login Data` / token / 凭据文件；`browser_extensions` 只读 `manifest.json` 与 `Preferences` 的扩展元数据。
- `headless` 用临时 profile；`chrome` 用独立持久 profile；都不会用用户日常 profile 启动。
- 只杀自己启动的 Chrome（`owned`）；`attach` 只断开连接。
- `browser_eval` 是显式能力：只用于短表达式，超时后尝试 `Runtime.terminateExecution`；不做批量上传、不绕过登录。
- 截图只落盘到指定路径/默认截图目录，不上传任何地方。

## 8. 已知限制

- 单 MCP server 实例只管理一个浏览器进程/连接；工具调用串行执行。
- `snapshot`/`click`/`type` 不穿透跨域 iframe 与 shadow DOM（ref 列表只覆盖主文档）。
- `data:` URL 含中文时必须显式 `charset=utf-8`（如 `data:text/html;charset=utf-8,...`）；这是 Chrome 对 data URL 默认字符集的行为，不是插件改写。
- `chrome` 模式加载解包扩展依赖浏览器支持：Google Chrome 官方版 156 实测忽略 `--load-extension`/`--disable-extensions-except`，Chrome for Testing 148 实测正常加载；插件会在启动结果里给出证据与提示。
- 不支持下载拦截、网络请求拦截/改写、多浏览器并行 profile、cookie 导入导出。
- 没有 systemd/Windows 服务模式；Windows 路径仅通过 `BROWSER_CHROME_PATH` 支持，未实测。

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| 没有 `mcp__browser__*` 工具 | `sh mcp/launch.sh --check`；查看 DSH 日志里 `mcp-browser` 的 stderr |
| 找不到 Node | 安装 Node ≥22，或设 `BROWSER_NODE_BIN` |
| 找不到 Chrome | 安装 Chrome，或设 `BROWSER_CHROME_PATH` |
| attach 连不上 | Chrome 需以 `--remote-debugging-port=9222 --user-data-dir=<非默认目录>` 启动（136+ 不允许默认 profile 开远程调试） |
| 点击后 ref 失效 | 重新 `browser_snapshot` |
| 官方版 Chrome 扩展没加载 | 换 Chrome for Testing/Chromium，或在窗口内 `chrome://extensions` 手动加载 |
| 临时 profile 残留 | `close`/进程退出都会清理；异常被杀时可能在 `$TMPDIR/dsh-browser-headless-*` 留目录，可手工删 |

## 10. 目录

```text
browser-plugin/
  package.json / cordis.patch.yml / index.js
  lib/          cdp.mjs（WS+CDP）、browser.mjs（三模式+操作）、chrome.mjs（发现/参数/扩展扫描）、
                dom.mjs（页面脚本）、tools.mjs（11 工具 schema+输出）、provider.js / frontmatter.js（技能）
  mcp/          launch.sh（自找 node）、server.mjs（JSON-RPC stdio，stdout 纯协议）
  skills/browser-automation/SKILL.md
  scripts/selftest.mjs
  tests/        core.test.mjs、mcp.test.mjs、live.test.mjs
```

构建：工作区根目录 `scripts/build_browser_package.py` → `release/dsh-browser-0.1.0.tgz`（确定性 tar：mtime=0、uid/gid=0、按 `files` 白名单）。
