/**
 * YOLO COCO → RetroVision HUD taxonomy (vehicle + road set).
 * Shared contract for yolo_server.py — keep cocoToProp in sync.
 */
(function (global) {
  /** @type {Record<string, string>} COCO label → HUD wire class name */
  const COCO_TO_HUD = {
    person: 'PEDESTRIAN',
    bicycle: 'BICYCLE',
    car: 'CAR',
    motorcycle: 'MOTORCYCLE',
    bus: 'BUS',
    truck: 'TRUCK',
    'traffic light': 'TRAFFIC_LIGHT',
    'stop sign': 'STOP_SIGN',
    'fire hydrant': 'HYDRANT',
    'parking meter': 'PARKING_METER',
    bench: 'BENCH',
    suitcase: 'OBSTACLE',
    backpack: 'OBSTACLE',
    handbag: 'OBSTACLE',
    skateboard: 'BICYCLE',
    'motor scooter': 'MOTORCYCLE',
  };

  /** HUD wire name → simulator prop key used by drawHudProp */
  const HUD_TO_PROP = {
    CAR: 'car',
    TRUCK: 'truck',
    BUS: 'bus',
    MOTORCYCLE: 'moto',
    BICYCLE: 'bike',
    PEDESTRIAN: 'ped',
    STOP_SIGN: 'stop',
    TRAFFIC_LIGHT: 'light',
    HYDRANT: 'hydrant',
    PARKING_METER: 'meter',
    BENCH: 'bench',
    OBSTACLE: 'obstacle',
  };

  /** Per-prop metadata (colors align with HUD legend) */
  const PROP_META = {
    car: { name: 'CAR', color: '#22d3ee' },
    truck: { name: 'TRUCK', color: '#38bdf8' },
    bus: { name: 'BUS', color: '#fbbf24' },
    moto: { name: 'MOTORCYCLE', color: '#fb923c' },
    bike: { name: 'BICYCLE', color: '#4ade80' },
    ped: { name: 'PEDESTRIAN', color: '#a78bfa' },
    stop: { name: 'STOP_SIGN', color: '#f43f5e' },
    light: { name: 'TRAFFIC_LIGHT', color: '#facc15' },
    hydrant: { name: 'HYDRANT', color: '#f472b6' },
    meter: { name: 'PARKING_METER', color: '#94a3b8' },
    bench: { name: 'BENCH', color: '#cbd5e1' },
    obstacle: { name: 'OBSTACLE', color: '#e879f9' },
  };

  const VEHICLE_PROPS = new Set(['car', 'truck', 'bus', 'moto', 'bike']);

  // Must stay above -(WORLD.cameraOffsetM) + margin or hudProject clips off-screen
  const MIN_HUD_RANGE_FT = 7;
  const MAX_HUD_RANGE_FT = 48;
  const smoothState = new Map();

  function clampHudRangeFt(ft) {
    return Math.max(MIN_HUD_RANGE_FT, Math.min(MAX_HUD_RANGE_FT, ft));
  }

  function cocoToHudClass(cocoName) {
    if (!cocoName) return null;
    const key = String(cocoName).toLowerCase().trim();
    return COCO_TO_HUD[key] || null;
  }

  function hudToPropType(hudClass) {
    return HUD_TO_PROP[hudClass] || null;
  }

  function smoothValue(key, next, alpha = 0.38) {
    const prev = smoothState.get(key);
    if (prev == null) {
      smoothState.set(key, next);
      return next;
    }
    const blended = prev + (next - prev) * alpha;
    smoothState.set(key, blended);
    return blended;
  }

  function mapDetection(d) {
    let wireClass = d.class;
    if (!wireClass || !HUD_TO_PROP[wireClass]) {
      wireClass = cocoToHudClass(d.coco || d.class);
    }
    if (!wireClass || !HUD_TO_PROP[wireClass]) wireClass = 'CAR';
    const propType = HUD_TO_PROP[wireClass] || 'car';
    const meta = PROP_META[propType] || PROP_META.car;

    const rawDist = Number(d.distM ?? d.yRelM ?? 20);
    const rawX = Number(d.xRelM ?? 0);
    const trackKey = d.id || `${wireClass}:${Math.round(rawX)}`;
    const rangeFt = smoothValue(`${trackKey}:y`, clampHudRangeFt(rawDist));
    const xRelM = smoothValue(`${trackKey}:x`, rawX);

    return {
      id: trackKey,
      prop: { type: propType, xM: xRelM, yM: rangeFt },
      class: meta.name,
      color: meta.color,
      distM: rangeFt,
      xRelM,
      yRelM: rangeFt,
      conf: d.conf ?? 1.0,
      rawDistM: rawDist,
    };
  }

  function resetSmoothing() {
    smoothState.clear();
  }

  function isVehicleProp(type) {
    return VEHICLE_PROPS.has(type);
  }

  /** Export list for Python server (window.YoloVision.exportCocoMap()) */
  function exportCocoMap() {
    return { ...COCO_TO_HUD };
  }

  global.YoloVision = {
    COCO_TO_HUD,
    HUD_TO_PROP,
    PROP_META,
    VEHICLE_PROPS,
    cocoToHudClass,
    hudToPropType,
    mapDetection,
    resetSmoothing,
    clampHudRangeFt,
    isVehicleProp,
    exportCocoMap,
  };
})(typeof window !== 'undefined' ? window : globalThis);
