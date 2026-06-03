#!/usr/bin/env bash
# Save multiple WiFi networks on the Pi (NetworkManager). Run on the Pi itself.
# Networks are tried automatically; higher autoconnect-priority wins when several are visible.
set -euo pipefail

add_wifi() {
  local name="$1"
  local ssid="$2"
  local psk="${3:-}"
  local priority="$4"

  if nmcli -t -f NAME connection show 2>/dev/null | grep -Fxq "$name"; then
    echo ">> Updating $name"
    nmcli connection modify "$name" \
      connection.autoconnect yes \
      connection.autoconnect-priority "$priority"
    if [ -n "$psk" ]; then
      nmcli connection modify "$name" wifi-sec.psk "$psk"
    fi
    return
  fi

  echo ">> Adding $name ($ssid)"
  if [ -n "$psk" ]; then
    nmcli connection add type wifi ifname wlan0 con-name "$name" ssid "$ssid" \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" \
      ipv4.method auto ipv6.method auto \
      connection.autoconnect yes connection.autoconnect-priority "$priority"
  else
    nmcli connection add type wifi ifname wlan0 con-name "$name" ssid "$ssid" \
      wifi-sec.key-mgmt none \
      ipv4.method auto ipv6.method auto \
      connection.autoconnect yes connection.autoconnect-priority "$priority"
  fi
}

if ! command -v nmcli >/dev/null 2>&1; then
  echo "NetworkManager (nmcli) not found. Run on Raspberry Pi OS." >&2
  exit 1
fi

add_wifi "BBOPHOUSE"        "BBOPHOUSE"        "Simon.123"    100
add_wifi "TMOBILE-693A"     "TMOBILE-693A"     "8svtkb75frx"   95
add_wifi "Seans-iPhone"     "Sean's iPhone"    "mangomeow"     90
add_wifi "Sean-iPhone-alt"  "Sean iPhone"      "mangomeow"     90
add_wifi "UCSD-GUEST"       "UCSD-GUEST"       ""              10

echo ">> Reloading WiFi"
nmcli connection reload
nmcli device wifi rescan || true
nmcli device connect wlan0 2>/dev/null || true

echo
echo "Saved networks:"
nmcli -f NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show | grep -E 'wifi|NAME' || true
echo
echo "Current connection:"
nmcli -f GENERAL.STATE,IP4.ADDRESS device show wlan0 2>/dev/null || true
echo
echo "Note: UCSD-GUEST needs captive portal accept in a browser (neverssl.com) once per visit."
