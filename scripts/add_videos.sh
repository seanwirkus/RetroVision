#!/usr/bin/env bash
# Grow the training set from many dashcam videos at once.
# Downloads each YouTube URL (or uses a local file), then teacher-labels the
# frames into Vision Lab/dataset/. Train afterward with ./scripts/train_self.sh
#
#   ./scripts/add_videos.sh URL1 URL2 ...           # YouTube links
#   ./scripts/add_videos.sh clip1.mp4 clip2.mp4     # local files
#   EVERY_SEC=0.5 ./scripts/add_videos.sh URL       # denser sampling
#
# Variety is what makes the model smarter — mix day/night, rain, city/highway.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FOOTAGE="$ROOT/Vision Lab/footage"
mkdir -p "$FOOTAGE"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <youtube-url-or-file> [more...]"; exit 1
fi

for SRC in "$@"; do
  case "$SRC" in
    http*://*)
      echo "=== downloading: $SRC ==="
      # HD pull: separate video+audio streams merged by ffmpeg (progressive mp4
      # alone caps at 360p). --remote-components enables deno's JS challenge
      # solver so YouTube exposes the high-res formats. Caps at 1080p — more than
      # that wastes disk for training and the teacher downsizes to IMGSZ anyway.
      # MAX_H overrides (e.g. MAX_H=720 for smaller files).
      yt-dlp --remote-components ejs:github \
             -f "bv*[height<=${MAX_H:-1080}]+ba/b[height<=${MAX_H:-1080}]/bv*+ba/b" \
             --merge-output-format mp4 \
             -o "$FOOTAGE/%(id)s.%(ext)s" "$SRC"
      VID="$(yt-dlp --get-id "$SRC" 2>/dev/null | head -1)"
      FILE="$(ls "$FOOTAGE/$VID".* 2>/dev/null | head -1)"
      ;;
    *)
      FILE="$SRC"
      ;;
  esac

  if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
    echo "!! could not resolve a file for: $SRC — skipping"; continue
  fi
  echo "=== teacher-labelling: $FILE ==="
  ( cd "$ROOT/Vision Lab" && python3 teacher_label.py "$FILE" )
done

echo
echo "All videos labelled into Vision Lab/dataset/."
echo "Next: ./scripts/train_self.sh    (stack on last: BASE=weights/self_v1.pt ./scripts/train_self.sh)"
