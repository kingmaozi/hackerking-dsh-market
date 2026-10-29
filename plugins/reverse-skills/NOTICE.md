# NOTICE / 出处与改动

- 上游仓库：https://github.com/zhaoxuya520/reverse-skill
- 快照 commit：`cab634bd855fc287f6e420c1f36fd1a6b9245960`（2026-09-22，分支 `main`）
- 上游版本：`1.0.1`（`repo/VERSION`）
- 许可：主体 MIT（`repo/LICENSE`）；`CTF-Sandbox-Orchestrator/` 为 GNU GPLv3（自带 LICENSE）；`skills/pentest-tools/src-hunter/` 自带 LICENSE；外部 Pentest Swarm AI 为 AGPL-3.0 且上游未收录其源码。

## 本插件相对上游的改动

1. 新增 `lib/`：DSH 原生 `SkillProvider`，读取本包 `skills/`，注册为 `reverse-skills`；只用 Node 内置模块，零依赖。
2. 生成 45 个模块技能（`scripts/build-skills.py`）：上游 frontmatter 与正文逐字保留，仅插入 DSH 适配头；`reverse-skill-router` 为手写 DSH 路由正文。
3. 新增 DSH 清单 `package.json` / `cordis.patch.yml` / `README.md` / `NOTICE.md` / `scripts/selftest.mjs`。
4. `repo/` 是上游快照：保留 `RULES.md`、`skills/`、`docs/`、`CTF-Sandbox-Orchestrator/`、`burp-mcp-full/`、`kali/`、`examples/`、脚本与许可证；排除 `.git/`、`.github/`、`plugins/`、`reverse-skill.png` 与空 `reports/`，以控制插件体积。上游技能正文、路由配置、脚本、契约文件均未修改。
5. 上游自带的薄适配器 `repo/plugins/reverse-skill/` 不在快照内；本插件的 `lib/` 取代它。

## 与 Codex 版的差异

- 技能发现走 DSH `ctx.skills.registerProvider`，不是 `.codex-plugin/plugin.json`。
- 工具映射改为 DSH：`bash` / `read` / `write` / `edit` / `grep` / `glob` / `subagent` / `skill`。
- 路由正文里的 `<CORE>` 路径、scope 入口与产物目录按 DSH 工作区调整。

## 授权边界

上游要求只对用户自有或已授权的目标动手，`scope.md` 门禁不得绕过。本插件保持这一约束，并把门禁接到 DSH 工作区的 `scripts/new-case.sh` / `case-guard.sh`。
