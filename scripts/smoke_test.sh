#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "=== RetroVision Smoke Test ==="

echo -n "Backend Running: "
if pgrep -f yolo_server.py > /dev/null; then
    echo "✅ Yes"
else
    echo "❌ No (Please run ./start_app.sh)"
    exit 1
fi

echo -n "Dashboard HTTP: "
if curl -s -f http://localhost:8000 > /dev/null; then
    echo "✅ Up"
else
    echo "⚠️ Down (Start frontend using ./start_app.sh)"
fi

./check_mjpeg.sh || exit 1
python3 check_ws.py || exit 1
python3 check_fps.py || exit 1
./check_bandwidth.sh || exit 1

echo "==============================="
