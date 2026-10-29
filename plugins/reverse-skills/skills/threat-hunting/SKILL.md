---
name: threat-hunting
description: Use for blue-team threat hunting, detection engineering with Sigma/YARA, SIEM query design, and incident detection validation.
---

> **DSH 适配说明（本插件生成，非上游原文）**
> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do [ -f "$p/RULES.md" ] && CORE="$p" && break; done`。
> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/threat-hunting/`，正文里的相对路径都以此为准。
> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。
> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。
> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。
> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。
> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。

# Threat Hunting & Detection Engineering

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 确认蓝队/狩猎授权与数据源范围（SIEM、EDR 导出）
2. `NOW`: 明确假说（hypothesis）再查数，避免无脑刷告警
3. `NEXT`: 工具与数据接入方式
4. `ACT`: 假说 → 查询 → 验证 → 规则化

## 适用场景

- 威胁狩猎（hypothesis-driven）
- Sigma / YARA 检测工程
- 告警调优、误报分析
- 与 `malware-analysis/`：样本侧 IOC → 本 skill 落地检测
- 与 `digital-forensics/`：案件伪影 → 横向狩猎

## 工作流

### 1. 建假说

```text
例：攻击者用 living-off-the-land 做横向
→ 数据源：Sysmon 1/3/10、Windows Security 4624/4648
→ 成功标准：发现异常父进程或罕见账户日志源
```

### 2. 查询与堆叠

```text
□ 基线：正常管理员行为时段与主机
□ 异常：新服务、编码 PowerShell、异常出站
□ 关联：同账号多主机短时登录
```

### 3. 规则化

```yaml
# Sigma 骨架见 malware-analysis；本 skill 强调：
# - 误报面
# - 数据源字段映射
# - 响应 playbook 链接
```

### 4. 验证

```text
□ 原子测试（Atomic Red Team）仅在授权实验室
□ 回放历史日志验证召回
```

## 工具链

| 工具 | 用途 |
|------|------|
| Sigma CLI / sigmac | 规则转换 |
| YARA | 文件/内存 |
| SIEM（ELK/Splunk 等） | 查询 |
| osquery | 端点狩猎 |
| Atomic Red Team | 检测验证（实验室） |

## 参考

- `references/hunting-loop.md`
- `../malware-analysis/references/yara-sigma-rules.md`
- `../digital-forensics/`

## 路由上下文

**上游**: MASTER R27  
**下游**: 确认入侵 → forensics；恶意样本 → malware-analysis  
**MUST NOT**: 在无授权生产环境跑攻击模拟

## 任务完成自检

- [ ] 是否有明确假说与结论？
- [ ] 规则是否注明误报与数据源？
- [ ] Checklist？
