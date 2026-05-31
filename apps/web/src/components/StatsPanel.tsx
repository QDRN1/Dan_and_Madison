import { memo, useEffect, useState } from "react";
import type { Stats } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

/** Stats drawer tab. The four headline cards + top operator/type lists + the
 *  Notable feed all live inline here so users see them at a glance. Clicking
 *  a card opens a full-screen popout (mounted at the root of RadarView so it
 *  isn't clipped by the drawer's transform). Refresh is slow (30s) to keep
 *  the cards from flickering. */
export function StatsPanel(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const select = useRadar((s) => s.select);
  const openPopout = useRadar((s) => s.openPopout);

  useEffect(() => {
    let alive = true;
    const load = () => api.stats().then((s) => alive && setStats(s)).catch(() => undefined);
    load();
    // 60s refresh is plenty for the daily counters; 30s caused enough
    // re-renders to look like the drawer was flickering.
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!stats) return <div className="muted" style={{ padding: 12 }}>Loading stats…</div>;

  return (
    <div className="scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginRight: -8, paddingRight: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card label="In view now"    value={stats.current}                 onClick={() => openPopout({ kind: "in-view",  title: "In view now" })} />
        <Card label="Seen today"     value={stats.todayUnique}             onClick={() => openPopout({ kind: "sightings", scope: "today", sort: "recent", title: "Seen today" })} />
        <Card label="Farthest today" value={`${stats.maxRangeNmToday} nm`} onClick={() => openPopout({ kind: "farthest",  scope: "today", sort: "farthest", title: "Farthest tracked" })} />
        <Card label="All-time"       value={stats.allTimeUnique}           onClick={() => openPopout({ kind: "sightings", scope: "all",   sort: "recent", title: "All-time unique" })} />
      </div>

      <Section title="Top operators today" rows={stats.topOperators.map((o) => [o.name, String(o.count)])} />
      <Section title="Top aircraft types" rows={stats.topTypes.map((t) => [t.type, String(t.count)])} />

      <div>
        <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Notable sightings</span>
        </div>
        {stats.recentFlagged.length === 0 && <div className="muted" style={{ fontSize: 13 }}>None yet today.</div>}
        {stats.recentFlagged.map((f, i) => (
          <div key={i} className="list-row" onClick={() => select(f.hex)}>
            <span className="pill warn">★</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cs">{f.flight?.trim() || f.hex.toUpperCase()}</div>
              <div className="sub">{f.reason}{f.operator ? ` · ${f.operator}` : ""}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Card = memo(function Card({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }): JSX.Element {
  return (
    <button className="stat-card stat-card-btn" onClick={onClick} type="button">
      <div className="stat-big">{value}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </button>
  );
});

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
