# 职场招聘

> **注意（本仓库实现）**：本文件保留上游通用用法作为参考。本仓库的 MCP 已把多数渠道内置为直连实现，
> 优先使用 `reach_run`（三档）或对应的 `reach_*` 工具，而不是手工拼接底层 CLI。
> 未在本仓库验证的能力不得视为已支持；渠道可用性以 `reach_status` 与
> [能力矩阵](../../../../docs/capability-matrix.md) 为准。

LinkedIn。

## LinkedIn

```bash
# 获取个人资料
mcporter call 'linkedin-scraper.get_person_profile(linkedin_url: "https://linkedin.com/in/username")'

# 搜索人才
mcporter call 'linkedin-scraper.search_people(keyword: "AI engineer", limit: 10)'

# 获取公司资料
mcporter call 'linkedin-scraper.get_company_profile(linkedin_url: "https://linkedin.com/company/xxx")'

# 搜索职位
mcporter call 'linkedin-scraper.search_jobs(keyword: "software engineer", limit: 10)'
```

> **需要登录**: LinkedIn scraper 需要有效的登录态。

### Fallback 方案

如果 MCP 不可用，可以用 Jina Reader：

```bash
curl -s "https://r.jina.ai/https://linkedin.com/in/username"
```
