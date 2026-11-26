#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
exec .venv-accounts/bin/python -m gateway.run --port 18900 "$@"
