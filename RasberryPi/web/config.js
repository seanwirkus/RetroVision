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
const configuredVisionHosts = [
  localDevVisionHost,
  FALLBACK_VISION_HOST,
  (visionHostParam || '').trim(),
  ...DEFAULT_VISION_HOSTS,
  window.localStorage.getItem('visionHost'),
].filter((host, index, hosts) => host && hosts.indexOf(host) === index);
const configuredVisionHost = configuredVisionHosts[0] || null;
const configuredVisionWs = configuredVisionHost ? `ws://${configuredVisionHost}:8766/ws` : null;
const configuredVisionMjpeg = configuredVisionHost ? `http://${configuredVisionHost}:8766/video_feed` : null;

window.CLUSTER_CONFIG = {
  // ---- design canvas (GeeekPi 11.26" panel) ----
  BASE_W: 1920,
  BASE_H: 480,

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
};
