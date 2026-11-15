#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-api}" in
  api) config=deploy/cloudflared-api.yml ;;
  accounts) config=deploy/cloudflared.yml ;;
  *) echo 'usage: scripts/ops/serve-tunnel.sh api|accounts' >&2; exit 2 ;;
esac
binary="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
if [[ ! -x "$binary" ]]; then binary=cloudflared; fi
exec "$binary" tunnel --no-autoupdate --config "$config" run
