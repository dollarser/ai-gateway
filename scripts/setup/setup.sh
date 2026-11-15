#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
"${PYTHON:-python3.12}" -m venv .venv-accounts
.venv-accounts/bin/python -m pip install -e .
.venv-accounts/bin/python -m scripts.setup.create_client_id
.venv-accounts/bin/python scripts/ops/accounts-admin.py bootstrap
