import type { CoveragePoint } from "@qdrn/shared";
import { TIMEZONE } from "./config.js";
import { db } from "./db.js";

// 72 buckets → one every 5° of bearing; keep a rolling window of recent days.
const BUCKETS = 72;
const STEP = 360 / BUCKETS;
const WINDOW_DAYS = 7;

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function today(): string {
  return dayFmt.format(new Date());
}
function cutoffDay(): string {
  return dayFmt.format(new Date(Date.now() - (WINDOW_DAYS - 1) * 86_400_000));
}

const upsert = db.prepare(
  `INSERT INTO coverage_daily (bucket, day, dist_nm, lat, lon, updated_at)
   VALUES (@bucket, @day, @dist, @lat, @lon, @ts)
   ON CONFLICT(bucket, day) DO UPDATE SET
     lat        = CASE WHEN @dist > coverage_daily.dist_nm THEN @lat ELSE coverage_daily.lat END,
     lon        = CASE WHEN @dist > coverage_daily.dist_nm THEN @lon ELSE coverage_daily.lon END,
     dist_nm    = MAX(coverage_daily.dist_nm, @dist),
     updated_at = @ts`,
);
const pruneStmt = db.prepare("DELETE FROM coverage_daily WHERE day < ?");

// Skip redundant writes: remember the best distance seen per (bucket, day).
const memMax = new Map<string, number>();

/** Record a tracked position; keeps the farthest point per bearing per day. */
export function recordCoverage(bearing: number, distNm: number, lat: number, lon: number): void {
  if (!Number.isFinite(bearing) || !Number.isFinite(distNm) || distNm <= 0) return;
  const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((((bearing % 360) + 360) % 360) / STEP))));
  const day = today();
  const k = `${bucket}:${day}`;
  const prev = memMax.get(k);
  if (prev !== undefined && distNm <= prev) return;
  memMax.set(k, distNm);
  try {
    upsert.run({ bucket, day, dist: distNm, lat, lon, ts: Date.now() });
  } catch {
    /* best-effort */
  }
}

let lastPruneDay = "";

/** Farthest points over the rolling window, in bearing order, for the outline. */
export function getCoverage(): CoveragePoint[] {
  const co = cutoffDay();
  if (lastPruneDay !== co) {
    try {
      pruneStmt.run(co);
    } catch {
      /* ignore */
    }
    lastPruneDay = co;
    memMax.clear(); // day rolled over — let today's observations re-register
  }

  const rows = db
    .prepare("SELECT bucket, dist_nm AS dist, lat, lon FROM coverage_daily WHERE day >= ?")
    .all(co) as { bucket: number; dist: number; lat: number; lon: number }[];

  const best = new Map<number, { dist: number; lat: number; lon: number }>();
  for (const r of rows) {
    const b = best.get(r.bucket);
    if (!b || r.dist > b.dist) best.set(r.bucket, { dist: r.dist, lat: r.lat, lon: r.lon });
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, v]) => ({ bearing: bucket * STEP, distNm: Math.round(v.dist * 10) / 10, lat: v.lat, lon: v.lon }));
}
