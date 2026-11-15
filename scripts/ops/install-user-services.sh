#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
service_dir="$HOME/.config/systemd/user"
mkdir -p "$service_dir"
if [[ -f "$service_dir/ai-gateway-health.timer" ]]; then
  systemctl --user disable --now ai-gateway-health.timer
  systemctl --user stop ai-gateway-health.service
  rm -f "$service_dir/ai-gateway-health.timer" "$service_dir/ai-gateway-health.service"
fi
install -m 644 deploy/systemd/ai-gateway.service deploy/systemd/ai-gateway-tunnel.service deploy/systemd/ai-gateway-auth-check.service deploy/systemd/ai-gateway-auth-check.timer "$service_dir/"
systemctl --user daemon-reload
systemctl --user enable ai-gateway.service ai-gateway-tunnel.service ai-gateway-auth-check.timer
# Stop any old manually started processes before starting these units.
if [[ "${1:-}" == --start ]]; then
  systemctl --user start ai-gateway.service ai-gateway-tunnel.service ai-gateway-auth-check.timer
fi
