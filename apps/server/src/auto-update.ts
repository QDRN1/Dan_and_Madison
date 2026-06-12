import { getAutoUpdateLastRunAt, isAutoUpdateEnabled, setAutoUpdateLastRunAt } from "./config.js";
import { netd } from "./netd.js";

/** Off-peak window when an auto-update is allowed to run. Inclusive lower,
 *  exclusive upper. 3:00–5:00 local time covers redeploy + boot + tile
 *  warmup before most users would notice; the radar is usually idle. */
const HOUR_START = 3;
const HOUR_END = 5;

/** How often the background loop wakes up to consider an update. Every 30
 *  min is plenty given the off-peak window is two hours wide. */
const TICK_MS = 30 * 60 * 1000;

/** Lockout between auto-runs so a borked update doesn't try to re-apply
 *  itself every tick. 6 hours covers the window + a buffer; a manual click
 *  still updates immediately. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

let started = false;

export function startAutoUpdate(log: { info(msg: string): void; warn(msg: string): void }): void {
  if (started) return;
  started = true;
  // Wait 60s after server boot before the first tick so we don't auto-update
  // immediately on the first restart after the feature ships.
  setTimeout(() => { void tick(log); }, 60_000);
  setInterval(() => { void tick(log); }, TICK_MS);
}

async function tick(log: { info(msg: string): void; warn(msg: string): void }): Promise<void> {
  if (!isAutoUpdateEnabled()) return;

  const now = new Date();
  const hour = now.getHours(); // local hour per the TZ env baked into the container
  if (hour < HOUR_START || hour >= HOUR_END) return;

  const lastRun = getAutoUpdateLastRunAt() ?? 0;
  if (Date.now() - lastRun < MIN_INTERVAL_MS) return;

  let check: { ok: boolean; behind: number; latestSha?: string; latestSubject?: string };
  try {
    check = await netd<{ ok: boolean; behind: number; latestSha?: string; latestSubject?: string }>({ op: "update-check" });
  } catch (e) {
    log.warn(`[auto-update] check failed: ${(e as Error).message}`);
    return;
  }
  if (!check.ok || check.behind === 0) return;

  log.info(`[auto-update] applying ${check.behind} commits (latest ${check.latestSha ?? "?"}: ${check.latestSubject ?? ""})`);
  setAutoUpdateLastRunAt(Date.now());
  try {
    // qdrn-netd kicks off git pull + detached docker compose build, which
    // will recycle this very container. Same path the manual button uses.
    await netd({ op: "update" });
  } catch (e) {
    // Often the container is killed mid-response; expected.
    log.warn(`[auto-update] update RPC returned: ${(e as Error).message} (likely container restart, not failure)`);
  }
}
