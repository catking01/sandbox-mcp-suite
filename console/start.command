#!/bin/zsh
set -eu
ROOT="${0:A:h}"
NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
  print -u2 "PATH 中找不到 Node.js；请先安装 Node.js 22.19 或更新版本，再从终端运行 sandbox-mcp console。"
  exit 1
fi
exec "$NODE" "$ROOT/server.mjs" --open
