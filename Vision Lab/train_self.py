"""
Fine-tune the live detector on the frames it collected (see auto_label.py).

Pipeline:
  1. Split dataset/ into train/val (90/10).
  2. Write data.yaml with the BASE COCO class names (keeps class ids compatible
     with yolov8n.pt so runs can stack).
  3. Fine-tune from the current weights into weights/self_vN.pt.
  4. Print how to hot-swap the new weights into the server.

Run:
  cd "Vision Lab" && python3 train_self.py
  # options:
  #   EPOCHS=30 BASE=yolov8n.pt python3 train_self.py
  #   BASE=weights/self_v1.pt python3 train_self.py   # keep stacking
"""

import os
import glob
import random
import shutil

from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
DS = os.environ.get("COLLECT_DIR", os.path.join(HERE, "dataset"))
IMG = os.path.join(DS, "images")
LBL = os.path.join(DS, "labels")
SPLIT = os.path.join(DS, "_split")        # YOLO-layout train/val symlinked here
WEIGHTS_DIR = os.path.join(HERE, "weights")
BASE = os.environ.get("BASE", "yolov8n.pt")
EPOCHS = int(os.environ.get("EPOCHS", "30"))
IMGSZ = int(os.environ.get("IMGSZ", "640"))
VAL_FRAC = float(os.environ.get("VAL_FRAC", "0.1"))


def build_split():
    pairs = []
    for img in glob.glob(os.path.join(IMG, "*.jpg")):
        stem = os.path.splitext(os.path.basename(img))[0]
        lbl = os.path.join(LBL, stem + ".txt")
        if os.path.exists(lbl):
            pairs.append((img, lbl))
    if not pairs:
        raise SystemExit(f"No labelled frames in {DS}. Run the server with "
                         f"COLLECT=1 first to collect training data.")
    random.seed(0)
    random.shuffle(pairs)
    n_val = max(1, int(len(pairs) * VAL_FRAC))
    splits = {"val": pairs[:n_val], "train": pairs[n_val:]}

    if os.path.exists(SPLIT):
        shutil.rmtree(SPLIT)
    for part, items in splits.items():
        pi = os.path.join(SPLIT, part, "images")
        pl = os.path.join(SPLIT, part, "labels")
        os.makedirs(pi, exist_ok=True)
        os.makedirs(pl, exist_ok=True)
        for img, lbl in items:
            shutil.copy(img, os.path.join(pi, os.path.basename(img)))
            shutil.copy(lbl, os.path.join(pl, os.path.basename(lbl)))
    print(f"[train] dataset: {len(pairs)} frames "
          f"({len(splits['train'])} train / {len(splits['val'])} val)")
    return len(pairs)


def write_yaml():
    # class names in id order, straight from the base model — keeps ids aligned
    names = YOLO(BASE).names
    names = [names[i] for i in range(len(names))]
    yaml_path = os.path.join(SPLIT, "data.yaml")
    with open(yaml_path, "w") as f:
        f.write(f"path: {SPLIT}\n")
        f.write("train: train/images\n")
        f.write("val: val/images\n")
        f.write(f"nc: {len(names)}\n")
        f.write("names: [" + ", ".join(f"'{n}'" for n in names) + "]\n")
    return yaml_path


def next_version_path():
    os.makedirs(WEIGHTS_DIR, exist_ok=True)
    existing = glob.glob(os.path.join(WEIGHTS_DIR, "self_v*.pt"))
    nums = []
    for p in existing:
        b = os.path.basename(p)
        try:
            nums.append(int(b[len("self_v"):-len(".pt")]))
        except ValueError:
            pass
    v = (max(nums) + 1) if nums else 1
    return os.path.join(WEIGHTS_DIR, f"self_v{v}.pt"), v


def main():
    build_split()
    data_yaml = write_yaml()
    device = os.environ.get("YOLO_DEVICE")
    if not device:
        try:
            import torch
            device = ("mps" if torch.backends.mps.is_available()
                      else "cuda" if torch.cuda.is_available() else "cpu")
        except Exception:
            device = "cpu"
    print(f"[train] base={BASE} epochs={EPOCHS} imgsz={IMGSZ} device={device}")

    model = YOLO(BASE)
    model.train(data=data_yaml, epochs=EPOCHS, imgsz=IMGSZ, device=device,
                project=os.path.join(HERE, "runs"), name="self_train",
                exist_ok=True, patience=10)

    out_path, v = next_version_path()
    best = os.path.join(HERE, "runs", "self_train", "weights", "best.pt")
    shutil.copy(best, out_path)
    print("\n" + "=" * 60)
    print(f"[train] DONE. New weights: {out_path}")
    print("Hot-swap into the server with:")
    print(f"  BASE_WEIGHTS={out_path} ./scripts/start_vision.sh <source>")
    print("(or set it permanently — see note below)")
    print("=" * 60)


if __name__ == "__main__":
    main()
