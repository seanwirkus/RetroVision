#!/usr/bin/env bash
# One-time setup on Raspberry Pi OS (Bookworm) to auto-launch the cluster on boot.
# Review before running. Run as the normal 'pi' user (not root); it uses sudo where needed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"

echo ">> Installing Python deps"
python3 -m pip install --break-system-packages -r "$DIR/requirements.txt"

echo ">> Creating autostart entry for the kiosk"
# Desktop session autostart (labwc/wayfire/LXDE all read ~/.config/autostart/*.desktop)
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/car-cluster.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Car Cluster
Exec=$DIR/scripts/start.sh
X-GNOME-Autostart-enabled=true
EOF

echo ">> Boot-speed tuning (optional, edits /boot/firmware/config.txt + cmdline.txt)"
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
if ! grep -q "disable_splash=1" "$CONFIG"; then
  echo "disable_splash=1" | sudo tee -a "$CONFIG" >/dev/null
fi
# Quiet boot + skip waiting for network at boot are left for you to add manually.

echo ">> Give this user serial access (dialout group) for /dev/ttyACM*"
sudo usermod -aG dialout "$USER_NAME" || true

echo
echo "Done. Reboot to test. The cluster autostarts in Chromium kiosk."
echo "For fast boot (~12–20s), use: bash scripts/install_fast_kiosk.sh  (see README)."
