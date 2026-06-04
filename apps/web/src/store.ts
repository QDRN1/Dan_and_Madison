import { create } from "zustand";
import type { Aircraft, FlightWatchHit, LiveSnapshot, PublicConfig, SightingScope, SightingSort, TrailPoint } from "@qdrn/shared";

export type LiveStatus = "connecting" | "live" | "stale" | "offline";
export type Theme = "light" | "dark";
export type IconTheme = "plane" | "paw" | "heart" | "ufo";

export type PopoutKind = "in-view" | "sightings" | "farthest";

/** When the user drills into a stat card we open a full-screen popout. State
 *  lives in the store so the popout mounts at the root of RadarView (outside
 *  the drawer's transformed bounds) and `onBack` returns to whichever drawer
 *  view spawned it. */
export interface PopoutState {
  kind: PopoutKind;
  scope?: SightingScope;
  sort?: SightingSort;
  title?: string;
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("qdrn-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return "light"; // default light
}

function initialIconTheme(): IconTheme {
  try {
    const saved = localStorage.getItem("qdrn-icon-theme");
    if (saved === "plane" || saved === "paw" || saved === "heart" || saved === "ufo") return saved;
  } catch {
    /* ignore */
  }
  return "plane";
}

function initialStorm(): boolean {
  try { return localStorage.getItem("qdrn-storm") === "1"; } catch { return false; }
}

interface RadarState {
  config: PublicConfig | null;
  aircraft: Aircraft[];
  byHex: Record<string, Aircraft>;
  now: number;
  messageRate: number;
  selectedHex: string | null;
  selectedTrail: TrailPoint[] | null;
  theme: Theme;
  iconTheme: IconTheme;
  stormOverlay: boolean;
  popout: PopoutState | null;
  liveStatus: LiveStatus;
  /** Most recent flight-watch hit, surfaced as a big alert until dismissed. */
  watchHit: FlightWatchHit | null;
  /** Drawer state lifted out of RadarView so the walkthrough engine can
   *  open it imperatively during the tour. */
  drawerOpen: boolean;
  drawerPanel: "flights" | "stats" | "achievements" | "settings";
  /** Walkthrough engine state. Steps live in a separate module. */
  tourStep: number | null;
  setConfig: (c: PublicConfig) => void;
  setLiveStatus: (s: LiveStatus) => void;
  setWatchHit: (h: FlightWatchHit | null) => void;
  setDrawerOpen: (b: boolean) => void;
  setDrawerPanel: (p: "flights" | "stats" | "achievements" | "settings") => void;
  startTour: () => void;
  endTour: () => void;
  nextTourStep: () => void;
  prevTourStep: () => void;
  applySnapshot: (s: LiveSnapshot) => void;
  select: (hex: string | null) => void;
  setSelectedTrail: (t: TrailPoint[] | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setIconTheme: (t: IconTheme) => void;
  toggleStorm: () => void;
  openPopout: (p: PopoutState) => void;
  closePopout: () => void;
  selected: () => Aircraft | null;
}

export const useRadar = create<RadarState>((set, get) => ({
  config: null,
  aircraft: [],
  byHex: {},
  now: Date.now(),
  messageRate: 0,
  selectedHex: null,
  selectedTrail: null,
  theme: initialTheme(),
  iconTheme: initialIconTheme(),
  stormOverlay: initialStorm(),
  popout: null,
  liveStatus: "connecting",
  watchHit: null,
  drawerOpen: false,
  drawerPanel: "flights",
  tourStep: null,

  setConfig: (config) => set({ config }),
  setLiveStatus: (liveStatus) => set({ liveStatus }),
  setWatchHit: (watchHit) => set({ watchHit }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setDrawerPanel: (drawerPanel) => set({ drawerPanel }),
  startTour: () => set({ tourStep: 0 }),
  endTour: () => set({ tourStep: null }),
  nextTourStep: () => set((s) => ({ tourStep: s.tourStep == null ? 0 : s.tourStep + 1 })),
  prevTourStep: () => set((s) => ({ tourStep: s.tourStep != null && s.tourStep > 0 ? s.tourStep - 1 : 0 })),

  applySnapshot: (s) => {
    const byHex: Record<string, Aircraft> = {};
    for (const a of s.aircraft) byHex[a.hex] = a;
    set({ aircraft: s.aircraft, byHex, now: s.now, messageRate: s.messageRate ?? 0 });
  },

  select: (selectedHex) => set({ selectedHex, selectedTrail: null }),
  setSelectedTrail: (selectedTrail) => set({ selectedTrail }),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  setIconTheme: (iconTheme) => {
    try { localStorage.setItem("qdrn-icon-theme", iconTheme); } catch { /* ignore */ }
    set({ iconTheme });
  },
  toggleStorm: () => set((s) => {
    const next = !s.stormOverlay;
    try { localStorage.setItem("qdrn-storm", next ? "1" : "0"); } catch { /* ignore */ }
    return { stormOverlay: next };
  }),
  openPopout: (popout) => set({ popout }),
  closePopout: () => set({ popout: null }),
  selected: () => {
    const { selectedHex, byHex } = get();
    return selectedHex ? byHex[selectedHex] ?? null : null;
  },
}));
