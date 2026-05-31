import { useState } from "react";
import { altColor } from "../format";

/** Altitude → color legend. Lives bottom-left so it doesn't fight the zoom
 *  controls. Collapsed by default to a small swatch button; tapping expands
 *  the full ramp. Hides itself when the user has selected an aircraft so
 *  the detail card has room to breathe. */
const STOPS: Array<{ ft: number; label: string }> = [
  { ft: 40000, label: "40 K+" },
  { ft: 30000, label: "30 K" },
  { ft: 20000, label: "20 K" },
  { ft: 10000, label: "10 K" },
  { ft: 0,     label: "Surface" },
];

export function AltitudeLegend({ hidden }: { hidden?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <div className={`altlegend${open ? " open" : ""}`}>
      {open ? (
        <>
          <button className="altlegend-close" aria-label="Collapse legend" onClick={() => setOpen(false)}>×</button>
          <div className="altlegend-title">Altitude</div>
          <ul className="altlegend-rows">
            {STOPS.map((s) => (
              <li key={s.ft}>
                <span className="altlegend-swatch" style={{ background: altColor(s.ft) }} />
                <span className="altlegend-label">{s.label}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <button className="altlegend-toggle" aria-label="Show altitude legend" onClick={() => setOpen(true)} title="Show altitude legend">
          <span className="altlegend-stripe" />
        </button>
      )}
    </div>
  );
}
