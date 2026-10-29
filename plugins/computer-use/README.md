# computer-use

**macOS 上的 computer-use 能力，以 9 个 `cua_*` 工具接进 DeepSeek Harness。**

一句话结论：**DSH 本身没有内建 computer-use**（应用包里没有 `cua-helper`，`@deepseek-ai/*` 里也没有任何
computer 包）；**ZCode 的闭源 helper 驱动不了**（它做客户端签名校验，日志里是
`cua broker rejected connection: peer verification failed`）；**所以本插件自己落地**，后端只用系统自带组件
（`screencapture` / `sips` / `osascript`）加一个已装好的 `cliclick`，外加 `python3 + pyobjc` 做滚动、窗口枚举和
TCC 权限探针。

- 不 import 任何 `@deepseek-ai/*` 内部包，profile 里 `node_modules` 断链也不影响挂载。
- 不需要 Swift helper（本机 CLT 26.3 与 SDK 26.2 不匹配，`swiftc` 直接编不过，和 `plugins/rea` 踩的是同一个坑）。
- 截图能真回给模型（`attachments.saveImage` → `{type:'image'}` 内容块），坐标与图片 1:1。

官方同生态备选：`@anionex/computer-use@0.3.4`（MIT，11 个 `computer_*` 工具 + 自带 universal helper）。
两条路怎么选、怎么装见 [docs/computer-use.md](../../docs/computer-use.md)。

## 工具

| 工具 | 作用 | 后端 | 需要授权 |
|---|---|---|---|
| `cua_status` | 体检：后端路径、TCC 权限、显示器尺寸与缩放 | python3+pyobjc；缺失时降级 | 无 |
| `cua_screenshot` | 截屏（整屏 / 指定显示器 / 区域），默认按逻辑点 1:1 缩放并内联图片块 | `screencapture` + `sips` | 屏幕录制 |
| `cua_windows` | 窗口枚举（owner / 标题 / pid / 逻辑点边界） | python3+pyobjc | 标题需屏幕录制 |
| `cua_click` | 左键单击/双击/三击、右键单击 | `cliclick` | 辅助功能 |
| `cua_move` | 指针移动（悬停） | `cliclick` | 辅助功能 |
| `cua_type` | 输入文本；短 ASCII 逐字键入，中文/多行/超长走剪贴板粘贴并还原 | `cliclick` + `osascript`+`pbcopy` | 辅助功能（粘贴另需自动化） |
| `cua_key` | 按键与组合键：`enter`/`tab`/`esc`/`page-down`/`f1..f12`/`cmd+shift+4` | `osascript` + System Events | 辅助功能 + 自动化 |
| `cua_scroll` | 滚动（`scrollY` 正=向下，`scrollX` 正=向右） | python3+pyobjc 滚轮事件 | 辅助功能 |
| `cua_drag` | 起点按下 → 分步移动 → 抬起 | `cliclick` | 辅助功能 |

所有动作类工具都支持 `dry_run: true`：只返回将要执行的命令，不发任何事件，用来在真点之前核对坐标。

## 注册契约（踩过的坑）

DSH `ToolRuntime.register()` 只校验两件事：`output` 是 `{ schema, render }`、`output.schema` 过
`assertSupportedJsonSchema`（标准 JSON-Schema 子集，对象级 `required` 数组）。它**不编译 `parameters`**：
`schemaOf()` 把 `definition.parameters` 原样投影给模型，上游 provider 又原样当 `input_schema` / `parameters`
发给 API（`dsh-llm-pi-ai` 的 `piTool()`、`dsh-llm-deepseek` 的 `input_schema: tool.parameters`）。

所以本插件的做法是：

- 工具表里继续用 DSH 的作者方言写参数（字段级 `required: true`，好读、和文档一致）；
- 注册前用 `lib/schema.js` 的 `compileParams()` 编成标准 JSON Schema（措辞与 `defineTool()` 内部一致）；
- selftest 拿真实 `parameterSchemaSpecToJsonSchema()` 对同一份方言再编一遍，逐字段 `deepEqual` 断言。

`output.schema` 侧不编译，直接按标准子集手写（对象级 `required` 数组）。两边形状不同，别抄串。

## 坐标约定（重要）

- 截图默认缩放成**逻辑点**尺寸：主屏 3840×2160 物理像素 → 1920×1080 图片，所以**图片上 1 px = 1 个逻辑点**。
- 因此 `cua_click` / `cua_drag` / `cua_scroll` 的 `x/y` 直接填图上读到的坐标，`space` 保持默认 `points`。
- 只有当你拿的是**物理像素**坐标（例如自己用 CGDisplay 抓的图）才传 `space: 'pixels'`，插件按该显示器
  scale 换算回点。
- `cua_screenshot` 的区域裁切用 4 个平铺字段 `region_x/region_y/region_width/region_height`（逻辑点、全局坐标，
  副屏在主屏左侧时 x 为负）。

## 安装

插件目录：`/Users/zhangsugang/Documents/hackerking/plugins/computer-use`。

```bash
cd ~/.dsh/profiles/desktop

# 1) 依赖 + 链接（联网时）
pnpm add link:/Users/zhangsugang/Documents/hackerking/plugins/computer-use

# 1') 离线兜底：自己写依赖 + 建软链
#     package.json dependencies 里加
#     "computer-use": "link:/Users/zhangsugang/Documents/hackerking/plugins/computer-use"
ln -sfn /Users/zhangsugang/Documents/hackerking/plugins/computer-use node_modules/computer-use
```

```bash
# 2) 把 bundle 加进 profile 的 dsh.profile.bundles（package.json）
#    "bundles": [ ..., "computer-use" ]
```

```bash
# 3) 重启 DSH（应用级重启，不是刷新页面）
#    没重启前插件不会挂载；本仓库的规矩是不擅自动手重启，交给你按自己节奏做。
```

`cordis.patch.yml` 由本包自带（`dsh.bundle.patch`），不需要往 profile 的 patch 里加行。可调配置：

```yaml
- id: computer-use
  config:
    inlineImages: true        # 截图是否作为图片块回给模型
    maxImageWidth: 0          # 0=显示器逻辑宽度；1280 可省 token
    restoreClipboard: true    # 粘贴输入后还原剪贴板
    skipPermissionGate: false # 仅排障用：跳过 TCC 闸门
    captureDir: /tmp/computer-use
```

## 首次授权（只做一次，必须做）

不授权时工具会**明确报错**（不会假装成功），`cua_status` 里对应项是 `denied`。

1. **屏幕录制** — 系统设置 → 隐私与安全性 → 屏幕录制 → 勾选（或用 `+` 添加）
   `/Applications/DeepSeek Harness.app`，然后**完全退出并重开 DSH**。
   验证：`cua_status` → `screenRecording=granted`；或缺省路径下 `screencapture -x /tmp/a.png` 能出文件。
2. **辅助功能** — 系统设置 → 隐私与安全性 → 辅助功能 → 同上勾选 `DeepSeek Harness`，退出重开。
   验证：`cua_status` → `accessibility=granted`。
   注意：鼠标/键盘事件由子进程（`cliclick` / `osascript` / `python3`）发出，macOS 把权限算在**宿主**
   `DeepSeek Harness` 头上；如果列表里另外出现了 `cliclick`、`python3` 单独条目，也一并勾上。
3. **自动化**（只有 `cua_key` 和粘贴路径需要）— 第一次调用会弹
   「DeepSeek Harness 想要控制 System Events」，选**允许**。可在 系统设置 → 隐私与安全性 → 自动化 里复查。
4. 不需要 root，不需要「完全磁盘访问权限」。

## 用法

```text
先 cua_status 看权限和分辨率，再 cua_screenshot 看一眼当前屏幕。
在「访达」窗口地址栏点一下，然后输入 ~/Documents，回车。
把这个窗口拖到左上角；滚动到第三项；cmd+shift+4 截图。
```

典型节奏：`cua_screenshot` → 看图定位 → `cua_click`（可先 `dry_run`）→ `cua_screenshot` 复核。
每次动作后都会回报 `pointer` 实际坐标和 `verified`，指针没到位时带 `warning`（多半是没授权）。

## 验证

```bash
cd /Users/zhangsugang/Documents/hackerking/plugins/computer-use
node scripts/selftest.mjs
```

自检覆盖 12 步：mock ctx 注册 9 个工具、过真实 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema`、
`parameters` 与 `parameterSchemaSpecToJsonSchema` 编译结果**逐一相等**、参数缺字段/错类型被拒（宿主校验器与本地
校验器双向核对）、9 个 `render` 输出、动作 argv 规划、`dry_run`、`cua_status` 真跑、`cua_screenshot` 真截屏
（含 `max_width` 与图片块）、辅助功能闸门报错、`cua_windows` 真枚举、真实返回值过一遍 output schema、配置归一化。

本机 2026-10-20 实测输出（节选）：

```text
✔ apply() 在 mock ctx 上注册全部 cua_* 工具 — 9 个：cua_status, cua_screenshot, ..., cua_drag
✔ 每个工具过 DSH 注册校验（output.schema + parameters 方言） — 9 个工具全过
✔ cua_status 真跑 — 辅助功能=denied 屏幕录制=granted 显示器=1920x1080@2x,1728x1117@2x
✔ cua_screenshot 真截屏 — 1280x720（scale 2，327946 bytes）
✔ 辅助功能闸门：未授权时明确报错 — cua_click / cua_type 均已按预期拒绝
✔ cua_windows 真跑 — 5/91 个窗口
OK computer-use 0.1.0 自检通过（9 个工具）
```

仓库级回归（本插件不注册 skill provider，技能与 provider 总数不受影响）：

```bash
node /Users/zhangsugang/Documents/hackerking/scripts/test-plugins.mjs
# 本机 2026-10-20 实测：OK 6 providers, 61 skills
# （其中 project-memory 来自 project-memory，与插件无关；以实际输出为准）
```

## 权限边界与风险

- **能做什么**：读屏、移动/点击指针、输入文本与组合键、滚动、拖拽、枚举窗口。等价于坐在机器前的人。
- **不做什么**：不做操作确认弹窗、不做应用租约/独占、不做「截图过期」保护、不记录操作日志到磁盘（除截图文件）。
  也就是说**模型调用即真实输入**，没有第二道闸。建议只在有人盯着的桌面上用，别在无人值守/批量任务里开。
- 截图写到系统临时目录 `computer-use/`，可能包含屏幕上的敏感信息；用完自己清。
- `cua_type` 的粘贴路径会**临时覆盖剪贴板**（默认粘贴后还原为原文本；原来是非文本内容时无法还原）。
- 只在 macOS 上挂载；其它平台 `apply()` 直接跳过并打一条 warn，不会拖垮 profile。

## 已知限制

- 不支持中键点击（`cliclick` 没有中键命令）。
- `cua_scroll` 的方向是经验值：`scrollY` 正数=向下浏览；若某个 App 里方向相反，传负数即可。
- 多显示器：截图的 `display` 序号与系统设置排列顺序一致；不同屏 scale 不同时，`space:'pixels'` 只按落点所在屏换算。
- 无 Swift helper：`swiftc` 在本机编不过（CLT/SDK 不匹配）。装好匹配的 CLT 后才能走编译型 helper 路线。
- 与 `@anionex/computer-use` **工具名不冲突**（它用 `computer_*`），但两边都在动同一只鼠标/键盘，建议只启用一个。

## 回滚

```bash
cd ~/.dsh/profiles/desktop
pnpm remove computer-use            # 或 rm node_modules/computer-use（软链）
# 从 package.json 的 dsh.profile.bundles 里删掉 "computer-use"
rm -rf /tmp/computer-use            # 可选：清截图
# 重启 DSH 后 cua_* 工具消失
```

profile 的 `cordis.patch.yml` 不需要改回去——本插件的 patch 行在自己包里，随 bundle 一起卸载。

## 文件

```text
plugins/computer-use/
├── package.json          # dsh.bundle.patch 指向本包 cordis.patch.yml
├── cordis.patch.yml      # insert: computer-use（含默认配置）
├── lib/
│   ├── index.js          # apply()：注册 9 个工具，任何一步失败只跳过该能力
│   ├── tools.js          # 工具 schema（output 标准子集 / parameters 参数方言）+ 执行体
│   ├── actions.js        # 纯规划器：参数 → argv（selftest 靠它零副作用验证）
│   ├── schema.js         # 作者参数方言 → 标准 JSON Schema（+ 本地参数校验）
│   └── system.js         # 二进制发现、子进程、pyobjc 探针（权限/显示器/窗口/滚动）
├── scripts/selftest.mjs  # 12 步自检
├── NOTICE.md
└── README.md
```
