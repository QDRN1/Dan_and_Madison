import type { BrandConfig, ReceiverInfo } from "@qdrn/shared";
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

// Settings that can be changed at runtime are persisted in the DB and override
// the env defaults. Keys are stored in the DB only (never the repo / env in prod).
const SETTING_KEYS = {
  receiverLat: "receiver.lat",
  receiverLon: "receiver.lon",
  receiverCity: "receiver.city",
  rangeRings: "receiver.rangeRingsNm",
  setupPin: "setup.pin",
  faKey: "keys.flightaware.aeroapi",
  fr24Token: "keys.flightradar24.token",
  fr24SharingKey: "keys.fr24.sharingKey",
  piawareFeederId: "keys.piaware.feederId",
} as const;

export function getReceiver(): ReceiverInfo {
  // Defaults: north Minneapolis (city-level). Overridden during onboarding.
  const lat = Number(getSetting(SETTING_KEYS.receiverLat) ?? envNum("RECEIVER_LAT", 45.03));
  const lon = Number(getSetting(SETTING_KEYS.receiverLon) ?? envNum("RECEIVER_LON", -93.3));
  const city = getSetting(SETTING_KEYS.receiverCity) ?? env("RECEIVER_CITY", "Minneapolis, MN");
  const ringsRaw = getSetting(SETTING_KEYS.rangeRings) ?? env("RANGE_RINGS_NM", "50,100,150");
  const rangeRingsNm = ringsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return { lat, lon, city, rangeRingsNm };
}

export function setReceiver(lat: number, lon: number, city: string): void {
  setSetting(SETTING_KEYS.receiverLat, String(lat));
  setSetting(SETTING_KEYS.receiverLon, String(lon));
  setSetting(SETTING_KEYS.receiverCity, city);
}

export function getSetupPin(): string {
  return getSetting(SETTING_KEYS.setupPin) ?? env("SETUP_PIN", "1234");
}

export function setSetupPin(pin: string): void {
  setSetting(SETTING_KEYS.setupPin, pin);
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

export function getBrand(): BrandConfig {
  // Official QDRN brand palette (dark blue #002D72, green #A3C940, white,
  // black, light gray #F0F0F0). Mirrored as CSS variables in the web theme.
  return {
    name: "QDRN Radar",
    tagline: "Live aircraft over the area",
    logoUrl: `${BASE_PATH}/brand/QDRN%20Radar%20Long.png`,
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
