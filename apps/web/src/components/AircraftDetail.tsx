import { useEffect, useState } from "react";
import type { Aircraft } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";
import { altColor, altFeet, fmtAlt, fmtSpeed, fmtTrack, fmtVert, label } from "../format";

export function AircraftDetail(): JSX.Element | null {
  const selectedHex = useRadar((s) => s.selectedHex);
  const live = useRadar((s) => (selectedHex ? s.byHex[selectedHex] : undefined));
  const select = useRadar((s) => s.select);
  const setSelectedTrail = useRadar((s) => s.setSelectedTrail);
  const [detail, setDetail] = useState<Aircraft | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Pull full enrichment + trail for the detail card when selection changes.
  useEffect(() => {
    setDetail(null);
    setExpanded(false);
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

  return (
    <div className={`glass sheet scroll${expanded ? " sheet--expanded" : ""}`}>
      <div className="sheet-handle" onClick={() => setExpanded((v) => !v)} role="button" aria-label="Expand">
        <span />
      </div>

      <div className="sheet-head">
        {e?.operatorIata && (
          <img
            className="ac-logo"
            src={`https://images.daisycon.io/airline/?width=160&height=80&color=ffffff&iata=${encodeURIComponent(e.operatorIata)}`}
            alt={e.operator ?? e.operatorIata}
            loading="lazy"
            onError={(ev) => (ev.currentTarget.style.display = "none")}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="callsign" style={{ color: altColor(ft) }}>
            {label(a)}
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {[e?.typeName, e?.operator].filter(Boolean).join(" · ") || "Identifying…"}
          </div>
        </div>
        {a.flagged && <span className="pill warn">★ Notable</span>}
        <button className="iconbtn" onClick={() => select(null)} aria-label="Close">
          ✕
        </button>
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

      <div className="kv-grid">
        <KV k="Altitude" v={fmtAlt(a)} />
        <KV k="Speed" v={fmtSpeed(a)} />
        <KV k="Vertical" v={fmtVert(a)} />
        <KV k="Heading" v={fmtTrack(a)} />
        <KV k="Distance" v={a.distNm != null ? `${a.distNm} nm` : "—"} />
        <KV k="Squawk" v={a.squawk ?? "—"} />
      </div>

      <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }): JSX.Element {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className={`v${mono ? " mono" : ""}`}>{v}</div>
    </div>
  );
}
