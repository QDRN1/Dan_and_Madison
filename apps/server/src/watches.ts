import type { Aircraft } from "@qdrn/shared";
import { db } from "./db.js";

/**
 * Flight watch list. The user pins a callsign (e.g. "DL2864") and we fire
 * a big alert the moment a matching aircraft enters the radar. Match is
 * by normalized callsign so an IATA-style input ("DL2864") still hits the
 * ADS-B feed's ICAO callsign ("DAL2864").
 */

/** IATA → ICAO airline prefix map for normalizing user input. Just the
 *  carriers that fly meaningful US/EU routes — extend as needed. */
const IATA_TO_ICAO: Record<string, string> = {
  // US mainline
  DL: "DAL", AA: "AAL", UA: "UAL", WN: "SWA", AS: "ASA",
  B6: "JBU", NK: "NKS", F9: "FFT", G4: "AAY", HA: "HAL",
  // US regional + cargo
  OO: "SKW", YX: "RPA", MQ: "ENY", "9E": "EDV", OH: "JIA",
  FX: "FDX", "5X": "UPS", PO: "PAC", GB: "GTI", "5Y": "GTI",
  // International
  AC: "ACA", AF: "AFR", BA: "BAW", LH: "DLH", KL: "KLM",
  IB: "IBE", AZ: "ITY", AY: "FIN", LX: "SWR", OS: "AUA",
  SK: "SAS", SN: "BEL", LO: "LOT", TP: "TAP", VS: "VIR",
  EI: "EIN", FI: "ICE", DY: "NAX", U2: "EZY", FR: "RYR",
  EK: "UAE", QR: "QTR", EY: "ETD", SQ: "SIA", QF: "QFA",
  NZ: "ANZ", CX: "CPA", JL: "JAL", NH: "ANA", KE: "KAL",
  OZ: "AAR", CI: "CAL", BR: "EVA", TG: "THA", MH: "MAS",
  SU: "AFL", TK: "THY", LY: "ELY", ET: "ETH", MS: "MSR",
};

/** Normalize a user-entered callsign for matching. Strips whitespace,
 *  uppercases, and expands a 2-char IATA airline prefix to its 3-char ICAO
 *  equivalent so "DL2864" matches the ADS-B feed's "DAL2864". */
export function normalizeCallsign(raw: string): string {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  // 2-char alpha prefix + numeric (possibly with trailing letter) → maybe IATA.
  const m = s.match(/^([A-Z][A-Z0-9])(\d.*)$/);
  const prefix = m?.[1];
  const suffix = m?.[2];
  if (prefix && suffix && IATA_TO_ICAO[prefix]) return IATA_TO_ICAO[prefix] + suffix;
  return s;
}

export interface WatchRow {
  id: number;
  callsign: string;      // normalized
  raw_input: string;
  note: string | null;
  created_at: number;
  expires_at: number | null;
  fired_at: number | null;
  fired_hex: string | null;
}

const listStmt = db.prepare(`SELECT * FROM watches ORDER BY created_at DESC`);
const insertStmt = db.prepare(
  `INSERT INTO watches (callsign, raw_input, note, created_at, expires_at)
   VALUES (@callsign, @raw_input, @note, @created_at, @expires_at)`,
);
const removeStmt = db.prepare(`DELETE FROM watches WHERE id = ?`);
const fireStmt = db.prepare(
  `UPDATE watches SET fired_at = @fired_at, fired_hex = @fired_hex WHERE id = @id`,
);
const clearFiredStmt = db.prepare(`UPDATE watches SET fired_at = NULL, fired_hex = NULL WHERE id = ?`);

export function listWatches(): WatchRow[] {
  return listStmt.all() as WatchRow[];
}

export function addWatch(input: { raw: string; note?: string; expiresAt?: number }): WatchRow {
  const callsign = normalizeCallsign(input.raw);
  if (!callsign) throw new Error("empty callsign");
  insertStmt.run({
    callsign,
    raw_input: input.raw.trim(),
    note: input.note ?? null,
    created_at: Date.now(),
    expires_at: input.expiresAt ?? null,
  });
  return listWatches().find((w) => w.callsign === callsign)!;
}

export function removeWatch(id: number): void {
  removeStmt.run(id);
}

export function clearWatchFire(id: number): void {
  clearFiredStmt.run(id);
}

/** Scan the current aircraft snapshot against the watch list. Returns
 *  newly-matching watches (callsign hit + not already fired against this hex).
 *  Caller is responsible for dispatching the alert + persisting the fire. */
export function checkWatches(aircraft: Aircraft[]): { watch: WatchRow; aircraft: Aircraft }[] {
  const watches = listWatches();
  if (watches.length === 0) return [];
  const now = Date.now();
  const hits: { watch: WatchRow; aircraft: Aircraft }[] = [];
  for (const w of watches) {
    if (w.expires_at && w.expires_at < now) continue;
    for (const ac of aircraft) {
      const cs = (ac.flight ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!cs) continue;
      if (cs !== w.callsign) continue;
      // De-dupe: if the watch already fired against this exact hex, skip.
      // (re-fires only when a different airframe matches or the user
      // clears the fired state via the UI).
      if (w.fired_hex === ac.hex) continue;
      fireStmt.run({ id: w.id, fired_at: now, fired_hex: ac.hex });
      hits.push({ watch: { ...w, fired_at: now, fired_hex: ac.hex }, aircraft: ac });
    }
  }
  return hits;
}
