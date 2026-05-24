# QDRN Radar ✈️

A custom, mobile-first **ADS-B aircraft tracker** for a headless Raspberry Pi —
QDRN-themed, with deep flight detail (routes, operators, aircraft type, stats),
a friendly **CaptainQ** setup guide, and zero-config remote access via Cloudflare.

Hosted at **`radar.qdrn.io/md`**.

---

## What it does

- **Live clickable map** (MapLibre, dark "mission-control" theme) — tap any plane
  for a flightwall-style detail card: route (origin → destination), operator,
  aircraft type, registration, altitude/speed/heading/squawk, distance.
- **Stats & history** — aircraft seen today / all-time, farthest contact, top
  operators & types, and "notable" sightings (emergency squawks, military/state).
- **CaptainQ setup wizard** (`/md/setup`) — a friendly guided onboarding for a
  non-technical owner: WiFi, location (city-level only), and their own
  FlightAware + FlightRadar24 keys (which earn them the free pro accounts).
- **Hidden admin console** (`/md/admin`) — gated by Cloudflare Access; view/restart
  services, tail logs, check status.
- **Earns the pro accounts** — feeds FlightRadar24, FlightAware, and the community
  aggregators (adsb.fi / adsb.lol / airplanes.live) out of the box.

## Architecture

```
RTL-SDR ─► ultrafeeder (readsb + mlat) ─► aircraft.json
                 │                              │
                 ├─► fr24feed  (FlightRadar24)  │
                 ├─► piaware   (FlightAware)    ▼
                 └─────────────────────►  qdrn-radar  (Node/Fastify + React/MapLibre)
                                                │   • enrichment (adsbdb/hexdb + FA/FR24 keys)
                                                │   • stats (SQLite)  • setup wizard  • admin
                                                ▼
                                          cloudflared ─► radar.qdrn.io/md  +  SSH
```

| Piece | Tech |
|------|------|
| Decoder / feed | `ultrafeeder` (readsb), `fr24feed`, `piaware` (Docker) |
| App backend | Node 20 + Fastify + better-sqlite3 (`apps/server`) |
| App frontend | React + TypeScript + Vite + MapLibre GL (`apps/web`) |
| Shared types | `packages/shared` |
| Onboarding | balena `wifi-connect` captive portal (`QDRN-Radar-Setup`) |
| Remote access | Cloudflare Tunnel + Access |

## Quick start (on the Pi)

```bash
git clone <this repo> && cd Dan_and_Madison
sudo bash provisioning/install.sh      # docker, SDR drivers, wifi-connect, SSH, build
cp .env.example .env && nano .env      # set CF token, receiver lat/lon/city, SETUP_PIN, ADMIN_EMAILS
docker compose up -d
```

Then set up the Cloudflare Tunnel + Access → see [`infra/cloudflared/README.md`](infra/cloudflared/README.md).
Hand it to your friend → CaptainQ takes over at `radar.qdrn.io/md/setup`.

## Local development

```bash
npm install
npm run build --workspace @qdrn/shared
# terminal 1 — backend (set AIRCRAFT_JSON_URL to a live tar1090 feed to see planes)
AIRCRAFT_JSON_URL=https://your-tar1090/data/aircraft.json npm run dev
# terminal 2 — frontend (proxies /md/api to :8080)
npm run dev:web      # http://localhost:5173/md/
```

## Branding

QDRN palette is in `apps/web/src/theme.css` (CSS variables) and
`apps/server/src/config.ts` (`getBrand`). Drop the official art into `brand/`:
`logo.svg`, `captainq.svg`, `favicon.svg` — swappable without a rebuild.

> Dark Blue `#002D72` · Green `#A3C940` · White `#FFFFFF` · Black `#000000` · Light Gray `#F0F0F0`

## Docs
- [`docs/FRIEND-GUIDE.md`](docs/FRIEND-GUIDE.md) — the non-technical owner's guide
- [`docs/ADMIN.md`](docs/ADMIN.md) — your operator/admin runbook
