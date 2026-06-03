"""Monocular distance + lateral offset from YOLO boxes (pinhole + class height)."""
import math

# Wide dashcam FOV — narrower values squash edge/oncoming cars toward centre.
CAMERA_H_FOV_DEG = 100.0
CAMERA_HEIGHT_FT = 2.2
MIN_HUD_RANGE_FT = 7.0
MAX_HUD_RANGE_FT = 160.0   # let far traffic spread in depth instead of piling at 48

# Real-world heights in feet for pinhole depth (width used as fallback)
CLASS_HEIGHT_FT = {
    "person": 5.6,
    "bicycle": 4.5,
    "car": 4.5,
    "motorcycle": 4.0,
    "bus": 10.0,
    "truck": 8.0,
    "traffic light": 8.0,
    "stop sign": 7.0,
    "fire hydrant": 3.0,
    "parking meter": 4.5,
    "bench": 3.0,
    "suitcase": 2.5,
    "backpack": 2.5,
    "handbag": 2.0,
    "skateboard": 1.5,
}


def focal_length_px(image_width: float, h_fov_deg: float = CAMERA_H_FOV_DEG) -> float:
    half = math.radians(h_fov_deg * 0.5)
    return (image_width * 0.5) / max(math.tan(half), 0.01)


def estimate_range_ft(
    bbox_xyxy,
    image_width: float,
    image_height: float,
    coco_class: str,
) -> float:
    """Range along the road (feet) from bbox size + ground contact."""
    x1, y1, x2, y2 = bbox_xyxy
    box_h = max(float(y2 - y1), 8.0)
    box_w = max(float(x2 - x1), 8.0)
    cls = (coco_class or "person").lower().strip()

    real_h = CLASS_HEIGHT_FT.get(cls, 5.0)
    # Some classes are wider than tall — use the larger cue
    real_w = real_h * 0.55
    f_px = focal_length_px(image_width)

    dist_by_h = (f_px * real_h) / box_h
    dist_by_w = (f_px * real_w) / box_w
    dist_pinhole = 0.65 * dist_by_h + 0.35 * dist_by_w

    # Objects lower in the frame are usually closer (dash cam / webcam)
    bottom_frac = float(y2) / max(image_height, 1.0)
    horizon_frac = 0.38
    if bottom_frac > horizon_frac + 0.05:
        ground_hint = CAMERA_HEIGHT_FT / max(0.08, bottom_frac - horizon_frac)
        ground_hint = min(ground_hint, 150.0)
        dist_pinhole = 0.55 * dist_pinhole + 0.45 * ground_hint

    return float(max(MIN_HUD_RANGE_FT, min(MAX_HUD_RANGE_FT, dist_pinhole)))


def estimate_lateral_ft(
    bbox_xyxy,
    image_width: float,
    range_ft: float,
    h_fov_deg: float = CAMERA_H_FOV_DEG,
) -> float:
    x1, y1, x2, y2 = bbox_xyxy
    cx = (x1 + x2) * 0.5
    f_px = focal_length_px(image_width, h_fov_deg)
    x_norm = (cx - image_width * 0.5) / f_px
    return float(max(-30.0, min(30.0, x_norm * range_ft)))


def clamp_hud_range_ft(range_ft: float) -> float:
    return float(max(MIN_HUD_RANGE_FT, min(MAX_HUD_RANGE_FT, range_ft)))
