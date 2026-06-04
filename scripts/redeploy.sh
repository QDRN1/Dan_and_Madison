#!/usr/bin/env bash
# Redeploy the qdrn-radar container with the current git SHA baked into
# the image, AND reinstall the host-side qdrn-netd helper so its code
# matches the current checkout. Run from the repo root after `git pull`.
#
# Why qdrn-netd too: it runs on the host (outside the container) so
# `docker compose up --build` doesn't touch it. If the user pulls
# new qdrn-netd code without re-installing, the admin "Pull update"
# button keeps hitting the old helper and fails confusingly.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Short SHA + commit ISO timestamp captured from the host's git checkout.
# The Dockerfile reads these via build args (see docker-compose.yml).
export QDRN_BUILD_SHA="$(git rev-parse --short HEAD)"
export QDRN_BUILD_AT="$(git log -1 --format=%cI)"

echo "→ Reinstalling host helpers (qdrn-netd)…"
sudo bash provisioning/qdrn-netd/install-netd.sh

echo "→ Building qdrn-radar at $QDRN_BUILD_SHA ($QDRN_BUILD_AT)…"
sudo -E docker compose up -d --build qdrn-radar

echo "✓ Redeploy complete."
