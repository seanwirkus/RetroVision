# AGENT_ASSIGNMENTS

Four agents improve this driving-vision HUD in small, non-overlapping passes.
**Rule: read this + AGENT_LOG.md + VISION_TELEMETRY_SCHEMA.md before editing. Edit only your files. Log every change.**

## Two codebases, one contract
This app spans two directories. The **contract** between them is the WebSocket JSON
(`ws://<host>:8766/ws`) + the MJPEG stream (`http://<host>:8766/video_feed`).

| Side | Path | Key files |
|------|------|-----------|
| **Backend** (vision) | `/Users/sean/Desktop/RetroView Ultra/vision-lab/` | `yolo_server.py`, `distance.py` |
| **Frontend** (HUD) | `/Users/sean/Documents/RasberryPi/web/` | `dashboard.js`, `config.js`, `index.html`, `style.css` |
| **Coordination** | `/Users/sean/Documents/RasberryPi/` | the `*.md` docs below |

Models live in vision-lab: `yolov8n.pt`, `traffic-light-detection.pt`, `carparts-seg.pt`, `lpr-v1.pt`.

## Ownership

### CLAUDE — architect / reviewer / planner / QC
Edits: `AGENT_ASSIGNMENTS.md`, `AGENT_LOG.md`, `ROADMAP.md`, `VISION_TELEMETRY_SCHEMA.md`, `TEST_PLAN.md`, `README.md`.
**Does NOT** edit `yolo_server.py` or `dashboard.js` unless explicitly asked.

### CODEX — backend vision pipeline
Edits: `yolo_server.py`, `distance.py`, backend vision/OCR/tracking/lane modules, backend tests.
**Does NOT** edit `dashboard.js`, CSS/HTML (may read for the schema only).

### CURSOR — frontend HUD
Edits: `web/dashboard.js`, `web/style.css`, `web/index.html`, `web/config.js`, frontend render utils.
**Does NOT** edit `yolo_server.py` (read telemetry shape only).

### ANTIGRAVITY — integration / testing / dev workflow
Edits: `scripts/`, `tests/`, launch/env files, health-check + perf scripts, README run/dev sections, watchdog/restart helpers.
**Does NOT** edit `yolo_server.py` or `dashboard.js` unless assigned a specific bug.

All agents: may **read** everything; must not **edit** unowned files; must log changes.

## Schema-change protocol
A telemetry field change is a contract change. **Update `VISION_TELEMETRY_SCHEMA.md` first**
(Claude approves), then Codex emits, then Cursor consumes. Changes must be **additive +
backward-compatible** so the running app never breaks mid-migration.

## Run state (as of PASS 0)
Backend launched from vision-lab: `VISION_SOURCE=window WINDOW_MATCH=YouTube python3 yolo_server.py`.
Frontend served from `web/`: `python3 -m http.server 8000`. Open `http://localhost:8000/?visionHost=localhost`.
No git repo in RasberryPi — coordinate via these docs, not commits.
