#!/usr/bin/env bash
echo "Measuring MJPEG bandwidth over 5 seconds..."
curl -s "http://localhost:8766/video_feed" > /tmp/mjpeg_test.bin &
CURL_PID=$!
sleep 5
kill $CURL_PID 2>/dev/null
SIZE=$(stat -f%z /tmp/mjpeg_test.bin 2>/dev/null || stat -c%s /tmp/mjpeg_test.bin)
KB=$((SIZE / 1024))
RATE=$((KB / 5))
rm -f /tmp/mjpeg_test.bin

if [ "$RATE" -gt 3000 ]; then
    echo "❌ High bandwidth: ${RATE} KB/s (Exceeds 3000 KB/s budget)"
    exit 1
else
    echo "✅ Bandwidth looks good: ${RATE} KB/s"
    exit 0
fi
