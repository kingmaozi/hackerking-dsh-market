# imgen — 本机生图 / 改图（DSH 原生适配）

从 ZCode 插件 `imgen@1.2.0`（BriKing Family AI，MIT）移植。**一个技能 + 一个 MCP 服务**：

| 组件 | 位置 | 说明 |
|---|---|---|
| 技能 | `skills/imgen/` | 触发词、参数事实、画幅与 quality 的实测边界、故障排查（含 3 份参考） |
| MCP 服务 | `mcp/server.mjs` + `mcp/launch.sh` | 工具 `imgen_generate`、`imgen_health` |
| CLI | `dist/cli.js` | 手敲 / 批处理 / 排查，与 MCP 共用 `lib/` 核心 |
| 核心 | `lib/` | 读并续期 `~/.codex/auth.json`、TLS 指纹、SSE 取图、落盘 |
| 原生依赖 | `node_modules/`（已内联） | `@ossiana/node-libcurl`，内置 darwin-arm64 预编译包 |

## 装了什么、改了什么

- 工具名不变：`imgen_generate` / `imgen_health`（DSH 里呈现为 `mcp__imgen__imgen_generate` 这类带前缀的名字）。
- 默认落盘根目录从 `~/.zcode/imgen/` 改为 **`~/.dsh/imgen/<时间戳>/image.png`**，可用 `IMGEN_OUTPUT_HOME` 覆盖。
- `cordis.patch.yml` 插入两行：技能 provider（`imgen`）与 MCP server（`mcp-imgen`，`serverName: imgen`）。
- 技能正文里的 CLI 路径改成工作区 `plugins/imgen/`，ZCode 宿主差异写进技能开头。
- 其余（提示词规格、服务端三条硬事实、画幅表）与上游一致，未改。

## 前置条件

1. Node.js ≥ 20（`mcp/launch.sh` 自行探测 PATH / `/opt/homebrew/bin` / nvm / volta）。
2. 本机跑过 `codex login`，`~/.codex/auth.json` 存在且账号为 Plus / Pro。
3. 平台：内联的原生二进制是 **darwin-arm64**。其他平台在插件目录执行
   `npm install --omit=dev` 取对应平台预编译包。

## 验证

```bash
cd ~/Documents/hackerking
node plugins/imgen/scripts/selftest.mjs     # 技能可加载 + MCP 握手 + imgen_health
IMGEN_OUTPUT_HOME=/tmp/imgen node plugins/imgen/scripts/selftest.mjs
node plugins/imgen/dist/cli.js --help
```

`imgen_health` 不联网、不出图、不消耗额度；出图报错先跑它。

## 用法

```text
imgen_generate(prompt="a red apple on white background, exact 16:9 aspect ratio", out_path="/abs/apple.png")
imgen_generate(prompt="make it watercolor", reference_images=["/abs/apple.png"], out_path="/abs/apple-watercolor.png")
```

- 单张约 15–40 秒，`count>1` 按张累加；工具超时用 300000ms 量级（patch 已配）。
- 画幅写进 prompt，不要靠 `size`；`quality` 后端会静默改写，读回执核对实际值。
- 详细规格见 `skills/imgen/SKILL.md` 与 `skills/imgen/references/`。

## 回滚

```bash
# 仅停 MCP、保留技能：从 profile 的 cordis.patch.yml 删除 mcp-imgen 行
bash scripts/uninstall-local.sh --profile desktop            # 或整插件卸载
```

## 许可与来源

上游 `imgen-zcode` 1.2.0，MIT，作者 BriKing Family AI；本移植保留 LICENSE，差异见 [NOTICE.md](./NOTICE.md)。
