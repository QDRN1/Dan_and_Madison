import { useState } from "react";
import "./radar.css";
import { BASE } from "../api";
import { useRadar } from "../store";
import { MapView } from "./MapView";
import { AircraftDetail } from "./AircraftDetail";
import { FlightList } from "./FlightList";
import { StatsPanel } from "./StatsPanel";
import { ThemeToggle } from "./ThemeToggle";

type Panel = "flights" | "stats";

export function RadarView(): JSX.Element {
  const config = useRadar((s) => s.config);
  const count = useRadar((s) => s.aircraft.filter((a) => a.lat != null).length);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("flights");

  const brand = config?.brand;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <MapView />

      <header className="topbar">
        <div className="brand">
          <span className="brand-plate">
            {brand?.logoUrl && <img src={brand.logoUrl} alt={brand?.name ?? "QDRN Radar"} onError={(e) => (e.currentTarget.style.display = "none")} />}
          </span>
          {config?.receiver.city && <span className="brand-sub">Live over {config.receiver.city}</span>}
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
          <span className="drawer-title">Menu</span>
          <button className="iconbtn" onClick={() => setOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>

        <div className="drawer-tabs">
          <button className={`tab${panel === "flights" ? " active" : ""}`} onClick={() => setPanel("flights")}>
            Flights
          </button>
          <button className={`tab${panel === "stats" ? " active" : ""}`} onClick={() => setPanel("stats")}>
            Stats
          </button>
        </div>

        <div className="drawer-body scroll">
          {panel === "flights" && <FlightList />}
          {panel === "stats" && <StatsPanel />}
        </div>

        <nav className="menu-links">
          <a className="menu-link" href={`${BASE}/setup`}>
            <span>⚙</span> Device setup
          </a>
          <a className="menu-link" href={`${BASE}/admin`}>
            <span>🛡</span> Super admin
          </a>
        </nav>
      </aside>

      <AircraftDetail />
    </div>
  );
}
