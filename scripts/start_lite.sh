#!/usr/bin/env bash
# LITE vision server for low-RAM / CPU-only boxes (e.g. a 4GB 2012 MacBook).
# Loads ONLY the main detector (no light/carparts/plate/char models), small imgsz.
# Measured on a 2012 2.5GHz i5 / 4GB: ~12 FPS @ 320, ~7 FPS @ 416 (CPU).
#
#   ./scripts/start_lite.sh                    # loop test clip / webcam
#   ./scripts/start_lite.sh clip.mp4           # a file
#   ./scripts/start_lite.sh "https://youtu.be/XXXX"   # YouTube
cd "$(dirname "$0")/../Vision Lab"
export LITE=1
export YOLO_DEVICE="${YOLO_DEVICE:-cpu}"
export BASE_WEIGHTS="${BASE_WEIGHTS:-self_v2.pt}"
export YOLO_IMGSZ="${YOLO_IMGSZ:-416}"

ARG="$1"
if [ -n "$ARG" ]; then
  if echo "$ARG" | grep -qE '(youtube\.com|youtu\.be)'; then
    export VISION_SOURCE=youtube VIDEO_URL="$ARG"
  elif [ -f "$ARG" ]; then
    export VISION_SOURCE=file VIDEO_PATH="$ARG"
  fi
fi
exec python3 yolo_server.py
