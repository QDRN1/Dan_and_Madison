#!/usr/bin/env bash
# Installs balena's wifi-connect for the correct CPU architecture and applies the
# QDRN-branded captive portal UI. Invoked by provisioning/install.sh; safe to run
# standalone and to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# v4.4.6 (the long-time default) crashes on current Pi OS NetworkManager —
# "RsnFlags ... wrong property type" — because NM changed the property type
# years ago. v4.11.x handles both old and new.
VERSION="${WIFI_CONNECT_VERSION:-v4.11.84}"

# Pick the right release asset for this CPU. The Pi 4 on 64-bit Pi OS is aarch64;
# balena's "-rpi" asset is 32-bit armv7 and will not run there.
case "$(uname -m)" in
  aarch64 | arm64) ASSET="aarch64" ;;
  armv7l | armv6l) ASSET="rpi" ;;
  x86_64) ASSET="x86_64" ;;
  *) ASSET="aarch64" ;;
esac

URL="https://github.com/balena-os/wifi-connect/releases/download/${VERSION}/wifi-connect-${VERSION}-linux-${ASSET}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading wifi-connect ${VERSION} (${ASSET})..."
curl -fsSL "$URL" -o "$TMP/wc.tar.gz"
tar -xzf "$TMP/wc.tar.gz" -C "$TMP"

install -m 755 "$TMP/wifi-connect" /usr/local/sbin/wifi-connect
mkdir -p /usr/local/share/wifi-connect
rm -rf /usr/local/share/wifi-connect/ui
cp -r "$TMP/ui" /usr/local/share/wifi-connect/ui

# Overlay QDRN branding if present.
if [[ -d "$HERE/ui" ]]; then
  echo "Applying QDRN captive-portal branding"
  cp -r "$HERE/ui/." /usr/local/share/wifi-connect/ui/
fi

# wifi-connect needs NetworkManager (default on Raspberry Pi OS Bookworm/Trixie).
if ! systemctl is-active NetworkManager >/dev/null 2>&1; then
  echo "WARNING: NetworkManager is not active. wifi-connect requires it — on"
  echo "         current Raspberry Pi OS it's the default. Check your network stack."
fi

/usr/local/sbin/wifi-connect --version && echo "wifi-connect OK. Hotspot SSID: QDRN-Radar-Setup"
