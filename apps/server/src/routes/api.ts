import type { FastifyInstance } from "fastify";
import type { PublicConfig, SetupState } from "@qdrn/shared";
import {
  BASE_PATH,
  MAP_STYLE_DARK,
  MAP_STYLE_LIGHT,
  getApiKeys,
  getBrand,
  getReceiver,
  getSetupPin,
  isPinSet,
  setApiKey,
  setReceiver,
  setSetupPin,
} from "../config.js";
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
  }));

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

  app.post<{ Body: { pin?: string; city?: string; lat?: number; lon?: number } }>(
    "/setup/location",
    async (req, reply) => {
      if (!pinOk(req.body?.pin)) return reply.code(401).send({ error: "bad_pin" });
      const { city, lat, lon } = req.body;
      if (typeof city !== "string" || typeof lat !== "number" || typeof lon !== "number") {
        return reply.code(400).send({ error: "invalid" });
      }
      setReceiver(lat, lon, city);
      return { ok: true, setup: setupState() };
    },
  );

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
