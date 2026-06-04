# Car Cluster (Raspberry Pi)

Complete dashboard UI for the **GeeekPi 11.26" 1920×440** HDMI touch panel,
driven by a **Raspberry Pi 3B+**, fed by the **ESP32-C3 sensor hub** over USB serial.
The cluster fuses the **ImprezaUI** WRX gauge skin with the **VisionLab** perception
HUD into one screen.

```
ESP32-C3 (RPM, speed, fuel, temp, lights)
   │  USB serial  (/dev/ttyACM0, 115200, one JSON line per tick)
   ▼
serial_bridge.py  ──  FastAPI: serves web/ + telemetry on /ws
   │  WebSocket JSON
   ▼                                    off-Pi machine (laptop / mini-PC)
web/  ──  Chromium kiosk 1920×440   ◀── VisionLab yolo_server.py (YOLO + camera)
          ImprezaUI skin +               │  detections on /ws, MJPEG on /video_feed
          VisionLab perception HUD       └─ wired via VISION_WS in web/config.js
```

**The Pi 3B+ never runs YOLO** — too slow for live inference (~1–3 fps, pegs all
cores). Detection runs on a separate machine and is streamed in; the Pi only renders.
With no vision source the HUD still runs on telemetry and shows synthetic demo blips.

## Files
| Path | Purpose |
|------|---------|
| `serial_bridge.py` | Reads C3 over USB serial → WebSocket JSON. Has `--demo`. |
| `web/index.html` `web/style.css` | Cluster layout + WRX skin for 1920×440. |
| `web/dashboard.js` | Ring gauges + VisionLab perception HUD + dual WebSocket. |
| `web/config.js` | **Edit this:** gauge ranges + off-Pi `VISION_WS` / `VISION_MJPEG`. |
| `web/_legacy/` | Pre-merge canvas UI (backup). |
| `scripts/start.sh` | Launch bridge + Chromium kiosk. |
| `scripts/install_kiosk.sh` | One-time Pi autostart + boot tuning (desktop session, ~40–60s boot). |
| `scripts/install_fast_kiosk.sh` | **Fast boot:** systemd bridge + cage/chromium, no desktop (~12–20s). |
| `scripts/push.sh` | **Mac→Pi push:** rsync web/ to Pi, auto-reloads Chromium. |
| `scripts/boot_diagnose.sh` | Show `systemd-analyze` blame on the Pi. |
| `scripts/install_wifi.sh` | Save multiple WiFi networks on the Pi (NetworkManager). |
| `scripts/copy_wifi_to_sd.sh` | Copy WiFi config to SD `bootfs` from your Mac. |
| `firmware_patch.md` | The one-line C3 change to emit data on USB. |

## Quick start (dev on Mac — no hardware)
```bash
cd ~/Documents/RaspberryPi
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 serial_bridge.py --demo
# open http://localhost:8000  (resize window very wide to see the cluster layout)
```

## On the Raspberry Pi (real data)
1. Apply `firmware_patch.md` to the C3 and flash it.
2. Plug the C3 into the Pi USB. Confirm `ls /dev/ttyACM*`.
3. ```bash
   cd ~/Documents/RaspberryPi
   pip install -r requirements.txt        # or use install_kiosk.sh
   scripts/start.sh                        # auto-detects the C3, else demo
   ```
4. Autostart on boot: `scripts/install_kiosk.sh` then reboot.

## Telemetry schema (what the UI consumes on /ws)
```json
{
  "rpm": 3450, "mph": 62, "fuelPct": 73,
  "tempC": 22.5, "humidity": 44.0, "distanceCm": null,
  "lights": { "head": false, "left": true, "right": false, "brake": false, "hazard": false },
  "status": { "fuelConnected": true, "tachLocked": true, "vssActive": true, "distanceValid": false, "dhtValid": true },
  "seq": 1234, "link": "live", "ts": 1716950000.0
}
```
`link`: `live` (fresh serial), `stale` (no data >1s), `demo` (synthetic).

## Layout (1920×440)
`[ left: SPEED ring + coolant/fuel ] · · · [ center: PERCEPTION HUD ] · · · [ right: TACH ring + gear + range/humidity ]`
Center HUD = perspective lane with off-Pi detections, a forward-collision (TTC) banner,
caution wedge, scan sweep, and an optional camera PiP. Tell-tales along the top; status
row (telemetry link, vision source/fps, seq, clock) along the bottom. The whole UI is a
fixed 1920×440 stage scaled to fit the panel.

## Off-Pi vision (VisionLab)
The Pi only renders detections; YOLO runs on a beefier machine.

On the laptop / mini-PC (the `Vision Lab` project — `~/Documents/Vision Lab`
is a symlink to the real folder `~/Desktop/RetroView Ultra/vision-lab`):
```bash
cd ~/Documents/Vision\ Lab
pip install -r requirements.txt
python3 yolo_server.py        # camera + YOLO → :8766  (/ws detections, /video_feed MJPEG)
```
Point the Pi at it with a query string:
```text
http://192.168.1.236:8000/?visionHost=<laptop-ip>
```
`127.0.0.1` / `127.0.1.1` only mean "this same machine." Use `192.168.1.236`
from your Mac or phone to reach the Pi.
Reload the kiosk. The HUD chip reads `LIVE <fps>` when detections arrive, `DEMO VISION`
when no source is set, `VISION STALE` if it drops. `yolo_server.py` already sends
permissive CORS, so nothing else is needed.

## Auto-reload (live dev workflow)
The bridge watches `web/` for file changes and tells Chromium to reload via a
`/ws-reload` WebSocket. Static files are served with `no-cache` headers, so
Chromium always fetches fresh CSS/JS.

**From your Mac:**
```bash
# Edit files locally, then push:
bash scripts/push.sh              # rsync web/ to Pi → auto-reload within ~1s
bash scripts/push.sh --all        # also push serial_bridge.py + scripts/
bash scripts/push.sh --host 100.x.x.x  # use Tailscale IP explicitly
```
Or just `scp` individual files — the watcher detects any change.

## Tailscale (SSH from anywhere)
Both `flash_setup.sh` and `install_fast_kiosk.sh` install Tailscale.
After first boot:
```bash
ssh sean@raspberrypi.local        # or use the Tailscale hostname
sudo tailscale up                 # authenticate + join your tailnet
```
Once connected, you can SSH via `ssh sean@raspberrypi` from any device
on your tailnet, regardless of what WiFi the Pi is on.

## Tuning
- Gauge ranges / redline / vision (TTC) thresholds: `web/config.js`.
- Colors: `:root` in `web/style.css`.
- Telemetry push rate: `PUSH_HZ` in `serial_bridge.py`.

## Faster boot (Chromium in ~12–20s instead of ~40–60s)

The slow path is `install_kiosk.sh`: it waits for the **full Raspberry Pi OS desktop**
(labwc/LightDM, panels, VNC, network wait) and only then autostarts Chromium. That
easily costs 40–60 seconds.

You do **not** need to reflash to fix it — run the fast installer on the Pi:

```bash
cd ~/Documents/RaspberryPi   # or wherever this repo lives on the Pi
bash scripts/install_fast_kiosk.sh
sudo reboot
```

That script:
- Starts `serial_bridge.py` under **systemd** at boot (before the display).
- Launches **Chromium inside `cage`** on tty1 (minimal Wayland compositor, no desktop).
- Disables LightDM, `NetworkManager-wait-online`, and the desktop autostart entry.
- Sets quiet boot + `disable_splash` / `boot_delay=0`.

After reboot, check timing:

```bash
bash scripts/boot_diagnose.sh
```

### Reflash option (fastest, ~8–12s boot)

If you want the absolute minimum image:

1. Flash **[Raspberry Pi OS Lite (64-bit)](https://www.raspberrypi.com/software/)** (no desktop).
   - In Raspberry Pi Imager: enable SSH, set user to `sean`, set hostname to `raspberrypi`.
   - Optionally pre-configure WiFi to `BBOPHOUSE` / `Simon.123` in the imager.
2. Boot, SSH in: `ssh sean@raspberrypi.local`
3. Copy this entire repo to the Pi:
   ```bash
   # From your Mac:
   scp -r ~/Documents/RasberryPi sean@raspberrypi.local:~/Documents/RaspberryPi
   ```
4. Run the all-in-one setup (installs deps, WiFi, kiosk, boot tuning):
   ```bash
   bash ~/Documents/RaspberryPi/scripts/flash_setup.sh
   ```
5. Reboot → dashboard auto-launches on the 1920×440 screen.

You do **not** need to touch ESP32-C3 firmware for Chromium boot time — that only
affects sensor data over USB (`firmware_patch.md`).

## WiFi (multiple networks, auto-connect)

| Network | Password | Priority |
|---------|----------|----------|
| BBOPHOUSE | Simon.123 | highest (home) |
| TMOBILE-693A | 8svtkb75frx | high (T-Mobile hotspot) |
| Sean's iPhone / Sean iPhone | mangomeow | high (phone hotspot) |
| UCSD-GUEST | (open) | fallback (library) |

**Mac + SD card inserted:** `bash scripts/copy_wifi_to_sd.sh` then eject and boot.

**On the Pi:** `bash scripts/install_wifi.sh` (persists in NetworkManager; preferred).

UCSD-GUEST still needs a one-time captive portal accept in a browser (`http://neverssl.com`).

### Revert to desktop autostart

```bash
sudo systemctl disable car-cluster-kiosk car-cluster-bridge
sudo systemctl set-default graphical.target
sudo systemctl enable lightdm
mv ~/.config/autostart/car-cluster.desktop.disabled ~/.config/autostart/car-cluster.desktop
sudo reboot
```
