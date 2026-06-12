import { createConnection } from "node:net";

const NETD_SOCK = process.env.QDRN_NETD_SOCK ?? "/run/qdrn-net.sock";

/** One-shot JSON RPC to the host helper (qdrn-netd). Extracted so the
 *  background auto-updater can use the same path the HTTP routes use. */
export function netd<T = unknown>(req: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(NETD_SOCK);
    let buf = "";
    let done = false;
    const finish = (val: unknown, err?: Error): void => {
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
    setTimeout(() => finish(null, new Error("netd timeout")), timeoutMs);
  });
}
