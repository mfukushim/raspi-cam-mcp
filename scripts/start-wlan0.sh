#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ ! -f dist/server.js ]]; then
  echo "dist/server.js がありません。先に pnpm build を実行してください。" >&2
  exit 1
fi

MCP_HOST="$(ip -4 -o address show dev wlan0 scope global | awk 'NR == 1 { split($4, a, "/"); print a[1] }')"
if [[ -z "$MCP_HOST" ]]; then
  echo "wlan0 に IPv4 アドレスがありません。" >&2
  exit 1
fi

export MCP_HOST
exec "${NODE_BIN:-/usr/bin/node}" dist/server.js
