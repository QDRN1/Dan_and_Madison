import { EventEmitter } from "node:events";
import type { Aircraft, LiveSnapshot } from "@qdrn/shared";
import { AIRCRAFT_JSON_URL, POLL_INTERVAL_MS, getReceiver } from "./config.js";
import { enrich } from "./enrichment.js";
import { bearing, distanceNm } from "./geo.js";
import { isFlagged, recordSighting } from "./stats.js";

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

      // Kick off enrichment for anything not yet enriched (cheap; cached + deduped).
      if (!ac.enrichment) {
        void enrich(hex, ac.flight).then((e) => {
          if (!e) return;
          const cur = this.aircraft.get(hex);
          if (cur) cur.enrichment = e;
        });
      }

      // Record for stats once we have a position.
      if (ac.lat != null && ac.lon != null) recordSighting(ac);
    }

    // Drop aircraft we haven't seen recently (stale > 60s).
    for (const [hex, ac] of this.aircraft) {
      if (!seen.has(hex) && (ac.seen ?? 0) > 60) this.aircraft.delete(hex);
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
