import type { CoveragePoint } from "@qdrn/shared";
import { db } from "./db.js";

// 72 buckets → one every 5° of bearing.
const BUCKETS = 72;
const STEP = 360 / BUCKETS;

interface Cell {
  distNm: number;
  lat: number;
  lon: number;
}

const cells = new Array<Cell | undefined>(BUCKETS).fill(undefined);

const upsert = db.prepare<[number, number, number, number, number]>(
  `INSERT INTO coverage (bucket, dist_nm, lat, lon, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(bucket) DO UPDATE SET dist_nm = excluded.dist_nm, lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at`,
);

// Warm the in-memory cells from the DB at startup.
for (const row of db.prepare("SELECT bucket, dist_nm, lat, lon FROM coverage").all() as {
  bucket: number;
  dist_nm: number;
  lat: number;
  lon: number;
}[]) {
  if (row.bucket >= 0 && row.bucket < BUCKETS) cells[row.bucket] = { distNm: row.dist_nm, lat: row.lat, lon: row.lon };
}

/** Record a tracked position; keeps the farthest point seen per bearing bucket.
 *  Coverage only grows, so DB writes become rare over time. Best-effort. */
export function recordCoverage(bearing: number, distNm: number, lat: number, lon: number): void {
  if (!Number.isFinite(bearing) || !Number.isFinite(distNm) || distNm <= 0) return;
  const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((bearing % 360) + 360) % 360 / STEP)));
  const cur = cells[bucket];
  if (cur && distNm <= cur.distNm) return;
  cells[bucket] = { distNm, lat, lon };
  try {
    upsert.run(bucket, distNm, lat, lon, Date.now());
  } catch {
    /* best-effort */
  }
}

/** Farthest points, in bearing order, for drawing the coverage outline. */
export function getCoverage(): CoveragePoint[] {
  const out: CoveragePoint[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const c = cells[b];
    if (c) out.push({ bearing: b * STEP, distNm: Math.round(c.distNm * 10) / 10, lat: c.lat, lon: c.lon });
  }
  return out;
}
