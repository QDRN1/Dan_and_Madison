import type { Aircraft } from "@qdrn/shared";
import { isOffRadarEnabled } from "./config.js";
import { enrich } from "./enrichment.js";

/**
 * adsb.lol fill-in feed. We don't try to compete with the Pi's own ADS-B
 * receiver; this just plugs the gaps — planes outside our reception (terrain
 * shadow, low altitude past the horizon, etc.) become visible on the map,
 * dimmed so it's obvious they're not from "our" radar.
 *
 * Pulls /v2/point/<lat>/<lon>/<distance_nm> every REFRESH_MS, dedupes
 * against the local feed by hex (local always wins), and returns the
 * remainder tagged `source: "adsblol"`. Each plane also goes through the
 * same enrich() pipeline as local readings so operator/type/route show up
 * in the detail card and the airline logo / Frontier animal / popout
 * filters work end-to-end.
 *
 * Gated on the standalone "Off-radar fill" toggle (Settings) — independent
 * from the adsb.lol routes toggle. Used to be coupled to isAdsblolEnabled,
 * but that meant disabling adsb.lol routes silently killed off-radar fill
 * even when the user had explicitly enabled it; the friend never saw any
 * dimmed fill-in planes.
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
  /** Hex+callsign pairs we've fired enrichment for so the same plane doesn't
   *  re-trigger HTTP every refresh. enrich() also caches internally; this
   *  just spares the repeat lookup overhead. */
  enrichedFor: Map<string, string>;
  /** Last failure reason from refresh() — shown by the debug endpoint so
   *  the user can tell whether the API is unreachable, returning 0 planes,
   *  or returning data we then drop on the floor. */
  lastError: string | null;
}

const state: State = { lastFetchAt: 0, byHex: new Map(), inflight: null, enrichedFor: new Map(), lastError: null };

/** Synchronously return the cached off-radar planes, refreshing in the
 *  background if the cache is stale. The poller calls this every snapshot
 *  tick; we don't want to block the tick on an external HTTP call. */
export function getOffRadarSnapshot(opts: {
  lat: number; lon: number; radiusNm: number;
}): Aircraft[] {
  if (!isOffRadarEnabled()) {
    if (state.byHex.size > 0) { state.byHex.clear(); state.enrichedFor.clear(); }
    // Zero out the timestamp so re-enabling triggers an immediate refresh
    // instead of waiting up to REFRESH_MS for the next 20s tick.
    state.lastFetchAt = 0;
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
    if (now - entry.seenAt > STALE_MS) {
      state.byHex.delete(hex);
      state.enrichedFor.delete(hex);
    }
  }
  return [...state.byHex.values()].map((e) => e.ac);
}

/** Direct lookup so /aircraft/:hex can return off-radar planes too (the
 *  local store doesn't know about them). */
export function getOffRadarAircraft(hex: string): Aircraft | undefined {
  return state.byHex.get(hex.toLowerCase())?.ac;
}

/** Debug snapshot — what does the off-radar subsystem actually think? Used
 *  by the admin off-radar status endpoint so the user can stop guessing
 *  why no fill-in planes are appearing. */
export function getOffRadarDebug(): {
  enabled: boolean;
  cacheSize: number;
  lastFetchAt: number | null;
  lastFetchAgoSec: number | null;
  lastError: string | null;
  inflight: boolean;
} {
  return {
    enabled: isOffRadarEnabled(),
    cacheSize: state.byHex.size,
    lastFetchAt: state.lastFetchAt || null,
    lastFetchAgoSec: state.lastFetchAt ? Math.round((Date.now() - state.lastFetchAt) / 1000) : null,
    lastError: state.lastError,
    inflight: state.inflight != null,
  };
}

async function refresh(lat: number, lon: number, radiusNm: number): Promise<void> {
  state.lastFetchAt = Date.now();
  try {
    const r = radiusNm > 250 ? 250 : Math.max(1, Math.round(radiusNm));
    const url = `${BASE}/point/${lat}/${lon}/${r}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      state.lastError = `HTTP ${res.status} from ${BASE}`;
      return;
    }
    const body = (await res.json()) as { ac?: RawAdsblolAircraft[] };
    const raw = body.ac ?? [];
    if (raw.length === 0) state.lastError = `${BASE} returned 0 aircraft near ${lat},${lon} r=${r}nm`;
    else state.lastError = null;
    const now = Date.now();
    for (const r of raw) {
      if (!r.hex || typeof r.lat !== "number" || typeof r.lon !== "number") continue;
      const hex = r.hex.toLowerCase();
      const flight = r.flight?.trim();
      const prev = state.byHex.get(hex)?.ac;
      const ac: Aircraft = {
        hex,
        flight,
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
        // Carry the enrichment forward — adsb.lol gave us position only, but
        // the cached operator/type/route is still valid for the same hex.
        enrichment: prev?.enrichment,
      };
      state.byHex.set(hex, { ac, seenAt: now });

      // Fire enrichment if we haven't yet for this (hex, callsign). The
      // enrichment cache keeps repeats cheap; this just spares re-dispatch.
      const cs = flight ?? "";
      const lacksRoute = !ac.enrichment || (!ac.enrichment.route && cs.length > 0);
      if (lacksRoute && state.enrichedFor.get(hex) !== cs) {
        state.enrichedFor.set(hex, cs);
        void enrich(hex, flight, { lat: r.lat, lon: r.lon, track: r.track }).then((e) => {
          if (!e) return;
          const cur = state.byHex.get(hex);
          if (cur) cur.ac.enrichment = e;
        });
      }
    }
  } catch (e) {
    state.lastError = `fetch threw: ${(e as Error).message}`;
  }
}
