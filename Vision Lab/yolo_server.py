import cv2
import os
import re
import json
import time
import asyncio
import threading

import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

from distance import estimate_lateral_ft, estimate_range_ft

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

model = YOLO("yolov8n.pt")
# Dedicated traffic-light state model: classes {0:'green', 1:'red', 2:'yellow'}.
light_model = YOLO("traffic-light-detection.pt")
LIGHT_STATE = {"green": "GREEN", "red": "RED", "yellow": "YELLOW"}
LIGHT_BGR = {"RED": (0, 0, 255), "YELLOW": (0, 255, 255), "GREEN": (0, 255, 0)}

# ---- car-parts segmentation → vehicle orientation (optional; loads if present) ----
_PARTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "carparts-seg.pt")
parts_model = YOLO(_PARTS_PATH) if os.path.exists(_PARTS_PATH) else None
if parts_model is not None:
    print(f"[vision] carparts-seg loaded: {len(parts_model.names)} classes", flush=True)


def _part_side(name):
    """Map a carparts class name to which face of the car it belongs to."""
    n = name.lower()
    if "front" in n or "hood" in n or "headlight" in n:
        return "front"
    if "back" in n or "rear" in n or "tail" in n or "trunk" in n:
        return "rear"
    return None

# plate detector — prefer the newer LPR model once exported, else the old one
_PLATE_PATHS = ["lpr-v1.pt", "plate-detector.pt"]
_plate_path = next((p for p in _PLATE_PATHS if os.path.exists(p)), None)
plate_model = YOLO(_plate_path) if _plate_path else None
if plate_model is not None:
    print(f"[vision] plate detector: {_plate_path}", flush=True)

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
PLATE_RE = re.compile(r"[A-Z0-9]{4,8}")
OCR_INTERVAL = 0.5  # seconds between OCR passes to keep fps high
PLATE_SHARP_MIN = float(os.environ.get("PLATE_SHARP_MIN", "120"))  # focus gate (var-of-Laplacian)
_plate = {"text": None, "cx": 0.0, "cy": 0.0, "ts": 0.0, "last_ocr": 0.0}
_plate_by_tid = {}          # track id -> (plate_text, timestamp) — sticks plate to a car
_plate_votes = {}           # track id -> {plate_text: summed_confidence} for consensus
PLATE_TTL = 8.0             # keep a car's plate this long after its last good read


def read_plate(frame, xyxy):
    """Detect plate with YOLO (if available), then OCR using EasyOCR."""
    if not _HAS_OCR:
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
            if prob > 0.30:
                for m in PLATE_RE.findall(t.upper().replace(" ", "")):
                    plates.append((m, float(prob)))
        # return (text, confidence) so the caller can vote across frames
        return max(plates, key=lambda x: (len(x[0]), x[1])) if plates else None
    except Exception:
        return None

# ---- lane-line detection (classical CV: road ROI + Canny + Hough, EMA-smoothed) ----
_lane_state = {"left": None, "right": None}   # smoothed (slope, intercept) in small-frame px


def _fit_side(pts):
    if not pts:
        return None
    xs, ys = [], []
    for x1, y1, x2, y2 in pts:
        xs += [x1, x2]; ys += [y1, y2]
    if len(set(ys)) < 2:
        return None
    m, b = np.polyfit(ys, xs, 1)   # x = m*y + b  (lane lines are near-vertical)
    return float(m), float(b)


def detect_lanes(frame):
    """Track the real lane lines in the frame; returns {'left':[[x,y],[x,y]], 'right':...} or None."""
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
    a = 0.4
    out = {}
    for side, pts in (("left", left), ("right", right)):
        f = _fit_side(pts)
        if f:
            prev = _lane_state[side]
            _lane_state[side] = f if prev is None else (
                prev[0] + (f[0] - prev[0]) * a, prev[1] + (f[1] - prev[1]) * a)
        st = _lane_state[side]
        if st:
            m, b = st
            out[side] = [[round((m * yb + b) / sc, 1), round(yb / sc, 1)],
                         [round((m * yt + b) / sc, 1), round(yt / sc, 1)]]
    return out or None


latest_frame = None
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

else:
    cap = cv2.VideoCapture(0)
    print("[vision] source=webcam index=0", flush=True)

    def read_frame():
        return cap.read()

    def source_ok():
        return cap.isOpened()


def map_coco_to_hud(cls_name):
    return COCO_TO_HUD.get(cls_name.lower().strip())


def camera_loop():
    global latest_frame, latest_telemetry

    while source_ok():
        ret, frame = read_frame()
        if not ret:
            time.sleep(0.1)
            continue

        height, width, _ = frame.shape
        # .track() keeps persistent IDs across frames (ByteTrack) so the HUD can
        # smooth each car's motion instead of flickering — the Tesla-style glide.
        results = model.track(frame, conf=CONF_MIN, persist=True,
                              tracker="bytetrack.yaml", verbose=False)
        # raw frame for the MJPEG — the dashboard renders its own clean overlay,
        # so don't bake YOLO's cluttered boxes/labels into the background video.
        annotated_frame = frame.copy()
        light_results = light_model(frame, verbose=False)
        detections = []
        for box in results[0].boxes:
            cls_id = int(box.cls[0])
            cls_name = model.names[cls_id]
            conf = float(box.conf[0])
            tid = int(box.id[0]) if box.id is not None else None
            hud_class = map_coco_to_hud(cls_name)
            if not hud_class or hud_class == "TRAFFIC_LIGHT":
                continue  # dedicated light model owns traffic lights (with colour)

            xyxy = box.xyxy[0].tolist()
            # reject sky/billboard false positives: a real road object's ground
            # contact (bbox bottom) sits below the horizon line.
            if xyxy[3] < HORIZON_FRAC * height:
                continue
            # billboards/ads trigger weak "person" hits — demand higher confidence
            if hud_class == "PEDESTRIAN" and conf < PED_CONF_MIN:
                continue

            range_ft = estimate_range_ft(xyxy, width, height, cls_name)
            lateral_ft = estimate_lateral_ft(xyxy, width, range_ft)

            detections.append({
                "id": f"T{tid}" if tid is not None else f"{hud_class}:{int(xyxy[0])}:{int(xyxy[1])}",
                "tid": tid,
                "class": hud_class,
                "coco": cls_name,
                "xRelM": lateral_ft,
                "yRelM": range_ft,
                "distM": range_ft,
                "conf": conf,
                "bbox": [round(v, 1) for v in xyxy],
            })

        # traffic lights with colour state from the dedicated model
        for box in light_results[0].boxes:
            conf = float(box.conf[0])
            if conf < 0.55:                      # was 0.25 — poles/signs fired as lights
                continue
            color_name = light_model.names[int(box.cls[0])].lower().strip()
            state = LIGHT_STATE.get(color_name)
            if not state:
                continue
            xyxy = box.xyxy[0].tolist()
            # real signals hang high — reject anything centred low in the frame
            if (xyxy[1] + xyxy[3]) / 2 > 0.55 * height:
                continue
            range_ft = estimate_range_ft(xyxy, width, height, "traffic light")
            lateral_ft = estimate_lateral_ft(xyxy, width, range_ft)
            detections.append(
                {
                    "id": f"TRAFFIC_LIGHT:{int(xyxy[0])}:{int(xyxy[1])}",
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
            bgr = LIGHT_BGR[state]
            x1, y1, x2, y2 = (int(v) for v in xyxy)
            cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), bgr, 2)
            cv2.putText(annotated_frame, state, (x1, max(15, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, bgr, 2)

        # car-parts segmentation → per-vehicle orientation, run on UPSCALED crops.
        # carparts-seg needs a big clear car; distant cars are tiny in the full
        # frame, so crop each vehicle box and enlarge it before segmenting.
        now_t2 = time.time()
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
                pres = parts_model(crop, conf=0.25, verbose=False)
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
        if _HAS_OCR:
            vehicles = [d for d in detections if d["class"] in VEHICLE_CLASSES]
            now_t = time.time()
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
                cached = _plate_by_tid.get(d.get("tid"))
                if cached:
                    d["plate"] = cached[0]
                    bx1, by1 = int(d["bbox"][0]), int(d["bbox"][1])
                    cv2.putText(annotated_frame, cached[0], (bx1, max(15, by1 - 8)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (15, 204, 250), 2)

        # downscale for the MJPEG — it's only a faint 10% background reference.
        # full-res frames (1800px) at 30fps saturate the browser and starve the
        # detection WebSocket (→ VISION STALE + no cars). 720px @ q60 is plenty.
        out = annotated_frame
        if out.shape[1] > 720:
            sc = 720.0 / out.shape[1]
            out = cv2.resize(out, (720, int(out.shape[0] * sc)), interpolation=cv2.INTER_AREA)
        _, buffer = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 60])
        latest_frame = buffer.tobytes()

        latest_telemetry["camera"] = {"width": width, "height": height}
        latest_telemetry["detections"] = detections
        latest_telemetry["lanes"] = detect_lanes(frame)
        time.sleep(FRAME_INTERVAL)


threading.Thread(target=camera_loop, daemon=True).start()


def mjpeg_generator():
    while True:
        if latest_frame is not None:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + latest_frame + b"\r\n"
            )
        time.sleep(FRAME_INTERVAL)


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
