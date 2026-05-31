import type { TrailPoint } from "@qdrn/shared";

/**
 * Pull the readsb-style historical trace for an aircraft from adsb.lol's
 * globe bucket. Format reference: the file contains
 *   { timestamp: <epoch_seconds>, trace: [[secOffset, lat, lon, alt, ...], ...] }
 * where `alt` is feet (or the string "ground"), and `secOffset` is seconds
 * relative to `timestamp`.
 *
 * Lightweight in-memory cache keyed by hex (2 min TTL) so opening the same
 * plane repeatedly doesn't keep pounding the bucket. Best-effort: any
 * failure (404, JSON shape change, network blip) returns `[]` quietly so
 * the caller can fall back to the session-only trail.
 */

interface CacheEntry { at: number; trail: TrailPoint[] }
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

const TRACE_BASE = process.env.ADSBLOL_TRACE_BASE ?? "https://globe.adsb.lol/data/traces";

export async function fetchExtendedTrack(hex: string): Promise<TrailPoint[]> {
  const k = hex.toLowerCase();
  const cached = cache.get(k);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.trail;

  const tail = k.slice(-2);
  // Prefer the "full" trace (rolling 24h); fall back to the live trace file.
  const candidates = [
    `${TRACE_BASE}/${tail}/trace_full_${k}.json`,
    `${TRACE_BASE}/${tail}/trace_recent_${k}.json`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { timestamp?: number; trace?: unknown[][] };
      const base = typeof body.timestamp === "number" ? body.timestamp : 0;
      const raw = Array.isArray(body.trace) ? body.trace : [];
      const trail: TrailPoint[] = [];
      for (const r of raw) {
        if (!Array.isArray(r) || r.length < 4) continue;
        const [secOff, lat, lon, alt] = r as [number, number, number, number | string];
        if (typeof lat !== "number" || typeof lon !== "number") continue;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const altFt = typeof alt === "number" ? alt : null; // "ground" → null
        trail.push({ lon, lat, alt: altFt, t: Math.round((base + secOff) * 1000) });
      }
      cache.set(k, { at: Date.now(), trail });
      return trail;
    } catch {
      /* try next candidate */
    }
  }

  cache.set(k, { at: Date.now(), trail: [] });
  return [];
}
