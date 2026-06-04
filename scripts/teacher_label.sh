#!/usr/bin/env bash
# Label frames with a big teacher model (yolov8x) for distillation.
# See Vision Lab/teacher_label.py.
#
#   ./scripts/teacher_label.sh footage/Nhg4BjgkWGQ.mp4     # from a video file
#   ./scripts/teacher_label.sh dataset/images             # relabel collected frames
#   TEACHER=yolov8l.pt EVERY_SEC=0.5 ./scripts/teacher_label.sh footage/clip.mp4
cd "$(dirname "$0")/../Vision Lab"
exec python3 teacher_label.py "$@"
