import { createConnection } from "node:net";
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
import {
  BASE_PATH,
  MAP_STYLE_DARK,
  MAP_STYLE_LIGHT,
  getAeroApiConfig,
  getAeroApiUsage,
  getApiKeys,
  getBrand,
  getGatewayConfig,
  getPilotName,
  getReceiver,
  getSetupPin,
  isPinSet,
  setAeroApiConfig,
  setApiKey,
  setGatewayConfig,
  setPilotName,
  setReceiver,
  setSetupPin,
} from "../config.js";
import { getConnections } from "../connections.js";
import { getCoverage } from "../coverage.js";
import { clearEnrichmentCache, enrich } from "../enrichment.js";
import { applyFeedersInBackground, writeFeederEnv } from "../feeder.js";
import { store } from "../poller.js";
import { getStats } from "../stats.js";

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

function pinOk(pin: unknown): boolean {
  const expected = getSetupPin();
  if (typeof pin !== "string" || pin.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= pin.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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
    const ac = store.get(hex);
    if (!ac) return reply.code(404).send({ error: "not_found" });
    // Opening a flight is when we spend a (metered) AeroAPI query: upgrade the
    // route to a live flight plan. enrich() itself dedupes/rate-limits so
    // repeated opens of the same flight don't re-query.
    const upgraded = await enrich(hex, ac.flight, { paid: true });
    if (upgraded) ac.enrichment = upgraded;
    return { ...ac, trail: store.getTrail(hex) };
  });

  app.get("/stats", async () => {
    const current = store.getSnapshot().aircraft.length;
    return getStats(current);
  });

  app.get("/coverage", async () => getCoverage());

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
  }));

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
    };
    return settings;
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
        return await netd<{ ok: boolean; error?: string }>({
          op: "add",
          ssid: ssid.trim(),
          password: typeof password === "string" ? password : "",
          priority: typeof priority === "number" ? priority : 50,
        });
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
        return await netd<{ ok: boolean; error?: string }>({ op: "connect", name, uuid });
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
