import type { Aircraft, Enrichment, Route, TrailPoint } from "@qdrn/shared";

const NM_PER_KM = 1 / 1.852;

/** Sanity-check a free-sourced route against the plane's live position. If
 *  (distance origin→plane + distance plane→destination) is much bigger than
 *  the direct route length, the plane is not on this route — adsb.lol's
 *  static rotation file is likely on a stale or different leg of the day's
 *  flying. We strip the route and set routeStale so the UI can show "route
 *  hidden" instead of misleading airports.
 *
 *  Threshold is max(routeLen × 1.5, routeLen + 80 nm). 1.5× covers normal
 *  approach/departure vectoring without burning routes near the endpoints,
 *  and the +80 nm floor handles short hops where 1.5× is too tight. */
export function routeMatchesPosition(ac: Aircraft, route: Route): boolean {
  const o = route.origin;
  const d = route.destination;
  if (!o?.lat || !o?.lon || !d?.lat || !d?.lon) return true; // can't check
  if (ac.lat == null || ac.lon == null) return true;
  const routeLen = haversineNm(o.lat, o.lon, d.lat, d.lon);
  if (routeLen < 5) return true; // taxi / hover-ish hops aren't worth checking
  const dOrigin = haversineNm(ac.lat, ac.lon, o.lat, o.lon);
  const dDest   = haversineNm(ac.lat, ac.lon, d.lat, d.lon);
  const detour  = dOrigin + dDest;
  const allowed = Math.max(routeLen * 1.5, routeLen + 80);
  return detour <= allowed;
}

/** When a free route comes back reversed (adsb.lol returns the standing
 *  pattern entry as origin→destination but the plane is actually flying
 *  the return leg), the position check passes — the plane is still "on
 *  the line", just near the wrong endpoint.
 *
 *  The clean signal is the plane's velocity vector dotted with the route
 *  vector (origin → destination). If the plane is moving in the route
 *  direction, dot > 0; if it's moving opposite, dot < 0. This holds at
 *  any point along the route, even near an endpoint where bearings get
 *  noisy. Two backup signals fire when the velocity check is too weak
 *  to call (turning, slow):
 *
 *    - Altitude + proximity: descending fast within 25 nm of "origin"
 *      means "origin" is actually the destination → reversed.
 *    - Climbing fast within 25 nm of "destination" → reversed.
 *
 *  Returns a SWAPPED route when reversed, the original otherwise. */
export function orientRoute(ac: Aircraft, route: Route, _trail: TrailPoint[]): Route {
  const o = route.origin;
  const d = route.destination;
  if (!o?.lat || !o?.lon || !d?.lat || !d?.lon) return route;
  if (ac.lat == null || ac.lon == null) return route;
  const routeLen = haversineNm(o.lat, o.lon, d.lat, d.lon);
  if (routeLen < 30) return route; // short hops are noisy

  let vote = 0; // negative = reversed

  // Primary: dot(velocity, route). Both as unit vectors in (east, north).
  if (ac.track != null && ac.gs != null && ac.gs > 50) {
    const routeBrg = bearingDeg(o.lat, o.lon, d.lat, d.lon);
    const vx = Math.sin((ac.track * Math.PI) / 180);
    const vy = Math.cos((ac.track * Math.PI) / 180);
    const rx = Math.sin((routeBrg * Math.PI) / 180);
    const ry = Math.cos((routeBrg * Math.PI) / 180);
    const dot = vx * rx + vy * ry; // [-1, 1]
    if (dot < -0.4) vote -= 2;       // moving distinctly opposite
    else if (dot > 0.4) vote += 2;   // moving distinctly along
  }

  // Backup: altitude + proximity. baroRate is fpm.
  if (ac.baroRate != null) {
    const distO = haversineNm(ac.lat, ac.lon, o.lat, o.lon);
    const distD = haversineNm(ac.lat, ac.lon, d.lat, d.lon);
    if (ac.baroRate < -600 && distO < 25 && distD > 50) vote -= 1; // descending into "origin"
    if (ac.baroRate < -600 && distD < 25 && distO > 50) vote += 1; // descending into "destination"
    if (ac.baroRate >  800 && distD < 25 && distO > 50) vote -= 1; // climbing away from "destination"
    if (ac.baroRate >  800 && distO < 25 && distD > 50) vote += 1; // climbing away from "origin"
  }

  if (vote <= -2) return { ...route, origin: d, destination: o };
  return route;
}

/** Apply the position sanity check to an Enrichment in-place. Returns a
 *  shallow copy with route stripped + routeStale = true when the check
 *  fails; returns the original object when it passes. The trail is
 *  optional — when present, we also use it to detect reversed routes
 *  (adsb.lol occasionally hands back the outbound leg for an inbound
 *  flight, or vice versa). */
export function withRouteSanity(ac: Aircraft, e: Enrichment | undefined, trail: TrailPoint[] = []): Enrichment | undefined {
  if (!e?.route) return e;
  // Paid sources (AeroAPI / gateway) are authoritative — they know the
  // actual filed plan for this leg. Only sanity-check the free sources.
  const src = e.route.source;
  if (src === "flightaware" || src === "gateway") return e;
  const oriented = orientRoute(ac, e.route, trail);
  if (oriented !== e.route) {
    // Direction was flipped. Apply the position check against the new
    // orientation so a genuinely off-route plane still gets the route
    // stripped — but the common case (plane near one endpoint) now
    // passes because origin/destination match the trail.
    if (!routeMatchesPosition(ac, oriented)) return { ...e, route: undefined, routeStale: true };
    return { ...e, route: oriented };
  }
  if (routeMatchesPosition(ac, e.route)) return e;
  return { ...e, route: undefined, routeStale: true };
}

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

/** Initial great-circle bearing from point 1 to point 2, in degrees [0,360). */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const λ1 = toRad(lon1), λ2 = toRad(lon2);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
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
