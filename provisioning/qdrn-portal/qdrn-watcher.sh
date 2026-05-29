#!/usr/bin/env bash
# QDRN captive-portal watcher.
#
# Toggles between hotspot mode and connected mode based on real connectivity:
#   - If we're online via any non-hotspot connection -> tear our hotspot down.
#   - Otherwise -> bring the QDRN-Radar-Setup hotspot up and start the Flask
#     captive portal so the owner can pick their network.
#
# Uses NetworkManager's own AP code (`ipv4.method shared`) for the hotspot, so
# DHCP + NAT just work without us shelling dnsmasq ourselves. The DNS hijack
# that makes phones auto-pop the captive portal lives in
# /etc/NetworkManager/dnsmasq-shared.d/qdrn-portal.conf.
set -u

HOTSPOT_NAME='qdrn-hotspot'
HOTSPOT_SSID='QDRN-Radar-Setup'
PORTAL_SVC='qdrn-portal.service'
IFACE='wlan0'
SLEEP_OFFLINE=15
SLEEP_ONLINE=30

ensure_hotspot_profile() {
  if ! nmcli -t -f NAME connection show | grep -qx "$HOTSPOT_NAME"; then
    nmcli connection add type wifi ifname "$IFACE" con-name "$HOTSPOT_NAME" \
      autoconnect no ssid "$HOTSPOT_SSID" \
      802-11-wireless.mode ap 802-11-wireless.band bg \
      ipv4.method shared >/dev/null
  fi
}

is_hotspot_active() {
  nmcli -t -f NAME,STATE connection show --active | grep -q "^${HOTSPOT_NAME}:activated$"
}

is_other_online() {
  # Online if any active connection that ISN'T our hotspot is "activated".
  while IFS=: read -r name state; do
    [[ "$name" == "$HOTSPOT_NAME" ]] && continue
    [[ "$state" == "activated" ]] && return 0
  done < <(nmcli -t -f NAME,STATE connection show --active)
  return 1
}

ensure_hotspot_profile

while true; do
  if is_other_online; then
    if is_hotspot_active; then
      echo "Online via another connection — tearing down hotspot"
      nmcli connection down "$HOTSPOT_NAME" >/dev/null 2>&1 || true
    fi
    systemctl stop "$PORTAL_SVC" 2>/dev/null || true
    sleep "$SLEEP_ONLINE"
  else
    if ! is_hotspot_active; then
      echo "Offline — bringing up hotspot"
      nmcli connection up "$HOTSPOT_NAME" >/dev/null 2>&1 || true
      sleep 3
    fi
    systemctl start "$PORTAL_SVC" 2>/dev/null || true
    sleep "$SLEEP_OFFLINE"
  fi
done
