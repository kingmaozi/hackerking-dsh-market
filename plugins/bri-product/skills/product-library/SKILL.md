---
name: product-library
description: 查询 brking.ai 产品库（约 500 个商品，含包装正面/侧面/中包装/配料表/内物图五类图片 URL），用于爆款商品主图、详情页、小红书图文的选品与取参考图。用户提到产品库、商品库、SKU、品牌商品、包装图、配料表、内物图、对比商品、给商品做图、找参考图时使用。
whenToUse: 需要按名称/品牌/分类找商品、取五类包装图、检查图片是否齐全、为图生图准备 reference_images 时
---

# 产品库查询（brking.ai）

产品库来自 `https://ai.bri-king.com`，当前约 **504 个商品**。本地只保存元数据与图床 URL（索引约 1.3 MB），**不保存整库图片**；图片全部按 URL 远程引用。

本技能对应的 MCP 工具在会话里显示为 `mcp__bri_product__<tool>`（`serverName` 为 `bri_product`）。

## 工具

| 工具 | 用途 |
| --- | --- |
| `product_sync` | 手动同步；默认 6 小时内自动跳过，`force: true` 强制拉取 |
| `product_search` | 按关键词/品牌/分类搜索，返回 ID、名称、品牌、分类 |
| `product_get` | 按 ID 或名称取单个商品详情与全部图片 URL |
| `product_images` | 只取图片 URL，可指定五类字段 |
| `product_compare` | 对比 2–10 个商品，输出表格与图片链接 |
| `product_similar` | 按同品牌/同分类/名称相似度推荐同类商品 |
| `product_image_audit` | 检查五类图片齐全度，可选远程核验 URL 是否可访问 |
| `product_context` | 生成做图上下文（名称/品牌/分类 + 五张参考图 URL） |
| `product_brands` | 品牌列表及商品数 |
| `product_categories` | 分类列表及商品数 |
| `product_stats` | 商品数、同步时间、索引与缓存占用 |
| `product_export` | 导出 Markdown / CSV / JSON |
| `product_cache_image` | 按需下载单张图到本地缓存，返回路径 |

五类图片字段：

| 字段 | 中文 | 做图用途 |
| --- | --- | --- |
| `package_front` | 包装正面 | 主视觉、品牌与口味识别，必须保真 |
| `package_side` | 包装侧面 | 规格、营养成分、生产信息 |
| `package_middle` | 中包装 | 箱规/组合装、陈列场景 |
| `ingredient_list` | 配料表 | 文字保真与合规核对 |
| `product_inner` | 内物图 | 产品本体、口感/内容物展示 |

## 标准流程

1. **不知道 ID**：先 `product_search`，关键词可用商品名、品牌或分类；也可先 `product_brands` / `product_categories` 看范围。
2. **看详情/取图**：`product_get` 或 `product_images`，用 ID。
3. **对比**：`product_compare`，传 `ids`、`names` 或混合 `items`，一次 2–10 个。
4. **做图**：`product_context` 拿到参考图 URL；需要本地文件时对**单张**调用 `product_cache_image`（返回本地路径），再把本地路径作为图生图工具的 `reference_images`。
5. **检查素材**：制作前用 `product_image_audit` 确认五类图是否齐全；必要时 `verify_remote: true` 核验 URL 可访问（有网络成本，按需开启）。
6. **选品**：`product_similar` 找同系列/替代品，适合系列化主图或扩品。

## 同步与空间规则

- 服务器新增 → 本地新增；服务器更新 → 本地覆盖；服务器已删除但本地存在 → **保留并标 `localOnly`，绝不自动删除**。
- 索引超过 6 小时会在任意工具调用时自动同步；也可 `product_sync` 手动拉。
- 公网失败时本机开发环境自动回退 `http://127.0.0.1:8001`；两者都失败时工具会报错并给出原因，不静默返回空结果。
- 只缓存实际要看/要用的单张图；`product_cache_image` 默认整库缓存上限 200 MB，超限淘汰最旧文件。**不要批量下载整库图片**。
- 每个运营可用 `BRI_PRODUCT_LIBRARY_HOME=~/.bri-product-library-<运营名>` 隔离数据目录。

## 做图交接约定

- 包装文字（品牌、品名、口味、净含量、配料表）必须来自真实图片，**不得让生图模型改写或臆造**。
- 主图优先用 `package_front`（+ `product_inner` 表达内容物）；详情页需要配料表时同时给 `ingredient_list`；不要用 `package_side` 的局部文字当配料表。
- 生图提示词里明确写「保留参考图中的包装版式与文字」「不要新增不存在的口味/规格/认证标识」。
- 生成后逐张对照原图复核文字、logo、净含量；不合规或文字错误的图不得交付。

## 故障处理

| 现象 | 处理 |
| --- | --- |
| 自动同步失败提示 | 用 `offline: true` 继续读本地缓存；确认网络后再 `product_sync` |
| 找不到商品 | 换关键词/品牌；用 `product_brands` 查准确品牌名；名称匹配有歧义时用 ID |
| 图片 URL 打不开 | `product_image_audit` + `verify_remote: true` 定位；不要自行替换成第三方图 |
| 缓存超限 | 降低 `max_cache_mb` 或清理 `~/.bri-product-library/cache/` |
