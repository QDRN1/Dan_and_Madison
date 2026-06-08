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

/** Detect which direction the plane is flying along this route by looking
 *  at the physical evidence: a flight is low at origin (just took off /
 *  climbing), high at cruise, then low at destination (descending / on
 *  short final). If the named "origin" matches the descending-near-low
 *  end of the picture (or the named "destination" matches the just-
 *  climbed-out end), the route is reversed and we swap.
 *
 *  Three signals, evaluated independently — the first one that fires
 *  wins. Each is grounded in the physics of a flight, not a heuristic.
 *
 *   1. NOW + descending + low: the plane is approaching landing here.
 *      Whichever named endpoint we're near IS the destination.
 *
 *   2. NOW + climbing + low: the plane just took off. Whichever named
 *      endpoint we're near IS the origin.
 *
 *   3. TRAIL: earliest low-altitude trail point IS near the origin (it
 *      caught the climb-out). Compare to named endpoints to identify
 *      which is which.
 *
 *  Returns a SWAPPED route when reversed, the original otherwise. */
export function orientRoute(ac: Aircraft, route: Route, trail: TrailPoint[]): Route {
  const o = route.origin;
  const d = route.destination;
  if (!o?.lat || !o?.lon || !d?.lat || !d?.lon) return route;
  // Degenerate route (same airport at both ends) — nothing to orient,
  // the merge or sanity step will strip it.
  if (o.icao && d.icao && o.icao === d.icao) return route;
  if (ac.lat == null || ac.lon == null) return route;
  const routeLen = haversineNm(o.lat, o.lon, d.lat, d.lon);
  if (routeLen < 30) return route; // short hops are noisy

  const swap = (): Route => ({ ...route, origin: d, destination: o });

  // Signal 1 + 2: what's the plane doing right now?
  const alt = typeof ac.altBaro === "number" ? ac.altBaro : ac.altBaro === "ground" ? 0 : null;
  if (alt != null && alt < 12000) {
    const distO = haversineNm(ac.lat, ac.lon, o.lat, o.lon);
    const distD = haversineNm(ac.lat, ac.lon, d.lat, d.lon);
    const nearO = distO < 30 && distD > distO * 3;
    const nearD = distD < 30 && distO > distD * 3;
    const descending = ac.baroRate != null && ac.baroRate < -400;
    const climbing   = ac.baroRate != null && ac.baroRate >  600;
    // Approaching landing here → this endpoint is destination.
    if (descending && nearO) return swap();           // "origin" is actually destination
    if (descending && nearD) return route;            // route already correct
    // Just took off here → this endpoint is origin.
    if (climbing && nearD) return swap();             // "destination" is actually origin
    if (climbing && nearO) return route;              // route already correct
  }

  // Signal 3: did the trail catch the climb-out? A single low-altitude
  // trail point is enough — that point is necessarily near the airport
  // the plane took off from.
  const earliestLow = trail.find((p) => p.alt != null && p.alt > 0 && p.alt < 5000);
  if (earliestLow) {
    const dToO = haversineNm(earliestLow.lat, earliestLow.lon, o.lat, o.lon);
    const dToD = haversineNm(earliestLow.lat, earliestLow.lon, d.lat, d.lon);
    // Trail's first low point is the climb-out, which IS the origin.
    // If it's close to named "destination" and far from named "origin",
    // the route is reversed.
    if (dToD < 30 && dToO > dToD * 3) return swap();
    if (dToO < 30 && dToD > dToO * 3) return route;
  }

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
  // Degenerate same-airport route (adsb.lol's rotation collapsed to MSP→MSP
  // because pickLeg lost a track and fell back to first→last of a round-trip
  // rotation). Strip it so the UI shows nothing rather than nonsense.
  const oIcao = e.route.origin?.icao;
  const dIcao = e.route.destination?.icao;
  if (oIcao && dIcao && oIcao === dIcao) return { ...e, route: undefined, routeStale: true };
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
