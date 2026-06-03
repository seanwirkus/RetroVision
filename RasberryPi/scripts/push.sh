#!/usr/bin/env bash
# Push updated web files from Mac to Pi. The bridge's file-watcher will
# auto-reload Chromium within ~1s of the files landing.
#
# Usage:
#   bash scripts/push.sh                   # push web/ only (CSS/JS/HTML)
#   bash scripts/push.sh --all             # push web/ + serial_bridge.py + scripts/
#   bash scripts/push.sh --host 100.x.x.x  # use a specific Pi address (e.g. Tailscale IP)
#
# The script auto-discovers the Pi via: $PI_HOST env var > tailscale hostname > .local mDNS.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_USER="${PI_USER:-sean}"
PI_DIR="~/Documents/RaspberryPi"

# --- resolve host ---
HOST="${PI_HOST:-}"
ALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --all)  ALL=true; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [ -z "$HOST" ]; then
  # Try Tailscale IP first (fastest, works anywhere)
  if command -v tailscale >/dev/null 2>&1; then
    HOST="$(tailscale status --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('Peer',{}).values():
  if 'raspberrypi' in p.get('HostName','').lower():
    print(p['TailscaleIPs'][0]); sys.exit(0)
" 2>/dev/null || true)"
  fi
  # Fall back to mDNS
  [ -z "$HOST" ] && HOST="raspberrypi.local"
fi

echo ">> Pushing to ${PI_USER}@${HOST}:${PI_DIR}"

# Always push web/
rsync -avz --delete \
  "$DIR/web/" \
  "${PI_USER}@${HOST}:${PI_DIR}/web/"

if $ALL; then
  echo ">> Also pushing serial_bridge.py + scripts/"
  rsync -avz \
    "$DIR/serial_bridge.py" \
    "${PI_USER}@${HOST}:${PI_DIR}/serial_bridge.py"
  rsync -avz \
    "$DIR/scripts/" \
    "${PI_USER}@${HOST}:${PI_DIR}/scripts/"
  echo ""
  echo "   Bridge updated — restart it on the Pi:"
  echo "   ssh ${PI_USER}@${HOST} 'sudo systemctl restart car-cluster-bridge'"
fi

echo ""
echo "Done. The dashboard will auto-reload within ~1s."
