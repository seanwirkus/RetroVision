#!/usr/bin/env bash
# Run on the MacBook (2021): vision detection server ONLY. Streams a Pi-friendly
# MJPEG + detections on :8766. The Raspberry Pi runs the dashboard (start_pi.sh)
# and connects here over the LAN.
#
#   ./scripts/start_vision.sh                 # webcam
#   ./scripts/start_vision.sh clip.mp4        # test footage instead of webcam
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VISION_PORT=8766

echo "Stopping any old vision server..."
pkill -f yolo_server.py 2>/dev/null
pids=$(lsof -ti tcp:"$VISION_PORT" 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null
sleep 1

# Pi-friendly stream defaults (the Pi 3B+ Chromium decodes this MJPEG). Override
# any inline, e.g. MJPEG_MAX_W=720 ./scripts/start_vision.sh
export MJPEG_MAX_W="${MJPEG_MAX_W:-640}"     # 640px is plenty on a 1920x440 panel
export MJPEG_QUALITY="${MJPEG_QUALITY:-55}"
export CAPTURE_FPS="${CAPTURE_FPS:-18}"      # cap the stream the Pi has to decode
export LIGHT_EVERY="${LIGHT_EVERY:-4}"

# optional: test on a local clip or YouTube URL instead of the webcam
ARG="$1"
if [ -n "$ARG" ]; then
  if echo "$ARG" | grep -qE '(youtube\.com|youtu\.be)'; then
    export VISION_SOURCE=youtube
    export VIDEO_URL="$ARG"
    echo "Vision source: YouTube -> $VIDEO_URL"
  elif [ -f "$ARG" ]; then
    export VISION_SOURCE=file
    export VIDEO_PATH="$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$ARG")"
    echo "Vision source: file -> $VIDEO_PATH"
  fi
fi

MAC_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<mac-ip>")
echo "Vision server on :${VISION_PORT}  (device picks MPS automatically)"
echo "-------------------------------------------------------------"
echo " On the Raspberry Pi, run:   ./scripts/start_pi.sh ${MAC_IP}"
echo "-------------------------------------------------------------"
cd "$ROOT/Vision Lab"
exec python3 yolo_server.py
