# RetroVision

RetroVision is a driving-vision dashboard app designed to provide a Tesla-style driver assistance HUD. It features MJPEG streaming, YOLO detections, ByteTrack IDs, plate OCR, and lane detection.

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
