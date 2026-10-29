# NOTICE / 出处与改动

- 上游 Ghidra：https://github.com/NationalSecurityAgency/ghidra（Apache-2.0）
- 上游 GhidraMCP：https://github.com/LaurieWired/GhidraMCP（MIT）
- 技能与 `scripts/setup.sh` 改编自本机 BriKing 市场的 `ghidra-bridge` 插件（MIT），按 DSH 工具与 MCP 接线重写。

## 本插件相对上游的改动

1. `skills/ghidra-bridge/SKILL.md`：把 ZCode 接线改为 DSH `@deepseek-ai/dsh-mcp-client`，补充 `mcp__ghidra__*` 工具映射、无头批量流水线与验收清单。
2. `scripts/setup.sh`：除 `.mcp.json` 外生成 `ghidra-mcp.patch.yml`，支持 `--profile <name>` 追加并备份 profile patch。
3. 新增 `lib/` DSH 技能 provider、`package.json`、`cordis.patch.yml`、`README.md`、`NOTICE.md`、`scripts/selftest.mjs`。

## 边界

不随包分发 Ghidra 本体、GhidraMCP jar 或 Python 依赖；`setup.sh` 在用户机器上按需下载/安装。
