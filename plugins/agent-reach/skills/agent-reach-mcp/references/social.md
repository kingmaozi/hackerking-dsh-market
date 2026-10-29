# 社交媒体 & 社区

> **注意（本仓库实现）**：本文件保留上游通用用法作为参考。本仓库的 MCP 已把多数渠道内置为直连实现，
> 优先使用 `reach_run`（三档）或对应的 `reach_*` 工具，而不是手工拼接底层 CLI。
> 未在本仓库验证的能力不得视为已支持；渠道可用性以 `reach_status` 与
> [能力矩阵](../../../../docs/capability-matrix.md) 为准。

Twitter/X、B站、V2EX、Reddit。

## Twitter/X (twitter-cli)

### 稳定命令

```bash
# 首页时间线（最稳定）
twitter feed -n 20

# 读取单条推文（含回复）
twitter tweet URL_OR_ID

# 读取长文 / X Article
twitter article URL_OR_ID

# 用户时间线
twitter user-posts @username -n 20

# 用户资料
twitter user @username
```

### 可能不稳定的命令

```bash
# 搜索推文（Twitter 频繁改 GraphQL 端点，可能 404）
twitter search "query" -n 10

# likes（2024 年后只能看自己的，平台限制）
twitter likes
```

### search 失败时的重试链（按序执行，成功即停）

1. 直接重试一次（偶发失败常见）：`twitter search "query" -n 10`
2. 升级后再试：`pipx upgrade twitter-cli && twitter search "query" -n 10`
3. 换 OpenCLI 备选（桌面，复用浏览器登录态）：`opencli twitter search "query" -f yaml`
4. 都不行就改用 `twitter feed` / `twitter user-posts @somebody` 等稳定命令绕路

### 重要注意事项

> **安装**: `pipx install twitter-cli`（确保 v0.8.5+）
>
> **认证**: 推荐用 Cookie-Editor 导出后设置环境变量 `TWITTER_AUTH_TOKEN` + `TWITTER_CT0`。自动提取在 SSH/Docker/无头环境不可用。
>
> **IP 风控**: 不要在 VPS/数据中心 IP 上频繁调用，尤其是 followers/following，有封号风险。使用住宅代理或本地环境。
>
> **OpenCLI 备选**: 桌面装了 OpenCLI 的话，`opencli twitter search/article/user-posts -f yaml` 全套可用（浏览器登录态，无需 cookie 环境变量）。
>
> **输出格式**: 建议用 `--yaml` 或 `--json` 获得结构化输出，对 AI agent 更友好。

## B站 / Bilibili

> ⚠️ **不要用 yt-dlp 读 B站**（风控已全面 412 拦截，实测无解）。用 bili-cli / OpenCLI。

```bash
# 搜索 / 热门 / 视频详情（bili-cli，只读无需登录）
bili search "query" --type video -n 5
bili hot -n 10
bili video BVxxx

# 字幕（OpenCLI，需桌面 Chrome）
opencli bilibili subtitle BVxxx
```

> 详细命令（音频转写、API 直连兜底）见 [references/video.md](video.md)。

## V2EX (公开 API)

无需认证，直接调用公开 API。

### 热门主题

```bash
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
```

### 节点主题

```bash
# node_name 如: python, tech, jobs, qna, programmers
curl -s "https://www.v2ex.com/api/topics/show.json?node_name=python&page=1" -H "User-Agent: agent-reach/1.0"
```

### 主题详情

```bash
# topic_id 从 URL 获取，如 https://www.v2ex.com/t/1234567
curl -s "https://www.v2ex.com/api/topics/show.json?id=TOPIC_ID" -H "User-Agent: agent-reach/1.0"
```

### 主题回复

```bash
curl -s "https://www.v2ex.com/api/replies/show.json?topic_id=TOPIC_ID&page=1" -H "User-Agent: agent-reach/1.0"
```

### 用户信息

```bash
curl -s "https://www.v2ex.com/api/members/show.json?username=USERNAME" -H "User-Agent: agent-reach/1.0"
```

### Python 调用示例

```python
from agent_reach.channels.v2ex import V2EXChannel

ch = V2EXChannel()

# 获取热门帖子
topics = ch.get_hot_topics(limit=10)
for t in topics:
    print(f"[{t['node_title']}] {t['title']} ({t['replies']} 回复)")

# 获取节点帖子
node_topics = ch.get_node_topics("python", limit=5)

# 获取帖子详情 + 回复
topic = ch.get_topic(1234567)
print(topic["title"], "—", topic["author"])

# 获取用户信息
user = ch.get_user("Livid")
```

> **节点列表**: https://www.v2ex.com/planes

## Reddit（多后端，必须登录态）

**Reddit 没有零配置路径**：匿名 `.json` 端点已被封（403），官方 API 自 2025-11 起人工审批基本不批。两个后端都靠登录态，先调 `reach_status` 看 reddit 是否可用。中国大陆访问需代理。

### 后端 A：OpenCLI（桌面首选，复用浏览器登录态）

```bash
# 搜索帖子
opencli reddit search "query" -f yaml

# 读帖子全文 + 评论
opencli reddit read POST_ID -f yaml

# 浏览 subreddit / 热门 / Popular
opencli reddit subreddit LocalLLaMA -f yaml
opencli reddit hot -f yaml
opencli reddit popular -f yaml

# subreddit 元信息（订阅数、简介）
opencli reddit subreddit-info LocalLLaMA -f yaml
```

> 要求 Chrome 打开且浏览器里登录过 reddit.com。

### 后端 B：rdt-cli（存量/服务器备选，上游 2026-03 起停更）

```bash
rdt search "query" --limit 10   # 搜索帖子
rdt read POST_ID                # 读帖子全文 + 评论
rdt sub python --limit 20       # 浏览 subreddit
rdt popular --limit 10          # 浏览热门
rdt all --limit 10              # 浏览 /r/all
```

> **安装**: `pipx install 'git+https://github.com/public-clis/rdt-cli.git'`（PyPI 版本落后，需从 GitHub 装 v0.4.2+）。先 `rdt login` 才能搜索和阅读（服务器无浏览器时手动写 Cookie，见 `reach_status` 提示）。
> 建议使用 `--yaml` 输出，对 AI agent 更友好。

### 高级选项：官方 API + PRAW（仅限已有凭证的用户）

2025-11 前注册过 Reddit script app（持有 client_id/client_secret）的用户可以用 PRAW 走官方 API（100 QPM 免费）。新申请需人工审批且个人项目基本不批，**不要推荐新用户走这条路**。
