#!/usr/bin/env bash
# Fine-tune the detector on frames collected while the vision server ran with
# COLLECT=1. See Vision Lab/train_self.py for details.
#
#   ./scripts/train_self.sh                 # 30 epochs from yolov8n.pt
#   EPOCHS=50 ./scripts/train_self.sh       # longer
#   BASE=weights/self_v1.pt ./scripts/train_self.sh   # stack on last run
cd "$(dirname "$0")/../Vision Lab"
exec python3 train_self.py
