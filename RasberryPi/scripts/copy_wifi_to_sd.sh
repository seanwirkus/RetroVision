#!/usr/bin/env bash
# Copy multi-network WiFi config onto the Pi SD boot partition (bootfs) from your Mac.
# Insert the SD card, then: bash scripts/copy_wifi_to_sd.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT="/Volumes/bootfs"

if [ ! -d "$BOOT" ]; then
  echo "SD boot partition not found at $BOOT" >&2
  echo "Insert the Pi SD card — it should mount as 'bootfs' in Finder." >&2
  exit 1
fi

echo ">> Copying WiFi config to $BOOT"
cp "$DIR/scripts/wifi/network-config" "$BOOT/network-config"
cp "$DIR/scripts/wifi/wpa_supplicant.conf" "$BOOT/wpa_supplicant.conf"

META="$BOOT/meta-data"
if [ -f "$META" ]; then
  STAMP="$(date +%Y%m%d%H%M)"
  if grep -q '^instance_id:' "$META"; then
    sed -i '' "s/^instance_id:.*/instance_id: rpios-wifi-${STAMP}/" "$META"
  else
    echo "instance_id: rpios-wifi-${STAMP}" >> "$META"
  fi
  echo ">> Bumped cloud-init instance_id so WiFi config re-applies on next boot"
fi

touch "$BOOT/ssh" 2>/dev/null || true

echo
echo "Done. Eject SD card safely, boot the Pi."
echo "Networks saved: BBOPHOUSE, TMOBILE-693A, Sean's iPhone, Sean iPhone, UCSD-GUEST"
echo "On the Pi (or after first boot), also run: bash scripts/install_wifi.sh"
