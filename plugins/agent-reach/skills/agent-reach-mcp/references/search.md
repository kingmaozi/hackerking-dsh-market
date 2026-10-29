# 搜索工具

> **注意（本仓库实现）**：本文件保留上游通用用法作为参考。本仓库的 MCP 已把多数渠道内置为直连实现，
> 优先使用 `reach_run`（三档）或对应的 `reach_*` 工具，而不是手工拼接底层 CLI。
> 未在本仓库验证的能力不得视为已支持；渠道可用性以 `reach_status` 与
> [能力矩阵](../../../../docs/capability-matrix.md) 为准。

Exa AI 搜索引擎。

## Exa AI 搜索

高质量 AI 搜索引擎，擅长技术和代码搜索。

```bash
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'
mcporter call 'exa.get_code_context_exa(query: "code question", tokensNum: 3000)'
```

### 使用场景

| 场景 | 参数 |
|-----|------|
| 网页搜索 | `web_search_exa(query: "...", numResults: 5)` |
| 代码搜索 | `get_code_context_exa(query: "...", tokensNum: 3000)` |

### 特点

- 擅长英文内容和技术文档
- 支持代码上下文搜索
- 结果质量高

## 与其他搜索工具对比

| 工具 | 来源 | 适用场景 |
|-----|------|---------|
| Exa | agent-reach | 英文/技术/代码搜索 |
| 智谱搜索 | my-mcp-tools | 中文搜索 |
| GitHub 搜索 | agent-reach (dev.md) | 仓库/代码搜索 |
