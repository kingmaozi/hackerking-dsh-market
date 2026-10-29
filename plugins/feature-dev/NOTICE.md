# NOTICE

本包是 `feature-dev` 的 **DSH 原生适配版**，Apache-2.0。

- 上游：Anthropic `claude-plugins-official` 的 `feature-dev` 与 `code-review`（Apache-2.0）。
- 中转：ZCode 市场 `briking-private` 的 `feature-dev@1.1.0`（BriKing Family AI 适配，Apache-2.0），
  本包从该版本移植并改写工具面。
- 本包改写内容：`commands/*.md` → 技能、`agents/*.md` → `subagent` 角色简报、
  工具名映射（`Read`→`read`、`Bash`→`bash`、`Task`/`Agent`→`subagent`）、
  删除 ZCode 专有的 model/thoughtLevel/disallowedTools frontmatter、补 DSH 安装与自检。
- 原件的授权边界、证据口径、审查 confidence 门槛、回帖需授权等规则**原样保留**，未放宽。

不包含样本、密钥、许可证或第三方二进制。
