---
name: feature-dev-pr-review
description: PR 级只读审查流程：由主会话用 gh 冻结 repo、PR、base/head 完整 SHA 与范围，再派审查角色；默认只在聊天报告，回帖需明确授权；用户给 PR 链接或编号时加载。
whenToUse: 用户给出 PR URL/编号，要求审查合并风险、复现缺陷或出一份可引用的审查报告时。
---

# PR 审查（DSH 版 /code-review）

主会话负责取数、冻结与最终发布；审查角色只读。默认**只聊天报告**，不自动回帖。

## 1. 冻结输入（主会话执行）

用 `gh` 确认链接指向的真实仓库与 PR，形成冻结包：

- `repo`（canonical owner/repo）、`pr` 编号与 URL、state、draft、获取时间、用户授权范围。
- `baseSha`、`headSha`：**全部 40 位**；记录 base/head 仓库（含 fork）与分支。
- 该 base/head 的 diff、改动文件列表、必要上下文与 diff 摘要；不用浮动分支代替冻结源码。
- `scope`：纳入/排除文件、审查目标、风险与验收；适用目录的 `AGENTS.md` / `CLAUDE.md` 内容与位置。
- 相关历史 PR、评论与提交历史（由主会话用 `gh` 搜，审查角色不自己联网）。
- `reviewFingerprint`：repo/pr/base/head/scope + diff 与规范快照摘要。旧 head 的结论不能免掉新审查。
- 本地验证证据：基线 SHA、受测状态（含 dirty 摘要）、命令、退出码、环境、证据路径；没跑就写 `not-run`。

## 2. 审查

派 subagent 时内联 `feature-dev-review` 的规则，并把冻结包放进任务书。审查角色：

- 只看冻结 diff 与必要调用方，按 severity/confidence 报缺陷（confidence ≥ 80）。
- 验收缺口单列。
- 需要执行才能判断时，返回最小复现步骤，不声称观察到未运行的行为。

## 3. 报告

固定输出：范围与冻结状态 → 缺陷 → 验收缺口 → 未覆盖 → 建议动作。
每条缺陷带 `file:line` 与证据；结论分级 `passed` / `failed` / `blocked` / `not-run`。

## 4. 回帖（仅显式授权）

用户明确说"回到 PR"才发布，且由主会话执行：

1. 发布前重新确认 PR 仍是同一 `headSha`、state 未变。
2. 只发报告里已写下的内容，不改写结论。
3. 发布失败或版本漂移时保留证据，报告 `blocked`，不重试到成功为止。

## 边界

- 不修改代码、不推提交、不改 PR 状态（draft/merge/close）。
- 私有仓库需要登录与读取授权；没有就只对已有离线材料做有限审查，并标注限制。
