import { useEffect, useState } from "react";
import type { Stats } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

export function StatsPanel(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const select = useRadar((s) => s.select);

  useEffect(() => {
    let alive = true;
    const load = () => api.stats().then((s) => alive && setStats(s)).catch(() => undefined);
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!stats) return <div className="muted" style={{ padding: 12 }}>Loading stats…</div>;

  return (
    <div className="scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card label="In view now" value={stats.current} />
        <Card label="Seen today" value={stats.todayUnique} />
        <Card label="Farthest today" value={`${stats.maxRangeNmToday} nm`} />
        <Card label="All-time" value={stats.allTimeUnique} />
      </div>

      <Section title="Top operators today" rows={stats.topOperators.map((o) => [o.name, String(o.count)])} />
      <Section title="Top aircraft types" rows={stats.topTypes.map((t) => [t.type, String(t.count)])} />

      <div>
        <div className="label">Notable sightings</div>
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

function Card({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="stat-card">
      <div className="stat-big">{value}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
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
