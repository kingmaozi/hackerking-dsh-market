# rea

**REA 原生逆向分析** for DeepSeek Harness。把 [morluto/rea](https://github.com/morluto/rea)（MIT）的官方 MCP 服务与同版本配套 Skill 接进 DSH：

- **Skill**：`reverse-engineer-anything`，教模型在原生二进制、托管程序、Electron/JavaScript、安装包、固件、浏览器与运行时目标上选择正确的 REA 工具，并要求每条结论落到 Evidence。
- **MCP**：`rea`，`npx -y rea-agents@6.4.0 mcp`，stdio 传输，工具名形如 `mcp__rea__open_binary`。
- **不装引擎**：Ghidra / IDA / JADX / Binwalk / Unblob 是独立分析引擎，本插件不下载、不升级；REA 会按目标与已配置的 provider 选择可用引擎。

## 版本选择（重要）

MCP 固定 **rea-agents 6.4.0**。6.7.0 新增的 macOS process ownership Swift helper 需要 Swift 编译器与 SDK 严格匹配；本机 Command Line Tools 26.3（Swift 6.2.4）与 SDK 26.2（Swift 6.2.3）不一致，`binary_session` 会在编译 helper 时失败。装好匹配的 CLT 26.5/26.6 后，把 `cordis.patch.yml` 里的版本改回 `6.7.0` 即可。

Skill 同步使用上游 6.4.0 的 v37（170 个工具），与 MCP 版本一致。

## 安装

```bash
bash ~/Documents/hackerking/scripts/install-local.sh --profile desktop
```

或直接装进任意 profile：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:/Users/zhangsugang/Documents/hackerking/plugins/rea
# 把 rea 加进 package.json 的 dsh.profile.bundles
```

首次调用 REA 工具时 `npx` 会拉取 `rea-agents@6.4.0`。REA doctor 不接受 Node 25，所以 `cordis.patch.yml` 默认把 MCP 固定到本机 Node 24（`/Users/zhangsugang/.nvm/versions/node/v24.14.0/bin/npx`）并把该目录前置到 `PATH`。换机器时改这两行即可。

## 使用

```text
用 REA 打开这个二进制，先给我 binary_overview，再定位校验函数。
分析这个 APK 的 classes.dex，找签名校验与网络入口。
比较这两个版本的 Electron 应用，列出新增的 native 模块。
```

先加载技能（DSH 会自动出现在技能目录）：

```text
skill: reverse-engineer-anything
```

然后按技能里的路由选第一个工具：

| 目标 | 第一个工具 |
|---|---|
| 原生可执行文件 / 库 | `open_binary` |
| ASAR / Electron JS 树 | `analyze_javascript_application` |
| APK / IPA / ZIP / DMG 成员清单 | `open_binary` 或 `inspect_artifact` |
| Android 代码/方法/引用 | `inspect_android_package` |
| 托管 PE/CLI | `inspect_managed_artifact` |
| 固件 | `inspect_firmware_regions` / `extract_firmware` |
| 已打开的浏览器页面 | `list_browser_targets` |
| HAR / mitmproxy 抓包 | `inspect_web_network_capture` |

完整路由在 `skills/reverse-engineer-anything/SKILL.md` 与 `references/`。

## 关闭 MCP、只用技能

REA 6.4.0 会注册 **170 个 `mcp__rea__*` 工具**。上下文紧张或只用静态技能时，建议关掉 MCP 行（下面的 patch），需要时再开。

在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: mcp-rea
  disabled: true
```

## 排障

- `mcp__rea__*` 工具没出现：看 DSH 日志里的 `[rea]` / MCP 连接错误；先在终端跑 `npx -y rea-agents@6.4.0 mcp --help` 确认能拉起。
- 工具出现但调用报 `resource_constraint`：按技能里的 `inspect_analysis_view` / `export_evidence_bundle` 取分页或导出，不要重复分析。
- 原生反编译不可用：REA 需要单独的 Ghidra/IDA provider；先跑 `binary_session` 看 `tool_availability`，再按 `references/connection-and-recovery.md` 修。

## 许可

REA 上游 MIT（`LICENSE`，Copyright (c) 2026 morluto）。本包只做 DSH 适配：Skill 正文与 MCP 版本跟随上游 `6.4.0`。


## 0.4.1：输入 Schema 兼容修复

REA 6.4.0 会在 `tools/list` 输入定义中复用 `$defs`。部分模型接入链路解析时丢失引用上下文，出现 `Pointer /$defs/__schema2 does not exist`。

本插件通过 `lib/mcp-compat.js` 转发 stdio，仅将 `tools/list` 的 `inputSchema` 本地引用内联；保留类型、required、额外属性限制和引用旁约束。不改变工具调用参数、分析结果和 outputSchema。缺失、循环及外部引用返回明确的 MCP 错误，不降级成任意类型。保持 REA 6.4.0，避免引入已有的 Swift/SDK 版本问题。

验证：`node --test plugins/rea/scripts/schema-compat.test.mjs`（在仓库根目录）。

接线使用现有本机 Node 24 路径，新增的代理脚本路径同样需在迁移机器时调整。应用补丁后重新连接 `mcp-rea`；若旧会话仍缓存工具目录，完整退出并重启 DSH。
