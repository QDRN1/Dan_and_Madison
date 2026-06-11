#!/usr/bin/env bash
# Installs the QDRN captive portal: NetworkManager hotspot + Flask portal +
# watcher service. Replaces our earlier comitup install (which is brittle on
# Pi OS Trixie's NetworkManager).
#
# Safe to re-run.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# 1. Tear down comitup if it's still around (don't apt-remove — its postinst
#    monkeys with NM and removal can leave the system in odd states).
for u in comitup.service comitup-web.service; do
  if systemctl list-unit-files "$u" >/dev/null 2>&1; then
    systemctl disable --now "$u" 2>/dev/null || true
  fi
done

# 2. Install Python + Flask from apt (no pip, no venv — keep it simple).
DEBIAN_FRONTEND=noninteractive apt-get install -y python3-flask

# 3. Drop the portal files into place.
install -m 755 "$HERE/qdrn-portal.py"          /usr/local/sbin/qdrn-portal.py
install -m 755 "$HERE/qdrn-watcher.sh"         /usr/local/sbin/qdrn-watcher.sh
install -m 644 "$HERE/qdrn-portal.service"     /etc/systemd/system/qdrn-portal.service
install -m 644 "$HERE/qdrn-watcher.service"    /etc/systemd/system/qdrn-watcher.service
install -d -m 755                              /etc/NetworkManager/dnsmasq-shared.d
install -m 644 "$HERE/qdrn-portal-shared.conf" /etc/NetworkManager/dnsmasq-shared.d/qdrn-portal.conf

# 4. Deploy brand assets the portal serves (logo + Captain Q favicon).
install -d -m 755 /usr/local/share/qdrn-portal/static
if [[ -f "$REPO_ROOT/brand/QDRN Radar Long.png" ]]; then
  install -m 644 "$REPO_ROOT/brand/QDRN Radar Long.png"  /usr/local/share/qdrn-portal/static/logo.png
elif [[ -f "$REPO_ROOT/brand/QDRN Radar.png" ]]; then
  install -m 644 "$REPO_ROOT/brand/QDRN Radar.png"       /usr/local/share/qdrn-portal/static/logo.png
fi
[[ -f "$REPO_ROOT/brand/CaptainQIcon-BGRVD.PNG" ]] && \
  install -m 644 "$REPO_ROOT/brand/CaptainQIcon-BGRVD.PNG" /usr/local/share/qdrn-portal/static/captain-q.png

# 5. Make NetworkManager actually use dnsmasq for shared connections (it does
#    by default, but a `dns=` override in NetworkManager.conf can disable it).
#    Drop a low-priority conf snippet to be safe.
mkdir -p /etc/NetworkManager/conf.d
cat >/etc/NetworkManager/conf.d/00-qdrn-portal.conf <<'EOF'
# Ensure NM uses dnsmasq for shared connections so our dnsmasq-shared.d
# captive-portal DNS hijack applies.
[main]
dns=dnsmasq
EOF
systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager || true

# 6. Enable + start the watcher. Portal service is started/stopped by the
#    watcher on demand (so it doesn't try to bind :80 when not in hotspot mode).
systemctl daemon-reload
systemctl enable qdrn-watcher.service
systemctl restart qdrn-watcher.service

echo
echo "QDRN captive portal installed."
echo "  - When the Pi has a working network, the watcher is dormant."
echo "  - Otherwise it brings up SSID  QDRN-Radar-Setup"
echo "    and serves the captive portal at  http://10.42.0.1/"
