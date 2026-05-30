import { useEffect, useState } from "react";
import type { FlaggedSighting, SightingRow, Stats } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

export type DetailKind = "overview" | "in-view" | "today" | "farthest" | "all-time" | "notable";

const TITLES: Record<DetailKind, string> = {
  "overview": "Stats overview",
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
  const [active, setActive] = useState<DetailKind>(kind);
  const [rows, setRows] = useState<SightingRow[] | null>(null);
  const [notable, setNotable] = useState<FlaggedSighting[] | null>(null);
  const [overview, setOverview] = useState<Stats | null>(null);
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRows(null); setNotable(null); setOverview(null); setTotal(undefined);
    const load = async () => {
      try {
        if (active === "overview") {
          const s = await api.stats();
          if (!alive) return;
          setOverview(s);
        } else if (active === "in-view") {
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
        } else if (active === "today") {
          const r = await api.statsToday(0, 200);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (active === "all-time") {
          const r = await api.statsAllTime(0, 200);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (active === "farthest") {
          const r = await api.statsFarthest("today", 50);
          if (!alive) return;
          setRows(r.rows); setTotal(r.total);
        } else if (active === "notable") {
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
  }, [active, liveAircraft]);

  const backable = active !== kind;

  return (
    <div className="detail-backdrop" onClick={onClose}>
      <div className="detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="detail-handle" />
        <div className="detail-head">
          {backable && (
            <button className="iconbtn" onClick={() => setActive(kind)} aria-label="Back" style={{ marginRight: 4 }}>‹</button>
          )}
          <div className="detail-title">{TITLES[active]}{total != null && <span className="muted detail-count"> · {total}</span>}</div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="detail-body scroll">
          {loading && <div className="muted" style={{ padding: 16, textAlign: "center" }}>Loading…</div>}

          {!loading && active === "overview" && overview && (
            <Overview stats={overview} onPick={setActive} />
          )}

          {!loading && rows && rows.length === 0 && (
            <div className="muted" style={{ padding: 16, textAlign: "center" }}>Nothing here yet.</div>
          )}
          {!loading && rows && rows.map((r) => (
            <div key={`${r.hex}-${r.lastSeen}`} className="detail-row" onClick={() => { if (active === "in-view") { select(r.hex); onClose(); } }}>
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

function Overview({ stats, onPick }: { stats: Stats; onPick: (k: DetailKind) => void }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 2px 12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card label="In view now"     value={stats.current}                 onClick={() => onPick("in-view")} />
        <Card label="Seen today"      value={stats.todayUnique}             onClick={() => onPick("today")} />
        <Card label="Farthest today"  value={`${stats.maxRangeNmToday} nm`} onClick={() => onPick("farthest")} />
        <Card label="All-time"        value={stats.allTimeUnique}           onClick={() => onPick("all-time")} />
      </div>

      <Section title="Top operators today" rows={stats.topOperators.map((o) => [o.name, String(o.count)])} />
      <Section title="Top aircraft types" rows={stats.topTypes.map((t) => [t.type, String(t.count)])} />
    </div>
  );
}

function Card({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }): JSX.Element {
  return (
    <button className="stat-card stat-card-btn" onClick={onClick} type="button">
      <div className="stat-big">{value}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </button>
  );
}

function Section({ title, rows }: { title: string; rows: [string, string][] }): JSX.Element {
  return (
    <div>
      <div className="label">{title}</div>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No data yet.</div>}
      {rows.map(([k, v], i) => (
        <div key={i} className="stat-row">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 }}>{k}</span>
          <span style={{ fontWeight: 700, color: "var(--accent)" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
