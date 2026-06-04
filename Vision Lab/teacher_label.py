"""
Teacher-student distillation: label frames with a BIG model (yolov8x), then
train the small fast model (yolov8n) on those labels with train_self.py.

Why this beats self-labeling: the labels come from a stronger model than the one
you deploy, so the student learns things its own predictions could never teach
it. This is the path that actually raises the ceiling.

Runs OFFLINE on a video file or an images folder — no live server, no perf hit.
The big model is slow but you only pay it once, here.

Usage:
  cd "Vision Lab"
  python3 teacher_label.py footage/Nhg4BjgkWGQ.mp4        # label from video
  python3 teacher_label.py dataset/images                 # label existing frames
  TEACHER=yolov8l.pt EVERY_SEC=0.5 python3 teacher_label.py footage/clip.mp4

Then:
  ./scripts/train_self.sh        # student learns from teacher labels
"""

import os
import sys
import glob

import cv2
from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
DS = os.environ.get("COLLECT_DIR", os.path.join(HERE, "dataset"))
IMG_DIR = os.path.join(DS, "images")
LBL_DIR = os.path.join(DS, "labels")

TEACHER = os.environ.get("TEACHER", "yolov8x.pt")   # big, accurate, slow
TEACHER_CONF = float(os.environ.get("TEACHER_CONF", "0.40"))  # big model trustworthy lower
EVERY_SEC = float(os.environ.get("EVERY_SEC", "1.0"))   # video sampling rate
IMGSZ = int(os.environ.get("IMGSZ", "960"))             # bigger = teacher sees more

# Only keep road-relevant COCO classes — drops teacher false-positives like
# airplane/boat/sports-ball that pollute a driving dataset. These match the
# HUD's own vocabulary (COCO_TO_HUD in yolo_server.py). Override with
# ALLOW_CLASSES="car,truck,person" (empty string = keep everything).
_DEFAULT_ALLOW = ("person,bicycle,car,motorcycle,bus,truck,traffic light,"
                  "stop sign,fire hydrant,parking meter,bench,train")
_allow_env = os.environ.get("ALLOW_CLASSES", _DEFAULT_ALLOW)
ALLOW = {c.strip().lower() for c in _allow_env.split(",") if c.strip()}


def _device():
    if os.environ.get("YOLO_DEVICE"):
        return os.environ["YOLO_DEVICE"]
    try:
        import torch
        return ("mps" if torch.backends.mps.is_available()
                else "cuda" if torch.cuda.is_available() else "cpu")
    except Exception:
        return "cpu"


def _write_label(stem, boxes, width, height, allowed_ids=None):
    lines = []
    for b in boxes:
        conf = float(b.conf[0])
        if conf < TEACHER_CONF:
            continue
        cls_id = int(b.cls[0])
        if allowed_ids is not None and cls_id not in allowed_ids:
            continue        # drop non-road classes (teacher false-positives)
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
        cx = ((x1 + x2) / 2) / width
        cy = ((y1 + y2) / 2) / height
        w = (x2 - x1) / width
        h = (y2 - y1) / height
        if w <= 0 or h <= 0:
            continue
        lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    if not lines:
        return False
    with open(os.path.join(LBL_DIR, stem + ".txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    return True


def label_video(path, model, device, allowed_ids=None):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    stride = max(1, int(round(fps * EVERY_SEC)))
    print(f"[teacher] video={path} fps={fps:.1f} sampling every {stride} frames")

    # resume numbering so teacher labels stack with any existing dataset
    n = len(glob.glob(os.path.join(IMG_DIR, "*.jpg")))
    fi = 0
    saved = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if fi % stride == 0:
            h, w = frame.shape[:2]
            res = model(frame, conf=TEACHER_CONF, imgsz=IMGSZ,
                        verbose=False, device=device)
            stem = f"frame_{n:06d}"
            if _write_label(stem, res[0].boxes, w, h, allowed_ids):
                cv2.imwrite(os.path.join(IMG_DIR, stem + ".jpg"), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 90])
                n += 1
                saved += 1
                if saved % 25 == 0:
                    print(f"[teacher] labelled {saved} frames", flush=True)
        fi += 1
    cap.release()
    return saved


def label_images(dir_path, model, device, allowed_ids=None):
    imgs = sorted(glob.glob(os.path.join(dir_path, "*.jpg")) +
                  glob.glob(os.path.join(dir_path, "*.png")))
    print(f"[teacher] relabelling {len(imgs)} images in {dir_path}")
    saved = 0
    for p in imgs:
        frame = cv2.imread(p)
        if frame is None:
            continue
        h, w = frame.shape[:2]
        res = model(frame, conf=TEACHER_CONF, imgsz=IMGSZ,
                    verbose=False, device=device)
        stem = os.path.splitext(os.path.basename(p))[0]
        # ensure the image is in the dataset images dir too
        dst = os.path.join(IMG_DIR, stem + ".jpg")
        if os.path.abspath(p) != os.path.abspath(dst):
            cv2.imwrite(dst, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if _write_label(stem, res[0].boxes, w, h, allowed_ids):
            saved += 1
            if saved % 25 == 0:
                print(f"[teacher] labelled {saved} images", flush=True)
    return saved


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python3 teacher_label.py <video.mp4 | images_dir>")
    src = sys.argv[1]
    os.makedirs(IMG_DIR, exist_ok=True)
    os.makedirs(LBL_DIR, exist_ok=True)

    device = _device()
    print(f"[teacher] model={TEACHER} conf>={TEACHER_CONF} imgsz={IMGSZ} device={device}")
    model = YOLO(TEACHER)          # auto-downloads yolov8x.pt on first run
    model.to(device)

    # resolve the road-class allowlist to id numbers against the teacher's names
    allowed_ids = None
    if ALLOW:
        allowed_ids = {i for i, n in model.names.items()
                       if n.lower() in ALLOW}
        kept = sorted(model.names[i] for i in allowed_ids)
        print(f"[teacher] keeping {len(allowed_ids)} classes: {', '.join(kept)}")

    if os.path.isdir(src):
        saved = label_images(src, model, device, allowed_ids)
    elif os.path.isfile(src):
        saved = label_video(src, model, device, allowed_ids)
    else:
        raise SystemExit(f"Not a file or dir: {src}")

    print("\n" + "=" * 60)
    print(f"[teacher] DONE. {saved} teacher-labelled frames in {DS}")
    print("Now train the student:")
    print("  ./scripts/train_self.sh")
    print("=" * 60)


if __name__ == "__main__":
    main()
