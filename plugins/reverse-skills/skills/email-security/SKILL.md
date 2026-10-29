---
name: email-security
description: Use for authorized email security review including phishing analysis, header authentication (SPF/DKIM/DMARC), BEC patterns, and mailbox token abuse research.
---

> **DSH 适配说明（本插件生成，非上游原文）**
> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do [ -f "$p/RULES.md" ] && CORE="$p" && break; done`。
> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/email-security/`，正文里的相对路径都以此为准。
> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。
> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。
> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。
> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。
> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。

# Email Security & Phishing Analysis

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 确认授权（分析样本邮件 / 租户配置评审）
2. `NOW`: 不向真实用户二次投递恶意样本
3. `ACT`: 头认证 → 内容/URL → 附件沙箱 → 租户控制面建议

## 适用场景

- 钓鱼邮件拆解与 IOC
- SPF/DKIM/DMARC 配置评估
- BEC 商务邮件欺诈模式
- OAuth 应用钓鱼 / 邮箱令牌滥用（联合 llm/cloud 身份）
- 安全意识演练设计（授权）

## 工作流

```text
□ 完整原始头：Received 链、From/Return-Path 一致性
□ SPF/DKIM/DMARC 对齐结果
□ URL 沙箱与附件静态（联合 malware-analysis）
□ 仿冒品牌与回复地址差异
□ 租户：反钓鱼策略、外部标记、MFA、OAuth app 同意
```

## 工具链

| 工具 | 用途 |
|------|------|
| 邮件客户端「查看源」 | 头 |
| dig/nslookup | SPF/DMARC 记录 |
| urlscan / 沙箱 | 链接与附件 |
| 租户管理中心 | 策略 |

## 参考

- `references/email-auth-checklist.md`
- `../malware-analysis/` `../attack-chain/`（钓鱼阶段） `../windows-ad/`（令牌）

## 路由上下文

**上游**: MASTER R36  
**MUST NOT**: 未授权对第三方域群发测试钓鱼

## 任务完成自检

- [ ] 头认证结论是否完整？
- [ ] IOC 是否可检测化（联合 threat-hunting）？
- [ ] Checklist？
