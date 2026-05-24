import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// File the fr24feed + piaware containers read their keys from (mounted at the
// same host path inside both this app and the compose project — see compose).
const FEEDER_ENV_PATH = process.env.FEEDER_ENV_PATH ?? "/app/data/feeder.env";
const STACK_DIR = process.env.STACK_DIR ?? "/app/stack";
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? `${STACK_DIR}/docker-compose.yml`;
const COMPOSE_ENV = process.env.COMPOSE_ENV_FILE ?? `${STACK_DIR}/.env`;
const PROJECT = process.env.COMPOSE_PROJECT ?? "qdrn-radar";
const FEEDER_SERVICES = ["fr24feed", "piaware"];

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Merge new feeder keys into the shared env file. Only writes provided keys. */
export function writeFeederEnv(updates: Partial<{ FR24KEY: string; FEEDER_ID: string }>): void {
  mkdirSync(dirname(FEEDER_ENV_PATH), { recursive: true });
  const merged = { ...parseEnvFile(FEEDER_ENV_PATH) };
  for (const [k, v] of Object.entries(updates)) {
    if (v && v.trim()) merged[k] = v.trim();
  }
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(FEEDER_ENV_PATH, body + "\n", { mode: 0o600 });
}

export interface ApplyResult {
  ok: boolean;
  detail: string;
}

/**
 * Recreate only the feeder containers so they pick up the new keys. Best-effort:
 * needs the docker socket + compose file mounted into this container (production
 * compose does this). In dev it just no-ops with a message.
 */
export async function applyFeeders(): Promise<ApplyResult> {
  if (!existsSync(COMPOSE_FILE)) {
    return { ok: false, detail: `compose file not mounted at ${COMPOSE_FILE} (keys saved; run \`docker compose up -d ${FEEDER_SERVICES.join(" ")}\` on the host)` };
  }
  const args = [
    "compose",
    "-p",
    PROJECT,
    "--project-directory",
    STACK_DIR,
    "-f",
    COMPOSE_FILE,
    ...(existsSync(COMPOSE_ENV) ? ["--env-file", COMPOSE_ENV] : []),
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    ...FEEDER_SERVICES,
  ];
  try {
    const { stdout, stderr } = await exec("docker", args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, detail: (stderr || stdout || "ok").slice(-500) };
  } catch (e) {
    return { ok: false, detail: String(e).slice(-500) };
  }
}

/** Fire-and-forget apply (used from the friend-facing wizard so it stays snappy). */
export function applyFeedersInBackground(log: (msg: string) => void): void {
  applyFeeders()
    .then((r) => log(`feeder apply: ${r.ok ? "ok" : "failed"} — ${r.detail}`))
    .catch((e) => log(`feeder apply error: ${String(e)}`));
}
