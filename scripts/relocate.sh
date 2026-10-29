#!/usr/bin/env bash
# relocate.sh — 把插件 cordis.patch.yml 里的发布机绝对路径改写成本机 profile 路径
#
#   bash scripts/relocate.sh ~/.dsh/profiles/desktop
#
# 只在目标 profile 已经装好对应插件后运行；不碰插件代码，只改 patch 里的路径字符串。
set -euo pipefail

PROFILE="${1:-}"
if [[ -z "$PROFILE" ]]; then
  echo "用法: bash scripts/relocate.sh <profile 目录>" >&2
  echo "例:   bash scripts/relocate.sh ~/.dsh/profiles/desktop" >&2
  exit 1
fi
PROFILE="${PROFILE%/}"
[[ -d "$PROFILE" ]] || { echo "profile 不存在: $PROFILE" >&2; exit 1; }

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "找不到 node" >&2; exit 1; }

PUBLISHED="/Users/zhangsugang/Documents/hackerking/plugins"
PUBLISHED_NODE="/Users/zhangsugang/.nvm/versions/node/v24.14.0/bin/node"

shopt -s nullglob
for manifest in "$PROFILE"/node_modules/*/package.json "$PROFILE"/node_modules/@*/*/package.json; do
  pkgdir="$(dirname "$manifest")"
  patch="$pkgdir/cordis.patch.yml"
  [[ -f "$patch" ]] || continue
  if grep -q "$PUBLISHED" "$patch" 2>/dev/null; then
    cp "$patch" "$patch.relocate.bak"
    # 发布机路径 -> 当前 profile 里的安装目录
    sed -i '' "s#$PUBLISHED/#$PROFILE/node_modules/#g" "$patch"
    sed -i '' "s#$PUBLISHED_NODE#$NODE#g" "$patch"
    echo "改写: $patch"
  fi
done
echo "完成。重启 DSH 或让 profile 重新加载后生效。"
