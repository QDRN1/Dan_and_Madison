import { useEffect, useState } from "react";
import type { FlaggedSighting, SightingRow } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

export type DetailKind = "in-view" | "today" | "farthest" | "all-time" | "notable";

const TITLES: Record<DetailKind, string> = {
  "in-view": "In view now",
  "today": "Seen today",
  "farthest": "Farthest today",
  "all-time": "All-time unique",
  "notable": "Notable sightings",
};

/** Slide-up sheet listing the rows behind whichever stat card was tapped. */
export function StatsDetail({ kind, onClose }: { kind: DetailKind; onClose: () => void }): JSX.Element {
  const select = useRadar((s) => s.select);
  const liveAircraft = useRadar((s) => s.aircraft);
  const [rows, setRows] = useState<SightingRow[] | null>(kind === "in-view" ? null : null);
  const [notable, setNotable] = useState<FlaggedSighting[] | null>(null);
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = async () => {
      try {
        if (kind === "in-view") {
          // Live snapshot — no DB hit. Map to the same SightingRow shape so we
          // can reuse the row rendering.
          const live: SightingRow[] = liveAircraft.map((a) => ({
            hex: a.hex,
            flight: a.flight,
            typeCode: a.enrichment?.typeCode ?? null,
            typeName: a.enrichment?.typeName ?? null,
            operator: a.enrichment?.operator ?? a.enrichment?.operatorIcao ?? null,
            lastSeen: Date.now(),
            maxDistNm: a.distNm,
          }));
          setRows(live);
          setTotal(live.length);
        } else if (kind === "today") {
          const r = await api.statsToday(0, 200);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (kind === "all-time") {
          const r = await api.statsAllTime(0, 200);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (kind === "farthest") {
          const r = await api.statsFarthest("today", 50);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (kind === "notable") {
          const r = await api.statsNotable(100);
          if (!alive) return;
          setNotable(r.rows); setTotal(r.rows.length);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, [kind, liveAircraft]);

  return (
    <div className="detail-backdrop" onClick={onClose}>
      <div className="detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="detail-handle" />
        <div className="detail-head">
          <div className="detail-title">{TITLES[kind]}{total != null && <span className="muted detail-count"> · {total}</span>}</div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="detail-body scroll">
          {loading && <div className="muted" style={{ padding: 16, textAlign: "center" }}>Loading…</div>}
          {!loading && rows && rows.length === 0 && (
            <div className="muted" style={{ padding: 16, textAlign: "center" }}>Nothing here yet.</div>
          )}
          {!loading && rows && rows.map((r) => (
            <div key={`${r.hex}-${r.lastSeen}`} className="detail-row" onClick={() => { if (kind === "in-view") { select(r.hex); onClose(); } }}>
              <div className="detail-cs">{r.flight?.trim() || r.hex.toUpperCase()}</div>
              <div className="detail-sub">
                {[r.typeName ?? r.typeCode, r.operator, r.maxDistNm != null ? `${Math.round(r.maxDistNm * 10) / 10} nm` : null]
                  .filter(Boolean).join(" · ")}
              </div>
            </div>
          ))}
          {!loading && notable && notable.map((f, i) => (
            <div key={i} className="detail-row" onClick={() => { select(f.hex); onClose(); }}>
              <div className="detail-cs">★ {f.flight?.trim() || f.hex.toUpperCase()}</div>
              <div className="detail-sub">{f.reason}{f.operator ? ` · ${f.operator}` : ""}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
