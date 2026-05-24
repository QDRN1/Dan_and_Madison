import { useState } from "react";
import "./radar.css";
import { BASE } from "../api";
import { useRadar } from "../store";
import { MapView } from "./MapView";
import { AircraftDetail } from "./AircraftDetail";
import { FlightList } from "./FlightList";
import { StatsPanel } from "./StatsPanel";

type Tab = "none" | "flights" | "stats";

export function RadarView(): JSX.Element {
  const config = useRadar((s) => s.config);
  const count = useRadar((s) => s.aircraft.filter((a) => a.lat != null).length);
  const [tab, setTab] = useState<Tab>("none");

  const brand = config?.brand;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <MapView />

      <header className="topbar">
        <div className="brand">
          {brand?.logoUrl && <img src={brand.logoUrl} alt="QDRN" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <div className="brand-text">
            <div className="name">{brand?.name ?? "QDRN Radar"}</div>
            <div className="tag">{config?.receiver.city ? `Live over ${config.receiver.city}` : brand?.tagline}</div>
          </div>
        </div>
        <div className="spacer" />
        <div className="live glass">
          <span className="dot" /> {count} <span className="muted" style={{ fontWeight: 600 }}>tracking</span>
        </div>
        <button
          className={`iconbtn glass${tab === "flights" ? " active" : ""}`}
          onClick={() => setTab(tab === "flights" ? "none" : "flights")}
          aria-label="Flight list"
          title="Flight list"
        >
          ☰
        </button>
        <button
          className={`iconbtn glass${tab === "stats" ? " active" : ""}`}
          onClick={() => setTab(tab === "stats" ? "none" : "stats")}
          aria-label="Stats"
          title="Stats"
        >
          ▦
        </button>
      </header>

      <aside className={`drawer glass${tab !== "none" ? " open" : ""}`}>
        {tab !== "none" && (
          <button className="iconbtn glass drawer-close" onClick={() => setTab("none")} aria-label="Close">
            ✕
          </button>
        )}
        <div className="drawer-tabs">
          <button className={`tab${tab === "flights" ? " active" : ""}`} onClick={() => setTab("flights")}>
            Flights
          </button>
          <button className={`tab${tab === "stats" ? " active" : ""}`} onClick={() => setTab("stats")}>
            Stats
          </button>
        </div>
        {tab === "flights" && <FlightList />}
        {tab === "stats" && <StatsPanel />}
      </aside>

      <AircraftDetail />

      <a className="setup-link" href={`${BASE}/setup`}>
        ⚙ Device setup
      </a>
    </div>
  );
}
