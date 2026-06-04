#!/usr/bin/env bash
# Redeploy the qdrn-radar container with the current git SHA baked into
# the image, so the admin "Build:" line shows a real value instead of
# "unknown". Run from the repo root after `git pull`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Short SHA + commit ISO timestamp captured from the host's git checkout.
# The Dockerfile reads these via build args (see docker-compose.yml).
export QDRN_BUILD_SHA="$(git rev-parse --short HEAD)"
export QDRN_BUILD_AT="$(git log -1 --format=%cI)"

echo "Building qdrn-radar at $QDRN_BUILD_SHA ($QDRN_BUILD_AT)"
sudo -E docker compose up -d --build qdrn-radar
