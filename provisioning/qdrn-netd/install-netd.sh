#!/usr/bin/env bash
# Installs qdrn-netd — a host-side helper the radar container talks to over
# a Unix socket to add/remove/list NetworkManager WiFi profiles.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 755 "$HERE/qdrn-netd.py"      /usr/local/sbin/qdrn-netd.py
install -m 644 "$HERE/qdrn-netd.service" /etc/systemd/system/qdrn-netd.service

# Tell qdrn-netd which checkout to `git pull` / `docker compose` against when
# the admin "Pull update" button fires. Repo root is two dirs up from us.
REPO_DIR="$(cd "$HERE/../.." && pwd)"
install -m 644 /dev/stdin /etc/default/qdrn-netd <<EOF
# Auto-written by install-netd.sh. Path to the QDRN Radar repo checkout.
QDRN_REPO=$REPO_DIR
EOF

systemctl daemon-reload
systemctl enable --now qdrn-netd.service

# Quick sanity check
sleep 1
if [[ -S /run/qdrn-net.sock ]]; then
  echo "qdrn-netd installed and listening on /run/qdrn-net.sock"
else
  echo "qdrn-netd installed but the socket isn't up yet — check 'journalctl -u qdrn-netd'"
fi
