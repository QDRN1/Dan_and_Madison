#!/usr/bin/env bash
# Install pre-baked WiFi profiles (HobbitHouse, LAN-Down-Under) so the radar
# auto-joins them silently whenever they're in range. The Settings UI hides
# these from the saved-networks list unless the SSID also shows up in the
# current scan — so the friend doesn't see networks they have no business
# seeing — but `nmcli connection delete` still works if the user ever wants
# to forget them.
#
# Passwords live in provisioning/baked-wifi.local.conf (gitignored). That
# file is written once at provisioning time; nothing about it survives in
# the repo. If the file doesn't exist, this script is a no-op.
#
# Profile priority is 90 (higher than 50 used for user-added) so when the
# radar is at HobbitHouse or LAN-Down-Under it prefers those over any
# weaker network the friend may have once added.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_DIR/provisioning/baked-wifi.local.conf"

if [[ ! -f "$CONF" ]]; then
  echo "no baked-wifi.local.conf — skipping pre-baked networks"
  exit 0
fi

# Format: SSID<TAB>PSK on each line. Lines starting with # are comments.
while IFS=$'\t' read -r ssid psk; do
  [[ -z "${ssid:-}" || "${ssid:0:1}" == "#" ]] && continue
  if nmcli -t -f NAME connection show | grep -qx "$ssid"; then
    # Profile already exists — refresh the password in case it rotated,
    # and re-assert autoconnect priority.
    nmcli connection modify "$ssid" \
      wifi-sec.psk "$psk" \
      connection.autoconnect yes \
      connection.autoconnect-priority 90 >/dev/null
  else
    nmcli connection add type wifi con-name "$ssid" ifname '*' \
      ssid "$ssid" \
      wifi-sec.key-mgmt wpa-psk \
      wifi-sec.psk "$psk" \
      connection.autoconnect yes \
      connection.autoconnect-priority 90 >/dev/null
  fi
  echo "baked: $ssid"
done < "$CONF"
