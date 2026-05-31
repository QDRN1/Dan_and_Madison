import type { Airport, Enrichment, Route } from "@qdrn/shared";
import {
  ADSBDB_BASE,
  HEXDB_BASE,
  VRS_ROUTES_BASE,
  getApiKeys,
  getGatewayConfig,
  isAdsblolEnabled,
  paidLookupsAllowed,
  recordAeroApiCall,
} from "./config.js";
import { db } from "./db.js";
import { pickLeg } from "./geo.js";

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

/** Where an aircraft is right now — used to pick which leg of a multi-stop
 *  callsign rotation it's actually flying. */
interface PlanePos {
  lat: number;
  lon: number;
  track?: number;
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
  opts?: { paid?: boolean; lat?: number; lon?: number; track?: number },
): Promise<Enrichment | undefined> {
  const paid = opts?.paid ?? false;
  const pos: PlanePos | undefined =
    opts?.lat != null && opts?.lon != null
      ? { lat: opts.lat, lon: opts.lon, track: opts.track }
      : undefined;
  const callsign = (flight ?? "").trim().toUpperCase();
  const k = key(hex, callsign);

  const cached = cacheGet.get(hex, callsign) as { data: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    const e = JSON.parse(cached.data) as Enrichment;
    const accurate = e.route?.source === "flightaware" || e.route?.source === "gateway";
    const wantUpgrade =
      paid &&
      callsign.length > 0 &&
      paidLookupsAllowed() &&
      !accurate &&
      Date.now() - (e.paidCheckedAt ?? 0) > PAID_RETRY_MS;
    if (!wantUpgrade) return { ...e, source: "cache" };
    return upgradeWithPaid(hex, callsign, e);
  }

  const ek = paid ? `${k}::paid` : k;
  const existing = inflight.get(ek);
  if (existing) return existing;

  const p = doEnrich(hex, callsign, paid, pos)
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
  const res = paidLookupsAllowed() ? await paidRoute(callsign) : undefined;
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

async function doEnrich(
  hex: string,
  callsign: string,
  paid: boolean,
  pos?: PlanePos,
): Promise<Enrichment | undefined> {
  const [aircraft, routeRes, photo] = await Promise.all([
    lookupAircraft(hex),
    callsign ? lookupRoute(callsign, paid, pos) : Promise.resolve(undefined),
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

async function lookupRoute(
  callsign: string,
  paid: boolean,
  pos?: PlanePos,
): Promise<RouteResult | undefined> {
  if (paid && paidLookupsAllowed()) {
    const r = await paidRoute(callsign);
    if (r?.route) return r;
  }
  // Free path. adsb.lol carries the full (often multi-stop) rotation, so we use
  // the aircraft's position to pick the leg it's actually flying — that beats a
  // single canonical leg for planes mid-rotation. adsbdb supplies the airline
  // name/IATA (adsb.lol's route file only has the airline ICAO). The adsb.lol
  // call is gated by `adsb.lol.enabled` (default true) so a user can disable
  // it from Settings without unsetting their AeroAPI key. hexdb is no longer
  // used for routes: its records are frozen ~2018 and have no leg awareness,
  // so it could only ever surface a stale, wrong-leg guess.
  const lolEnabled = isAdsblolEnabled();
  const [lol, adb] = await Promise.all([
    lolEnabled ? adsblolRoute(callsign, pos) : Promise.resolve(undefined),
    adsbdbRoute(callsign),
  ]);
  if (!lol) return adb;
  if (!adb) return lol;
  return {
    route: {
      ...lol.route!,
      origin: lol.route?.origin ?? adb.route?.origin,
      destination: lol.route?.destination ?? adb.route?.destination,
    },
    operator: adb.operator ?? lol.operator,
    operatorIcao: lol.operatorIcao ?? adb.operatorIcao,
    operatorIata: adb.operatorIata,
  };
}

/** The accurate (metered) route source: the shared gateway if configured,
 *  otherwise a direct FlightAware/AeroAPI call with the local key. */
async function paidRoute(callsign: string): Promise<RouteResult | undefined> {
  const gw = getGatewayConfig();
  if (gw.url && gw.key) return gatewayRoute(callsign, gw);
  const fa = getApiKeys().flightAwareAeroApi;
  if (fa) return flightAwareRoute(callsign, fa);
  return undefined;
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

// ─── adsb.lol routes (VRS standing-data, free, ODbL) ──────────────────────────
// Static per-callsign JSON with the full rotation in `_airports` (each carries
// icao/iata/name/location/country + lat/lon). We pick the leg by position.

function adsblolAirport(a: any): Airport | undefined {
  if (!a) return undefined;
  return {
    icao: a.icao || undefined,
    iata: a.iata || undefined,
    name: a.name || undefined,
    city: a.location || undefined,
    country: a.countryiso2 || undefined,
    lat: typeof a.lat === "number" ? a.lat : undefined,
    lon: typeof a.lon === "number" ? a.lon : undefined,
  };
}

async function adsblolRoute(callsign: string, pos?: PlanePos): Promise<RouteResult | undefined> {
  const cs = callsign.toUpperCase();
  const j = await fetchJson(
    `${VRS_ROUTES_BASE}/${encodeURIComponent(cs.slice(0, 2))}/${encodeURIComponent(cs)}.json`,
  );
  const airports: any[] = Array.isArray(j?._airports) ? j._airports : [];
  if (airports.length === 0) return undefined;
  // NOTE: the leg is resolved from the position at first lookup and then cached
  // for the (hex, callsign) pair. That's correct for a normal airborne leg; a
  // callsign reused for a later leg within the cache window keeps the old one
  // until re-enriched. AeroAPI (when enabled) supersedes this for opened flights.
  const { origin, destination } = pos
    ? pickLeg(pos, airports)
    : { origin: airports[0], destination: airports[airports.length - 1] };
  return {
    route: {
      callsign: cs,
      origin: adsblolAirport(origin),
      destination: adsblolAirport(destination),
      source: "adsblol",
    },
    operatorIcao: j?.airline_code || undefined,
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
    recordAeroApiCall(); // a 2xx is a billable query — count it toward the cap
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

// ─── Shared API gateway (ops.qdrn.io — normalized, provider-agnostic) ──────────
// The gateway holds the real upstream credentials, picks a provider, meters/caps
// usage, and returns ONE normalized shape so the radar doesn't care whether it's
// backed by FR24, AeroAPI, etc. Contract (GET, device key as bearer):
//   GET {gatewayUrl}/v1/route/{CALLSIGN}   Authorization: Bearer {deviceKey}
//   200 {
//     origin:      { iata, icao, name, city } | null,
//     destination: { iata, icao, name, city } | null,
//     airline:     { iata, icao, name } | null,
//     times: { scheduledOut, estimatedOut, actualOut, scheduledIn, estimatedIn,
//              actualIn, actualOff, progressPercent } | null
//   }
//   404 -> no route (fall back to free sources)   429 -> over quota   401/403 -> bad key
async function gatewayRoute(callsign: string, gw: { url: string; key: string }): Promise<RouteResult | undefined> {
  let j: any;
  try {
    const res = await fetch(`${gw.url}/v1/route/${encodeURIComponent(callsign)}`, {
      headers: { Authorization: `Bearer ${gw.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[gateway] ${callsign} -> ${res.status} ${res.statusText}`);
      return undefined;
    }
    j = await res.json();
  } catch (e) {
    console.warn(`[gateway] ${callsign} request failed:`, (e as Error)?.message ?? e);
    return undefined;
  }
  const airport = (a: any): Airport | undefined =>
    a ? { icao: a.icao || undefined, iata: a.iata || undefined, name: a.name || undefined, city: a.city || undefined } : undefined;
  const t = j?.times ?? {};
  const route: Route = {
    callsign,
    origin: airport(j?.origin),
    destination: airport(j?.destination),
    source: "gateway",
    scheduledOut: t.scheduledOut || undefined,
    estimatedOut: t.estimatedOut || undefined,
    actualOut: t.actualOut || undefined,
    scheduledIn: t.scheduledIn || undefined,
    estimatedIn: t.estimatedIn || undefined,
    actualIn: t.actualIn || undefined,
    actualOff: t.actualOff || undefined,
    progressPercent: typeof t.progressPercent === "number" ? t.progressPercent : undefined,
  };
  if (!route.origin && !route.destination && !j?.airline) return undefined;
  return {
    route,
    operator: j?.airline?.name || undefined,
    operatorIcao: j?.airline?.icao || undefined,
    operatorIata: j?.airline?.iata || undefined,
  };
}
