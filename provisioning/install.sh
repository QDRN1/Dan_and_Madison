#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# QDRN Radar — one-shot provisioning for a Raspberry Pi 4 (Raspberry Pi OS).
# Run from the repo root:  sudo bash provisioning/install.sh
# Idempotent — safe to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

log() { printf "\n\033[1;32m==>\033[0m %s\n" "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash provisioning/install.sh" >&2
  exit 1
fi

# ── 1. Enable SSH (for remote access over the Cloudflare tunnel) ──────────────
log "Enabling SSH"
systemctl enable --now ssh 2>/dev/null || raspi-config nonint do_ssh 0 || true

# ── 2. RTL-SDR: blacklist the kernel DVB driver so readsb can claim the dongle ─
log "Blacklisting DVB-T kernel drivers for the SDR"
cat >/etc/modprobe.d/blacklist-rtlsdr.conf <<'EOF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist dvb_usb_v2
EOF
modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

# ── 3. Cooling fan on GPIO3 (kernel-managed via gpio-fan overlay) ────────────
# A 5V fan wired between the 5V rail and GPIO3 is driven directly by the kernel
# — no userspace code, no GPIO access inside the Docker container. Fan turns on
# at 60 °C and back off ~5 °C below (built-in hysteresis). Reboot to apply.
BOOT_CONFIG=""
for c in /boot/firmware/config.txt /boot/config.txt; do
  [[ -f "$c" ]] && BOOT_CONFIG="$c" && break
done
if [[ -n "$BOOT_CONFIG" ]] && ! grep -q '^dtoverlay=gpio-fan' "$BOOT_CONFIG"; then
  log "Enabling kernel gpio-fan overlay on GPIO3 (60 °C threshold) — reboot required"
  printf '\n# QDRN Radar: cooling fan on GPIO3 (60 °C on, ~55 °C off)\ndtoverlay=gpio-fan,gpiopin=3,temp=60000\n' >> "$BOOT_CONFIG"
  FAN_NEEDS_REBOOT=1
fi

# ── 4. Docker + compose plugin ───────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  log "Installing docker compose plugin"
  apt-get update && apt-get install -y docker-compose-plugin
fi
# Let the default 'pi' user run docker without sudo
usermod -aG docker "${SUDO_USER:-pi}" 2>/dev/null || true

# ── 5. WiFi captive portal (comitup) ─────────────────────────────────────────
# Brings up a "QDRN-Radar-Setup" hotspot when the Pi can't reach WiFi, so the
# friend can join it from their phone and pick their home network. We use
# comitup — balena/wifi-connect's RsnFlags D-Bus call crashes on current
# Raspberry Pi OS NetworkManager (any version), comitup just works.
log "Installing comitup captive portal"
bash "$REPO_DIR/provisioning/comitup/install-comitup.sh" || \
  echo "comitup install skipped (no network?). Re-run later."

# ── 6. App config ────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  log "Creating .env from .env.example — EDIT IT before going live"
  cp .env.example .env
  # Generate a tunnel UUID for the feeders if not present.
  UUID="$(cat /proc/sys/kernel/random/uuid)"
  sed -i "s/^ULTRAFEEDER_UUID=.*/ULTRAFEEDER_UUID=${UUID}/" .env 2>/dev/null || \
    echo "ULTRAFEEDER_UUID=${UUID}" >> .env
fi

# The feeders read their keys from this file; the wizard writes it. Must exist
# for compose's env_file. (Created empty if the friend hasn't added keys yet.)
mkdir -p data
[[ -f data/feeder.env ]] || printf '# Written by the QDRN Radar setup wizard\n' > data/feeder.env

# ── 7. Build + start the stack ───────────────────────────────────────────────
log "Building and starting the QDRN Radar stack"
docker compose up -d --build

cat <<'DONE'

────────────────────────────────────────────────────────────
 QDRN Radar is starting up. Next steps:
   1. Edit .env  (Cloudflare token, receiver lat/lon/city, SETUP_PIN, ADMIN_EMAILS)
   2. Re-run:  docker compose up -d
   3. Configure the Cloudflare Tunnel + Access  (see infra/cloudflared/README.md)
   4. Hand it to your friend — CaptainQ takes over at  radar.qdrn.io/md/setup
────────────────────────────────────────────────────────────
DONE

if [[ "${FAN_NEEDS_REBOOT:-0}" == "1" ]]; then
  echo
  echo "  ⚠  Reboot to activate the GPIO3 cooling fan (gpio-fan overlay):  sudo reboot"
fi
