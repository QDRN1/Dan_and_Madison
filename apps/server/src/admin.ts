import { readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { db } from "./db.js";

interface DeviceInfo {
  uptimeHuman: string;
  load1: number; load5: number; load15: number;
  diskUsedPct: number; diskFreeHuman: string;
  cpuTempF: number | null;
  sightingsCount: number;
  achievementsEarned: number; achievementsTotal: number;
  buildSha?: string;
}

function readUptimeSec(): number {
  try {
    const raw = readFileSync("/proc/uptime", "utf8");
    return Number(raw.split(/\s+/)[0]);
  } catch { return 0; }
}

function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function readLoadAvg(): [number, number, number] {
  try {
    const parts = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  } catch { return [0, 0, 0]; }
}

function readCpuTempF(): number | null {
  try {
    const milli = Number(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim());
    if (!Number.isFinite(milli) || milli <= 0) return null;
    return (milli / 1000) * 9 / 5 + 32;
  } catch { return null; }
}

function humanBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

function readDiskFreeFor(path: string): { freeBytes: number; totalBytes: number } {
  // Linux statfs would be ideal; we approximate via `df -k`.
  try {
    const out = execSync(`df -k ${path}`, { encoding: "utf8", timeout: 4000 });
    const line = out.trim().split("\n").pop() ?? "";
    const parts = line.split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const freeKb = Number(parts[3]);
    if (!Number.isFinite(totalKb)) return { freeBytes: 0, totalBytes: 0 };
    void usedKb;
    return { freeBytes: freeKb * 1024, totalBytes: totalKb * 1024 };
  } catch { return { freeBytes: 0, totalBytes: 0 }; }
}

function buildSha(): string | undefined {
  // Optional file written by the install / publish script. Falls back to env.
  try { return readFileSync("/etc/qdrn-build.sha", "utf8").trim(); }
  catch { /* not present */ }
  return process.env.QDRN_BUILD_SHA;
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const uptime = readUptimeSec();
  const [load1, load5, load15] = readLoadAvg();
  const cpuTempF = readCpuTempF();
  const dataPath = process.env.DB_PATH ?? "./data/qdrn-radar.db";
  let dataDir = "."; try { dataDir = statSync(dataPath).isDirectory() ? dataPath : dataPath.replace(/\/[^/]+$/, ""); } catch { /* default */ }
  const disk = readDiskFreeFor(dataDir);
  const diskUsedPct = disk.totalBytes > 0 ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100) : 0;

  const sightingsCount = (db.prepare("SELECT COUNT(*) n FROM sightings").get() as { n: number }).n;
  const achievementsEarned = (db.prepare("SELECT COUNT(*) n FROM achievements WHERE count > 0").get() as { n: number }).n;
  const achievementsTotal = (db.prepare("SELECT COUNT(*) n FROM achievements").get() as { n: number }).n;

  return {
    uptimeHuman: humanDuration(uptime),
    load1, load5, load15,
    diskUsedPct, diskFreeHuman: humanBytes(disk.freeBytes),
    cpuTempF,
    sightingsCount,
    achievementsEarned, achievementsTotal,
    buildSha: buildSha(),
  };
}

/** Wipes the operational tables — sightings, flagged, coverage, achievements.
 *  Settings (PIN, location, WiFi, gateway, etc.) and the enrichment cache are
 *  intentionally kept so the device stays usable without re-setup. */
export function adminResetStats(): void {
  db.exec(`
    DELETE FROM sightings;
    DELETE FROM flagged;
    DELETE FROM coverage_range;
    DELETE FROM achievements;
  `);
}
