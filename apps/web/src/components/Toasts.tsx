import { useEffect, useRef, useState } from "react";
import type { Aircraft } from "@qdrn/shared";
import { useRadar } from "../store";

interface Toast {
  id: number;
  hex: string;
  icon: string;
  title: string;
  sub: string;
}

/** Detect notable aircraft (military, presidential, superjumbo, helicopters,
 *  rare types) as they enter the radar, and pop a celebratory toast in the
 *  top-right. Each hex only fires once per session; closed toasts time out
 *  after 9s. Click a toast to select the plane on the map. */
export function Toasts(): JSX.Element {
  const aircraft = useRadar((s) => s.aircraft);
  const select = useRadar((s) => s.select);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const idRef = useRef(1);

  useEffect(() => {
    const fresh: Toast[] = [];
    for (const a of aircraft) {
      if (seen.current.has(a.hex)) continue;
      const m = classify(a);
      if (!m) continue;
      seen.current.add(a.hex);
      fresh.push({ id: idRef.current++, hex: a.hex, ...m });
    }
    if (!fresh.length) return;
    setToasts((cur) => [...cur, ...fresh].slice(-4));
    // Auto-expire each new toast after 9s.
    for (const t of fresh) {
      setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), 9000);
    }
  }, [aircraft]);

  if (toasts.length === 0) return <></>;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className="toast" onClick={() => { select(t.hex); setToasts((cur) => cur.filter((x) => x.id !== t.id)); }}>
          <span className="toast-icon">{t.icon}</span>
          <span className="toast-text">
            <span className="toast-title">{t.title}</span>
            <span className="toast-sub">{t.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** ICAO hex prefix to military service. US ranges per ADS-B Exchange. */
function militaryService(hex: string): string | null {
  const h = hex.toUpperCase();
  // US military: AE0000-AFFFFF; also ADF7C8-ADFFFF
  if (h >= "AE0000" && h <= "AFFFFF") return "US military";
  if (h >= "ADF000" && h <= "ADFFFF") return "US military";
  // UK military: 43C000-43CFFF
  if (h >= "43C000" && h <= "43CFFF") return "UK military";
  // German military
  if (h >= "3F8000" && h <= "3FBFFF") return "German military";
  // French military
  if (h >= "3A8000" && h <= "3AFFFF") return "French military";
  // Canadian forces
  if (h >= "C00000" && h <= "C00FFF") return "Canadian forces";
  return null;
}

const PRESIDENTIAL = /^(AF1|AF2|EXEC1F|VENUS|MAGMA|SAM\d|MUSIC|DENALI)/i;

function classify(a: Aircraft): { icon: string; title: string; sub: string } | null {
  const cs = (a.flight ?? "").trim().toUpperCase();
  const e = a.enrichment;
  const tc = e?.typeCode?.toUpperCase() ?? "";
  const tn = e?.typeName ?? "";
  const op = e?.operator ?? "";

  if (PRESIDENTIAL.test(cs)) {
    return { icon: "🦅", title: "VIP in the sky!", sub: `${cs || "Executive callsign"} overhead — possibly presidential.` };
  }
  const svc = militaryService(a.hex);
  if (svc) {
    return { icon: "🪖", title: `${svc} overhead`, sub: `${cs || a.hex.toUpperCase()}${tn ? ` · ${tn}` : ""}` };
  }
  if (tc === "A388") {
    return { icon: "🛩️", title: "Superjumbo!", sub: `Airbus A380${op ? ` — ${op}` : ""}` };
  }
  if (tc === "B748" || tc === "B742" || tc === "B744") {
    return { icon: "🛫", title: "Queen of the skies", sub: `Boeing 747${op ? ` — ${op}` : ""}` };
  }
  if (tc === "SR71" || tc === "U2" || tc === "U-2") {
    return { icon: "🕵️", title: "Spy plane sighting!", sub: tn || tc };
  }
  if (tc === "DC3" || tc === "DC-3" || tn.toLowerCase().includes("dc-3")) {
    return { icon: "🎞️", title: "Vintage warbird!", sub: `${tn || "DC-3"} — flying since the 1930s.` };
  }
  if (tc === "CONC" || tn.toLowerCase().includes("concorde")) {
    return { icon: "🚀", title: "Concorde?!", sub: "If this is real, take a photo." };
  }
  if (tc === "AN225") {
    return { icon: "🦣", title: "Antonov An-225 'Mriya'", sub: "Once the largest plane in the world." };
  }
  // Helicopters (typeCode starting with H or ICAO category)
  if (tc.startsWith("H") && tc.length <= 4 && tc !== "HEAVY") {
    return { icon: "🚁", title: "Helicopter overhead", sub: tn || tc };
  }
  // Cargo monsters by operator
  if (/UPS|FEDEX|FED EX|ATLAS|DHL|CARGOLUX/i.test(op) && (tc.startsWith("B7") || tc.startsWith("A3"))) {
    return { icon: "📦", title: "Cargo heavy", sub: `${op}${tn ? ` · ${tn}` : ""}` };
  }
  // 7700 emergency squawk would be very notable — but we don't have squawk in Aircraft here.
  return null;
}
