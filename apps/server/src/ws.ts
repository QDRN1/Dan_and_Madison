import type { FastifyInstance } from "fastify";
import { BASE_PATH } from "./config.js";
import { store } from "./poller.js";

// Minimal shape of the ws socket handed to us by @fastify/websocket.
interface WSLike {
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  readyState: number;
  readonly OPEN: number;
}

/**
 * Live websocket at {BASE_PATH}/api/live. Sends the current snapshot on connect,
 * then pushes a new snapshot on every poll tick.
 */
export function setupWebsocket(app: FastifyInstance): void {
  const clients = new Set<WSLike>();

  app.get(`${BASE_PATH}/api/live`, { websocket: true }, (connection) => {
    const socket = connection as unknown as WSLike;
    clients.add(socket);
    try {
      socket.send(JSON.stringify({ type: "snapshot", data: store.getSnapshot() }));
    } catch {
      /* ignore */
    }
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  store.on("snapshot", (snapshot) => {
    if (clients.size === 0) return;
    const msg = JSON.stringify({ type: "snapshot", data: snapshot });
    for (const c of clients) {
      try {
        if (c.readyState === c.OPEN) c.send(msg);
        else clients.delete(c);
      } catch {
        clients.delete(c);
      }
    }
  });

  // Push flight-watch alerts to every connected client. Same delivery path
  // as snapshots so a stale/dropped socket doesn't get a misleading hit.
  store.on("watch_hit", (hit) => {
    if (clients.size === 0) return;
    const msg = JSON.stringify({ type: "watch_hit", data: hit });
    for (const c of clients) {
      try {
        if (c.readyState === c.OPEN) c.send(msg);
        else clients.delete(c);
      } catch {
        clients.delete(c);
      }
    }
  });
}
