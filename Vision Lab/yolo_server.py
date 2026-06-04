import cv2
import os
import re
import json
import time
import asyncio
import threading
import subprocess

import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

from distance import estimate_lateral_ft, estimate_range_ft

# --- self-training data collector (opt-in via COLLECT=1) ---
COLLECT = os.environ.get("COLLECT", "0") != "0"
collector = None
if COLLECT:
    from auto_label import Collector
    _ds = os.environ.get("COLLECT_DIR",
                         os.path.join(os.path.dirname(os.path.abspath(__file__)), "dataset"))
    collector = Collector(
        _ds,
        conf_thr=float(os.environ.get("COLLECT_CONF", "0.75")),
        every_sec=float(os.environ.get("COLLECT_EVERY", "1.0")),
        max_frames=int(os.environ.get("COLLECT_MAX", "0")),
        raw=os.environ.get("COLLECT_RAW", "0") != "0",
    )

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COCO_TO_HUD = {
    "person": "PEDESTRIAN",
    "bicycle": "BICYCLE",
    "car": "CAR",
    "motorcycle": "MOTORCYCLE",
    "bus": "BUS",
    "truck": "TRUCK",
    "traffic light": "TRAFFIC_LIGHT",
    "stop sign": "STOP_SIGN",
    "fire hydrant": "HYDRANT",
    "parking meter": "PARKING_METER",
    "bench": "BENCH",
    "suitcase": "OBSTACLE",
    "backpack": "OBSTACLE",
    "handbag": "OBSTACLE",
    "skateboard": "BICYCLE",
}

TARGET_FPS = 30
FRAME_INTERVAL = 1.0 / TARGET_FPS

# Inference device: Apple GPU (MPS) on M-series Macs, CUDA on Nvidia, else CPU.
# Override with YOLO_DEVICE=cpu. MPS typically 2-4x faster than CPU here.
try:
    import torch
    DEVICE = os.environ.get("YOLO_DEVICE") or (
        "mps" if torch.backends.mps.is_available()
        else "cuda" if torch.cuda.is_available()
        else "cpu")
except Exception:
    DEVICE = os.environ.get("YOLO_DEVICE", "cpu")
print(f"[vision] inference device: {DEVICE}", flush=True)

# BASE_WEIGHTS lets you hot-swap in a self-trained model (see train_self.py).
# Defaults to stock yolov8n.pt.
_BASE_WEIGHTS = os.environ.get("BASE_WEIGHTS", "yolov8n.pt")
print(f"[vision] detector weights: {_BASE_WEIGHTS}", flush=True)
model = YOLO(_BASE_WEIGHTS)
model.to(DEVICE)
# Dedicated traffic-light state model: classes {0:'green', 1:'red', 2:'yellow'}.
light_model = YOLO("traffic-light-detection.pt")
light_model.to(DEVICE)
LIGHT_STATE = {"green": "GREEN", "red": "RED", "yellow": "YELLOW"}
LIGHT_BGR = {"RED": (0, 0, 255), "YELLOW": (0, 255, 255), "GREEN": (0, 255, 0)}

# ---- car-parts segmentation → vehicle orientation (optional; loads if present) ----
_PARTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "carparts-seg.pt")
parts_model = YOLO(_PARTS_PATH) if os.path.exists(_PARTS_PATH) else None
if parts_model is not None:
    parts_model.to(DEVICE)
    print(f"[vision] carparts-seg loaded: {len(parts_model.names)} classes", flush=True)


def _part_side(name):
    """Map a carparts class name to which face of the car it belongs to."""
    n = name.lower()
    if "front" in n or "hood" in n or "headlight" in n:
        return "front"
    if "back" in n or "rear" in n or "tail" in n or "trunk" in n:
        return "rear"
    return None

# plate detector — prefer the Platform-trained ANPR yolo26n (mAP50 0.858),
# then the older LPR models. First file that exists wins. Override with
# PLATE_WEIGHTS=/path/to.pt
_PLATE_PATHS = [os.environ.get("PLATE_WEIGHTS", ""), "anpr-2.pt",
                "lpr-v1.pt", "plate-detector.pt"]
_PLATE_PATHS = [p for p in _PLATE_PATHS if p]
_plate_path = next((p for p in _PLATE_PATHS if os.path.exists(p)), None)
plate_model = YOLO(_plate_path) if _plate_path else None
# Restrict detections to the plate class so junk labels (e.g. anpr-2's 'class1')
# can't hijack the highest-conf pick. None = accept any class.
_PLATE_CLASS_ID = None
if plate_model is not None:
    _PLATE_CLASS_ID = next(
        (i for i, n in plate_model.names.items() if "plate" in str(n).lower()), None)
    print(f"[vision] plate detector: {_plate_path} "
          f"classes={plate_model.names} use_class={_PLATE_CLASS_ID}", flush=True)

# char-level plate OCR (YOLO that detects each digit/letter as a box). Replaces
# EasyOCR when present — faster, GPU-friendly, fully offline. Set CHAR_OCR=0 to
# force EasyOCR. PLATE_CHARS_WEIGHTS overrides the path.
CHAR_OCR = os.environ.get("CHAR_OCR", "1") != "0"
_CHAR_PATH = next((p for p in [os.environ.get("PLATE_CHARS_WEIGHTS", ""),
                               "plate-chars.pt"] if p and os.path.exists(p)), None)
char_model = YOLO(_CHAR_PATH) if (CHAR_OCR and _CHAR_PATH) else None
CHAR_CONF_MIN = float(os.environ.get("CHAR_CONF_MIN", "0.40"))
CHAR_UPSCALE_W = int(os.environ.get("CHAR_UPSCALE_W", "200"))  # upscale plate crop to >= this width
if char_model is not None:
    char_model.to(DEVICE)
    print(f"[vision] plate-char OCR: {_CHAR_PATH} ({len(char_model.names)} classes)",
          flush=True)

# ---- license-plate OCR (EasyOCR) ----
try:
    import easyocr
    print("[vision] Loading EasyOCR (this takes a moment)...", flush=True)
    _plate_reader = easyocr.Reader(['en'], gpu=False)
    _HAS_OCR = True
    print("[vision] EasyOCR loaded.", flush=True)
except Exception as e:
    print(f"[vision] EasyOCR not available: {e}", flush=True)
    _HAS_OCR = False

VEHICLE_CLASSES = {"CAR", "TRUCK", "BUS"}
# detection gates (env-tunable) — cut billboard / sky / low-conf false positives
CONF_MIN = float(os.environ.get("CONF_MIN", "0.35"))        # global floor
PED_CONF_MIN = float(os.environ.get("PED_CONF_MIN", "0.50"))  # ads fake "person"
HORIZON_FRAC = float(os.environ.get("HORIZON_FRAC", "0.45"))  # reject above horizon
MJPEG_MAX_W = int(os.environ.get("MJPEG_MAX_W", "720"))       # 720 = Pi-safe; raise for recording
MJPEG_QUALITY = int(os.environ.get("MJPEG_QUALITY", "60"))
LIGHT_EVERY = int(os.environ.get("LIGHT_EVERY", "3"))         # run the light model every Nth frame
PLATE_RE = re.compile(r"[A-Z0-9]{5,8}")
OCR_INTERVAL = 0.5  # seconds between OCR passes to keep fps high
PLATE_SHARP_MIN = float(os.environ.get("PLATE_SHARP_MIN", "120"))  # focus gate (var-of-Laplacian)
PLATE_OCR = os.environ.get("PLATE_OCR", "1") != "0"   # set 0 to disable (e.g. unreadable footage)
PLATE_PROB_MIN = float(os.environ.get("PLATE_PROB_MIN", "0.55"))   # per-read EasyOCR confidence floor
PLATE_VOTE_MIN = float(os.environ.get("PLATE_VOTE_MIN", "1.6"))    # summed votes before a plate is shown
_plate = {"text": None, "cx": 0.0, "cy": 0.0, "ts": 0.0, "last_ocr": 0.0}
_plate_by_tid = {}          # track id -> (plate_text, timestamp) — sticks plate to a car
_plate_votes = {}           # track id -> {plate_text: summed_confidence} for consensus
PLATE_TTL = 8.0             # keep a car's plate this long after its last good read

# ---- additive v2 telemetry helpers ----
FALLBACK_TRACK_TTL = float(os.environ.get("FALLBACK_TRACK_TTL", "1.2"))
TRACK_STATE_TTL = float(os.environ.get("TRACK_STATE_TTL", "5.0"))
_next_fallback_tid = -1
_id_memory = {}             # tid -> last bbox/class, used when ByteTrack drops an id
_track_state = {}           # tid -> first/last position for age + velocity telemetry
_fps_state = {"last_ts": 0.0, "fps": 0.0}


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _bbox_stats(xyxy):
    x1, y1, x2, y2 = (float(v) for v in xyxy)
    return {
        "cx": (x1 + x2) * 0.5,
        "cy": (y1 + y2) * 0.5,
        "w": max(1.0, x2 - x1),
        "h": max(1.0, y2 - y1),
    }


def _remember_tid(tid, hud_class, xyxy, now_t):
    st = _bbox_stats(xyxy)
    st.update({"class": hud_class, "bbox": list(xyxy), "last_seen": now_t})
    _id_memory[tid] = st


def _fallback_tid(hud_class, xyxy, now_t, used_tids):
    """Reuse a recent id when ByteTrack emits None; otherwise mint a negative id."""
    global _next_fallback_tid
    for tid in [k for k, v in _id_memory.items() if now_t - v["last_seen"] > FALLBACK_TRACK_TTL]:
        _id_memory.pop(tid, None)

    cur = _bbox_stats(xyxy)
    best_tid, best_score = None, float("inf")
    for tid, st in _id_memory.items():
        if tid in used_tids or st["class"] != hud_class:
            continue
        sx = max(cur["w"], st["w"], 80.0)
        sy = max(cur["h"], st["h"], 80.0)
        score = abs(cur["cx"] - st["cx"]) / sx + abs(cur["cy"] - st["cy"]) / sy
        if score < best_score:
            best_tid, best_score = tid, score

    if best_tid is None or best_score > 1.15:
        best_tid = _next_fallback_tid
        _next_fallback_tid -= 1

    used_tids.add(best_tid)
    _remember_tid(best_tid, hud_class, xyxy, now_t)
    return best_tid


def _stable_tid(raw_tid, hud_class, xyxy, now_t, used_tids):
    if raw_tid is not None:
        tid = int(raw_tid)
        if tid in used_tids:
            return _fallback_tid(hud_class, xyxy, now_t, used_tids)
        used_tids.add(tid)
        _remember_tid(tid, hud_class, xyxy, now_t)
        return tid
    return _fallback_tid(hud_class, xyxy, now_t, used_tids)


def _telemetry_id(tid):
    return f"T{tid}" if tid >= 0 else f"F{abs(tid)}"


def _fps(now_t):
    last = _fps_state["last_ts"]
    _fps_state["last_ts"] = now_t
    if last <= 0.0:
        return _fps_state["fps"]
    inst = 1.0 / max(now_t - last, 1e-3)
    _fps_state["fps"] = inst if _fps_state["fps"] <= 0.0 else _fps_state["fps"] * 0.85 + inst * 0.15
    return _fps_state["fps"]


def _enrich_v2_detections(detections, width, height, now_t):
    stale = [k for k, v in _track_state.items() if now_t - v["last_seen"] > TRACK_STATE_TTL]
    for key in stale:
        _track_state.pop(key, None)

    for d in detections:
        tid = d.get("tid")
        key = str(tid)
        lateral_ft = float(d.get("xRelM") or 0.0)
        distance_ft = float(d.get("distM") or 0.0)
        prev = _track_state.get(key)
        if prev:
            dt = max(now_t - prev["last_seen"], 1e-3)
            vx_inst = (lateral_ft - prev["lateral_ft"]) / dt
            vy_inst = (distance_ft - prev["distance_ft"]) / dt
            vx = prev["vx"] * 0.65 + vx_inst * 0.35
            vy = prev["vy"] * 0.65 + vy_inst * 0.35
            first_seen = prev["first_seen"]
        else:
            vx = vy = 0.0
            first_seen = now_t
        _track_state[key] = {
            "first_seen": first_seen,
            "last_seen": now_t,
            "lateral_ft": lateral_ft,
            "distance_ft": distance_ft,
            "vx": vx,
            "vy": vy,
        }

        x1, y1, x2, y2 = (float(v) for v in d.get("bbox", [0, 0, 0, 0]))
        d["distance_ft"] = round(distance_ft, 2)
        d["lateral_ft"] = round(lateral_ft, 2)
        d["cx"] = round(_clamp(((x1 + x2) * 0.5) / max(width, 1), 0.0, 1.0), 4)
        d["cy"] = round(_clamp(((y1 + y2) * 0.5) / max(height, 1), 0.0, 1.0), 4)
        d["age_ms"] = int((now_t - first_seen) * 1000)
        d["last_seen_ms"] = 0
        d["vx"] = round(vx, 2)
        d["vy"] = round(vy, 2)
        if d["class"] in VEHICLE_CLASSES:
            d["orientation"] = d.get("orient") or "unknown"


def _ocr_plate_chars(plate_bgr):
    """Read a plate crop with the char-detection YOLO: detect each digit/letter,
    group into rows (handles 1- or 2-line plates), sort left->right, join.
    Returns (text, mean_conf) or None."""
    if char_model is None or plate_bgr is None or plate_bgr.size == 0:
        return None
    # upscale small plate crops so characters are big enough to detect (the
    # char model was trained on larger plates). Needs real detail to begin with
    # — sub-~60px-wide plates from low-res video usually can't be recovered.
    if plate_bgr.shape[1] < CHAR_UPSCALE_W:
        s = CHAR_UPSCALE_W / plate_bgr.shape[1]
        plate_bgr = cv2.resize(plate_bgr, None, fx=s, fy=s,
                               interpolation=cv2.INTER_CUBIC)
    res = char_model(plate_bgr, conf=CHAR_CONF_MIN, verbose=False, device=DEVICE)
    chars = []
    for b in res[0].boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        chars.append({
            "ch": char_model.names[int(b.cls[0])],
            "conf": float(b.conf[0]),
            "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2,
            "h": y2 - y1,
        })
    if len(chars) < 4:                 # too few = not a real plate read
        return None
    # cluster into rows by vertical position (2-line plates read top then bottom)
    med_h = sorted(c["h"] for c in chars)[len(chars) // 2]
    chars.sort(key=lambda c: c["cy"])
    rows, cur = [], [chars[0]]
    for c in chars[1:]:
        if c["cy"] - cur[-1]["cy"] > 0.6 * med_h:
            rows.append(cur); cur = [c]
        else:
            cur.append(c)
    rows.append(cur)
    text = ""
    for row in rows:
        row.sort(key=lambda c: c["cx"])
        text += "".join(c["ch"] for c in row)
    text = "".join(PLATE_RE.findall(text.upper()))
    if len(text) < 4:
        return None
    mean_conf = sum(c["conf"] for c in chars) / len(chars)
    return (text, mean_conf)


def read_plate(frame, xyxy):
    """Detect plate with YOLO, then OCR with the char model (preferred) or EasyOCR."""
    if char_model is None and not _HAS_OCR:
        return None
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in xyxy)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 - x1 < 40 or y2 - y1 < 30:
        return None
        
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return None
        
    # 1. Try to find the exact plate using the YOLO model
    if plate_model is not None:
        p_res = plate_model(roi, verbose=False)
        best_plate = None
        best_conf = 0.0
        for box in p_res[0].boxes:
            if _PLATE_CLASS_ID is not None and int(box.cls[0]) != _PLATE_CLASS_ID:
                continue          # skip non-plate classes (e.g. 'class1')
            c = float(box.conf[0])
            if c > best_conf and c > 0.25:
                best_conf = c
                best_plate = box.xyxy[0].tolist()
        
        if best_plate:
            px1, py1, px2, py2 = (int(v) for v in best_plate)
            # Expand the plate box slightly to ensure text isn't cut off
            px1 = max(0, px1 - 5)
            py1 = max(0, py1 - 5)
            px2 = min(roi.shape[1], px2 + 5)
            py2 = min(roi.shape[0], py2 + 5)
            roi = roi[py1:py2, px1:px2]
        else:
            # Fallback: bottom 45% if the model misses it
            roi = roi[int((y2 - y1) * 0.55):, :]
    else:
        # Fallback: bottom 45%
        roi = roi[int((y2 - y1) * 0.55):, :]
        
    if roi.size == 0:
        return None

    # 1b. Preferred OCR: char-detection YOLO on the plate crop (fast, offline).
    if char_model is not None:
        hit = _ocr_plate_chars(roi)
        if hit:
            return hit
        if not _HAS_OCR:
            return None      # char model is the only OCR and it found nothing

    # 2. Sharpness gate — a motion-blurred plate has no legible characters, so
    #    skip it instead of emitting OCR garbage (var-of-Laplacian = focus measure).
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi
    if cv2.Laplacian(gray, cv2.CV_64F).var() < PLATE_SHARP_MIN:
        return None
    # upscale + CLAHE + unsharp mask to give EasyOCR the best shot
    if gray.shape[0] < 64:
        s = 64.0 / gray.shape[0]
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    gray = cv2.addWeighted(gray, 1.6, cv2.GaussianBlur(gray, (0, 0), 3), -0.6, 0)
    try:
        results = _plate_reader.readtext(gray, allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
        plates = []
        for _, t, prob in results:
            if prob > PLATE_PROB_MIN:
                for m in PLATE_RE.findall(t.upper().replace(" ", "")):
                    plates.append((m, float(prob)))
        # return (text, confidence) so the caller can vote across frames
        return max(plates, key=lambda x: (len(x[0]), x[1])) if plates else None
    except Exception:
        return None

# ---- lane-line detection (classical CV: road ROI + Canny + Hough, EMA-smoothed) ----
LANE_TTL = float(os.environ.get("LANE_TTL", "0.85"))
# curve-fit gates — looser = bends more readily on turns, tighter = stays straight.
LANE_CURVE_GAIN = float(os.environ.get("LANE_CURVE_GAIN", "0.90"))   # quad must beat line by this (was .65)
LANE_CURVE_MAX = float(os.environ.get("LANE_CURVE_MAX", "0.020"))    # max |a|; bigger allows sharper turns (was .004)
LANE_CURVE_MIN_PTS = int(os.environ.get("LANE_CURVE_MIN_PTS", "6"))  # min points to attempt a curve (was 10)
LANE_CURVE_MIN_SPAN = float(os.environ.get("LANE_CURVE_MIN_SPAN", "50"))  # min vertical px span (was 70)
LANE_EMA = float(os.environ.get("LANE_EMA", "0.5"))                  # higher = snappier turn tracking (was 0.4)
_lane_state = {
    "left": {"fit": None, "last_seen": 0.0, "confidence": 0.0},
    "right": {"fit": None, "last_seen": 0.0, "confidence": 0.0},
}   # smoothed (slope, intercept) in small-frame px


def _fit_side(pts):
    """Fit x as a function of y. Default to a STRAIGHT line; only return a curve
    when a quadratic clearly fits better AND the curvature is physically plausible.
    This stops noisy Hough points from bending a straight road. Returns (a, b, c)
    for x = a*y^2 + b*y + c (a == 0 means straight)."""
    if not pts:
        return None
    xs, ys = [], []
    for x1, y1, x2, y2 in pts:
        xs += [x1, x2]; ys += [y1, y2]
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    if np.unique(ys).size < 2:
        return None

    # straight fit + one outlier-rejection pass (drop points >2σ off the line)
    b, c = np.polyfit(ys, xs, 1)
    resid = xs - (b * ys + c)
    sigma = float(np.std(resid)) or 1.0
    keep = np.abs(resid) < 2.0 * sigma
    if keep.sum() >= 4:
        xs, ys = xs[keep], ys[keep]
        b, c = np.polyfit(ys, xs, 1)
        resid = xs - (b * ys + c)
    rmse_lin = float(np.sqrt(np.mean(resid * resid)))

    a = 0.0
    # only consider a curve with enough points spread over enough vertical range
    if ys.size >= LANE_CURVE_MIN_PTS and (ys.max() - ys.min()) > LANE_CURVE_MIN_SPAN:
        a2, b2, c2 = np.polyfit(ys, xs, 2)
        resid2 = xs - (a2 * ys * ys + b2 * ys + c2)
        rmse_quad = float(np.sqrt(np.mean(resid2 * resid2)))
        # accept the curve on a real fit improvement and bounded curvature;
        # a straight road shows ~no improvement, so it stays straight. Looser
        # gates than before so genuine turns actually bend (was 0.65 / 0.004).
        if rmse_quad < LANE_CURVE_GAIN * rmse_lin and abs(a2) < LANE_CURVE_MAX:
            a, b, c = a2, b2, c2
    return (float(a), float(b), float(c))


def _lane_confidence(pts, h):
    if not pts:
        return 0.0
    length = sum(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 for x1, y1, x2, y2 in pts)
    by_count = min(0.45, len(pts) * 0.09)
    by_length = min(0.45, length / max(h * 1.7, 1))
    return _clamp(0.10 + by_count + by_length, 0.0, 1.0)


def detect_lanes(frame):
    """Track real lane lines; returns v1 left/right plus v2 source/confidence/center."""
    now_t = time.time()
    H, W = frame.shape[:2]
    sc = 640.0 / W
    small = cv2.resize(frame, (640, max(1, int(H * sc))))
    h, w = small.shape[:2]
    edges = cv2.Canny(cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0), 60, 150)
    mask = np.zeros_like(edges)
    # wide vertical span so the road band is covered whether the video is
    # fullscreen (road fills the bottom) or letterboxed (road sits mid-frame).
    yb, yt = int(h * 0.93), int(h * 0.42)
    roi = np.array([[(int(w * 0.04), yb), (int(w * 0.40), yt),
                     (int(w * 0.60), yt), (int(w * 0.96), yb)]], np.int32)
    cv2.fillPoly(mask, roi, 255)
    lines = cv2.HoughLinesP(cv2.bitwise_and(edges, mask), 1, np.pi / 180, 35,
                            minLineLength=int(h * 0.05), maxLineGap=120)
    left, right = [], []
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0, :]:
            if x2 == x1:
                continue
            s = (y2 - y1) / (x2 - x1)
            if abs(s) < 0.4:                  # drop near-horizontal clutter
                continue
            (left if s < 0 else right).append((x1, y1, x2, y2))
    ema = LANE_EMA
    ygrid = np.linspace(yb, yt, 8)   # sample bottom -> top (decreasing y) for a polyline
    out = {}
    for side, pts in (("left", left), ("right", right)):
        f = _fit_side(pts)
        side_conf = _lane_confidence(pts, h)
        if f:
            prev = _lane_state[side]["fit"]
            if prev is None or len(prev) != len(f):
                _lane_state[side]["fit"] = f
            else:
                _lane_state[side]["fit"] = tuple(
                    p + (n - p) * ema for p, n in zip(prev, f))
            _lane_state[side]["last_seen"] = now_t
            _lane_state[side]["confidence"] = side_conf
        st = _lane_state[side]
        if st["fit"] and now_t - st["last_seen"] <= LANE_TTL:
            a, b, c = st["fit"]
            age_decay = _clamp(1.0 - ((now_t - st["last_seen"]) / LANE_TTL), 0.0, 1.0)
            # sample bottom -> top; stop where the line leaves the frame instead of
            # clamping x to the edge (clamping hooks straight lanes into fake curves).
            poly = []
            for yy in ygrid:
                xf = (a * yy * yy + b * yy + c) / sc
                if xf < -2 or xf > W + 2:
                    break
                poly.append([round(xf, 1), round(yy / sc, 1)])
            if len(poly) >= 2:
                out[side] = poly
                out[f"{side}_confidence"] = round(st["confidence"] * age_decay, 3)
    if not (out.get("left") or out.get("right")):
        return None

    side_scores = [out[k] for k in ("left_confidence", "right_confidence") if k in out]
    confidence = sum(side_scores) / max(len(side_scores), 1)
    if out.get("left") and out.get("right"):
        confidence = _clamp(confidence + 0.18, 0.0, 1.0)
        # center line = per-sample midpoint of the two curves (same y grid)
        out["center"] = [
            [round((l[0] + r[0]) * 0.5, 1), round((l[1] + r[1]) * 0.5, 1)]
            for l, r in zip(out["left"], out["right"])
        ]
    else:
        confidence *= 0.65
    out["confidence"] = round(_clamp(confidence, 0.0, 1.0), 3)
    out["source"] = "vision"
    return out


latest_frame = None          # encoded MJPEG bytes (produced by the capture thread)
latest_raw = None            # most recent decoded BGR frame (shared capture -> inference)
latest_raw_seq = 0           # bumps each new frame so inference can skip duplicates
latest_telemetry = {"speedMps": 0.0, "lidarDistM": None, "detections": []}

# ---- frame source: webcam (default) or on-screen capture ----
# VISION_SOURCE=screen grabs a screen region instead of the Brio, so you can
# play driving footage in a browser tab and feed it straight to YOLO.
# Optional SCREEN_REGION="x,y,w,h" in pixels; default = whole primary display.
VISION_SOURCE = os.environ.get("VISION_SOURCE", "webcam").lower()


def _parse_region(spec):
    try:
        x, y, w, h = (int(v) for v in spec.split(","))
        return {"left": x, "top": y, "width": w, "height": h}
    except Exception:
        return None


if VISION_SOURCE == "screen":
    import mss

    # mss handles are not thread-safe; build one lazily inside the grab thread.
    _grab = threading.local()
    _region_spec = os.environ.get("SCREEN_REGION", "")

    def _sct_region():
        if not hasattr(_grab, "sct"):
            _grab.sct = mss.MSS()
            _grab.region = _parse_region(_region_spec) or _grab.sct.monitors[1]
            print(f"[vision] source=screen region={_grab.region}", flush=True)
        return _grab.sct, _grab.region

    def read_frame():
        sct, region = _sct_region()
        shot = sct.grab(region)
        frame = np.ascontiguousarray(np.array(shot)[:, :, :3])  # BGRA -> BGR
        return True, frame

    def source_ok():
        return True

elif VISION_SOURCE == "window":
    # Capture one dedicated Chrome window by name — wherever it sits, even if
    # partly covered. WINDOW_OWNER (default "Chrome") + optional WINDOW_MATCH
    # (substring of the tab/window title) pick the window. Put the driving
    # footage in its own Chrome window and only that window feeds YOLO.
    import Quartz

    _win_owner = os.environ.get("WINDOW_OWNER", "Chrome")
    _win_match = os.environ.get("WINDOW_MATCH", "")
    # never capture the dashboard tab itself (its <title> is "WRX Cluster"),
    # otherwise we'd film the HUD showing itself. Override via WINDOW_EXCLUDE.
    _win_exclude = os.environ.get("WINDOW_EXCLUDE", "WRX Cluster")
    _win = {"id": None}

    def _find_window():
        wins = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
        )
        best, best_area = None, 0
        for w in wins or []:
            owner = w.get("kCGWindowOwnerName") or ""
            name = w.get("kCGWindowName") or ""
            if _win_owner.lower() not in owner.lower():
                continue
            if not name:
                continue  # untitled Chrome window (helper / unfocused) → skip
            if _win_match and _win_match.lower() not in name.lower():
                continue
            if _win_exclude and _win_exclude.lower() in name.lower():
                continue  # skip the dashboard window
            b = w.get("kCGWindowBounds", {})
            area = b.get("Width", 0) * b.get("Height", 0)
            if area > best_area and b.get("Width", 0) > 200 and b.get("Height", 0) > 200:
                best, best_area = w, area
        if best is not None:
            _win["id"] = best["kCGWindowNumber"]
            print(f"[vision] source=window owner={_win_owner!r} "
                  f"title={best.get('kCGWindowName')!r} id={_win['id']}", flush=True)
        return _win["id"]

    def _grab_window(win_id):
        img = Quartz.CGWindowListCreateImage(
            Quartz.CGRectNull,
            Quartz.kCGWindowListOptionIncludingWindow,
            win_id,
            Quartz.kCGWindowImageBoundsIgnoreFraming,
        )
        if img is None:
            return None
        w = Quartz.CGImageGetWidth(img)
        h = Quartz.CGImageGetHeight(img)
        if not w or not h:
            return None
        bpr = Quartz.CGImageGetBytesPerRow(img)
        data = Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img))
        buf = np.frombuffer(data, dtype=np.uint8).reshape((h, bpr // 4, 4))
        return np.ascontiguousarray(buf[:, :w, :3])  # BGRA (row-padded) -> BGR

    def read_frame():
        win_id = _win["id"] or _find_window()
        if not win_id:
            return False, None
        frame = _grab_window(win_id)
        if frame is None:
            _win["id"] = None  # window closed/moved → re-find next tick
            return False, None
        return True, frame

    def source_ok():
        return True

elif VISION_SOURCE == "file":
    # Loop a driving-footage clip straight through YOLO — no webcam, no window
    # capture, no macOS permissions. Best for testing the HUD on real footage.
    #   VISION_SOURCE=file VIDEO_PATH=/path/to/driving.mp4
    _video_path = os.environ.get("VIDEO_PATH", "")
    cap = cv2.VideoCapture(_video_path)
    print(f"[vision] source=file path={_video_path!r} opened={cap.isOpened()}",
          flush=True)

    def read_frame():
        ret, frame = cap.read()
        if not ret:  # end of clip → rewind and keep playing
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, frame = cap.read()
        return ret, frame

    def source_ok():
        return cap.isOpened()

elif VISION_SOURCE == "youtube":
    # Stream directly from YouTube using yt-dlp
    _video_url = os.environ.get("VIDEO_URL", "")
    try:
        import subprocess
        result = subprocess.run(
            ["yt-dlp", "-f", "best", "-g", _video_url],
            capture_output=True,
            text=True,
            timeout=15
        )
        if result.returncode == 0:
            stream_url = result.stdout.strip().split("\n")[0]
            cap = cv2.VideoCapture(stream_url)
        else:
            raise Exception(f"yt-dlp failed: {result.stderr}")
    except Exception as e:
        print(f"[vision] YouTube error: {e}, falling back to file", flush=True)
        cap = cv2.VideoCapture(_video_url)
    
    print(f"[vision] source=youtube url={_video_url!r} opened={cap.isOpened()}", flush=True)

    def read_frame():
        global cap
        ret, frame = cap.read()
        if not ret:  # end of stream → try to reconnect
            try:
                result = subprocess.run(
                    ["yt-dlp", "-f", "best", "-g", _video_url],
                    capture_output=True,
                    text=True,
                    timeout=15
                )
                if result.returncode == 0:
                    stream_url = result.stdout.strip().split("\n")[0]
                    cap = cv2.VideoCapture(stream_url)
                    ret, frame = cap.read()
            except Exception:
                pass
        return ret, frame

    def source_ok():
        return cap.isOpened()

else:
    cap = cv2.VideoCapture(0)
    print("[vision] source=webcam index=0", flush=True)

    def read_frame():
        return cap.read()

    def source_ok():
        return cap.isOpened()


def map_coco_to_hud(cls_name):
    return COCO_TO_HUD.get(cls_name.lower().strip())


def capture_loop():
    """Sole reader of the source. Decodes frames and encodes the MJPEG at the
    source frame rate — independent of (and much faster than) inference — so the
    recorded video stays smooth even while YOLO runs slower in camera_loop."""
    global latest_frame, latest_raw, latest_raw_seq

    cap_fps_env = float(os.environ.get("CAPTURE_FPS", "0") or 0)
    if cap_fps_env > 1:
        interval = 1.0 / cap_fps_env          # explicit cap (e.g. 18 when feeding a Pi)
    elif VISION_SOURCE == "file":
        try:
            sfps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        except Exception:
            sfps = 0.0
        interval = 1.0 / sfps if sfps and sfps > 1 else 1.0 / 30.0
    else:
        interval = 1.0 / 30.0   # cap webcam/screen/window encode at 30fps

    while source_ok():
        t0 = time.time()
        ret, frame = read_frame()
        if not ret:
            time.sleep(0.03)
            continue
        latest_raw = frame
        latest_raw_seq += 1
        # encode the RAW frame — overlays are drawn client-side, nothing baked in
        out = frame
        if out.shape[1] > MJPEG_MAX_W:
            sc = MJPEG_MAX_W / out.shape[1]
            out = cv2.resize(out, (MJPEG_MAX_W, int(out.shape[0] * sc)),
                             interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, MJPEG_QUALITY])
        if ok:
            latest_frame = buffer.tobytes()
        dt = time.time() - t0
        if dt < interval:
            time.sleep(interval - dt)


def camera_loop():
    """Inference loop — runs YOLO/lanes on the latest captured frame at its own
    pace and publishes telemetry. Does NOT read the source or touch the MJPEG."""
    global latest_telemetry
    last_seq = -1

    while True:
        # wait for a fresh frame; skip if inference outran capture (no dup work)
        if latest_raw is None or latest_raw_seq == last_seq:
            time.sleep(0.005)
            continue
        last_seq = latest_raw_seq
        frame = latest_raw

        height, width, _ = frame.shape
        frame_ts = time.time()
        fps_value = _fps(frame_ts)
        used_tids = set()
        # .track() keeps persistent IDs across frames (ByteTrack) so the HUD can
        # smooth each car's motion instead of flickering — the Tesla-style glide.
        results = model.track(frame, conf=CONF_MIN, persist=True,
                              tracker="bytetrack.yaml", verbose=False, device=DEVICE)
        # self-training: stash high-confidence detections as pseudo-labels.
        if collector is not None:
            collector.maybe_save(frame, results[0].boxes, width, height)
        # the light model is a second full YOLO pass — lights move slowly, so run
        # it every Nth frame and reuse the cached boxes between runs.
        _fc = getattr(camera_loop, "_fc", 0) + 1
        camera_loop._fc = _fc
        if _fc % LIGHT_EVERY == 1:
            _lr = light_model(frame, verbose=False, device=DEVICE)
            camera_loop._light_boxes = [
                (bx.xyxy[0].tolist(), float(bx.conf[0]), int(bx.cls[0]))
                for bx in _lr[0].boxes
            ]
        light_boxes = getattr(camera_loop, "_light_boxes", [])
        detections = []
        for box in results[0].boxes:
            cls_id = int(box.cls[0])
            cls_name = model.names[cls_id]
            conf = float(box.conf[0])
            raw_tid = int(box.id[0]) if box.id is not None else None
            hud_class = map_coco_to_hud(cls_name)
            if not hud_class or hud_class == "TRAFFIC_LIGHT":
                continue  # dedicated light model owns traffic lights (with colour)

            xyxy = box.xyxy[0].tolist()
            # reject sky/billboard false positives: a real road object's ground
            # contact (bbox bottom) sits below the horizon line. Street signs are
            # the exception — they're mounted high, so don't horizon-reject them.
            if hud_class != "STOP_SIGN" and xyxy[3] < HORIZON_FRAC * height:
                continue
            # billboards/ads trigger weak "person" hits — demand higher confidence
            if hud_class == "PEDESTRIAN" and conf < PED_CONF_MIN:
                continue

            range_ft = estimate_range_ft(xyxy, width, height, cls_name)
            lateral_ft = estimate_lateral_ft(xyxy, width, range_ft)
            tid = _stable_tid(raw_tid, hud_class, xyxy, frame_ts, used_tids)

            detections.append({
                "id": _telemetry_id(tid),
                "tid": tid,
                "class": hud_class,
                "coco": cls_name,
                "xRelM": lateral_ft,
                "yRelM": range_ft,
                "distM": range_ft,
                "conf": conf,
                "bbox": [round(v, 1) for v in xyxy],
            })

        # traffic lights with colour state from the dedicated model (cached boxes).
        # No bake-in — the dashboard draws the marker, so it isn't shown twice.
        for xyxy, conf, cls_i in light_boxes:
            if conf < 0.55:                      # was 0.25 — poles/signs fired as lights
                continue
            color_name = light_model.names[cls_i].lower().strip()
            state = LIGHT_STATE.get(color_name)
            if not state:
                continue
            # real signals hang high — reject anything centred low in the frame
            if (xyxy[1] + xyxy[3]) / 2 > 0.55 * height:
                continue
            range_ft = estimate_range_ft(xyxy, width, height, "traffic light")
            lateral_ft = estimate_lateral_ft(xyxy, width, range_ft)
            tid = _stable_tid(None, "TRAFFIC_LIGHT", xyxy, frame_ts, used_tids)
            detections.append(
                {
                    "id": _telemetry_id(tid),
                    "tid": tid,
                    "class": "TRAFFIC_LIGHT",
                    "coco": f"traffic light ({color_name})",
                    "xRelM": lateral_ft,
                    "yRelM": range_ft,
                    "distM": range_ft,
                    "conf": conf,
                    "state": state,
                    "bbox": [round(v, 1) for v in xyxy],
                }
            )

        # car-parts segmentation → per-vehicle orientation, run on UPSCALED crops.
        # carparts-seg needs a big clear car; distant cars are tiny in the full
        # frame, so crop each vehicle box and enlarge it before segmenting.
        now_t2 = frame_ts
        _orient_ts = getattr(camera_loop, "_orient_ts", 0.0)
        _orient_cache = getattr(camera_loop, "_orient_cache", {})
        vehs = [d for d in detections if d["class"] in VEHICLE_CLASSES]

        def _okey(b):  # position-rounded key so orient persists between seg runs
            return (round((b[0] + b[2]) / 2 / 20) * 20, round((b[1] + b[3]) / 2 / 20) * 20)

        if parts_model is not None and vehs and now_t2 - _orient_ts >= 0.5:
            camera_loop._orient_ts = now_t2
            # Only run seg on nearest 2 vehicles that are close enough to have legible parts
            close_vehs = [d for d in sorted(vehs, key=lambda x: x["distM"]) if d["distM"] < 40][:2]
            for d in close_vehs:
                b = [int(v) for v in d["bbox"]]
                x1, y1 = max(0, b[0]), max(0, b[1])
                x2, y2 = min(width, b[2]), min(height, b[3])
                if x2 - x1 < 24 or y2 - y1 < 24:
                    continue
                crop = frame[y1:y2, x1:x2]
                ch = y2 - y1
                if ch < 192:                          # enlarge small cars
                    s = 192.0 / ch
                    crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
                pres = parts_model(crop, conf=0.25, verbose=False, device=DEVICE)
                fs = rs = 0.0
                for pb in pres[0].boxes:
                    side = _part_side(parts_model.names[int(pb.cls[0])])
                    if side == "front":
                        fs += float(pb.conf[0])
                    elif side == "rear":
                        rs += float(pb.conf[0])
                if fs > 0 or rs > 0:
                    d["orient"] = "front" if fs > rs else "rear"
                    _orient_cache[_okey(d["bbox"])] = d["orient"]
            camera_loop._orient_cache = _orient_cache
        else:
            for d in vehs:                            # reuse cache between seg runs
                o = _orient_cache.get(_okey(d["bbox"]))
                if o:
                    d["orient"] = o

        # license-plate OCR → stick the read to that car's TRACK ID so it stays
        # on the same vehicle as it moves (not a per-frame position guess).
        if _HAS_OCR and PLATE_OCR:
            vehicles = [d for d in detections if d["class"] in VEHICLE_CLASSES]
            now_t = frame_ts
            if vehicles and now_t - _plate["last_ocr"] >= OCR_INTERVAL:
                _plate["last_ocr"] = now_t
                # OCR the nearest 2 vehicles; vote each read into that car's track id.
                # Consensus across frames beats any single noisy read (the 10x win).
                for d in sorted(vehicles, key=lambda d: d["distM"])[:2]:
                    tid = d.get("tid")
                    if tid is None:
                        continue
                    res = read_plate(frame, d["bbox"])
                    if res:
                        text, prob = res
                        votes = _plate_votes.setdefault(tid, {})
                        votes[text] = votes.get(text, 0.0) + prob
                        _plate_by_tid[tid] = (max(votes, key=votes.get), now_t)
            # prune stale, then re-attach each car's consensus plate by track id
            for k in [k for k, (_, ts) in _plate_by_tid.items() if now_t - ts > PLATE_TTL]:
                _plate_by_tid.pop(k, None); _plate_votes.pop(k, None)
            for d in vehicles:
                tid = d.get("tid")
                cached = _plate_by_tid.get(tid)
                # only surface a plate once several confident reads agree on it —
                # one noisy frame shouldn't paint a wrong plate. Dashboard draws it
                # (no bake-in here, so it isn't shown twice / can't be wrong twice).
                if cached and _plate_votes.get(tid, {}).get(cached[0], 0.0) >= PLATE_VOTE_MIN:
                    d["plate"] = cached[0]

        _enrich_v2_detections(detections, width, height, frame_ts)

        latest_telemetry = {
            "v": 2,
            "ts": frame_ts,
            "fps": round(fps_value, 1),
            "stale": False,
            "speedMps": latest_telemetry.get("speedMps", 0.0),
            "lidarDistM": latest_telemetry.get("lidarDistM"),
            "camera": {"width": width, "height": height},
            "detections": detections,
            "lanes": detect_lanes(frame),
        }


# capture (smooth video) + inference (detections) run on separate threads
threading.Thread(target=capture_loop, daemon=True).start()
threading.Thread(target=camera_loop, daemon=True).start()


def mjpeg_generator():
    # only push NEW frames — so the client decodes at the capture rate (CAPTURE_FPS),
    # not a fixed 30fps of duplicates. This is what actually unloads the Pi.
    last = -1
    while True:
        if latest_frame is not None and latest_raw_seq != last:
            last = latest_raw_seq
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + latest_frame + b"\r\n"
            )
        else:
            time.sleep(0.004)


@app.get("/video_feed")
def video_feed():
    return StreamingResponse(
        mjpeg_generator(), media_type="multipart/x-mixed-replace; boundary=frame"
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(json.dumps(latest_telemetry))
            await asyncio.sleep(FRAME_INTERVAL)
    except Exception as e:
        print("WebSocket disconnected", e)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8766)
