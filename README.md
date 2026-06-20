# RetroVision

RetroVision is a driving-vision dashboard app designed to provide a Tesla-style driver assistance HUD. It features MJPEG streaming, YOLO detections, ByteTrack IDs, plate OCR, and lane detection.

## Scene Mode & Intersection Timer
RetroVision can run in two center-panel modes:

- **Perception HUD** — the realtime, frame-accurate view (camera + YOLO boxes + lanes).
- **Scene Mode** *(default)* — a "less realtime, more visual" view. Instead of tracking
  every object, it infers the **driving type** from telemetry + coarse vision cues and paints
  a stylised retro/synthwave scene that matches it: `PARKED`, `TRAFFIC`, `CITY`, `SUBURBAN`,
  `HIGHWAY`, or `CANYON`. The scene scrolls in parallax at a rate tied to road speed, and the
  classifier uses hysteresis so the scene stays stable instead of flickering between types.

On top of the scene sits an **Urus-style intersection countdown** (`intersection.js`):
- **Approach** — when a traffic light or stop sign is ahead, a ring counts down the
  estimated time-to-arrival (distance ÷ speed).
- **Stop hold** — at a stop sign, a 3s "complete stop" timer, then `GO`.
- **Red wait** — at a red light, a *predicted* time-to-green. The prediction is **learned**:
  observed red-phase durations are folded into a running average (persisted in
  `localStorage`), so the estimate sharpens the more lights you sit through. Actual elapsed
  wait is always shown beneath the prediction.

**Toggles:** press `s` to switch between Scene Mode and the Perception HUD; or use
`?scene=1` / `?scene=0` in the URL. Defaults and tuning live under `SCENE` and
`INTERSECTION` in `RasberryPi/web/config.js` (`SCENE_MODE_DEFAULT` flips the startup view).

## How to Run
To start both the backend YOLO server and the frontend web server:
```bash
./scripts/start_app.sh
```
The YOLO server will run in the background and the frontend will be available at `http://localhost:8000`.

## How to Reload
To cleanly restart the backend YOLO server without killing the frontend:
```bash
./scripts/restart_server.sh
```

## How to Test
A suite of diagnostic scripts is available in the `scripts/` directory:

- **Smoke Test**: Run `./scripts/smoke_test.sh` to check the overall health of the backend, MJPEG stream, and WebSocket telemetry.
- **Test MJPEG**: Run `./scripts/check_mjpeg.sh` to verify the video feed is streaming correctly.
- **Test WebSocket**: Run `./scripts/check_ws.py` to ensure the server is emitting detections and lane data.
- **Test FPS**: Run `./scripts/check_fps.py` to measure the telemetry update rate.
- **Test Bandwidth**: Run `./scripts/check_bandwidth.sh` to ensure the MJPEG stream is not overloading the network.

## Agent Ownership
This repository is maintained by four AI agents, each with strict responsibilities to prevent stepping on each other:

- **Claude**: Architect, reviewer, planner, quality control. Owns documentation, roadmap, schema, and assignment files.
- **Codex**: Backend vision pipeline. Owns `yolo_server.py` and backend logic (OCR, tracking, lane detection).
- **Cursor**: Frontend HUD and visuals. Owns `dashboard.js`, CSS, HTML, and rendering utilities.
- **Antigravity**: Integration, testing, and dev workflow. Owns `scripts/`, `tests/`, and performance diagnostics.

## Troubleshooting: VISION STALE
If the dashboard shows a "VISION STALE" error:
1. **Check Backend Status**: Run `./scripts/smoke_test.sh`. If the backend is down, run `./scripts/restart_server.sh`.
2. **Check Browser Overload**: If the backend is running but the browser is freezing, the MJPEG stream or WebSocket telemetry may be too heavy. Run `./scripts/check_bandwidth.sh` and `./scripts/check_fps.py` to diagnose.
3. **Restart the App**: If all else fails, use `./scripts/start_app.sh` to restart both the backend and frontend.
