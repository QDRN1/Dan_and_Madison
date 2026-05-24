import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { BASE_PATH, PORT } from "./config.js";
import { store } from "./poller.js";
import { setupWebsocket } from "./ws.js";
import apiRoutes from "./routes/api.js";
import adminRoutes from "./routes/admin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST ?? resolve(__dirname, "../../web/dist");
const BRAND_DIR = process.env.BRAND_DIR ?? resolve(__dirname, "../../../brand");

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });

  await app.register(fastifyWebsocket);
  setupWebsocket(app);

  await app.register(apiRoutes, { prefix: `${BASE_PATH}/api` });
  await app.register(adminRoutes, { prefix: `${BASE_PATH}/admin/api` });

  // Brand assets (logo, etc) — swappable without rebuilding the app.
  if (existsSync(BRAND_DIR)) {
    await app.register(fastifyStatic, {
      root: BRAND_DIR,
      prefix: `${BASE_PATH}/brand/`,
      decorateReply: false,
    });
  }

  // Serve the built SPA with client-side routing fallback.
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: `${BASE_PATH}/` });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && req.url.startsWith(BASE_PATH) && !req.url.startsWith(`${BASE_PATH}/api`)) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.log.warn(`Web build not found at ${WEB_DIST} — run \`npm run build\` (dev uses the Vite server).`);
  }

  // Bare domain → app base path.
  app.get("/", (_req, reply) => reply.redirect(BASE_PATH));
  app.get(`${BASE_PATH}`, (_req, reply) => reply.redirect(`${BASE_PATH}/`));

  app.get(`${BASE_PATH}/healthz`, async () => ({ ok: true }));

  store.start();

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`QDRN Radar listening on :${PORT} at ${BASE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
