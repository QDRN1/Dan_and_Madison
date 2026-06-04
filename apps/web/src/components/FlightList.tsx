import { classifyAircraft } from "@qdrn/shared";
import { useRadar } from "../store";
import { altColor, altFeet, fmtAlt, frontierAnimal, label } from "../format";

export function FlightList(): JSX.Element {
  const aircraft = useRadar((s) => s.aircraft);
  const selectedHex = useRadar((s) => s.selectedHex);
  const select = useRadar((s) => s.select);
  const hidden = useRadar((s) => s.hiddenClasses);

  const sorted = [...aircraft]
    .filter((a) => a.lat != null)
    .filter((a) => hidden.size === 0 || !hidden.has(classifyAircraft(a)))
    .sort((a, b) => (a.distNm ?? 1e9) - (b.distNm ?? 1e9));

  return (
    <div className="scroll" style={{ flex: 1, marginRight: -6, paddingRight: 6 }}>
      {sorted.length === 0 && <div className="muted" style={{ padding: 12 }}>No aircraft in range yet…</div>}
      {sorted.map((a) => {
        const e = a.enrichment;
        const animal = frontierAnimal(a);
        const offRadar = a.source === "adsblol";
        return (
          <div
            key={a.hex}
            className={`list-row${a.hex === selectedHex ? " sel" : ""}`}
            onClick={() => select(a.hex)}
            style={offRadar ? { opacity: 0.6 } : undefined}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: altColor(altFeet(a)),
                flex: "0 0 auto",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cs">
                {label(a)}
                {animal && <span title="Frontier — every tail is an animal" style={{ marginLeft: 6 }}>{animal}</span>}
                {offRadar && <span title="Off-radar fill-in from adsb.lol" style={{ marginLeft: 6, fontSize: 12 }}>📡</span>}
                {a.flagged && <span className="pill warn" style={{ marginLeft: 6 }}>★</span>}
              </div>
              <div className="sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {[e?.typeCode, e?.operator].filter(Boolean).join(" · ") || a.hex.toUpperCase()}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtAlt(a)}</div>
              <div className="sub">{a.distNm != null ? `${a.distNm} nm` : ""}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
