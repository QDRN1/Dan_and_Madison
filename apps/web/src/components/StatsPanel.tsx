import { memo, useEffect, useState } from "react";
import { classifyAircraft, type Stats } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

/** Stats drawer tab. Every stat surfaces — the four headline cards, both
 *  top-N lists (operators / aircraft types), and the notable feed — is
 *  clickable and opens the matching pre-filtered popout. Notable rows
 *  carry their flag timestamp. Refresh stays slow (60s) to avoid the
 *  drawer flickering on every snapshot. */
export function StatsPanel(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const select = useRadar((s) => s.select);
  const openPopout = useRadar((s) => s.openPopout);
  const liveAircraft = useRadar((s) => s.aircraft);
  const hidden = useRadar((s) => s.hiddenClasses);

  useEffect(() => {
    let alive = true;
    const load = () => api.stats().then((s) => alive && setStats(s)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!stats) return <div className="muted" style={{ padding: 12 }}>Loading stats…</div>;

  // The server reports total tracked; the user expects the "In view now"
  // count to match what they actually see on the map / list once they've
  // hidden classes in Settings. Recompute from live + hiddenClasses so
  // all three views stay in sync.
  const inViewCount = hidden.size === 0
    ? stats.current
    : liveAircraft.filter((a) => a.lat != null && !hidden.has(classifyAircraft(a))).length;

  return (
    <div className="scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, marginRight: -8, paddingRight: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card label="In view now"    value={inViewCount}                   onClick={() => openPopout({ kind: "in-view",  title: "In view now" })} />
        <Card label="Seen today"     value={stats.todayUnique}             onClick={() => openPopout({ kind: "sightings", scope: "today", sort: "recent", title: "Seen today" })} />
        <Card label="Farthest today" value={`${stats.maxRangeNmToday} nm`} onClick={() => openPopout({ kind: "farthest",  scope: "today", sort: "farthest", title: "Farthest tracked" })} />
        <Card label="All-time"       value={stats.allTimeUnique}           onClick={() => openPopout({ kind: "sightings", scope: "all",   sort: "recent", title: "All-time unique" })} />
      </div>

      <Section
        title="Top operators today"
        rows={stats.topOperators.map((o) => ({ k: o.name, v: String(o.count), airline: o.name }))}
        onHeaderClick={() => openPopout({ kind: "sightings", scope: "today", sort: "recent", title: "Today's operators" })}
        onRowClick={(r) => openPopout({ kind: "sightings", scope: "today", sort: "recent", airline: r.airline, title: r.k })}
      />
      <Section
        title="Top aircraft types"
        rows={stats.topTypes.map((t) => ({ k: t.type, v: String(t.count), q: t.type }))}
        onHeaderClick={() => openPopout({ kind: "sightings", scope: "today", sort: "recent", title: "Today's aircraft types" })}
        onRowClick={(r) => openPopout({ kind: "sightings", scope: "today", sort: "recent", q: r.q, title: r.k })}
      />

      <div>
        <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Notable sightings</span>
          <button
            className="btn"
            style={{ padding: "3px 9px", fontSize: 11 }}
            onClick={() => openPopout({ kind: "notable", title: "Notable sightings" })}
          >
            See all
          </button>
        </div>
        {stats.recentFlagged.length === 0 && <div className="muted" style={{ fontSize: 13 }}>None yet today.</div>}
        {stats.recentFlagged.map((f, i) => (
          <div key={i} className="list-row" onClick={() => select(f.hex)}>
            <span className="pill warn">★</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cs">{f.flight?.trim() || f.hex.toUpperCase()}</div>
              <div className="sub">
                {f.reason}{f.operator ? ` · ${f.operator}` : ""}
                <span className="muted" style={{ marginLeft: 6 }}>· {fmtAt(f.at)}</span>
              </div>
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

interface SectionRow {
  k: string;
  v: string;
  airline?: string;
  q?: string;
}

function Section({
  title, rows, onHeaderClick, onRowClick,
}: {
  title: string;
  rows: SectionRow[];
  onHeaderClick?: () => void;
  onRowClick?: (r: SectionRow) => void;
}): JSX.Element {
  return (
    <div>
      <button
        className="label stat-section-head"
        onClick={onHeaderClick}
        type="button"
      >
        <span>{title}</span>
        {rows.length > 0 && <span className="muted" style={{ fontSize: 11 }}>see all →</span>}
      </button>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No data yet.</div>}
      {rows.map((r, i) => (
        <button
          key={i}
          className="stat-row stat-row-btn"
          onClick={() => onRowClick?.(r)}
          type="button"
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8, textAlign: "left" }}>{r.k}</span>
          <span style={{ fontWeight: 700, color: "var(--accent)" }}>{r.v}</span>
        </button>
      ))}
    </div>
  );
}

/** Compact "5m ago" / "2h ago" / "Yesterday" / "Jun 1 9:42 AM" for the
 *  notable list — relative when fresh, calendar once it's older than a day. */
function fmtAt(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 172_800_000) return "yesterday";
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}
