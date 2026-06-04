import { useEffect, useRef, useState } from "react";
import type { FlaggedSighting, SightingPage, SightingRow, SightingScope, SightingSort } from "@qdrn/shared";
import { api } from "../api";
import { type PopoutKind, useRadar } from "../store";

const PAGE_SIZE = 100;

/** Full-screen popout listing sightings with scope/search/airline filters.
 *  Mounted at the root of RadarView so it escapes the drawer's clipping
 *  transform. The drawer stays open behind it: "←" returns to the overview
 *  sheet inside the drawer, "✕" closes the popout (drawer keeps its state). */
export function SightingsPopout(): JSX.Element | null {
  const popout = useRadar((s) => s.popout);
  const close = useRadar((s) => s.closePopout);
  const select = useRadar((s) => s.select);
  const live = useRadar((s) => s.aircraft);

  const [scope, setScope] = useState<SightingScope>(popout?.scope ?? "today");
  const [sort, setSort] = useState<SightingSort>(popout?.sort ?? "recent");
  const [q, setQ] = useState(popout?.q ?? "");
  const [airline, setAirline] = useState<string>(popout?.airline ?? "");
  const [page, setPage] = useState<SightingPage | null>(null);
  const [notable, setNotable] = useState<FlaggedSighting[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);

  // Reset filters whenever a new popout is opened — honoring any pre-fills
  // the caller passed (e.g. clicking "Delta Air Lines" in Top operators
  // opens the popout already filtered to that airline).
  useEffect(() => {
    if (!popout) return;
    setScope(popout.scope ?? "today");
    setSort(popout.sort ?? (popout.kind === "farthest" ? "farthest" : "recent"));
    setQ(popout.q ?? "");
    setAirline(popout.airline ?? "");
    setOffset(0);
  }, [popout]);

  useEffect(() => { setOffset(0); }, [scope, sort, q, airline]);

  // Debounce search so we don't fire on every keystroke.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [q]);

  // In-view popout reads from the live aircraft store and re-filters on
  // every snapshot. Cheap — purely client-side, no flash.
  useEffect(() => {
    if (!popout || popout.kind !== "in-view") return;
    setPage(applyClientFilters(live, debouncedQ, airline, sort));
    setLoading(false);
  }, [popout, debouncedQ, airline, sort, live]);

  // Sightings + farthest popouts hit the server. `live` is deliberately NOT
  // in the dep list — including it (as I previously did) re-fired the fetch
  // on every websocket snapshot, flashing "Loading…" every ~1s and making
  // the whole popout feel like it was strobing. This effect only re-runs
  // when the actual query inputs change.
  useEffect(() => {
    if (!popout) return;
    if (popout.kind === "in-view" || popout.kind === "notable") return;
    let alive = true;
    setLoading(true);
    api.sightings({ scope, sort, q: debouncedQ, airline, offset, limit: PAGE_SIZE })
      .then((p) => { if (alive) setPage(p); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [popout, scope, sort, debouncedQ, airline, offset]);

  // Notable popout — pulls the flagged-sightings feed. Filtered client-side
  // by debounced search since the result set is small (a few hundred max).
  useEffect(() => {
    if (!popout || popout.kind !== "notable") return;
    let alive = true;
    setLoading(true);
    api.statsNotable(500)
      .then((r) => { if (alive) setNotable(r.rows); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [popout]);

  // Esc to close.
  useEffect(() => {
    if (!popout) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popout, close]);

  if (!popout) return null;

  const title = popout.title ?? defaultTitle(popout.kind);

  return (
    <div className="popout-backdrop" onClick={close}>
      <div className="popout" onClick={(e) => e.stopPropagation()}>
        <header className="popout-head">
          <button className="iconbtn" onClick={close} aria-label="Back" title="Back">←</button>
          <div className="popout-title">
            {title}
            {page && <span className="muted popout-count"> · {page.total.toLocaleString()}</span>}
          </div>
          <button className="iconbtn" onClick={close} aria-label="Close" title="Close">✕</button>
        </header>

        <div className="popout-filters">
          {popout.kind !== "in-view" && popout.kind !== "notable" && (
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

          {popout.kind !== "notable" ? (
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
              <select className="input" value={airline} onChange={(e) => setAirline(e.target.value)}>
                <option value="">All airlines</option>
                {page?.airlines.map((a) => (
                  <option key={a.name} value={a.name}>{a.name} ({a.count})</option>
                ))}
              </select>
              <select className="input" value={sort} onChange={(e) => setSort(e.target.value as SightingSort)}>
                <option value="recent">Last seen</option>
                <option value="farthest">Farthest</option>
                <option value="first">First seen</option>
              </select>
            </div>
          ) : (
            <div className="popout-row" style={{ gridTemplateColumns: "1fr" }}>
              <input
                className="input"
                placeholder="Search callsign, type, operator, reason…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div className="popout-body scroll">
          {loading && <div className="muted" style={{ padding: 24, textAlign: "center" }}>Loading…</div>}

          {/* Notable kind — flagged sightings with reason + timestamp */}
          {!loading && popout.kind === "notable" && (() => {
            const needle = debouncedQ.toLowerCase();
            const filtered = (notable ?? []).filter((f) => {
              if (!needle) return true;
              return (
                f.hex.toLowerCase().includes(needle) ||
                (f.flight ?? "").toLowerCase().includes(needle) ||
                (f.operator ?? "").toLowerCase().includes(needle) ||
                (f.typeName ?? "").toLowerCase().includes(needle) ||
                f.reason.toLowerCase().includes(needle)
              );
            });
            if (filtered.length === 0) {
              return <div className="muted" style={{ padding: 24, textAlign: "center" }}>Nothing flagged yet.</div>;
            }
            return (
              <table className="popout-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Callsign</th>
                    <th>Reason</th>
                    <th>Type</th>
                    <th>Operator</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f, i) => (
                    <tr key={i} onClick={() => { select(f.hex); close(); }}>
                      <td><span className="pill warn">★</span></td>
                      <td><strong>{f.flight?.trim() || f.hex.toUpperCase()}</strong></td>
                      <td className="ellipsis">{f.reason}</td>
                      <td>{f.typeName ?? "—"}</td>
                      <td className="ellipsis">{f.operator ?? "—"}</td>
                      <td className="num">{fmtAt(f.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}

          {/* Sightings / farthest / in-view — standard SightingRow table */}
          {!loading && popout.kind !== "notable" && page && page.rows.length === 0 && (
            <div className="muted" style={{ padding: 24, textAlign: "center" }}>Nothing matches those filters.</div>
          )}
          {!loading && popout.kind !== "notable" && page && page.rows.length > 0 && (
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
                  <tr key={`${r.hex}-${r.lastSeen ?? r.firstSeen ?? ""}`} onClick={() => { select(r.hex); close(); }}>
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

        {popout.kind !== "in-view" && page && page.total > PAGE_SIZE && (
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

function defaultTitle(kind: PopoutKind): string {
  return kind === "in-view" ? "In view now"
    : kind === "farthest" ? "Farthest tracked"
    : kind === "notable" ? "Notable sightings"
    : "Sightings";
}

function fmtAt(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

function routeLabel(r: SightingRow): string {
  if (r.originIcao && r.destIcao) return `${r.originIcao} → ${r.destIcao}`;
  if (r.originIcao)               return `${r.originIcao} →`;
  if (r.destIcao)                 return `→ ${r.destIcao}`;
  return "—";
}

/** Mirror the server-side filter for the "in-view" live source. */
function applyClientFilters(
  live: { hex: string; flight?: string; distNm?: number; enrichment?: { typeCode?: string; typeName?: string; operator?: string; operatorIcao?: string; route?: { origin?: { icao?: string; iata?: string }; destination?: { icao?: string; iata?: string } } } }[],
  q: string,
  airline: string,
  sort: SightingSort,
): SightingPage {
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
