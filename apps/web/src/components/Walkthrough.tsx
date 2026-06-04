import { useEffect, useState } from "react";
import { useRadar } from "../store";

/**
 * Express walkthrough — 8 steps, ~60 sec, visitor-safe (no Settings depth,
 * no PIN-gated features). Each step targets a DOM element via data-tour
 * attributes and renders a dimming overlay with a cutout around the target
 * plus a tooltip-style copy card. Steps can side-effect into store state
 * (open the drawer, switch tabs) so the spotlight tracks what it's
 * teaching.
 *
 * "FAQ" is a separate short modal of common questions, accessible from
 * the same Help (?) button. localStorage flag `qdrn-tour-seen` keeps the
 * first-time prompt from re-firing on every refresh.
 */

const SEEN_KEY = "qdrn-tour-seen";

interface Step {
  /** CSS selector for the highlighted element. Empty = full-screen modal. */
  target?: string;
  title: string;
  body: string;
  /** Fires when the step is shown. Use to set drawer panel, select a plane, etc. */
  onShow?: () => void;
}

const STEPS: Step[] = [
  {
    title: "Welcome to your radar",
    body: "Every plane on the map is real and overhead right now. Each dot is a live ADS-B reading from the Pi. This is the express tour — about 60 seconds.",
    onShow: () => {
      const st = useRadar.getState();
      st.setDrawerOpen(false);
      st.select(null);
    },
  },
  {
    target: "[data-tour=\"brand\"]",
    title: "Hello, pilot",
    body: "Top-left is who you are, where you live, and which air-traffic Center owns the airspace above you. (Madison's home airspace is ZMP, Minneapolis Center.)",
  },
  {
    target: "[data-tour=\"tracking-pill\"]",
    title: "Tracking count",
    body: "Live plane count for what your antenna sees right now. Tap the pill for a full filterable list of everything currently in view.",
  },
  {
    target: ".altlegend",
    title: "Color tells you altitude",
    body: "Each plane icon is tinted by altitude — red on the ground, yellow low, green at cruise, blue and purple for jets up at FL350+. The legend bottom-left expands the full key.",
  },
  {
    target: "[data-tour=\"storm-btn\"]",
    title: "Storm radar",
    body: "Tap the cloud button to overlay live precipitation from RainViewer. The map auto-zooms to the area-view scale so the rain pattern is actually readable.",
  },
  {
    target: "[data-tour=\"menu-btn\"]",
    title: "The menu drawer",
    body: "The ☰ menu opens a four-tab drawer: flights nearby, stats, achievements, and settings. Let's open it.",
    onShow: () => useRadar.getState().setDrawerOpen(true),
  },
  {
    target: "[data-tour=\"tab-achievements\"]",
    title: "100 badges to earn",
    body: "Every interesting plane unlocks something — A380 spotters, dawn patrol, military overhead, your first hundred today. Tap any earned badge for a detail card explaining what triggered it.",
    onShow: () => {
      const st = useRadar.getState();
      st.setDrawerOpen(true);
      st.setDrawerPanel("achievements");
    },
  },
  {
    title: "You're set",
    body: "That's the express tour. Tap the ? button in the top bar anytime to replay this or open the FAQ. Enjoy your radar.",
    onShow: () => {
      const st = useRadar.getState();
      st.setDrawerOpen(false);
    },
  },
];

export function Walkthrough(): JSX.Element | null {
  const step = useRadar((s) => s.tourStep);
  const nextStep = useRadar((s) => s.nextTourStep);
  const prevStep = useRadar((s) => s.prevTourStep);
  const endTour = useRadar((s) => s.endTour);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // First-visit prompt — only on the first page load that has no SEEN flag.
  const [firstTimePrompt, setFirstTimePrompt] = useState<boolean>(() => {
    try { return localStorage.getItem(SEEN_KEY) == null; } catch { return false; }
  });

  // Recompute spotlight rect on step / window resize / target appears.
  useEffect(() => {
    if (step == null) { setRect(null); return; }
    const cur = STEPS[step];
    cur?.onShow?.();
    if (!cur?.target) { setRect(null); return; }

    const compute = (): void => {
      const el = document.querySelector(cur.target!);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    // Wait one frame so any side-effect (drawer animation, panel switch)
    // settles before we measure.
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(compute));
    window.addEventListener("resize", compute);
    const interval = setInterval(compute, 600); // catches late mounts (drawer opening)
    return () => {
      cancelAnimationFrame(raf1);
      window.removeEventListener("resize", compute);
      clearInterval(interval);
    };
  }, [step]);

  useEffect(() => {
    if (step == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") advance();
      else if (e.key === "ArrowLeft") prevStep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function advance(): void {
    if (step == null) return;
    if (step >= STEPS.length - 1) finish();
    else nextStep();
  }
  function finish(): void {
    try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* ignore */ }
    setFirstTimePrompt(false);
    endTour();
  }

  // First-time prompt — small centered card asking if they want the tour.
  if (firstTimePrompt && step == null) {
    return (
      <div className="tour-backdrop" onClick={() => { setFirstTimePrompt(false); try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* ignore */ } }}>
        <div className="tour-card" onClick={(e) => e.stopPropagation()}>
          <div className="tour-card-title">First time here?</div>
          <p className="tour-card-body">
            Quick 60-second tour of the radar — what every part does, how
            to read it, where the cool stuff lives.
          </p>
          <div className="tour-card-actions">
            <button className="btn" onClick={() => { setFirstTimePrompt(false); try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* ignore */ } }}>Skip</button>
            <button className="btn btn-primary" onClick={() => { setFirstTimePrompt(false); useRadar.getState().startTour(); }}>Start tour</button>
          </div>
        </div>
      </div>
    );
  }

  if (step == null) return null;
  const cur = STEPS[step];
  if (!cur) return null;

  const cutoutPad = 10;
  return (
    <div className="tour-overlay" role="dialog" aria-modal>
      {rect ? (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top - cutoutPad,
            left: rect.left - cutoutPad,
            width: rect.width + cutoutPad * 2,
            height: rect.height + cutoutPad * 2,
          }}
        />
      ) : (
        <div className="tour-spotlight-full" />
      )}
      <div className="tour-card" style={tourCardPosition(rect)} onClick={(e) => e.stopPropagation()}>
        <div className="tour-card-step muted">Step {step + 1} of {STEPS.length}</div>
        <div className="tour-card-title">{cur.title}</div>
        <p className="tour-card-body">{cur.body}</p>
        <div className="tour-card-actions">
          <button className="btn" onClick={finish}>Skip tour</button>
          {step > 0 && <button className="btn" onClick={prevStep}>Back</button>}
          <button className="btn btn-primary" onClick={advance}>
            {step >= STEPS.length - 1 ? "Done" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Position the tour copy card near the spotlight without overlapping it.
 *  When there's no target (intro / outro), the card centers on screen. */
function tourCardPosition(rect: DOMRect | null): React.CSSProperties {
  if (!rect) {
    return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  }
  const cardW = 340;
  const margin = 16;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  // Prefer placing the card below the spotlight; fall back to above when
  // there's not enough room.
  const belowRoom = viewportH - rect.bottom;
  const verticalAnchor = belowRoom >= 220 ? "below" : "above";
  const top = verticalAnchor === "below"
    ? Math.min(viewportH - 200 - margin, rect.bottom + margin)
    : Math.max(margin, rect.top - 220);
  // Center horizontally on the target where possible, clamp to viewport.
  let left = rect.left + rect.width / 2 - cardW / 2;
  if (left < margin) left = margin;
  if (left + cardW > viewportW - margin) left = viewportW - margin - cardW;
  return { left, top, width: cardW };
}

/* ─── Help (?) button + menu ────────────────────────────────────────── */

const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: "Why doesn't a plane I expect to see show up?",
    a: "Two reasons: it's below the radar horizon (too low at too great a distance), or it's behind terrain / a building. The Pi sees about 200 nm in clear conditions for high cruisers and much less for low planes. If a friend's flight is below 10,000 ft 100 nm away, you probably won't pick it up.",
  },
  {
    q: "What do the colors mean?",
    a: "Plane icon color = altitude. Red near surface, yellow low, green at cruise, blue and purple for jets at FL350+. Open the legend bottom-left for the full key.",
  },
  {
    q: "Why is the route on this plane wrong?",
    a: "Free route data (adsb.lol + adsbdb) is static — it's keyed off the callsign and doesn't always know which leg of a multi-stop rotation today's flight is. The radar sanity-checks against the plane's position and hides routes that don't match, but sometimes the data is just stale. AeroAPI (paid) has live flight plans.",
  },
  {
    q: "How do I get an alert for my actual flight?",
    a: "Settings → Watch a flight. Add the callsign (DL2864), name it, set the date. A big alert fires when that exact flight crosses the radar on the right day.",
  },
  {
    q: "How do I add my home WiFi?",
    a: "Settings → WiFi → Scan for nearby networks → pick yours → enter the password. The Pi will switch over once you save.",
  },
  {
    q: "What's the PIN for?",
    a: "Settings tab is PIN-gated so visitors with the URL can't change configuration. Default is 0000 (changed from setup if you set one). Owner master is in the install docs.",
  },
];

export function HelpButton(): JSX.Element {
  const [menu, setMenu] = useState<"closed" | "menu" | "faq">("closed");
  const startTour = useRadar((s) => s.startTour);
  return (
    <>
      <button
        className="iconbtn glass"
        onClick={() => setMenu(menu === "closed" ? "menu" : "closed")}
        aria-label="Help"
        title="Help"
      >
        ?
      </button>
      {menu !== "closed" && (
        <div className="tour-backdrop" onClick={() => setMenu("closed")}>
          <div className="tour-card" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            {menu === "menu" && (
              <>
                <div className="tour-card-title">Help</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => { setMenu("closed"); startTour(); }}>
                    ⚡ Replay express tour
                  </button>
                  <button className="btn" onClick={() => setMenu("faq")}>
                    ❓ Frequently asked
                  </button>
                </div>
              </>
            )}
            {menu === "faq" && (
              <>
                <div className="tour-card-title">FAQ</div>
                <div className="tour-faq scroll">
                  {FAQ_ITEMS.map((item, i) => (
                    <div key={i} className="tour-faq-item">
                      <div className="tour-faq-q">{item.q}</div>
                      <div className="tour-faq-a">{item.a}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  <button className="btn" onClick={() => setMenu("menu")}>← Back</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
