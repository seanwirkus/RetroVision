# AGENT_LOG

Append-only. Newest on top. Format: `## [date] AGENT — PASS — title`, then Changed / Tested / Remaining.

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
