#!/usr/bin/env bash
# Launch the QDRN setup captive portal ONLY when the Pi has no network yet.
# Runs once at boot: if already online (normal case), it exits cleanly; if there
# is no connection (e.g. the friend's WiFi password changed, or first boot at
# their house), it opens the "QDRN-Radar-Setup" hotspot so they can reconnect.
set -u

if nm-online -q -t 30; then
  echo "QDRN: already online — captive portal not needed."
  exit 0
fi

echo "QDRN: no network — starting captive portal (SSID: QDRN-Radar-Setup)"
exec /usr/local/sbin/wifi-connect --portal-ssid "QDRN-Radar-Setup"
