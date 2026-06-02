import { useEffect } from "react";
import { useRadar } from "../store";

/** Big celebratory banner that pops at the top of the screen when a flight
 *  the user is watching enters the radar. Click to dismiss (the matched
 *  plane is already selected on the map by App.tsx). Persists until the
 *  user acknowledges so a missed glance doesn't miss the alert. */
export function WatchAlert(): JSX.Element | null {
  const hit = useRadar((s) => s.watchHit);
  const setWatchHit = useRadar((s) => s.setWatchHit);
  const select = useRadar((s) => s.select);

  useEffect(() => {
    if (!hit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWatchHit(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hit, setWatchHit]);

  if (!hit) return null;
  const { watch, aircraft } = hit;
  const operator = aircraft.enrichment?.operator;
  const type = aircraft.enrichment?.typeName ?? aircraft.enrichment?.typeCode;
  const route = aircraft.enrichment?.route;
  const origin = route?.origin?.iata || route?.origin?.icao;
  const dest = route?.destination?.iata || route?.destination?.icao;

  // Headline goes "Dan's flight is in view!" when a name was set, otherwise
  // falls back to the raw callsign so anonymous watches still read right.
  const headline = watch.name ? `${watch.name} is in view!` : `${watch.raw_input.toUpperCase()} is in view!`;
  return (
    <div className="watch-alert" role="alert" onClick={() => { select(aircraft.hex); setWatchHit(null); }}>
      <div className="watch-alert-icon">🎯</div>
      <div className="watch-alert-text">
        <div className="watch-alert-title">{headline}</div>
        <div className="watch-alert-sub">
          {[watch.name ? watch.raw_input.toUpperCase() : null, operator, type,
            origin && dest ? `${origin} → ${dest}` : null,
            aircraft.distNm != null ? `${aircraft.distNm} nm` : null]
            .filter(Boolean).join(" · ")}
        </div>
      </div>
      <button
        className="iconbtn"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); setWatchHit(null); }}
      >
        ✕
      </button>
    </div>
  );
}
