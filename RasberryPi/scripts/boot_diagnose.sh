#!/usr/bin/env bash
# Run on the Pi to see what is slowing boot. Paste output when tuning.
set -euo pipefail

echo "=== systemd-analyze ==="
systemd-analyze 2>/dev/null || true

echo
echo "=== Top boot delays (blame) ==="
systemd-analyze blame 2>/dev/null | head -25 || true

echo
echo "=== Critical chain ==="
systemd-analyze critical-chain 2>/dev/null || true

echo
echo "=== Default target ==="
systemctl get-default 2>/dev/null || true

echo
echo "=== Kiosk services ==="
systemctl is-enabled car-cluster-bridge.service 2>/dev/null || echo "bridge: not installed"
systemctl is-enabled car-cluster-kiosk.service 2>/dev/null || echo "kiosk: not installed"
systemctl is-active car-cluster-bridge.service 2>/dev/null || true
systemctl is-active car-cluster-kiosk.service 2>/dev/null || true

echo
echo "=== Desktop autostart ==="
ls -la "$HOME/.config/autostart/" 2>/dev/null || echo "(none)"
