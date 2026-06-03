#!/usr/bin/env bash
# Fast-boot kiosk: systemd bridge + cage/chromium on tty1 (skip full desktop).
# Run on the Pi as your normal user. Reboot when finished.
#
# Expected boot-to-cluster: ~12–20s on Pi 4/5 (vs ~40–60s with desktop autostart).
# For the fastest path (~8–12s), flash Pi OS Lite and run this script there.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"
USER_UID="$(id -u)"
BRIDGE_UNIT="/etc/systemd/system/car-cluster-bridge.service"
KIOSK_UNIT="/etc/systemd/system/car-cluster-kiosk.service"
AUTOSTART="$HOME/.config/autostart/car-cluster.desktop"

echo ">> Installing packages (cage, chromium, curl, seatd)"
sudo apt-get update -qq
sudo apt-get install -y cage chromium curl seatd

echo ">> Python deps (RPi OS trixie is externally-managed + ships no pip; prefer apt)"
if ! sudo apt-get install -y python3-fastapi python3-uvicorn python3-serial python3-websockets; then
  sudo apt-get install -y python3-pip
  python3 -m pip install --break-system-packages -r "$DIR/requirements.txt"
fi

echo ">> Serial access for /dev/ttyACM*"
sudo usermod -aG dialout "$USER_NAME" || true
sudo usermod -aG video "$USER_NAME" || true

echo ">> Installing Tailscale (remote SSH access from anywhere)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable tailscaled
sudo systemctl start tailscaled 2>/dev/null || true
echo "   Tailscale installed. Run 'sudo tailscale up' after reboot to authenticate."

echo ">> seatd (gives cage a DRM/VT seat with no desktop session)"
sudo systemctl enable --now seatd
SEATGRP="$(stat -c %G /run/seatd.sock 2>/dev/null || echo video)"
sudo usermod -aG "$SEATGRP" "$USER_NAME" || true

CHROMIUM=""
for c in /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -x "$c" ] && CHROMIUM="$c" && break
done
if [ -z "$CHROMIUM" ]; then
  echo "Chromium not found after install." >&2
  exit 1
fi

echo ">> Installing systemd units"
sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__UID__|$USER_UID|g" \
    -e "s|__DIR__|$DIR|g" \
    "$DIR/scripts/car-cluster-bridge.service" | sudo tee "$BRIDGE_UNIT" >/dev/null

sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__UID__|$USER_UID|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__CHROMIUM__|$CHROMIUM|g" \
    "$DIR/scripts/car-cluster-kiosk.service" | sudo tee "$KIOSK_UNIT" >/dev/null

echo ">> Disabling slow desktop autostart (if present)"
if [ -f "$AUTOSTART" ]; then
  mv "$AUTOSTART" "${AUTOSTART}.disabled"
  echo "   Renamed $AUTOSTART -> ${AUTOSTART}.disabled"
fi

echo ">> Boot tuning"
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt

append_config() {
  local key="$1"
  grep -qE "^${key}=" "$CONFIG" 2>/dev/null || echo "$key=1" | sudo tee -a "$CONFIG" >/dev/null
}

append_config disable_splash
grep -qE '^boot_delay=' "$CONFIG" 2>/dev/null || echo "boot_delay=0" | sudo tee -a "$CONFIG" >/dev/null

# Quiet kernel + skip long network wait at boot (local dashboard does not need WAN).
if ! grep -q ' loglevel=3 ' "$CMDLINE"; then
  sudo sed -i 's/$/ quiet loglevel=3/' "$CMDLINE"
fi

echo ">> Disabling desktop login manager + network boot wait"
sudo systemctl disable lightdm.service 2>/dev/null || true
sudo systemctl mask getty@tty1.service 2>/dev/null || true   # cage owns tty1; stop getty VT ping-pong
sudo systemctl disable gdm.service 2>/dev/null || true
sudo systemctl disable sddm.service 2>/dev/null || true
sudo systemctl disable wayvnc.service 2>/dev/null || true
sudo systemctl disable NetworkManager-wait-online.service 2>/dev/null || true
sudo systemctl disable systemd-networkd-wait-online.service 2>/dev/null || true

sudo systemctl set-default multi-user.target

sudo systemctl daemon-reload
sudo systemctl enable car-cluster-bridge.service car-cluster-kiosk.service

echo
echo "Done. Reboot to test fast boot:"
echo "  sudo reboot"
echo
echo "After reboot, check timing:"
echo "  systemd-analyze"
echo "  systemd-analyze blame | head -20"
echo
echo "To revert to desktop autostart:"
echo "  sudo systemctl disable car-cluster-kiosk car-cluster-bridge"
echo "  sudo systemctl set-default graphical.target"
echo "  sudo systemctl enable lightdm"
echo "  mv ${AUTOSTART}.disabled $AUTOSTART 2>/dev/null || true"
