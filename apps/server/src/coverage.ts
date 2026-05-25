import type { CoveragePoint } from "@qdrn/shared";
import { db } from "./db.js";

// 72 buckets → one every 5° of bearing; keep the farthest point per bearing seen
// in the last 24h so the footprint reflects "how far we've picked up planes today"
// and ages out stale spikes.
const BUCKETS = 72;
const STEP = 360 / BUCKETS;
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface Cell {
  dist: number;
  lat: number;
  lon: number;
  ts: number;
}

const cells = new Array<Cell | undefined>(BUCKETS).fill(undefined);

const upsert = db.prepare<[number, number, number, number, number]>(
  `INSERT INTO coverage_range (bucket, dist_nm, lat, lon, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(bucket) DO UPDATE SET dist_nm = excluded.dist_nm, lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at`,
);

// Warm in-memory cells from the DB at startup.
for (const r of db.prepare("SELECT bucket, dist_nm, lat, lon, updated_at FROM coverage_range").all() as {
  bucket: number;
  dist_nm: number;
  lat: number;
  lon: number;
  updated_at: number;
}[]) {
  if (r.bucket >= 0 && r.bucket < BUCKETS) cells[r.bucket] = { dist: r.dist_nm, lat: r.lat, lon: r.lon, ts: r.updated_at };
}

/** Record a tracked position; keeps the farthest point per bearing in the
 *  rolling window. A bucket's record is replaced when a farther plane appears
 *  OR when the current record has aged past the window. Best-effort. */
export function recordCoverage(bearing: number, distNm: number, lat: number, lon: number): void {
  if (!Number.isFinite(bearing) || !Number.isFinite(distNm) || distNm <= 0) return;
  const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor((((bearing % 360) + 360) % 360) / STEP)));
  const now = Date.now();
  const cur = cells[bucket];
  if (cur && distNm <= cur.dist && now - cur.ts <= WINDOW_MS) return;
  cells[bucket] = { dist: distNm, lat, lon, ts: now };
  try {
    upsert.run(bucket, distNm, lat, lon, now);
  } catch {
    /* best-effort */
  }
}

/** Farthest points within the rolling window, in bearing order, for the outline. */
export function getCoverage(): CoveragePoint[] {
  const now = Date.now();
  const out: CoveragePoint[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const c = cells[b];
    if (c && now - c.ts <= WINDOW_MS) {
      out.push({ bearing: b * STEP, distNm: Math.round(c.dist * 10) / 10, lat: c.lat, lon: c.lon });
    }
  }
  return out;
}
