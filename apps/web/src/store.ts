import { create } from "zustand";
import type { Aircraft, AircraftClass, FlightWatchHit, LiveSnapshot, PublicConfig, SightingScope, SightingSort, TrailPoint } from "@qdrn/shared";

export type LiveStatus = "connecting" | "live" | "stale" | "offline";
export type Theme = "light" | "dark";
export type IconTheme = "plane" | "paw" | "heart" | "ufo";

export type PopoutKind = "in-view" | "sightings" | "farthest" | "notable";

export interface UpdateJob {
  /** Wall-clock ms when the job started — drives the big elapsed timer. */
  startedAt: number;
  /** Current short-form status, e.g. "Pulling code…", "Building…", "Waiting for radar to come back…". */
  phase: string;
  /** Build SHA the radar was running BEFORE the update. Used to detect
   *  when the new container has come up (server returns a different SHA). */
  oldSha: string | null;
  /** Set if something went wrong — overlay flips to error mode. */
  error?: string;
}

/** When the user drills into a stat card we open a full-screen popout. State
 *  lives in the store so the popout mounts at the root of RadarView (outside
 *  the drawer's transformed bounds) and `onBack` returns to whichever drawer
 *  view spawned it. */
export interface PopoutState {
  kind: PopoutKind;
  scope?: SightingScope;
  sort?: SightingSort;
  title?: string;
  /** Pre-filled airline filter (e.g. clicking a row in "Top operators today"
   *  opens the sightings popout already filtered to that operator). */
  airline?: string;
  /** Pre-filled search query (e.g. clicking a row in "Top aircraft types"). */
  q?: string;
  /** Pre-filled aircraft class filter (commercial / cargo / private /
   *  military / helicopter / other). Drives the popout's class dropdown
   *  and the server-side sightings query. */
  klass?: AircraftClass;
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

/** Persisted set of aircraft classes the user has hidden from the live view.
 *  Empty by default — all aircraft visible. */
function initialHiddenClasses(): Set<AircraftClass> {
  try {
    const raw = localStorage.getItem("qdrn-hidden-classes");
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as AircraftClass[]);
  } catch { return new Set(); }
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
  hiddenClasses: Set<AircraftClass>;
  toggleHiddenClass: (k: AircraftClass) => void;
  /** Active "Pull update + restart" job. Non-null = the full-screen
   *  UpdateOverlay is up, showing a live elapsed timer and the current
   *  phase. The Settings card kicks it off and polls device-info to
   *  decide when to reload. */
  updateJob: UpdateJob | null;
  setUpdateJob: (j: UpdateJob | null) => void;
  setUpdatePhase: (phase: string) => void;
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
  drawerPanel: "stats",
  hiddenClasses: initialHiddenClasses(),
  updateJob: null,
  tourStep: null,

  setConfig: (config) => set({ config }),
  setLiveStatus: (liveStatus) => set({ liveStatus }),
  setWatchHit: (watchHit) => set({ watchHit }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setDrawerPanel: (drawerPanel) => set({ drawerPanel }),
  toggleHiddenClass: (k) => set((s) => {
    const next = new Set(s.hiddenClasses);
    if (next.has(k)) next.delete(k); else next.add(k);
    try { localStorage.setItem("qdrn-hidden-classes", JSON.stringify([...next])); } catch { /* ignore */ }
    return { hiddenClasses: next };
  }),
  setUpdateJob: (updateJob) => set({ updateJob }),
  setUpdatePhase: (phase) => set((s) => (s.updateJob ? { updateJob: { ...s.updateJob, phase } } : {})),
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
  setTheme: (theme) => {
    try { localStorage.setItem("qdrn-theme", theme); } catch { /* ignore */ }
    set({ theme });
  },
  toggleTheme: () => set((s) => {
    const next: Theme = s.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("qdrn-theme", next); } catch { /* ignore */ }
    return { theme: next };
  }),
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
