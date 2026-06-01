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
  /** Epoch ms the sighting occurred. Lets time-of-day predicates use the
   *  sighting's own clock instead of `new Date()` — backfill replays history
   *  outside of "now", and using wall-clock there blew golden_hour to 11,530. */
  now: number;
  todayUnique: number;          // running count BEFORE this sighting was upserted
  allTimeUnique: number;        // running count BEFORE this sighting was upserted
  operatorsToday: number;
  operatorsAllTime: number;
  cpuTempF?: number;
}

const hourOf = (c: Ctx): number => new Date(c.now).getHours();

function isMilitary(op?: string | null): boolean {
  if (!op) return false;
  return /\b(air force|navy|army|marine|coast guard|national guard|military|royal air|nato|space force)\b/i.test(op);
}

function altFt(ac: Aircraft): number | null {
  if (ac.altBaro == null) return null;
  if (ac.altBaro === "ground") return 0;
  return typeof ac.altBaro === "number" ? ac.altBaro : null;
}

/** Longer "here's what this badge means" copy keyed by achievement id.
 *  Surfaced only after the badge is earned, so it doesn't spoil unearned
 *  ones — the `hint` field still teases the locked state. Missing entries
 *  fall back to the hint in the UI. */
const DESCRIPTIONS: Record<string, string> = {
  // Volume / staying power
  first_sighting: "Your first ADS-B contact ever. Every other badge on this list is downstream of this moment.",
  ten_sightings: "Ten unique aircraft tracked all-time. You're past the random-poke phase and are actually using the radar.",
  hundred_today: "100 unique aircraft in a single day — the Pi's antenna is earning its keep.",
  mile_high: "Every 5,280 unique aircraft tracked. Named after the actual altitude club but counting unique hexes instead of feet.",
  iron_eyes: "Ten thousand unique aircraft ever. You've watched the sky for real.",

  // Time of day
  dawn_patrol: "Spotted an aircraft between 5 and 7 AM local — the dawn cargo and early commuter slot.",
  golden_hour: "Spotted an aircraft between 7 and 9 PM local — the last-light window photographers chase.",
  midnight_owl: "Spotted an aircraft during the midnight hour (00:00–00:59 local).",
  graveyard: "Spotted an aircraft between 2 and 5 AM local — overnight cargo and red-eyes only.",
  breakfast_hour: "Spotted an aircraft between 7 and 8 AM local — the breakfast departure bank.",
  lunch_rush: "Spotted an aircraft between 12 and 1 PM local.",
  evening_traffic: "Spotted an aircraft between 6 and 7 PM local — evening commute bank.",
  late_evening: "Spotted an aircraft between 10 and 11 PM local.",

  // Aircraft types
  iron_eagle: "Spotted a military aircraft — operator field matched air force, navy, army, marines, NATO, or related.",
  heavy_metal: "Spotted a wide-body airliner — 747, 767, 777, 787, A330/340/350/380, MD-11, IL-96, L-1011.",
  superjumbo: "Spotted an Airbus A380. ICAO type code A388 — only Emirates, Singapore, BA, Qantas, Lufthansa, ANA, Korean, China Southern, Etihad still fly them.",
  warbird: "Spotted a WWII-era warbird (P-51, P-40, B-17, B-25, B-29, SBD, TBM, F4U, SNJ, T-6).",
  whirlybird: "Spotted a helicopter — Robinson 22/44/66, Eurocopter, H125/135/145, UH-60, AS3xx, S-70, etc.",
  cargo_king: "Spotted a major cargo carrier — FedEx, UPS, DHL, Atlas, Polar, Kalitta, Amerijet, Cargolux, West Cargo.",
  bizjet: "Spotted a business jet — Citation, Gulfstream, Global Express, Hawker, Falcon, Challenger, Embraer Phenom, Learjet.",
  blimp_spotter: "Spotted a blimp or airship — Goodyear or otherwise.",
  a380_spotter: "Sentinel badge for the A380 — same predicate as Superjumbo, kept separate as a manual test of the achievement engine.",
  b777_spotter: "Spotted a Boeing 777 — the long-haul workhorse. ICAO type codes B772, B77L, B77W, B773.",
  b787_spotter: "Spotted a Boeing 787 Dreamliner. ICAO type codes B788, B789, B78X.",
  b737_spotter: "Spotted a Boeing 737 — domestic mainline backbone in the US. The most common type you'll see by far.",
  a320_family_spotter: "Spotted an Airbus A320 family aircraft (A319, A320, A321, A32N).",
  embraer_spotter: "Spotted a Brazilian-built Embraer regional jet (E135 through E195).",
  crj_spotter: "Spotted a Bombardier CRJ — the long, tight regional jet you've been crammed into for a Delta Connection hop.",
  atr_spotter: "Spotted an ATR turboprop — the European-built twin you only see on shorter regional routes.",
  dc3_spotter: "Spotted a DC-3. Designed in 1935, still flying commercial cargo runs almost 90 years later.",

  // Speed / altitude / distance
  stratosphere: "Spotted an aircraft cruising above 40,000 feet — into the bottom of the stratosphere.",
  mach_chaser: "Spotted an aircraft moving at 600+ knots ground speed.",
  ground_effect: "Spotted an aircraft below 200 feet — likely on short final or just airborne.",
  buzz_cut: "Spotted an aircraft right overhead — within 0.5 nautical miles of the receiver, alt under 2,000 ft.",
  long_distance: "Spotted an aircraft at 200+ nm range — most of the way to the radar horizon.",
  far_horizon: "Spotted an aircraft at 250+ nm range — pushing the theoretical reception limit for a Pi at this altitude.",
  slow_flyer: "Spotted an aircraft moving slower than 100 knots ground speed — small GA or a heavy on approach.",
  fast_mover: "Spotted an aircraft moving at 500+ knots ground speed — strong jet stream tailwind.",
  quick_climber: "Spotted an aircraft climbing at 3,000+ feet per minute — military, or a light jet showing off.",
  quick_descender: "Spotted an aircraft descending at 3,000+ feet per minute — emergency descent profile or just a steep approach.",
  edge_of_radar: "Spotted an aircraft at 150+ nm — beyond your typical reception ring.",
  horizon_pusher: "Spotted an aircraft at 200+ nm — right at the radar horizon.",

  // Operators / callsigns / specials
  variety_pack: "Tracked aircraft from 25+ distinct operators all-time.",
  globetrotter: "Tracked aircraft from 100+ distinct operators all-time.",
  presidential: "Spotted a presidential or executive flight (AF1/AF2/VENUS/SAM/EXEC callsign).",
  wildlife: "Spotted a Frontier Airlines (FFT) flight — every Frontier tail has a real animal painted on it.",
  regional_champ: "Spotted a US regional carrier (SkyWest, Endeavor, Republic, GoJet, PSA, Piedmont, etc.).",
  test_pilot: "Spotted a manufacturer test flight (Boeing BOEnn or Airbus AIB callsign).",
  nato_air: "Spotted a NATO-allied military aircraft (RAF/RFR/GAF/GAM/ASCOT/RRR/NATO).",

  // Emergency squawks
  mayday: "Witnessed a 7700 squawk — general emergency. Hopefully a test or a misclick.",
  radio_silent: "Witnessed a 7600 squawk — radio failure.",
  hijack_code: "Witnessed a 7500 squawk — unlawful interference / hijack code. Almost always a finger slip.",

  // Direction
  north_bound: "Spotted an aircraft tracking due north (track within ±22.5° of 0°).",
  south_bound: "Spotted an aircraft tracking due south.",
  east_bound: "Spotted an aircraft tracking due east.",
  west_bound: "Spotted an aircraft tracking due west.",

  // Holidays
  santa: "Spotted on December 25.",
  fireworks: "Spotted on July 4.",
  valentine: "Spotted on February 14.",
  national_dog_day: "Spotted on August 26 — National Dog Day. For Madison.",
  new_year: "Spotted on January 1.",

  // Animals
  dog_callsign: "Caught a callsign containing DOG / PUP / BARK / FIDO / HUSKY / BEAGLE.",
  wild_callsign: "Caught a callsign with a wild animal in it (EAGLE / HAWK / FOX / TIGER / BEAR / WOLF / LION / SHARK).",

  // Persistence / day
  first_today: "First plane of the day, every day. The opening bell.",
  century_day: "100 unique aircraft in a single day.",

  // System
  hot_box: "Pi CPU temperature crossed 175°F when this aircraft was sighted — the fan is earning its money.",
  round_world: "Spotted a major foreign carrier overhead.",
  deltas_dozen: "(unused — was a planned aggregate-window predicate)",
  skywatcher: "Five hundred unique aircraft tracked all-time.",
  kilo_club: "One thousand unique aircraft tracked all-time.",
  radarversary: "Anniversary of the first home WiFi connection. Fires once per year.",

  // Foreign airline spotters
  spotted_emirates: "Spotted an Emirates flight overhead. Look at the route — odds are it's headed for Dubai.",
  spotted_lufthansa: "Spotted a Lufthansa flight — German flag carrier with the crane on the tail.",
  spotted_british_airways: "Spotted a British Airways flight — callsign Speedbird.",
  spotted_air_france: "Spotted an Air France flight — French flag carrier with the tricolor stripe.",
  spotted_klm: "Spotted a KLM flight — the oldest still-operating airline in the world (founded 1919).",
  spotted_qatar: "Spotted a Qatar Airways flight — Skytrax World's Best Airline regular.",
  spotted_singapore: "Spotted a Singapore Airlines flight — Pacific star carrier.",
  spotted_cathay: "Spotted a Cathay Pacific flight — Hong Kong flag carrier with the brushwing logo.",
  spotted_jal: "Spotted a Japan Airlines flight — the tsurumaru (crane) tail.",
  spotted_ana: "Spotted an All Nippon Airways flight — Japan's largest carrier.",
  spotted_virgin_atlantic: "Spotted a Virgin Atlantic flight — red tails, named individual aircraft.",
  spotted_korean_air: "Spotted a Korean Air flight — the taegeuk on the tail.",
  spotted_turkish: "Spotted a Turkish Airlines flight — flies to more countries than any other airline.",

  // US airline spotters
  spotted_southwest: "Spotted a Southwest Airlines flight — open seating, heart on the belly.",
  spotted_alaska: "Spotted an Alaska Airlines flight — Eskimo face on the tail.",
  spotted_jetblue: "Spotted a JetBlue flight — all-blue tail patterns.",
  spotted_spirit: "Spotted a Spirit Airlines flight — yellow ultra-low-cost.",
  spotted_hawaiian: "Spotted a Hawaiian Airlines flight — Pualani (flower of the sky) on the tail.",
  spotted_allegiant: "Spotted an Allegiant Air flight — Vegas/Florida route specialist.",

  // Cargo
  spotted_fedex: "Spotted a FedEx Express flight — purple tail, Memphis hub.",
  spotted_ups: "Spotted a UPS flight — brown delivers from above.",
  spotted_dhl: "Spotted a DHL flight — yellow and red express.",
  spotted_atlas: "Spotted an Atlas Air flight — ACMI carrier moving anything for anyone.",

  // Volume long-tail
  quarter_kilo: "250 unique aircraft tracked all-time.",
  half_kilo: "500 unique aircraft tracked all-time.",
  two_kilo: "2,000 unique aircraft tracked all-time.",
  five_kilo: "5,000 unique aircraft tracked all-time.",
  ten_kilo: "10,000 unique aircraft tracked all-time.",

  // Squawks / day
  vfr_squawk: "Spotted an aircraft squawking 1200 — VFR conspicuity code, usually small private GA.",
  normal_squawk_7000: "Spotted an aircraft squawking 7000 — ICAO general conspicuity code outside the US.",
  fifty_today: "50 unique aircraft in a single day.",
  two_hundred_today: "200 unique aircraft in a single day — a really busy reception window.",
  operator_variety: "Saw 10+ distinct operators in a single day.",
  operator_pageant: "Saw 25+ distinct operators in a single day.",
};

// ICAO type designators, not marketing names. A380-800 is "A388",
// 777-300ER is "B77W", 787-9 is "B789", etc. The old regex used "A380"
// which never matched real data and silently never fired.
const WIDEBODY = /\b(A30[0-9B]|A310|A33[0-9NF]|A34[0-9]|A35[0-9KF]|A38[0-9NF]|B74[0-9SLM]|B75[0-9]|B76[0-9]|B77[0-9LWX]|B78[0-9X]|MD11|DC10|IL96|L101)\b/i;
const A380_RE = /\bA38[0-9NF]\b/i;
const B777_RE = /\bB77[0-9LWX]\b/i;
const B787_RE = /\bB78[0-9X]\b/i;
const B737_RE = /\bB73[0-9MNJ]\b/i;
const A320_FAMILY = /\bA(318|319|320|321|32[NF])\b/i;
const EMBRAER_REGIONAL = /\b(E1[3579]0|E1[3579]5|E17[0-9]|E19[0-9])\b/i;
const CRJ_RE = /\bCRJ[0-9X]\b/i;
const ATR_RE = /\b(AT4[0-9]|AT7[0-9]|ATR)\b/i;
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

  // ── Time of day (uses the sighting's own clock, not wall-clock) ──
  { id: "dawn_patrol", icon: "🌅", hint: "Early bird gets the worm", title: "Dawn Patrol",
    test: (c) => { const h = hourOf(c); return h >= 5 && h < 7; } },
  { id: "golden_hour", icon: "🌇", hint: "Last light", title: "Golden Hour",
    test: (c) => { const h = hourOf(c); return h >= 19 && h < 21; } },
  { id: "midnight_owl", icon: "🌙", hint: "Witching hour", title: "Midnight Watcher",
    test: (c) => hourOf(c) === 0 },
  { id: "graveyard", icon: "🦉", hint: "Should you be up?", title: "Graveyard Shift",
    test: (c) => { const h = hourOf(c); return h >= 2 && h < 5; } },

  // ── Aircraft types ──
  { id: "iron_eagle", icon: "🪖", hint: "Salute a uniform", title: "Iron Eagle", once: true,
    test: (c) => isMilitary(c.ac.enrichment?.operator) || isMilitary(c.ac.enrichment?.owner) },
  { id: "heavy_metal", icon: "🛫", hint: "Real heavy lifting", title: "Heavy Metal", once: true,
    test: (c) => WIDEBODY.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "superjumbo", icon: "🛩️", hint: "Two decks of grins", title: "Superjumbo", once: true,
    test: (c) => A380_RE.test(c.ac.enrichment?.typeCode ?? "") },
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

  // Sentinel achievement used to verify the predicate path against a known
  // aircraft type. The A380 superjumbo is rare enough overhead to be an
  // obvious test trigger; double-counts with `superjumbo` (same predicate)
  // so both fire on the same plane.
  { id: "a380_spotter", icon: "🦣", hint: "Two decks, four engines", title: "A380 Spotter", once: true,
    test: (c) => A380_RE.test(c.ac.enrichment?.typeCode ?? "") },

  // ── Aircraft type spotters (47 new) ──
  { id: "b777_spotter", icon: "🛬", hint: "Triple seven overhead", title: "Triple Seven Spotter", once: true,
    test: (c) => B777_RE.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "b787_spotter", icon: "🪶", hint: "Dreamliner overhead", title: "Dreamliner Spotter", once: true,
    test: (c) => B787_RE.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "b737_spotter", icon: "✈️", hint: "Workhorse of the skies", title: "737 Spotter", once: true,
    test: (c) => B737_RE.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "a320_family_spotter", icon: "🛩️", hint: "European workhorse", title: "A320 Family", once: true,
    test: (c) => A320_FAMILY.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "embraer_spotter", icon: "🇧🇷", hint: "Brazilian regional", title: "Embraer Spotter", once: true,
    test: (c) => EMBRAER_REGIONAL.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "crj_spotter", icon: "🪁", hint: "Tight cabin, long legs", title: "CRJ Spotter", once: true,
    test: (c) => CRJ_RE.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "atr_spotter", icon: "🌀", hint: "Twin turboprop", title: "ATR Spotter", once: true,
    test: (c) => ATR_RE.test(c.ac.enrichment?.typeCode ?? "") },
  { id: "dc3_spotter", icon: "🎞️", hint: "1935 design, still flying", title: "DC-3 Spotter", once: true,
    test: (c) => /\bDC3\b/i.test(c.ac.enrichment?.typeCode ?? "") },

  // ── Foreign airline spotters ──
  { id: "spotted_emirates", icon: "🇦🇪", hint: "Dubai overhead", title: "Spotted Emirates", once: true,
    test: (c) => /emirates/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_lufthansa", icon: "🇩🇪", hint: "Crane on the tail", title: "Spotted Lufthansa", once: true,
    test: (c) => /lufthansa/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_british_airways", icon: "🇬🇧", hint: "Speedbird overhead", title: "Spotted British Airways", once: true,
    test: (c) => /british airways/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_air_france", icon: "🇫🇷", hint: "Tricolor in the sky", title: "Spotted Air France", once: true,
    test: (c) => /air france/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_klm", icon: "🇳🇱", hint: "Royal Dutch overhead", title: "Spotted KLM", once: true,
    test: (c) => /\bklm\b/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_qatar", icon: "🇶🇦", hint: "Oryx on the tail", title: "Spotted Qatar Airways", once: true,
    test: (c) => /qatar/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_singapore", icon: "🇸🇬", hint: "Pacific star carrier", title: "Spotted Singapore Airlines", once: true,
    test: (c) => /singapore/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_cathay", icon: "🇭🇰", hint: "Brushwing in flight", title: "Spotted Cathay Pacific", once: true,
    test: (c) => /cathay/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_jal", icon: "🇯🇵", hint: "Tsurumaru overhead", title: "Spotted Japan Airlines", once: true,
    test: (c) => /japan airlines|\bjal\b/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_ana", icon: "🇯🇵", hint: "Triton in the sky", title: "Spotted ANA", once: true,
    test: (c) => /\bana\b|all nippon/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_virgin_atlantic", icon: "🦄", hint: "Red tail overhead", title: "Spotted Virgin Atlantic", once: true,
    test: (c) => /virgin atlantic/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_korean_air", icon: "🇰🇷", hint: "Taegeuk in the sky", title: "Spotted Korean Air", once: true,
    test: (c) => /korean air/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_turkish", icon: "🇹🇷", hint: "Bridge between two worlds", title: "Spotted Turkish Airlines", once: true,
    test: (c) => /turkish airlines/i.test(c.ac.enrichment?.operator ?? "") },

  // ── US airline spotters ──
  { id: "spotted_southwest", icon: "💛", hint: "Heart livery overhead", title: "Spotted Southwest", once: true,
    test: (c) => /southwest/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_alaska", icon: "🗻", hint: "Eskimo on the tail", title: "Spotted Alaska", once: true,
    test: (c) => /alaska/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_jetblue", icon: "💙", hint: "All-blue tail", title: "Spotted JetBlue", once: true,
    test: (c) => /jetblue/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_spirit", icon: "💛", hint: "Yellow with a smile", title: "Spotted Spirit", once: true,
    test: (c) => /spirit/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_hawaiian", icon: "🌺", hint: "Pualani in flight", title: "Spotted Hawaiian", once: true,
    test: (c) => /hawaiian/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_allegiant", icon: "🎰", hint: "Vegas route specialist", title: "Spotted Allegiant", once: true,
    test: (c) => /allegiant/i.test(c.ac.enrichment?.operator ?? "") },

  // ── Cargo carrier spotters ──
  { id: "spotted_fedex", icon: "📦", hint: "Purple tail overhead", title: "Spotted FedEx", once: true,
    test: (c) => /fedex/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_ups", icon: "🟫", hint: "Brown delivers from above", title: "Spotted UPS", once: true,
    test: (c) => /\bups\b/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_dhl", icon: "📮", hint: "Yellow + red express", title: "Spotted DHL", once: true,
    test: (c) => /\bdhl\b/i.test(c.ac.enrichment?.operator ?? "") },
  { id: "spotted_atlas", icon: "🌍", hint: "Atlas on the wing", title: "Spotted Atlas Air", once: true,
    test: (c) => /atlas/i.test(c.ac.enrichment?.operator ?? "") },

  // ── Volume milestones (long-tail) ──
  { id: "quarter_kilo", icon: "🥉", hint: "A quarter of a thousand", title: "Quarter Kilo", once: true,
    test: (c) => c.allTimeUnique >= 250 },
  { id: "half_kilo", icon: "🥈", hint: "Halfway to four digits", title: "Half Kilo", once: true,
    test: (c) => c.allTimeUnique >= 500 },
  { id: "two_kilo", icon: "🔟", hint: "Twice the club", title: "Two Kilo Club", once: true,
    test: (c) => c.allTimeUnique >= 2000 },
  { id: "five_kilo", icon: "💎", hint: "Five thousand unique", title: "Five Kilo Club", once: true,
    test: (c) => c.allTimeUnique >= 5000 },
  { id: "ten_kilo", icon: "👑", hint: "Five-digit unique", title: "Ten Kilo Club", once: true,
    test: (c) => c.allTimeUnique >= 10000 },

  // ── More time-of-day buckets ──
  { id: "breakfast_hour", icon: "🥞", hint: "Coffee + traffic", title: "Breakfast Hour",
    test: (c) => { const h = hourOf(c); return h >= 7 && h < 8; } },
  { id: "lunch_rush", icon: "🥪", hint: "Midday departures", title: "Lunch Rush",
    test: (c) => { const h = hourOf(c); return h >= 12 && h < 13; } },
  { id: "evening_traffic", icon: "🌃", hint: "Headed home", title: "Evening Traffic",
    test: (c) => { const h = hourOf(c); return h >= 18 && h < 19; } },
  { id: "late_evening", icon: "🌌", hint: "After the news", title: "Late Evening",
    test: (c) => { const h = hourOf(c); return h >= 22 && h < 23; } },

  // ── Squawks & special codes ──
  { id: "vfr_squawk", icon: "🔢", hint: "Twelve hundred", title: "VFR Squawk", once: true,
    test: (c) => c.ac.squawk === "1200" },
  { id: "normal_squawk_7000", icon: "7️⃣", hint: "ICAO conspicuity", title: "Conspicuity Code", once: true,
    test: (c) => c.ac.squawk === "7000" },

  // ── Speed / altitude extremes ──
  { id: "slow_flyer", icon: "🐢", hint: "Below a hundred knots", title: "Slow Flyer", once: true,
    test: (c) => (c.ac.gs ?? 9999) < 100 && (c.ac.gs ?? 0) > 0 },
  { id: "fast_mover", icon: "🚀", hint: "Five hundred knots over", title: "Fast Mover", once: true,
    test: (c) => (c.ac.gs ?? 0) >= 500 },
  { id: "quick_climber", icon: "📈", hint: "Three thousand feet per minute up", title: "Quick Climber", once: true,
    test: (c) => (c.ac.baroRate ?? 0) >= 3000 },
  { id: "quick_descender", icon: "📉", hint: "Three thousand feet per minute down", title: "Quick Descender", once: true,
    test: (c) => (c.ac.baroRate ?? 0) <= -3000 },
  { id: "edge_of_radar", icon: "📡", hint: "Hundred and fifty out", title: "Edge of Radar", once: true,
    test: (c) => (c.ac.distNm ?? 0) >= 150 },
  { id: "horizon_pusher", icon: "🌅", hint: "Two hundred nautical out", title: "Horizon Pusher", once: true,
    test: (c) => (c.ac.distNm ?? 0) >= 200 },

  // ── Busy-day bookends ──
  { id: "fifty_today", icon: "5️⃣0️⃣", hint: "Half a hundred in a day", title: "Fifty Today",
    test: (c) => c.todayUnique === 50 },
  { id: "two_hundred_today", icon: "🎯", hint: "Two hundred in a day", title: "Two Hundred Day",
    test: (c) => c.todayUnique === 200 },
  { id: "operator_variety", icon: "🎨", hint: "Ten operators in a day", title: "Operator Variety",
    test: (c) => c.operatorsToday === 10 },
  { id: "operator_pageant", icon: "🌈", hint: "Twenty-five operators in a day", title: "Operator Pageant",
    test: (c) => c.operatorsToday === 25 },
];

// ─── Persistence ────────────────────────────────────────────────────────────

const getStmt = db.prepare<[string]>("SELECT count, first_at, last_at FROM achievements WHERE id = ?");
// Named parameters here are deliberate. The previous version used
// `VALUES (?2, 1, ?1, ?1)` with positional `?N` markers — better-sqlite3
// silently rejected the out-of-order layout and every checkAll() iteration
// raised, so 2,347 sightings produced exactly 0 unlocks. Named binds remove
// the ambiguity completely.
const incStmt = db.prepare(
  `INSERT INTO achievements (id, count, first_at, last_at)
   VALUES (@id, 1, @ts, @ts)
   ON CONFLICT(id) DO UPDATE SET count = count + 1, last_at = @ts,
                                 first_at = COALESCE(first_at, @ts)`,
);
const seedStmt = db.prepare<[string]>(
  `INSERT INTO achievements (id, count) VALUES (?, 0) ON CONFLICT(id) DO NOTHING`,
);
const allStmt = db.prepare(`
  SELECT a.id, COALESCE(p.count, 0) AS count, p.first_at, p.last_at
  FROM (SELECT 1) AS dummy
  CROSS JOIN (${DEFS.map((_, i) => `SELECT '${DEFS[i]!.id}' AS id`).join(" UNION ALL ")}) a
  LEFT JOIN achievements p ON p.id = a.id
`);

// Seed every defined achievement with count=0 and drop orphaned IDs from
// past renames. Wrapped in one defensive block so a single startup blip
// (table not ready, weird state from a partial migration, anything) can't
// take the server down — but the error gets logged so it's diagnosable.
try {
  for (const def of DEFS) seedStmt.run(def.id);
  const placeholders = DEFS.map(() => "?").join(",");
  db.prepare(`DELETE FROM achievements WHERE id NOT IN (${placeholders})`).run(...DEFS.map((d) => d.id));
} catch (e) {
  console.error("[achievements] seed/cleanup failed:", (e as Error).message);
}

/** Number of defined achievements — used as the authoritative denominator. */
export const DEFINED_ACHIEVEMENTS = DEFS.length;

function getCount(id: string): number {
  const row = getStmt.get(id) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Run after every recordSighting(). Best-effort; never throws — but errors
 *  are now logged so a misbehaving predicate or column-shape change is
 *  visible in `docker logs` instead of failing silently. */
export function checkAll(ctx: Ctx): void {
  const now = Date.now();
  for (const def of DEFS) {
    try {
      const cur = getCount(def.id);
      if (def.once && cur >= 1) continue;
      if (def.test(ctx, cur)) incStmt.run({ id: def.id, ts: now });
    } catch (e) {
      console.error(`[achievements] ${def.id} threw:`, (e as Error).message);
    }
  }
}

/** Walk the sightings table and re-run every predicate against each row in
 *  chronological order. Idempotent — `once` achievements only fire once even
 *  if you run this repeatedly. Used by the admin "Backfill achievements"
 *  button to retroactively unlock badges from history when the live path was
 *  broken at the time. */
export function backfillAchievements(): { processed: number; fired: number } {
  const rows = db.prepare(`
    SELECT hex, day, flight, type_code AS typeCode, type_name AS typeName,
           operator, origin_icao AS originIcao, dest_icao AS destIcao,
           first_seen AS firstSeen, last_seen AS lastSeen, max_dist_nm AS maxDistNm
    FROM sightings ORDER BY first_seen ASC
  `).all() as Array<{
    hex: string; day: string; flight: string | null;
    typeCode: string | null; typeName: string | null; operator: string | null;
    originIcao: string | null; destIcao: string | null;
    firstSeen: number; lastSeen: number; maxDistNm: number;
  }>;

  // Zero every count before walking — otherwise re-running backfill stacks
  // repeatable predicates (golden_hour, century_day, etc.) on top of prior
  // runs. first_at stays so the original unlock moment isn't lost.
  db.exec("UPDATE achievements SET count = 0, last_at = NULL");

  const todaySeen = new Set<string>();
  const everSeen = new Set<string>();
  let curDay = "";
  let todayUnique = 0;
  let allTimeUnique = 0;

  for (const r of rows) {
    if (r.day !== curDay) { curDay = r.day; todaySeen.clear(); todayUnique = 0; }
    const isNewToday = !todaySeen.has(r.hex);
    const isNewEver  = !everSeen.has(r.hex);
    if (isNewToday) { todaySeen.add(r.hex); todayUnique++; }
    if (isNewEver)  { everSeen.add(r.hex);  allTimeUnique++; }

    const ac: Aircraft = {
      hex: r.hex,
      flight: r.flight ?? undefined,
      enrichment: {
        typeCode: r.typeCode ?? undefined,
        typeName: r.typeName ?? undefined,
        operator: r.operator ?? undefined,
      },
      distNm: r.maxDistNm,
    } as Aircraft;

    checkAll({
      ac,
      day: r.day,
      // Use the sighting's own timestamp so time-of-day predicates fire
      // against when the plane was actually overhead, not wall-clock now.
      now: r.firstSeen,
      todayUnique,
      allTimeUnique,
      operatorsToday: 0,
      operatorsAllTime: 0,
    });
  }
  const fired = (db.prepare("SELECT COALESCE(SUM(count), 0) n FROM achievements").get() as { n: number }).n;
  return { processed: rows.length, fired };
}

/** End-to-end probe of the achievement persistence path. Returns the table
 *  shape, the seeded row count, and the result of directly trying to fire
 *  `first_sighting` through incStmt. Lets us pinpoint where the chain breaks
 *  without grepping container logs. */
export function diagnoseAchievements(): {
  defined: number;
  rows: number;
  populated: number;
  firstSightingBefore: number;
  firstSightingAfter: number;
  incStmtWorked: boolean;
  incStmtError?: string;
  topUnlocked: { id: string; count: number }[];
  topTypes: { typeCode: string; count: number }[];
  a38xSightings: { typeCode: string; flight: string | null; operator: string | null }[];
} {
  const defined = DEFINED_ACHIEVEMENTS;
  const rows = (db.prepare("SELECT COUNT(*) n FROM achievements").get() as { n: number }).n;
  const populated = (db.prepare("SELECT COUNT(*) n FROM achievements WHERE count > 0").get() as { n: number }).n;
  const before = (db.prepare("SELECT count FROM achievements WHERE id = 'first_sighting'").get() as { count: number } | undefined)?.count ?? 0;
  let incStmtWorked = false;
  let incStmtError: string | undefined;
  try {
    incStmt.run({ id: "first_sighting", ts: Date.now() });
    incStmtWorked = true;
  } catch (e) {
    incStmtError = (e as Error).message;
  }
  const after = (db.prepare("SELECT count FROM achievements WHERE id = 'first_sighting'").get() as { count: number } | undefined)?.count ?? 0;
  const topUnlocked = db.prepare("SELECT id, count FROM achievements WHERE count > 0 ORDER BY count DESC LIMIT 10").all() as { id: string; count: number }[];
  // Diagnostic surfaces what type codes are actually in the sightings
  // table + every A38x row specifically — so we can see whether the
  // upstream data ever tagged anything as an A380 (ICAO A388).
  const topTypes = db.prepare(`
    SELECT type_code AS typeCode, COUNT(*) AS count FROM sightings
    WHERE type_code IS NOT NULL AND type_code != ''
    GROUP BY type_code ORDER BY count DESC LIMIT 15
  `).all() as { typeCode: string; count: number }[];
  const a38xSightings = db.prepare(`
    SELECT type_code AS typeCode, flight, operator FROM sightings
    WHERE type_code LIKE 'A38%'
    GROUP BY type_code, flight LIMIT 20
  `).all() as { typeCode: string; flight: string | null; operator: string | null }[];
  return {
    defined, rows, populated,
    firstSightingBefore: before, firstSightingAfter: after,
    incStmtWorked, incStmtError, topUnlocked,
    topTypes, a38xSightings,
  };
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
    const earned = r.count > 0;
    return {
      id: d.id,
      icon: d.icon,
      hint: d.hint,
      title: earned ? d.title : undefined,
      // Longer description only goes out for earned badges — locked ones
      // keep the hint as a mystery teaser.
      description: earned ? DESCRIPTIONS[d.id] : undefined,
      count: r.count,
      firstAt: r.first_at ?? undefined,
      lastAt: r.last_at ?? undefined,
    };
  });
}
