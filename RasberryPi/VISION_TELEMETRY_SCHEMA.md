# VISION_TELEMETRY_SCHEMA

The contract between backend (`yolo_server.py`) and frontend (`dashboard.js`).
Transport: `ws://<host>:8766/ws` (JSON, ~30/s) + `http://<host>:8766/video_feed` (MJPEG).

**Migration rule:** additive + backward-compatible only. Frontend MUST tolerate missing/null
fields. Bump `v` when the target shape lands. Update THIS file before changing emit/consume code.

---

## v1 — CURRENT (live, verified)

```jsonc
{
  "speedMps": 0.0,             // serial-bridge telemetry; 0 when no Pi connected
  "lidarDistM": null,          // number | null
  "camera": { "width": 1800, "height": 2160 },   // captured frame px (varies w/ window)
  "detections": [
    {
      "id": "T5" ,             // "T<tid>" if tracked, else "CLASS:x:y"
      "tid": 5,                // ByteTrack id. ⚠ CURRENTLY NULL for some cars (gap, see below)
      "class": "CAR",          // CAR TRUCK BUS PEDESTRIAN BICYCLE MOTORCYCLE TRAFFIC_LIGHT STOP_SIGN HYDRANT PARKING_METER BENCH OBSTACLE
      "coco": "car",
      "xRelM": 9.9,            // lateral. ⚠ name says M, value is FEET
      "yRelM": 36.1,           // range, FEET
      "distM": 36.1,           // == yRelM (FEET)
      "conf": 0.67,            // 0..1
      "bbox": [1061.5, 947.7, 1154.0, 1006.4],   // [x1,y1,x2,y2] full-frame px
      "orient": "rear",        // OPTIONAL, vehicles only: "front" | "rear" (carparts-seg)
      "state": "RED",          // OPTIONAL, traffic lights only: RED|YELLOW|GREEN
      "plate": "ABC123"        // OPTIONAL, vehicles: bare string, sticky-by-tid + voted
    }
  ],
  "lanes": {                   // | null when nothing detected
    "left":  [[-183.1, 2008.1], [1064.6, 905.6]],   // ⚠ can extrapolate off-frame (negative x)
    "right": [[1929.4, 2008.1], [797.5, 905.6]]      // [[x_near,y_near],[x_far,y_far]] full-frame px
  }
}
```

### Known v1 gaps (the migration targets)
1. **`tid` null** — ByteTrack returns no id for some boxes → breaks "track-id as source of truth" for plate/orient stickiness. Codex: ensure a stable id always (fallback id if tracker drops).
2. **`lanes` no confidence / no `center` / no `source`** — frontend can't fade to fallback intelligently.
3. **Lane points unclamped** — extrapolate past frame edges (`x=-183`, `x=2243`). Clamp to `[0,width]`.
4. **`plate` is a bare string** — no confidence/age → frontend can't threshold display.
5. **`xRelM`/`distM` misnamed** (feet, not meters). Keep names for compat; document only.

---

## v2 — TARGET (migrate toward, additive)

```jsonc
{
  "v": 2,
  "ts": 1730000000.0,
  "fps": 28.0,
  "stale": false,
  "camera": { "width": 1800, "height": 2160 },
  "detections": [
    {
      "id": "T5", "tid": 5,            // tid NEVER null
      "class": "CAR", "conf": 0.67,
      "distance_ft": 36.1, "lateral_ft": 9.9,
      "bbox": [1061,947,1154,1006],
      "cx": 0.61, "cy": 0.45,          // normalized 0..1 (resolution-independent)
      "orientation": "rear",           // front|rear|unknown
      "age_ms": 1200, "last_seen_ms": 0,
      "vx": -0.2, "vy": 1.1,           // smoothed velocity (ft/s) for prediction/warnings
      "plate": { "text": "ABC123", "confidence": 0.82, "age_ms": 900, "track_id": 5 }
    }
  ],
  "lanes": {
    "source": "vision",              // "vision" | "fallback" | "none"
    "confidence": 0.74,              // 0..1 — frontend fades to fallback when low
    "left":   [[x,y],[x,y]],         // clamped to frame
    "right":  [[x,y],[x,y]],
    "center": [[x,y],[x,y]]          // derived midline (lane-departure logic)
  }
}
```

Keep v1 fields alongside v2 during migration (e.g. emit both `distM` and `distance_ft`,
`plate` string AND object) until Cursor confirms consumption, then drop v1.
