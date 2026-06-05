#!/usr/bin/env bash
# One-shot provisioner for a FRESH Ubuntu/Debian box (e.g. a 2012 MacBook wiped
# of macOS). Installs the RetroVision vision server + dashboard, sets them up as
# systemd services, and starts them. Idempotent — safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/seanwirkus/RetroVision/master/scripts/setup_linux.sh | bash
# or, if the repo is already cloned:
#   ./scripts/setup_linux.sh
#
# Stock yolov8n auto-downloads, so this reaches a WORKING server with no manual
# weight transfer. Copy self_v2.pt / anpr-2.pt / plate-chars.pt into "Vision Lab/"
# afterward for the better models (see UPGRADE WEIGHTS at the end).
set -euo pipefail

REPO_URL="https://github.com/seanwirkus/RetroVision.git"
ROOT="${RETRO_ROOT:-$HOME/retrovision}"
VL="$ROOT/RetroVision/Vision Lab"
WEB="$ROOT/RetroVision/RasberryPi/web"
USER_NAME="$(whoami)"

echo "[setup] system packages..."
sudo apt-get update -y
# python, git, ffmpeg, and the libGL/glib opencv needs at runtime
sudo apt-get install -y python3 python3-venv python3-pip git ffmpeg \
  libgl1 libglib2.0-0 v4l-utils

echo "[setup] clone/update repo..."
mkdir -p "$ROOT"; cd "$ROOT"
if [ -d "$ROOT/RetroVision/.git" ]; then
  git -C "$ROOT/RetroVision" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$ROOT/RetroVision"
fi

echo "[setup] python venv + deps..."
python3 -m venv "$ROOT/venv"
# shellcheck disable=SC1091
source "$ROOT/venv/bin/activate"
pip install --upgrade pip wheel >/dev/null
# CPU-only torch wheel (smaller, no CUDA); ultralytics + server deps
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics opencv-python-headless fastapi uvicorn websockets wsproto

# pick the best detector that's actually present (self_v2 if you copied it, else
# stock yolov8n which ultralytics auto-downloads on first run)
if [ -f "$VL/self_v2.pt" ]; then WEIGHTS=self_v2.pt; else WEIGHTS=yolov8n.pt; fi
# more RAM on Linux than macOS: still default LITE for a 2-core box, but the
# server auto-loads plate/char/light models too if their .pt files are present
# AND you flip LITE=0. Keep LITE=1 here for a safe, fast baseline.
echo "[setup] using detector weights: $WEIGHTS"

echo "[setup] vision service..."
sudo tee /etc/systemd/system/retrovision-vision.service >/dev/null <<UNIT
[Unit]
Description=RetroVision vision server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$VL
Environment=LITE=1 YOLO_DEVICE=cpu BASE_WEIGHTS=$WEIGHTS YOLO_IMGSZ=416
# SOURCE: webcam works out of the box on Linux (no macOS TCC wall).
# Swap to a file/URL by editing this line and: sudo systemctl daemon-reload
Environment=VISION_SOURCE=webcam
ExecStart=$ROOT/venv/bin/python yolo_server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

echo "[setup] dashboard service..."
sudo tee /etc/systemd/system/retrovision-dashboard.service >/dev/null <<UNIT
[Unit]
Description=RetroVision dashboard (static web)
After=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$WEB
ExecStart=/usr/bin/python3 -m http.server 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

echo "[setup] enable + start services..."
sudo systemctl daemon-reload
sudo systemctl enable --now retrovision-vision retrovision-dashboard

IP="$(hostname -I | awk '{print $1}')"
echo
echo "============================================================"
echo "RetroVision deployed."
echo "  Dashboard : http://$IP:8000"
echo "  Vision    : http://$IP:8766/video_feed   ws://$IP:8766/ws"
echo "  Logs      : journalctl -u retrovision-vision -f"
echo "  Restart   : sudo systemctl restart retrovision-vision"
echo
echo "UPGRADE WEIGHTS (better detection): copy these into \"$VL\":"
echo "  self_v2.pt  anpr-2.pt  plate-chars.pt  traffic-light-detection.pt"
echo "then for MORE detection (plates/lights), edit the service:"
echo "  sudo systemctl edit --full retrovision-vision   # set LITE=0"
echo "  sudo systemctl restart retrovision-vision"
echo "============================================================"
