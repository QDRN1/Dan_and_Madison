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
  | "hexdb"
  | "flightaware"
  | "flightradar24"
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
}

export interface FlaggedSighting {
  hex: string;
  flight?: string;
  typeName?: string;
  operator?: string;
  reason: string;
  at: number;
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

/** Real connection status per service for the Settings pills. */
export type ConnStatus = "ok" | "invalid" | "error" | "down" | "unset" | "unknown";
export interface Connections {
  flightAwareAeroApi: ConnStatus;
  flightRadar24Token: ConnStatus;
  fr24SharingKey: ConnStatus;
  piawareFeederId: ConnStatus;
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
