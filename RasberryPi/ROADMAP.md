# ROADMAP — driving-vision HUD

Slow passes. One focused improvement each, tested, logged. **Correct + stable + uncluttered
before flashy.** Status: ✅ done · 🔄 in progress · ⬜ todo.

| Pass | Owner | Goal | Status |
|------|-------|------|--------|
| **0** Freeze + document | Claude + Antigravity | Ownership docs, schema capture, smoke tests, app starts | ✅ |
| **1** Telemetry contract | Claude + Codex | Lock v1→v2 schema; backend emits consistently; no visual change | ⬜ |
| **2** Real lane detection | Codex | Lanes from video frames; emit left/right/center + `confidence` + `source`; clamp to frame; fallback only when low | 🔄 (Canny+Hough live, no confidence/center yet) |
| **3** Frontend lane render | Cursor | Render backend lanes; smooth; fade vision↔fallback; fallback visually distinct | ✅ |
| **4** Object tracking polish | Codex | Stable `tid` (never null); add `age_ms`, `vx/vy`, `last_seen`; less flicker | ⬜ (tid null gap) |
| **5** 3D car polish | Cursor | Premium 3D cars, capped size, far-fade, no clutter, no ego car | ✅ baseline (extruded 3D, size-capped, ego removed) — refine |
| **6** Plate OCR ×10 | Codex | Stronger temporal voting; better crop; tid-bound memory; confidence threshold; no flicker | ✅ baseline (vote-by-tid, sharpness gate) — add confidence/age to schema |
| **7** Plate frontend | Cursor | Badge only above confidence; attached to track; subtle | 🔄 (badge exists; needs confidence gate from v2) |
| **8** Warning logic | Codex + Cursor | Following-distance + lane-departure (high-confidence only); red/yellow/blue, no spam | ⬜ (FCW exists; no lane-departure) |
| **9** Performance hardening | Antigravity + Codex + Cursor | Measure bandwidth + FPS; no browser starvation; no backend overload | 🔄 (MJPEG downscaled 720/q60 fixed STALE) |
| **10** Final Tesla-style polish | Claude + Cursor | Premium feel, minimal text, clean hierarchy, demo checklist | ⬜ |

## Locked design decisions
- Lanes come from **video**; synthetic lanes are **fallback only** (visually distinct, low-confidence).
- **No ego car.** Ever.
- Cars **size-capped** — never screen-filling. Far objects fade. Labels minimal (near only).
- **Track id = source of truth** for a vehicle + its plate. Fix the null-tid gap (Pass 4).
- Plates show **only above a confidence threshold**, bound to the track, no flicker.
- Confidence + smoothing over instant flickery detections.
- Low browser load + low MJPEG bandwidth are hard requirements (regression = bug).

## Sequencing note
Pass 1 (schema lock) gates Passes 2–8. Codex emits v2 fields **additively**; Cursor consumes
once present; neither breaks v1 while migrating.
