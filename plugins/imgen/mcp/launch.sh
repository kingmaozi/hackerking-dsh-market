#!/bin/sh
# 启动 imgen MCP 服务。
# 宿主启动 MCP 子进程时的 PATH 可能不含 Node，故自行探测常见安装位置。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
    for candidate in \
        "${IMGEN_NODE:-}" \
        node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /usr/bin/node \
        "$HOME/.local/bin/node" \
        "$HOME"/.nvm/versions/node/*/bin/node \
        "$HOME"/.volta/bin/node \
        "$HOME"/.fnm/aliases/default/bin/node
    do
        [ -n "$candidate" ] || continue
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

NODE=$(find_node) || {
    echo "imgen: 找不到 Node.js（需要 >= 20）。请安装 Node，或设置 IMGEN_NODE 指向 node 可执行文件。" >&2
    exit 1
}

exec "$NODE" "$DIR/server.mjs"
