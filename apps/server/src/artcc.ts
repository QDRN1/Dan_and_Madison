import { ARTCC_BOUNDARIES } from "./artcc-data.js";

export interface Artcc {
  id: string;
  name: string;
}

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const cache = new Map<string, Artcc | undefined>();

/** Which US Air Route Traffic Control Center contains this point, if any. */
export function lookupArtcc(lat: number, lon: number): Artcc | undefined {
  const k = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (cache.has(k)) return cache.get(k);
  let hit: Artcc | undefined;
  for (const c of ARTCC_BOUNDARIES) {
    if (c.rings.some((r) => inRing(lon, lat, r))) {
      hit = { id: c.id, name: c.name };
      break;
    }
  }
  cache.set(k, hit);
  return hit;
}
