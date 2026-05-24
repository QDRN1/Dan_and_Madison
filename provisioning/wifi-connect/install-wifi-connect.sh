#!/usr/bin/env bash
# Installs balena's wifi-connect binary and applies the QDRN-branded captive
# portal UI. Invoked by provisioning/install.sh; safe to run standalone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Official installer (sets up the binary + NetworkManager dependency).
bash <(curl -fsSL https://raw.githubusercontent.com/balena-os/wifi-connect/master/scripts/raspbian-install.sh)

# The installer drops the default UI under /usr/local/share/wifi-connect/ui.
# Overlay our QDRN branding (logo + colors) if present.
UI_DEST="/usr/local/share/wifi-connect/ui"
if [[ -d "$HERE/ui" && -d "$UI_DEST" ]]; then
  echo "Applying QDRN captive-portal branding"
  cp -r "$HERE/ui/." "$UI_DEST/"
fi

echo "wifi-connect installed. Hotspot SSID will be 'QDRN-Radar-Setup'."
