#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-api}" in
  api) config=deploy/cloudflared-api.yml ;;
  accounts) echo "Accounts now runs on https://accounts.hilex.me (Worker/D1); no tunnel is needed." >&2; exit 2 ;;
  *) echo 'usage: scripts/ops/serve-tunnel.sh api|accounts' >&2; exit 2 ;;
esac
binary="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
if [[ ! -x "$binary" ]]; then binary=cloudflared; fi
exec "$binary" tunnel --no-autoupdate --config "$config" --metrics "${CLOUDFLARED_METRICS_ADDR:-127.0.0.1:20241}" run
