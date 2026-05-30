import { useEffect, useState } from "react";
import type { FlaggedSighting } from "@qdrn/shared";
import { api } from "../api";
import { useRadar } from "../store";
import { StatsDetail, type DetailKind } from "./StatsDetail";

/** Drawer Stats tab — kept lean so it doesn't flicker. The noisy bits
 *  (totals + top lists) live behind the Overview popup; only the small
 *  Notable list refreshes inline here. */
export function StatsPanel(): JSX.Element {
  const [flagged, setFlagged] = useState<FlaggedSighting[] | null>(null);
  const [detail, setDetail] = useState<DetailKind | null>(null);
  const select = useRadar((s) => s.select);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.statsNotable(8)
        .then((r) => alive && setFlagged(r.rows))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
      <button className="btn btn-primary btn-block" onClick={() => setDetail("overview")} style={{ padding: "12px 16px", fontSize: 14 }}>
        Show stats overview →
      </button>

      <div>
        <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Notable sightings</span>
          <button className="btn" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => setDetail("notable")}>See all</button>
        </div>
        {flagged === null && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
        {flagged && flagged.length === 0 && <div className="muted" style={{ fontSize: 13 }}>None yet today.</div>}
        {flagged && flagged.map((f, i) => (
          <div key={i} className="list-row" onClick={() => select(f.hex)}>
            <span className="pill warn">★</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cs">{f.flight?.trim() || f.hex.toUpperCase()}</div>
              <div className="sub">{f.reason}{f.operator ? ` · ${f.operator}` : ""}</div>
            </div>
          </div>
        ))}
      </div>

      {detail && <StatsDetail kind={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
