import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConnStatus, Connections } from "@qdrn/shared";
import { getApiKeys } from "./config.js";

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

/** Real connection status per service (validity for tokens, feeding for feeders). */
export async function getConnections(force = false): Promise<Connections> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const k = getApiKeys();
  const unset = (v?: string): boolean => !v || !v.trim();
  const [flightAwareAeroApi, flightRadar24Token, fr24SharingKey, piawareFeederId] = await Promise.all([
    unset(k.flightAwareAeroApi) ? Promise.resolve<ConnStatus>("unset") : checkAeroApi(k.flightAwareAeroApi!),
    unset(k.flightRadar24Token) ? Promise.resolve<ConnStatus>("unset") : checkFr24Token(k.flightRadar24Token!),
    unset(k.fr24SharingKey) ? Promise.resolve<ConnStatus>("unset") : dockerHealth("fr24feed"),
    unset(k.piawareFeederId) ? Promise.resolve<ConnStatus>("unset") : dockerHealth("piaware"),
  ]);
  const data: Connections = { flightAwareAeroApi, flightRadar24Token, fr24SharingKey, piawareFeederId };
  cache = { at: Date.now(), data };
  return data;
}
