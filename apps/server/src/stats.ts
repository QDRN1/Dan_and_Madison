import { readFileSync } from "node:fs";
import type { Aircraft, FlaggedSighting, SightingRow, Stats } from "@qdrn/shared";
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
  `INSERT INTO sightings (hex, day, flight, type_code, type_name, operator, first_seen, last_seen, max_dist_nm)
   VALUES (@hex, @day, @flight, @type_code, @type_name, @operator, @ts, @ts, @dist)
   ON CONFLICT(hex, day) DO UPDATE SET
     last_seen   = @ts,
     flight      = COALESCE(@flight, sightings.flight),
     type_code   = COALESCE(@type_code, sightings.type_code),
     type_name   = COALESCE(@type_name, sightings.type_name),
     operator    = COALESCE(@operator, sightings.operator),
     max_dist_nm = MAX(sightings.max_dist_nm, @dist)`,
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

export function recordSighting(ac: Aircraft): void {
  try {
    const e = ac.enrichment;
    const day = today();
    // Snapshot pre-write counts so achievements like "first plane today" /
    // "100 in a day" trigger on the crossing edge, not after the upsert.
    const todayUniqueBefore = (countTodayStmt.get(day) as { n: number }).n;
    const allTimeUniqueBefore = (countAllTimeStmt.get() as { n: number }).n;
    const wasSeenBefore = Boolean(seenAlreadyStmt.get(ac.hex));

    upsertSighting.run({
      hex: ac.hex,
      day,
      flight: ac.flight ?? null,
      type_code: e?.typeCode ?? null,
      type_name: e?.typeName ?? null,
      operator: e?.operator ?? e?.operatorIcao ?? null,
      ts: Date.now(),
      dist: ac.distNm ?? 0,
    } as any);

    // Approximate the "would this become a new unique?" delta. Used by the
    // achievement context so milestone checks fire on the crossing edge.
    const todayUniqueAfter = wasSeenBefore ? todayUniqueBefore : todayUniqueBefore + 1;
    const allTimeUniqueAfter = wasSeenBefore ? allTimeUniqueBefore : allTimeUniqueBefore + 1;

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

const todayListStmt = db.prepare(
  `SELECT hex, flight, type_code AS typeCode, type_name AS typeName, operator,
          first_seen AS firstSeen, last_seen AS lastSeen, max_dist_nm AS maxDistNm
   FROM sightings WHERE day = ?
   ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
);
const allTimeListStmt = db.prepare(
  `SELECT hex, MAX(last_seen) AS lastSeen, MAX(max_dist_nm) AS maxDistNm,
          MAX(flight) AS flight, MAX(type_code) AS typeCode,
          MAX(type_name) AS typeName, MAX(operator) AS operator
   FROM sightings GROUP BY hex
   ORDER BY lastSeen DESC LIMIT ? OFFSET ?`,
);
const farthestTodayStmt = db.prepare(
  `SELECT hex, flight, type_code AS typeCode, type_name AS typeName, operator,
          last_seen AS lastSeen, max_dist_nm AS maxDistNm
   FROM sightings WHERE day = ? ORDER BY max_dist_nm DESC LIMIT ?`,
);
const farthestAllStmt = db.prepare(
  `SELECT hex, MAX(flight) AS flight, MAX(type_code) AS typeCode,
          MAX(type_name) AS typeName, MAX(operator) AS operator,
          MAX(last_seen) AS lastSeen, MAX(max_dist_nm) AS maxDistNm
   FROM sightings GROUP BY hex ORDER BY maxDistNm DESC LIMIT ?`,
);
const notableListStmt = db.prepare(
  `SELECT hex, flight, type_name AS typeName, operator, reason, at
   FROM flagged ORDER BY at DESC LIMIT ?`,
);

export interface SightingPage { rows: SightingRow[]; total: number; }

export function listToday(offset = 0, limit = 50): SightingPage {
  const day = today();
  const total = (db.prepare("SELECT COUNT(*) n FROM sightings WHERE day = ?").get(day) as { n: number }).n;
  return { rows: todayListStmt.all(day, limit, offset) as SightingRow[], total };
}

export function listAllTime(offset = 0, limit = 50): SightingPage {
  const total = (db.prepare("SELECT COUNT(DISTINCT hex) n FROM sightings").get() as { n: number }).n;
  return { rows: allTimeListStmt.all(limit, offset) as SightingRow[], total };
}

export function listFarthest(scope: "today" | "all" = "today", limit = 50): SightingPage {
  const rows = scope === "today"
    ? farthestTodayStmt.all(today(), limit) as SightingRow[]
    : farthestAllStmt.all(limit) as SightingRow[];
  return { rows, total: rows.length };
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
