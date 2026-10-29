# NOTICE — agent-reach

本插件是 ZCode / MiniMax Code 插件 `briking-agent-reach`（版本 3.3.0）的 DeepSeek Harness 移植版。

- 上游作者：BriKing Family AI
- 上游许可：MIT（插件清单声明；上游仓库未随包附带 LICENSE 文件，本插件补上标准 MIT 文本）
- 上游仓库：https://github.com/kingmaozi/briking-agent-reach-codex
- 移植来源快照：`~/Documents/agent-reach-update-20261012`（`mcp/`、`skills/agent-reach`、`scripts/browser-ai.mjs` 原样复制）

移植改动（据此可逐项 diff）：

1. 新增 DSH 宿主胶水：`lib/index.js`（技能 provider）、`cordis.patch.yml`（技能 + MCP 两行）、
   `scripts/selftest.mjs`（技能加载 + MCP 握手 + 离线 `reach_status`）。
2. 技能目录与 frontmatter 名字 `agent-reach` → `agent-reach-mcp`：避免与 `~/.agents/skills/agent-reach`
   的 CLI 版技能同名（注册表一个名字只保留一个 provider）。正文内容未改，仅在开头加 DSH 移植说明。
3. `skills/agent-reach-mcp/references/browser-ai.md`：补 DSH 宿主差异（无 Browser Use 运行时，
   改用 `cua_*` / Playwright 复用已登录浏览器）。
4. `package.json` 改写为 DSH 插件清单（`dsh.bundle.patch`）。
5. `mcp/legacy.mjs`：`reach_read` 补正文读取回退链 Jina → Firecrawl → Scrapfly，并在 Jina 失败后
   10 分钟内跳过它。原因：本机 `r.jina.ai` TLS 被重置，上游单通道会直接 `fetch failed`。
6. `mcp/tools/zcode-compat.mjs` + `mcp/agent-reach-mcp.mjs`：浏览器交接对象里的
   `browser-use:control-browser` / `mcp__node_repl__js` / `agent.browsers.get('iab')` 改指 DSH 的
   `browser-automation`（Playwright），并注明 `cua_*` 只有另装 `computer-use` 时才可用；限频、遇验证码停止、关标签等策略字段未改。
7. 其余 `mcp/**` 运行时代码未动——`reach_*` 18 个工具、planner / scheduler / evidence / auto-extend
   与上游 3.3.0 一致；`tools/zcode-compat.mjs` 的兼容语义原样保留。

凭据仍由上游逻辑从 `~/.agent-reach/briking/` 读取，本插件不复制、不落盘、不外发任何密钥。

第三方渠道（Tavily / Exa / Jina / Parallel / TinyFish / Firecrawl / Valyu / Scrapfly 等）的
服务条款与计费由各自提供方决定，与本移植无关。
