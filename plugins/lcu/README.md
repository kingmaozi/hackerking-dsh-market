# lcu — 真·桌面操作（DSH 原生适配）

把 **LCU**（[amontlabs/lcu](https://github.com/amontlabs/lcu)，MIT）接进 DSH。LCU 不是又写一套点击/截图，
它把 **ChatGPT 桌面应用里那套官方 computer-use 运行时**（`cua_repl`，rmcp MCP 服务，Sky 签名 helper）暴露给任意宿主。
本插件 = **一层 relay + 一个技能**。

| 组件 | 位置 | 说明 |
|---|---|---|
| Relay（MCP） | `mcp/relay.mjs` + `mcp/run.sh` | 对 DSH 是 MCP 服务，对 `lcu` 是 MCP 客户端；工具只暴露 `js` / `js_reset` |
| 技能 | `skills/lcu-computer-use/` | 首次调用规则、`cua.*` 常用动作、审批纪律、边界 |
| 自检 | `scripts/selftest.mjs` | 技能加载 + 双端握手 + `getState`（只读，不动桌面） |

## 为什么要 relay（关键结论，实测过）

DSH 的 `@deepseek-ai/dsh-mcp-client` 直接连 `lcu` 时，`cua.getApp(...)` 会失败：

```text
nodeRepl.createElicitation is unavailable because the MCP client does not support form elicitation
```

原因是运行时在控制任何 App 前都要求客户端声明 MCP `elicitation` 能力（哪怕这个 App 已经在
always-allow 名单里），而 DSH 的 MCP 客户端不声明。relay 补上这个能力，并代替人做**有依据的**回答：

1. 用户在终端用 Touch ID 批准过的 App（`lcu apps allow "<App>"`，写进
   `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/.../ComputerUseAppApprovals.json`）→ `accept`；
2. 其余 → `decline`，工具结果里是 `Computer Use was not approved to use "<App>"`，模型会转述要你去批；
3. 没有 UI 通道可用，所以“人”的通道就是 Touch ID + `lcu apps`，relay 不替人做决定。

顺带只暴露模型可见的两个工具：`turn_ended` / `js_add_node_module_dir` 是宿主专用（官方 relay 同样隐藏）。

## 前置条件

1. macOS Apple Silicon（本机 arm64 / macOS 26.5.2 实测）。
2. `ChatGPT.app` 已安装（LCU 复用它里面的 `cua_node`，不下载、不登录）。
3. LCU 已装（runtime-only 即可，不注册任何 harness）：
   ```sh
   # 从 https://github.com/amontlabs/lcu/releases/latest 下 darwin-arm64 包，校验 sha256 后
   ./scripts/install.sh --runtime-only --yes
   ~/.local/share/lcu/current/bin/lcu doctor     # 期望 exit 0
   ```
4. macOS 权限：辅助功能（ChatGPT Computer Use）、屏幕录制（ChatGPT）——首次真实调用后系统才列出来。
5. 想控制的 App 先批准：`lcu apps allow "TextEdit"`（过 Touch ID），`lcu apps` 查看。

## 验证

```bash
cd ~/Documents/hackerking
node plugins/lcu/scripts/selftest.mjs
# OK skills / OK mcp: lcu 1.5.0 (dsh-relay) / OK tools: js, js_reset / OK js(getState) / OK approvals
```

装进 DSH 后（`mcp__lcu__js`）：

```text
await cua.getState()                      → 应用/窗口清单 + 完整 cua API 文档
let app = await cua.getApp("TextEdit")    → 该 App 的无障碍树（首次需已批准）
await app.getScreenshot()                 → 截图，作为 image block 回给模型
```

本机实测（2026-10-21）：relay → lcu → TextEdit 截图 1172×976 JPEG，全程 200ms 级；
未批准 App（Notes）被 decline，返回 `Computer Use was not approved to use Notes`。

## 边界与已知风险

- **版本配对**：LCU 0.11.7 未测试过本机 ChatGPT `26.1013.40934`（CUA `0.0.30`），`lcu status` 报 `untested`。
  官方测试到 `26.1007`。ChatGPT 升级后如异常，先 `lcu update`，再看 `lcu status`。
- 高危 App（浏览器、密码管理器、iPhone 镜像）运行时自带警告；页面内容按不可信输入处理。
- relay 不做 Chrome/origin 审批流程（不带 `--chrome`），需要浏览器控制时再评估。
- DSH 侧只按“未批准就 decline”处理，不提供“本次会话临时批准”的 UI。

## 回滚

```bash
# 只从 DSH 摘掉：从 profile 的 cordis.patch.yml 删除 mcp-lcu 行，或
bash scripts/uninstall-local.sh --profile desktop
# 连 LCU 一起删：
rm -rf ~/.local/share/lcu
# 撤销某个 App 的批准：
~/.local/share/lcu/current/bin/lcu apps revoke "<App>"
```

## 许可与来源

LCU：MIT，Amont Labs，v0.11.7；本插件只加 relay/技能/接线，不修改 LCU。差异见 [NOTICE.md](./NOTICE.md)。
