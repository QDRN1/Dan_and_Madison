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

/** Definition of an achievement badge (server-side; sent to the UI). */
export interface AchievementDef {
  id: string;
  icon: string;
  hint: string;
  title: string;
}

/** What the UI sees per achievement — hint always, title+count once unlocked. */
export interface AchievementProgress {
  id: string;
  icon: string;
  hint: string;
  /** Set only when count > 0 (so the UI keeps things mysterious). */
  title?: string;
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
