#!/usr/bin/env bash
cd "$(dirname "$0")"
python3 -c "import websockets" 2>/dev/null || pip3 install -r requirements.txt
exec python3 yolo_server.py
