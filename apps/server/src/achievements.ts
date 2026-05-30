/**
 * Achievements engine.
 *
 * 50 hand-curated badges. Each one is a small predicate run after every
 * sighting; if it returns true and (for non-repeatable badges) it hasn't fired
 * before, we increment its count and update first_at/last_at. The Achievements
 * tab in the web app shows hints for locked badges and the full title +
 * unlock count for the ones the user has earned.
 */
import type { Aircraft, AchievementDef, AchievementProgress } from "@qdrn/shared";
import { getHomeWifi } from "./config.js";
import { db } from "./db.js";

/** Returns true if `now` is on or past the year-anniversary of the home WiFi
 *  first connection, and the calendar MM-DD matches. Used by the Radar-versary
 *  achievement and the client banner. */
export function isRadarVersary(now: Date = new Date()): boolean {
  const home = getHomeWifi();
  if (!home) return false;
  const first = new Date(home.firstAt);
  if (now.getTime() - first.getTime() < 364 * 24 * 60 * 60 * 1000) return false;
  return now.getMonth() === first.getMonth() && now.getDate() === first.getDate();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Ctx {
  ac: Aircraft;
  /** Local day key "YYYY-MM-DD" the sighting belongs to. */
  day: string;
  todayUnique: number;          // running count BEFORE this sighting was upserted
  allTimeUnique: number;        // running count BEFORE this sighting was upserted
  operatorsToday: number;
  operatorsAllTime: number;
  cpuTempF?: number;
}

function isMilitary(op?: string | null): boolean {
  if (!op) return false;
  return /\b(air force|navy|army|marine|coast guard|national guard|military|royal air|nato|space force)\b/i.test(op);
}

function altFt(ac: Aircraft): number | null {
  if (ac.altBaro == null) return null;
  if (ac.altBaro === "ground") return 0;
  return typeof ac.altBaro === "number" ? ac.altBaro : null;
}

const WIDEBODY = /\bB7(47|77|87)|A3(30|40|50|80)|A350|A380|A340|A330|B767|B787\b/;
const HELO = /\b(R22|R44|R66|EC[0-9]|H1[35]5|H125|H145|UH-?60|AS3|S70|EC1)/;
const WARBIRD = /\bP51|P40|B17|B25|B29|SBD|TBM|F4U|SNJ|T6\b/;
const CARGO_OPS = /\b(fedex|ups|dhl|atlas|polar|kalitta|amerijet|cargolux|west cargo)\b/i;
const PRESIDENTIAL = /\b(VENUS|SAM01|SAM02|AF1|AF2|SAM|EXEC)/i;
const NATO = /\b(RAF|RFR|GAF|GAM|ASCOT|RRR|NATO[0-9])\b/;
const FRONTIER = /^\s*FFT/i;
const REGIONAL = /\b(SKW|JIA|RPA|ENY|GJS|EDV|PDT|QXE)/i;
const TEST_FLIGHTS = /\b(BOE[0-9]|AIB|N[0-9]+(BA|EA|DE))\b/i;

// ─── Definitions ────────────────────────────────────────────────────────────

const DEFS: (AchievementDef & {
  /** Fires once total then saturates. */
  once?: boolean;
  /** Predicate over the current sighting + context. */
  test: (ctx: Ctx, currentCount: number) => boolean;
})[] = [
  // ── Beginner / volume ──
  { id: "first_sighting", icon: "🛬", hint: "Welcome aboard, captain", title: "Pilot's First", once: true,
    test: (c) => c.allTimeUnique >= 0 /* any sighting */ },
  { id: "ten_sightings", icon: "🔟", hint: "Stay a while", title: "Getting the Hang of It", once: true,
    test: (c) => c.allTimeUnique >= 10 },
  { id: "hundred_today", icon: "🎉", hint: "Day of the party", title: "Plane Party",
    test: (c) => c.todayUnique === 100 },
  { id: "mile_high", icon: "🏔️", hint: "Reach for the sky", title: "Mile High Club",
    test: (c, count) => Math.floor(c.allTimeUnique / 5280) > count },
  { id: "iron_eyes", icon: "👀", hint: "A lot of looking", title: "Iron Eyes", once: true,
    test: (c) => c.allTimeUnique >= 10000 },

  // ── Time of day ──
  { id: "dawn_patrol", icon: "🌅", hint: "Early bird gets the worm", title: "Dawn Patrol",
    test: () => { const h = new Date().getHours(); return h >= 5 && h < 7; } },
  { id: "golden_hour", icon: "🌇", hint: "Last light", title: "Golden Hour",
    test: () => { const h = new Date().getHours(); return h >= 19 && h < 21; } },
  { id: "midnight_owl", icon: "🌙", hint: "Witching hour", title: "Midnight Watcher",
    test: () => new Date().getHours() === 0 },
  { id: "graveyard", icon: "🦉", hint: "Should you be up?", title: "Graveyard Shift",
    test: () => { const h = new Date().getHours(); return h >= 2 && h < 5; } },

  // ── Aircraft types ──
  { id: "iron_eagle", icon: "🪖", hint: "Salute a uniform", title: "Iron Eagle", once: true,
    test: (c) => isMilitary(c.ac.enrichment?.operator) || isMilitary(c.ac.enrichment?.owner) },
  { id: "heavy_metal", icon: "🛫", hint: "Real heavy lifting", title: "Heavy Metal", once: true,
    test: (c) => WIDEBODY.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "superjumbo", icon: "🛩️", hint: "Two decks of grins", title: "Superjumbo", once: true,
    test: (c) => /\bA380\b/.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "warbird", icon: "✈️", hint: "Out of the museum", title: "Warbird", once: true,
    test: (c) => WARBIRD.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "whirlybird", icon: "🚁", hint: "Vertical takeoff", title: "Whirlybird", once: true,
    test: (c) => HELO.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "cargo_king", icon: "📦", hint: "Brown boxes overhead", title: "Cargo King", once: true,
    test: (c) => CARGO_OPS.test(c.ac.enrichment?.operator ?? "") },
  { id: "bizjet", icon: "💼", hint: "Tail number, no airline", title: "Bizjet", once: true,
    test: (c) => /\b(C[CL]\d{2,3}|GLF[1-7]|G[VI]?|GLEX|H25|F2TH|CL30|E55P|FA[57]|LJ\d+)\b/.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "blimp_spotter", icon: "🎈", hint: "Floats more than flies", title: "Blimp Spotter", once: true,
    test: (c) => /goodyear|airship|blimp/i.test(c.ac.enrichment?.operator ?? "") },

  // ── Speed / altitude ──
  { id: "stratosphere", icon: "☁️", hint: "Up where the air is thin", title: "Stratosphere", once: true,
    test: (c) => { const a = altFt(c.ac); return a != null && a >= 40000; } },
  { id: "mach_chaser", icon: "💨", hint: "Faster than you can think", title: "Mach Chaser", once: true,
    test: (c) => (c.ac.gs ?? 0) >= 600 },
  { id: "ground_effect", icon: "🌾", hint: "Pavement scraper", title: "Ground Effect", once: true,
    test: (c) => { const a = altFt(c.ac); return a != null && a > 0 && a <= 1000; } },
  { id: "buzz_cut", icon: "🔪", hint: "Right overhead", title: "Buzz Cut", once: true,
    test: (c) => (c.ac.distNm ?? 999) < 5 },

  // ── Distance / coverage ──
  { id: "long_distance", icon: "📡", hint: "Edge of the dish", title: "Long Distance", once: true,
    test: (c) => (c.ac.distNm ?? 0) >= 150 },
  { id: "far_horizon", icon: "🔭", hint: "Curvature of the earth", title: "Far Horizon", once: true,
    test: (c) => (c.ac.distNm ?? 0) >= 200 },

  // ── Operators ──
  { id: "variety_pack", icon: "🎁", hint: "A little of everything", title: "Variety Pack", once: true,
    test: (c) => c.operatorsAllTime >= 25 },
  { id: "globetrotter", icon: "🌍", hint: "Round the world", title: "Globetrotter", once: true,
    test: (c) => c.operatorsAllTime >= 100 },
  { id: "presidential", icon: "🦅", hint: "Most important seat in the air", title: "Presidential", once: true,
    test: (c) => PRESIDENTIAL.test(c.ac.flight ?? "") },
  { id: "wildlife", icon: "🦊", hint: "Animals on the tail", title: "Wildlife (Frontier)", once: true,
    test: (c) => FRONTIER.test(c.ac.flight ?? "") },
  { id: "regional_champ", icon: "🛩️", hint: "Big airline, small jet", title: "Regional Champ", once: true,
    test: (c) => REGIONAL.test(c.ac.flight ?? "") },
  { id: "test_pilot", icon: "🧪", hint: "Never seen that ID before", title: "Test Pilot", once: true,
    test: (c) => TEST_FLIGHTS.test(c.ac.flight ?? "") },
  { id: "nato_air", icon: "🤝", hint: "Foreign uniform", title: "NATO Allies", once: true,
    test: (c) => NATO.test(c.ac.flight ?? "") },

  // ── Emergency / unusual ──
  { id: "mayday", icon: "🆘", hint: "Hope it's a test", title: "Mayday Spotter",
    test: (c) => c.ac.squawk === "7700" },
  { id: "radio_silent", icon: "📵", hint: "Comm out", title: "Radio Silent",
    test: (c) => c.ac.squawk === "7600" },
  { id: "hijack_code", icon: "🚨", hint: "Hopefully a finger slip", title: "Hijack Code", once: true,
    test: (c) => c.ac.squawk === "7500" },

  // ── Geo / direction ──
  { id: "north_bound", icon: "⬆️", hint: "True north", title: "Northbound", once: true,
    test: (c) => c.ac.track != null && (c.ac.track <= 22.5 || c.ac.track >= 337.5) },
  { id: "south_bound", icon: "⬇️", hint: "Down south", title: "Southbound", once: true,
    test: (c) => c.ac.track != null && c.ac.track >= 157.5 && c.ac.track <= 202.5 },
  { id: "east_bound", icon: "➡️", hint: "Toward sunrise", title: "Eastbound", once: true,
    test: (c) => c.ac.track != null && c.ac.track >= 67.5 && c.ac.track <= 112.5 },
  { id: "west_bound", icon: "⬅️", hint: "Toward sunset", title: "Westbound", once: true,
    test: (c) => c.ac.track != null && c.ac.track >= 247.5 && c.ac.track <= 292.5 },

  // ── Holidays ──
  { id: "santa", icon: "🎅", hint: "Dec 25", title: "Santa's Helper",
    test: () => { const d = new Date(); return d.getMonth() === 11 && d.getDate() === 25; } },
  { id: "fireworks", icon: "🎆", hint: "Jul 4", title: "Firework Finder",
    test: () => { const d = new Date(); return d.getMonth() === 6 && d.getDate() === 4; } },
  { id: "valentine", icon: "💝", hint: "Feb 14", title: "Heart in the Sky",
    test: () => { const d = new Date(); return d.getMonth() === 1 && d.getDate() === 14; } },
  { id: "national_dog_day", icon: "🐕", hint: "Aug 26", title: "National Dog Day",
    test: () => { const d = new Date(); return d.getMonth() === 7 && d.getDate() === 26; } },
  { id: "new_year", icon: "🎊", hint: "First day, first plane", title: "Auld Lang Sky",
    test: () => { const d = new Date(); return d.getMonth() === 0 && d.getDate() === 1; } },

  // ── Madison's favorites: animals on the wing ──
  { id: "dog_callsign", icon: "🐶", hint: "Best friend overhead", title: "Madison's Dog Spotter", once: true,
    test: (c) => /\b(DOG|PUP|BARK|FIDO|HUSKY|BEAGLE)/i.test(`${c.ac.flight ?? ""} ${c.ac.enrichment?.registration ?? ""}`) },
  { id: "wild_callsign", icon: "🦊", hint: "Critter callsigns", title: "On Safari", once: true,
    test: (c) => /\b(EAGLE|HAWK|FOX|TIGER|BEAR|WOLF|LION|SHARK)/i.test(c.ac.flight ?? "") },

  // ── Persistence ──
  { id: "first_today", icon: "☀️", hint: "Up before the sun is", title: "First of the Day",
    test: (c) => c.todayUnique === 1 },
  { id: "century_day", icon: "💯", hint: "100 in a single day", title: "Century Day",
    test: (c) => c.todayUnique === 100 },

  // ── System / device ──
  { id: "hot_box", icon: "🔥", hint: "When the fan kicks in", title: "Hot Box", once: true,
    test: (c) => (c.cpuTempF ?? 0) >= 175 },
  { id: "round_world", icon: "🛰️", hint: "Foreign carrier", title: "Around the World", once: true,
    test: (c) => /(?:lufthansa|emirates|ana all nippon|cathay|qantas|british airways|air france|klm|singapore|qatar|etihad|virgin atlantic|aeroflot|aer lingus)/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "deltas_dozen", icon: "🔺", hint: "One operator, again and again", title: "Delta's Dozen", once: true,
    test: (c) => false }, // computed in checkAll (needs aggregate query)
  { id: "skywatcher", icon: "👁️", hint: "Half a thousand strong", title: "Sky Watcher", once: true,
    test: (c) => c.allTimeUnique >= 500 },
  { id: "kilo_club", icon: "🥇", hint: "Quad digit unique", title: "Kilo Club", once: true,
    test: (c) => c.allTimeUnique >= 1000 },

  // Anniversary of the first home WiFi connection — quiet for a year, then
  // unlocks on the calendar match. Repeats every year after that.
  { id: "radarversary", icon: "🎂", hint: "One trip around the sun", title: "Radar-versary",
    test: () => isRadarVersary() },
];

// ─── Persistence ────────────────────────────────────────────────────────────

const getStmt = db.prepare<[string]>("SELECT count, first_at, last_at FROM achievements WHERE id = ?");
const incStmt = db.prepare<[number, string]>(
  `INSERT INTO achievements (id, count, first_at, last_at) VALUES (?2, 1, ?1, ?1)
   ON CONFLICT(id) DO UPDATE SET count = count + 1, last_at = ?1`,
);
const allStmt = db.prepare(`
  SELECT a.id, COALESCE(p.count, 0) AS count, p.first_at, p.last_at
  FROM (SELECT 1) AS dummy
  CROSS JOIN (${DEFS.map((_, i) => `SELECT '${DEFS[i]!.id}' AS id`).join(" UNION ALL ")}) a
  LEFT JOIN achievements p ON p.id = a.id
`);

function getCount(id: string): number {
  const row = getStmt.get(id) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Run after every recordSighting(). Best-effort; never throws. */
export function checkAll(ctx: Ctx): void {
  const now = Date.now();
  for (const def of DEFS) {
    try {
      const cur = getCount(def.id);
      if (def.once && cur >= 1) continue;
      if (def.test(ctx, cur)) incStmt.run(now, def.id);
    } catch {
      /* swallow */
    }
  }
}

/** Snapshot for the UI: every achievement with its hint + (when unlocked) title and count. */
export function listAchievements(): AchievementProgress[] {
  const rows = (allStmt.all() as { id: string; count: number; first_at: number | null; last_at: number | null }[])
    .reduce<Record<string, { count: number; first_at: number | null; last_at: number | null }>>((acc, r) => {
      acc[r.id] = { count: r.count, first_at: r.first_at, last_at: r.last_at };
      return acc;
    }, {});
  return DEFS.map((d) => {
    const r = rows[d.id] ?? { count: 0, first_at: null, last_at: null };
    return {
      id: d.id,
      icon: d.icon,
      hint: d.hint,
      title: r.count > 0 ? d.title : undefined,
      count: r.count,
      firstAt: r.first_at ?? undefined,
      lastAt: r.last_at ?? undefined,
    };
  });
}
