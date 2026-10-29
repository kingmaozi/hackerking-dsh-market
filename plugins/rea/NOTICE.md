# NOTICE / 出处与改动

- 上游仓库：https://github.com/morluto/rea
- 上游版本：`rea-agents 6.4.0`（MCP）与同版本配套 Skill（skill metadata v42）
- 许可：MIT（`LICENSE`，Copyright (c) 2026 morluto）

## 本插件相对上游的改动

1. 新增 `lib/`：DSH 原生 `SkillProvider`，读取 `skills/reverse-engineer-anything/`，注册为 `rea`；零依赖。
2. 新增 `cordis.patch.yml`：插入技能 provider 行与 `@deepseek-ai/dsh-mcp-client` 的 `mcp-rea` 行（stdio，`npx -y rea-agents@6.4.0 mcp`）。
3. 新增 DSH 清单 `package.json`、`README.md`、`NOTICE.md`、`scripts/selftest.mjs`。
4. Skill 正文与 `references/` 跟随上游 `6.4.0`，未改写分析结论或工具语义。

## 边界

- 不安装、不升级 Ghidra / IDA / JADX / Binwalk / Unblob 等分析引擎。
- 不把 REA 的工具描述复制成 DSH 原生工具；MCP 工具由 `dsh-mcp-client` 以 `mcp__rea__*` 注册。
