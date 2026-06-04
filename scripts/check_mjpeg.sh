#!/usr/bin/env bash
echo "Checking MJPEG stream at http://localhost:8766/video_feed..."
if curl -s -N "http://localhost:8766/video_feed" | head -c 2000 | grep -q "boundary=frame\|image/jpeg"; then
    echo "✅ MJPEG stream is active and returning frames."
    exit 0
else
    echo "❌ MJPEG stream failed or is not returning jpeg boundaries."
    exit 1
fi
