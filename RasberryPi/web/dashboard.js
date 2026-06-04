/* WRX cluster engine.
 * - Telemetry from serial_bridge.py (/ws on this host): speed, rpm, fuel, temp, lights.
 * - Optional off-Pi detections from VisionLab yolo_server.py (CFG.VISION_WS).
 * - Renders ImprezaUI-style ring gauges + a VisionLab-style perception HUD.
 * The Pi 3B+ only RENDERS; no ML runs here. */
'use strict';

const CFG = window.CLUSTER_CONFIG;
const { BASE_W, BASE_H, TACH_REDLINE, TACH_MAX, SPEED_MAX } = CFG;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const $ = id => document.getElementById(id);

/* ---------------- stage scaling (fit 1920x440 to the panel) ---------------- */
const stage = $('stage');
let stageScale = 1;

/* ---- clean / recording mode ----
 * ?clean=1 (or ?feed) hides the gauges, status bar and bezel and lets the
 * perception video fill the whole window — so a screen-recording crop is just
 * the video, at whatever aspect you resize the window to. Toggle live with "c". */
function isClean() { return document.body.classList.contains('clean'); }
(function initCleanMode() {
  const qp = new URLSearchParams(location.search);
  if (qp.get('clean') === '1' || qp.has('feed')) document.body.classList.add('clean');
})();
window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') {
    document.body.classList.toggle('clean');
    fit();
  }
});

/* LITE profile — Raspberry Pi 3B+ / low-power kiosk. Drops the heavy canvas work
 * (per-frame gradients, occluder clip), caps the render rate, and disables CSS
 * filters. Force with ?lite=1 / ?lite=0; otherwise auto-detect a Pi-class device. */
const LITE = (() => {
  const qp = new URLSearchParams(location.search);
  if (qp.get('lite') === '1') return true;
  if (qp.get('lite') === '0') return false;
  const dm = navigator.deviceMemory || 8;
  const hc = navigator.hardwareConcurrency || 8;
  return dm <= 2 && hc <= 4;   // ~Pi 3B+ (1GB, 4 cores)
})();
if (LITE) document.body.classList.add('lite');

function fit() {
  if (isClean()) {
    // panel fills the window via CSS; no 1920x440 letterbox scaling.
    stageScale = 1;
    stage.style.transform = 'none';
    resizeCanvas();
    return;
  }
  stageScale = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
  stage.style.transform = `translate(-50%,-50%) scale(${stageScale})`;
  resizeCanvas();
}

/* ---------------- SVG ring gauges ---------------- */
// 270deg sweep, 90deg gap at the bottom. Needle traces 7:30 -> top -> 4:30.
const RR = 82, CC = 100, RCIRC = 2 * Math.PI * RR, ARC = 0.75 * RCIRC;
const polar = (deg, r = RR) => {           // deg measured clockwise from 12 o'clock
  const a = (deg * Math.PI) / 180;
  return [CC + r * Math.sin(a), CC - r * Math.cos(a)];
};
function ringTicks(n, redlineFrac) {
  let s = '';
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const [x1, y1] = polar(225 + f * 270, RR + 3);
    const [x2, y2] = polar(225 + f * 270, RR - (i % (n / 5 | 0) === 0 ? 11 : 6));
    const hot = redlineFrac != null && f >= redlineFrac;
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hot ? '#ff5252' : '#3a4450'}" stroke-width="${hot ? 3 : 2}" stroke-linecap="round"/>`;
  }
  return s;
}
function makeRing(container, { grad0, grad1, redlineFrac = null, ticks = 40 }) {
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  const svg = `
    <svg viewBox="0 0 200 200">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="${grad0}"/><stop offset="1" stop-color="${grad1}"/>
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="${RR}" fill="none" stroke="var(--track)" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${ARC} ${RCIRC}" transform="rotate(135 100 100)"/>
      <circle class="val" cx="100" cy="100" r="${RR}" fill="none" stroke="url(#${gid})" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="0 ${RCIRC}" transform="rotate(135 100 100)"/>
      <g>${ringTicks(ticks, redlineFrac)}</g>
    </svg>`;
  container.insertAdjacentHTML('afterbegin', svg);
  const val = container.querySelector('.val');
  return {
    set(frac) {
      frac = clamp(frac, 0, 1);
      val.setAttribute('stroke-dasharray', `${frac * ARC} ${RCIRC}`);
    },
  };
}

/* mini gauges */
const mR = 70, mC = 100, mCIRC = 2 * Math.PI * mR, mARC = 0.75 * mCIRC;
function makeMini(host, name) {
  const el = document.createElement('div');
  el.className = 'gauge';
  el.innerHTML = `
    <svg viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="${mR}" fill="none" stroke="var(--track)" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${mARC} ${mCIRC}" transform="rotate(135 100 100)"/>
      <circle class="v" cx="100" cy="100" r="${mR}" fill="none" stroke="var(--green-soft)" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="0 ${mCIRC}" transform="rotate(135 100 100)"/>
    </svg>
    <div class="gval">—</div><div class="gname">${name}</div>`;
  host.appendChild(el);
  const v = el.querySelector('.v'), txt = el.querySelector('.gval');
  return {
    set(frac, color, label) {
      frac = clamp(frac, 0, 1);
      v.setAttribute('stroke-dasharray', `${frac * mARC} ${mCIRC}`);
      if (color) v.setAttribute('stroke', color);
      if (label != null) txt.textContent = label;
    },
  };
}

const RED = '#ff4d4d', AMB = '#ffb020', GRN = 'var(--green-soft)';
const speedRing = makeRing($('speedRing'), { grad0: '#0a8f2a', grad1: '#00ff20' });
const rpmRing = makeRing($('rpmRing'), { grad0: '#7a1010', grad1: '#ff2a2a', redlineFrac: TACH_REDLINE / TACH_MAX });

// left minis: coolant, fuel ; right minis: range, humidity
const coolant = makeMini($('minisL'), 'Coolant');
const fuelMini = makeMini($('minisL'), 'Fuel');
const rangeMini = makeMini($('minisR'), 'Range');
const humid = makeMini($('minisR'), 'Humid');

/* ---------------- DOM refs ---------------- */
const elSpeed = $('speed'), elRpm = $('rpm'), elGear = $('gear');
const elSpeedBar = $('speedBar'), elRpmBar = $('rpmBar');
const elTurnL = $('turnL'), elTurnR = $('turnR');
const elTells = [...document.querySelectorAll('.tell')];
const elLinkDot = $('linkDot'), elLinkText = $('linkText'), elClock = $('clock');
const elSeq = $('seqText'), elVisStat = $('visStat');
const elFcw = $('fcw'), elFcwState = $('fcwState'), elFcwReason = $('fcwReason');
const elVsrc = $('vsrc'), elVsrcDot = $('vsrcDot'), elVsrcText = $('vsrcText');
const camFeed = $('camFeed'), camTag = $('camTag');

/* sequential shift-light LEDs across the tach (green → yellow → red toward redline) */
const rpmRingEl = $('rpmRing');
const shiftbar = $('shiftbar');
const SHIFT_LEDS = 10;
const shiftLeds = [];
for (let i = 0; i < SHIFT_LEDS; i++) {
  const f = i / (SHIFT_LEDS - 1);
  const led = document.createElement('div');
  led.className = 'led ' + (f < 0.6 ? 'g' : f < 0.85 ? 'y' : 'r');
  shiftbar.appendChild(led);
  shiftLeds.push(led);
}

/* ---------------- telemetry state ---------------- */
const target = {
  rpm: 0, mph: 0, fuelPct: 0, tempC: null, humidity: null, distanceCm: null,
  lights: {}, status: {}, seq: 0, link: 'stale',
};
const shown = { mph: 0, rpm: 0 };

/* vision state: list of detections + freshness */
const VISION_HOSTS = (Array.isArray(CFG.VISION_HOSTS) && CFG.VISION_HOSTS.length)
  ? CFG.VISION_HOSTS
  : (CFG.VISION_HOST ? [CFG.VISION_HOST] : []);
const vision = {
  dets: [], tracks: new Map(), lastRx: 0, fps: 0, backendFps: 0,
  configured: VISION_HOSTS.length > 0, host: null, packetStale: false,
  laneConf: null, laneSource: null, schemaV: null,
};

/* Lane display: EMA-smooth backend points; blend vision ↔ synthetic fallback. */
const LANE_PT_EMA = 0.38;
const LANE_BLEND_SPEED = 0.14;
const LANE_CONF_SHOW = 0.45;
const LANE_CONF_STRONG = 0.62;
let laneSmooth = { left: null, right: null, center: null };
let laneBlend = 0;
let horizonHold = null;   // sticky lane vanishing-point Y (camera px) for the horizon

/* ---------------- object tracking + smoothing (the Tesla glide) ----------------
 * Server emits a stable id per object (ByteTrack). We EMA-smooth each track's
 * lateral/range so cars slide instead of teleporting, fade in on appear, and
 * linger+fade for a moment on loss instead of popping out. */
const TRACK_ALPHA = 0.3;     // position smoothing (lower = smoother/laggier)
const TRACK_TTL_MS = 600;    // keep a vanished track this long while it fades
function updateTracks(raw, now) {
  const tr = vision.tracks, seen = new Set();
  for (const o of raw) {
    const key = o.id || (o.tid != null ? `T${o.tid}` : `${o.cls}:${Math.round(o.xRelM || 0)}:${Math.round(o.distM || 0)}`);
    seen.add(key);
    let t = tr.get(key);
    if (!t) { t = { key, dx: o.xRelM || 0, dd: o.distM ?? 30, alpha: 0 }; tr.set(key, t); }
    t.dx += ((o.xRelM ?? t.dx) - t.dx) * TRACK_ALPHA;
    t.dd += ((o.distM ?? t.dd) - t.dd) * TRACK_ALPHA;
    t.cls = o.cls; t.state = o.state; t.conf = o.conf; t.bbox = o.bbox;
    if (o.orient || o.orientation) t.orient = o.orient || o.orientation;
    if (o.plate) t.plate = o.plate;
    t.lastSeen = now;
    t.alpha = Math.min(1, t.alpha + 0.18);
  }
  for (const [k, t] of tr) {
    if (seen.has(k)) continue;
    if (now - (t.lastSeen || 0) > TRACK_TTL_MS) tr.delete(k);
    else t.alpha = Math.max(0, t.alpha - 0.12);   // fade out the ghost
  }
}
function trackedDets(now) {
  const out = [];
  for (const [k, t] of vision.tracks) {
    if (now - (t.lastSeen || 0) > TRACK_TTL_MS) { vision.tracks.delete(k); continue; }
    out.push({ cls: t.cls, xRelM: t.dx, distM: t.dd, state: t.state, orient: t.orient,
               plate: t.plate, conf: t.conf, bbox: t.bbox, alpha: t.alpha });
  }
  return out;
}
let activeVisionHost = CFG.VISION_HOST || VISION_HOSTS[0] || null;
let visionWs = null;
let visionConnectTimer = null;
let visionHostAttempt = Math.max(0, VISION_HOSTS.indexOf(activeVisionHost));
let cameraHostAttempt = visionHostAttempt;
const VISION_RETRY_MS = 900;
const CAMERA_PROBE_MS = 8000;
const CAMERA_RETRY_MS = 750;

function visionWsUrl(host) {
  return `ws://${host}:8766/ws`;
}
function visionMjpegUrl(host) {
  return `http://${host}:8766/video_feed`;
}
function updateVisionHost(host, save = false) {
  if (!host) return;
  activeVisionHost = host;
  vision.host = host;
  CFG.VISION_HOST = host;
  CFG.VISION_WS = visionWsUrl(host);
  CFG.VISION_MJPEG = visionMjpegUrl(host);
  if (save) {
    try { window.localStorage.setItem('visionHost', host); } catch {}
  }
}
function nextVisionHostIndex(index) {
  if (!VISION_HOSTS.length) return 0;
  return (index + 1) % VISION_HOSTS.length;
}

/* ---------------- websockets ---------------- */
function connectTelemetry() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws`); }
  catch { return setTimeout(connectTelemetry, 1000); }
  ws.onmessage = e => { try { Object.assign(target, JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { target.link = 'stale'; setTimeout(connectTelemetry, 1000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
connectTelemetry();

function connectVision(hostIndex = visionHostAttempt) {
  if (!VISION_HOSTS.length) return;
  clearTimeout(visionConnectTimer);
  const normalizedIndex = hostIndex % VISION_HOSTS.length;
  const host = VISION_HOSTS[normalizedIndex];
  visionHostAttempt = normalizedIndex;
  let ws;
  try { ws = new WebSocket(visionWsUrl(host)); }
  catch {
    visionConnectTimer = setTimeout(() => connectVision(nextVisionHostIndex(normalizedIndex)), VISION_RETRY_MS);
    return;
  }
  visionWs = ws;
  let frames = 0, t0 = performance.now();
  ws.onopen = () => {
    updateVisionHost(host, true);
    cameraHostAttempt = normalizedIndex;
    loadCameraFeed(true, host);
  };
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      // VisionLab emits {class, xRelM, distM, conf, state, bbox, plate}; keep bbox+plate
      // to draw boxes/crosshairs/plates aligned to the real camera image.
      const raw = (Array.isArray(d.detections) ? d.detections : []).map(o => ({
        id: o.id, tid: o.tid, cls: o.cls || o.class, xRelM: o.xRelM, distM: o.distM ?? o.distance_ft,
        conf: o.conf, state: o.state, bbox: o.bbox, plate: o.plate,
        orient: o.orient || o.orientation,
      }));
      vision.dets = raw;
      updateTracks(raw, performance.now());
      if (d.camera) { vision.camW = d.camera.width || vision.camW; vision.camH = d.camera.height || vision.camH; }
      vision.lanes = d.lanes || null;
      vision.laneConf = d.lanes?.confidence ?? null;
      vision.laneSource = d.lanes?.source ?? null;
      vision.schemaV = d.v ?? vision.schemaV;
      vision.packetStale = d.stale === true;
      if (typeof d.fps === 'number') vision.backendFps = d.fps;
      vision.lastRx = performance.now();
      frames++;
      const dt = (vision.lastRx - t0) / 1000;
      if (dt >= 1) {
        vision.fps = Math.round(frames / dt);
        frames = 0;
        t0 = vision.lastRx;
      }
    } catch {}
  };
  ws.onclose = () => {
    if (visionWs !== ws) return;
    visionWs = null;
    visionConnectTimer = setTimeout(() => connectVision(nextVisionHostIndex(normalizedIndex)), VISION_RETRY_MS);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
connectVision();

let camErr = false;
let camReady = false;
let camRetryTimer = null;
let camProbeTimer = null;
function loadCameraFeed(cacheBust = false, host = activeVisionHost || VISION_HOSTS[cameraHostAttempt]) {
  if (!host) return;
  updateVisionHost(host);
  camReady = false;
  camErr = false;
  const src = visionMjpegUrl(host) + (cacheBust ? `?t=${Date.now()}` : '');
  camFeed.dataset.host = host;
  camFeed.src = src;
  clearTimeout(camProbeTimer);
  camProbeTimer = setTimeout(() => {
    if (!camReady && !(camFeed.naturalWidth > 0 && camFeed.naturalHeight > 0)) {
      camErr = true;
      scheduleCameraReconnect();
    }
  }, CAMERA_PROBE_MS);
}
function scheduleCameraReconnect() {
  if (!VISION_HOSTS.length || camRetryTimer) return;
  camRetryTimer = setTimeout(() => {
    camRetryTimer = null;
    if (!activeVisionHost || camErr) {
      cameraHostAttempt = nextVisionHostIndex(cameraHostAttempt);
    }
    loadCameraFeed(true, VISION_HOSTS[cameraHostAttempt] || activeVisionHost);
  }, CAMERA_RETRY_MS);
}
// --- video crash guard: on the Pi, fast reload loops from the MJPEG layer
// disable the camera for a 3-min cooldown. On localhost (dev), skip entirely. ---
let camDisabled = false, camErrCount = 0;
try {
  const p = new URLSearchParams(location.search).get('cam');
  if (p === '1') localStorage.removeItem('camOff');
  if (p === '0') localStorage.setItem('camOff', String(Date.now() + 31536000000));
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isLocal) {
    if (+(localStorage.getItem('camOff') || 0) > Date.now()) camDisabled = true;
    const nowTs = Date.now(), last = +(localStorage.getItem('camTs') || 0);
    const quick = (nowTs - last < 12000) ? (+(localStorage.getItem('camQuick') || 0) + 1) : 0;
    localStorage.setItem('camTs', String(nowTs));
    localStorage.setItem('camQuick', String(quick));
    // Only trip on a genuine reload storm (the Pi decoder crash signature), and
    // cool down briefly — so normal page reloads don't hide the video.
    if (quick >= 8) { camDisabled = true; localStorage.setItem('camOff', String(nowTs + 30000)); }
    setTimeout(() => { try { localStorage.setItem('camQuick', '0'); } catch {} }, 20000);
  }
} catch {}
if (VISION_HOSTS.length && !camDisabled) {
  // The MJPEG is already YOLO-annotated server-side. Show it based on the stream's
  // own health (not the flaky detection WS), and auto-reconnect if it drops.
  camFeed.onload = () => {
    camReady = true;
    camErr = false;
    clearTimeout(camProbeTimer);
    const host = camFeed.dataset.host;
    if (host) {
      updateVisionHost(host, true);
      cameraHostAttempt = Math.max(0, VISION_HOSTS.indexOf(host));
    }
  };
  camFeed.onerror = () => {
    camReady = false;
    camErr = true;
    clearTimeout(camProbeTimer);
    if (++camErrCount >= 8) { camDisabled = true; return; }   // flaky stream → drop video this session
    scheduleCameraReconnect();
  };
  loadCameraFeed();
}

/* ---------------- demo vision (no off-Pi source) ---------------- */
// Keeps the perception HUD alive on a bench / in --demo so it never looks dead.
const DEMO = [
  { cls: 'CAR', lane: 0.15, base: 30, amp: 14, spd: 0.23, conf: 0.91 },
  { cls: 'TRUCK', lane: -0.55, base: 40, amp: 6, spd: 0.11, conf: 0.84 },
  { cls: 'PEDESTRIAN', lane: 0.85, base: 22, amp: 4, spd: 0.4, conf: 0.77 },
];
function demoDetections(now) {
  const t = now / 1000;
  return DEMO.map((d, i) => {
    const dist = d.base + Math.sin(t * d.spd + i) * d.amp;
    return {
      cls: d.cls, conf: d.conf,
      xRelM: d.lane * CFG.HUD_LATERAL_FT + Math.sin(t * 0.5 + i) * 1.5,
      distM: clamp(dist, CFG.HUD_RANGE_MIN_FT, CFG.HUD_RANGE_MAX_FT),
    };
  });
}

/* ---------------- perception HUD canvas ---------------- */
const hud = $('hud');
const ctx = hud.getContext('2d');
let HW = 0, HH = 0; // logical (css px) size
function resizeCanvas() {
  const r = hud.getBoundingClientRect();
  if (isClean()) {
    // Full-window video: logical size = on-screen size, backing store at
    // device resolution (capped at 2x) so the recording stays crisp.
    HW = Math.max(1, r.width);
    HH = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    hud.width = Math.round(HW * dpr);
    hud.height = Math.round(HH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }
  HW = Math.max(1, r.width / stageScale);   // back out the stage transform
  HH = Math.max(1, r.height / stageScale);
  // Force DPR=1 — Pi panel is exactly 1920x440, no retina needed.
  // Halves the pixel count vs DPR=2, massive perf win on Pi 3B+.
  const dpr = stageScale;
  hud.width = Math.round(HW * dpr);
  hud.height = Math.round(HH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const CLASS_COLOR = {
  PEDESTRIAN: '#ff7ad9', BICYCLE: '#ff7ad9', MOTORCYCLE: '#ffb020',
  CAR: '#22d3ee', TRUCK: '#22d3ee', BUS: '#22d3ee',
  TRAFFIC_LIGHT: '#facc15', STOP_SIGN: '#f43f5e',
};
const fmtClass = c => (c || '').replace(/_/g, ' ');

const LIGHT_COLOR = { RED: '#ff3b30', YELLOW: '#ffcc00', GREEN: '#34d058' };
// traffic lights colour by their state; everything else by class (red if danger)
function detColor(d, danger) {
  if (d.cls === 'TRAFFIC_LIGHT' && LIGHT_COLOR[d.state]) return LIGHT_COLOR[d.state];
  return danger ? '#f43f5e' : (CLASS_COLOR[d.cls] || '#22d3ee');
}
// label text, with light state baked in: "TRAFFIC LIGHT RED 40ft"
function detLabel(d) {
  const ft = Math.round(d.distM ?? 0);
  const st = d.cls === 'TRAFFIC_LIGHT' && d.state ? `${d.state} ` : '';
  return `${fmtClass(d.cls)} ${st}${ft}ft`;
}

/* --- real-world object sizes [width, height] in FEET (from VisionLab distance.py CLASS_HEIGHT_FT).
 *     Width = height × 0.55 for most classes (distance.py convention), overridden for vehicles. */
const OBJ_SIZE = {
  PEDESTRIAN: [2.0, 5.6],  BICYCLE: [2.2, 4.5],  MOTORCYCLE: [2.8, 4.0],
  CAR: [6.0, 4.5],  TRUCK: [8.0, 8.0],  BUS: [8.5, 10.0],
  TRAFFIC_LIGHT: [1.2, 8.0],  STOP_SIGN: [2.5, 7.0],
};
const DEFAULT_OBJ = [5.0, 4.5];

/*  True 1/distance pinhole projection.
 *  Maps (lateralFt, distFt) → screen point + projected scale.
 *  - Y is placed via 1/dist  (hyperbolic, not linear)
 *  - X lateral uses half-FOV angle so off-center objects sit correctly
 *  - 'scale' factor sizes markers proportional to 1/dist  */
function project(xFt, distFt) {
  const { HUD_RANGE_MIN_FT: rMin, HUD_RANGE_MAX_FT: rMax,
          HUD_HORIZON_FRAC: hFrac, HUD_NEAR_FRAC: nFrac, CAM_HFOV_DEG: hfov } = CFG;

  const dist = clamp(distFt, rMin, rMax);

  // --- Y: 1/distance mapping (near → bottom, far → horizon) ---
  const invNear = 1 / rMin, invFar = 1 / rMax;
  const t = clamp((1 / dist - invFar) / (invNear - invFar), 0, 1);  // 0 = far, 1 = near
  const yFar = HH * hFrac, yNear = HH * nFrac;
  const y = lerp(yFar, yNear, t);

  // --- X: pinhole lateral (camera FOV) ---
  const halfFovRad = (hfov / 2) * Math.PI / 180;
  const screenHalfPx = HW / 2;
  const focalPx = screenHalfPx / Math.tan(halfFovRad);   // virtual focal length in px
  const x = HW / 2 + (xFt / dist) * focalPx;

  // --- scale: proportional to 1/dist (largest at rMin) ---
  const scale = rMin / dist;   // 1.0 at nearest range, shrinks hyperbolically

  return { x, y, t, scale, dist };
}

/* Project a road-edge point at given distance using the same pinhole model */
function projectRoadEdge(lateralFt, distFt) {
  return project(lateralFt, distFt);
}

function drawRoad(fcwColor, now = 0) {
  const { HUD_RANGE_MIN_FT: rMin, HUD_RANGE_MAX_FT: rMax,
          HUD_HORIZON_FRAC: hFrac, HUD_NEAR_FRAC: nFrac, HUD_ROAD_HALF_FT: roadHalf } = CFG;
  const vpx = HW / 2, vpy = HH * hFrac;
  const nearY = HH * nFrac;

  // compute road-edge X at near and far ranges using the pinhole
  const pNearL = project(-roadHalf, rMin), pNearR = project(roadHalf, rMin);
  const pFarL  = project(-roadHalf, rMax), pFarR  = project(roadHalf, rMax);

  ctx.save();
  // road fill
  const g = ctx.createLinearGradient(0, vpy, 0, nearY);
  g.addColorStop(0, 'rgba(20,40,55,0.0)');
  g.addColorStop(1, 'rgba(30,70,100,0.40)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(pFarL.x, pFarL.y); ctx.lineTo(pFarR.x, pFarR.y);
  ctx.lineTo(pNearR.x, pNearR.y); ctx.lineTo(pNearL.x, pNearL.y);
  ctx.closePath(); ctx.fill();

  // lane edges (bright) — no shadowBlur, it kills perf on Pi 3B+ pixman
  ctx.strokeStyle = 'rgba(150,215,255,0.95)'; ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(pFarL.x, pFarL.y); ctx.lineTo(pNearL.x, pNearL.y);
  ctx.moveTo(pFarR.x, pFarR.y); ctx.lineTo(pNearR.x, pNearR.y);
  ctx.stroke();
  // glow effect via double-stroke (cheap alternative to shadowBlur)
  ctx.strokeStyle = 'rgba(70,190,255,0.25)'; ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(pFarL.x, pFarL.y); ctx.lineTo(pNearL.x, pNearL.y);
  ctx.moveTo(pFarR.x, pFarR.y); ctx.lineTo(pNearR.x, pNearR.y);
  ctx.stroke();

  // depth rungs at logarithmically spaced distances (perspective-correct)
  for (let i = 1; i <= 6; i++) {
    const frac = i / 7;
    const d = rMin * Math.pow(rMax / rMin, frac);     // log spacing
    const pl = project(-roadHalf, d), pr = project(roadHalf, d);
    ctx.strokeStyle = `rgba(90,160,200,${0.6 * (1 - frac) + 0.15})`;
    ctx.beginPath(); ctx.moveTo(pl.x, pl.y); ctx.lineTo(pr.x, pr.y); ctx.stroke();
  }

  // center lane line — dashes flow toward the viewer = motion / lane tracking
  const flow = (now % 1200) / 1200;
  const cFar = project(0, rMax), cNear = project(0, rMin);
  ctx.strokeStyle = 'rgba(190,235,255,0.9)'; ctx.lineWidth = 3;
  ctx.setLineDash([16, 18]); ctx.lineDashOffset = -flow * 34;
  ctx.beginPath(); ctx.moveTo(cFar.x, cFar.y); ctx.lineTo(cNear.x, cNear.y); ctx.stroke();
  ctx.setLineDash([]);

  // ego caution wedge (colored by FCW)
  const egoHalf = roadHalf * 0.28;
  const eFarL = project(-egoHalf, rMax), eFarR = project(egoHalf, rMax);
  const eNearL = project(-egoHalf * 3, rMin), eNearR = project(egoHalf * 3, rMin);
  ctx.fillStyle = fcwColor.wedge;
  ctx.beginPath();
  ctx.moveTo(eFarL.x, eFarL.y); ctx.lineTo(eFarR.x, eFarR.y);
  ctx.lineTo(eNearR.x, eNearR.y); ctx.lineTo(eNearL.x, eNearL.y);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

/*  Draw a detection marker with perspective-correct size.
 *  The marker width/height comes from real-world object dimensions projected
 *  through the same pinhole model so a truck at 40ft looks proportionally
 *  larger than a pedestrian at 40ft, and everything shrinks correctly with distance. */
function drawDetection(d, danger) {
  const lateral = d.xRelM ?? 0;
  const dist    = d.distM ?? 30;
  const p = project(lateral, dist);
  const color = detColor(d, danger);

  // Real-world size → screen pixels via pinhole: px = (realFt / distFt) * focalPx
  const [objW, objH] = OBJ_SIZE[d.cls] || DEFAULT_OBJ;
  const halfFovRad = (CFG.CAM_HFOV_DEG / 2) * Math.PI / 180;
  const focalPx = (HW / 2) / Math.tan(halfFovRad);
  // cap size so a very close car can't balloon and swallow the whole HUD
  const w = clamp((objW / dist) * focalPx, 14, HW * 0.2);    // projected width in px
  const h = clamp((objH / dist) * focalPx, 18, HH * 0.36);   // projected height in px

  const A = d.alpha ?? 1;            // track fade in/out
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.globalAlpha = A;

  // soft ground shadow only (no boxy bracket — keeps the scene clean)
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(0, 2, w * 0.4, h * 0.09, 0, 0, 7); ctx.fill();

  // slim stylised glyph, slightly inset + a touch transparent so it doesn't
  // block the road behind it
  const iw = w * 0.82, ih = h * 0.88, top = -ih;
  ctx.globalAlpha = 0.92 * A;
  drawClassIconBox(d.cls, d.state, -iw / 2, top, iw / 2, 0, d.orient);
  ctx.globalAlpha = A;

  // label only on near cars (cuts text clutter); distant ones stay clean
  const fontSize = clamp(Math.round(12 * p.scale), 8, 14);
  if (fontSize >= 8 && (d.distM ?? 0) < 90) {
    ctx.font = `700 ${fontSize}px "SF Pro Rounded", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const ly = top - fontSize * 0.55;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillText(detLabel(d), 0.6, ly + 0.6);
    ctx.fillStyle = color;
    ctx.fillText(detLabel(d), 0, ly);
  }

  // sticky license plate badge under the car (yellow on dark), near cars only
  if (d.plate && (d.distM ?? 0) < 75) {
    const pf = clamp(Math.round(11 * p.scale), 8, 13);
    ctx.font = `800 ${pf}px "SF Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    const pw = ctx.measureText(d.plate).width + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.72)'; rrect(-pw / 2, 3, pw, pf + 5, 3); ctx.fill();
    ctx.fillStyle = '#ffd23f'; ctx.fillText(d.plate, 0, 3 + pf);
  }
  ctx.restore();
}

function smoothLaneSeg(prev, next) {
  if (!next || next.length < 2) return prev;
  // server now sends N-point curves; EMA per-point when the sampling matches,
  // otherwise snap to the new shape.
  if (!prev || prev.length !== next.length) return next.map(p => [...p]);
  return next.map((p, i) => [
    lerp(prev[i][0], p[0], LANE_PT_EMA),
    lerp(prev[i][1], p[1], LANE_PT_EMA),
  ]);
}

/* Clip a camera-space polyline to the horizon: keep points at or below it (larger
 * y = nearer), interpolate the crossing, and drop everything above. Lanes are
 * ordered bottom -> top, so we can stop at the first point past the horizon. */
function clipPolyToHorizon(seg, hY) {
  if (!seg || seg.length < 2) return null;
  const out = [];
  for (const p of seg) {
    if (p[1] >= hY) { out.push([p[0], p[1]]); continue; }
    const prev = out.length ? out[out.length - 1] : null;
    if (prev) {
      const t = (hY - prev[1]) / (p[1] - prev[1]);
      out.push([prev[0] + (p[0] - prev[0]) * t, hY]);
    }
    break;
  }
  return out.length >= 2 ? out : null;
}

function updateLaneSmooth(lanes) {
  if (!lanes) return;
  if (lanes.left) laneSmooth.left = smoothLaneSeg(laneSmooth.left, lanes.left);
  if (lanes.right) laneSmooth.right = smoothLaneSeg(laneSmooth.right, lanes.right);
  if (lanes.center) laneSmooth.center = smoothLaneSeg(laneSmooth.center, lanes.center);
}

function laneConfidence(lanes) {
  if (!lanes) return 0;
  if (lanes.source === 'none') return 0;
  if (typeof lanes.confidence === 'number') return clamp(lanes.confidence, 0, 1);
  if (lanes.source === 'fallback') return clamp(lanes.confidence ?? 0.25, 0, 1);
  const hasL = !!(lanes.left?.length >= 2);
  const hasR = !!(lanes.right?.length >= 2);
  if (hasL && hasR) return 0.55;
  if (hasL || hasR) return 0.28;
  return 0;
}

/* Smooth quadratic stroke through a polyline (midpoint curve) — nicer than
 * straight lineTo segments for curved lanes. pts are already panel-space. */
function strokeSmooth(pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const n = pts.length - 1;
  ctx.lineTo(pts[n][0], pts[n][1]);
  ctx.stroke();
}

function drawLaneSeg(seg, mp, { glowA, lineA, lineW, dashed = false }) {
  if (!seg || seg.length < 2) return;
  const path = seg.map(mp);
  if (dashed) ctx.setLineDash([6, 10]);
  ctx.strokeStyle = `rgba(70,190,255,${glowA})`; ctx.lineWidth = lineW + 6; strokeSmooth(path);
  ctx.strokeStyle = `rgba(165,228,255,${lineA})`; ctx.lineWidth = lineW; strokeSmooth(path);
  if (dashed) ctx.setLineDash([]);
}

/* Real lane lines (camera px → panel). alpha scales fade; tentative = dashed/muted.
 * horizonCamY (camera px) clips the lines so nothing renders above the horizon. */
function drawLanes(lanes, { alpha = 1, tentative = false, horizonCamY = null } = {}) {
  if (!lanes || alpha < 0.02) return;
  const vw = vision.camW || 1280, vh = vision.camH || 720;
  const scale = Math.max(HW / vw, HH / vh), offX = (HW - vw * scale) / 2, offY = (HH - vh * scale) / 2;
  const mp = ([x, y]) => [x * scale + offX, y * scale + offY];
  const clip = (s) => (horizonCamY == null ? s : clipPolyToHorizon(s, horizonCamY));
  const a = clamp(alpha, 0, 1);
  const glowA = (tentative ? 0.08 : 0.22) * a;
  const lineA = (tentative ? 0.38 : 0.95) * a;
  const lineW = tentative ? 2.5 : 3.5;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (tentative) ctx.setLineDash([10, 14]);
  for (const side of ['left', 'right']) drawLaneSeg(clip(lanes[side]), mp, { glowA, lineA, lineW });
  if (lanes.center?.length >= 2 && !tentative) {
    drawLaneSeg(clip(lanes.center), mp, {
      glowA: 0.06 * a, lineA: 0.32 * a, lineW: 1.5, dashed: true,
    });
  }
  ctx.restore();
}

/* object-fit:cover mapping from camera pixels → panel pixels. Identical to the
 * transform the browser applies to the MJPEG <img>, so anything drawn through
 * this maps exactly onto the live video. */
function camCover() {
  const vw = vision.camW || camFeed.naturalWidth || 1280;
  const vh = vision.camH || camFeed.naturalHeight || 720;
  const scale = Math.max(HW / vw, HH / vh);
  const offX = (HW - vw * scale) / 2, offY = (HH - vh * scale) / 2;
  return { vw, vh, mp: (p) => [p[0] * scale + offX, p[1] * scale + offY] };
}

/* Intersection of two line segments extended to infinite lines (the lane
 * vanishing point). Returns [x,y] in the same coords, or null if ~parallel. */
function lineIntersect(a, b) {
  const [[x1, y1], [x2, y2]] = a, [[x3, y3], [x4, y4]] = b;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-6) return null;
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den;
  return [px, py];
}

/* Realtime street map locked to the video: drivable road fill between the two
 * detected lane edges, a horizon line at the lane vanishing height, and the
 * lane lines themselves. Tinted by FCW level. */
/* Clip the canvas to "whole panel minus the detection boxes" so anything drawn
 * after (road fill, lanes, horizon) passes BEHIND the objects — giving depth:
 * cars/signs sit on top of the road instead of the lanes painting over them. */
function applyOccluderClip(dets) {
  if (!dets || !dets.length) return;
  const vw = vision.camW || camFeed.naturalWidth || 1280;
  const vh = vision.camH || camFeed.naturalHeight || 720;
  const scale = Math.max(HW / vw, HH / vh);
  const offX = (HW - vw * scale) / 2, offY = (HH - vh * scale) / 2;
  ctx.beginPath();
  ctx.rect(0, 0, HW, HH);
  for (const d of dets) {
    if (!Array.isArray(d.bbox) || d.bbox.length < 4) continue;
    const x1 = d.bbox[0] * scale + offX, y1 = d.bbox[1] * scale + offY;
    const x2 = d.bbox[2] * scale + offX, y2 = d.bbox[3] * scale + offY;
    const ix = (x2 - x1) * 0.05, iy = (y2 - y1) * 0.05;   // tuck just inside the silhouette
    ctx.rect(x1 + ix, y1 + iy, (x2 - x1) - 2 * ix, (y2 - y1) - 2 * iy);
  }
  ctx.clip('evenodd');   // outer rect minus the boxes
}

function drawStreetMap(now, fcw, dets) {
  const { vw, vh, mp } = camCover();
  const L = laneSmooth.left, R = laneSmooth.right;
  const topSeg = (s) => [s[s.length - 2], s[s.length - 1]];  // far end of the curve

  // horizon = lane vanishing point (far segments extended to their intersection),
  // sticky so it holds steady when the right lane drops out frame to frame.
  if (L && R && L.length >= 2 && R.length >= 2) {
    const vp = lineIntersect(topSeg(L), topSeg(R));
    if (vp && vp[1] > vh * 0.15 && vp[1] < vh * 0.85) {
      horizonHold = horizonHold == null ? vp[1] : lerp(horizonHold, vp[1], 0.15);
    }
  }
  const horizonCamY = horizonHold != null ? horizonHold : vh * (CFG.HUD_HORIZON_FRAC ?? 0.45);

  const col = fcw.level === 2 ? '244,63,94' : fcw.level === 1 ? '250,204,21' : '34,211,238';
  ctx.save();
  if (!LITE) applyOccluderClip(dets);   // depth: road + lanes behind objects (Mac only)

  // drivable surface between the curved lane edges, clipped to the horizon so it
  // never bleeds into the sky. Follows both curves, not a flat trapezoid.
  const lc = clipPolyToHorizon(L, horizonCamY), rc = clipPolyToHorizon(R, horizonCamY);
  if (lc && rc) {
    const left = lc.map(mp), right = rc.map(mp);
    // flat fill on Pi (no per-frame gradient object), gradient on Mac
    if (LITE) {
      ctx.fillStyle = `rgba(${col},0.12)`;
    } else {
      const allY = [...left, ...right].map(p => p[1]);
      const g = ctx.createLinearGradient(0, Math.min(...allY), 0, Math.max(...allY));
      g.addColorStop(0, `rgba(${col},0.02)`);
      g.addColorStop(1, `rgba(${col},0.20)`);
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath(); ctx.fill();
  }

  // horizon line across the frame
  const hy = mp([0, horizonCamY])[1];
  ctx.strokeStyle = `rgba(${col},0.32)`; ctx.lineWidth = 1.25;
  ctx.setLineDash([14, 12]);
  ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(HW, hy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 11px "SF Pro Rounded", system-ui, sans-serif';
  ctx.fillStyle = `rgba(${col},0.55)`;
  ctx.fillText('HORIZON', 12, hy - 6);

  // lane edges — curved, clipped to the horizon, and (via the occluder clip above)
  // hidden behind detected objects so the crosshairs read as in front.
  drawLanes(laneSmooth, { alpha: 1, tentative: false, horizonCamY });
  ctx.restore();
}

/* Predicted drive path — a glowing band up the ego lane, tinted by FCW level. */
function drawEgoPath(now, level = 0) {
  const { HUD_RANGE_MIN_FT: rMin, HUD_RANGE_MAX_FT: rMax } = CFG;
  const halfW = 3.4, near = rMin * 0.9, midD = rMin * Math.pow(rMax / rMin, 0.5);
  const nL = project(-halfW, near), nR = project(halfW, near);
  const mL = project(-halfW * 0.5, midD), mR = project(halfW * 0.5, midD);
  const col = level === 2 ? '244,63,94' : level === 1 ? '250,204,21' : '40,160,255';
  ctx.save();
  const g = ctx.createLinearGradient(0, nL.y, 0, mL.y);
  g.addColorStop(0, `rgba(${col},0.22)`); g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(nL.x, nL.y); ctx.lineTo(nR.x, nR.y); ctx.lineTo(mR.x, mR.y); ctx.lineTo(mL.x, mL.y);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = `rgba(${col},0.3)`; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nL.x, nL.y); ctx.lineTo(mL.x, mL.y);
  ctx.moveTo(nR.x, nR.y); ctx.lineTo(mR.x, mR.y);
  ctx.stroke();
  ctx.restore();
}

/*  3D AR cuboid: extrude a 2D box into a wireframe prism. With no explicit
 *  offset it pushes "into" the scene toward the vanishing point (horizon centre),
 *  giving each detection a volumetric look. Faint shaded side faces + bright
 *  front face. Cheap: plain strokes/fills, no shadowBlur (Pi 3B+ safe). */
function draw3DBox(x1, y1, x2, y2, color, ox, oy) {
  const w = x2 - x1, h = y2 - y1;
  if (ox === undefined) {
    const vpx = HW / 2, vpy = HH * (CFG.HUD_HORIZON_FRAC ?? 0.3);
    let dx = vpx - (x1 + x2) / 2, dy = vpy - (y1 + y2) / 2;
    const dl = Math.hypot(dx, dy) || 1;
    const depth = clamp(Math.min(w, h) * 0.45, 8, 110);
    ox = (dx / dl) * depth; oy = (dy / dl) * depth;
  }
  const bx1 = x1 + ox, by1 = y1 + oy, bx2 = x2 + ox, by2 = y2 + oy;
  ctx.save();
  // back face
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.35;
  ctx.strokeRect(bx1, by1, w, h);
  // shaded side faces for depth (top + both vertical sides)
  ctx.globalAlpha = 0.13; ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.lineTo(bx2, by1); ctx.lineTo(bx1, by1); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2, y2); ctx.lineTo(bx2, by2); ctx.lineTo(bx2, by1); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y2); ctx.lineTo(bx1, by2); ctx.lineTo(bx1, by1); ctx.closePath(); ctx.fill();
  // connectors between front and back faces
  ctx.globalAlpha = 0.5; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(bx1, by1);
  ctx.moveTo(x2, y1); ctx.lineTo(bx2, by1);
  ctx.moveTo(x1, y2); ctx.lineTo(bx1, by2);
  ctx.moveTo(x2, y2); ctx.lineTo(bx2, by2);
  ctx.stroke();
  // front face (bright)
  ctx.globalAlpha = 1; ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, w, h);
  ctx.restore();
}

/* ===== RetroVision icon kit (ported/adapted from vision-lab app.js) =====
 * Stylised glyphs drawn as a floating badge next to each detection: octagon
 * STOP sign, 3-bulb traffic light lit by state, pedestrian, and type-aware
 * vehicles (sedan / truck / bus / two-wheeler). */
function rrect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function poly(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function iconStop(cx, cy, r) {
  ctx.save();
  ctx.shadowColor = '#f43f5e'; ctx.shadowBlur = Math.min(12, r * 0.6);
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, r * 0.09);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const ir = r * 0.84; const x = cx + Math.cos(a) * ir, y = cy + Math.sin(a) * ir; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.closePath(); ctx.stroke();
  if (r > 9) { ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.floor(r * 0.6)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('STOP', cx, cy + r * 0.04); }
  ctx.restore();
}

function iconLight(cx, cy, w, h, state) {
  ctx.save();
  ctx.fillStyle = '#0f172a'; rrect(cx - w / 2, cy - h / 2, w, h, w * 0.25); ctx.fill();
  ctx.strokeStyle = '#475569'; ctx.lineWidth = Math.max(1, w * 0.08); rrect(cx - w / 2, cy - h / 2, w, h, w * 0.25); ctx.stroke();
  const col = { RED: '#f43f5e', YELLOW: '#facc15', GREEN: '#34d399' }, order = ['RED', 'YELLOW', 'GREEN'];
  const r = w * 0.3;
  for (let i = 0; i < 3; i++) {
    const by = cy - h / 2 + h * (0.2 + i * 0.3);
    const lit = state === order[i];
    ctx.shadowColor = col[order[i]]; ctx.shadowBlur = lit ? 12 : 0;
    ctx.fillStyle = lit ? col[order[i]] : '#1a2030';
    ctx.beginPath(); ctx.arc(cx, by, r, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function iconPed(cx, cy, w, h) {
  ctx.save();
  const top = cy - h / 2, headR = h * 0.13, lw = Math.max(1.5, w * 0.13);
  ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = 7; ctx.fillStyle = '#a78bfa';
  ctx.beginPath(); ctx.arc(cx, top + headR, headR, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#7c3aed'; rrect(cx - w * 0.2, top + headR * 2, w * 0.4, h * 0.4, 3); ctx.fill();
  const sh = top + headR * 2, hip = sh + h * 0.4;
  ctx.strokeStyle = '#a78bfa'; ctx.lineCap = 'round'; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.2, sh + lw); ctx.lineTo(cx - w * 0.42, sh + h * 0.34);
  ctx.moveTo(cx + w * 0.2, sh + lw); ctx.lineTo(cx + w * 0.42, sh + h * 0.34);
  ctx.moveTo(cx - w * 0.08, hip); ctx.lineTo(cx - w * 0.2, cy + h * 0.5);
  ctx.moveTo(cx + w * 0.08, hip); ctx.lineTo(cx + w * 0.2, cy + h * 0.5);
  ctx.stroke(); ctx.restore();
}

/* type-aware rear vehicle — adapted from drawRearVehicle */
const VEH = {
  CAR:   { body: '#cfd8e3', roof: '#8a97a6' },
  TRUCK: { body: '#5aa0d6', roof: '#2c5f86', sensor: true },
  BUS:   { body: '#f2c14e', roof: '#b5862a' },
};
function mix(a, b, t) {                 // lerp two #rrggbb hex colours → rgb()
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = (pa >> 16) + (((pb >> 16) - (pa >> 16)) * t);
  const g = ((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = (pa & 255) + (((pb & 255) - (pa & 255)) * t);
  return `rgb(${r | 0},${g | 0},${bl | 0})`;
}

/* True 3D vehicle: the near (visible) end is a solid face; the body extrudes
 * up-screen to a smaller far end, giving shaded roof + flank faces = real depth.
 * Trucks/buses extrude longer. Lights pick headlights(front)/taillights(rear). */
function iconVehicle(cx, bottomY, w, h, cls, orient) {
  const v = VEH[cls] || VEH.CAR;
  const front = orient === 'front';
  const nh = h * 0.66;                          // near (rear) face height
  const ext = h * 0.34;                         // roof recedes up to the box top
  const k = 0.84, fw = w * k, fh = nh * k, fy = bottomY - ext;
  const P = (pts) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
  const nbl = [cx - w / 2, bottomY], nbr = [cx + w / 2, bottomY];
  const ntl = [cx - w / 2, bottomY - nh], ntr = [cx + w / 2, bottomY - nh];
  const fbl = [cx - fw / 2, fy], fbr = [cx + fw / 2, fy];
  const ftl = [cx - fw / 2, fy - fh], ftr = [cx + fw / 2, fy - fh];

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(cx, bottomY + 1, w * 0.5, Math.max(2, h * 0.09), 0, 0, 7); ctx.fill();
  // wheels along the flanks
  ctx.fillStyle = '#0a0e14';
  for (const [wx, wy, ww] of [[cx - w / 2, bottomY, w * 0.08], [cx + w / 2, bottomY, w * 0.08], [cx - fw / 2, fy, fw * 0.09], [cx + fw / 2, fy, fw * 0.09]]) {
    ctx.beginPath(); ctx.ellipse(wx, wy, Math.max(2, ww), Math.max(1.5, h * 0.08), 0, 0, 7); ctx.fill();
  }
  ctx.fillStyle = mix(v.body, '#000000', 0.6); P([fbl, fbr, ftr, ftl]); ctx.fill();   // far face
  ctx.fillStyle = mix(v.body, '#ffffff', 0.22); P([ntl, ntr, ftr, ftl]); ctx.fill();  // roof (lit)
  ctx.fillStyle = mix(v.body, '#000000', 0.34); P([nbl, ntl, ftl, fbl]); ctx.fill();  // left flank
  ctx.fillStyle = mix(v.body, '#000000', 0.16); P([nbr, ntr, ftr, fbr]); ctx.fill();  // right flank
  ctx.shadowColor = v.body; ctx.shadowBlur = 8;
  ctx.fillStyle = v.body; P([nbl, nbr, ntr, ntl]); ctx.fill();                        // near face
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#10141c'; rrect(cx - w * 0.32, bottomY - nh * 0.92, w * 0.64, nh * 0.34, Math.max(2, nh * 0.08)); ctx.fill();  // rear glass
  ctx.fillStyle = '#111827'; ctx.fillRect(cx - w / 2, bottomY - nh * 0.26, w, nh * 0.26);  // bumper
  const lc = front ? '#fde68a' : '#ff3b3b';
  ctx.fillStyle = lc; ctx.shadowColor = lc; ctx.shadowBlur = nh * 0.18;
  ctx.fillRect(cx - w * 0.43, bottomY - nh * 0.5, w * 0.17, nh * 0.14);
  ctx.fillRect(cx + w * 0.26, bottomY - nh * 0.5, w * 0.17, nh * 0.14);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = Math.max(1, h * 0.02);
  P([nbl, nbr, ntr, ntl]); ctx.stroke();
  P([ntl, ntr, ftr, ftl]); ctx.stroke();
  if (v.sensor) { ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(cx, fy - fh * 0.1, Math.max(2, w * 0.03), 0, 7); ctx.fill(); }
  ctx.restore();
}

function iconTwoWheeler(cx, bottomY, w, h, cls) {
  const color = cls === 'BICYCLE' ? '#4ade80' : '#fb923c';
  const wr = h * 0.18, wy = bottomY - wr;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, w * 0.09);
  for (const wx of [cx - w * 0.28, cx + w * 0.28]) { ctx.beginPath(); ctx.arc(wx, wy, wr, 0, 7); ctx.stroke(); }
  ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.fillStyle = color;
  rrect(cx - w * 0.13, bottomY - h * 0.72, w * 0.26, h * 0.5, 3); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, bottomY - h * 0.8, h * 0.12, 0, 7); ctx.fill();
  ctx.restore();
}

/* dispatch: draw the right glyph centred in a size×size badge box */
function drawClassIcon(cls, state, cx, cy, size) {
  if (cls === 'STOP_SIGN') return iconStop(cx, cy, size * 0.5);
  if (cls === 'TRAFFIC_LIGHT') return iconLight(cx, cy, size * 0.46, size * 0.92, state);
  if (cls === 'PEDESTRIAN') return iconPed(cx, cy, size * 0.5, size * 0.92);
  if (cls === 'CAR' || cls === 'TRUCK' || cls === 'BUS') {
    const hf = cls === 'BUS' ? 0.74 : cls === 'TRUCK' ? 0.68 : 0.58;
    return iconVehicle(cx, cy + size * 0.42, size * 0.92, size * hf, cls);
  }
  if (cls === 'MOTORCYCLE' || cls === 'BICYCLE') return iconTwoWheeler(cx, cy + size * 0.4, size * 0.55, size * 0.8, cls);
}

/* draw the glyph fitted ON the detection box (sits on the real object) */
function drawClassIconBox(cls, state, x1, y1, x2, y2, orient) {
  const w = x2 - x1, h = y2 - y1, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  if (cls === 'STOP_SIGN') return iconStop(cx, cy, Math.min(w, h) / 2);
  if (cls === 'TRAFFIC_LIGHT') return iconLight(cx, cy, w, h, state);
  if (cls === 'PEDESTRIAN') return iconPed(cx, cy, w, h);
  if (cls === 'CAR' || cls === 'TRUCK' || cls === 'BUS') return iconVehicle(cx, y2, w, h, cls, orient);
  if (cls === 'MOTORCYCLE' || cls === 'BICYCLE') return iconTwoWheeler(cx, y2, w, h, cls);
}

/*  Camera-aligned overlay: map each detection's pixel bbox (camera space) onto the
 *  panel via the same object-fit:cover transform, then draw a 3D cuboid + crosshair +
 *  class/range label + license plate + a RetroVision icon badge, sitting on the
 *  real object in the video. */
function drawCameraOverlay(dets, danger) {
  const vw = vision.camW || 1280, vh = vision.camH || 720;
  const scale = Math.max(HW / vw, HH / vh);          // object-fit: cover
  const offX = (HW - vw * scale) / 2, offY = (HH - vh * scale) / 2;
  for (const d of dets) {
    if (!Array.isArray(d.bbox) || d.bbox.length < 4) continue;
    const x1 = d.bbox[0] * scale + offX, y1 = d.bbox[1] * scale + offY;
    const x2 = d.bbox[2] * scale + offX, y2 = d.bbox[3] * scale + offY;
    const w = x2 - x1, h = y2 - y1, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const dangerHit = danger && danger.has(d);
    const color = detColor(d, dangerHit);
    ctx.save();
    // thin tracking box — shows exactly where YOLO sees the object
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.strokeRect(x1, y1, w, h);

    // crosshair at object center
    const cl = Math.min(w, h) * 0.18 + 5;
    ctx.beginPath();
    ctx.moveTo(cx - cl, cy); ctx.lineTo(cx + cl, cy);
    ctx.moveTo(cx, cy - cl); ctx.lineTo(cx, cy + cl);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 7); ctx.fillStyle = color; ctx.fill();
    // class + state + range label
    ctx.font = '700 13px "SF Pro Rounded", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.fillStyle = color;
    ctx.fillText(detLabel(d), x1, Math.max(12, y1 - 5));
    // license plate (read server-side)
    if (d.plate) {
      ctx.font = '800 14px "SF Mono", ui-monospace, monospace';
      const pw = ctx.measureText(d.plate).width + 12;
      ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(x1, y2 + 2, pw, 19);
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 1; ctx.strokeRect(x1, y2 + 2, pw, 19);
      ctx.fillStyle = '#facc15'; ctx.fillText(d.plate, x1 + 6, y2 + 16);
    }
    ctx.restore();
  }
}

let sweep = 0;
function drawSweep(now) {
  sweep = (now % 2600) / 2600;
  // Sweep from far → near using the same pinhole projection
  const { HUD_RANGE_MIN_FT: rMin, HUD_RANGE_MAX_FT: rMax, HUD_ROAD_HALF_FT: roadHalf } = CFG;
  const d = rMin * Math.pow(rMax / rMin, 1 - sweep);   // log-sweep through distance
  const pl = project(-roadHalf, d), pr = project(roadHalf, d);
  ctx.save();
  ctx.strokeStyle = `rgba(34,211,238,${0.5 * (1 - sweep) + 0.12})`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pl.x, pl.y); ctx.lineTo(pr.x, pr.y); ctx.stroke();
  ctx.restore();
}

/* ---------------- forward-collision assessment ---------------- */
function assessFCW(dets, mph) {
  const ftps = mph * 1.4667;
  let nearest = null;
  for (const d of dets) {
    if (Math.abs(d.xRelM ?? 99) > 6) continue;       // only ego-lane objects
    if (!nearest || (d.distM ?? 1e9) < nearest.distM) nearest = d;
  }
  if (!nearest) return { level: 0, state: 'CLEAR', reason: 'road ahead clear', danger: new Set() };
  const dist = nearest.distM ?? 99;
  const ttc = ftps > 0.6 ? dist / ftps : Infinity;
  const danger = new Set();
  let level = 0, state = 'CLEAR', reason = 'road ahead clear';
  if (ttc < CFG.TTC_WARN_S || dist < CFG.NEAR_WARN_FT) {
    level = 1; state = 'CAUTION';
    reason = `${fmtClass(nearest.cls)} ${Math.round(dist)}ft · TTC ${isFinite(ttc) ? ttc.toFixed(1) + 's' : '—'}`;
  }
  if (ttc < CFG.TTC_DANGER_S || dist < 12) {
    level = 2; state = 'BRAKE'; danger.add(nearest);
    reason = `${fmtClass(nearest.cls)} ${Math.round(dist)}ft · TTC ${isFinite(ttc) ? ttc.toFixed(1) + 's' : '—'}`;
  }
  return { level, state, reason, danger };
}
const FCW_COLORS = [
  { wedge: 'rgba(52,211,153,0.10)' },
  { wedge: 'rgba(250,204,21,0.16)' },
  { wedge: 'rgba(244,63,94,0.22)' },
];

/* ---------------- main render loop (30fps cap for Pi 3B+) ---------------- */
let last = performance.now();
let lastSpeed = -1, lastRpm = -1, lastGear = '', lastLink = '';
const FRAME_BUDGET = 1000 / (LITE ? 20 : 30);  // Pi 3B+ renders at 20fps, Mac at 30
function frame(now) {
  requestAnimationFrame(frame);
  if (now - last < FRAME_BUDGET) return;  // skip frame if too soon
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  const k = 1 - Math.pow(0.0016, dt);               // needle smoothing
  shown.mph = lerp(shown.mph, target.mph || 0, k);
  shown.rpm = lerp(shown.rpm, target.rpm || 0, k);
  const blink = (Math.floor(now / 420) % 2) === 0;

  /* --- speed --- */
  const mph = Math.round(shown.mph);
  if (mph !== lastSpeed) { elSpeed.textContent = mph; lastSpeed = mph; }
  speedRing.set(shown.mph / SPEED_MAX);
  elSpeedBar.style.transform = `scaleX(${clamp(shown.mph / SPEED_MAX, 0, 1)})`;

  /* --- rpm + gear --- */
  const rpm = Math.round(shown.rpm / 10) * 10;
  if (rpm !== lastRpm) { elRpm.textContent = rpm; lastRpm = rpm; }
  rpmRing.set(shown.rpm / TACH_MAX);
  elRpmBar.style.transform = `scaleX(${clamp(shown.rpm / TACH_REDLINE, 0, 1)})`;
  const gear = (target.mph || 0) < 1 ? 'P' : 'D';
  if (gear !== lastGear) { elGear.textContent = gear; lastGear = gear; }

  /* --- shift light + redline warning --- */
  const redFrac = shown.rpm / TACH_REDLINE;          // 1.0 = redline
  const lit = Math.round(clamp(redFrac, 0, 1) * SHIFT_LEDS);
  for (let i = 0; i < SHIFT_LEDS; i++) shiftLeds[i].classList.toggle('on', i < lit);
  rpmRingEl.classList.toggle('redline', redFrac >= 0.95);
  shiftbar.classList.toggle('flash', redFrac >= 1.0);

  /* --- minis --- */
  const fp = target.fuelPct || 0;
  fuelMini.set(fp / 100, fp < 15 ? RED : fp < 30 ? AMB : GRN, fp + '%');
  const tc = target.tempC;
  coolant.set(clamp((tc ?? 20) / 120, 0, 1), (tc ?? 0) > 105 ? RED : GRN, tc == null ? '—' : Math.round(tc) + '°');
  const hum = target.humidity;
  humid.set((hum ?? 0) / 100, GRN, hum == null ? '—' : Math.round(hum) + '%');

  /* --- vision source selection --- */
  const visAge = (now - vision.lastRx) / 1000;
  const visLive = vision.configured && visAge < 1.2 && !vision.packetStale;
  let dets, vmode;
  if (visLive) { dets = trackedDets(now); vmode = 'live'; }
  else if (!vision.configured) { dets = demoDetections(now); vmode = 'demo'; }
  else { dets = trackedDets(now); vmode = 'stale'; }   // let ghosts fade, don't pop

  rangeMini.set(clamp((target.distanceCm ?? 0) / 400, 0, 1), GRN,
    target.distanceCm == null ? '—' : Math.round(target.distanceCm) + 'cm');

  /* --- FCW --- */
  const fcw = assessFCW(dets, shown.mph);
  if (elFcwState.textContent !== fcw.state) elFcwState.textContent = fcw.state;
  elFcwReason.textContent = fcw.reason;
  elFcw.className = 'fcw' + (fcw.level === 1 ? ' warn' : fcw.level === 2 ? ' danger' : '');

  /* --- perception HUD --- */
  ctx.clearRect(0, 0, HW, HH);
  // When the off-Pi camera is live, its MJPEG (already YOLO-annotated) fills the
  // panel behind this canvas. Keep the VisionLab 3D framework on top.
  if (!camReady && camFeed.naturalWidth > 0 && camFeed.naturalHeight > 0) {
    camReady = true;
    camErr = false;
  }
  const camOn = CFG.SHOW_CAM_PIP !== false && !!CFG.VISION_MJPEG && camReady && !camErr && !camDisabled;
  camFeed.classList.toggle('on', camOn);
  if (camTag) camTag.style.display = camOn ? 'block' : 'none';

  // Lane tracking: camera-space polylines from the server, EMA-smoothed.
  const laneConf = laneConfidence(vision.lanes);
  const visionLaneOk = visLive && vision.lanes && laneConf > 0.10
    && vision.laneSource !== 'none' && vision.lanes?.source !== 'none';
  if (visionLaneOk) updateLaneSmooth(vision.lanes);

  if (camOn) {
    // ---- AR mode: everything locked to the real video pixels ----
    // Realtime street map (road + lanes + horizon), then YOLO tracking boxes
    // sitting on the actual objects. No synthetic top-down — it never tracks.
    drawStreetMap(now, fcw, dets);
    drawCameraOverlay(dets, fcw.danger);
    if (visionLaneOk) {
      laneBlend = 1;
    } else {
      laneBlend = lerp(laneBlend, 0, LANE_BLEND_SPEED * 2);  // let lanes fade, don't freeze
      if (laneBlend < 0.06) laneSmooth = { left: null, right: null, center: null };
    }
  } else {
    // ---- synthetic top-down HUD: demo / no camera ----
    const targetBlend = visionLaneOk ? clamp(laneConf, 0, 1) : 0;
    laneBlend = lerp(laneBlend, targetBlend, LANE_BLEND_SPEED);
    const showVision = laneBlend > 0.04 && (laneSmooth.left || laneSmooth.right);
    const tentative = laneConf < LANE_CONF_SHOW || vision.laneSource === 'fallback';
    const fallbackRoad = !showVision || laneBlend < 0.98;
    if (fallbackRoad) {
      ctx.save();
      ctx.globalAlpha = tentative ? 0.72 : (1 - laneBlend * (showVision ? 1 : 0));
      drawRoad(FCW_COLORS[fcw.level], now);
      ctx.restore();
    }
    if (showVision) {
      drawLanes(laneSmooth, { alpha: laneBlend, tentative });
    } else if (!visionLaneOk) {
      laneBlend = lerp(laneBlend, 0, LANE_BLEND_SPEED * 2);
      if (laneBlend < 0.06) laneSmooth = { left: null, right: null, center: null };
    }
    ctx.save();
    ctx.globalAlpha = 1 - laneBlend * (laneConf >= LANE_CONF_STRONG ? 0.7 : 0.45);
    drawEgoPath(now, fcw.level);
    ctx.restore();
    const sorted = [...dets].sort((a, b) => (b.distM ?? 0) - (a.distM ?? 0)); // far first
    for (const d of sorted) drawDetection(d, fcw.danger.has(d));
  }

  /* --- turn signals + tells --- */
  const L = target.lights || {};
  const eco = (target.rpm || 0) > 50 && (target.rpm || 0) < 2800 && (target.mph || 0) > 1;
  elTurnL.classList.toggle('on', !!(L.left || L.hazard) && blink);
  elTurnR.classList.toggle('on', !!(L.right || L.hazard) && blink);
  for (const t of elTells) {
    const key = t.dataset.t; let on;
    if (key === 'left') on = !!(L.left || L.hazard) && blink;
    else if (key === 'right') on = !!(L.right || L.hazard) && blink;
    else if (key === 'hazard') on = !!L.hazard && blink;
    else if (key === 'eco') on = eco;
    else on = !!L[key];
    t.classList.toggle('on', on);
  }

  /* --- vision chip + status --- */
  const fpsN = Math.round(vision.backendFps ?? vision.fps) || 0;
  let vTxt = vmode === 'live' ? `LIVE ${fpsN}fps` : vmode === 'demo' ? 'DEMO VISION' : 'VISION STALE';
  if (vmode === 'live' && laneConf >= 0.2) {
    vTxt += ` · lanes ${Math.round(laneConf * 100)}%`;
  }
  const vCol = vmode === 'live' ? '#34d058' : vmode === 'demo' ? '#ffb020' : '#ff3b30';
  if (elVsrcText.textContent !== vTxt) {
    elVsrcText.textContent = vTxt;
    elVsrcDot.style.background = vCol; elVsrcDot.style.boxShadow = `0 0 8px ${vCol}`;
  }
  elVisStat.textContent = 'VISION ' + vTxt;

  /* --- link + seq + clock --- */
  const lk = target.link || 'stale';
  if (lk !== lastLink) {
    lastLink = lk;
    elLinkText.textContent = lk.toUpperCase();
    const c = lk === 'live' ? '#34d058' : lk === 'demo' ? '#ffb020' : '#ff3b30';
    elLinkDot.style.background = c; elLinkDot.style.boxShadow = `0 0 8px ${c}`;
  }
  elSeq.textContent = 'seq ' + (target.seq || 0);
  const d = new Date();
  elClock.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

}

window.addEventListener('resize', fit);
fit();
requestAnimationFrame(frame);
