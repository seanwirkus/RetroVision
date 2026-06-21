/* Cluster configuration — edit this file, no rebuild needed.
 *
 * The dashboard talks to TWO sources:
 *   1. Local telemetry  (serial_bridge.py /ws on this same host) — always on.
 *   2. Off-Pi vision    (VisionLab yolo_server.py on a laptop / mini-PC) — optional.
 *
 * The Raspberry Pi 3B+ does NOT run YOLO. Object detection runs on a beefier
 * machine; the Pi only renders the detections it receives. If no vision source
 * is configured (or it is unreachable), the perception HUD still runs on
 * telemetry and shows synthetic demo blips so the panel never looks dead.
 */

const qs = new URLSearchParams(window.location.search);
const visionHostParam = qs.get('visionHost');
if (visionHostParam !== null) {
  const trimmedVisionHost = visionHostParam.trim();
  if (trimmedVisionHost) window.localStorage.setItem('visionHost', trimmedVisionHost);
  else window.localStorage.removeItem('visionHost');
}
const localDevVisionHost = window.location.hostname === 'localhost' ? 'localhost' : null;
// Candidate off-Pi YOLO hosts = the Mac running yolo_server.py on common networks.
// The dashboard rotates through these automatically, so the Pi survives hotspot/LAN
// changes without editing this file every time.
const FALLBACK_VISION_HOST = '192.168.12.162';
const DEFAULT_VISION_HOSTS = [
  FALLBACK_VISION_HOST,   // current TMOBILE-693A address
  '100.64.75.99',         // Tailscale address
  '192.168.1.182',        // home LAN address used earlier
];
// Priority: explicit ?visionHost= param → the host serving this page (self-
// contained appliance: box runs dashboard AND vision on the same IP) → saved
// value → known fallbacks. The serving host comes early so an all-in-one box
// "just works" and survives IP changes without editing this file.
const servingHost = (window.location.hostname && window.location.hostname !== 'localhost')
  ? window.location.hostname : null;
const configuredVisionHosts = [
  (visionHostParam || '').trim(),
  localDevVisionHost,
  servingHost,
  window.localStorage.getItem('visionHost'),
  FALLBACK_VISION_HOST,
  ...DEFAULT_VISION_HOSTS,
].filter((host, index, hosts) => host && hosts.indexOf(host) === index);
const configuredVisionHost = configuredVisionHosts[0] || null;
const configuredVisionWs = configuredVisionHost ? `ws://${configuredVisionHost}:8766/ws` : null;
const configuredVisionMjpeg = configuredVisionHost ? `http://${configuredVisionHost}:8766/video_feed` : null;

window.CLUSTER_CONFIG = {
  // ---- design canvas (GeeekPi 11.26" 1920x440 panel) ----
  BASE_W: 1920,
  BASE_H: 440,

  // ---- gauge ranges ----
  TACH_REDLINE: 6500,   // WRX EJ25 redline-ish
  TACH_MAX: 7000,
  SPEED_MAX: 160,       // mph full-scale on the ring

  // ---- off-Pi vision source ----
  // Point these at the machine running VisionLab/yolo_server.py.
  // Local Mac dev at localhost auto-connects to localhost:8766.
  // On the Pi, launch with:
  //   http://192.168.1.236:8000/?visionHost=<laptop-ip>
  // or set localStorage.visionHost in Chromium.
  // Example:
  //   VISION_WS:    'ws://192.168.1.50:8766/ws',
  //   VISION_MJPEG: 'http://192.168.1.50:8766/video_feed',
  VISION_HOST: configuredVisionHost,
  VISION_HOSTS: configuredVisionHosts,
  VISION_WS: configuredVisionWs,
  VISION_MJPEG: configuredVisionMjpeg,

  // Show the off-Pi camera image as a picture-in-picture in the HUD corner.
  SHOW_CAM_PIP: true,

  // Detection geometry (matches VisionLab distance.py output).
  // NOTE: xRelM/distM field names are misleading — values are actually FEET, not meters.
  HUD_RANGE_MIN_FT: 7,      // distance.py MIN_HUD_RANGE_FT
  HUD_RANGE_MAX_FT: 160,    // distance.py MAX_HUD_RANGE_FT — far traffic spreads in depth
  HUD_LATERAL_FT: 28,       // distance.py lateral clamp ±30 ft

  // Perception HUD perspective (true 1/distance pinhole projection).
  HUD_HORIZON_FRAC: 0.38,   // vanishing-point row — matches distance.py horizon_frac=0.38
  HUD_NEAR_FRAC: 0.97,      // closest-range row
  HUD_ROAD_HALF_FT: 18,     // half lane+shoulder width — room for oncoming/side traffic
  CAM_HFOV_DEG: 100,         // matches distance.py CAMERA_H_FOV_DEG

  // Forward-collision thresholds.
  TTC_WARN_S: 4.0,      // amber
  TTC_DANGER_S: 2.0,    // red
  NEAR_WARN_FT: 22,     // amber if closer, regardless of TTC

  // ---- Scene mode (generated retro driving scenes) ----
  // A "less realtime, more visual" view: instead of frame-accurate perception,
  // infer the driving type from telemetry + coarse vision and paint a stylised
  // synthwave scene that matches it. Toggle live with "s"; force with ?scene=1/0.
  SCENE_MODE_DEFAULT: true,   // start in scene mode (set false to default to the perception HUD)
  SCENE: {
    SCROLL_SPEED_REF: 60,     // mph that maps to full parallax flow
    SWITCH_HOLD_MS: 2600,     // a new driving-type must lead this long before the scene switches
    STAT_WINDOW_MS: 12000,    // rolling speed window for avg/variance/stop-fraction
    HORIZON_FRAC: 0.52,       // horizon row as a fraction of panel height
  },

  // ---- Intersection timer (Urus-style countdown) ----
  INTERSECTION: {
    DEFAULT_RED_MS: 28000,    // assumed red-light length before the model has learned anything
    STOP_HOLD_MS: 3000,       // required full-stop dwell at a stop sign
    NEAR_FT: 130,             // an intersection object within this range counts as "ahead"
    LATERAL_FT: 16,           // |lateral| within this counts as in our path
    STOPPED_MPH: 2,           // at/under this we treat the car as stopped
    GO_MPH: 4,                // rolling above this after a wait => moving off
    LEARN_ALPHA: 0.3,         // EMA weight applied to each newly observed red duration
    FRESH_MS: 900,            // how long an intersection stays "seen" after the last detection
    // intelligence: presence belief + green detection
    CONF_SHOW: 0.45,          // presence-confidence needed before the widget appears
    GREEN_CONFIRM_FRAMES: 2,  // consecutive GREEN frames before the light is trusted green
    RED_CONFIRM_FRAMES: 2,    // consecutive RED frames before the light is trusted red
    LEAD_MOVE_FT: 8,          // lead vehicle range opening this much => traffic is moving (=> green)
    BRAKE_DECEL_MPHS: 3,      // braking this hard near a signal corroborates an intersection
  },
};
