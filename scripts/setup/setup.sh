#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if (( $# != 0 )); then
  echo 'usage: scripts/setup/setup.sh' >&2
  exit 2
fi
umask 077
"${PYTHON:-python3.12}" -m venv .venv-accounts
.venv-accounts/bin/python -m pip install -e .
.venv-accounts/bin/python -m scripts.setup.create_client_id
