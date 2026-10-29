# imgen CLI 参考

## 它是什么

`imgen` 是一个本地 CLI，通过 ChatGPT / Codex 后端出图。

```
imgen → https://chatgpt.com/backend-api/codex/responses
```

它读取 `~/.codex/auth.json` 里的登录态，自动做 token 刷新，
然后以 `image_generation` 工具的形式驱动托管的图片模型。

**因此：不需要 `OPENAI_API_KEY`，也不按张计费** —— 走的是已有订阅账号的额度。
要求账号已登录过 Codex CLI，且是 Plus / Pro 级别。

代码位置：本插件内 `lib/`（核心）+ `dist/cli.js`（命令行入口）+ `mcp/server.mjs`
（MCP 服务）。手敲命令即 `node <插件目录>/dist/cli.js …`；MCP 侧用
`imgen_generate` / `imgen_health` 两个工具，走的是同一套核心。

## 两种模式

给不给 `-i` 决定走哪条路：

- 不给 `-i` → `generate`，文生图
- 给了 `-i` → `edit`，图生图（1~5 张输入图）

## 参数详解

| 参数 | 取值 | 说明 |
|---|---|---|
| `-i, --image <path...>` | 路径，1~5 张 | 输入图。支持 png / jpg / jpeg / webp / gif |
| `-o, --out <path>` | 文件路径 | 默认 `./image-<unix时间戳>.png` |
| `-n, --count <num>` | 正整数 | 生成张数。>1 时实际输出 `<out>-1.png`、`<out>-2.png` … |
| `-s, --size <size>` | `auto` 或 `WIDTHxHEIGHT` | 默认 `auto` |
| `-q, --quality <q>` | `low` / `medium` / `high` / `auto` | 默认 `auto` |
| `-b, --background <bg>` | `transparent` / `opaque` / `auto` | 默认 `auto` |
| `-m, --model <model>` | 模型名 | **编排模型**，默认 `gpt-6-luna` |
| `-e, --effort <level>` | `low` / `medium` / `high` / `xhigh` / `max` | **编排模型的推理强度**，默认 `xhigh`（1.2.0 起；此前是 `max`） |
| `--codex-home <dir>` | 目录 | 默认 `~/.codex` |

只有 `prompt` 是必填的位置参数。

**`xhigh` 是实测可用的一档**（2026-10-06）：直接打 `reasoning.effort=xhigh`，服务端 HTTP 200
并回显 `{"effort":"xhigh","mode":"standard"}`；同一 prompt 下 xhigh 改写 299 字，max 改写 236 字。
注意这与「能选到的档位」是两件事：客户端（ZCode 的模型设置）里 `gpt-6-luna` 默认只列出 `max`，
要在界面上用别的档位，得先把该档位加进模型设置的推理档位列表。

## 编排模型 vs 图片模型

这是最容易踩的坑。

`-m` 指定的**不是出图模型**，而是"负责决定调用图片工具的那个模型"，
它通过 Responses API 的 `image_generation` 工具间接出图。

**`gpt-5.4` 在 ChatGPT 账号下会被直接拒绝：**

```
400 The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.
```

本机默认已改为 `gpt-6-luna`（账号可用，且最省）。
**除非用户明确要求，不要自己传 `-m`。**

## 尺寸约束

传 `WIDTHxHEIGHT` 时必须同时满足：

- 最长边 ≤ `3840px`
- 两条边都是 `16` 的倍数
- 长边 : 短边 ≤ `3 : 1`
- 总像素在 `655,360` ~ `8,294,400` 之间

实测 `-s 1024x1024` 返回的实际像素是 `1254x1254`（后端会做对齐），
属正常现象。

**违反约束不会 `400`（2026-10-06 更正）**：后端对越界 `size` 是**静默忽略**。
矩阵实测 `-s 4000x1000`（超 3840）请求成功、HTTP 200，交付 `1254x1254`，
回执里也不会提这件事——比报错更危险，因为它看起来"成功了"。

因此插件在**提交前**就校验 `size` 并直接报错（`4000x1000` → `size 的两条边都必须是 16 的倍数`），
报错属预期行为；同理 `-s 3840x2160` 合法可提交，但实际仍只给 `1672x941`。
**要画幅就写进 prompt，不要靠 `-s`。**

## quality 怎么选

| 场景 | 建议 |
|---|---|
| 试构图、快速草稿、缩略图 | `low` |
| 正式交付、图里有文字 | `medium`（见下节：`high` 拿不到） |
| 信息图、图表、幻灯片视觉 | `medium` |
| 涉及人脸身份的编辑 | `medium` |
| 不确定 | 不要用 `auto`（随机降级），用 `medium` |

延迟大致：20–40 秒/张（2026-10-06 矩阵：19–39 秒），批量按并发折算。
**Bash 超时至少设 300000ms。**

**降级有多频繁（2026-10-06 矩阵，14 用例）**：12 次 `medium` 请求里 **6 次被降到 `low`**
（含改图两例、`4:3`/`3:4`/`1:2`/`1:3`/`3:1`），另外 3 次 `low` 请求里有 **1 次被提升到
`medium`**。所以回执报的永远是"实际拿到的那一档"，别把请求值当结果。

## 透明背景

`-b transparent` 显式要求真透明背景。

实测 `background=auto` 在图标、贴纸这类主体上，**经常本身就返回真透明背景**：
输出为 RGBA PNG，背景区域 alpha=0（例：`1254x1254` 贴纸，顶部 60 行
96.8% 像素 alpha < 250）。但这是模型判断，不是保证 ——
需要确定的抠图资产时仍要显式传 `-b transparent`。

## 实际用的是哪个图模（已实测）

抓后端返回的原始 SSE，`response.created.response.tools[0]` 会回显最终的工具定义：

```
response.tools.0.model      = gpt-image-2-codex
response.tools.0.size       = auto
response.tools.0.quality    = auto
response.tools.0.background = auto
response.model              = gpt-6-luna      ← 这是编排模型，不是图模
```

两个结论：

1. **图模是后端锁死的。** `imgen` 请求里从不传 model（`imageTool()` 只设
   `type` / `size` / `quality` / `background`），`gpt-image-2-codex` 是服务端
   填进去的。
2. **当前生效的图模是 `gpt-image-2-codex`，不是更新的版本。** 这条通道
   （ChatGPT/Codex 后端）固定用它。

### 显式覆盖 model 无效（已实测）

往 tool 定义里手写 `model` 字段打过去，后端**静默忽略**，
回显的永远是 `gpt-image-2-codex`：

| 请求里发的 | HTTP | 后端回显 | 是否出图 |
|---|---|---|---|
| 不指定 | 200 | `gpt-image-2-codex` | 是 |
| `gpt-image-2.5` | 200 | `gpt-image-2-codex` | 是 |
| `gpt-image-2-5` | 200 | `gpt-image-2-codex` | 是 |
| `gpt-image-2.5-codex` | 200 | `gpt-image-2-codex` | 是 |
| `gpt-image-2-codex` | 200 | `gpt-image-2-codex` | 是 |

注意它**不报错**——非法模型名和不传一样都正常出图。这比报错更难发现：
改完之后看起来"成功了"，但实际仍在用被锁定的图模。

**所以：走 ChatGPT/Codex 这条通道无法切到更新的图模。** 客户端没有任何
可用杠杆。想要更新的图模只能换通道（需要 `OPENAI_API_KEY` 的平台 API，
或第三方代理服务）。

所以要判断出图质量时，以 `gpt-image-2-codex` 为准，不要拿别处（比如
ChatGPT 网页版）可能存在的更新版图模来类比。

顺带一个实测观察：`-s 1024x1024 -q low` 回来时
`output_item.done.item` 报告的实际是 `size=1254x1254`、`quality=low`、
`background=opaque` —— 后端会对尺寸做对齐，且 `auto` 未必等于请求里写的值。

## quality 会被后端静默调整（实测 8 组）

后端会自行决定最终 quality，**不一定照你说的给**。完整实测矩阵
（同一 prompt，只变 effort 和请求 quality）：

| effort | 请求 | 实际 | 改写后 prompt 字数 |
|---|---|---|---|
| low | `low` | `low` ✅ | 62 |
| low | `medium` | `medium` ✅ | 69 |
| low | `high` | **`low`** ❌ | 92 |
| low | `auto` | `medium` | 70 |
| max | `low` | `low` ✅ | 234 |
| max | `medium` | `medium` ✅ | 72 |
| max | `high` | **`medium`** ❌ | 105 |
| max | `auto` | **`low`** | 73 |

**关键结论：**

1. **`high` 永远拿不到。** 2/2 都被降级。
2. **没有任何一档可以信任。** 后续追加测试中 `medium` 也出现过降到 `low`
   的情况 —— 所以「medium 稳定」只在 3/3 的小样本里成立，不是规律。
   **唯一可靠的做法是请求 `medium`，然后读回执确认。**
3. **`auto` 不是"让后端选最好的"，是随机。** 实测落到过 `medium` 也落到过 `low`。
4. 降级幅度与 effort 有关：effort=low 时 `high` 掉到 `low`（灾难性），
   effort=max 时掉到 `medium`（可接受）。
5. 一次极端案例：满屏规格 prompt + `-e max` + `-q high`，实际拿到
   **`quality=low`**，尺寸从请求的 2048x1152 掉到 1536x1024。

## 编排模型会改写 prompt（这是真正的质量杠杆）

后端返回里有 `revised_prompt` 字段 —— **编排模型把你的 prompt 重写后才喂给图模**。

实测：输入 11 个字「一只橘猫坐在窗台上」，`effort=low` 扩写成 62 字，
换成结构化规格 prompt 后，`effort=medium` 会扩写成 200+ 字的英文
摄影描述（`Photorealistic natural photograph, wide panoramic eye-level view…`）。

**推论：想提高成图质量，最有效的做法是喂给它结构化的详细 prompt**，
让改写有素材可用 —— 这就是本技能那套标签化规格的价值所在。
含糊的短句会被改写得同样含糊。

注意 `effort` 越高并不保证改写越长：实测 max 下出现过 72 / 105 / 234 字
三种长度，波动很大。

## 画幅比例靠 prompt，不靠 `-s`（实测）

| 方式 | 请求 | 实际交付 | 命中 |
|---|---|---|---|
| `-s 1536x1024` | 3:2 横 | `1370x1148` | ✗ |
| `-s auto` + prompt 写「16:9」 | 16:9 横 | `1672x941` | ✓ |
| `-s 1024x1536` | 2:3 竖 | `1370x1148`（横幅） | ✗ **完全反了** |
| `-s auto` + prompt 写「9:16」 | 9:16 竖 | `941x1672` | ✓ |

**`-s` 的像素对基本无效，比例必须写进提示词。** 第 3 行最危险 ——
要竖版却拿到横幅，不核对回执尺寸就会交付错东西。

比例 → 实际像素：`1:1`→1254×1254、`4:3`→1448×1086、`3:4`→1086×1448、
`16:9`→1672×941、`9:16`→941×1672、`1:2`→887×1774、`1:3`→724×2172、
`3:1`→2172×724。（2026-10-06 矩阵：以上 8 种一次全部精确命中。）
**超过 3:1 不可达**，提交前应直接拒绝该比例。

## 尺寸：4K 是理论上限，实际拿不到

文档写的 3840px 是**允许范围**，不是实际交付。实测请求 `3840x2160`：

| 请求 | 实际交付 |
|---|---|
| `3840x2160` | `1916x821`、`1370x1148` |
| `3840x2160` + prompt 写 16:9（2026-10-06 矩阵） | `1672x941` |
| `4000x1000`（越界，2026-10-06 矩阵） | `1254x1254`（**静默忽略，不报错**） |
| `2048x1152` | `1536x1024` |
| `1024x1024` | `1254x1254`、`1312x1199`、`1370x1148` |

**实际交付多在 1200~1900px 长边，且比例会受 prompt 影响**
（写了 `wide panoramic` 就真给你超宽幅）。**想要更高分辨率，
这个通道给不了，只能放大。**

## 输出

命令成功后 stdout 打印：

```
✓ 已保存 1 张图片（1254x1254）：
  /path/to/out.png
```

拿到路径后用 **Read 工具**读那张 PNG，才能真正看到图并展示给用户。

## 错误码对照

| 状态 | CLI 提示 | 原因与处理 |
|---|---|---|
| `400` | `请求被拒 (400)：<后端信息>` | 看后端信息。多为编排模型不对，或尺寸违规 |
| `401` / `403` | `认证/权限失败` | 账号未登录，或不是 Plus/Pro。让用户跑 `codex` 重新登录 |
| `429` | `撞限流 (429)` | 等一会儿再试，别立刻连续重试 |
| 退出码 `2` | `usageError` | 参数用错了，比如 `-i` 给了 0 张或超过 5 张 |

命令用法问题（参数错、输入图不存在、不支持的文件类型）会打印
`✗ ...` 并以退出码 2 结束。这类不需要重试，改对参数即可。

## 与 Codex imagegen 技能的关系

Codex 原生 `imagegen` 技能有两条路：

1. 内置 `image_gen` 工具 —— 走 Codex 自己的账号通道
2. `scripts/image_gen.py` 兜底 CLI —— 需要 `OPENAI_API_KEY`

ZCode 宿主**没有**内置 `image_gen` 工具，而本插件同样复用同一个 ChatGPT
账号通道，所以技能直接以 `imgen_generate` 为执行路径；原技能的 Python
兜底那套（以及它的 `OPENAI_API_KEY` 依赖）不需要。
