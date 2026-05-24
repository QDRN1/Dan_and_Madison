import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServiceName, ServiceStatus } from "@qdrn/shared";
import { ADMIN_EMAILS } from "../config.js";

const exec = promisify(execFile);

// Only these containers can ever be acted on — never trust a path param.
const SERVICES: ServiceName[] = ["ultrafeeder", "fr24feed", "piaware", "qdrn-radar", "cloudflared"];

function isService(x: string): x is ServiceName {
  return (SERVICES as string[]).includes(x);
}

/**
 * Cloudflare Access sits in front of /admin at the edge and injects the
 * authenticated user's email. We re-check it here (defense in depth) and, when
 * ADMIN_EMAILS is set, enforce an allowlist. In dev we allow through.
 */
function requireCfAccess(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  if (process.env.NODE_ENV !== "production") return done();
  const email = String(req.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase();
  if (!email) {
    reply.code(403).send({ error: "forbidden", detail: "No Cloudflare Access identity." });
    return;
  }
  if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(email)) {
    reply.code(403).send({ error: "forbidden", detail: "Not an authorized admin." });
    return;
  }
  done();
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

  app.get("/info", async () => ({
    sshHint: "ssh over the Cloudflare tunnel — see infra/cloudflared and docs/ADMIN.md",
    services: SERVICES,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  }));
}
