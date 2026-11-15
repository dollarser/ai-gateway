#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
case "${GATEWAY_ACCOUNT_MODE:-worker}" in
  worker) exec .venv-accounts/bin/python -m gateway.run --port 18900 "$@" ;;
  local)
    unset ACCOUNTS_WORKER_URL ACCOUNTS_WORKER_SECRET
    exec .venv-accounts/bin/python -m gateway.run --port 18900 --local-accounts "$@"
    ;;
  *) echo 'GATEWAY_ACCOUNT_MODE must be worker or local' >&2; exit 2 ;;
esac
