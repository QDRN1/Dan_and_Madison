import { useEffect, useState } from "react";
import "./radar.css";
import { api } from "../api";
import { useRadar } from "../store";
import { MapView } from "./MapView";
import { AircraftDetail } from "./AircraftDetail";
import { FlightList } from "./FlightList";
import { StatsPanel } from "./StatsPanel";
import { Settings } from "./Settings";
import { ThemeToggle } from "./ThemeToggle";

type Panel = "flights" | "stats" | "settings";

export function RadarView(): JSX.Element {
  const config = useRadar((s) => s.config);
  const count = useRadar((s) => s.aircraft.filter((a) => a.lat != null).length);
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
        <div className="live glass">
          <span className="dot" /> {count} <span className="muted" style={{ fontWeight: 600 }}>tracking</span>
        </div>
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
          {(["flights", "stats", "settings"] as const).map((p) => (
            <button key={p} className={`tab${panel === p ? " active" : ""}`} onClick={() => setPanel(p)}>
              {p === "flights" ? "Flights" : p === "stats" ? "Stats" : "Settings"}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {panel === "flights" && <FlightList />}
          {panel === "stats" && <StatsPanel />}
          {panel === "settings" && <Settings />}
        </div>
      </aside>

      <AircraftDetail />
    </div>
  );
}

/** Persistent status row at the top of the menu drawer: local date + 12-hour
 *  time, and the Pi's SoC temp in °F. Stays visible across all tabs. */
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
  const hot = tempF != null && tempF >= 140;

  return (
    <div className="drawer-status">
      <span className="drawer-status-when">{dateStr} · {timeStr}</span>
      {tempF != null && (
        <span className="drawer-status-temp" style={{ color: hot ? "var(--danger)" : "var(--muted)" }}>
          CPU {tempF}°F{hot ? " 🔥" : ""}
        </span>
      )}
    </div>
  );
}
