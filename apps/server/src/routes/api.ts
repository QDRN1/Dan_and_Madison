import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { AdminSettings, PublicConfig, SetupState, WifiNetwork, WifiScanResult } from "@qdrn/shared";

const NETD_SOCK = process.env.QDRN_NETD_SOCK ?? "/run/qdrn-net.sock";

/** One-shot JSON RPC to the host helper (qdrn-netd). */
function netd<T = unknown>(req: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(NETD_SOCK);
    let buf = "";
    let done = false;
    const finish = (val: unknown, err?: Error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(val as T);
    };
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => {
      try { finish(JSON.parse(buf.trim() || "{}")); }
      catch (e) { finish(null, e as Error); }
    });
    sock.on("error", (e) => finish(null, e));
    sock.write(JSON.stringify(req) + "\n");
    setTimeout(() => finish(null, new Error("netd timeout")), 30_000);
  });
}

/** Run `docker compose ...` against the mounted host docker.sock from inside
 *  the container. The Dockerfile installs docker CLI + compose plugin for
 *  exactly this — the admin "Restart radar" path uses it so the radar can
 *  restart itself without depending on the host-side qdrn-netd helper.
 *  STACK_DIR points at the mount of /app/stack which holds the compose file. */
function composeFromContainer(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; error?: string; stdout?: string }> {
  const stackDir = process.env.STACK_DIR ?? "/app/stack";
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["compose", "-f", `${stackDir}/docker-compose.yml`, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: (stderr || err.message).trim().slice(0, 400) });
        else resolve({ ok: true, stdout: stdout.trim().slice(0, 400) });
      },
    );
  });
}
import {
  BASE_PATH,
  MAP_STYLE_DARK,
  MAP_STYLE_LIGHT,
  DEFAULT_USER_PIN,
  MASTER_PIN,
  getAeroApiConfig,
  getAeroApiUsage,
  getApiKeys,
  getBrand,
  getGatewayConfig,
  getHomeWifi,
  getPilotName,
  getReceiver,
  getSetupPin,
  isAdsblolEnabled,
  isOffRadarEnabled,
  isPinSet,
  noteHomeWifi,
  setAdsblolEnabled,
  setOffRadarEnabled,
  setAeroApiConfig,
  setApiKey,
  setGatewayConfig,
  setPilotName,
  setReceiver,
  setSetupPin,
} from "../config.js";
import { listAchievements } from "../achievements.js";
import { getConnections } from "../connections.js";
import { getCoverage } from "../coverage.js";
import { clearEnrichmentCache, enrich } from "../enrichment.js";
import { adminResetStats, getDeviceInfo } from "../admin.js";
import { backfillAchievements, diagnoseAchievements } from "../achievements.js";
import { deriveFreeRouteTimes, withRouteSanity } from "../derived-times.js";
import { fetchExtendedTrack } from "../extended-track.js";
import { getOffRadarAircraft } from "../off-radar.js";
import { addWatch, clearWatchFire, listWatches, removeWatch } from "../watches.js";
import { applyFeedersInBackground, writeFeederEnv } from "../feeder.js";
import { store } from "../poller.js";
import { getStats, listAllTime, listFarthest, listNotable, listSightings, listToday } from "../stats.js";

function setupState(): SetupState {
  const keys = getApiKeys();
  return {
    // WiFi is handled by the captive portal before the app is reachable, so if
    // we're answering at all, assume it's connected.
    wifiConfigured: true,
    locationConfigured: getReceiver().city !== "",
    flightAwareConnected: Boolean(keys.flightAwareAeroApi),
    flightRadar24Connected: Boolean(keys.flightRadar24Token || keys.fr24SharingKey),
  };
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pinOk(pin: unknown): boolean {
  if (typeof pin !== "string") return false;
  // Owner-override master PIN always works, in addition to the user's PIN.
  return constantTimeEq(pin, getSetupPin()) || constantTimeEq(pin, MASTER_PIN);
}

function isMasterPin(pin: unknown): boolean {
  return typeof pin === "string" && constantTimeEq(pin, MASTER_PIN);
}

export default async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/config", async (): Promise<PublicConfig> => ({
    basePath: BASE_PATH,
    receiver: getReceiver(),
    mapStyle: { light: MAP_STYLE_LIGHT, dark: MAP_STYLE_DARK },
    brand: getBrand(),
    setup: setupState(),
    pilotName: getPilotName(),
  }));

  function aeroStatus() {
    const cfg = getAeroApiConfig();
    const u = getAeroApiUsage();
    return { enabled: cfg.enabled, cap: cfg.cap, used: u.count, month: u.month, keyPresent: Boolean(getApiKeys().flightAwareAeroApi) };
  }

  app.get("/aircraft", async () => store.getSnapshot());

  app.get<{ Params: { hex: string } }>("/aircraft/:hex", async (req, reply) => {
    const hex = req.params.hex.toLowerCase();
    // Local Pi readings first; if it's an off-radar fill-in plane from
    // adsb.lol, the local store doesn't know about it — fall back to the
    // off-radar buffer so the detail card opens and the user can see
    // operator/route/photo on dimmed planes too.
    const ac = store.get(hex) ?? getOffRadarAircraft(hex);
    if (!ac) return reply.code(404).send({ error: "not_found" });
    // Opening a flight is when we spend a (metered) AeroAPI query: upgrade the
    // route to a live flight plan. enrich() itself dedupes/rate-limits so
    // repeated opens of the same flight don't re-query.
    const upgraded = await enrich(hex, ac.flight, { paid: true, lat: ac.lat, lon: ac.lon, track: ac.track });
    if (upgraded) ac.enrichment = upgraded;
    // Position sanity check — strip stale free-source routes that don't
    // match where the plane actually is.
    ac.enrichment = withRouteSanity(ac, ac.enrichment);
    return { ...ac, trail: store.getTrail(hex) };
  });

  // Extended track: pre-pends adsb.lol's historical trace to the session trail
  // so a freshly-selected plane shows where it came from before the receiver
  // saw it. Cached server-side (see fetchExtendedTrack) so opening the same
  // hex repeatedly doesn't pound the upstream globe.adsb.lol bucket.
  app.get<{ Params: { hex: string } }>("/aircraft/:hex/track", async (req, reply) => {
    const hex = req.params.hex.toLowerCase();
    const session = store.getTrail(hex);
    const ext = isAdsblolEnabled() ? await fetchExtendedTrack(hex) : [];
    // Merge: external trace first (older), then session points; drop any
    // external points that overlap the session window so we don't double up.
    const sessionStart = session.length > 0 ? session[0]!.t : Number.POSITIVE_INFINITY;
    const trail = [...ext.filter((p) => p.t < sessionStart), ...session];
    // Free-derived flight times: actualOff from the trace, progress + ETA
    // from live position vs the destination airport. Skips fields the paid
    // path already filled in so AeroAPI values stay authoritative.
    const ac = store.get(hex);
    // Same sanity check the detail endpoint runs — skip the derived times
    // entirely when the route doesn't match the plane's track. Sending a
    // bad route here would put it back into the UI even after the detail
    // endpoint stripped it.
    const sanity = ac && ac.enrichment ? withRouteSanity(ac, ac.enrichment) : undefined;
    const route = sanity?.route;
    const derivedRoute = ac && route ? deriveFreeRouteTimes(ac, route, trail) : undefined;
    return reply.send({
      hex,
      trail,
      sources: ext.length > 0 ? ["adsblol", "session"] : ["session"],
      route: derivedRoute,
      routeStale: sanity?.routeStale === true,
    });
  });

  app.get("/stats", async () => {
    const current = store.getSnapshot().aircraft.length;
    return getStats(current);
  });

  app.get("/coverage", async () => getCoverage());

  // Popout lists for the clickable stat cards.
  app.get<{ Querystring: { offset?: string; limit?: string } }>("/stats/today", async (req) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return listToday(offset, limit);
  });
  app.get<{ Querystring: { offset?: string; limit?: string } }>("/stats/all-time", async (req) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return listAllTime(offset, limit);
  });
  app.get<{ Querystring: { scope?: "today" | "all"; limit?: string } }>("/stats/farthest", async (req) => {
    const scope = req.query.scope === "all" ? "all" : "today";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return listFarthest(scope, limit);
  });
  app.get<{ Querystring: { limit?: string } }>("/stats/notable", async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    return { rows: listNotable(limit) };
  });

  // Filtered sightings popout — powers the full-screen tables in the UI.
  app.get<{
    Querystring: {
      scope?: "today" | "week" | "month" | "all";
      sort?: "recent" | "farthest" | "first";
      q?: string;
      airline?: string;
      offset?: string;
      limit?: string;
    };
  }>("/stats/sightings", async (req) => listSightings({
    scope: req.query.scope,
    sort: req.query.sort,
    q: req.query.q,
    airline: req.query.airline,
    offset: req.query.offset != null ? Math.max(0, Number(req.query.offset) || 0) : undefined,
    limit: req.query.limit != null ? Math.min(500, Math.max(1, Number(req.query.limit) || 100)) : undefined,
  }));

  app.get("/achievements", async () => ({ achievements: listAchievements() }));

  // Radar-versary banner data: the first home WiFi name + when it was joined,
  // and whether today is its calendar anniversary.
  app.get("/anniversary", async () => {
    const home = getHomeWifi();
    if (!home) return { configured: false as const };
    const now = new Date();
    const first = new Date(home.firstAt);
    const days = Math.floor((now.getTime() - first.getTime()) / 86400000);
    const years = now.getFullYear() - first.getFullYear() - (now.getMonth() < first.getMonth() || (now.getMonth() === first.getMonth() && now.getDate() < first.getDate()) ? 1 : 0);
    const isAnniversary = years >= 1 && now.getMonth() === first.getMonth() && now.getDate() === first.getDate();
    return { configured: true as const, name: home.name, firstAt: home.firstAt, days, years, isAnniversary };
  });

  // ── Friend-facing setup wizard (PIN-gated) ─────────────────────────────────

  app.get("/setup/state", async () => setupState());

  app.get("/setup/pin-status", async () => ({ pinSet: isPinSet() }));

  // First-run PIN creation (allowed once). Changing later requires the current PIN.
  app.post<{ Body: { pin?: string; currentPin?: string } }>("/setup/set-pin", async (req, reply) => {
    const pin = req.body?.pin;
    if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
      return reply.code(400).send({ error: "invalid_pin", detail: "PIN must be 4–6 digits." });
    }
    if (isPinSet() && !pinOk(req.body?.currentPin)) {
      return reply.code(401).send({ error: "bad_pin", detail: "Current PIN required to change it." });
    }
    setSetupPin(pin);
    return { ok: true };
  });

  app.post<{ Body: { pin?: string } }>("/setup/verify-pin", async (req) => ({
    ok: pinOk(req.body?.pin),
    /** True if the PIN that authenticated is the master override (so the UI
     *  can offer "Reset user PIN to default"). Never true for the user PIN. */
    master: isMasterPin(req.body?.pin),
  }));

  // Owner-only: reset the user PIN back to the default (0000). Requires the
  // master override PIN so a regular user can't wipe it from a phone with
  // sessionStorage open.
  app.post<{ Body: { pin?: string } }>("/setup/reset-user-pin", async (req, reply) => {
    if (!isMasterPin(req.body?.pin)) return reply.code(401).send({ error: "master_pin_required" });
    setSetupPin(DEFAULT_USER_PIN);
    return { ok: true, pin: DEFAULT_USER_PIN };
  });

  app.post<{ Body: { pin?: string; city?: string; lat?: number; lon?: number; county?: string } }>(
    "/setup/location",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const { city, lat, lon, county } = req.body;
      if (typeof city !== "string" || typeof lat !== "number" || typeof lon !== "number") {
        return reply.code(400).send({ error: "invalid" });
      }
      setReceiver(lat, lon, city, typeof county === "string" ? county : undefined);
      return { ok: true, setup: setupState(), receiver: getReceiver() };
    },
  );

  // Full editable settings for the PIN-gated Settings tab. Returns the actual
  // key values (owner-only, behind the PIN) so each can be revealed/edited.
  app.post<{ Body: { pin?: string } }>("/setup/settings", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    const k = getApiKeys();
    const settings: AdminSettings = {
      pilotName: getPilotName(),
      receiver: getReceiver(),
      keys: {
        flightAwareAeroApi: k.flightAwareAeroApi ?? "",
        flightRadar24Token: k.flightRadar24Token ?? "",
        fr24SharingKey: k.fr24SharingKey ?? "",
        piawareFeederId: k.piawareFeederId ?? "",
      },
      aero: aeroStatus(),
      gateway: getGatewayConfig(),
      adsblolEnabled: isAdsblolEnabled(),
      offRadarEnabled: isOffRadarEnabled(),
    };
    return settings;
  });

  app.post<{ Body: { pin?: string; enabled?: boolean } }>("/setup/off-radar", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "bad_request" });
    setOffRadarEnabled(req.body.enabled);
    return { ok: true, enabled: isOffRadarEnabled() };
  });

  // ── Flight watches (pinned callsigns the user wants alerted on) ────────
  app.post<{ Body: { pin?: string } }>("/setup/watches", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    return { watches: listWatches() };
  });
  app.post<{ Body: { pin?: string; callsign?: string; name?: string; flightDate?: string; note?: string; expiresAt?: number } }>(
    "/setup/watches/add",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const raw = (req.body?.callsign ?? "").trim();
      if (!raw) return reply.code(400).send({ error: "callsign_required" });
      try {
        const w = addWatch({
          raw,
          name: req.body?.name,
          flightDate: req.body?.flightDate,
          note: req.body?.note,
          expiresAt: req.body?.expiresAt,
        });
        return { ok: true, watch: w };
      } catch (e) {
        return reply.code(400).send({ ok: false, error: (e as Error).message });
      }
    },
  );
  app.post<{ Body: { pin?: string; id?: number } }>("/setup/watches/remove", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    if (typeof req.body?.id !== "number") return reply.code(400).send({ error: "id_required" });
    removeWatch(req.body.id);
    return { ok: true };
  });
  app.post<{ Body: { pin?: string; id?: number } }>("/setup/watches/clear-fire", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    if (typeof req.body?.id !== "number") return reply.code(400).send({ error: "id_required" });
    clearWatchFire(req.body.id);
    return { ok: true };
  });

  app.post<{ Body: { pin?: string; enabled?: boolean } }>("/setup/adsblol", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "bad_request" });
    setAdsblolEnabled(req.body.enabled);
    // Wipe the route cache so the next enrichment pass reflects the new source mix.
    clearEnrichmentCache();
    store.resetEnrichment();
    return { ok: true, enabled: isAdsblolEnabled() };
  });

  // ── Owner-only admin endpoints ─────────────────────────────────────────────
  // Master PIN is required (the user PIN intentionally can't unlock these).
  // adminPinOk runs the same constant-time check as pinOk but only accepts
  // the master PIN, so even a shared user PIN can't trigger a wipe/update.
  function adminPinOk(p: unknown): boolean { return isMasterPin(p); }

  app.post<{ Body: { pin?: string } }>("/admin/device-info", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    return await getDeviceInfo();
  });

  app.post<{ Body: { pin?: string } }>("/admin/reset-stats", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    try {
      adminResetStats();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

  app.post<{ Body: { pin?: string } }>("/admin/backfill-achievements", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    try {
      const r = backfillAchievements();
      return { ok: true as const, ...r };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

  app.post<{ Body: { pin?: string } }>("/admin/diagnose-achievements", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    return diagnoseAchievements();
  });

  app.post<{ Body: { pin?: string } }>("/admin/restart", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    // Restart can happen directly from the container — we have the docker
    // socket and the compose file mounted (see docker-compose.yml). Try
    // that first so this works even if qdrn-netd on the host is old or
    // missing. The container will die mid-response; the new one will be
    // serving within a few seconds.
    try {
      const r = await composeFromContainer(["restart", "qdrn-radar"]);
      if (r.ok) return r;
      // Compose failed — fall through to qdrn-netd as a backup path.
    } catch { /* fall through */ }
    try {
      return await netd<{ ok: boolean; error?: string }>({ op: "restart" });
    } catch (e) {
      return { ok: false, error: `Restart unavailable: ${(e as Error).message}. Make sure the docker socket is mounted, or update qdrn-netd on the host.` };
    }
  });

  app.post<{ Body: { pin?: string } }>("/admin/update", async (req, reply) => {
    if (!adminPinOk(req.body?.pin)) return reply.code(401).send({ error: "owner_required" });
    // Pull update needs `git pull` on the host, which the container can't
    // do directly — qdrn-netd is the only path. If qdrn-netd is too old to
    // know the "update" op, give the user the exact command to run rather
    // than a cryptic "unknown op" error.
    try {
      const r = await netd<{ ok: boolean; error?: string }>({ op: "update" });
      if (!r.ok && /unknown op/i.test(r.error ?? "")) {
        return {
          ok: false,
          error: "Host helper (qdrn-netd) is out of date and doesn't know the `update` op. SSH to the Pi and run:\n\n  sudo bash ~/Dan_and_Madison/provisioning/qdrn-netd/install-netd.sh\n\nThen this button will work.",
        };
      }
      return r;
    } catch (e) {
      return { ok: false, error: `qdrn-netd unavailable: ${(e as Error).message}` };
    }
  });

  app.post<{ Body: { pin?: string; url?: string; key?: string } }>("/setup/gateway", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    setGatewayConfig({ url: req.body?.url, key: req.body?.key });
    // Switching the route source — drop cached free routes so the gateway applies.
    clearEnrichmentCache();
    store.resetEnrichment();
    return { ok: true, gateway: getGatewayConfig() };
  });

  app.post<{ Body: { pin?: string; enabled?: boolean; cap?: number } }>("/setup/aeroapi", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    setAeroApiConfig({ enabled: req.body?.enabled, cap: req.body?.cap });
    return { ok: true, aero: aeroStatus() };
  });

  app.post<{ Body: { pin?: string; name?: string } }>("/setup/name", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    setPilotName(typeof req.body?.name === "string" ? req.body.name.trim() : "");
    return { ok: true, pilotName: getPilotName() };
  });

  // ── Saved WiFi networks (proxied to qdrn-netd on the host) ──────────────
  app.post<{ Body: { pin?: string } }>("/setup/wifi", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    try {
      return await netd<{ ok: boolean; networks: WifiNetwork[]; error?: string }>({ op: "list" });
    } catch (e) {
      return reply.code(503).send({ ok: false, error: `netd unavailable: ${(e as Error).message}` });
    }
  });

  app.post<{ Body: { pin?: string; ssid?: string; password?: string; priority?: number } }>(
    "/setup/wifi/add",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const { ssid, password, priority } = req.body ?? {};
      if (typeof ssid !== "string" || !ssid.trim()) {
        return reply.code(400).send({ ok: false, error: "ssid required" });
      }
      try {
        const r = await netd<{ ok: boolean; error?: string }>({
          op: "add",
          ssid: ssid.trim(),
          password: typeof password === "string" ? password : "",
          priority: typeof priority === "number" ? priority : 50,
        });
        if (r.ok) noteHomeWifi(ssid.trim());
        return r;
      } catch (e) {
        return reply.code(503).send({ ok: false, error: `netd unavailable: ${(e as Error).message}` });
      }
    },
  );

  app.post<{ Body: { pin?: string; name?: string; uuid?: string } }>(
    "/setup/wifi/remove",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const { name, uuid } = req.body ?? {};
      if ((!name || !name.trim()) && (!uuid || !uuid.trim())) {
        return reply.code(400).send({ ok: false, error: "name or uuid required" });
      }
      try {
        return await netd<{ ok: boolean; error?: string }>({ op: "remove", name, uuid });
      } catch (e) {
        return reply.code(503).send({ ok: false, error: `netd unavailable: ${(e as Error).message}` });
      }
    },
  );

  app.post<{ Body: { pin?: string; name?: string; uuid?: string } }>(
    "/setup/wifi/connect",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const { name, uuid } = req.body ?? {};
      if ((!name || !name.trim()) && (!uuid || !uuid.trim())) {
        return reply.code(400).send({ ok: false, error: "name or uuid required" });
      }
      try {
        const r = await netd<{ ok: boolean; error?: string }>({ op: "connect", name, uuid });
        if (r.ok && typeof name === "string" && name.trim()) noteHomeWifi(name.trim());
        return r;
      } catch (e) {
        return reply.code(503).send({ ok: false, error: `netd unavailable: ${(e as Error).message}` });
      }
    },
  );

  app.post<{ Body: { pin?: string } }>("/setup/wifi/scan", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    try {
      return await netd<{ ok: boolean; networks: WifiScanResult[]; error?: string }>({ op: "scan" });
    } catch (e) {
      return reply.code(503).send({ ok: false, error: `netd unavailable: ${(e as Error).message}` });
    }
  });

  // Real connection status per service (token validity / feeder health).
  app.post<{ Body: { pin?: string; force?: boolean } }>("/setup/connections", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    return getConnections(Boolean(req.body?.force));
  });

  app.post<{
    Body: {
      pin?: string;
      flightAwareAeroApi?: string;
      flightRadar24Token?: string;
      fr24SharingKey?: string;
      piawareFeederId?: string;
    };
  }>("/setup/keys", async (req, reply) => {
    if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
    const b = req.body;
    let routeKeyChanged = false;
    if (b.flightAwareAeroApi) {
      setApiKey("flightAwareAeroApi", b.flightAwareAeroApi.trim());
      routeKeyChanged = true;
    }
    if (b.flightRadar24Token) setApiKey("flightRadar24Token", b.flightRadar24Token.trim());
    if (b.fr24SharingKey) setApiKey("fr24SharingKey", b.fr24SharingKey.trim());
    if (b.piawareFeederId) setApiKey("piawareFeederId", b.piawareFeederId.trim());

    // A new route source (AeroAPI) only helps if we stop serving cached
    // free-source routes — wipe the cache and re-enrich live aircraft.
    if (routeKeyChanged) {
      clearEnrichmentCache();
      store.resetEnrichment();
    }

    // Push feeder keys into the shared env file and recreate the feeder
    // containers in the background so feeding "just works" with no SSH.
    let feedersApplying = false;
    if (b.fr24SharingKey || b.piawareFeederId) {
      writeFeederEnv({
        ...(b.fr24SharingKey ? { FR24KEY: b.fr24SharingKey } : {}),
        ...(b.piawareFeederId ? { FEEDER_ID: b.piawareFeederId } : {}),
      });
      applyFeedersInBackground((m) => req.log.info(m));
      feedersApplying = true;
    }
    return { ok: true, setup: setupState(), feedersApplying };
  });
}
