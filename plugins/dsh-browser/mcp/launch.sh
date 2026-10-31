#!/bin/sh
# dsh-browser MCP launcher for DSH (and any MCP stdio client)
#
# Why this layer exists:
#   1) GUI-launched hosts start MCP children with a short PATH, so `node` is not
#      guaranteed to be found. Discover it here instead of hard-coding a path.
#   2) Fail with a clear diagnostic on stderr when Node is missing/too old
#      (this plugin needs Node >= 22 for the global WebSocket used by CDP).
#   3) Never write to stdout in serve mode: stdout belongs to JSON-RPC.
#
# Usage:
#   launch.sh            serve MCP over stdio (stdout is JSON-RPC only)
#   launch.sh --check    print one JSON diagnostic line on stdout, exit 0/2
set -eu

PKG_NAME=dsh-browser

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PKG_ROOT=$(CDPATH= cd -- "$SELF_DIR/.." && pwd)

die() {
  printf '%s: %s\n' "$PKG_NAME" "$*" >&2
  exit 2
}

find_node() {
  for candidate in \
    "${BROWSER_NODE_BIN:-}" \
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

NODE=$(find_node) || die "找不到 Node.js（需要 >= 22）。请安装 Node，或在 DSH 的 mcp-browser.env 里设置 BROWSER_NODE_BIN 指向 node。"

if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  die "Node 版本过低（$("$NODE" -v 2>/dev/null || echo 未知)，需要 >= 22）。请用 BROWSER_NODE_BIN 指向 >= 22 的 node；本启动器不会自动安装。"
fi

if [ "${1:-}" = "--check" ]; then
  [ "$#" -eq 1 ] || die "--check 不接受其他参数"
  exec "$NODE" -e '
    const pkgRoot = process.argv[1];
    const fs = require("node:fs");
    const path = require("node:path");
    const server = path.join(pkgRoot, "mcp", "server.mjs");
    const skills = path.join(pkgRoot, "skills");
    const candidates = [];
    if (process.env.BROWSER_CHROME_PATH) candidates.push({ path: process.env.BROWSER_CHROME_PATH, source: "BROWSER_CHROME_PATH" });
    for (const item of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ]) candidates.push({ path: item, source: "默认位置" });
    for (const dir of String(process.env.PATH || "").split(":").filter(Boolean)) {
      for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
        candidates.push({ path: path.join(dir, name), source: "PATH" });
      }
    }
    let chrome = null;
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate.path, fs.constants.X_OK);
        chrome = candidate;
        break;
      } catch {
        // 继续找
      }
    }
    const report = {
      check: true,
      ok: fs.existsSync(server) && fs.existsSync(skills),
      ready: fs.existsSync(server) && fs.existsSync(skills) && chrome !== null,
      package: "dsh-browser",
      package_root: pkgRoot,
      server: server,
      server_present: fs.existsSync(server),
      skills_present: fs.existsSync(skills),
      node: process.execPath,
      node_version: process.version,
      node_ok: Number(process.versions.node.split(".")[0]) >= 22,
      chrome_found: chrome !== null,
      chrome_path: chrome ? chrome.path : null,
      chrome_source: chrome ? chrome.source : null,
      mode: process.env.BROWSER_MODE || "headless",
      profile_dir: process.env.BROWSER_PROFILE_DIR || null,
      attach_port: process.env.BROWSER_ATTACH_PORT || "9222",
      automatic_install: false,
    };
    if (!report.ok) process.stderr.write("dsh-browser: package files are incomplete\n");
    else if (!report.chrome_found) process.stderr.write("dsh-browser: Chrome not found; set BROWSER_CHROME_PATH\n");
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exit(report.ok ? 0 : 2);
  ' "$PKG_ROOT"
fi

if [ "$#" -gt 0 ]; then
  die "未知参数：$1（仅支持 --check）"
fi

exec "$NODE" "$SELF_DIR/server.mjs"
