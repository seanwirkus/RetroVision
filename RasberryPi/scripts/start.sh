#!/usr/bin/env bash
# Launch the serial bridge + Chromium kiosk for the car cluster.
# Usage: scripts/start.sh [--demo] [--port /dev/ttyACM0]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PY="${PYTHON:-python3}"

# 1. Bridge (serves http://localhost:8000 + /ws). Auto-detects serial, falls back to demo.
"$PY" serial_bridge.py "$@" &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null || true' EXIT

# wait for the http port to come up
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:8000/" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

URL="http://localhost:8000/"

# 2. Chromium kiosk. Try common binary names (Pi OS = chromium-browser).
CHROME=""
for c in chromium-browser chromium google-chrome chrome; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done

if [ -z "$CHROME" ]; then
  echo "No chromium found. Open $URL in a browser manually (Ctrl-C to stop the bridge)."
  wait $BRIDGE_PID
else
  exec "$CHROME" \
    --kiosk --app="$URL" \
    --window-size=1920,480 --window-position=0,0 \
    --start-fullscreen \
    --noerrdialogs --disable-infobars --hide-scrollbars \
    --disable-pinch --overscroll-history-navigation=0 \
    --disable-features=Translate,TranslateUI \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000
fi
