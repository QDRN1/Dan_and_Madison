import type { Aircraft, Route, TrailPoint } from "@qdrn/shared";

const NM_PER_KM = 1 / 1.852;

/** Great-circle distance between two lat/lon points, in nautical miles. */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) * NM_PER_KM;
}

/** First sample where the plane is in the air. Walks forward from the start
 *  of the (current-leg-trimmed) trace; the first non-null altitude with a
 *  reasonable lat/lon is the takeoff moment. */
function findActualOff(trail: TrailPoint[]): number | undefined {
  for (const p of trail) {
    if (p.alt != null && p.alt > 50) return p.t;
  }
  return undefined;
}

/** Compute progress + ETA for a free-sourced route. Mutates a copy of `route`
 *  with derived fields (actualOff from the trace, estimatedIn + progress
 *  from live position). Skips fields that are already populated by a paid
 *  source so AeroAPI's authoritative values are never overwritten. */
export function deriveFreeRouteTimes(
  ac: Aircraft,
  route: Route,
  trail: TrailPoint[],
): Route {
  const out: Route = { ...route };
  const origin = route.origin;
  const destination = route.destination;

  // actualOff from the trace (we already had to fetch it for the leg trim).
  if (!out.actualOff && trail.length > 0) {
    const off = findActualOff(trail);
    if (off != null) out.actualOff = new Date(off).toISOString();
  }

  // Need destination coords + live position + ground speed for ETA + progress.
  if (
    destination?.lat != null && destination?.lon != null &&
    ac.lat != null && ac.lon != null
  ) {
    const distRemaining = haversineNm(ac.lat, ac.lon, destination.lat, destination.lon);

    if (origin?.lat != null && origin?.lon != null) {
      const total = haversineNm(origin.lat, origin.lon, destination.lat, destination.lon);
      if (total > 1 && out.progressPercent == null) {
        // Cap at 100 — great-circle is shortest path, actual path is longer,
        // so we can briefly overshoot near landing without going past 100.
        out.progressPercent = Math.max(0, Math.min(100, Math.round((1 - distRemaining / total) * 100)));
      }
    }

    if (!out.estimatedIn && ac.gs != null && ac.gs > 30 && distRemaining > 0.5) {
      const etaMs = Date.now() + (distRemaining / ac.gs) * 3600 * 1000;
      out.estimatedIn = new Date(etaMs).toISOString();
    }
  }

  return out;
}
