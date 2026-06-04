#!/usr/bin/env bash
# Run on the Raspberry Pi 3B+: serve the dashboard and open it fullscreen on the
# GeeekPi 11.26" (1920x440) panel, pointed at the MacBook's vision server.
#
#   ./scripts/start_pi.sh <MAC_IP>      # MAC_IP printed by start_vision.sh on the Mac
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WEB_PORT=8000
MAC_IP="${1:?usage: ./scripts/start_pi.sh <MAC_IP>}"
# &lite=1 -> Pi render profile (20fps, no gradients/clip, no CSS filters)
URL="http://localhost:${WEB_PORT}/?visionHost=${MAC_IP}&lite=1"

# free the web port from a previous run
pids=$(lsof -ti tcp:"$WEB_PORT" 2>/dev/null || true); [ -n "$pids" ] && kill $pids 2>/dev/null || true

# keep the kiosk screen awake
xset s off -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

echo "Serving dashboard on :${WEB_PORT}  (vision @ ${MAC_IP}:8766)"
( cd "$ROOT/RasberryPi/web" && python3 -m http.server "$WEB_PORT" ) &
WEB_PID=$!

for _ in $(seq 1 20); do curl -s -o /dev/null "http://localhost:${WEB_PORT}/" && break; sleep 0.25; done

# Chromium kiosk (Raspberry Pi OS). GPU rasterization + small cache help the 3B+.
CHROME=$(command -v chromium-browser || command -v chromium || echo chromium-browser)
echo "Opening kiosk: $URL"
"$CHROME" \
  --kiosk --app="$URL" \
  --noerrdialogs --disable-infobars --incognito --no-first-run \
  --disable-translate --disable-features=Translate,TranslateUI \
  --check-for-update-interval=31536000 \
  --enable-gpu-rasterization --ignore-gpu-blocklist \
  --disk-cache-size=1 --window-size=1920,440 --window-position=0,0 \
  >/dev/null 2>&1 &

trap "echo 'Shutting down...'; kill $WEB_PID 2>/dev/null; exit" INT TERM
wait $WEB_PID
