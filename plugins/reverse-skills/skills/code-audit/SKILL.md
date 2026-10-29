---
name: code-audit
description: Use for authorized source-code security review and SAST workflows including Semgrep, CodeQL patterns, dangerous API hunting, and fix verification.
---

> **DSH 适配说明（本插件生成，非上游原文）**
> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do [ -f "$p/RULES.md" ] && CORE="$p" && break; done`。
> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/code-audit/`，正文里的相对路径都以此为准。
> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。
> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。
> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。
> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。
> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。

# Source Code Security Audit

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 读取 `../field-journal/precedent-pentest.md` 或代码审计授权
2. `NOW`: 确认有**源码/仓库访问**（无源码二进制 → 转 RE skill）
3. `NOW`: 明确语言栈与范围（目录/服务/PR diff）
4. `NEXT`: tool-index；semgrep 等
5. `ACT`: 威胁建模草图 → 自动扫描 → 人工验证

## 适用场景

- 白盒审计、PR/差分安全审查
- Semgrep / CodeQL / Bandit / gosec 等 SAST
- 危险 API、注入点、鉴权缺失、加密误用
- 与 `supply-chain-security/` 分工：本 skill 偏**自有代码逻辑**，供应链偏依赖与管道

## 工作流

### 1. 范围与威胁模型

```text
□ 信任边界：用户输入、文件、反序列化、SSRF、鉴权中间件
□ 高价值资产：鉴权、支付、管理端、密钥处理
```

### 2. 自动扫描

```bash
semgrep --config auto .
# 或项目规则包
semgrep --config p/owasp-top-ten .
```

### 3. 人工验证（MUST）

```text
□ 每个 SAST 命中：可达性？可利用性？误报？
□ 鉴权：IDOR/越权、缺校验、错误的多租户隔离
□ 注入：SQL/命令/模板/LDAP
□ 加密：硬编码密钥、ECB、自定义 crypto
```

### 4. 产出

```text
Finding：位置 + 数据流 + PoC + 修复建议
可选 ATT&CK / CWE 编号
```

## 工具链

| 工具 | 语言/场景 |
|------|-----------|
| Semgrep | 多语言快速规则 |
| CodeQL | 深数据流（GitHub） |
| Bandit | Python |
| gosec / staticcheck | Go |
| SpotBugs / FindSecBugs | Java |

## 参考

- `references/sast-review-checklist.md`
- `../supply-chain-security/` `../api-security/` `../llm-security/`（Agent 代码）

## 路由上下文

**上游**: MASTER R26  
**角色**: `ops/role-map.md` cae  
**下游**: 依赖漏洞 → supply-chain；运行时验证 → pentest-tools

## 任务完成自检

- [ ] 是否人工验证而非只贴扫描器输出？
- [ ] 是否含修复建议？
- [ ] 是否限定在授权仓库范围？
- [ ] Checklist？
