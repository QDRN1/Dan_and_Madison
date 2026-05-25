import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServiceName, ServiceStatus } from "@qdrn/shared";
import type { AeroApiStatus } from "@qdrn/shared";
import {
  ADMIN_EMAILS,
  CF_ACCESS_AUD,
  CF_ACCESS_TEAM_DOMAIN,
  getAeroApiConfig,
  getAeroApiUsage,
  getApiKeys,
  getReceiver,
  setAeroApiConfig,
  setApiKey,
  setReceiver,
  setSetupPin,
  type ApiKeys,
} from "../config.js";
import { db } from "../db.js";
import { clearEnrichmentCache } from "../enrichment.js";
import { applyFeeders, applyFeedersInBackground, writeFeederEnv } from "../feeder.js";
import { store } from "../poller.js";

const exec = promisify(execFile);

// Only these containers can ever be acted on — never trust a path param.
const SERVICES: ServiceName[] = ["ultrafeeder", "fr24feed", "piaware", "qdrn-radar", "cloudflared"];

function isService(x: string): x is ServiceName {
  return (SERVICES as string[]).includes(x);
}

let jwks: JWTVerifyGetKey | null = null;
function getJwks(): JWTVerifyGetKey | null {
  if (!CF_ACCESS_TEAM_DOMAIN) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(`https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  return jwks;
}

function accessToken(req: FastifyRequest): string | undefined {
  const header = req.headers["cf-access-jwt-assertion"];
  if (typeof header === "string" && header) return header;
  const cookie = req.headers.cookie ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1];
}

/**
 * Verify the Cloudflare Access JWT (not just a spoofable header). The token is
 * issued by your Access team for the admin application; we check its signature
 * against the team JWKS, the audience tag, and the email allowlist. Fails closed
 * in production if Access isn't configured. Dev is allowed through.
 */
async function requireCfAccess(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const keys = getJwks();
  if (!keys || !CF_ACCESS_AUD) {
    return reply.code(503).send({
      error: "access_not_configured",
      detail: "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD so admin can verify Cloudflare Access.",
    });
  }
  const token = accessToken(req);
  if (!token) return reply.code(403).send({ error: "forbidden", detail: "No Cloudflare Access token." });

  try {
    const { payload } = await jwtVerify(token, keys, {
      audience: CF_ACCESS_AUD,
      issuer: `https://${CF_ACCESS_TEAM_DOMAIN}`,
    });
    const email = String(payload.email ?? "").toLowerCase();
    if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(email)) {
      return reply.code(403).send({ error: "forbidden", detail: "Not an authorized admin." });
    }
  } catch {
    return reply.code(403).send({ error: "forbidden", detail: "Invalid Cloudflare Access token." });
  }
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function serviceStatus(): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];
  for (const name of SERVICES) {
    try {
      const status = (await docker(["inspect", "-f", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", name])).trim();
      const [state, health] = status.split("|");
      out.push({
        name,
        running: state === "running",
        health: health === "none" ? "unknown" : (health as ServiceStatus["health"]),
        detail: state,
      });
    } catch {
      out.push({ name, running: false, health: "unknown", detail: "not found" });
    }
  }
  return out;
}

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireCfAccess);

  app.get("/whoami", async (req) => ({
    email: req.headers["cf-access-authenticated-user-email"] ?? null,
  }));

  app.get("/services", async () => serviceStatus());

  app.post<{ Params: { name: string } }>("/services/:name/restart", async (req, reply) => {
    const { name } = req.params;
    if (!isService(name)) return reply.code(400).send({ error: "unknown_service" });
    try {
      await docker(["restart", name]);
      return { ok: true };
    } catch (e) {
      return reply.code(500).send({ error: "restart_failed", detail: String(e) });
    }
  });

  app.get<{ Params: { name: string }; Querystring: { lines?: string } }>(
    "/logs/:name",
    async (req, reply) => {
      const { name } = req.params;
      if (!isService(name)) return reply.code(400).send({ error: "unknown_service" });
      const lines = Math.min(Math.max(Number(req.query.lines ?? 200) || 200, 1), 2000);
      try {
        const logs = await docker(["logs", "--tail", String(lines), name]);
        return { name, logs };
      } catch (e) {
        return reply.code(500).send({ error: "logs_failed", detail: String(e) });
      }
    },
  );

  app.post("/feeders/apply", async () => applyFeeders());

  // ── API keys (CF-gated; same store as the PIN setup wizard) ───────────────
  app.get("/keys", async () => {
    const k = getApiKeys();
    return {
      flightAwareConnected: Boolean(k.flightAwareAeroApi),
      flightRadar24Connected: Boolean(k.flightRadar24Token),
      fr24SharingKeySet: Boolean(k.fr24SharingKey),
      piawareFeederIdSet: Boolean(k.piawareFeederId),
    };
  });

  app.post<{ Body: Partial<Record<keyof ApiKeys, string>> }>("/keys", async (req) => {
    const b = req.body ?? {};
    let routeKeyChanged = false;
    let feedersChanged = false;
    for (const which of ["flightAwareAeroApi", "flightRadar24Token", "fr24SharingKey", "piawareFeederId"] as const) {
      const v = b[which];
      if (v === undefined) continue;
      setApiKey(which, v.trim());
      if (which === "flightAwareAeroApi") routeKeyChanged = true;
      if (which === "fr24SharingKey" || which === "piawareFeederId") feedersChanged = true;
    }
    if (routeKeyChanged) {
      clearEnrichmentCache();
      store.resetEnrichment();
    }
    if (feedersChanged) {
      const k = getApiKeys();
      writeFeederEnv({
        ...(k.fr24SharingKey ? { FR24KEY: k.fr24SharingKey } : {}),
        ...(k.piawareFeederId ? { FEEDER_ID: k.piawareFeederId } : {}),
      });
      applyFeedersInBackground((m) => req.log.info(m));
    }
    return { ok: true };
  });

  // ── Receiver location ─────────────────────────────────────────────────────
  app.get("/location", async () => getReceiver());

  app.post<{ Body: { city?: string; lat?: number; lon?: number } }>("/location", async (req, reply) => {
    const { city, lat, lon } = req.body ?? {};
    if (typeof city !== "string" || typeof lat !== "number" || typeof lon !== "number") {
      return reply.code(400).send({ error: "invalid" });
    }
    setReceiver(lat, lon, city);
    return { ok: true, receiver: getReceiver() };
  });

  // ── AeroAPI spend guard (master switch + monthly cap + usage) ─────────────
  app.get("/aeroapi", async (): Promise<AeroApiStatus> => {
    const cfg = getAeroApiConfig();
    const u = getAeroApiUsage();
    return { enabled: cfg.enabled, cap: cfg.cap, used: u.count, month: u.month, keyPresent: Boolean(getApiKeys().flightAwareAeroApi) };
  });

  app.post<{ Body: { enabled?: boolean; cap?: number } }>("/aeroapi", async (req) => {
    setAeroApiConfig({ enabled: req.body?.enabled, cap: req.body?.cap });
    const cfg = getAeroApiConfig();
    const u = getAeroApiUsage();
    return { enabled: cfg.enabled, cap: cfg.cap, used: u.count, month: u.month, keyPresent: Boolean(getApiKeys().flightAwareAeroApi) };
  });

  // Set/override the owner PIN (admin is already authenticated by CF Access, so
  // no current PIN needed — useful if the friend forgets it).
  app.post<{ Body: { pin?: string } }>("/device/set-pin", async (req, reply) => {
    const pin = req.body?.pin;
    if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
      return reply.code(400).send({ error: "invalid_pin", detail: "PIN must be 4–6 digits." });
    }
    setSetupPin(pin);
    return { ok: true };
  });

  // Factory reset: wipe PIN, location, keys, and stats so the device can be
  // onboarded fresh (re-triggers the first-run CaptainQ flow). Does NOT touch
  // the feeder.env keys file (feeding keeps working) — clear that over SSH if
  // re-gifting to a different person.
  app.post("/device/reset", async () => {
    db.exec("DELETE FROM settings; DELETE FROM sightings; DELETE FROM flagged; DELETE FROM enrichment_cache; DELETE FROM coverage_range;");
    return { ok: true };
  });

  app.get("/info", async () => ({
    sshHint: "ssh over the Cloudflare tunnel — see infra/cloudflared and docs/ADMIN.md",
    services: SERVICES,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  }));
}
