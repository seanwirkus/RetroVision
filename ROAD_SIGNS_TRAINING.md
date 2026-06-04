# Road-Signs Model — Training Action Plan (for Claude on another machine)

Goal: train a standalone **road-sign detector** (`yolo26n`) on the Ultralytics
Platform dataset `sean/datasets/road-signs` (~49,811 images), then hand the
weights back so they slot into RetroVision's vision server as a 4th detector.

This is a SEPARATE model from the car/pedestrian detector (`yolov8n` + the
`self_vN.pt` self-trained weights). Different dataset, different classes. It does
not replace anything — it adds sign detection.

---

## 0. Prerequisites on the new machine

- Python 3.10+ and `pip`
- A GPU strongly recommended (NVIDIA CUDA, or Apple Silicon MPS). CPU works but
  100 epochs on ~50k images will be painfully slow.
- ~5 GB free disk (dataset converts locally to `~/Documents/datasets/` or CWD).
- Network access (pulls model + dataset from the Platform on first run).

```bash
pip install -U ultralytics
yolo checks          # confirm install + device (should show CUDA or MPS)
```

## 1. Auth — Ultralytics PLATFORM key (not legacy HUB)

The dataset lives on **platform.ultralytics.com** (the new Platform), NOT the old
`hub.ultralytics.com`. Two consequences:
- Do **NOT** run `yolo login` — that hits the legacy HUB and will report
  "Invalid API key" even for a valid Platform key. Misleading. Ignore it.
- Instead, pass the key via the `ULTRALYTICS_API_KEY` env var. The `ul://` URIs
  resolve against the Platform automatically.

Get a key: https://platform.ultralytics.com → Settings → API Keys → copy.

```bash
export ULTRALYTICS_API_KEY="ul_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

> SECURITY: never commit this key or paste it into a tracked file. Env var only.
> If it ever leaks, regenerate it on the Platform.

Quick auth sanity check (should download a tiny dataset manifest, not error):
```bash
python3 -c "import os; assert os.environ.get('ULTRALYTICS_API_KEY'), 'set the key first'; print('key set')"
```

## 2. Train

```bash
yolo train \
  model="ul://ultralytics/yolo26/yolo26n" \
  data="ul://sean/datasets/road-signs" \
  epochs=100 \
  batch=-1 \
  imgsz=640 \
  project="sean/retroview"
```

Notes / gotchas observed on the origin machine:
- First run downloads `road-signs.ndjson` (~14 MB) then converts it to a YOLO
  dataset locally (`Converting road-signs.ndjson → .../datasets/road-signs-<hash>`),
  ~50k images, takes a couple minutes. Cached after.
- `batch=-1` = auto-batch; it probes for the largest batch that fits VRAM.
  **Only safe when nothing else is using the GPU.** If you hit OOM, set a fixed
  batch: `batch=16` (or `8`).
- If a previous run was interrupted mid-convert, delete the partial dir
  `~/Documents/datasets/road-signs-*` and re-run (the `.ndjson` stays cached, so
  no re-download).
- Output weights land under `runs/` (or the Platform project `sean/retroview`).
  Find `best.pt`:
  ```bash
  find . -name best.pt -path "*road*" -o -name best.pt | tail -3
  ```

## 3. Hand back the weights

Copy `best.pt` to this repo as `Vision Lab/road-signs.pt` (gitignored — transfer
out-of-band: scp, AirDrop, cloud drive, etc.):

```bash
cp <path>/best.pt "Vision Lab/road-signs.pt"
```

Also write down the **class names** the model was trained on — needed for the
HUD. Get them from the trained model:
```bash
python3 -c "from ultralytics import YOLO; print(YOLO('Vision Lab/road-signs.pt').names)"
```
Paste that dict into the handoff so the server can map sign classes → HUD labels.

## 4. Wiring into the server (done back on the main machine)

The origin-machine Claude will load `road-signs.pt` as a 4th model in
`Vision Lab/yolo_server.py`, mirroring how `light_model` / `parts_model` are
loaded and run, gated behind an env flag (e.g. `SIGNS=1`), and add the sign
classes to the HUD vocabulary. Nothing to do on the training machine for this —
just deliver `road-signs.pt` + its `names` dict.

---

## Coordinating with the origin machine

Talk to the other Claude through **`SIGNS_HANDOFF.md`** (a git-synced mailbox).
Before you start and after each milestone: `git pull --rebase`, read it, append
your message, set STATUS, then commit + push. That's how the origin machine knows
training is done and gets the class `names` it needs to wire the model in.

## TL;DR for the other Claude

1. `git pull --rebase` and read `SIGNS_HANDOFF.md`.
2. `pip install -U ultralytics`
3. `export ULTRALYTICS_API_KEY=<platform key>`  (do NOT `yolo login`)
4. Run the `yolo train ...` block in §2. Use `batch=16` if `-1` OOMs.
5. Find `best.pt`, grab `YOLO(best.pt).names`.
6. Fill DELIVERABLES in `SIGNS_HANDOFF.md`, set STATUS=`TRAINED_AWAITING_TRANSFER`,
   commit + push. Send `best.pt` out-of-band (gitignored). Done.
