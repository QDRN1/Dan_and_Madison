const R_NM = 3440.065; // Earth radius in nautical miles

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing in degrees (0–360) from point 1 to point 2. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle (0–180°) between two compass bearings. */
export function bearingDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Pick the leg a plane is currently flying out of an ordered list of airports
 * making up a (possibly multi-stop) callsign rotation. The destination is the
 * airport whose bearing best matches the plane's track; the origin is the
 * preceding stop in the rotation (or the next one, if it's the return leg).
 * Falls back to first→last when there's no track or no usable coordinates.
 */
export function pickLeg<T extends { lat?: number; lon?: number }>(
  pos: { lat: number; lon: number; track?: number },
  airports: T[],
): { origin?: T; destination?: T } {
  const n = airports.length;
  if (n === 0) return {};
  if (n === 1) return { destination: airports[0] };
  if (pos.track == null) return { origin: airports[0], destination: airports[n - 1] };

  let destIdx = -1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = airports[i];
    if (!a || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    const diff = bearingDiff(bearing(pos.lat, pos.lon, a.lat, a.lon), pos.track);
    if (diff < best) {
      best = diff;
      destIdx = i;
    }
  }
  if (destIdx < 0) return { origin: airports[0], destination: airports[n - 1] };
  const originIdx = destIdx > 0 ? destIdx - 1 : destIdx + 1;
  return { origin: airports[originIdx], destination: airports[destIdx] };
}
