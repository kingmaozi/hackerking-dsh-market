# NOTICE — lcu

本插件把 [amontlabs/lcu](https://github.com/amontlabs/lcu)（MIT，Amont Labs，版本 0.11.7）接入
DeepSeek Harness。LCU 本体没有复制进本插件：运行时安装在 `~/.local/share/lcu/`，
relay 通过 `LCU_BIN`（默认 `~/.local/share/lcu/current/bin/lcu`）调用它。

本插件原创部分：

1. `mcp/relay.mjs` — 零依赖的 MCP 双向桥：
   - 对 `lcu` 声明 MCP `2025-06-18` + `elicitation` 能力（DSH 的 MCP 客户端两者缺一不可）；
   - 只向模型暴露 `js` / `js_reset`，隐藏宿主专用的 `turn_ended` / `js_add_node_module_dir`；
   - 审批请求按主人的 Touch ID allow-list（`lcu apps allow` 写入的 `ComputerUseAppApprovals.json`）回答
     accept/decline，其余 fail closed；
   - 透传 text 与 image content，不改写结果。
2. `mcp/run.sh` — Node 探测启动器（宿主 PATH 不含 node 时也能起）。
3. `skills/lcu-computer-use/SKILL.md` — 首次调用规则、`cua.*` 动作、审批纪律、边界。
4. `lib/index.js`、`cordis.patch.yml`、`scripts/selftest.mjs`、README。

LCU 的 MIT 许可文本随附于 `LICENSE`（版权归 Amont Labs）。ChatGPT 桌面应用与其
`cua_node` / Sky helper 归 OpenAI，本插件不改动、不重打包、不绕过其签名校验；
提示词与运行时行为以 OpenAI 随应用分发的为准。

用户批准状态存放在 LCU/运行时的 Group Container 里，由 LCU 的 `lcu-owner-auth`
（Touch ID / 登录密码）写入；relay 只读该文件，不写。
