import { useState } from "react";
import "./radar.css";
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
          <span className="drawer-title">Menu</span>
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
