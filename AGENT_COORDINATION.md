# Multi-agent coordination (RetroVision)

Four agents (Claude, Codex, Cursor, Antigravity) improve the driving-vision HUD in **small, non-overlapping passes**.

**Before any edit:** read these files under `RasberryPi/`:

| File | Purpose |
|------|---------|
| [AGENT_ASSIGNMENTS.md](RasberryPi/AGENT_ASSIGNMENTS.md) | Who owns which files |
| [AGENT_LOG.md](RasberryPi/AGENT_LOG.md) | Append-only change log |
| [VISION_TELEMETRY_SCHEMA.md](RasberryPi/VISION_TELEMETRY_SCHEMA.md) | WebSocket + MJPEG contract |
| [ROADMAP.md](RasberryPi/ROADMAP.md) | Slow passes (PASS 0–10) |
| [TEST_PLAN.md](RasberryPi/TEST_PLAN.md) | How to verify each pass |

**Code layout**

- Backend: `Vision Lab/yolo_server.py` — YOLO, ByteTrack, lanes, OCR (`:8766`)
- Frontend: `RasberryPi/web/dashboard.js` — HUD render (reads telemetry only)
- Dev workflow: `./scripts/start_app.sh`, `./scripts/smoke_test.sh` (Antigravity PASS 0 ✅)

**One-line rule:** Do not make it flashier until it is more correct, more stable, and less cluttered.

Paste the role-specific prompts from your master doc into each tool; each agent logs in `AGENT_LOG.md` and stops after one pass.
