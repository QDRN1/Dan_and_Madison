#!/usr/bin/env bash
# Installs Dave Steele's `comitup` — a captive-portal hotspot designed for
# Raspberry Pi OS. Replaces balena/wifi-connect, which crashes on current Pi OS
# NetworkManager ("RsnFlags ... wrong property type"). Comitup integrates with
# NetworkManager natively and is the standard choice today.
#
# Safe to re-run.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Add Dave's apt repo (signed) if not already present.
KEYRING=/usr/share/keyrings/davesteele-comitup.gpg
LIST=/etc/apt/sources.list.d/davesteele-comitup.list
if [[ ! -f "$LIST" ]]; then
  echo "Adding davesteele comitup apt repo"
  curl -fsSL https://davesteele.github.io/comitup/deb/davesteele.gpg | gpg --dearmor -o "$KEYRING"
  chmod 644 "$KEYRING"
  printf 'deb [signed-by=%s] https://davesteele.github.io/comitup/deb comitup main\n' "$KEYRING" > "$LIST"
  apt-get update
fi

# 2. Install comitup + its captive-portal web UI.
DEBIAN_FRONTEND=noninteractive apt-get install -y comitup comitup-web

# 3. Apply the QDRN SSID + settings.
install -m 644 "$HERE/comitup.conf" /etc/comitup.conf

# 4. Tear down the old balena/wifi-connect service if present (it's superseded).
if systemctl list-unit-files qdrn-wifi-connect.service >/dev/null 2>&1; then
  systemctl disable --now qdrn-wifi-connect.service 2>/dev/null || true
  rm -f /etc/systemd/system/qdrn-wifi-connect.service
  systemctl daemon-reload
fi

# 5. Enable + restart so the new config takes effect.
systemctl enable comitup.service comitup-web.service 2>/dev/null || true
systemctl restart comitup.service comitup-web.service

echo
echo "comitup is installed."
echo "  - When the Pi is online, comitup is dormant."
echo "  - When the Pi can't reach a known WiFi, it broadcasts SSID  QDRN-Radar-Setup"
echo "    and the captive portal at  http://10.41.0.1/"
