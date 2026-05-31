import type { AchievementProgress, AdminSettings, Aircraft, Connections, CoveragePoint, FlaggedSighting, LiveSnapshot, PublicConfig, SetupState, SightingFilter, SightingPage, SightingRow, Stats, WifiNetwork, WifiScanResult } from "@qdrn/shared";

// Vite injects the configured base path (e.g. "/md/"); strip the trailing slash.
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");
const API = `${BASE}/api`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  config: () => get<PublicConfig>("/config"),
  aircraft: (hex: string) => get<Aircraft>(`/aircraft/${hex}`),
  /** Extended track + free-derived flight times (actualOff/ETA/progress)
   *  when AeroAPI isn't in play. The route field is the upgraded route. */
  aircraftTrack: (hex: string) =>
    get<{
      hex: string;
      trail: import("@qdrn/shared").TrailPoint[];
      sources: string[];
      route?: import("@qdrn/shared").Route;
    }>(`/aircraft/${hex}/track`),
  snapshot: () => get<LiveSnapshot>("/aircraft"),
  stats: () => get<Stats>("/stats"),
  coverage: () => get<CoveragePoint[]>("/coverage"),
  statsToday:    (offset = 0, limit = 100) => get<{ rows: SightingRow[]; total: number }>(`/stats/today?offset=${offset}&limit=${limit}`),
  statsAllTime:  (offset = 0, limit = 100) => get<{ rows: SightingRow[]; total: number }>(`/stats/all-time?offset=${offset}&limit=${limit}`),
  statsFarthest: (scope: "today" | "all" = "today", limit = 50) => get<{ rows: SightingRow[]; total: number }>(`/stats/farthest?scope=${scope}&limit=${limit}`),
  statsNotable:  (limit = 100) => get<{ rows: FlaggedSighting[] }>(`/stats/notable?limit=${limit}`),
  /** Filtered sightings — backs the full-screen popout tables. */
  sightings: (f: SightingFilter) => {
    const p = new URLSearchParams();
    if (f.scope)   p.set("scope",   f.scope);
    if (f.sort)    p.set("sort",    f.sort);
    if (f.q)       p.set("q",       f.q);
    if (f.airline) p.set("airline", f.airline);
    if (f.offset != null) p.set("offset", String(f.offset));
    if (f.limit  != null) p.set("limit",  String(f.limit));
    return get<SightingPage>(`/stats/sightings?${p.toString()}`);
  },
  achievements:  () => get<{ achievements: AchievementProgress[] }>("/achievements"),
  anniversary:   () => get<
    | { configured: false }
    | { configured: true; name: string; firstAt: number; days: number; years: number; isAnniversary: boolean }
  >("/anniversary"),
  setupState: () => get<SetupState>("/setup/state"),
  pinStatus: () => get<{ pinSet: boolean }>("/setup/pin-status"),
  setPin: (pin: string, currentPin?: string) =>
    post<{ ok: boolean }>("/setup/set-pin", { pin, currentPin }),
  verifyPin: (pin: string) => post<{ ok: boolean; master: boolean }>("/setup/verify-pin", { pin }),
  /** Master-PIN-gated: forces the user PIN back to the default. */
  resetUserPin: (masterPin: string) =>
    post<{ ok: boolean; pin: string }>("/setup/reset-user-pin", { pin: masterPin }),
  saveLocation: (pin: string, city: string, lat: number, lon: number, county?: string) =>
    post<{ ok: boolean; setup: SetupState }>("/setup/location", { pin, city, lat, lon, county }),
  saveKeys: (pin: string, keys: Record<string, string>) =>
    post<{ ok: boolean; setup: SetupState }>("/setup/keys", { pin, ...keys }),
  settings: (pin: string) => post<AdminSettings>("/setup/settings", { pin }),
  saveAero: (pin: string, patch: { enabled?: boolean; cap?: number }) =>
    post<{ ok: boolean; aero: AdminSettings["aero"] }>("/setup/aeroapi", { pin, ...patch }),
  saveName: (pin: string, name: string) => post<{ ok: boolean; pilotName: string }>("/setup/name", { pin, name }),
  connections: (pin: string, force?: boolean) => post<Connections>("/setup/connections", { pin, force }),
  saveGateway: (pin: string, url: string, key: string) =>
    post<{ ok: boolean; gateway: { url: string; key: string } }>("/setup/gateway", { pin, url, key }),
  saveAdsblol: (pin: string, enabled: boolean) =>
    post<{ ok: boolean; enabled: boolean }>("/setup/adsblol", { pin, enabled }),
  saveOffRadar: (pin: string, enabled: boolean) =>
    post<{ ok: boolean; enabled: boolean }>("/setup/off-radar", { pin, enabled }),
  /** Owner-only admin endpoints (master PIN required server-side). */
  deviceInfo: (pin: string) => post<{
    uptimeHuman: string; load1: number; load5: number; load15: number;
    diskUsedPct: number; diskFreeHuman: string; cpuTempF: number | null;
    sightingsCount: number; achievementsEarned: number; achievementsTotal: number;
    buildSha?: string;
  }>("/admin/device-info", { pin }),
  adminResetStats: (pin: string) => post<{ ok: boolean; error?: string }>("/admin/reset-stats", { pin }),
  adminRestart:    (pin: string) => post<{ ok: boolean; error?: string }>("/admin/restart", { pin }),
  adminUpdate:     (pin: string) => post<{ ok: boolean; error?: string }>("/admin/update", { pin }),
  wifiList: (pin: string) =>
    post<{ ok: boolean; networks?: WifiNetwork[]; error?: string }>("/setup/wifi", { pin }),
  wifiAdd: (pin: string, ssid: string, password: string, priority: number) =>
    post<{ ok: boolean; error?: string }>("/setup/wifi/add", { pin, ssid, password, priority }),
  wifiRemove: (pin: string, target: { name?: string; uuid?: string }) =>
    post<{ ok: boolean; error?: string }>("/setup/wifi/remove", { pin, ...target }),
  wifiConnect: (pin: string, target: { name?: string; uuid?: string }) =>
    post<{ ok: boolean; error?: string }>("/setup/wifi/connect", { pin, ...target }),
  wifiScan: (pin: string) =>
    post<{ ok: boolean; networks?: WifiScanResult[]; error?: string }>("/setup/wifi/scan", { pin }),
};

/** Connect to the live websocket, auto-reconnecting with backoff. */
export function connectLive(onSnapshot: (s: LiveSnapshot) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  let lastMsg = Date.now();
  // Generation guard: a stale socket's late events can't reconnect or deliver
  // data once we've moved on to a newer connection.
  let gen = 0;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${API}/live`;
  // The server pushes a snapshot every ~1s; if we hear nothing for this long the
  // connection is almost certainly dead (some proxies drop it without a close
  // frame, so onclose never fires) — force a fresh one.
  const STALE_MS = 12_000;

  const open = () => {
    if (closed) return;
    const myGen = ++gen;
    lastMsg = Date.now();
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      if (myGen !== gen) return;
      lastMsg = Date.now();
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") onSnapshot(msg.data as LiveSnapshot);
      } catch {
        /* ignore */
      }
    };
    ws.onopen = () => {
      if (myGen === gen) backoff = 1000;
    };
    ws.onclose = () => {
      if (closed || myGen !== gen) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  };
  open();

  const watchdog = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastMsg > STALE_MS) {
      // open() bumps gen, neutralizing the old socket's handlers, so this can't
      // double-connect even if the dead socket's onclose fires later.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      open();
    }
  }, 4000);

  return () => {
    closed = true;
    gen++;
    clearInterval(watchdog);
    ws?.close();
  };
}

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

/** Nominatim geocode for the location search (no key needed). */
export interface GeoResult {
  /** Full display name from Nominatim. */
  name: string;
  /** "City, ST" friendly label. */
  label: string;
  county?: string;
  /** Resolved city/town for the address (used for city-center centering). */
  city?: string;
  /** Full state name from Nominatim (used to look up city center). */
  state?: string;
  /** Coords of the matched result (may be a street address — see cityCenter). */
  lat: number;
  lon: number;
}
export async function geocodeCity(q: string): Promise<GeoResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    address?: Record<string, string>;
  }>;
  return rows.map((r) => {
    const a = r.address ?? {};
    const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || r.display_name.split(",")[0]!;
    const st = a.state ? STATE_ABBR[a.state] ?? a.state : "";
    return {
      name: r.display_name,
      label: st ? `${city}, ${st}` : city,
      county: a.county,
      city,
      state: a.state,
      lat: Number(r.lat),
      lon: Number(r.lon),
    };
  });
}

/** Resolve the geometric center of a city — used so a full address still centers
 *  the map on the nearest town rather than the user's doorstep. Falls back to
 *  the original coords if the city lookup fails. */
export async function cityCenter(city: string, state?: string): Promise<{ lat: number; lon: number } | null> {
  const q = state ? `${city}, ${state}` : city;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&featuretype=city&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!rows.length) return null;
    return { lat: Number(rows[0]!.lat), lon: Number(rows[0]!.lon) };
  } catch {
    return null;
  }
}
