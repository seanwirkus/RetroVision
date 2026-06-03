#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# flash_setup.sh — ONE-TIME first-boot setup for the WRX car cluster.
#
# Flash Raspberry Pi OS Lite (64-bit, no desktop) to SD, boot the Pi, SSH in,
# copy/clone this whole repo to ~/Documents/RaspberryPi, then run:
#
#   bash ~/Documents/RaspberryPi/scripts/flash_setup.sh
#
# What it does (in order):
#   1. apt install minimal deps (cage, chromium, python3-pip, curl)
#   2. pip install FastAPI + uvicorn (serial_bridge.py needs them)
#   3. Configure WiFi (BBOPHOUSE + TMOBILE-693A + Sean iPhone via NetworkManager)
#   4. Add user to dialout + video groups
#   5. Install systemd services (bridge + kiosk)
#   6. Aggressive boot tuning (disable splash, quiet kernel, kill waits)
#   7. Reboot → dashboard up in ~8-12s
#
# Safe to re-run (idempotent).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"
USER_UID="$(id -u "$USER_NAME")"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
[ -n "$USER_HOME" ] || USER_HOME="$HOME"
BRIDGE_UNIT="/etc/systemd/system/car-cluster-bridge.service"
KIOSK_UNIT="/etc/systemd/system/car-cluster-kiosk.service"

echo "╔══════════════════════════════════════════════════╗"
echo "║   WRX Car Cluster — First-Boot Setup             ║"
echo "║   Project: $DIR"
echo "║   User: $USER_NAME (uid $USER_UID)"
echo "╚══════════════════════════════════════════════════╝"
echo

# ── 1. Package install ──────────────────────────────────────────────────────
echo ">> [1/7] Installing packages..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  cage chromium-browser curl python3-pip python3-venv \
  2>/dev/null || \
sudo apt-get install -y --no-install-recommends \
  cage chromium curl python3-pip python3-venv

# ── 2. Python deps ──────────────────────────────────────────────────────────
echo ">> [2/7] Python deps (FastAPI + uvicorn + pyserial)..."
if [ -f "$DIR/requirements.txt" ]; then
  python3 -m pip install --break-system-packages -r "$DIR/requirements.txt" 2>/dev/null || \
  pip3 install --break-system-packages -r "$DIR/requirements.txt"
fi

# ── 3. WiFi (NetworkManager) ────────────────────────────────────────────────
echo ">> [3/7] Configuring WiFi networks..."
if command -v nmcli >/dev/null 2>&1; then
  add_wifi() {
    local name="$1" ssid="$2" psk="${3:-}" priority="$4"
    if sudo nmcli -t -f NAME connection show 2>/dev/null | grep -Fxq "$name"; then
      sudo nmcli connection modify "$name" connection.autoconnect yes \
        connection.autoconnect-priority "$priority"
      [ -n "$psk" ] && sudo nmcli connection modify "$name" wifi-sec.psk "$psk"
    elif [ -n "$psk" ]; then
      sudo nmcli connection add type wifi ifname wlan0 con-name "$name" ssid "$ssid" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" \
        ipv4.method auto ipv6.method auto \
        connection.autoconnect yes connection.autoconnect-priority "$priority"
    else
      sudo nmcli connection add type wifi ifname wlan0 con-name "$name" ssid "$ssid" \
        wifi-sec.key-mgmt none ipv4.method auto ipv6.method auto \
        connection.autoconnect yes connection.autoconnect-priority "$priority"
    fi
  }
  add_wifi "BBOPHOUSE"       "BBOPHOUSE"       "Simon.123"    100
  add_wifi "TMOBILE-693A"    "TMOBILE-693A"    "8svtkb75frx"   95
  add_wifi "Seans-iPhone"    "Sean's iPhone"    "mangomeow"     90
  add_wifi "Sean-iPhone-alt" "Sean iPhone"      "mangomeow"     90
  add_wifi "UCSD-GUEST"      "UCSD-GUEST"       ""              10
  sudo nmcli connection reload
  sudo nmcli device wifi rescan 2>/dev/null || true
  sudo nmcli device connect wlan0 2>/dev/null || true
  echo "   WiFi configured: BBOPHOUSE (pri 100), TMOBILE-693A (95), Sean iPhone (90), UCSD-GUEST (10)"
else
  echo "   WARN: nmcli not found — WiFi not configured via NetworkManager."
  echo "   Falling back to wpa_supplicant.conf on bootfs (if present)."
fi

# ── 4. Tailscale (remote SSH from anywhere) ───────────────────────────────────
echo ">> [4/8] Installing Tailscale..."
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable tailscaled
sudo systemctl start tailscaled 2>/dev/null || true
echo "   Tailscale installed. Run 'sudo tailscale up' after reboot to authenticate."

# ── 5. User groups ──────────────────────────────────────────────────────────
echo ">> [5/8] Serial + video access..."
sudo usermod -aG dialout "$USER_NAME" 2>/dev/null || true
sudo usermod -aG video "$USER_NAME" 2>/dev/null || true

# ── 6. Systemd services ─────────────────────────────────────────────────────
echo ">> [6/8] Installing systemd units..."
CHROMIUM=""
for c in /usr/bin/chromium-browser /usr/bin/chromium; do
  [ -x "$c" ] && CHROMIUM="$c" && break
done
if [ -z "$CHROMIUM" ]; then
  echo "   ERROR: Chromium not found!" >&2; exit 1
fi

sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__UID__|$USER_UID|g" \
    -e "s|__DIR__|$DIR|g" \
    "$DIR/scripts/car-cluster-bridge.service" | sudo tee "$BRIDGE_UNIT" >/dev/null

sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__UID__|$USER_UID|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__CHROMIUM__|$CHROMIUM|g" \
    "$DIR/scripts/car-cluster-kiosk.service" | sudo tee "$KIOSK_UNIT" >/dev/null

# Disable old desktop autostart if present
AUTOSTART="$USER_HOME/.config/autostart/car-cluster.desktop"
[ -f "$AUTOSTART" ] && mv "$AUTOSTART" "${AUTOSTART}.disabled" && echo "   Disabled desktop autostart"

# ── 7. Aggressive boot tuning ───────────────────────────────────────────────
echo ">> [7/8] Boot tuning (targeting <12s)..."

# config.txt
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
for kv in "disable_splash=1" "boot_delay=0" "dtoverlay=disable-bt" "gpu_mem=128"; do
  key="${kv%%=*}"
  if ! grep -qE "^${key}=" "$CONFIG" 2>/dev/null; then
    echo "$kv" | sudo tee -a "$CONFIG" >/dev/null
  fi
done

# cmdline.txt — quiet boot
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if ! grep -q ' quiet ' "$CMDLINE" 2>/dev/null; then
  sudo sed -i 's/$/ quiet loglevel=3 vt.global_cursor_default=0/' "$CMDLINE"
fi

# Disable everything heavy
for svc in \
  lightdm gdm sddm wayvnc \
  NetworkManager-wait-online systemd-networkd-wait-online \
  bluetooth hciuart \
  apt-daily apt-daily-upgrade \
  avahi-daemon ModemManager triggerhappy \
  man-db.timer e2scrub_all.timer fstrim.timer \
  raspi-config rpi-eeprom-update \
  ; do
  sudo systemctl disable "$svc.service" 2>/dev/null || true
  sudo systemctl disable "$svc.timer" 2>/dev/null || true
  sudo systemctl mask "$svc.service" 2>/dev/null || true
done

# multi-user (no desktop)
sudo systemctl set-default multi-user.target

# Enable our units
sudo systemctl daemon-reload
sudo systemctl enable car-cluster-bridge.service car-cluster-kiosk.service

echo "   Disabled: desktop, bluetooth, apt-daily, avahi, modem, etc."
echo "   Enabled:  car-cluster-bridge + car-cluster-kiosk"

# ── 8. Summary ──────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════════════════╗"
echo "║   Setup complete! Reboot to start the dashboard. ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║   sudo reboot                                    ║"
echo "║                                                  ║"
echo "║   After boot, check timing:                      ║"
echo "║     bash $DIR/scripts/boot_diagnose.sh           ║"
echo "║                                                  ║"
echo "║   WiFi: BBOPHOUSE (Simon.123)                    ║"
echo "║         TMOBILE-693A                             ║"
echo "║         Sean iPhone (mangomeow)                  ║"
echo "║                                                  ║"
echo "║   Dashboard: http://<pi-ip>:8000                 ║"
echo "║   Kiosk: auto-launches on 1920x480 screen        ║"
echo "║                                                  ║"
echo "║   Tailscale: run 'sudo tailscale up' to connect  ║"
echo "╚══════════════════════════════════════════════════╝"
echo
read -p "Reboot now? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  sudo reboot
fi
