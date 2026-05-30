import { useEffect, useState } from "react";
import type { FlaggedSighting, SightingScope, SightingSort, Stats } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";
import { SightingsPopout, type PopoutKind } from "./SightingsPopout";

export type DetailKind = "overview" | "in-view" | "today" | "farthest" | "all-time" | "notable";

const SHEET_TITLES = {
  overview: "Stats overview",
  notable:  "Notable sightings",
} as const;

/** Routes the right UI for each stat kind:
 *   - "overview" / "notable" → small slide-up sheet
 *   - "in-view" / "today" / "all-time" / "farthest" → full-screen filtered
 *     popout (search, scope tabs, airline filter, sortable).
 *  Drilling from the overview cards opens the popout, closing the sheet. */
export function StatsDetail({ kind, onClose }: { kind: DetailKind; onClose: () => void }): JSX.Element {
  const [active, setActive] = useState<DetailKind>(kind);

  // Drill from a sheet card into the full-screen popout. The sheet stays
  // mounted underneath so closing the popout returns to the overview.
  if (active === "in-view" || active === "today" || active === "all-time" || active === "farthest") {
    const popoutKind: PopoutKind = active === "in-view" ? "in-view" : active === "farthest" ? "farthest" : "sightings";
    const initScope: SightingScope | undefined =
      active === "today"    ? "today" :
      active === "all-time" ? "all"   :
      active === "farthest" ? "today" :
      undefined;
    const initSort: SightingSort | undefined = active === "farthest" ? "farthest" : "recent";
    const title =
      active === "in-view"  ? "In view now" :
      active === "today"    ? "Seen today" :
      active === "all-time" ? "All-time unique" :
                              "Farthest tracked";
    return (
      <SightingsPopout
        kind={popoutKind}
        initial={{ scope: initScope, sort: initSort, title }}
        onClose={() => { setActive(kind === "overview" ? "overview" : kind); if (kind !== "overview") onClose(); }}
      />
    );
  }

  return <DetailSheet active={active} onPick={setActive} onClose={onClose} />;
}

function DetailSheet({ active, onPick, onClose }: { active: "overview" | "notable"; onPick: (k: DetailKind) => void; onClose: () => void }): JSX.Element {
  const select = useRadar((s) => s.select);
  const [overview, setOverview] = useState<Stats | null>(null);
  const [notable, setNotable] = useState<FlaggedSighting[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = async () => {
      try {
        if (active === "overview") {
          const s = await api.stats();
          if (alive) setOverview(s);
        } else if (active === "notable") {
          const r = await api.statsNotable(100);
          if (alive) setNotable(r.rows);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, [active]);

  const title = SHEET_TITLES[active];
  const count = active === "notable" ? notable?.length : undefined;

  return (
    <div className="detail-backdrop" onClick={onClose}>
      <div className="detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="detail-handle" />
        <div className="detail-head">
          <div className="detail-title">
            {title}{count != null && <span className="muted detail-count"> · {count}</span>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="detail-body scroll">
          {loading && <div className="muted" style={{ padding: 16, textAlign: "center" }}>Loading…</div>}

          {!loading && active === "overview" && overview && <Overview stats={overview} onPick={onPick} />}

          {!loading && active === "notable" && notable && notable.length === 0 && (
            <div className="muted" style={{ padding: 16, textAlign: "center" }}>Nothing flagged yet.</div>
          )}
          {!loading && active === "notable" && notable && notable.map((f, i) => (
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
