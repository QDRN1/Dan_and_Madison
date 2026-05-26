import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConnStatus, Connections, GatewayInfo } from "@qdrn/shared";
import { getApiKeys, getGatewayConfig } from "./config.js";

const exec = promisify(execFile);

// Real checks are a little expensive (network + docker), so cache them.
const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; data: Connections } | undefined;

async function dockerHealth(name: string): Promise<ConnStatus> {
  try {
    const { stdout } = await exec(
      "docker",
      ["inspect", "-f", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", name],
      { timeout: 10_000 },
    );
    const [state, health] = stdout.trim().split("|");
    if (state !== "running") return "down";
    if (health && health !== "none" && health !== "healthy" && health !== "starting") return "down";
    return "ok";
  } catch {
    return "unknown"; // docker socket not available (e.g. dev) — can't tell
  }
}

async function checkAeroApi(key: string): Promise<ConnStatus> {
  try {
    const res = await fetch("https://aeroapi.flightaware.com/aeroapi/flights/AAL1", {
      headers: { "x-apikey": key, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "error";
  } catch {
    return "error";
  }
}

async function checkFr24Token(token: string): Promise<ConnStatus> {
  // Best-effort against the FR24 API; inconclusive responses → "unknown".
  try {
    const res = await fetch("https://fr24api.flightradar24.com/api/static/airlines/light", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Version": "v1" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Ask the gateway for this device's quota status WITHOUT spending a route
 *  credit. Distinguishes ok / over-limit (blocked) / bad key / unreachable. */
async function checkGateway(): Promise<{ status: ConnStatus; info?: GatewayInfo }> {
  const gw = getGatewayConfig();
  if (!gw.url || !gw.key) return { status: "unset" };
  try {
    const res = await fetch(`${gw.url}/v1/status`, {
      headers: { Authorization: `Bearer ${gw.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) return { status: "invalid" };
    if (res.status === 429) return { status: "blocked" };
    if (res.status === 404) return { status: "ok" }; // reachable, no status endpoint yet
    if (!res.ok) return { status: "error" };
    const j: any = await res.json().catch(() => ({}));
    const key = j?.key ?? j ?? {};
    const used = num(key.used);
    const limit = num(key.limit);
    const remaining = num(key.remaining) ?? (limit != null && used != null ? limit - used : undefined);
    const blocked = Boolean(key.blocked) || (limit != null && used != null && used >= limit);
    const info: GatewayInfo = { name: key.name, used, limit, remaining, resets: key.resets ?? null };
    return { status: blocked ? "blocked" : "ok", info };
  } catch {
    return { status: "down" };
  }
}

/** Real connection status per service (validity for tokens, feeding for feeders). */
export async function getConnections(force = false): Promise<Connections> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const k = getApiKeys();
  const unset = (v?: string): boolean => !v || !v.trim();
  const [flightAwareAeroApi, flightRadar24Token, fr24SharingKey, piawareFeederId, gw] = await Promise.all([
    unset(k.flightAwareAeroApi) ? Promise.resolve<ConnStatus>("unset") : checkAeroApi(k.flightAwareAeroApi!),
    unset(k.flightRadar24Token) ? Promise.resolve<ConnStatus>("unset") : checkFr24Token(k.flightRadar24Token!),
    unset(k.fr24SharingKey) ? Promise.resolve<ConnStatus>("unset") : dockerHealth("fr24feed"),
    unset(k.piawareFeederId) ? Promise.resolve<ConnStatus>("unset") : dockerHealth("piaware"),
    checkGateway(),
  ]);
  const data: Connections = {
    flightAwareAeroApi,
    flightRadar24Token,
    fr24SharingKey,
    piawareFeederId,
    gateway: gw.status,
    gatewayInfo: gw.info,
  };
  cache = { at: Date.now(), data };
  return data;
}
