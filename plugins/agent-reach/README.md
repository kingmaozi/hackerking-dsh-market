# agent-reach — 三档全网调研（DSH 原生适配）

从 ZCode 插件 `briking_agent_reach@3.3.0`（BriKing Family AI，MIT）移植。**一个技能 + 一个 MCP 服务**：

| 组件 | 位置 | 说明 |
|---|---|---|
| 技能 | `skills/agent-reach-mcp/` | 三档选档规则、`reach_run` 生命周期、证据与缺口纪律（含 7 份分类参考） |
| MCP 服务 | `mcp/agent-reach-mcp.mjs` + `mcp/launch.sh` | 18 个工具：`reach_run` / `reach_status` / 单渠道 `reach_*` |
| 核心 | `mcp/core/` | planner、scheduler、contracts、evidence、runs、health、credentials、cache、auto-extend |
| 渠道 | `mcp/providers/` | tavily / exa / jina / parallel / tinyfish / firecrawl / valyu / scrapfly / academic / community / external-research |
| 浏览器 AI 助手 | `scripts/browser-ai.mjs` | 豆包 / Gemini 页面脚本（宿主差异见下） |

## 装了什么、改了什么

- **技能名 `agent-reach` → `agent-reach-mcp`**。机器上已有 CLI 版 `agent-reach`（`~/.agents/skills/agent-reach`，15 平台 CLI：小红书 / X / FB / IG / 雪球 …），而技能注册表一个名字只留一个 provider。改名后两者并存、分工互补：
  - `agent-reach`（CLI）：平台账号类渠道。
  - `agent-reach-mcp`（本插件）：`reach_*` MCP 渠道与三档调研工作流。
- MCP 工具名不变（18 个），DSH 里呈现为 `mcp__reach__reach_run` 这类带前缀的名字（patch 里 `serverName: reach`）。
- 凭据不出插件：继续用 `~/.agent-reach/briking/`（`keys.env` / `social.env` / `providers.json`），`mcp/launch.sh` 只导出该进程需要的少数变量。
- 二进制 / 代码逻辑未改；只补了 DSH 宿主说明（技能开头、`references/browser-ai.md`）。

## 前置条件

1. Node.js ≥ 18（`mcp/launch.sh` 自查版本与路径）。
2. 渠道密钥放在 `~/.agent-reach/briking/`。缺 key 的渠道在 `reach_status` 里显示未配置，不影响其他渠道。

## 验证

```bash
cd ~/Documents/hackerking
node plugins/agent-reach/scripts/selftest.mjs
# OK skills / OK mcp tools(18) / OK reach_status 离线体检
```

`reach_status` 是**离线**体检：只看配置与历史调用，不联网、不消耗额度。

## 凭据（没有“搬过来”这一步，是原地复用）

ZCode 版与本插件读的是同一份凭据目录，所以不需要拷贝：`~/.agent-reach/briking/`

| 文件 | 内容 |
|---|---|
| `keys.env` | `TAVILY_API_KEYS`（5 个 key）、`EXA_MCP_SERVERS` |
| `social.env` | `TWITTER_AUTH_TOKEN`、`TWITTER_CT0` |
| `providers.json` | `jina` / `tinyfish` / `firecrawl` / `valyu` / `scrapfly` 各 1 个 key |

`mcp/launch.sh` 启动时 source 前两个 env 文件，其余由 `mcp/core/credentials.mjs` 惰性读取；
插件目录里不存、不复制、不打印任何密钥（`reach_status` 也只报「已配置/密钥数量」）。

## 渠道实测（2026-10-21，本机）

| 渠道 | 结果 | 备注 |
|---|---|---|
| `tavily` | ✅ 真检索（3.5s） | 5 key 轮询 |
| `exa`（`reach_search`） | ✅ 真检索（3.7s） | 一次 wide 档贡献 17 条证据 |
| `parallel` | ✅ 匿名检索 | 免 key |
| `tinyfish`（`reach_provider`） | ✅ 检索（1.9s） | 免费额度 |
| `firecrawl`（read） | ✅ 正文（1.4s） | 已被 `reach_read` 回退链使用 |
| `scrapfly`（read） | ✅ 正文（8.7s） | 回退链第二级 |
| `github` / `bilibili` / `rss` / `youtube` | ✅ | 零配置 CLI/API |
| `reach_read` | ✅ 正文 | Jina 不可达时自动回退（见下） |
| `jina`（r.jina.ai） | ❌ TLS 重置 | 本机网络不可达，已做回退 |
| `v2ex` | ❌ ECONNRESET | 本机网络不可达（直连与系统代理 1082 都失败） |
| `wechat` / `twitter` / `doubao` / `gemini` | 交接对象 | 设计如此：返回 `browser_action_required`，主会话用 `browser-automation` / `cua_*` 执行 |

`reach_run` 端到端：`fast` 档 4.6s 拿到 20 条证据；`wide` 档 5.1s 拿到 42 条（parallel 6 / tavily 8 / exa 17 + 零散），
`finalize` 正常收敛。

## 两个额外的移植补丁（上游没有）

1. **正文读取回退链**：`r.jina.ai` 在本机被 TLS 重置，上游 `reach_read` 单通道直接报 `fetch failed`。
   现在 `mcp/legacy.mjs` 里改成 Jina → Firecrawl scrape → Scrapfly scrape，并且 Jina 失败后 10 分钟内
   直接跳过它（第二次读取从 6.7s 降到 0.4s）。
2. **浏览器交接改指 DSH**：上游交接对象写的是 `browser-use:control-browser` + `mcp__node_repl__js`
   + `agent.browsers.get('iab')`，DSH 里没有这套运行时。改成 `skill: "browser-automation"`
   （Playwright）；若另装 `computer-use` 才有 `cua_*` 兜底；策略字段（限频、遇验证码停止、关标签）不变。

## 用法

```text
reach_run(op="describe")
reach_run(op="start", plan={query, tier:"wide", reason, costPolicy, includeSocial}, requestKey="...")
reach_run(op="get", runId="...")                                   # 先读证据
reach_run(op="advance", runId, revision, tasks, claims, requestKey) # 需要再补一轮
reach_run(op="finalize", runId, revision, claims)
```

- 选档：查事实/链接 → `fast`；比较/选型/口碑 → `wide`；系统梳理/论文/争议 → `deep`。
- 判断不了就 `wide` 并说明理由，不要让用户选 API。
- `deep` 会自动延伸 2–3 轮（数十秒到几分钟），patch 里工具超时已给到 300000ms。
- 详细纪律见 `skills/agent-reach-mcp/SKILL.md`。

## 回滚

```bash
# 只停 MCP、保留技能：从 profile 的 cordis.patch.yml 删除 mcp-agent-reach 行
bash scripts/uninstall-local.sh --profile desktop
```

## 许可与来源

上游 `briking-agent-reach` 3.3.0，MIT，作者 BriKing Family AI；差异见 [NOTICE.md](./NOTICE.md)。
