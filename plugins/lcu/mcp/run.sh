#!/bin/sh
# 启动 lcu relay。宿主启动 MCP 子进程时 PATH 可能不含 Node，故自行探测。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
    for candidate in \
        "${LCU_RELAY_NODE:-}" \
        node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /usr/bin/node \
        "$HOME/.local/bin/node" \
        "$HOME"/.nvm/versions/node/*/bin/node \
        "$HOME"/.volta/bin/node
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
    echo "lcu: 找不到 Node.js（需要 >= 20）。设置 LCU_RELAY_NODE 指向 node。" >&2
    exit 1
}

exec "$NODE" "$DIR/relay.mjs"
