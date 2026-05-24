import type { FastifyInstance } from "fastify";
import type { PublicConfig, SetupState } from "@qdrn/shared";
import {
  BASE_PATH,
  MAP_STYLE_URL,
  getApiKeys,
  getBrand,
  getReceiver,
  getSetupPin,
  setApiKey,
  setReceiver,
} from "../config.js";
import { enrich } from "../enrichment.js";
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
    mapStyleUrl: MAP_STYLE_URL,
    brand: getBrand(),
    setup: setupState(),
  }));

  app.get("/aircraft", async () => store.getSnapshot());

  app.get<{ Params: { hex: string } }>("/aircraft/:hex", async (req, reply) => {
    const hex = req.params.hex.toLowerCase();
    const ac = store.get(hex);
    if (!ac) return reply.code(404).send({ error: "not_found" });
    // Make sure enrichment is attached for the detail view.
    if (!ac.enrichment) ac.enrichment = await enrich(hex, ac.flight);
    return ac;
  });

  app.get("/stats", async () => {
    const current = store.getSnapshot().aircraft.length;
    return getStats(current);
  });

  // ── Friend-facing setup wizard (PIN-gated) ─────────────────────────────────

  app.get("/setup/state", async () => setupState());

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
    if (b.flightAwareAeroApi) setApiKey("flightAwareAeroApi", b.flightAwareAeroApi.trim());
    if (b.flightRadar24Token) setApiKey("flightRadar24Token", b.flightRadar24Token.trim());
    if (b.fr24SharingKey) setApiKey("fr24SharingKey", b.fr24SharingKey.trim());
    if (b.piawareFeederId) setApiKey("piawareFeederId", b.piawareFeederId.trim());
    return { ok: true, setup: setupState() };
  });
}
