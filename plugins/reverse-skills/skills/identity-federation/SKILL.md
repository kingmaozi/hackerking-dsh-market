---
name: identity-federation
description: Use for authorized assessment of federated identity systems including SAML, OIDC, OAuth2 flows, SSO misconfiguration, and token confusion issues.
---

> **DSH 适配说明（本插件生成，非上游原文）**
> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do [ -f "$p/RULES.md" ] && CORE="$p" && break; done`。
> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/identity-federation/`，正文里的相对路径都以此为准。
> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。
> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。
> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。
> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。
> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。

# Identity Federation (SAML / OIDC / OAuth)

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 读取 precedent-pentest；SSO 测试账号与 IdP/SP 范围入 scope
2. `NOW`: 禁止锁定真实用户账户的暴力尝试
3. `NEXT`: 抓包工具与文档（元数据 URL）
4. `ACT`: 协议流映射 → 常见错配 → 验证

## 适用场景

- SAML Response 签名/断言篡改面（经典缺陷模式）
- OIDC 隐式/授权码 + PKCE 缺失
- redirect_uri / state / nonce 问题
- IdP 与 SP 元数据、多租户 issuer 混淆
- 与 `api-security` JWT 攻击互补（本 skill 偏联邦与 SSO 流）

## 工作流

```text
□ 画清：User → SP → IdP → Token → SP
□ 收集：/.well-known/openid-configuration、SAML metadata
□ 检查：redirect_uri 精确匹配、state 绑定、PKCE
□ 检查：SAML 签名覆盖范围、algorithm 降级
□ 会话固定与登出失效
```

## 工具链

| 工具 | 用途 |
|------|------|
| Burp + SAML Raider 等 | 断言编辑（授权） |
| jwt_tool | JWT 段 |
| 浏览器 DevTools | 重定向链 |
| IdP 管理日志 | 审计 |

## 参考

- `references/sso-flow-checklist.md`
- `../api-security/` `../windows-ad/`（企业 IdP）

## 路由上下文

**上游**: MASTER R37  
**下游**: 纯 API JWT → api-security；云 IdP → cloud-k8s

## 任务完成自检

- [ ] 是否映射完整 SSO 流？
- [ ] 每个 Finding 是否有复现与影响？
- [ ] Checklist？
