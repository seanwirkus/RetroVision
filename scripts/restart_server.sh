#!/usr/bin/env bash
echo "Killing any existing YOLO servers..."
pkill -f yolo_server.py
sleep 1
cd "$(dirname "$0")/../Vision Lab"
echo "Restarting YOLO server..."
nohup python3 yolo_server.py > yolo_server.log 2>&1 &
echo "Server restarted. Logs are in Vision Lab/yolo_server.log"
