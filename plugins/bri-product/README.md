# bri-product — brking.ai 产品库 DSH 插件

把 `bri-product-library`（原 ZCode / Codex 插件）适配成 **DSH 原生插件**：13 个 `product_*` MCP 工具 + `product-library` 技能。只增加宿主接线、技能与启动器，业务逻辑仍是原插件的本地索引/同步/取图实现，不复制第二套数据源。

## 1. 包身份与版本

| 项 | 值 |
| --- | --- |
| DSH / npm 包名 | `bri-product` |
| 插件版本 | `0.2.1`（DSH 适配版） |
| 上游插件 | `bri-product-library` `0.1.3`（briking-private） |
| MCP `serverName` | `bri_product`（模型侧工具 `mcp__bri_product__<tool>`） |
| 技能 | `product-library` |
| 目标 DSH | `>=0.2.1-0 <0.3.0-0`（`engines.dsh`） |
| Node | `>=18` |
| 许可证 | MIT（见 `LICENSE` / `NOTICE.md`） |

## 2. DSH 接线

`cordis.patch.yml` 插入两行：

1. `bri-product`：技能提供者（`index.js` → `lib/provider.js`），只读加载 `skills/`。
2. `mcp-bri-product`：`@deepseek-ai/dsh-mcp-client`，stdio 启动 `mcp/launch.sh`。

启动器用 `ctx.baseUrl` 解析已安装包路径，不写死机器路径：

```yaml
!!js "decodeURIComponent(new URL('node_modules/bri-product/mcp/launch.sh', ctx.baseUrl).pathname)"
```

## 3. 安装

### 3.1 DSH Desktop（推荐）

1. 构建 tarball：在**工作区根目录**执行 `python3 scripts/build_package.py`，产物在 `release/bri-product-0.2.1.tgz`。
2. 打开 DSH → 侧栏 **插件 → 添加插件 → 安装第三方插件**。
3. 填入 tarball 绝对路径（例如 `/Users/zhangsugang/Documents/爆款商品工作区/release/bri-product-0.2.1.tgz`），确认安装并启用。
4. 重启 DSH（或按提示重启）。新会话里应出现 `mcp__bri_product__*` 工具和 `product-library` 技能。

> Desktop profile 由 Electron 应用独占管理，`dsh plugin --profile desktop` 会被拒绝；请走插件界面。

### 3.2 命令行（仅测试 profile）

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-bri-probe "$DSH" --profile bri-probe --from-default-profile headless --dump-config
DSH_HOME=/tmp/dsh-bri-probe "$DSH" plugin --profile bri-probe add /absolute/path/bri-product-0.2.1.tgz
```

安装后重启该 profile；`--dump-config` 只证明组合里有行，真实加载以工具注册和技能可见为准。

## 4. 数据与网络

- 默认数据目录 `~/.bri-product-library/`（`index.json`、`meta.json`、`cache/`、`sync.lock`）。
- 同步源 `https://ai.bri-king.com/api/products`；公网失败回退 `http://127.0.0.1:8001`。
- 出口白名单：`ai.bri-king.com`、`*.bri-king.com`、`*.myqcloud.com`、`127.0.0.1`、`localhost`、`::1`；需要新图床时设 `BRI_PRODUCT_LIBRARY_ALLOWED_HOSTS`。
- 索引超过 6 小时会在工具调用时自动增量同步；只增不删，服务器消失的商品标记 `localOnly` 保留。

## 5. 环境变量

| 变量 | 作用 |
| --- | --- |
| `BRI_PRODUCT_LIBRARY_HOME` | 数据目录（每个运营一个，互不干扰） |
| `BRI_PRODUCT_LIBRARY_SERVER` | 同步服务器覆盖 |
| `BRI_PRODUCT_LIBRARY_LOCAL_SERVER` | 本机回退地址 |
| `BRI_PRODUCT_LIBRARY_ALLOWED_HOSTS` | 追加出口白名单，逗号分隔，`.example.com` 表示后缀 |
| `BRI_PRODUCT_LIBRARY_CACHE_MB` | 图片缓存上限，默认 200 |
| `BRI_NODE_BIN` | 指定 node 可执行文件（启动器默认自动探测） |

在 DSH 里设置：在 `cordis.patch.yml` 的 `mcp-bri-product.config.env` 下加键，然后重启。

## 6. 自检与测试

```sh
cd plugin
sh mcp/launch.sh --check        # 输出一行 JSON：node/包路径/数据目录
node scripts/selftest.mjs       # 技能 + MCP 握手 + tools/list（不联网）
node scripts/selftest.mjs --live  # 额外做一次真实同步与搜索（访问 ai.bri-king.com）
node --test tests/*.test.mjs    # 上游逻辑回归
```

## 7. 故障诊断

| 现象 | 处理 |
| --- | --- |
| 没有 `mcp__bri_product__*` | 跑 `sh mcp/launch.sh --check`；看 DSH 日志里 `mcp-bri-product` 的 stderr |
| 找不到 Node | 装 Node ≥18，或设置 `BRI_NODE_BIN` |
| 同步失败 | 检查网络与 `ai.bri-king.com`；本地开发可启动 `127.0.0.1:8001`；失败时工具会回退本地缓存并提示 |
| 图片 URL 403/404 | `product_image_audit` + `verify_remote: true` 定位；不要换成第三方图 |
| 缓存占空间 | 默认上限 200 MB，自动淘汰最旧文件；可调 `BRI_PRODUCT_LIBRARY_CACHE_MB` 或清 `cache/` |

## 8. 边界

- 只读查询 + 单张按需缓存；无写服务器、无遥测、无入站端口、无命令执行、无批量下载。
- 本插件不包含图片生成能力；生图由工作区里已有的 imgen 等工具完成，产品库只提供参考图 URL/本地缓存。
- 上游业务逻辑保持原样；DSH 适配层只改 manifest、技能、启动器和接线。
