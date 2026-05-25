import type { BrandConfig, ReceiverInfo } from "@qdrn/shared";
import { lookupArtcc } from "./artcc.js";
import { getSetting, setSetting } from "./db.js";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const BASE_PATH = (() => {
  let p = env("BASE_PATH", "/md");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
})();

// Timezone for daily stat buckets (e.g. "America/Chicago"). Defaults to UTC;
// falls back to UTC if the value isn't a valid IANA zone.
export const TIMEZONE = (() => {
  const tz = env("TZ", "UTC") || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
})();

export const PORT = envNum("PORT", 8080);
export const POLL_INTERVAL_MS = envNum("POLL_INTERVAL_MS", 1000);
export const AIRCRAFT_JSON_URL = env(
  "AIRCRAFT_JSON_URL",
  "http://ultrafeeder/data/aircraft.json",
);
export const MAP_STYLE_DARK = env(
  "MAP_STYLE_URL_DARK",
  env("MAP_STYLE_URL", "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"),
);
export const MAP_STYLE_LIGHT = env(
  "MAP_STYLE_URL_LIGHT",
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
);

export const ADSBDB_BASE = env("ADSBDB_BASE", "https://api.adsbdb.com/v0");
export const HEXDB_BASE = env("HEXDB_BASE", "https://hexdb.io/api/v1");

export const ADMIN_EMAILS = env("ADMIN_EMAILS", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Cloudflare Access (admin JWT verification). Team domain like
// "qdrn.cloudflareaccess.com"; AUD is the admin Access application's audience tag.
export const CF_ACCESS_TEAM_DOMAIN = env("CF_ACCESS_TEAM_DOMAIN", "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
export const CF_ACCESS_AUD = env("CF_ACCESS_AUD", "");

// Settings that can be changed at runtime are persisted in the DB and override
// the env defaults. Keys are stored in the DB only (never the repo / env in prod).
const SETTING_KEYS = {
  receiverLat: "receiver.lat",
  receiverLon: "receiver.lon",
  receiverCity: "receiver.city",
  receiverCounty: "receiver.county",
  rangeRings: "receiver.rangeRingsNm",
  setupPin: "setup.pin",
  pilotName: "pilot.name",
  faKey: "keys.flightaware.aeroapi",
  fr24Token: "keys.flightradar24.token",
  fr24SharingKey: "keys.fr24.sharingKey",
  piawareFeederId: "keys.piaware.feederId",
  aeroEnabled: "aeroapi.enabled",
  aeroCap: "aeroapi.monthlyCap",
  aeroUsage: "aeroapi.usage",
} as const;

export function getReceiver(): ReceiverInfo {
  // Defaults: 3511 McKinley St NE, Minneapolis. Overridden by env / onboarding.
  const lat = Number(getSetting(SETTING_KEYS.receiverLat) ?? envNum("RECEIVER_LAT", 45.0317));
  const lon = Number(getSetting(SETTING_KEYS.receiverLon) ?? envNum("RECEIVER_LON", -93.2279));
  const city = getSetting(SETTING_KEYS.receiverCity) ?? env("RECEIVER_CITY", "Minneapolis, MN");
  const county = getSetting(SETTING_KEYS.receiverCounty) || undefined;
  const ringsRaw = getSetting(SETTING_KEYS.rangeRings) ?? env("RANGE_RINGS_NM", "50,100,150");
  const rangeRingsNm = ringsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return { lat, lon, city, county, artcc: lookupArtcc(lat, lon), rangeRingsNm };
}

export function setReceiver(lat: number, lon: number, city: string, county?: string): void {
  setSetting(SETTING_KEYS.receiverLat, String(lat));
  setSetting(SETTING_KEYS.receiverLon, String(lon));
  setSetting(SETTING_KEYS.receiverCity, city);
  setSetting(SETTING_KEYS.receiverCounty, county ?? "");
}

export function getPilotName(): string {
  return getSetting(SETTING_KEYS.pilotName) ?? env("PILOT_NAME", "");
}

export function setPilotName(name: string): void {
  setSetting(SETTING_KEYS.pilotName, name.slice(0, 40));
}

export function getSetupPin(): string {
  return getSetting(SETTING_KEYS.setupPin) ?? env("SETUP_PIN", "1234");
}

export function setSetupPin(pin: string): void {
  setSetting(SETTING_KEYS.setupPin, pin);
}

/** True once the owner has chosen their own PIN (vs the env/default). */
export function isPinSet(): boolean {
  return Boolean(getSetting(SETTING_KEYS.setupPin));
}

export interface ApiKeys {
  flightAwareAeroApi?: string;
  flightRadar24Token?: string;
  fr24SharingKey?: string;
  piawareFeederId?: string;
}

export function getApiKeys(): ApiKeys {
  return {
    flightAwareAeroApi: (getSetting(SETTING_KEYS.faKey) ?? env("FLIGHTAWARE_AEROAPI_KEY")) || undefined,
    flightRadar24Token: (getSetting(SETTING_KEYS.fr24Token) ?? env("FLIGHTRADAR24_API_TOKEN")) || undefined,
    fr24SharingKey: (getSetting(SETTING_KEYS.fr24SharingKey) ?? env("FR24_SHARING_KEY")) || undefined,
    piawareFeederId: (getSetting(SETTING_KEYS.piawareFeederId) ?? env("PIAWARE_FEEDER_ID")) || undefined,
  };
}

export function setApiKey(which: keyof ApiKeys, value: string): void {
  const map: Record<keyof ApiKeys, string> = {
    flightAwareAeroApi: SETTING_KEYS.faKey,
    flightRadar24Token: SETTING_KEYS.fr24Token,
    fr24SharingKey: SETTING_KEYS.fr24SharingKey,
    piawareFeederId: SETTING_KEYS.piawareFeederId,
  };
  setSetting(map[which], value);
}

// ─── AeroAPI spend guard ─────────────────────────────────────────────────────
// "Both": a master on/off switch and an automatic monthly call cap. Past the
// cap (or when disabled), we fall back to the free route sources.

const monthFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit" });
function currentMonth(): string {
  return monthFmt.format(new Date()).slice(0, 7); // YYYY-MM
}

export function getAeroApiConfig(): { enabled: boolean; cap: number } {
  const enabledRaw = getSetting(SETTING_KEYS.aeroEnabled);
  const enabled = enabledRaw == null ? env("AEROAPI_ENABLED", "true") !== "false" : enabledRaw === "true";
  const capRaw = getSetting(SETTING_KEYS.aeroCap);
  const cap = capRaw == null ? envNum("AEROAPI_MONTHLY_CAP", 500) : Math.max(0, Number(capRaw) || 0);
  return { enabled, cap };
}

export function setAeroApiConfig(patch: { enabled?: boolean; cap?: number }): void {
  if (typeof patch.enabled === "boolean") setSetting(SETTING_KEYS.aeroEnabled, String(patch.enabled));
  if (typeof patch.cap === "number" && Number.isFinite(patch.cap)) {
    setSetting(SETTING_KEYS.aeroCap, String(Math.max(0, Math.floor(patch.cap))));
  }
}

function readUsage(): { month: string; count: number } {
  const raw = getSetting(SETTING_KEYS.aeroUsage);
  const month = currentMonth();
  if (!raw) return { month, count: 0 };
  try {
    const u = JSON.parse(raw) as { month: string; count: number };
    return u.month === month ? u : { month, count: 0 };
  } catch {
    return { month, count: 0 };
  }
}

export function getAeroApiUsage(): { month: string; count: number } {
  return readUsage();
}

/** Count one billable AeroAPI call against the current month. */
export function recordAeroApiCall(): void {
  const u = readUsage();
  setSetting(SETTING_KEYS.aeroUsage, JSON.stringify({ month: u.month, count: u.count + 1 }));
}

/** Whether a paid AeroAPI lookup is currently permitted (key + switch + cap). */
export function paidLookupsAllowed(): boolean {
  if (!getApiKeys().flightAwareAeroApi) return false;
  const { enabled, cap } = getAeroApiConfig();
  if (!enabled) return false;
  if (cap > 0 && readUsage().count >= cap) return false;
  return true;
}

export function getBrand(): BrandConfig {
  // Official QDRN brand palette (dark blue #002D72, green #A3C940, white,
  // black, light gray #F0F0F0). Mirrored as CSS variables in the web theme.
  return {
    name: "QDRN Radar",
    tagline: "Live aircraft over the area",
    logoUrl: `${BASE_PATH}/brand/QDRN%20Radar.png`,
    captainUrl: `${BASE_PATH}/brand/CaptainQIcon-BGRVD.PNG`,
    colors: {
      bg: "#001533", // deep navy, derived from brand blue
      surface: "#002D72", // QDRN dark blue
      accent: "#A3C940", // QDRN green
      accent2: "#5b8def", // brighter blue for map/secondary accents
      text: "#F0F0F0", // QDRN light gray / near-white
      muted: "#9fb0c9",
    },
  };
}
