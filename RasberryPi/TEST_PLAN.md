# TEST_PLAN

Every pass runs the relevant checks before logging. Backend = vision-lab; frontend = web/.

## Quick commands

```bash
# --- backend up? ---
lsof -i :8766 -sTCP:LISTEN -n -P

# --- python syntax (backend) ---
python3 -m py_compile "/Users/sean/Desktop/RetroView Ultra/vision-lab/yolo_server.py"

# --- js syntax (frontend) ---
node --check "/Users/sean/Documents/RasberryPi/web/dashboard.js"

# --- MJPEG reachable + bandwidth (should be ~1–2 MB/s, NOT 13) ---
curl -s -m 2 -o /dev/null -w "bytes in 2s=%{size_download} http=%{http_code}\n" http://127.0.0.1:8766/video_feed

# --- WebSocket telemetry sample (keys + lanes + a detection) ---
python3 - <<'PY'
import asyncio, json, websockets
async def main():
    async with websockets.connect("ws://127.0.0.1:8766/ws") as ws:
        m=json.loads(await ws.recv())
        print("keys:", list(m.keys()))
        print("lanes:", m.get("lanes"))
        print("det0:", (m.get("detections") or [None])[0])
asyncio.run(main())
PY
```

## Backend (Codex)
- [ ] `py_compile` passes.
- [ ] Server boots; log shows all models + `source=window`.
- [ ] WS emits `detections` + `lanes` + `camera`.
- [ ] `tid` is non-null for tracked vehicles (Pass 4 target).
- [ ] Lane points within `[0,width]×[0,height]` (no off-frame extrapolation).
- [ ] OCR runs on ≤ nearest 2–3 cars, throttled (no per-frame-all-cars).
- [ ] Backend FPS stable (≥ ~20) with all models on.
- [ ] No exception spam in `/tmp/yolo.log`.

## Frontend (Cursor)
- [ ] `node --check` passes.
- [ ] Hard-reload (Cmd+Shift+R); `VISION LIVE`, not `STALE`.
- [ ] Cars render 3D, **size-capped** (no screen-filling), far ones fade.
- [ ] No ego car. No cyan box spam. Labels near-only.
- [ ] Lanes follow the video; fallback lanes visually distinct when confidence low.
- [ ] Plate badge only when confident; sticks to one car.
- [ ] Smooth (rAF), no layout thrash, no per-frame DOM churn.

## Full-app (Antigravity)
- [ ] `smoke_test.sh`: backend proc + MJPEG 200 + WS has detections + dashboard route 200.
- [ ] Bandwidth check ≤ ~2 MB/s.
- [ ] WS not stale while backend alive.
- [ ] Clean restart recovers (browser reconnects WS + MJPEG).

## Regression guards (never reintroduce)
- MJPEG back to full-res 1800px firehose → browser starvation / `VISION STALE`.
- Ego car returns.
- Close car balloons to fill HUD.
- Fixed synthetic lanes shown as primary (must be fallback only).
- Plate flicker (un-voted, low-confidence guesses).
