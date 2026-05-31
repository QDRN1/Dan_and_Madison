import { useEffect, useState } from "react";
import "./radar.css";
import { api } from "../api";
import { useRadar } from "../store";
import { MapView } from "./MapView";
import { AircraftDetail } from "./AircraftDetail";
import { AchievementsPanel } from "./AchievementsPanel";
import { FactBanner } from "./FactBanner";
import { FlightList } from "./FlightList";
import { StatsPanel } from "./StatsPanel";
import { AltitudeLegend } from "./AltitudeLegend";
import { SeasonalOverlay } from "./SeasonalOverlay";
import { Settings } from "./Settings";
import { SightingsPopout } from "./SightingsPopout";
import { ThemeToggle } from "./ThemeToggle";
import { Toasts } from "./Toasts";

type Panel = "flights" | "stats" | "achievements" | "settings";

export function RadarView(): JSX.Element {
  const config = useRadar((s) => s.config);
  // Counting separately avoids re-rendering the entire topbar every snapshot
  // when only the live count changes.
  const stormOn = useRadar((s) => s.stormOverlay);
  const toggleStorm = useRadar((s) => s.toggleStorm);
  const openPopout = useRadar((s) => s.openPopout);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("flights");

  const brand = config?.brand;
  const rx = config?.receiver;
  const pilot = config?.pilotName?.trim();
  const cityLine = rx?.city ? `${rx.city}${rx.county ? ` (${rx.county})` : ""}` : "";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <MapView />

      <header className="topbar">
        <div className="brand">
          <span className="brand-plate">
            {brand?.logoUrl && <img src={brand.logoUrl} alt={brand?.name ?? "QDRN Radar"} onError={(e) => (e.currentTarget.style.display = "none")} />}
          </span>
          <div className="brand-text">
            <span className="brand-greeting">{pilot ? `Hello Pilot, ${pilot}` : "Hello Pilot!"}</span>
            {cityLine && <span className="brand-sub">Live over {cityLine}</span>}
            {rx?.artcc && <span className="brand-artcc">{rx.artcc.name} Center ({rx.artcc.id})</span>}
          </div>
        </div>
        <div className="spacer" />
        <LiveCountPill onClick={() => openPopout({ kind: "in-view", title: "Tracking now" })} />
        <button
          className={`iconbtn glass${stormOn ? " active" : ""}`}
          onClick={toggleStorm}
          aria-label="Storm radar"
          title={stormOn ? "Storm radar on (tap to hide)" : "Show storm radar (zooms to area view)"}
        >
          {stormOn ? "⛈️" : "🌦️"}
        </button>
        <ThemeToggle className="glass" />
        <button
          className={`iconbtn glass${open ? " active" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
          title="Menu"
        >
          ☰
        </button>
      </header>

      <aside className={`drawer glass${open ? " open" : ""}`}>
        <div className="drawer-head">
          <span style={{ width: 42, flex: "0 0 auto" }} />
          <DrawerStatus />
          <button className="iconbtn" onClick={() => setOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>

        <div className="drawer-tabs">
          {(["flights", "stats", "achievements", "settings"] as const).map((p) => (
            <button key={p} className={`tab${panel === p ? " active" : ""}`} onClick={() => setPanel(p)} title={p}>
              {p === "flights" ? "Flights" : p === "stats" ? "Stats" : p === "achievements" ? "🏆" : "Settings"}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {panel === "flights" && <FlightList />}
          {panel === "stats" && <StatsPanel />}
          {panel === "achievements" && <AchievementsPanel />}
          {panel === "settings" && <Settings />}
        </div>
      </aside>

      <AircraftDetail />
      <FactBanner />
      <SeasonalOverlay />
      <Toasts />
      <SightingsPopout />
      <AltitudeLegendWrapper />
    </div>
  );
}

/** Persistent status row at the top of the menu drawer: local date + 12-hour
 *  time, and the Pi's SoC temp in °F. Stays visible across all tabs. */
function AltitudeLegendWrapper(): JSX.Element {
  const selected = useRadar((s) => s.selectedHex);
  // Tuck the legend away while a plane's detail card is on screen — the
  // card is the same color information in context, and the legend would
  // crowd the bottom edge on phones.
  return <AltitudeLegend hidden={!!selected} />;
}

/** Live tracking count pill in the topbar. Selectors are scoped to the count
 *  itself so other topbar UI doesn't re-render on every snapshot. Clicking it
 *  opens the In view popout. */
function LiveCountPill({ onClick }: { onClick: () => void }): JSX.Element {
  const count = useRadar((s) => s.aircraft.filter((a) => a.lat != null).length);
  return (
    <button className="live glass live-pill" onClick={onClick} title="Show all aircraft in view" type="button">
      <span className="dot" /> {count} <span className="muted" style={{ fontWeight: 600 }}>tracking</span>
    </button>
  );
}

function DrawerStatus(): JSX.Element {
  const [now, setNow] = useState(new Date());
  const [tempC, setTempC] = useState<number | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => api.stats().then((s) => alive && setTempC(s.cpuTempC ?? null)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const dateStr = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
  const heat = describeHeat(tempF);

  return (
    <div className="drawer-status">
      <span className="drawer-status-when">{dateStr} · {timeStr}</span>
      {tempF != null && (
        <span
          className="drawer-status-temp"
          style={{ color: heat.color }}
          title={heat.hint}
        >
          CPU {tempF}°F{heat.emoji ? ` ${heat.emoji}` : ""}{heat.label ? ` · ${heat.label}` : ""}
        </span>
      )}
    </div>
  );
}

/** Map Pi CPU temp (°F) to a one-line vibe-check. Crosses into the danger zone
 *  above ~170°F where throttling kicks in on a Pi 4/5. */
function describeHeat(tempF: number | null): { emoji: string; label: string; color: string; hint: string } {
  if (tempF == null) return { emoji: "", label: "", color: "var(--muted)", hint: "" };
  if (tempF >= 185) return { emoji: "🚨", label: "lava mode",      color: "var(--danger)", hint: "Throttling — give the Pi some air." };
  if (tempF >= 175) return { emoji: "🔥", label: "working overtime", color: "var(--danger)", hint: "It's working overtime — maybe pop a fan in." };
  if (tempF >= 160) return { emoji: "🥵", label: "toasty",         color: "var(--danger)", hint: "Toasty. Watch for throttling above 175°F." };
  if (tempF >= 140) return { emoji: "♨️", label: "warm",           color: "#e0a83e",       hint: "Warm and happy." };
  if (tempF <= 60)  return { emoji: "🧊", label: "chilly",         color: "var(--accent)", hint: "Cooler than a hangar fridge." };
  return { emoji: "", label: "", color: "var(--muted)", hint: "" };
}
