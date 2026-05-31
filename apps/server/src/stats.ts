import { readFileSync } from "node:fs";
import type {
  Aircraft,
  FlaggedSighting,
  SightingFilter,
  SightingPage,
  SightingRow,
  SightingScope,
  Stats,
} from "@qdrn/shared";
import { checkAll as checkAchievements } from "./achievements.js";
import { TIMEZONE } from "./config.js";
import { db } from "./db.js";

const SIGHTING_KEEP_DAYS = Number(process.env.SIGHTING_KEEP_DAYS) > 0
  ? Number(process.env.SIGHTING_KEEP_DAYS)
  : 365;

/** Read the Pi's SoC temperature in °C from the thermal sysfs node. Best-effort:
 *  returns undefined on non-Linux/non-Pi or if the node isn't reachable. */
function readCpuTempC(): number | undefined {
  try {
    const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim();
    const milli = Number(raw);
    if (!Number.isFinite(milli) || milli <= 0) return undefined;
    return Math.round((milli / 1000) * 10) / 10;
  } catch {
    return undefined;
  }
}

// YYYY-MM-DD in the configured timezone. Uses Intl (ICU, always bundled with
// Node) so named zones work without OS tzdata in the container.
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function today(): string {
  return dayFmt.format(new Date());
}

const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);
const MIL_KEYWORDS = /\b(air force|navy|army|military|nato|royal air|marine|coast guard|national guard)\b/i;

// Dedup flagged inserts to once-per-hex-per-day.
const flaggedToday = new Set<string>();
let flaggedDay = today();

const upsertSighting = db.prepare(
  `INSERT INTO sightings (hex, day, flight, type_code, type_name, operator,
                          origin_icao, dest_icao, route_source,
                          first_seen, last_seen, max_dist_nm)
   VALUES (@hex, @day, @flight, @type_code, @type_name, @operator,
           @origin_icao, @dest_icao, @route_source,
           @ts, @ts, @dist)
   ON CONFLICT(hex, day) DO UPDATE SET
     last_seen    = @ts,
     flight       = COALESCE(@flight, sightings.flight),
     type_code    = COALESCE(@type_code, sightings.type_code),
     type_name    = COALESCE(@type_name, sightings.type_name),
     operator     = COALESCE(@operator, sightings.operator),
     origin_icao  = COALESCE(@origin_icao, sightings.origin_icao),
     dest_icao    = COALESCE(@dest_icao, sightings.dest_icao),
     route_source = COALESCE(@route_source, sightings.route_source),
     max_dist_nm  = MAX(sightings.max_dist_nm, @dist)`,
);

const insertFlagged = db.prepare(
  `INSERT INTO flagged (hex, flight, type_name, operator, reason, at) VALUES (?, ?, ?, ?, ?, ?)`,
);

const countTodayStmt = db.prepare("SELECT COUNT(*) n FROM sightings WHERE day = ?");
const countAllTimeStmt = db.prepare("SELECT COUNT(DISTINCT hex) n FROM sightings");
const opCountTodayStmt = db.prepare(
  "SELECT COUNT(DISTINCT operator) n FROM sightings WHERE day = ? AND operator IS NOT NULL AND operator != ''",
);
const opCountAllStmt = db.prepare(
  "SELECT COUNT(DISTINCT operator) n FROM sightings WHERE operator IS NOT NULL AND operator != ''",
);
const seenAlreadyStmt = db.prepare("SELECT 1 FROM sightings WHERE hex = ? LIMIT 1");
const seenTodayStmt = db.prepare("SELECT 1 FROM sightings WHERE hex = ? AND day = ? LIMIT 1");

export function recordSighting(ac: Aircraft): void {
  try {
    const e = ac.enrichment;
    const day = today();
    // Snapshot pre-write counts so achievements like "first plane today" /
    // "100 in a day" trigger on the crossing edge, not after the upsert.
    const todayUniqueBefore = (countTodayStmt.get(day) as { n: number }).n;
    const allTimeUniqueBefore = (countAllTimeStmt.get() as { n: number }).n;
    // Two checks: was this hex ever seen (for all-time delta), and was it
    // seen TODAY already (for today delta). Conflating the two means a hex
    // seen yesterday but first-of-the-day today never triggers `first_today`.
    const wasSeenEver = Boolean(seenAlreadyStmt.get(ac.hex));
    const wasSeenToday = Boolean(seenTodayStmt.get(ac.hex, day));

    const route = e?.route;
    const originIcao = route?.origin?.icao ?? route?.origin?.iata ?? null;
    const destIcao = route?.destination?.icao ?? route?.destination?.iata ?? null;
    upsertSighting.run({
      hex: ac.hex,
      day,
      flight: ac.flight ?? null,
      type_code: e?.typeCode ?? null,
      type_name: e?.typeName ?? null,
      operator: e?.operator ?? e?.operatorIcao ?? null,
      origin_icao: originIcao,
      dest_icao: destIcao,
      route_source: route?.source ?? null,
      ts: Date.now(),
      dist: ac.distNm ?? 0,
    } as any);

    // "Would this become a new unique?" delta. Today and all-time count
    // crossings independently so milestone predicates fire on the right edge.
    const todayUniqueAfter = wasSeenToday ? todayUniqueBefore : todayUniqueBefore + 1;
    const allTimeUniqueAfter = wasSeenEver ? allTimeUniqueBefore : allTimeUniqueBefore + 1;

    checkAchievements({
      ac,
      day,
      todayUnique: todayUniqueAfter,
      allTimeUnique: allTimeUniqueAfter,
      operatorsToday: (opCountTodayStmt.get(day) as { n: number }).n,
      operatorsAllTime: (opCountAllStmt.get() as { n: number }).n,
      cpuTempF: readCpuTempC() != null ? readCpuTempC()! * 9 / 5 + 32 : undefined,
    });
  } catch {
    // Stats are best-effort — a write hiccup must never break live tracking.
  }
}

/** Decide if an aircraft is "interesting", logging a flagged sighting on first sight. */
export function isFlagged(ac: Aircraft): boolean {
  const reason = flagReason(ac);
  if (!reason) return false;

  const day = today();
  if (day !== flaggedDay) {
    flaggedDay = day;
    flaggedToday.clear();
  }
  if (!flaggedToday.has(ac.hex)) {
    flaggedToday.add(ac.hex);
    try {
      insertFlagged.run(
        ac.hex,
        ac.flight ?? null,
        ac.enrichment?.typeName ?? null,
        ac.enrichment?.operator ?? null,
        reason,
        Date.now(),
      );
    } catch {
      // Best-effort — never let a flagged-log write break tracking.
    }
  }
  return true;
}

function flagReason(ac: Aircraft): string | undefined {
  if (ac.squawk && EMERGENCY_SQUAWKS.has(ac.squawk)) {
    return ac.squawk === "7700" ? "Emergency (7700)" : ac.squawk === "7600" ? "Radio failure (7600)" : "Hijack code (7500)";
  }
  const op = ac.enrichment?.operator ?? ac.enrichment?.owner ?? "";
  if (op && MIL_KEYWORDS.test(op)) return "Military / state operator";
  return undefined;
}

export function getStats(current: number): Stats {
  const day = today();

  const todayUnique = (db.prepare("SELECT COUNT(*) n FROM sightings WHERE day = ?").get(day) as { n: number }).n;
  const allTimeUnique = (db.prepare("SELECT COUNT(DISTINCT hex) n FROM sightings").get() as { n: number }).n;
  const maxRange = (db.prepare("SELECT COALESCE(MAX(max_dist_nm), 0) m FROM sightings WHERE day = ?").get(day) as { m: number }).m;

  const topOperators = (
    db
      .prepare(
        "SELECT operator name, COUNT(*) count FROM sightings WHERE day = ? AND operator IS NOT NULL AND operator != '' GROUP BY operator ORDER BY count DESC LIMIT 5",
      )
      .all(day) as { name: string; count: number }[]
  );

  const topTypes = (
    db
      .prepare(
        "SELECT type_name type, COUNT(*) count FROM sightings WHERE day = ? AND type_name IS NOT NULL AND type_name != '' GROUP BY type_name ORDER BY count DESC LIMIT 5",
      )
      .all(day) as { type: string; count: number }[]
  );

  const recentFlagged = (
    db
      .prepare("SELECT hex, flight, type_name typeName, operator, reason, at FROM flagged ORDER BY at DESC LIMIT 10")
      .all() as FlaggedSighting[]
  );

  return {
    current,
    todayUnique,
    allTimeUnique,
    maxRangeNmToday: Math.round(maxRange * 10) / 10,
    topOperators,
    topTypes,
    recentFlagged,
    cpuTempC: readCpuTempC(),
  };
}

// ─── Popout queries (clickable stat cards) ───────────────────────────────────

const SIGHTING_COLS = `hex, flight, type_code AS typeCode, type_name AS typeName,
  operator, origin_icao AS originIcao, dest_icao AS destIcao,
  first_seen AS firstSeen, last_seen AS lastSeen, max_dist_nm AS maxDistNm`;

const notableListStmt = db.prepare(
  `SELECT hex, flight, type_name AS typeName, operator, reason, at
   FROM flagged ORDER BY at DESC LIMIT ?`,
);

/** Day-key (YYYY-MM-DD) for `n` days ago in the configured timezone. */
function dayAgo(n: number): string {
  return dayFmt.format(new Date(Date.now() - n * 86_400_000));
}

function scopeWhere(scope: SightingScope): { sql: string; params: unknown[] } {
  switch (scope) {
    case "today": return { sql: "day = ?",  params: [today()] };
    case "week":  return { sql: "day >= ?", params: [dayAgo(6)] };
    case "month": return { sql: "day >= ?", params: [dayAgo(29)] };
    case "all":   return { sql: "1=1",      params: [] };
  }
}

/** Filtered popout query — backs the table popouts. Aggregates by hex when the
 *  scope is wider than a single day so each aircraft shows up once with its
 *  best/latest values. */
export function listSightings(filter: SightingFilter): SightingPage {
  const scope: SightingScope = filter.scope ?? "today";
  const sort = filter.sort ?? (scope === "today" ? "recent" : "recent");
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  const offset = Math.max(0, filter.offset ?? 0);

  const { sql: scopeSql, params: scopeParams } = scopeWhere(scope);
  const whereParts: string[] = [scopeSql];
  const params: unknown[] = [...scopeParams];

  if (filter.airline && filter.airline.trim()) {
    whereParts.push("operator = ?");
    params.push(filter.airline.trim());
  }
  if (filter.q && filter.q.trim()) {
    const like = `%${filter.q.trim().toLowerCase()}%`;
    whereParts.push("(LOWER(hex) LIKE ? OR LOWER(flight) LIKE ? OR LOWER(operator) LIKE ? OR LOWER(type_code) LIKE ? OR LOWER(type_name) LIKE ? OR LOWER(origin_icao) LIKE ? OR LOWER(dest_icao) LIKE ?)");
    params.push(like, like, like, like, like, like, like);
  }
  const where = whereParts.join(" AND ");

  const orderBy = sort === "farthest" ? "maxDistNm DESC"
    : sort === "first"               ? "firstSeen ASC"
    :                                   "lastSeen DESC";

  // For multi-day scopes, collapse to one row per hex (latest values, best dist).
  const aggregate = scope !== "today";
  const rowsSql = aggregate
    ? `SELECT hex,
              MAX(flight) AS flight, MAX(type_code) AS typeCode, MAX(type_name) AS typeName,
              MAX(operator) AS operator, MAX(origin_icao) AS originIcao, MAX(dest_icao) AS destIcao,
              MIN(first_seen) AS firstSeen, MAX(last_seen) AS lastSeen,
              MAX(max_dist_nm) AS maxDistNm
       FROM sightings WHERE ${where}
       GROUP BY hex
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    : `SELECT ${SIGHTING_COLS}
       FROM sightings WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`;

  const rows = db.prepare(rowsSql).all(...params, limit, offset) as SightingRow[];

  const totalSql = aggregate
    ? `SELECT COUNT(DISTINCT hex) n FROM sightings WHERE ${where}`
    : `SELECT COUNT(*) n FROM sightings WHERE ${where}`;
  const total = (db.prepare(totalSql).get(...params) as { n: number }).n;

  // Airline facet — top 30 by count within the same scope (no q/airline filter
  // applied so the dropdown shows the full set, not just what's visible).
  const airlines = db.prepare(
    `SELECT operator AS name, COUNT(DISTINCT hex) AS count
     FROM sightings WHERE ${scopeSql} AND operator IS NOT NULL AND operator != ''
     GROUP BY operator ORDER BY count DESC LIMIT 30`,
  ).all(...scopeParams) as { name: string; count: number }[];

  return { rows, total, airlines };
}

/** Back-compat wrappers — used by the existing /stats/today, /stats/all-time,
 *  /stats/farthest endpoints. */
export function listToday(offset = 0, limit = 50): SightingPage {
  return listSightings({ scope: "today", sort: "recent", offset, limit });
}
export function listAllTime(offset = 0, limit = 50): SightingPage {
  return listSightings({ scope: "all", sort: "recent", offset, limit });
}
export function listFarthest(scope: "today" | "all" = "today", limit = 50): SightingPage {
  return listSightings({ scope, sort: "farthest", offset: 0, limit });
}

export function listNotable(limit = 100): FlaggedSighting[] {
  return notableListStmt.all(limit) as FlaggedSighting[];
}

// ─── Auto-prune ──────────────────────────────────────────────────────────────

let lastPruneAt = 0;

/** Trim sightings older than SIGHTING_KEEP_DAYS. Cheap (single DELETE on an
 *  indexed column) and runs at most once an hour, kicked from the poller. */
export function pruneOldSightings(): void {
  const now = Date.now();
  if (now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  try {
    const cutoff = new Date(now - SIGHTING_KEEP_DAYS * 86_400_000);
    const cutoffDay = dayFmt.format(cutoff);
    db.prepare("DELETE FROM sightings WHERE day < ?").run(cutoffDay);
    db.prepare("DELETE FROM flagged   WHERE at  < ?").run(now - SIGHTING_KEEP_DAYS * 86_400_000);
  } catch {
    /* best-effort */
  }
}
