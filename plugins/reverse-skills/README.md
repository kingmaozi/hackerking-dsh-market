# reverse-skills

DeepSeek Harness 版的 **Reverse Skill**。把 [zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill)（MIT）整包注册为 DSH 原生技能：

- **46 个技能**：1 个总控路由 `reverse-skill-router`、43 个一级模块、2 个模块内子技能（`src-hunter`、`dsl-vm-reverse`）。
- **路由核心**：`repo/RULES.md` + `repo/skills/config/routing.json` 的 44 条路由 + `master-route.sh` / `case-init.sh` / `case-guard.sh`。
- **零依赖**：插件只用 Node 内置模块，不需要 `yaml`、不需要构建、不改用户技能目录。

## 安装

市场安装（DSH 插件市场索引）：

```bash
# 在 DSH 插件页添加索引后搜索 reverse-skills
```

本地安装：

```bash
bash ~/Documents/hackerking/scripts/install-local.sh --profile desktop
```

或把本目录作为本地包装进任意 profile：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:/Users/zhangsugang/Documents/hackerking/plugins/reverse-skills
# 然后把 reverse-skills 加进 package.json 的 dsh.profile.bundles
```

安装后重启 DSH，或让 profile HMR 重新组合，再新开一个会话。

## 使用

直接说任务，或用 `skill` 工具加载 `reverse-skill-router`：

```text
帮我逆这个 APK，看它怎么做签名校验
这个网页的加密参数是从哪来的，帮我定位
这个 ELF 没有符号，帮我恢复到可读
CTF 附件在这儿，帮我看一下
```

路由技能会先跑 `master-route.sh` 定 PRIMARY，再用 `case-init.sh` 落地 `work/<case>/scope.md` 过 scope 门禁，然后进入对应模块。

工作区 `~/Documents/hackerking` 另有一套更贴合破解交付的封装：

```bash
bash scripts/preflight.sh
bash scripts/new-case.sh <case> <样本路径>
```

## 技能目录

| 类别 | 技能 |
|---|---|
| 总控 | `reverse-skill-router` |
| 逆向 | `reverse-engineering` `ida-reverse` `ghidra-reverse` `binary-ninja-reverse` `radare2` `binary-diff` `patch-diff-exploit` |
| 平台 | `apk-reverse` `mobile-reverse` `js-reverse` `dotnet-reverse` `go-rust-reverse` `macos-reverse` `windows-ad` `thick-client` `browser-extension-reverse` |
| 加固/对抗 | `edr-bypass-re` `malware-analysis` `pwn-chain` `ctf-sandbox` `attack-chain` |
| 固件/硬件 | `firmware-pentest` `hardware-security` `radio-sdr` `wifi-wireless` `ot-ics` |
| Web/云 | `api-security` `code-audit` `database-security` `cloud-k8s` `identity-federation` `supply-chain-security` `email-security` |
| 情报/取证 | `threat-intelligence` `threat-hunting` `digital-forensics` `asset-correlation` `src-hunter` |
| 交付 | `docs-generator` `diagram-generator` `case-review` `dsl-vm-reverse` |

完整表在 `repo/skills/INDEX.md`。

## 产物与边界

路由与 case 产物默认写到项目根的 `work/`，推荐 `cases/<case>/`。插件目录只读。scope 门禁是硬门：`auth.status=granted` + 合法 `network_profile`（或 offline-sample 就绪）之前不 ACT。

## 许可

主体 MIT（`LICENSE` / `repo/LICENSE`）。快照内含组件按各自许可证：`CTF-Sandbox-Orchestrator/` 为 GPLv3，`skills/pentest-tools/src-hunter/` 自带 LICENSE。详见 `NOTICE.md` 与 `repo/README.md`。
