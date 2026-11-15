#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
local_accounts=false
case "${1:-}" in
  '') ;;
  --local-accounts) local_accounts=true ;;
  *) echo 'usage: scripts/setup/setup.sh [--local-accounts]' >&2; exit 2 ;;
esac
umask 077
"${PYTHON:-python3.12}" -m venv .venv-accounts
.venv-accounts/bin/python -m pip install -e .
.venv-accounts/bin/python -m scripts.setup.create_client_id
if [[ "$local_accounts" == true ]]; then
  .venv-accounts/bin/python scripts/ops/accounts-admin.py bootstrap --local-only
fi
