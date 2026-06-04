"""
Self-training data collector.

Saves frames + YOLO-format pseudo-labels straight from the live model's own
high-confidence detections, so the dataset grows as the camera runs. A later
fine-tune pass (train_self.py) turns that dataset into smarter weights.

IMPORTANT — pseudo-labels are the model's OWN guesses. To avoid the model
reinforcing its own mistakes (drift / "model collapse"):
  * Only high-confidence boxes are saved (CONF_THR, default 0.75).
  * Frames are sampled (EVERY_SEC) so near-duplicate frames don't dominate.
  * Labels are written in editable YOLO .txt form so you can spot-correct
    them before training. Review the dataset before you trust a new model.

Class ids are kept in the BASE model's index space (COCO 80) so a fine-tune
stays compatible with yolov8n.pt and you can keep stacking runs.
"""

import os
import time
import threading

import cv2


class Collector:
    def __init__(self, out_dir, conf_thr=0.75, every_sec=1.0, max_frames=0,
                 raw=False):
        self.img_dir = os.path.join(out_dir, "images")
        self.lbl_dir = os.path.join(out_dir, "labels")
        os.makedirs(self.img_dir, exist_ok=True)
        os.makedirs(self.lbl_dir, exist_ok=True)
        self.conf_thr = conf_thr
        self.every_sec = every_sec
        self.max_frames = max_frames          # 0 = unlimited
        # raw=True banks frames WITHOUT labels, for a teacher model to label
        # later (distillation). The live model's own boxes are ignored.
        self.raw = raw
        self._last = 0.0
        self._n = 0
        self._lock = threading.Lock()
        # resume the counter so we don't overwrite an existing dataset
        existing = [f for f in os.listdir(self.img_dir) if f.endswith(".jpg")]
        self._n = len(existing)
        print(f"[collector] out={out_dir} conf>={conf_thr} every={every_sec}s "
              f"existing={self._n}", flush=True)

    @property
    def count(self):
        return self._n

    def maybe_save(self, frame, boxes, width, height):
        """Throttled save. `boxes` is an ultralytics Boxes object (results[0].boxes)."""
        now = time.time()
        if now - self._last < self.every_sec:
            return
        if self.max_frames and self._n >= self.max_frames:
            return

        # raw mode: bank the frame unlabeled for the teacher to label later.
        if self.raw:
            with self._lock:
                self._last = now
                idx = self._n
                self._n += 1
            cv2.imwrite(os.path.join(self.img_dir, f"frame_{idx:06d}.jpg"), frame,
                        [cv2.IMWRITE_JPEG_QUALITY, 90])
            if idx % 25 == 0:
                print(f"[collector] banked {idx + 1} raw frames "
                      f"(label later with teacher_label.py)", flush=True)
            return

        if boxes is None or len(boxes) == 0:
            return

        lines = []
        for b in boxes:
            conf = float(b.conf[0])
            if conf < self.conf_thr:
                continue
            cls_id = int(b.cls[0])
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
            # YOLO format: normalized centre-x, centre-y, width, height
            cx = ((x1 + x2) / 2) / width
            cy = ((y1 + y2) / 2) / height
            w = (x2 - x1) / width
            h = (y2 - y1) / height
            if w <= 0 or h <= 0:
                continue
            lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

        if not lines:        # nothing confident enough this frame — skip it
            return

        with self._lock:
            self._last = now
            idx = self._n
            self._n += 1
        stem = f"frame_{idx:06d}"
        cv2.imwrite(os.path.join(self.img_dir, stem + ".jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 90])
        with open(os.path.join(self.lbl_dir, stem + ".txt"), "w") as f:
            f.write("\n".join(lines) + "\n")
        if idx % 25 == 0:
            print(f"[collector] saved {idx + 1} labelled frames", flush=True)
