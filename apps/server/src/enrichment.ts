import type { Airport, Enrichment, Route } from "@qdrn/shared";
import { ADSBDB_BASE, HEXDB_BASE, getApiKeys } from "./config.js";
import { db } from "./db.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — registrations/types rarely change
const FETCH_TIMEOUT_MS = 6000;
// Don't re-hit the metered AeroAPI for the same flight more often than this,
// even if the user keeps re-opening it and we found no flight plan.
const PAID_RETRY_MS = 10 * 60 * 1000;

/** Route plus the operating airline, which free/paid sources return together. */
interface RouteResult {
  route?: Route;
  operator?: string;
  operatorIcao?: string;
  operatorIata?: string;
}

const cacheGet = db.prepare<[string, string]>(
  "SELECT data, fetched_at FROM enrichment_cache WHERE hex = ? AND callsign = ?",
);
const cacheSet = db.prepare<[string, string, string, number]>(
  `INSERT INTO enrichment_cache (hex, callsign, data, fetched_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(hex, callsign) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
);

// In-flight de-duplication so we never hit a source twice for the same key.
const inflight = new Map<string, Promise<Enrichment | undefined>>();

/** Wipe cached enrichment so the next lookups re-fetch (e.g. after an API key
 *  change, so newly-available sources like AeroAPI take effect immediately). */
export function clearEnrichmentCache(): void {
  try {
    db.prepare("DELETE FROM enrichment_cache").run();
  } catch {
    /* ignore */
  }
  inflight.clear();
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | undefined> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

function key(hex: string, callsign: string): string {
  return `${hex}::${callsign}`;
}

/**
 * Look up enrichment for an aircraft. Returns cached data immediately if fresh;
 * otherwise fetches from the free sources (adsbdb → hexdb). The metered
 * FlightAware/AeroAPI lookup is only performed when `paid` is set — i.e. lazily,
 * when the user actually opens a flight — so the background poll never spends
 * AeroAPI queries. Never throws.
 */
export async function enrich(
  hex: string,
  flight?: string,
  opts?: { paid?: boolean },
): Promise<Enrichment | undefined> {
  const paid = opts?.paid ?? false;
  const callsign = (flight ?? "").trim().toUpperCase();
  const k = key(hex, callsign);

  const cached = cacheGet.get(hex, callsign) as { data: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    const e = JSON.parse(cached.data) as Enrichment;
    const wantUpgrade =
      paid &&
      callsign.length > 0 &&
      Boolean(getApiKeys().flightAwareAeroApi) &&
      e.route?.source !== "flightaware" &&
      Date.now() - (e.paidCheckedAt ?? 0) > PAID_RETRY_MS;
    if (!wantUpgrade) return { ...e, source: "cache" };
    return upgradeWithPaid(hex, callsign, e);
  }

  const ek = paid ? `${k}::paid` : k;
  const existing = inflight.get(ek);
  if (existing) return existing;

  const p = doEnrich(hex, callsign, paid)
    .then((e) => {
      if (e) cacheSet.run(hex, callsign, JSON.stringify(e), Date.now());
      return e;
    })
    .finally(() => inflight.delete(ek));
  inflight.set(ek, p);
  return p;
}

/** Add (or replace) the route with an AeroAPI flight plan on an already-cached
 *  enrichment, recording the attempt so we don't keep re-querying. */
async function upgradeWithPaid(hex: string, callsign: string, e: Enrichment): Promise<Enrichment> {
  const fa = getApiKeys().flightAwareAeroApi;
  const res = fa ? await flightAwareRoute(callsign, fa) : undefined;
  const merged: Enrichment = {
    ...e,
    route: res?.route ?? e.route,
    operatorIata: res?.operatorIata ?? e.operatorIata,
    operatorIcao: e.operatorIcao ?? res?.operatorIcao,
    operator: e.operator ?? res?.operator,
    paidCheckedAt: Date.now(),
  };
  cacheSet.run(hex, callsign, JSON.stringify(merged), Date.now());
  return { ...merged, source: "cache" };
}

async function doEnrich(hex: string, callsign: string, paid: boolean): Promise<Enrichment | undefined> {
  const [aircraft, routeRes, photo] = await Promise.all([
    lookupAircraft(hex),
    callsign ? lookupRoute(callsign, paid) : Promise.resolve(undefined),
    lookupPhoto(hex),
  ]);
  if (!aircraft && !routeRes?.route && !routeRes?.operatorIata && !photo) return undefined;
  return {
    ...aircraft,
    route: routeRes?.route,
    operator: aircraft?.operator ?? routeRes?.operator,
    operatorIcao: aircraft?.operatorIcao ?? routeRes?.operatorIcao,
    operatorIata: routeRes?.operatorIata,
    photo,
    fetchedAt: Date.now(),
    paidCheckedAt: paid ? Date.now() : undefined,
  };
}

// ─── Photo (Planespotters, free, attribution required) ───────────────────────

async function lookupPhoto(hex: string): Promise<Enrichment["photo"] | undefined> {
  const j = await fetchJson(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`);
  const p = j?.photos?.[0];
  const url = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
  if (!url) return undefined;
  return { url, link: p.link || undefined, photographer: p.photographer || undefined };
}

// ─── Aircraft (hex → reg/type/operator) ──────────────────────────────────────

async function lookupAircraft(hex: string): Promise<Partial<Enrichment> | undefined> {
  return (await adsbdbAircraft(hex)) ?? (await hexdbAircraft(hex));
}

async function adsbdbAircraft(hex: string): Promise<Partial<Enrichment> | undefined> {
  const j = await fetchJson(`${ADSBDB_BASE}/aircraft/${encodeURIComponent(hex)}`);
  const a = j?.response?.aircraft;
  if (!a) return undefined;
  return {
    registration: a.registration || undefined,
    typeCode: a.icao_type || undefined,
    typeName: a.type || undefined,
    manufacturer: a.manufacturer || undefined,
    operator: a.registered_owner || undefined,
    operatorIcao: a.registered_owner_operator_flag_code || undefined,
    owner: a.registered_owner || undefined,
    source: "adsbdb",
  };
}

async function hexdbAircraft(hex: string): Promise<Partial<Enrichment> | undefined> {
  const j = await fetchJson(`${HEXDB_BASE}/aircraft/${encodeURIComponent(hex)}`);
  if (!j || !j.Registration) return undefined;
  return {
    registration: j.Registration || undefined,
    typeCode: j.ICAOTypeCode || undefined,
    typeName: j.Type || undefined,
    manufacturer: j.Manufacturer || undefined,
    operator: j.RegisteredOwners || undefined,
    operatorIcao: j.OperatorFlagCode || undefined,
    owner: j.RegisteredOwners || undefined,
    source: "hexdb",
  };
}

// ─── Route (callsign → origin/destination) ───────────────────────────────────

async function lookupRoute(callsign: string, paid: boolean): Promise<RouteResult | undefined> {
  if (paid) {
    const fa = getApiKeys().flightAwareAeroApi;
    if (fa) {
      const r = await flightAwareRoute(callsign, fa);
      if (r?.route) return r;
    }
  }
  return (await adsbdbRoute(callsign)) ?? (await hexdbRoute(callsign));
}

function adsbdbAirport(a: any): Airport | undefined {
  if (!a) return undefined;
  return {
    icao: a.icao_code || undefined,
    iata: a.iata_code || undefined,
    name: a.name || undefined,
    city: a.municipality || undefined,
    country: a.country_name || undefined,
    lat: typeof a.latitude === "number" ? a.latitude : undefined,
    lon: typeof a.longitude === "number" ? a.longitude : undefined,
  };
}

async function adsbdbRoute(callsign: string): Promise<RouteResult | undefined> {
  const j = await fetchJson(`${ADSBDB_BASE}/callsign/${encodeURIComponent(callsign)}`);
  const fr = j?.response?.flightroute;
  if (!fr) return undefined;
  return {
    route: {
      callsign,
      origin: adsbdbAirport(fr.origin),
      destination: adsbdbAirport(fr.destination),
      source: "adsbdb",
    },
    operator: fr.airline?.name || undefined,
    operatorIcao: fr.airline?.icao || undefined,
    operatorIata: fr.airline?.iata || undefined,
  };
}

async function hexdbRoute(callsign: string): Promise<RouteResult | undefined> {
  const j = await fetchJson(`${HEXDB_BASE}/route/icao/${encodeURIComponent(callsign)}`);
  const routeStr: string | undefined = j?.route;
  if (!routeStr || !routeStr.includes("-")) return undefined;
  const [from, to] = routeStr.split("-");
  const [origin, destination] = await Promise.all([
    from ? hexdbAirport(from) : Promise.resolve(undefined),
    to ? hexdbAirport(to) : Promise.resolve(undefined),
  ]);
  return { route: { callsign, origin, destination, source: "hexdb" } };
}

async function hexdbAirport(icao: string): Promise<Airport | undefined> {
  const j = await fetchJson(`${HEXDB_BASE}/airport/icao/${encodeURIComponent(icao)}`);
  if (!j) return { icao };
  return {
    icao: j.icao || icao,
    iata: j.iata || undefined,
    name: j.airport || undefined,
    city: j.region_name || undefined,
    country: j.country_code || undefined,
    lat: typeof j.latitude === "number" ? j.latitude : undefined,
    lon: typeof j.longitude === "number" ? j.longitude : undefined,
  };
}

// ─── FlightAware AeroAPI (paid, optional upgrade) ─────────────────────────────

async function flightAwareRoute(callsign: string, apiKey: string): Promise<RouteResult | undefined> {
  let j: any;
  try {
    const res = await fetch(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(callsign)}`, {
      headers: { "x-apikey": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Surface the failure (esp. 401/403 = bad key) instead of silently
      // falling back to the free sources, which looks identical to "still wrong".
      console.warn(`[aeroapi] ${callsign} -> ${res.status} ${res.statusText}; falling back to free route data`);
      return undefined;
    }
    j = await res.json();
  } catch (e) {
    console.warn(`[aeroapi] ${callsign} request failed:`, (e as Error)?.message ?? e);
    return undefined;
  }
  const flights: any[] = Array.isArray(j?.flights) ? j.flights : [];
  // Prefer the flight that's actually airborne now (departed, not yet landed)
  // so we don't show a stale/scheduled leg for a reused flight number.
  const f = flights.find((x) => x?.actual_off && !x?.actual_on) ?? flights[0];
  if (!f) return undefined;
  return {
    route: {
      callsign,
      origin: f.origin
        ? { icao: f.origin.code_icao, iata: f.origin.code_iata, name: f.origin.name, city: f.origin.city }
        : undefined,
      destination: f.destination
        ? { icao: f.destination.code_icao, iata: f.destination.code_iata, name: f.destination.name, city: f.destination.city }
        : undefined,
      source: "flightaware",
      scheduledOut: f.scheduled_out || undefined,
      estimatedOut: f.estimated_out || undefined,
      actualOut: f.actual_out || undefined,
      scheduledIn: f.scheduled_in || undefined,
      estimatedIn: f.estimated_in || undefined,
      actualIn: f.actual_in || undefined,
      actualOff: f.actual_off || undefined,
      progressPercent: typeof f.progress_percent === "number" ? f.progress_percent : undefined,
    },
    operator: f.operator || undefined,
    operatorIcao: f.operator_icao || undefined,
    operatorIata: f.operator_iata || undefined,
  };
}
