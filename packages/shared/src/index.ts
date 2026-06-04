// Shared types between the QDRN Radar backend and frontend.

/** A live aircraft as decoded by readsb/ultrafeeder, normalized for the UI. */
export interface Aircraft {
  /** ICAO 24-bit address, lowercase hex. Stable per airframe. */
  hex: string;
  /** Callsign / flight number as transmitted (trimmed), if any. */
  flight?: string;
  lat?: number;
  lon?: number;
  /** Barometric altitude in feet, or "ground". */
  altBaro?: number | "ground";
  /** Geometric altitude in feet. */
  altGeom?: number;
  /** Ground speed in knots. */
  gs?: number;
  /** True track over ground in degrees. */
  track?: number;
  /** Vertical rate in feet/min. */
  baroRate?: number;
  /** Mode A squawk code. */
  squawk?: string;
  /** Emitter category (A0..C7) — used to pick an icon. */
  category?: string;
  /** RSSI signal strength (dBFS). */
  rssi?: number;
  /** Seconds since this aircraft was last seen. */
  seen?: number;
  /** Distance from receiver in nautical miles (computed). */
  distNm?: number;
  /** Bearing from receiver in degrees (computed). */
  bearing?: number;
  /** Whether this aircraft has a mil/interesting flag (computed). */
  flagged?: boolean;
  /** Enrichment (route/operator/type), filled in asynchronously. */
  enrichment?: Enrichment;
  /** Recent position history (only populated on the detail endpoint). */
  trail?: TrailPoint[];
  /** "adsblol" when this aircraft is sourced from the wider adsb.lol feed
   *  (off-radar fill-in), absent for local ADS-B receiver readings. The map
   *  dims off-radar planes so it's obvious which are our own readings. */
  source?: "local" | "adsblol";
}

/** A single point in an aircraft's recent flight path. */
export interface TrailPoint {
  lon: number;
  lat: number;
  /** Altitude in feet, or null if unknown / on ground. */
  alt: number | null;
  /** Unix ms timestamp. */
  t: number;
}

/** Enrichment data merged in from adsbdb/hexdb/FlightAware/FR24. */
export interface Enrichment {
  registration?: string;
  typeCode?: string; // ICAO type designator, e.g. B738
  typeName?: string; // human, e.g. Boeing 737-800
  operator?: string;
  operatorIcao?: string;
  /** Operating airline IATA code (e.g. DL) — used for the airline logo. */
  operatorIata?: string;
  owner?: string;
  manufacturer?: string;
  built?: string;
  route?: Route;
  /** Photo of the airframe (Planespotters), with attribution. */
  photo?: AircraftPhoto;
  /** Where the enrichment came from, for the UI/debugging. */
  source?: EnrichmentSource;
  /** Unix ms when enrichment was fetched. */
  fetchedAt?: number;
  /** Unix ms of the last paid (AeroAPI) route attempt, to rate-limit retries. */
  paidCheckedAt?: number;
  /** True when the server stripped the route because the plane's live
   *  position didn't match the displayed origin → destination corridor
   *  (e.g. adsb.lol's static rotation is on a different leg). The UI shows
   *  a "route hidden" note instead of the wrong airports. */
  routeStale?: boolean;
}

export interface AircraftPhoto {
  /** Large thumbnail URL, suitable for the detail panel. */
  url: string;
  /** Link back to the photo page (required for attribution). */
  link?: string;
  photographer?: string;
}

export type EnrichmentSource =
  | "adsbdb"
  | "adsblol"
  | "hexdb"
  | "flightaware"
  | "flightradar24"
  | "gateway"
  | "cache";

export interface Airport {
  icao?: string;
  iata?: string;
  name?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

export interface Route {
  callsign?: string;
  origin?: Airport;
  destination?: Airport;
  /** Which source produced this route (so we know when to upgrade to AeroAPI). */
  source?: EnrichmentSource;
  /** Scheduled / estimated / actual times, ISO strings, when available (paid). */
  scheduledOut?: string;
  estimatedOut?: string;
  actualOut?: string;
  scheduledIn?: string;
  estimatedIn?: string;
  actualIn?: string;
  /** Wheels-up time (actual_off), for "departed" when no gate-out is known. */
  actualOff?: string;
  /** 0–100 flight progress, when the paid source reports it. */
  progressPercent?: number;
}

/** Live snapshot pushed over the websocket. */
export interface LiveSnapshot {
  now: number;
  /** Aircraft with a position. */
  aircraft: Aircraft[];
  /** Total messages/sec from the decoder, if known. */
  messageRate?: number;
  /** Receiver location (city-level) for centering / range rings. */
  receiver: ReceiverInfo;
}

export interface ReceiverInfo {
  lat: number;
  lon: number;
  city: string;
  county?: string;
  /** Air Route Traffic Control Center containing the receiver, if known. */
  artcc?: { id: string; name: string };
  rangeRingsNm: number[];
}

export interface Stats {
  /** Aircraft currently being tracked (with position). */
  current: number;
  /** Unique aircraft seen today. */
  todayUnique: number;
  /** Unique aircraft seen all-time. */
  allTimeUnique: number;
  /** Farthest aircraft seen today, nautical miles. */
  maxRangeNmToday: number;
  /** Most-seen operators today. */
  topOperators: { name: string; count: number }[];
  /** Most-seen aircraft types today. */
  topTypes: { type: string; count: number }[];
  /** Recent "interesting" sightings (mil, rare types, etc). */
  recentFlagged: FlaggedSighting[];
  /** SoC temperature in °C if available (Raspberry Pi). */
  cpuTempC?: number;
}

export interface FlaggedSighting {
  hex: string;
  flight?: string;
  typeName?: string;
  operator?: string;
  reason: string;
  at: number;
}

/** A single row in the popout list (today / all-time / farthest views). */
export interface SightingRow {
  hex: string;
  flight?: string | null;
  typeCode?: string | null;
  typeName?: string | null;
  operator?: string | null;
  /** Origin airport code (ICAO preferred, IATA fallback) saved from enrichment. */
  originIcao?: string | null;
  destIcao?: string | null;
  /** Aircraft class bucket (commercial/cargo/private/military/heli/other). */
  klass?: AircraftClass | null;
  firstSeen?: number;
  lastSeen?: number;
  maxDistNm?: number;
}

/** Server-side filters supported by the /stats/sightings popout endpoint. */
export type SightingScope = "today" | "week" | "month" | "all";
export type SightingSort = "recent" | "farthest" | "first";

export interface SightingFilter {
  scope?: SightingScope;
  /** Free-text search over hex, callsign, operator, type. */
  q?: string;
  /** Exact operator name (from the operators dropdown). */
  airline?: string;
  /** Aircraft classification (commercial/cargo/private/military/heli/etc). */
  klass?: AircraftClass;
  /** Sort order. */
  sort?: SightingSort;
  offset?: number;
  limit?: number;
}

export interface SightingPage {
  rows: SightingRow[];
  total: number;
  /** Operator names with counts, useful for populating the airline dropdown. */
  airlines: { name: string; count: number }[];
}

/** Aircraft classification — a high-level "what kind of plane is this"
 *  bucket the user can filter by on both the live map and the report
 *  popouts. classifyAircraft() lives in this file so the server (for
 *  sightings queries) and the client (for live filtering) agree. */
export type AircraftClass =
  | "commercial"  // scheduled airline (Delta, BA, JAL, etc.)
  | "cargo"       // FedEx, UPS, DHL, Atlas, Polar, Kalitta, etc.
  | "private"     // N-number callsign, biz jet, GA
  | "military"    // military operator OR military hex range
  | "helicopter"  // ADS-B category A7 OR helicopter type code
  | "other";      // blimps, gliders, balloons, ground vehicles, unknown

interface ClassifierInput {
  hex: string;
  flight?: string;
  category?: string;        // ADS-B emitter category (A0..C7)
  enrichment?: {
    operator?: string;
    operatorIcao?: string;
    operatorIata?: string;
    typeCode?: string;
  };
}

const HELO_TYPE_RE = /\b(R22|R44|R66|EC[0-9]|H1[35]5|H125|H145|H160|H175|UH-?60|AS3[0-9]|AS65|AS50|AS55|S70|S76|S92|EC1|B407|B412|B429|B505|A109|A119|A139|MD500|MD600|MD9|HEL|UH-|CH-|MI-?[0-9]|KA[0-9])\b/i;
const MIL_OP_RE = /\b(air force|navy|army|marine|coast guard|national guard|military|royal air|nato|space force|usaf|usn|usmc|usa\b|usaf\b)\b/i;
const CARGO_OP_RE = /\b(fedex|federal express|ups|united parcel|dhl|atlas air|polar air|kalitta|amerijet|cargolux|cathay cargo|west cargo|fed ?ex|ata cargo|ups cargo)\b/i;
const BIZJET_TYPE_RE = /\b(C[CL]\d{2,3}|GLF[1-7]|GIV|GV|GVI|GLEX|H25|F2TH|CL30|CL35|CL60|E55P|E55B|E45X|F[57]\d|LJ\d+|PC12|PC24|HDJN|HA4T|JS3[12])\b/i;

/** US military hex ranges (rough). adsbexchange/Mictronics keep the
 *  authoritative list — we cover the most common allocations. */
function isMilitaryHex(hex: string): boolean {
  const h = hex.toUpperCase();
  // US: ADF7C8-AFFFFF
  if (h >= "ADF7C8" && h <= "AFFFFF") return true;
  // UK military: 43C000-43CFFF
  if (h >= "43C000" && h <= "43CFFF") return true;
  // German military: 3F8000-3FBFFF
  if (h >= "3F8000" && h <= "3FBFFF") return true;
  // French military: 3A8000-3AFFFF
  if (h >= "3A8000" && h <= "3AFFFF") return true;
  // Canadian forces: C00000-C00FFF
  if (h >= "C00000" && h <= "C00FFF") return true;
  return false;
}

export function classifyAircraft(ac: ClassifierInput): AircraftClass {
  const op = ac.enrichment?.operator ?? "";
  const type = ac.enrichment?.typeCode ?? "";
  // 1. Helicopter beats everything — a medevac heli is a helicopter,
  //    not a "commercial flight that happens to be a B407".
  if (ac.category === "A7") return "helicopter";
  if (HELO_TYPE_RE.test(type)) return "helicopter";
  // 2. Military — operator string or hex range. Catches AF flights even
  //    when the rotorcraft check above misses (some military helos do).
  if (op && MIL_OP_RE.test(op)) return "military";
  if (isMilitaryHex(ac.hex)) return "military";
  // 3. Cargo carriers next so a 747-400F doesn't get bucketed as
  //    "commercial" just because FedEx has an ICAO code.
  if (op && CARGO_OP_RE.test(op)) return "cargo";
  // 4. Commercial — has an operator with an IATA/ICAO code (scheduled
  //    airline pattern).
  if (op && (ac.enrichment?.operatorIcao || ac.enrichment?.operatorIata)) return "commercial";
  // 5. Private — N-number callsign or biz-jet type code.
  if (ac.flight && /^N\d/.test(ac.flight.trim().toUpperCase())) return "private";
  if (BIZJET_TYPE_RE.test(type)) return "private";
  return "other";
}

export const AIRCRAFT_CLASS_LABELS: Record<AircraftClass, string> = {
  commercial: "Commercial",
  cargo: "Cargo",
  private: "Private",
  military: "Military",
  helicopter: "Helicopters",
  other: "Other",
};

/** A user-pinned callsign to alert on when it enters the radar. */
export interface FlightWatch {
  id: number;
  /** Normalized ICAO-style callsign used for the match (e.g. "DAL2864"). */
  callsign: string;
  /** Whatever the user typed (e.g. "DL2864"). */
  raw_input: string;
  /** Friendly label — who or what this watch is for ("Dan's flight"). */
  name: string | null;
  /** YYYY-MM-DD the flight is expected. Null = any date (always armed). */
  flight_date: string | null;
  note: string | null;
  created_at: number;
  expires_at: number | null;
  fired_at: number | null;
  fired_hex: string | null;
}

/** Fired by the server over the websocket when a watch matches a live plane. */
export interface FlightWatchHit {
  watch: FlightWatch;
  aircraft: Aircraft;
}

/** Definition of an achievement badge (server-side; sent to the UI). */
export interface AchievementDef {
  id: string;
  icon: string;
  hint: string;
  title: string;
  /** Longer plain-language explanation of what triggers / triggered the
   *  badge. Shown in the detail popup once the badge is earned. Omitted
   *  while locked so it doesn't spoil the surprise. */
  description?: string;
}

/** What the UI sees per achievement — hint always, title+count once unlocked. */
export interface AchievementProgress {
  id: string;
  icon: string;
  hint: string;
  /** Set only when count > 0 (so the UI keeps things mysterious). */
  title?: string;
  /** Set only when count > 0 — the longer "here's what this badge means" copy. */
  description?: string;
  count: number;
  firstAt?: number;
  lastAt?: number;
}

/** Farthest tracked point for one bearing bucket, for the coverage outline. */
export interface CoveragePoint {
  bearing: number;
  distNm: number;
  lat: number;
  lon: number;
}

/** AeroAPI usage + spending guard, surfaced in the admin console. */
export interface AeroApiStatus {
  /** Master switch: when false, only free route sources are ever used. */
  enabled: boolean;
  /** Monthly call cap; 0 = unlimited. Past the cap we fall back to free. */
  cap: number;
  /** Calls made in the current month. */
  used: number;
  /** Current month key, YYYY-MM. */
  month: string;
  /** Whether a FlightAware key is configured. */
  keyPresent: boolean;
}

/** A NetworkManager WiFi connection profile (as seen by the host helper). */
export interface WifiNetwork {
  name: string;
  uuid: string;
  autoconnect: boolean;
  priority: number;
  /** True iff this profile is the one currently activated on wlan0. */
  active: boolean;
}

/** A nearby broadcasting WiFi network from a fresh scan. */
export interface WifiScanResult {
  ssid: string;
  /** True if the network requires a password. */
  secured: boolean;
  /** Raw nmcli SECURITY field (e.g. "WPA2", "open"). */
  security: string;
  /** Signal strength 0-100. */
  signal: number;
}

/** Real connection status per service for the Settings pills.
 *  "blocked" = reachable + authenticated but over its quota/limit. */
export type ConnStatus = "ok" | "invalid" | "error" | "down" | "blocked" | "unset" | "unknown";

/** Gateway quota snapshot (from the gateway's /v1/status), for display. */
export interface GatewayInfo {
  name?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  /** ISO8601 when the quota resets, or null for never/forever. */
  resets?: string | null;
}

export interface Connections {
  flightAwareAeroApi: ConnStatus;
  flightRadar24Token: ConnStatus;
  fr24SharingKey: ConnStatus;
  piawareFeederId: ConnStatus;
  gateway: ConnStatus;
  gatewayInfo?: GatewayInfo;
  /** Free position-aware route source (adsb.lol). */
  adsblol: ConnStatus;
}

/** Public, friend-facing config + setup state. */
export interface PublicConfig {
  basePath: string;
  receiver: ReceiverInfo;
  mapStyle: { light: string; dark: string };
  brand: BrandConfig;
  setup: SetupState;
  /** Pilot name for the greeting; empty/undefined → generic "Hello Pilot!". */
  pilotName?: string;
}

/** Full editable settings returned to the PIN-gated Settings tab (incl. secrets). */
export interface AdminSettings {
  pilotName: string;
  receiver: ReceiverInfo;
  keys: {
    flightAwareAeroApi: string;
    flightRadar24Token: string;
    fr24SharingKey: string;
    piawareFeederId: string;
  };
  aero: AeroApiStatus;
  /** Shared API gateway (ops.qdrn.io) this device routes paid lookups through. */
  gateway: { url: string; key: string };
  /** Whether the free adsb.lol route source is currently active. */
  adsblolEnabled: boolean;
  /** Whether the off-radar fill-in (adsb.lol nearby feed) is on. */
  offRadarEnabled: boolean;
}

export interface BrandConfig {
  name: string; // "QDRN Radar"
  tagline?: string;
  logoUrl?: string;
  /** CaptainQ mascot icon, used in the setup wizard. */
  captainUrl?: string;
  colors: {
    bg: string;
    surface: string;
    accent: string;
    accent2: string;
    text: string;
    muted: string;
  };
}

/** What the friend still needs to do, surfaced in the setup wizard. */
export interface SetupState {
  wifiConfigured: boolean;
  locationConfigured: boolean;
  flightAwareConnected: boolean;
  flightRadar24Connected: boolean;
}

export type ServiceName =
  | "ultrafeeder"
  | "fr24feed"
  | "piaware"
  | "qdrn-radar"
  | "cloudflared";

export interface ServiceStatus {
  name: ServiceName;
  running: boolean;
  health?: "healthy" | "unhealthy" | "starting" | "unknown";
  detail?: string;
}
