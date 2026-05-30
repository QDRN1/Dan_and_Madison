import { useEffect, useRef, useState } from "react";
import type { SightingPage, SightingRow, SightingScope, SightingSort } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";

export type PopoutKind = "in-view" | "sightings" | "farthest";

interface Initial {
  scope?: SightingScope;
  sort?: SightingSort;
  title?: string;
}

const PAGE_SIZE = 100;

/** Full-screen popout listing sightings with scope/search/airline filters.
 *  Used by every stat card that opens a "big table" view. The "in-view" kind
 *  uses live aircraft from the store instead of the DB, so live position
 *  changes don't require a refetch. */
export function SightingsPopout({
  kind, initial, onClose,
}: { kind: PopoutKind; initial?: Initial; onClose: () => void }): JSX.Element {
  const live = useRadar((s) => s.aircraft);
  const select = useRadar((s) => s.select);

  const [scope, setScope] = useState<SightingScope>(initial?.scope ?? "today");
  const [sort, setSort] = useState<SightingSort>(initial?.sort ?? (kind === "farthest" ? "farthest" : "recent"));
  const [q, setQ] = useState("");
  const [airline, setAirline] = useState<string>("");
  const [page, setPage] = useState<SightingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);

  // Reset offset whenever the filter combo changes — fresh result set.
  useEffect(() => { setOffset(0); }, [scope, sort, q, airline, kind]);

  // Debounce the search so we don't hammer the DB on every keystroke.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [q]);

  useEffect(() => {
    if (kind === "in-view") {
      // Reuse the page shape so the table doesn't care where rows came from.
      const filtered = applyClientFilters(live, debouncedQ, airline, sort);
      setPage({
        rows: filtered.rows,
        total: filtered.total,
        airlines: filtered.airlines,
      });
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.sightings({ scope, sort, q: debouncedQ, airline, offset, limit: PAGE_SIZE })
      .then((p) => { if (alive) setPage(p); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind, scope, sort, debouncedQ, airline, offset, live]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = initial?.title ?? (
    kind === "in-view" ? "In view now" :
    kind === "farthest" ? "Farthest tracked" :
    "Sightings"
  );

  return (
    <div className="popout-backdrop" onClick={onClose}>
      <div className="popout" onClick={(e) => e.stopPropagation()}>
        <header className="popout-head">
          <div className="popout-title">
            {title}
            {page && <span className="muted popout-count"> · {page.total.toLocaleString()}</span>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="popout-filters">
          {kind !== "in-view" && (
            <div className="popout-scope-tabs" role="tablist">
              {(["today", "week", "month", "all"] as const).map((s) => (
                <button
                  key={s}
                  className={`tab${scope === s ? " active" : ""}`}
                  onClick={() => setScope(s)}
                  type="button"
                >
                  {s === "today" ? "Today" : s === "week" ? "This week" : s === "month" ? "This month" : "All time"}
                </button>
              ))}
            </div>
          )}

          <div className="popout-row">
            <input
              className="input"
              placeholder="Search callsign, hex, type, route…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <select
              className="input"
              value={airline}
              onChange={(e) => setAirline(e.target.value)}
            >
              <option value="">All airlines</option>
              {page?.airlines.map((a) => (
                <option key={a.name} value={a.name}>{a.name} ({a.count})</option>
              ))}
            </select>
            <select
              className="input"
              value={sort}
              onChange={(e) => setSort(e.target.value as SightingSort)}
            >
              <option value="recent">Last seen</option>
              <option value="farthest">Farthest</option>
              <option value="first">First seen</option>
            </select>
          </div>
        </div>

        <div className="popout-body scroll">
          {loading && <div className="muted" style={{ padding: 24, textAlign: "center" }}>Loading…</div>}
          {!loading && page && page.rows.length === 0 && (
            <div className="muted" style={{ padding: 24, textAlign: "center" }}>Nothing matches those filters.</div>
          )}
          {!loading && page && page.rows.length > 0 && (
            <table className="popout-table">
              <thead>
                <tr>
                  <th>Callsign</th>
                  <th>Type</th>
                  <th>Operator</th>
                  <th>Route</th>
                  <th className="num">Max dist</th>
                  <th className="num">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={`${r.hex}-${r.lastSeen ?? r.firstSeen ?? ""}`} onClick={() => { select(r.hex); onClose(); }}>
                    <td><strong>{r.flight?.trim() || r.hex.toUpperCase()}</strong></td>
                    <td>{r.typeName ?? r.typeCode ?? "—"}</td>
                    <td className="ellipsis">{r.operator ?? "—"}</td>
                    <td className="ellipsis">{routeLabel(r)}</td>
                    <td className="num">{r.maxDistNm != null ? `${Math.round(r.maxDistNm * 10) / 10} nm` : "—"}</td>
                    <td className="num">{r.lastSeen ? new Date(r.lastSeen).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {kind !== "in-view" && page && page.total > PAGE_SIZE && (
          <footer className="popout-foot">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</button>
            <span className="muted" style={{ fontSize: 12 }}>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, page.total)} of {page.total.toLocaleString()}
            </span>
            <button className="btn" disabled={offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</button>
          </footer>
        )}
      </div>
    </div>
  );
}

function routeLabel(r: SightingRow): string {
  if (r.originIcao && r.destIcao) return `${r.originIcao} → ${r.destIcao}`;
  if (r.originIcao)               return `${r.originIcao} →`;
  if (r.destIcao)                 return `→ ${r.destIcao}`;
  return "—";
}

/** Mirror the server-side filter shape for the "in-view" (live) source so the
 *  same table+filters work for live aircraft without an extra round-trip. */
function applyClientFilters(
  live: { hex: string; flight?: string; distNm?: number; enrichment?: { typeCode?: string; typeName?: string; operator?: string; operatorIcao?: string; route?: { origin?: { icao?: string; iata?: string }; destination?: { icao?: string; iata?: string } } } }[],
  q: string,
  airline: string,
  sort: SightingSort,
): { rows: SightingRow[]; total: number; airlines: { name: string; count: number }[] } {
  const rowsAll: SightingRow[] = live.map((a) => ({
    hex: a.hex,
    flight: a.flight,
    typeCode: a.enrichment?.typeCode ?? null,
    typeName: a.enrichment?.typeName ?? null,
    operator: a.enrichment?.operator ?? a.enrichment?.operatorIcao ?? null,
    originIcao: a.enrichment?.route?.origin?.icao ?? a.enrichment?.route?.origin?.iata ?? null,
    destIcao: a.enrichment?.route?.destination?.icao ?? a.enrichment?.route?.destination?.iata ?? null,
    lastSeen: Date.now(),
    maxDistNm: a.distNm,
  }));

  const airlines = Object.entries(
    rowsAll.reduce<Record<string, number>>((acc, r) => {
      const k = r.operator ?? "";
      if (k) acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 30);

  let rows = rowsAll;
  if (airline) rows = rows.filter((r) => r.operator === airline);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) =>
      r.hex.toLowerCase().includes(needle) ||
      (r.flight ?? "").toLowerCase().includes(needle) ||
      (r.operator ?? "").toLowerCase().includes(needle) ||
      (r.typeCode ?? "").toLowerCase().includes(needle) ||
      (r.typeName ?? "").toLowerCase().includes(needle) ||
      (r.originIcao ?? "").toLowerCase().includes(needle) ||
      (r.destIcao ?? "").toLowerCase().includes(needle),
    );
  }
  if (sort === "farthest") rows = [...rows].sort((a, b) => (b.maxDistNm ?? 0) - (a.maxDistNm ?? 0));
  return { rows, total: rows.length, airlines };
}
