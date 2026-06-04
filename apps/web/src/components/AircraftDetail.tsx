import { useEffect, useState } from "react";
import type { Aircraft } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";
import { altColor, altFeet, fmtAlt, fmtSpeed, fmtTrack, fmtVert, label } from "../format";

/** Data-source credit shown under a route (adsb.lol's ODbL data needs attribution). */
function routeCredit(source?: string): string | null {
  switch (source) {
    case "adsblol":
      return "Route via adsb.lol (ODbL) · adsbdb";
    case "adsbdb":
      return "Route via adsbdb";
    case "flightaware":
      return "Route via FlightAware";
    case "gateway":
      return "Route via flight-data partner";
    default:
      return null;
  }
}

export function AircraftDetail(): JSX.Element | null {
  const selectedHex = useRadar((s) => s.selectedHex);
  const live = useRadar((s) => (selectedHex ? s.byHex[selectedHex] : undefined));
  const select = useRadar((s) => s.select);
  const setSelectedTrail = useRadar((s) => s.setSelectedTrail);
  const [detail, setDetail] = useState<Aircraft | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Minimized state collapses the card to a thin pill so you can pan/scroll
  // the map and see the trail without dismissing the selection. Tap the pill
  // (or the chevron) to bring the full card back. Separate from `expanded`
  // because expanding goes the other direction (taller, scrolls internally).
  const [minimized, setMinimized] = useState(false);

  // Pull full enrichment + trail for the detail card when selection changes.
  // The session trail comes back with the detail fetch; we then upgrade it
  // with adsb.lol's historical trace so the map shows where the plane came
  // from before our receiver started seeing it.
  useEffect(() => {
    setDetail(null);
    setExpanded(false);
    setMinimized(false);
    if (!selectedHex) return;
    let alive = true;
    api
      .aircraft(selectedHex)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setSelectedTrail(d.trail ?? []);
      })
      .catch(() => undefined);
    api
      .aircraftTrack(selectedHex)
      .then((t) => {
        if (!alive) return;
        if (t.trail && t.trail.length > 0) setSelectedTrail(t.trail);
        // Merge free-derived times into the detail so the route block shows
        // actualOff + ETA + progress when AeroAPI didn't supply them. Carry
        // routeStale through too so the "route hidden" note can render
        // even if /aircraft/:hex hadn't computed it yet.
        if (t.route || t.routeStale) {
          setDetail((d) => d
            ? { ...d, enrichment: { ...(d.enrichment ?? {}), route: t.route, routeStale: t.routeStale } }
            : d);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selectedHex, setSelectedTrail]);

  if (!selectedHex) return null;
  const a: Aircraft = { ...(detail ?? {}), ...(live ?? {}) } as Aircraft;
  if (!a.hex) a.hex = selectedHex;
  const e = a.enrichment ?? detail?.enrichment;
  const ft = altFeet(a);

  const origin = e?.route?.origin;
  const dest = e?.route?.destination;
  const photo = e?.photo;

  const r = e?.route;
  const landed = Boolean(r?.actualIn);
  const dep = fmtClock(r?.actualOut ?? r?.actualOff ?? r?.estimatedOut ?? r?.scheduledOut);
  const arrIso = r?.actualIn ?? r?.estimatedIn ?? r?.scheduledIn;
  const arr = fmtClock(arrIso);
  const rem = landed ? "Landed" : remaining(arrIso);
  const progress = !landed && typeof r?.progressPercent === "number" ? r.progressPercent : null;

  const callsign = a.flight?.trim();
  // Direct live-map URL: adsb.lol globe opens zoomed on the exact hex with
  // no login wall or search list. FR24's by-callsign URL is a search page,
  // and FR24's per-flight URLs use unpredictable internal slugs — globe is
  // the only deep-link that lands on a map immediately. Their /data/aircraft
  // page is kept as a secondary "spec sheet" link for the registration.
  const globeUrl = `https://globe.adsb.lol/?icao=${a.hex.toLowerCase()}`;
  // FR24 aircraft-page URL prefers registration (deep-links to the airframe
  // spec page), falls back to callsign (search), and finally to hex (also a
  // search). Always show a link — better to land on a search than nothing.
  const fr24Url = e?.registration
    ? `https://www.flightradar24.com/data/aircraft/${encodeURIComponent(e.registration.toLowerCase())}`
    : callsign
      ? `https://www.flightradar24.com/${encodeURIComponent(callsign)}`
      : `https://www.flightradar24.com/${a.hex.toLowerCase()}`;

  // Minimized: thin pill at the bottom with just the callsign + restore.
  if (minimized) {
    return (
      <div className="glass sheet sheet--mini" onClick={() => setMinimized(false)} role="button" aria-label="Restore card">
        <div className="sheet-mini-row">
          <span className="callsign-mini" style={{ color: altColor(ft) }}>{label(a)}</span>
          {(origin || dest) && (
            <span className="muted" style={{ fontSize: 12 }}>
              {origin?.iata || origin?.icao || "???"} → {dest?.iata || dest?.icao || "???"}
            </span>
          )}
          <span className="spacer" />
          <button className="iconbtn" onClick={(ev) => { ev.stopPropagation(); setMinimized(false); }} aria-label="Restore">▲</button>
          <button className="iconbtn" onClick={(ev) => { ev.stopPropagation(); select(null); }} aria-label="Close">✕</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`glass sheet sheet--compact scroll${expanded ? " sheet--expanded" : ""}`}>
      <div className="sheet-handle" onClick={() => setExpanded((v) => !v)} role="button" aria-label="Expand">
        <span />
      </div>

      {e?.operatorIata && (
        <div className="ac-logo-band">
          <img
            className="ac-logo"
            src={`https://images.daisycon.io/airline/?width=200&height=100&color=ffffff&iata=${encodeURIComponent(e.operatorIata)}`}
            alt={e.operator ?? e.operatorIata}
            loading="lazy"
            onError={(ev) => (ev.currentTarget.parentElement!.style.display = "none")}
          />
        </div>
      )}

      <div className="sheet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="callsign" style={{ color: altColor(ft) }}>
            {label(a)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {[e?.typeName, e?.operator].filter(Boolean).join(" · ") || "Identifying…"}
          </div>
        </div>
        {a.flagged && <span className="pill warn">★ Notable</span>}
        <button className="iconbtn" onClick={() => setMinimized(true)} aria-label="Minimize" title="Minimize — see the map">▼</button>
        <button className="iconbtn" onClick={() => select(null)} aria-label="Close">✕</button>
      </div>

      {photo && (
        <a className="ac-photo" href={photo.link} target="_blank" rel="noreferrer">
          <img src={photo.url} alt={label(a)} loading="lazy" />
          {photo.photographer && <span className="ac-photo-credit">© {photo.photographer} / Planespotters</span>}
        </a>
      )}

      {(origin || dest) && (
        <div className="route">
          <div className="code">{origin?.iata || origin?.icao || "???"}</div>
          <div className="arrow" />
          <div className="code">{dest?.iata || dest?.icao || "???"}</div>
        </div>
      )}
      {(origin?.city || dest?.city) && (
        <div className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          {origin?.city ?? origin?.name ?? ""} → {dest?.city ?? dest?.name ?? ""}
        </div>
      )}
      {(origin || dest) && (
        <div className="muted route-disclaimer">
          Routes are derived from the callsign and may not match every leg of
          a rotation — this is the free data path.
          {routeCredit(r?.source) && <span> {routeCredit(r?.source)}.</span>}
        </div>
      )}
      {!origin && !dest && e?.routeStale && (
        <div className="muted route-disclaimer" style={{ marginTop: 8 }}>
          Route hidden — the free data source had this callsign on a
          different leg, and the plane's position didn't match. Enable
          AeroAPI in Settings for live flight plans.
        </div>
      )}

      {(dep || arr) && (
        <>
          <div className="flight-times">
            <div className="ft">
              <div className="ft-k">Departed</div>
              <div className="ft-v">{dep || "—"}</div>
            </div>
            <div className="ft">
              <div className="ft-k">Arrives</div>
              <div className="ft-v">{arr || "—"}</div>
            </div>
            <div className="ft">
              <div className="ft-k">{landed ? "Status" : "Remaining"}</div>
              <div className="ft-v">{rem}</div>
            </div>
          </div>
          {progress != null && (
            <div className="progress" title={`${Math.round(progress)}% complete`}>
              <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
            </div>
          )}
        </>
      )}

      <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <KV k="Altitude" v={fmtAlt(a)} />
        <KV k="Speed" v={fmtSpeed(a)} />
        <KV k="Heading" v={fmtTrack(a)} />
        <KV k="Vertical" v={fmtVert(a)} />
        <KV k="Distance" v={a.distNm != null ? `${a.distNm} nm` : "—"} />
        <KV k="Squawk" v={a.squawk ?? "—"} />
        <KV k="Registration" v={e?.registration ?? "—"} />
        <KV k="Type" v={e?.typeCode ?? "—"} />
        <KV k="ICAO hex" v={a.hex.toUpperCase()} mono />
        <KV k="Signal" v={a.rssi != null ? `${a.rssi.toFixed(1)} dBFS` : "—"} />
      </div>

      {e?.owner && (
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Operator: {e.owner}
        </div>
      )}

      <div className="external-links">
        <a className="fr24-link" href={globeUrl} target="_blank" rel="noreferrer">
          Open in live map ↗
        </a>
        {fr24Url && (
          <a className="fr24-link" href={fr24Url} target="_blank" rel="noreferrer">
            FR24 aircraft page ↗
          </a>
        )}
      </div>
    </div>
  );
}

function fmtClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Force 12-hour AM/PM regardless of locale — the rest of the UI is locked
  // to 12-hour, this keeps the detail card's Departed/Arrives consistent.
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}

function remaining(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "Arriving";
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }): JSX.Element {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className={`v${mono ? " mono" : ""}`}>{v}</div>
    </div>
  );
}
