# NOTICE

## 上游业务代码

- 产品库检索、同步、审计、缓存等业务实现来自 `briking-private` 仓库的 `plugins/bri-product-library`（`bri-product-library` 0.1.3，MIT，作者 BriKing Family AI）。本包保留其实现与数据合同，只增加 DSH 宿主适配层。

## DSH 适配层

- `index.js`、`lib/provider.js`、`lib/frontmatter.js` 参考同作者 MIT 许可的 DSH 插件 `lcu` 的技能提供者实现（`DirectorySkillProvider` / 最小 frontmatter 解析），已改写为随包自包含、无外部依赖。
- `cordis.patch.yml` 与 `mcp/launch.sh` 采用 DSH 宿主合同里的 `ctx.baseUrl` 路径表达式与 node 探测方式，参考 `jianying-mcp` 与 `imgen` 的 DSH 打包方式。

## 数据与图片

- 本包不包含产品图片，也不包含完整产品库索引。运行时从 `https://ai.bri-king.com` 同步元数据与图床 URL；图片版权与使用权归原权利人，按业务授权使用。
