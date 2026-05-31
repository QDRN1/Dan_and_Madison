import type { Aircraft } from "@qdrn/shared";
import { isAdsblolEnabled } from "./config.js";

/**
 * adsb.lol fill-in feed. We don't try to compete with the Pi's own ADS-B
 * receiver; this just plugs the gaps — planes outside our reception (terrain
 * shadow, low altitude past the horizon, etc.) become visible on the map,
 * dimmed so it's obvious they're not from "our" radar.
 *
 * Pulls /v2/point/<lat>/<lon>/<distance_nm> every REFRESH_MS, dedupes
 * against the local feed by hex (local always wins), and returns the
 * remainder tagged `source: "adsblol"`.
 *
 * Disabled when adsb.lol is off (Settings → adsb.lol routes) so a single
 * toggle controls both routes + fill-in.
 */

const REFRESH_MS = 20_000;
const STALE_MS = 60_000; // drop off-radar planes we haven't seen in a minute

const BASE = process.env.ADSBLOL_API_BASE ?? "https://api.adsb.lol/v2";

interface RawAdsblolAircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
}

interface State {
  lastFetchAt: number;
  byHex: Map<string, { ac: Aircraft; seenAt: number }>;
  inflight: Promise<void> | null;
}

const state: State = { lastFetchAt: 0, byHex: new Map(), inflight: null };

/** Synchronously return the cached off-radar planes, refreshing in the
 *  background if the cache is stale. The poller calls this every snapshot
 *  tick; we don't want to block the tick on an external HTTP call. */
export function getOffRadarSnapshot(opts: {
  lat: number; lon: number; radiusNm: number;
}): Aircraft[] {
  if (!isAdsblolEnabled()) {
    if (state.byHex.size > 0) state.byHex.clear();
    return [];
  }
  const now = Date.now();
  if (now - state.lastFetchAt > REFRESH_MS && !state.inflight) {
    state.inflight = refresh(opts.lat, opts.lon, opts.radiusNm).finally(() => {
      state.inflight = null;
    });
  }
  // Prune stale entries (plane drifted out of range / API returned fewer last fetch).
  for (const [hex, entry] of state.byHex) {
    if (now - entry.seenAt > STALE_MS) state.byHex.delete(hex);
  }
  return [...state.byHex.values()].map((e) => e.ac);
}

async function refresh(lat: number, lon: number, radiusNm: number): Promise<void> {
  state.lastFetchAt = Date.now();
  try {
    const r = radiusNm > 250 ? 250 : Math.max(1, Math.round(radiusNm));
    const url = `${BASE}/point/${lat}/${lon}/${r}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const body = (await res.json()) as { ac?: RawAdsblolAircraft[] };
    const raw = body.ac ?? [];
    const now = Date.now();
    for (const r of raw) {
      if (!r.hex || typeof r.lat !== "number" || typeof r.lon !== "number") continue;
      const hex = r.hex.toLowerCase();
      const ac: Aircraft = {
        hex,
        flight: r.flight?.trim(),
        lat: r.lat,
        lon: r.lon,
        altBaro: r.alt_baro,
        altGeom: r.alt_geom,
        gs: r.gs,
        track: r.track,
        baroRate: r.baro_rate,
        squawk: r.squawk,
        category: r.category,
        source: "adsblol",
      };
      state.byHex.set(hex, { ac, seenAt: now });
    }
  } catch {
    /* swallow — best-effort feed */
  }
}
