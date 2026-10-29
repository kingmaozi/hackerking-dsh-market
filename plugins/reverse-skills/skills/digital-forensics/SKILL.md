---
name: digital-forensics
description: Use for authorized digital forensics including memory dumps, disk timelines, PCAP investigation, artifact triage, and IR evidence preservation.
---

> **DSH 适配说明（本插件生成，非上游原文）**
> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do [ -f "$p/RULES.md" ] && CORE="$p" && break; done`。
> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/digital-forensics/`，正文里的相对路径都以此为准。
> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。
> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。
> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。
> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。
> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。

# Digital Forensics & IR Artifacts

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 读取 `../field-journal/precedent-pentest.md` 或组织 IR 授权说明
2. `NOW`: 确认是**取证/溯源**而非进攻性扫描
3. `NOW`: 建立 case；证据只读副本优先（原始介质写保护）
4. `NEXT`: tool-index；Volatility 等常手动
5. `ACT`: 保全哈希 → 时间线 → 关键伪影

## 适用场景

- 内存转储分析（Volatility 2/3）
- 磁盘/ E01 / 落地文件时间线
- PCAP 溯源与协议还原（可联合 `protocol-reverse/`）
- 主机伪影：Prefetch、Shimcache、Event Log、浏览器历史
- 应急响应 IOC 提炼（联合 `malware-analysis/` / `threat-hunting/`）

## 工作流

### 1. 保全

```text
□ 计算 SHA256；记录时区与采集命令
□ 工作在副本上；原始只读
□ chain of custody 备注写入 timeline
```

### 2. 内存

```bash
vol -f mem.dmp windows.info
vol -f mem.dmp windows.pslist
vol -f mem.dmp windows.netscan
vol -f mem.dmp windows.cmdline
```

### 3. 主机伪影

```text
□ 事件日志：Security / PowerShell / Sysmon
□ 持久化：Run 键、服务、计划任务、WMI
□ 执行痕迹：Amcache、Prefetch、BAM
```

### 4. 网络

```text
□ tshark 统计会话与 DNS
□ 导出可疑流 → protocol-reverse 或 malware C2 分析
```

## 工具链

| 工具 | 用途 |
|------|------|
| Volatility 3 | 内存 |
| Timeline Explorer / Plaso | 超级时间线 |
| tshark | PCAP |
| Eric Zimmerman 工具集 | Windows 伪影 |
| Autopsy / FTK Imager | 磁盘 |

## 参考

- `references/forensics-triage.md`
- `../malware-analysis/` `../threat-hunting/` `../protocol-reverse/`

## 路由上下文

**上游**: MASTER R25  
**下游**: 恶意样本深挖 → malware-analysis；规则 → threat-hunting

## 任务完成自检

- [ ] 是否保全哈希与副本策略？
- [ ] 时间线是否可复核？
- [ ] IOC 是否脱敏分级？
- [ ] Checklist？
