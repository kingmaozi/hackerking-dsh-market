---
name: imgen
description: "本机生图/改图：用本机已登录的 ChatGPT / Codex 账号（OAuth）生成或编辑位图 —— 照片、插画、商品图、海报底图、贴纸、壁纸、头像、透明底抠图、Logo 概念、广告图、幻灯片配图。不需要 OPENAI_API_KEY，不算平台配额，不经第三方服务器。触发词：画一张 / 生成一张图 / 做张图 / 做张海报 / 做个 logo / 图标 / 插画 / 壁纸 / 贴纸 / 头像 / 商品主图 / 抠个图 / 把这张图改成… / P 成… / 换个背景 / give me a picture of… / turn this photo into… —— 用户没提 imgen 也要用。首选工具 imgen_generate（体检用 imgen_health）。不要用于：图表/流程图/架构图（用代码或 mermaid）、真正的界面/网页（写前端代码）、SVG 矢量图。"
---

# imgen — 本机生图 / 改图

用**本机已登录的 ChatGPT / Codex 账号**出图：读 `~/.codex/auth.json`，令牌过期时
自动用 refresh_token 续期并写回。不需要 `OPENAI_API_KEY`，不按张计费，不经过任何
中转服务器（直连 `chatgpt.com`）。输出 PNG。

> 与市场里另一个 `bri_image`（平台 Key、走远端服务）的区别：本插件吃**本机登录态**，
> 没有平台 Key 也能用；两者的工具名不同（`imgen_*` vs `image_*`），别混。

> **DSH 移植版（imgen）宿主差异**：MCP 服务与工具名不变，DSH 里通常显示为
> `mcp__imgen__imgen_generate` / `mcp__imgen__imgen_health`；默认落盘根目录改成
> `~/.dsh/imgen/`（`IMGEN_OUTPUT_HOME` 可覆盖）；CLI 在插件目录
> `plugins/imgen/dist/cli.js`；自检 `node scripts/selftest.mjs`。

## 何时用 / 不用

**用**：文生图、图生图（编辑已有图）、logo / 图标 / 插画 / 壁纸 / 贴纸 / 头像、
产品图 / 场景图 / 海报底图 / 信息图 / UI 效果图等**位图**。

**不用**：
- 图表 / 流程图 / 架构图 → 用代码或 mermaid（位图里的文字和结构不可靠）
- 真正的界面 / 网页 → 写前端代码实现
- SVG 矢量图 → 直接写 SVG

## 执行：MCP 工具（首选）

| 工具 | 用途 |
|---|---|
| `imgen_generate` | 生成 / 编辑图片。参数：`prompt`（必填，英文为宜）、`reference_images`（1~5 张，给了就是改图）、`count`(1~4)、`out_path`、`size`、`quality`、`background`、`effort`（编排模型推理强度，默认 `xhigh`；`low`/`medium`/`high`/`xhigh`/`max`）、`model` |
| `imgen_health` | 体检：登录态是否可用、令牌到期时间、原生模块能否加载。不联网、不消耗额度；出图报错时先跑它 |

调用要点：

1. `out_path` **尽量显式给绝对路径**。图是交付物就放进用户工作区；不给则落在
   `~/.dsh/imgen/<时间戳>/image.png`。
2. **单张约 15–40 秒**，`count>1` 按张累加（内部两路并发）。调用超时要给到
   300000ms 量级，别用默认的短超时。
3. 回执里必须读三样：**实际保存路径、实际尺寸、实际 quality**。后端会静默改写
   quality，出现「被后端降级」就重跑一次。
4. 工具会把图片本体一并返回，直接看它验收；不要用文字描述代替图片。

### 手敲 CLI（同一套核心，排查与批处理用）

```bash
PLUGIN=~/Documents/hackerking/plugins/imgen          # 本工作区路径；profile 里是 link: 安装，路径相同
node "$PLUGIN/dist/cli.js" "<prompt>" -o out.png                  # 文生图
node "$PLUGIN/dist/cli.js" "<怎么改>" -i in.png -o out.png        # 图生图
node "$PLUGIN/dist/cli.js" "<prompt>" -n 3 -o out.png             # 多张 → out-1.png …
node "$PLUGIN/dist/cli.js" --help
```

参数与 MCP 工具一致（`-i/-o/-n/-s/-q/-b/-e/-m`），另有 `--codex-home` 指定登录目录。

## ⚠️ 三条硬事实（服务端实测，改不了）

1. **图片模型由服务端锁定**（当前回显 `gpt-image-2-codex`）。显式换模型名会被
   **静默忽略**。`model` 参数只影响**编排模型**（负责改写 prompt 并调用图片工具），
   默认 `gpt-6-luna`；**绝不要用 `gpt-5.4`**，ChatGPT 账号会直接
   `400 The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.`
2. **分辨率约 1.5MP，没有 2K/4K**。请求 `3840x2160` 实际只给 1200~1900px 长边。
   要更高分辨率只能后期放大。
3. **quality 会被静默改写，而且经常发生**：请求 `high` 从未拿到 `high`；`medium` 也会掉到
   `low`（2026-10-06 全矩阵：12 次 `medium` 请求里 **6 次**落到 `low`），甚至 `low` 也会被
   **提升**成 `medium`。**规则：请求 `medium`，读回执核对实际值，不足就重跑。**

### 画幅比例：写进 prompt，不要靠 `size`

| 方式 | 请求 | 实际交付 | 命中 |
|---|---|---|---|
| `size=1536x1024`，prompt 不提画幅 | 3:2 横 | `1370x1148` | ✗ |
| `size=auto`，prompt 写「16:9」 | 16:9 横 | **`1672x941`** | ✓ |
| `size=1024x1536`，prompt 不提画幅 | 2:3 竖 | `1370x1148`（横幅） | ✗ 完全反了 |
| `size=auto`，prompt 写「9:16」 | 9:16 竖 | **`941x1672`** | ✓ |

常用比例与实际像素：

| 比例 | 实际像素 |
|---|---|
| `1:1` | `1254×1254` |
| `4:3` | `1448×1086` |
| `3:4` | `1086×1448` |
| `16:9` | `1672×941` |
| `9:16` | `941×1672` |
| `1:2` | `887×1774` |
| `1:3` | `724×2172` |
| `3:1`（横向上限） | `2172×724` |

以上七种 + `3:1` 在 2026-10-06 矩阵里 **全部精确命中**（各 1 张，`quality=medium` 请求）。
**超过 3:1 不可达**，直接告诉用户换比例，别交一张与请求不符的图。

**`size` 基本无效，别指望它定像素**：矩阵里 `size=3840x2160` 照样只给 `1672×941`；
越界值（`4000x1000`）后端**不会报错**，而是静默忽略——所以插件在提交前就拒绝越界值
（长边 ≤3840、两边都是 16 的倍数、长短边比 ≤3:1、总像素 655,360~8,294,400），
收到明确报错时改 `size` 或改回 `auto`，把画幅写进 prompt。

### 透明底

`background=transparent` 返回真 RGBA（背景 alpha=0）。实测 `auto` 对图标、贴纸
这类主体**常常本身就返回透明底**，但需要抠图资产时仍显式传 `transparent`。
不支持遮罩（mask）与 JPEG/WebP 输出。

## 决策：generate 还是 edit

1. 用户要改一张**已存在的图**并保留其中部分 → **edit**（传 `reference_images`）
2. 给的图只是**风格 / 构图 / 氛围参考**，没要求改它 → **generate**，图作为参考传入
3. 没给图 → **generate**

多张输入时，在 prompt 里**按序号标注每张图的角色**：
`Image 1: edit target`、`Image 2: style reference`。

编辑硬规则：每条 edit prompt 都写死不变量，用
`change only X; keep Y unchanged` 句式，**每次迭代都重复一遍**，否则越改越跑偏。

```
Use case: precise-object-edit
Input images: Image 1: room photo
Primary request: replace only the white chairs with wooden chairs
Constraints: change only the chairs; preserve camera angle, room lighting,
floor shadows, and all surrounding objects; keep everything else unchanged
```

## 提示词方法

把中文需求转成**英文 prompt**（图片模型对英文更稳），按标签化规格组织。
详细原则见 `references/prompting.md`，可复制的完整范例见
`references/sample-prompts.md`，后端参数事实见 `references/imgen-cli.md`。

```
Use case: <分类 slug>
Asset type: <这张图用在哪>
Primary request: <用户的主要需求>
Input images: <Image 1: role; Image 2: role>   (可选)
Scene/backdrop: <环境>
Subject: <主体>
Style/medium: <照片/插画/3D…>
Composition/framing: <构图，如 16:9 horizontal widescreen; exact 16:9 aspect ratio>
Lighting/mood: <光线 + 情绪>
Color palette: <配色>
Materials/textures: <材质细节>
Text (verbatim): "<逐字准确的文字>"
Constraints: <必须保留的>
Avoid: <必须避免的>
```

**增补尺度**：用户说得又细又准 → 只做结构化整理，不加戏；只说了一句很泛的话 →
可适度补构图/光线/质感，但只补有助于出图的，不要凭空加人、加物、加品牌、加标语。

**用途 slug** — Generate：`photorealistic-natural`、`product-mockup`、`ui-mockup`、
`infographic-diagram`、`scientific-educational`、`ads-marketing`、
`productivity-visual`、`logo-brand`、`illustration-story`、`stylized-concept`、
`historical-scene`；Edit：`text-localization`、`identity-preserve`、
`precise-object-edit`、`lighting-weather`、`background-extraction`、
`style-transfer`、`compositing`、`sketch-to-render`。

## 保存路径

1. 用户指定了位置 → 存到那儿
2. 图要进项目 / 当交付物 → 存进工作区，报出完整路径
3. 只是预览试效果 → 可放临时目录，但要**告诉用户文件在哪**
4. **不要覆盖已有文件**（除非用户明确要求），用 `hero-v2.png` 这类带版本的名字

## 标准流程

1. **判类型**：有输入图 → edit；否则 generate
2. **定用途**：进项目还是只预览 → 决定 `out_path`
3. **写 prompt**：转英文 + 按规格组织 + 适度补细节（比例写进去）
4. **选参数**：成品 `quality=medium`；草稿 `low` 更快；抠图 `background=transparent`
5. **调用**：`imgen_generate`，超时给足（300000ms 量级）
6. **验收**：看回执（路径 / 尺寸 / quality 是否被降级）+ 看返回的图片本身；
   **文字是否逐字正确**，编辑类检查不变量有没有被破坏
7. **迭代**：一次只改一个点，再验收

## 失败排查

| 报错 | 原因 | 处理 |
|---|---|---|
| `400 ... 'gpt-5.4' model is not supported` | 编排模型用错 | 去掉 `model`，用默认 `gpt-6-luna` |
| `size 的两条边都必须是 16 的倍数` / `size 的最长边必须 ≤ 3840` / `长短边比必须 ≤ 3:1` / `总像素需在 …` | 越界 size（插件提交前就拦下；后端对越界是静默忽略，不会报错） | 改 `size` 为合法值，或直接改回 `auto`，画幅写进 prompt |
| `401` / `403` | 未登录，或账号非 Plus/Pro | 跑 `imgen_health` 确认；让用户执行 `codex login` |
| `429` | 限流 | 等一会儿再试，别连续猛打 |
| `未找到 ~/.codex/auth.json` | 本机没登录过 Codex | 让用户执行 `codex login`（约 1 分钟） |
| `输入图不存在` / 不支持的图片类型 | 路径或格式问题 | 用 png/jpg/jpeg/webp/gif 的绝对路径 |
| 原生模块加载失败 | 平台二进制缺失（本包内置 darwin-arm64） | 在插件目录 `npm install --omit=dev` |

把 imgen 的报错**原样转达**给用户，别自己吞掉或改写成成功。

## 实测基线（2026-10-06 全矩阵，14 用例）

生图 7 画幅 + `3:1` 上限 + 4K 请求 + 越界尺寸 + 单图改图 + 双图改图 + 透明底 + 批量 3 张，
全部成功（越界尺寸按预期被插件拒绝）。要点：

- 画幅 **7/7 精确命中**（写进 prompt 的比例），`3:1` 也能到 `2172×724`；
- `size=3840x2160` → 实际 `1672×941`（**size 无效**）；
- `medium` 请求 12 次，**6 次被降到 `low`**；`low` 请求也可能被**提升**到 `medium`；
- 透明底 `alpha=yes`，批量 3 张落成 `-1/-2/-3`（并发 2，3 张 54 秒）；
- 单张耗时 19–39 秒；改图与生图同量级。

## 参考文件

- `references/prompting.md` — 提示词结构、增补尺度、构图、不变量、迭代原则
- `references/sample-prompts.md` — 按用途分类的完整可复制 prompt 范例
- `references/imgen-cli.md` — 参数与后端行为实测（含尺寸/quality 约束来源）
