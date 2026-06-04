# AGENT_LOG

Append-only. Newest on top. Format: `## [date] AGENT — PASS — title`, then Changed / Tested / Remaining.

---

## 2026-06-03 CURSOR — PASS 3 — Consume v2 lane telemetry
**Changed:** `web/dashboard.js` — reads `lanes.confidence`, `source`, `center`; EMA-smooth center;
draw center as subtle dashed midline; blend/fallback uses v2 confidence; lanes render without
camera PiP; fade synthetic `drawRoad`/`drawEgoPath` when vision lanes strong; track keys prefer
`T{tid}`; `orientation` + `distance_ft`; status chip shows `lanes NN%`; honors `d.stale` / `d.fps`.
**Tested:** `node --check`; live WS (`v:2`, `confidence:1.0`, `source:vision`, clamped center).
**Remaining:** Plate badge still v1 string (Pass 7). Hard-reload dashboard to pick up JS.

---

## 2026-06-03 ANTIGRAVITY — PASS 9 — Performance Budgets
**Changed:** `scripts/check_bandwidth.sh` (fails if MJPEG > 3000 KB/s), `scripts/check_fps.py` (fails if telemetry < 15 FPS), `scripts/smoke_test.sh` (added HTTP probe for `localhost:8000`; cascades failure if any perf check fails).
**Tested:** Ran `./scripts/smoke_test.sh` — verified strict exiting logic. Everything passed (bandwidth ~600 KB/s, FPS ~30.6). HTTP probe gracefully warned the frontend was down, as expected.

## 2026-06-03 ANTIGRAVITY — Smoke Test Post-Codex
**Tested:** Restarted backend (`./scripts/restart_server.sh`) to apply Codex Pass 1/2 changes. Ran `./scripts/smoke_test.sh`.
**Results:** All health checks passed. Backend successfully restarted, MJPEG streaming is active, WebSocket emitting detections/lanes properly, ~30 FPS, bandwidth is healthy.
**Next:** Cursor Pass 3 (consume lane confidence, fade to fallback).

---

## 2026-06-03 CODEX — PASS 1/2 — Additive v2 backend telemetry
**Changed:** `Vision Lab/yolo_server.py` — added v2 top-level telemetry (`v`, `ts`, `fps`,
`stale`); stable integer `tid` fallback when ByteTrack returns `None`; normalized `cx`/`cy`,
`distance_ft`, `lateral_ft`, `age_ms`, `last_seen_ms`, smoothed `vx`/`vy`, and
`orientation` alongside existing v1 fields. Lane detection now emits clamped `left`/`right`,
`center`, `confidence`, per-side confidence, and `source:"vision"` while still returning `null`
when no real lane is present so the frontend fallback remains compatible.
**Tested:** `python3 -m py_compile 'Vision Lab/yolo_server.py' 'Vision Lab/distance.py'`;
focused helper validation for fallback IDs, v2 detection enrichment, and synthetic lane detection
with all lane points clamped inside frame bounds; existing live server health probes passed
(`python3 scripts/check_ws.py`, `bash scripts/check_mjpeg.sh`).
**Remaining:** running `:8766` server was already active before this patch, so live WebSocket v2
fields require a backend restart to verify end-to-end. Plate telemetry remains the v1 bare string
for frontend compatibility; Pass 6 should add a non-breaking confidence/age object after schema
confirmation.

---

## 2026-06-03 ANTIGRAVITY — PASS 0 — Dev workflow + smoke tests
**Changed:** repo-root `scripts/` — `start_app.sh`, `restart_server.sh`, `check_mjpeg.sh`,
`check_ws.py`, `check_fps.py`, `check_bandwidth.sh`, `smoke_test.sh`; root `README.md` (run,
reload, test, agent ownership, VISION STALE). Walkthrough in Antigravity brain artifact.
**Tested:** `./scripts/smoke_test.sh` — backend up, WS detections+lanes, ~30 FPS telemetry,
healthy MJPEG bandwidth.
**Remaining:** `start_app.sh` served from repo root (not `RasberryPi/web`) — **Cursor fix**
below. Pi deploy scripts stay in `RasberryPi/scripts/` (separate from dev `scripts/`).
**Next:** Codex Pass 1/2; Claude refresh schema if v2 lands; Antigravity Pass 9 perf scripts.

---

## 2026-06-03 CURSOR — PASS 0 follow-up — start_app web root
**Changed:** `scripts/start_app.sh` — HTTP server now runs from `RasberryPi/web/` so the cluster
HUD loads (was serving RetroVision repo listing).
**Tested:** shell syntax only (no full stack start in this pass).

---

## 2026-06-03 CURSOR — PASS 3 — Lane blend + EMA smooth (frontend)
**Changed:** `web/dashboard.js` — EMA-smooth lane endpoints; blend vision lanes over synthetic
`drawRoad` by confidence; muted/dashed style when `lanes.confidence` low or `source=fallback`;
removed dead `drawEgo()`. `AGENT_ASSIGNMENTS.md` / `TEST_PLAN.md` paths → RetroVision repo.
**Tested:** `node --check RasberryPi/web/dashboard.js` (run from repo root).
**Remaining:** Backend still v1 lanes (no `confidence`/`source`/`center`) → heuristic conf ~0.55
when both sides present. **Codex Pass 2** should emit real confidence + clamp points. Plate badge
still shows v1 bare string (no threshold until Pass 6/7).

---

## 2026-06-03 CLAUDE — PASS 0 — Coordination docs + schema capture
**Changed:** created `AGENT_ASSIGNMENTS.md`, `VISION_TELEMETRY_SCHEMA.md`, `ROADMAP.md`,
`TEST_PLAN.md`, `AGENT_LOG.md`. No app code touched (architect role).
**Tested:** captured live WS schema from running backend (:8766) — documented as v1 truth.
Backend up, WS emitting detections + lanes, MJPEG ~1.6 MB/s.
**Remaining / risky areas (handoff):**
- `tid` is **null** for some detections (sample: `CAR tid:null`). Breaks track-id-as-truth for
  plate/orient. → **Codex Pass 4**.
- `lanes` lack `confidence`/`center`/`source`; points extrapolate **off-frame** (`x=-183`,`x=1929`
  near-edge, far x ok). → **Codex Pass 2** (clamp + confidence), **Cursor Pass 3** (fade/fallback).
- `plate` is a bare string (no confidence/age) → frontend can't threshold. → **Codex Pass 6 / schema v2**.
- Capture window is letterboxed (video mid-frame, YouTube UI below) → lane ROI widened to 0.42–0.93;
  **fullscreen the video (`f`)** for clean road. Document in README (Antigravity).
**Next agent:** Codex → Pass 1 (lock v2 emit additively: `tid` never null, lane `confidence`+`source`+clamp).
Then Cursor → Pass 3 (consume lane confidence, fade to fallback).

---

## Pre-PASS-0 BASELINE (work already in tree, this session — for reference)
Backend `yolo_server.py` (vision-lab): window-capture source (`VISION_SOURCE=window`, Quartz, skips
dashboard window); 4 models — yolov8n + ByteTrack `.track()`, traffic-light-detection.pt (state, gated
conf 0.55 + high-in-frame), carparts-seg.pt (orientation front/rear on upscaled crops), lpr-v1.pt +
EasyOCR (sticky-by-tid temporal **vote**, sharpness gate); detection gates (CONF_MIN, PED_CONF_MIN,
HORIZON_FRAC); MJPEG **downscaled 720px/q60** (fixed VISION STALE firehose); `distance.py` FOV 100°,
range 160ft, lateral ±30; classical-CV **lane detection** (Canny+Hough ROI, EMA).
Frontend `web/`: EMA track smoothing + fade; **3D extruded cars** (roof/flank shading, size-capped,
orientation lights); plate badge; lane render; ego car **removed**; video bg at 10% opacity; shift-light
+ redline; bigger gauges.
Known-good: VISION LIVE, lanes 50/50 frames, tracking holds (id stable 44 frames when assigned).
