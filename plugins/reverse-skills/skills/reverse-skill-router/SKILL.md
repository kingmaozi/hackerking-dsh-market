---
name: reverse-skill-router
description: 逆向/破解/渗透/CTF/移动/固件/恶意样本任务的总控路由。任务跨模块、入口不确定、或需要先做 scope 建档与工具预检时先加载本技能。
---

# Reverse Skill — DSH 路由包

本包把上游 `zhaoxuya520/reverse-skill` 的 46 个技能整包接入 DeepSeek Harness：1 个总控路由 + 43 个一级模块 + 2 个模块内子技能。路由核心是插件内的 `repo/` 快照，不要求把上游仓库当工作区。

## 0. 路径解析（每次进入先做）

DSH 可能把本技能以**符号链接**发现（本项目 `.dsh/skills/reverse-skill-router`）。此时本文件的 base dir 是链接路径，`..` 只到 `.dsh/`，**不能靠上两级找插件根**。先解析 `<CORE>`：

```bash
CORE=""
for p in "$HOME/Documents/hackerking/plugins/reverse-skills/repo" \
         "$HOME/.dsh/profiles"/*/node_modules/reverse-skills/repo; do
  if [ -f "$p/RULES.md" ]; then CORE="$p"; break; fi
done
echo "CORE=$CORE"
[ -n "$CORE" ] || echo "未找到 CORE：手工 export CORE=<插件根>/repo"
```

- 工作区安装通常是 `~/Documents/hackerking/plugins/reverse-skills/repo`。
- profile 安装通常是 `~/.dsh/profiles/<profile>/node_modules/reverse-skills/repo`。
- `<CORE>` 包含 `RULES.md`、`skills/`（模块技能 + `config/routing.json` 的 44 条路由 + `scripts/` + `ops/` + `field-journal/`）。
- 技能正文里的相对路径（`../tool-index.md`、`../field-journal/...`）都以 `<CORE>/skills/` 为基准。
- 解析结果写进当前 case 的 `notes/static.md`，后续命令直接复用 `$CORE`。

## 1. 本机执行入口（macOS / bash）

```bash
bash <CORE>/skills/scripts/master-route.sh --hint "<用户任务>"
bash <CORE>/skills/scripts/case-init.sh --hint "<任务>" --case-name "<case>" --project-root "<项目根>"
bash <CORE>/skills/scripts/case-guard.sh --case-root "<项目根>/work/<case>"
bash <CORE>/skills/scripts/refresh-tool-index.sh "<工作目录>/tool-index.md" "<工作目录>/tool-index.json"
```

工作区 `~/Documents/hackerking` 另有一套更贴合破解交付的封装，优先用：

```bash
bash ~/Documents/hackerking/scripts/preflight.sh
bash ~/Documents/hackerking/scripts/new-case.sh <case> <样本路径>
```

## 2. 执行契约（按顺序做，不要只回“已读”）

1. **NOW 读契约**：`<CORE>/RULES.md`（行为链唯一真相源）；需要模块总表时读 `<CORE>/skills/INDEX.md`。
2. **NOW 路由**：跑 `master-route.sh` 拿 PRIMARY。路由唯一事实源是 `<CORE>/skills/config/routing.json`；有歧义再读 `<CORE>/skills/routing.md` 或 `MASTER-ROUTING.md`。
3. **NOW 建档与门禁**：用 `case-init.sh`（或工作区 `new-case.sh`）在项目根落地 `work/<case>/scope.md`。**`auth.status=granted` 加合法 `network_profile`（或 offline-sample 就绪）之前，禁止对目标 ACT**；`--force` 不能绕过硬门。自有本地样本用 `--preset offline-sample --sample <文件>`；公开 CTF 用 `--preset ctf-public --target-url <URL>`。
4. **ACT**：用 DSH 的 `skill` 工具加载 PRIMARY 对应的技能，执行它的 `ACTION REQUIRED`。工具路径只认 tool-index（下一步），缺工具才 bootstrap，且只按清单，不猜路径。
5. **收尾**：结论按 Evidence → Finding → Path 组织（`<CORE>/skills/ops/evidence-finding-path.md`）；要交付物时走 `docs-generator`，用 `case-review` 校验证据链与 hash。

## 3. DSH 工具映射

| 上游写法 | DSH 实际 |
|---|---|
| shell / Bash / PowerShell | `bash`（macOS 一律 bash；不要用 PowerShell 入口） |
| Read / 读文件 | `read` |
| Write / Edit | `write` / `edit` |
| Grep / Glob / 检索 | `grep` / `glob` |
| Task / 子代理 | `subagent`（叶子任务）或 `spawn_teammate`（并行长任务） |
| Skill / 加载技能 | `skill` |
| 后台任务 | `bash` 的 `run_in_background` + `job_output` |

## 4. 产物写进项目，插件目录只读

路由与 case 产物默认落在 `--project-root`（不传就是当前 cwd）的 `work/` 下。推荐工作区结构：

```text
~/Documents/hackerking/
├── cases/<case>/
│   ├── scope.md          # 授权/范围/网络画像
│   ├── sample/           # 原始样本副本（只读）
│   ├── notes/            # static.md / dynamic.md / hypotheses.md
│   ├── evidence/         # 命令输出、截图、dump、hash
│   ├── patches/          # 补丁脚本、patch bytes、重签名产物
│   └── report.md
└── work/<case>/          # 上游 router 的默认产物（timeline 等）
```

工具索引首次使用或怀疑过期时生成到 case 或工作目录，之后以它作为工具可用性的唯一来源。**不要为了“工具齐活”自动安装软件或注册 MCP server**；缺什么先列清单，由用户决定。

## 5. 常见入口速查

| 任务 | PRIMARY 模块 |
|------|--------------|
| APK 解包 / smali / 重打包 | `apk-reverse` |
| 前端 JS 签名与加密参数 | `js-reverse` |
| IDA Pro 反编译与交叉引用 | `ida-reverse` |
| Ghidra / Binary Ninja / radare2 | `ghidra-reverse` / `binary-ninja-reverse` / `radare2` |
| Android + iOS 动态插桩、反检测 | `mobile-reverse` |
| 恶意样本分析、YARA/Sigma | `malware-analysis` |
| 固件提取与仿真 | `firmware-pentest` |
| 从逆向到可用 exploit | `pwn-chain` |
| 补丁差分与 N-day | `patch-diff-exploit` |
| 完整渗透 / 演练编排 | `attack-chain` |
| CTF | `ctf-sandbox` |
| Web/API 安全测试 | `api-security` / `code-audit` |
| 报告与图表 | `docs-generator` / `diagram-generator` |
| 证据链校验 | `case-review` |
| 授权校验定位与补丁 | `license-patch`（crack-lab） |
| 序列号/注册机算法 | `keygen-model`（crack-lab） |
| 原生脱壳/反调试 | `native-unpack`（crack-lab） |

完整模块表在 `<CORE>/skills/INDEX.md` 与 `<CORE>/skills/routing.md`；模块内的工具链、阶段门、检查清单以各自 `SKILL.md` 为准。

## 6. 路由后的执行纪律

- 先静态后动态：能在文件里定位的，不要先起调试器。
- 每个结论必须能复现：命令 + 输入 hash + 偏移/地址 + 输出片段。
- 改样本前先备份，记录原始 hash 与 patch bytes；任何补丁都要留回滚副本。
- 观察、推断、未知分开写；不要把“字符串像校验”写成“已确认校验”。
- 一个模块跑完再换下一个；跨模块时回到本路由重新定 PRIMARY。
- 用户给了具体样本就直接开工，不要先反问“你想做什么”；缺关键信息时只问一个最小问题并给出默认假设。
