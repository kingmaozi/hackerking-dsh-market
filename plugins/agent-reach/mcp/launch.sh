#!/bin/sh
# Agent Reach MCP 启动器：加载用户凭据后启动 Node 服务。
# 保持 POSIX sh 兼容（macOS / Linux / Git Bash on Windows）。
set -eu

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SECRET_DIR="${AGENT_REACH_HOME:-$HOME/.agent-reach/briking}"

for env_file in social.env keys.env; do
  if [ -f "$SECRET_DIR/$env_file" ]; then
    # shellcheck disable=SC1090
    . "$SECRET_DIR/$env_file"
  fi
done
export TWITTER_AUTH_TOKEN="${TWITTER_AUTH_TOKEN:-}"
export TWITTER_CT0="${TWITTER_CT0:-}"
export TAVILY_API_KEYS="${TAVILY_API_KEYS:-}"
export EXA_MCP_SERVERS="${EXA_MCP_SERVERS:-exa}"
# 其余渠道的密钥保存在 providers.json，由 MCP 内部按需读取，不在此导出，
# 避免把更多密钥放进所有子进程环境。

# Node 发现顺序：PATH → 常见安装位置 → 明确报错。
# 不写死单个路径，便于在不同机器与包管理器下工作。
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.nvm/versions/node/"*/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node \
    "/c/Program Files/nodejs/node.exe"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! NODE_BIN=$(find_node); then
  printf '%s\n' "[agent-reach] 未找到 Node.js 18+。请安装 Node 后重试：https://nodejs.org/" >&2
  exit 1
fi

MAJOR=$("$NODE_BIN" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
  printf '%s\n' "[agent-reach] 需要 Node 18+，当前为 $("$NODE_BIN" -v 2>/dev/null || echo unknown)" >&2
  exit 1
fi

exec "$NODE_BIN" "$BASE_DIR/agent-reach-mcp.mjs"
