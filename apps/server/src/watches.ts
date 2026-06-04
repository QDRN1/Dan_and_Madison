import type { Aircraft } from "@qdrn/shared";
import { TIMEZONE } from "./config.js";
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

/** Cheap input validation — catches the obvious garbage ("ASDF", "12345",
 *  "Dan's flight") without being so strict it rejects legitimate edge
 *  cases (military designators, ferry callsigns, N-numbers). Real
 *  callsigns: 2-3 letter airline prefix + 1-5 digits + optional 1-2
 *  trailing letters, OR N-numbers (US private), OR military patterns. */
export function validateCallsign(raw: string): { ok: true; normalized: string } | { ok: false; error: string } {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!s) return { ok: false, error: "Callsign is empty." };
  if (s.length > 8) return { ok: false, error: "Callsign too long (max 8 characters)." };
  if (!/^[A-Z0-9-]+$/.test(s)) {
    return { ok: false, error: "Only letters, numbers and dashes allowed." };
  }
  if (!/[A-Z]/.test(s) || !/[0-9]/.test(s)) {
    return { ok: false, error: "Needs letters and numbers (e.g. DL2864, AAL100, N123AB)." };
  }
  // Common shapes: airline (2-3 letters + digits + optional 1-2 trailing
  // letters), N-number (N + digits + optional letters), military (letters/
  // digits mix). The last regex is permissive.
  const airline = /^[A-Z]{2,3}\d{1,5}[A-Z]{0,2}$/;
  const nNumber = /^N\d{1,5}[A-Z]{0,2}$/;
  const military = /^[A-Z]{2,5}\d{1,4}[A-Z]?$/;
  if (!airline.test(s) && !nNumber.test(s) && !military.test(s)) {
    return { ok: false, error: "Doesn't look like an airline callsign or tail number." };
  }
  return { ok: true, normalized: normalizeCallsign(s) };
}

export interface WatchRow {
  id: number;
  callsign: string;      // normalized
  raw_input: string;
  name: string | null;
  flight_date: string | null; // YYYY-MM-DD or null = any date
  note: string | null;
  created_at: number;
  expires_at: number | null;
  fired_at: number | null;
  fired_hex: string | null;
}

const listStmt = db.prepare(`SELECT * FROM watches ORDER BY created_at DESC`);
const insertStmt = db.prepare(
  `INSERT INTO watches (callsign, raw_input, name, flight_date, note, created_at, expires_at)
   VALUES (@callsign, @raw_input, @name, @flight_date, @note, @created_at, @expires_at)`,
);
const removeStmt = db.prepare(`DELETE FROM watches WHERE id = ?`);
const fireStmt = db.prepare(
  `UPDATE watches SET fired_at = @fired_at, fired_hex = @fired_hex WHERE id = @id`,
);
const clearFiredStmt = db.prepare(`UPDATE watches SET fired_at = NULL, fired_hex = NULL WHERE id = ?`);

/** Day key in the configured timezone — same format as flight_date. */
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
function dayKey(d: Date): string { return dayFmt.format(d); }

export function listWatches(): WatchRow[] {
  return listStmt.all() as WatchRow[];
}

export function addWatch(input: {
  raw: string; name?: string; flightDate?: string; note?: string; expiresAt?: number;
}): WatchRow {
  const check = validateCallsign(input.raw);
  if (!check.ok) throw new Error(check.error);
  const callsign = check.normalized;
  // Validate the date if provided (YYYY-MM-DD)
  if (input.flightDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.flightDate)) {
    throw new Error("flight_date must be YYYY-MM-DD");
  }
  const r = insertStmt.run({
    callsign,
    raw_input: input.raw.trim(),
    name: input.name?.trim() || null,
    flight_date: input.flightDate ?? null,
    note: input.note ?? null,
    created_at: Date.now(),
    expires_at: input.expiresAt ?? null,
  });
  return listStmt.all().find((w) => (w as WatchRow).id === Number(r.lastInsertRowid)) as WatchRow;
}

export function removeWatch(id: number): void {
  removeStmt.run(id);
}

export function clearWatchFire(id: number): void {
  clearFiredStmt.run(id);
}

/** True if the watch's flight_date is null or within ±1 day of "today" in
 *  the configured timezone. The ±1 buffer covers late departures crossing
 *  midnight and lets people add a watch the night before. */
function dateMatchesToday(w: WatchRow, now: Date): boolean {
  if (!w.flight_date) return true;
  const today = dayKey(now);
  if (w.flight_date === today) return true;
  const day = 86_400_000;
  return w.flight_date === dayKey(new Date(now.getTime() - day))
      || w.flight_date === dayKey(new Date(now.getTime() + day));
}

/** Scan the current aircraft snapshot against the watch list. Returns
 *  newly-matching watches (callsign hit + not already fired against this hex
 *  + date in window). Caller dispatches the alert + persists the fire. */
export function checkWatches(aircraft: Aircraft[]): { watch: WatchRow; aircraft: Aircraft }[] {
  const watches = listWatches();
  if (watches.length === 0) return [];
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const hits: { watch: WatchRow; aircraft: Aircraft }[] = [];
  for (const w of watches) {
    if (w.expires_at && w.expires_at < nowMs) continue;
    if (!dateMatchesToday(w, nowDate)) continue;
    for (const ac of aircraft) {
      const cs = (ac.flight ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!cs) continue;
      if (cs !== w.callsign) continue;
      // De-dupe: if the watch already fired against this exact hex, skip.
      if (w.fired_hex === ac.hex) continue;
      fireStmt.run({ id: w.id, fired_at: nowMs, fired_hex: ac.hex });
      hits.push({ watch: { ...w, fired_at: nowMs, fired_hex: ac.hex }, aircraft: ac });
    }
  }
  return hits;
}
