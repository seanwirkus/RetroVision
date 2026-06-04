#!/usr/bin/env bash
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

WEB_PORT=8000
VISION_PORT=8766
RECORD_URL="http://localhost:${WEB_PORT}/?visionHost=127.0.0.1&clean=1"
FULL_URL="http://localhost:${WEB_PORT}/?visionHost=127.0.0.1"

# --- free the ports: kill stale servers from a previous run ---
# (the "address already in use" on 8766 was a leftover yolo_server.py) ---
echo "Stopping any old servers (ports ${WEB_PORT}, ${VISION_PORT})..."
pkill -f yolo_server.py 2>/dev/null
for port in "$WEB_PORT" "$VISION_PORT"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
done
sleep 1

# Optional driving footage to test on instead of the webcam. Pass either:
#   ./scripts/start_app.sh ~/Movies/driving.mp4          (local file)
#   ./scripts/start_app.sh "https://youtu.be/XXXX"       (YouTube / any URL)
# URLs are downloaded once (cached, <=720p) and looped through YOLO.
ARG="$1"
FOOTAGE_DIR="$ROOT/Vision Lab/footage"

if [ -n "$ARG" ]; then
  case "$ARG" in
    http://*|https://*)
      mkdir -p "$FOOTAGE_DIR"
      # Local, no-install yt-dlp: grab the standalone build once into scripts/.bin.
      YTDLP="$(command -v yt-dlp || true)"
      if [ -z "$YTDLP" ]; then
        YTDLP="$ROOT/scripts/.bin/yt-dlp"
        if [ ! -x "$YTDLP" ]; then
          echo "Fetching yt-dlp (one-time)..."
          mkdir -p "$ROOT/scripts/.bin"
          curl -fsSL -o "$YTDLP" \
            https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
            && chmod +x "$YTDLP"
        fi
      fi
      # Cache by video id so re-runs replay instantly instead of re-downloading.
      VID_ID="$("$YTDLP" --no-playlist --print id "$ARG" 2>/dev/null | tail -n1)"
      [ -z "$VID_ID" ] && VID_ID="clip"
      TARGET="$FOOTAGE_DIR/$VID_ID.mp4"
      if [ ! -f "$TARGET" ]; then
        echo "Downloading footage (<=720p): $ARG"
        "$YTDLP" --no-playlist --merge-output-format mp4 \
          -f "bv*[height<=720]+ba/b[height<=720]/b" \
          -o "$TARGET" "$ARG"
      fi
      if [ -f "$TARGET" ]; then
        export VISION_SOURCE=file VIDEO_PATH="$TARGET"
        # local recording: crisp full feed (Pi default stays 720@q60)
        export MJPEG_MAX_W="${MJPEG_MAX_W:-1280}" MJPEG_QUALITY="${MJPEG_QUALITY:-82}"
        export PLATE_OCR="${PLATE_OCR:-0}"   # footage plates unreadable; set 1 to force
        echo "Vision source: youtube -> $TARGET (looped)"
      else
        echo "Footage download failed — falling back to webcam."
      fi
      ;;
    *)
      if [ -f "$ARG" ]; then
        # absolute path — the server runs from the "Vision Lab" dir, so a
        # repo-relative path would resolve wrong (opened=False).
        ABS="$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$ARG")"
        export VISION_SOURCE=file VIDEO_PATH="$ABS"
        export MJPEG_MAX_W="${MJPEG_MAX_W:-1280}" MJPEG_QUALITY="${MJPEG_QUALITY:-82}"
        export PLATE_OCR="${PLATE_OCR:-0}"   # footage plates unreadable; set 1 to force
        echo "Vision source: file -> $ABS (looped)"
      else
        echo "No such file: $ARG — falling back to webcam."
      fi
      ;;
  esac
fi

echo "Starting YOLO backend server..."
cd "$ROOT/Vision Lab"
python3 yolo_server.py &
YOLO_PID=$!

echo "Starting frontend web server on port ${WEB_PORT}..."
cd "$ROOT/RasberryPi/web"
python3 -m http.server "$WEB_PORT" &
WEB_PID=$!

# --- wait for the web server to answer, then open the recording tab ---
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://localhost:${WEB_PORT}/" && break
  sleep 0.25
done

echo "App is running."
echo "YOLO server PID: $YOLO_PID"
echo "Web server PID:  $WEB_PID"
echo "Recording view (video only): $RECORD_URL"
echo "Full cluster:                $FULL_URL"
open "$RECORD_URL" 2>/dev/null || true

trap "echo 'Shutting down...'; kill $YOLO_PID $WEB_PID 2>/dev/null; exit" INT TERM
wait
