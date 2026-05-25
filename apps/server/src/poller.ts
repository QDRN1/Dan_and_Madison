import { EventEmitter } from "node:events";
import type { Aircraft, LiveSnapshot, TrailPoint } from "@qdrn/shared";
import { AIRCRAFT_JSON_URL, POLL_INTERVAL_MS, getReceiver } from "./config.js";
import { enrich } from "./enrichment.js";
import { bearing, distanceNm } from "./geo.js";
import { isFlagged, recordSighting } from "./stats.js";

const TRAIL_MAX_POINTS = 250;
const TRAIL_MAX_AGE_MS = 45 * 60 * 1000;
const TRAIL_MIN_GAP_MS = 2000;

/** Raw aircraft entry shape from readsb/ultrafeeder aircraft.json. */
interface RawAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
  rssi?: number;
  seen?: number;
}

class AircraftStore extends EventEmitter {
  private aircraft = new Map<string, Aircraft>();
  private trails = new Map<string, TrailPoint[]>();
  // Callsign each aircraft was last enriched for, so we re-enrich once the
  // callsign is decoded (it often appears a few ticks after first contact).
  private enrichedFor = new Map<string, string>();
  private messageRate = 0;
  private timer?: NodeJS.Timeout;
  private lastNow = 0;

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.poll();
    };
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getSnapshot(): LiveSnapshot {
    const receiver = getReceiver();
    return {
      now: this.lastNow || Date.now(),
      aircraft: [...this.aircraft.values()].filter((a) => a.lat != null && a.lon != null),
      messageRate: this.messageRate,
      receiver,
    };
  }

  get(hex: string): Aircraft | undefined {
    return this.aircraft.get(hex);
  }

  /** Drop attached enrichment so every aircraft re-enriches on the next poll
   *  (used after an API key change so new sources apply right away). */
  resetEnrichment(): void {
    for (const ac of this.aircraft.values()) ac.enrichment = undefined;
    this.enrichedFor.clear();
  }

  getTrail(hex: string): TrailPoint[] {
    return this.trails.get(hex) ?? [];
  }

  private recordTrail(ac: Aircraft, now: number): void {
    if (ac.lat == null || ac.lon == null) return;
    const alt = ac.altBaro === "ground" ? null : typeof ac.altBaro === "number" ? ac.altBaro : ac.altGeom ?? null;
    let pts = this.trails.get(ac.hex);
    if (!pts) {
      pts = [];
      this.trails.set(ac.hex, pts);
    }
    const last = pts[pts.length - 1];
    if (last && now - last.t < TRAIL_MIN_GAP_MS && last.lat === ac.lat && last.lon === ac.lon) return;
    pts.push({ lon: ac.lon, lat: ac.lat, alt, t: now });
    // Trim by count and age.
    const cutoff = now - TRAIL_MAX_AGE_MS;
    while (pts.length > TRAIL_MAX_POINTS || (pts.length > 0 && pts[0]!.t < cutoff)) pts.shift();
  }

  private async poll(): Promise<void> {
    const data = await this.fetchData();
    if (!data) return;

    const receiver = getReceiver();
    const now = (typeof data.now === "number" ? data.now * 1000 : Date.now());
    this.lastNow = now;
    this.messageRate = typeof data.messages === "number" ? data.messages : this.messageRate;

    const seen = new Set<string>();
    const list: RawAircraft[] = Array.isArray(data.aircraft) ? data.aircraft : [];

    for (const raw of list) {
      if (!raw.hex) continue;
      const hex = raw.hex.toLowerCase().replace(/^~/, ""); // ~ = TIS-B/non-ICAO
      seen.add(hex);

      const prev = this.aircraft.get(hex);
      const ac: Aircraft = {
        hex,
        flight: raw.flight?.trim() || prev?.flight,
        lat: raw.lat ?? prev?.lat,
        lon: raw.lon ?? prev?.lon,
        altBaro: raw.alt_baro ?? prev?.altBaro,
        altGeom: raw.alt_geom ?? prev?.altGeom,
        gs: raw.gs ?? prev?.gs,
        track: raw.track ?? prev?.track,
        baroRate: raw.baro_rate ?? prev?.baroRate,
        squawk: raw.squawk ?? prev?.squawk,
        category: raw.category ?? prev?.category,
        rssi: raw.rssi ?? prev?.rssi,
        seen: raw.seen,
        enrichment: prev?.enrichment,
      };

      if (ac.lat != null && ac.lon != null) {
        ac.distNm = Math.round(distanceNm(receiver.lat, receiver.lon, ac.lat, ac.lon) * 10) / 10;
        ac.bearing = Math.round(bearing(receiver.lat, receiver.lon, ac.lat, ac.lon));
      }
      ac.flagged = isFlagged(ac);

      this.aircraft.set(hex, ac);

      // Enrich on first contact, then re-enrich once a callsign is decoded so
      // the route (which needs the callsign) gets filled in. Cheap: cached + deduped.
      const cs = ac.flight ?? "";
      const lacksRoute = !ac.enrichment || (!ac.enrichment.route && cs.length > 0);
      if (lacksRoute && this.enrichedFor.get(hex) !== cs) {
        this.enrichedFor.set(hex, cs);
        void enrich(hex, ac.flight).then((e) => {
          if (!e) return;
          const cur = this.aircraft.get(hex);
          if (cur) cur.enrichment = e;
        });
      }

      // Record for stats + trail once we have a position.
      if (ac.lat != null && ac.lon != null) {
        recordSighting(ac);
        this.recordTrail(ac, now);
      }
    }

    // Drop aircraft we haven't seen recently (stale > 60s).
    for (const [hex, ac] of this.aircraft) {
      if (!seen.has(hex) && (ac.seen ?? 0) > 60) {
        this.aircraft.delete(hex);
        this.trails.delete(hex);
        this.enrichedFor.delete(hex);
      }
    }

    this.emit("snapshot", this.getSnapshot());
  }

  private async fetchData(): Promise<{ now?: number; messages?: number; aircraft?: RawAircraft[] } | undefined> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), POLL_INTERVAL_MS * 2);
      const res = await fetch(AIRCRAFT_JSON_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return undefined;
      return (await res.json()) as any;
    } catch {
      return undefined;
    }
  }
}

export const store = new AircraftStore();
