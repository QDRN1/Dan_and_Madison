import type { Aircraft } from "@qdrn/shared";

export function altFeet(a: Aircraft): number | null {
  if (a.altBaro === "ground") return 0;
  if (typeof a.altBaro === "number") return a.altBaro;
  if (typeof a.altGeom === "number") return a.altGeom;
  return null;
}

/** Color ramp by altitude (feet) — low=warm, high=cool. */
export function altColor(ft: number | null): string {
  if (ft == null) return "#9fb0c9";
  const stops: [number, string][] = [
    [0, "#ff4d4d"],
    [10000, "#ffb300"],
    [20000, "#a3c940"],
    [30000, "#5b8def"],
    [40000, "#b06bff"],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a0, c0] = stops[i]!;
    const [a1, c1] = stops[i + 1]!;
    if (ft <= a1) return lerpColor(c0, c1, (ft - a0) / (a1 - a0));
  }
  return stops[stops.length - 1]![1];
}

function lerpColor(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * tt);
  const g = Math.round(ag + (bg - ag) * tt);
  const bl = Math.round(ab + (bb - ab) * tt);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

export function fmtAlt(a: Aircraft): string {
  if (a.altBaro === "ground") return "On ground";
  const ft = altFeet(a);
  return ft == null ? "—" : `${ft.toLocaleString()} ft`;
}

export function fmtSpeed(a: Aircraft): string {
  return a.gs == null ? "—" : `${Math.round(a.gs)} kt`;
}

export function fmtVert(a: Aircraft): string {
  if (a.baroRate == null) return "level";
  if (Math.abs(a.baroRate) < 100) return "level";
  const arrow = a.baroRate > 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(Math.round(a.baroRate))} fpm`;
}

export function fmtTrack(a: Aircraft): string {
  if (a.track == null) return "—";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const d = dirs[Math.round(a.track / 45) % 8];
  return `${Math.round(a.track)}° ${d}`;
}

export function label(a: Aircraft): string {
  return a.flight?.trim() || a.enrichment?.registration || a.hex.toUpperCase();
}
