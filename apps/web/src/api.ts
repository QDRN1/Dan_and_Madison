import type { Aircraft, LiveSnapshot, PublicConfig, SetupState, Stats } from "@qdrn/shared";

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
  snapshot: () => get<LiveSnapshot>("/aircraft"),
  stats: () => get<Stats>("/stats"),
  setupState: () => get<SetupState>("/setup/state"),
  verifyPin: (pin: string) => post<{ ok: boolean }>("/setup/verify-pin", { pin }),
  saveLocation: (pin: string, city: string, lat: number, lon: number) =>
    post<{ ok: boolean; setup: SetupState }>("/setup/location", { pin, city, lat, lon }),
  saveKeys: (pin: string, keys: Record<string, string>) =>
    post<{ ok: boolean; setup: SetupState }>("/setup/keys", { pin, ...keys }),
};

/** Connect to the live websocket, auto-reconnecting with backoff. */
export function connectLive(onSnapshot: (s: LiveSnapshot) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${API}/live`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") onSnapshot(msg.data as LiveSnapshot);
      } catch {
        /* ignore */
      }
    };
    ws.onopen = () => {
      backoff = 1000;
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    ws?.close();
  };
}

/** Nominatim geocode for the setup wizard's city search (no key needed). */
export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
}
export async function geocodeCity(q: string): Promise<GeoResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return rows.map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}
