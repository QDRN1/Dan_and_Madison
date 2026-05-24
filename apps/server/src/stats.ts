import type { Aircraft, FlaggedSighting, Stats } from "@qdrn/shared";
import { db } from "./db.js";

function today(): string {
  // Local YYYY-MM-DD
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

export function recordSighting(ac: Aircraft): void {
  const e = ac.enrichment;
  upsertSighting.run({
    hex: ac.hex,
    day: today(),
    flight: ac.flight ?? null,
    type_code: e?.typeCode ?? null,
    type_name: e?.typeName ?? null,
    operator: e?.operator ?? e?.operatorIcao ?? null,
    ts: Date.now(),
    dist: ac.distNm ?? 0,
  } as any);
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
    insertFlagged.run(
      ac.hex,
      ac.flight ?? null,
      ac.enrichment?.typeName ?? null,
      ac.enrichment?.operator ?? null,
      reason,
      Date.now(),
    );
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
  };
}
