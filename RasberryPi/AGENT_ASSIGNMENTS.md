# AGENT_ASSIGNMENTS

Four agents improve this driving-vision HUD in small, non-overlapping passes.
**Rule: read this + AGENT_LOG.md + VISION_TELEMETRY_SCHEMA.md before editing. Edit only your files. Log every change.**

## Two codebases, one contract (RetroVision monorepo)
This app spans two directories in **RetroVision**. The **contract** is WebSocket JSON
(`ws://<host>:8766/ws`) + MJPEG (`http://<host>:8766/video_feed`).

| Side | Path | Key files |
|------|------|-----------|
| **Backend** (vision) | `Vision Lab/` | `yolo_server.py`, `distance.py` |
| **Frontend** (HUD) | `RasberryPi/web/` | `dashboard.js`, `config.js`, `index.html`, `style.css` |
| **Coordination** | `RasberryPi/` | `AGENT_*.md`, `ROADMAP.md`, `VISION_TELEMETRY_SCHEMA.md`, `TEST_PLAN.md` |

Models live in `Vision Lab/`: `yolov8n.pt`, `traffic-light-detection.pt`, `carparts-seg.pt`, `lpr-v1.pt`.

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
Edits: repo-root `scripts/` (start, smoke, health checks), `tests/`, root `README.md` run/dev sections,
`RasberryPi/scripts/` (Pi kiosk/deploy only). **Does NOT** edit `yolo_server.py` or `dashboard.js`
unless assigned a specific bug.

All agents: may **read** everything; must not **edit** unowned files; must log changes.

## Schema-change protocol
A telemetry field change is a contract change. **Claude owns** `VISION_TELEMETRY_SCHEMA.md`,
`ROADMAP.md`, and assignment docs unless explicitly delegated. **Update the schema first**, then
Codex emits, then Cursor consumes. **Antigravity** owns integration/scripts only — not schema or
vision logic. Changes must be **additive + backward-compatible** so the running app never breaks
mid-migration.

## Run state (dev)
```bash
# from repo root — starts backend + HUD (see scripts/start_app.sh)
./scripts/start_app.sh

# health check (backend must be running)
./scripts/smoke_test.sh
# open http://localhost:8000/?visionHost=127.0.0.1
```
Git repo: **RetroVision** (root). Coordinate via these docs + `AGENT_LOG.md` append-only entries.
