import { create } from "zustand";
import type { Aircraft, LiveSnapshot, PublicConfig, TrailPoint } from "@qdrn/shared";

export type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("qdrn-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return "light"; // default light
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
  setConfig: (c: PublicConfig) => void;
  applySnapshot: (s: LiveSnapshot) => void;
  select: (hex: string | null) => void;
  setSelectedTrail: (t: TrailPoint[] | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
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

  setConfig: (config) => set({ config }),

  applySnapshot: (s) => {
    const byHex: Record<string, Aircraft> = {};
    for (const a of s.aircraft) byHex[a.hex] = a;
    set({ aircraft: s.aircraft, byHex, now: s.now, messageRate: s.messageRate ?? 0 });
  },

  select: (selectedHex) => set({ selectedHex, selectedTrail: null }),
  setSelectedTrail: (selectedTrail) => set({ selectedTrail }),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  selected: () => {
    const { selectedHex, byHex } = get();
    return selectedHex ? byHex[selectedHex] ?? null : null;
  },
}));
