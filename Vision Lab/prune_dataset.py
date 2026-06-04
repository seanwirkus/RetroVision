"""
Strip non-road classes from an already-collected dataset's label files.
Use after the fact to clean junk (airplane, boat, sports ball, ...) that a
teacher/self run let through.

  cd "Vision Lab"
  python3 prune_dataset.py                       # prune dataset/ in place
  ALLOW_CLASSES="car,truck,person" python3 prune_dataset.py

COCO ids are stable, so we filter by id directly (no model load needed).
"""

import os
import glob

from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
DS = os.environ.get("COLLECT_DIR", os.path.join(HERE, "dataset"))
LBL = os.path.join(DS, "labels")
IMG = os.path.join(DS, "images")

_DEFAULT_ALLOW = ("person,bicycle,car,motorcycle,bus,truck,traffic light,"
                  "stop sign,fire hydrant,parking meter,bench,train")
ALLOW = {c.strip().lower() for c in
         os.environ.get("ALLOW_CLASSES", _DEFAULT_ALLOW).split(",") if c.strip()}


def main():
    names = YOLO("yolov8n.pt").names           # COCO id -> name
    allowed_ids = {i for i, n in names.items() if n.lower() in ALLOW}
    print(f"[prune] keeping classes: {', '.join(sorted(names[i] for i in allowed_ids))}")

    lbls = glob.glob(os.path.join(LBL, "*.txt"))
    dropped_boxes = 0
    removed_files = 0
    for lp in lbls:
        with open(lp) as f:
            rows = [r.split() for r in f.read().splitlines() if r.strip()]
        keep = [r for r in rows if r and int(r[0]) in allowed_ids]
        dropped_boxes += len(rows) - len(keep)
        if keep:
            with open(lp, "w") as f:
                f.write("\n".join(" ".join(r) for r in keep) + "\n")
        else:
            # no road objects left -> drop the label AND its image
            os.remove(lp)
            stem = os.path.splitext(os.path.basename(lp))[0]
            img = os.path.join(IMG, stem + ".jpg")
            if os.path.exists(img):
                os.remove(img)
            removed_files += 1

    print(f"[prune] dropped {dropped_boxes} junk boxes, "
          f"removed {removed_files} now-empty frames")
    print(f"[prune] dataset clean: {len(glob.glob(os.path.join(IMG, '*.jpg')))} images remain")


if __name__ == "__main__":
    main()
