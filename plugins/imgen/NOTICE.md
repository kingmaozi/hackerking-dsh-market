# NOTICE — imgen

本插件是 ZCode 插件 `imgen`（包名 `imgen-zcode`，版本 1.2.0）的 DeepSeek Harness 移植版。

- 上游作者：BriKing Family AI
- 上游许可：MIT（见同目录 `LICENSE`）
- 上游描述：用本机已登录的 ChatGPT / Codex 账号（OAuth）出图与改图，不需要 API Key，
  不按张计费，不经第三方服务器。
- 移植来源快照：`~/Documents/imgen-zcode`（`skills/imgen`、`lib/`、`mcp/`、`dist/` 原样复制）

移植改动（除此之外逻辑与文案未动）：

1. 新增 DSH 宿主胶水：`lib/index.js`（技能 provider）、`cordis.patch.yml`（技能 + MCP 两行）、
   `scripts/selftest.mjs`（技能加载 + MCP 握手 + `imgen_health`）。
2. `mcp/server.mjs`：默认输出根目录 `~/.zcode/imgen` → `~/.dsh/imgen`，新增 `IMGEN_OUTPUT_HOME` 覆盖；
   对应工具描述与体检输出同步。
3. `skills/imgen/SKILL.md`：补 DSH 宿主差异段，CLI 示例路径改为工作区插件目录。
4. `package.json` 改写为 DSH 插件清单，`bundledDependencies` 内联原生依赖
   （`@ossiana/node-libcurl`、`node-libcurl`、`node-libcurl-darwin-arm64`、`commander`、`node-addon-api`）。

上游依赖 `@ossiana/node-libcurl`（MIT / libcurl 许可）与 `commander`（MIT）版权归各自作者。
