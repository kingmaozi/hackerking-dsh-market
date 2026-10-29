# feature-dev

功能开发工作流的 DSH 原生适配版：从一句需求到**能跑、能回归、能回滚、带证据**的改动，
按风险伸缩流程，用 `subagent` 分担探索、架构、实现、验证与独立审查。

移植自 ZCode 市场 `briking-private` 的 `feature-dev@1.1.0`（上游 Anthropic
`claude-plugins-official` 的 feature-dev 与 code-review，Apache-2.0）。

## 0.2.1 修复：`output.render` 层级

DSH 的 `tools.register()` 强制要求 `output` 恰好是 `{ schema, render, presentationMeta? }`：

```text
TypeError: tool "feature_dev_role" must declare output { schema, render, presentationMeta? }
```

0.2.0 把 `render` 写在了 ToolDefinition 顶层，注册即抛错 —— 插件页显示的“1 异常”就是它。
0.2.1 已把 `render` 移进 `output`，并在 `selftest.mjs` 里加断言防止回归。

## 角色模型绑定（`feature_dev_role`）

> 0.2.1 起：profile 里已把 `enableRoleTool` 设为 `false`，角色模型统一由
> `dsh-plugin-subagent-director` 的设置页管理（工具名 `subagent_role`，角色 id 相同）。
> 本工具保留但默认不注册，需要时把 `enableRoleTool` 改回 `true` 即可。


ZCode 原件在每个 `agents/*.md` 的 frontmatter 里钉死 `model:` 和 `thoughtLevel:`；DSH 没有 per-file
路由，所以本插件把同一件事做成一个派单工具：

```text
feature_dev_role(role="feature-dev-code", description="…", prompt="…")
```

模型解析顺序：**调用参数 > 角色绑定 > 插件默认 > 继承主代理**。角色表在插件 config 的 `roles` 段：

```yaml
- id: feature-dev
  config:
    provider: king
    model: deepseek-v4.1-flash
    reasoningEffort: high
    roles:
      feature-dev-code: { model: gpt-6.1-sol, reasoningEffort: xhigh }
      feature-dev-architect: { model: gpt-6.1-sol, reasoningEffort: high }
      feature-dev-review: { model: gpt-6.1-sol, reasoningEffort: high }
      feature-dev-pr-review: { model: deepseek-v4.1-flash, reasoningEffort: max }
```

两条硬约束：

1. 绑定的 route 必须同时被 `subagent-model-selection.allowedModels` 放行，否则核心丢弃 route，子代理静默继承主代理。
2. `provider` / `model` 必须成对；只给一个会被判无效并整体丢弃。

工具名默认 `feature_dev_role`（`config.toolName` 可改），传输 provider 默认 `spawn`
（`config.subagentProvider` 可改），`config.enableRoleTool: false` 可整体关掉只留技能。

## 五个技能

| 技能 | 用途 | 对应 ZCode 原件 |
|---|---|---|
| `feature-dev` | 总控：接单 → 风险分级 → 探索 → 架构 → 实施 → 验证 → 审查闭环 | `commands/feature-dev.md` |
| `feature-dev-pr-review` | PR 级审查：冻结 repo/PR/base/head → 只读审查 → 聊天报告，回帖需授权 | `commands/code-review.md` |
| `feature-dev-code` | 实现/验证角色简报：implementation / verification-only / exploration 三模式 | `agents/code.md` |
| `feature-dev-architect` | 只读架构角色简报：契约、数据流、文件级任务切分 | `agents/code-architect.md` |
| `feature-dev-review` | 独立只读审查角色简报：severity + confidence ≥ 80，验收缺口单列 | `agents/code-review.md` |

## ZCode → DSH 映射

| ZCode | DSH |
|---|---|
| `commands/*.md`（`/feature-dev`、`/code-review`） | 技能 `feature-dev`、`feature-dev-pr-review` |
| `agents/*.md` + 命名空间 `feature-dev:code` 等 | `subagent` 派单，把对应技能正文内联进任务书 |
| `model: new-provider-2/gpt-6.1-sol`、`thoughtLevel: xhigh` | 由主会话在派单时用 `provider`/`model`/`reasoning_effort` 指定 |
| `disallowedTools: [Agent, Task]` | 子代理默认不派生；任务书写明"不二次委派" |
| `injectAgentsMd: true` | DSH 的 `AGENTS.md` 自动注入，无需额外声明 |
| Dots 远端派活 | 不在本包内；由 DSH 的 `subagent` / Agent Teams 承接 |

原件的命令是斜杠命令，DSH 没有同名的用户斜杠命令面，所以两条命令改为**技能**：
说"用 feature-dev 开工"或"审这个 PR"即可加载，行为边界（授权、只读、证据口径）原样保留。

## 安装

```bash
bash ~/Documents/hackerking/scripts/install-local.sh --profile desktop
```

脚本会写 `link:` 依赖、建 `node_modules` 符号链接、把 `feature-dev` 加进
`dsh.profile.bundles`，并保留已有的市场索引配置。重启 DSH 后生效。

卸载：

```bash
bash ~/Documents/hackerking/scripts/uninstall-local.sh --profile desktop
```

## 用法

```text
skill: feature-dev
给这个仓库加一个 CSV 导出，先按风险判断要不要拆架构和审查。
```

```text
skill: feature-dev-pr-review
审一下 https://github.com/OWNER/REPO/pull/123，只出聊天报告，不要回帖。
```

```text
skill: feature-dev-code
以 feature-dev-code 的角色做这次修复：allowedFiles 只有 src/export.ts，验收是三个用例全绿。
```

## 自检

```bash
# 技能 + 角色路由逻辑（mock 服务，无需 DSH）
node plugins/feature-dev/scripts/selftest.mjs

# 工具定义过 DSH 官方 schema（可选，需解包 @deepseek-ai/dsh-tools）
DSH_TOOLS_DIR=/path/to/@deepseek-ai/dsh-tools node scripts/verify-schema.mjs
```

`selftest.mjs` 校验五个 `SKILL.md` 可解析、角色 route 解析顺序（role > plugin default > call override）、
后台派单走 `delivery: parent`、未知角色与半截 route 被拒。

`verify-schema.mjs` 用 DSH 自己的 `parameterSchemaSpecToJsonSchema` / `assertSupportedJsonSchema` /
`validateArgs` / `validateJsonSchemaValue` 校验工具定义与三种输出形状。注意 DSH 的两套 schema 方言：
`parameters` 用参数方言（字段级 `required: true`），`output.schema` 用标准 JSON-Schema 子集
（对象级 `required: [...]`，不支持 `type: 'json'`）。

## 边界

- 纯技能包：不注册工具、不挂 MCP、不改宿主配置、不注入提示词。
- 不自带模型路由；子代理模型由主会话或 `subagent` 参数决定。
- 不发放任何权限：审查只读、实施仅限任务书里的 `allowedFiles`。
