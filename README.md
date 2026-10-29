# HackerKing 逆向破解市场 / HackerKing Reverse Engineering Market

DSH 插件市场索引（format 1），全部插件以 **git 源 + 固定 commit** 发布：不需要 npm registry，装的时候 pnpm 直接从这个仓库拉指定子目录。

## 市场地址

```text
https://raw.githubusercontent.com/kingmaozi/hackerking-dsh-market/main/index.json
```

把它加进 DSH 的插件市场索引：**设置 → 插件 → 市场 → 添加索引**，或让 agent 用 `plugin_market` / `plugin_manager` 装。

## 手动安装单个插件

```bash
pnpm add "git+https://github.com/kingmaozi/hackerking-dsh-market.git#<commit>&path:/plugins/<name>"
```

`<commit>` 就是 `index.json` 里该版本 `source.commit` 的值，市场里点安装会自动拼好。

## 插件清单

| 插件 | 版本 | 分类 | 说明 |
|---|---|---|---|
| `dsh-composer-prediction` | 0.7.7 | productivity | 助手回复后在空输入框显示下一句预测；Tab 接受到草稿、Esc 关闭，含 Predictions 设置与同类插件冲突检测。 |
| `reverse-skills` | 0.2.2 | reverse-engineering | 46 个逆向/破解/渗透/CTF/移动/固件技能，含上游路由核心与 scope 门禁。 |
| `rea` | 0.4.1 | reverse-engineering | REA 配套 Skill + 官方 rea-agents MCP，覆盖原生、托管、Electron 与固件目标。 |
| `ghidra-bridge` | 0.2.0 | toolchain | Ghidra + GhidraMCP 安装、无头批量分析与 DSH MCP 接线。 |
| `crack-lab` | 0.2.0 | reverse-engineering | 七阶段破解工作台：接单建档、授权补丁、注册机、APK、脱壳与证据报告。 |
| `project-memory` | 0.1.0 | development | 按项目绝对路径哈希隔离的 .dsh/memory/<slug>.md 记忆，配 project-memory 技能与三个记忆工具。 |
| `feature-dev` | 0.2.1 | development | 从 ZCode 移植的功能开发工作流：探索、架构、有边界实现、证据验证与独立审查，五个技能可由 subagent 分角色执行。 |
| `imgen` | 0.1.0 | productivity | 用本机已登录的 ChatGPT / Codex 账号（OAuth）生图与改图：imgen 技能 + imgen MCP（imgen_generate / imgen_health），不要 API Key，不按张计费。 |
| `agent-reach` | 0.1.0 | productivity | 从 ZCode 移植的三档全网调研：fast / wide / deep，走 reach_* MCP 渠道（Tavily、Exa、Jina、Parallel、TinyFish、Firecrawl、Valyu），自带证据 ID、反例与缺口说明。 |
| `lcu` | 0.1.0 | toolchain | 把 Codex 官方 computer-use 运行时（LCU）接成 DSH 的 MCP：js / js_reset 两个工具，App 控制按 Touch ID 批准名单放行，未批准一律 decline。 |
| `computer-use` | 0.1.0 | toolchain | macOS 桌面操作工具：cua_* 系列（截屏、窗口枚举、点击、移动、输入、按键、滚动、拖拽），后端只用 screencapture + cliclick + osascript + pyobjc。 |
| `dsh-artcraft-plugin-pdfcraft` | 0.1.3 | productivity | PDF 读取、编辑、抽取与整页渲染（pdfcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-gridcraft` | 0.1.3 | productivity | 电子表格：单元格、公式、图表与 xlsx 读写（gridcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-wordcraft` | 0.1.3 | productivity | 文字处理：段落、样式、目录与 docx 读写（wordcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-photocraft` | 0.1.3 | productivity | 位图编辑：图层、选区、滤镜与导出（photocraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-vectorcraft` | 0.1.3 | productivity | 矢量绘图：路径、贝塞尔、描边与 SVG/PDF 导出（vectorcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-designcraft` | 0.1.3 | productivity | 页面排版：画板、母版、图文混排与印刷导出（designcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-deckcraft` | 0.1.3 | productivity | 演示文稿：幻灯片、版式、备注与 pptx 读写（deckcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-cadcraft` | 0.1.3 | productivity | CAD 绘图：实体、图层、尺寸标注与 dxf/dwg/svg 转换（cadcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-soundcraft` | 0.1.3 | productivity | 音频工作站：音轨、效果、混音与导出（soundcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-effectcraft` | 0.1.3 | productivity | 动效合成：合成、关键帧、特效与渲染（effectcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-filmcraft` | 0.1.3 | productivity | 非线性剪辑：时间线、转场、多机位与转码（filmcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |
| `dsh-artcraft-plugin-lightcraft` | 0.1.3 | productivity | 照片库与 RAW 显影：目录、评级、显影参数（lightcraft-cli），由 DSH 插件无头驱动：命令目录、执行、检查、转换与自带 MCP 服务器。 |

## 安装后处理（MCP 类插件）

带 MCP 的插件（`lcu` / `imgen` / `agent-reach` / `rea` / `ghidra-bridge`）在 `cordis.patch.yml` 里记录了**发布机上的绝对路径**。换机器安装后跑一次：

```bash
bash scripts/relocate.sh ~/.dsh/profiles/<profile>
```

它把 patch 里的发布机路径改写成当前 profile 的 `node_modules/<name>/...`，并把 node 路径换成当前 `command -v node`。

## 目录

```text
index.json           # 市场索引（DSH format 1）
plugins/<name>/      # 每个插件的完整包（package.json 里 dsh.bundle.patch 指向 cordis.patch.yml）
scripts/relocate.sh  # MCP 插件换机路径修正
```

## 许可

各插件自带 LICENSE / NOTICE.md，第三方来源在各自的 NOTICE.md 里注明。仓库根许可见 LICENSE。
