import { useState, type ReactNode } from "react";
import "./setup.css";
import { BASE, api, geocodeCity, type GeoResult } from "../api";
import { useRadar } from "../store";
import { ThemeToggle } from "../components/ThemeToggle";

const CAPTAIN_AVATAR = `${BASE}/brand/CaptainQIcon-BGRVD.PNG`;

function CaptainQ({ children }: { children: ReactNode }): JSX.Element {
  const captainUrl = useRadar((s) => s.config?.brand.captainUrl) ?? CAPTAIN_AVATAR;
  return (
    <div className="captain">
      <img className="captain-avatar" src={captainUrl} alt="CaptainQ" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
      <div className="bubble">
        <span className="who">CaptainQ</span>
        {children}
      </div>
    </div>
  );
}

const STEPS = ["WiFi", "Location", "FlightAware", "FlightRadar24", "Done"] as const;

export function Setup(): JSX.Element {
  const config = useRadar((s) => s.config);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [step, setStep] = useState(0);

  async function tryUnlock(value: string): Promise<void> {
    const res = await api.verifyPin(value).catch(() => ({ ok: false }));
    if (res.ok) {
      setUnlocked(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPin("");
    }
  }

  if (!unlocked) {
    return (
      <div className="setup">
        <div className="page-toggle"><ThemeToggle className="glass" /></div>
        <div className="glass setup-card">
          <img className="setup-logo" src={config?.brand.logoUrl ?? `${BASE}/brand/logo.svg`} alt="QDRN" onError={(e) => (e.currentTarget.style.display = "none")} />
          <CaptainQ>
            Ahoy! I'm <b>CaptainQ</b>, your setup guide. Punch in the device PIN and I'll
            walk you through getting your radar online. 🫡
          </CaptainQ>
          <PinPad
            pin={pin}
            error={pinError}
            onChange={(v) => {
              setPin(v);
              setPinError(false);
              if (v.length >= 4) void tryUnlock(v);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="page-toggle"><ThemeToggle className="glass" /></div>
      <div className="glass setup-card">
        <img className="setup-logo" src={config?.brand.logoUrl ?? `${BASE}/brand/logo.svg`} alt="QDRN" onError={(e) => (e.currentTarget.style.display = "none")} />
        <div className="steps-dots">
          {STEPS.map((_, i) => (
            <span key={i} className={`d${i === step ? " on" : i < step ? " done" : ""}`} />
          ))}
        </div>

        {step === 0 && <WifiStep onNext={() => setStep(1)} />}
        {step === 1 && <LocationStep pin={pin} onNext={() => setStep(2)} onBack={() => setStep(0)} />}
        {step === 2 && <FlightAwareStep pin={pin} onNext={() => setStep(3)} onBack={() => setStep(1)} />}
        {step === 3 && <FlightRadarStep pin={pin} onNext={() => setStep(4)} onBack={() => setStep(2)} />}
        {step === 4 && <DoneStep />}
      </div>
    </div>
  );
}

function PinPad({ pin, error, onChange }: { pin: string; error: boolean; onChange: (v: string) => void }): JSX.Element {
  const press = (d: string) => onChange((pin + d).slice(0, 6));
  const del = () => onChange(pin.slice(0, -1));
  return (
    <div>
      <div className="pin-dots">
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <span key={i} className={`pin-dot${i < pin.length ? " filled" : ""}`} />
        ))}
      </div>
      {error && <div style={{ color: "var(--danger)", textAlign: "center", marginBottom: 10 }}>That PIN didn't work — try again.</div>}
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} onClick={() => press(d)}>{d}</button>
        ))}
        <button onClick={del} aria-label="Delete">⌫</button>
        <button onClick={() => press("0")}>0</button>
        <button onClick={() => onChange("")} aria-label="Clear">C</button>
      </div>
    </div>
  );
}

function WifiStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div>
      <CaptainQ>
        First mate, your radar is already <span className="status-ok">online</span> — that's how
        you're seeing me! If you ever move the device or change your WiFi, just power it off and
        on; I'll pop up a <b>“QDRN-Radar-Setup”</b> WiFi network for you to reconnect.
      </CaptainQ>
      <h2 className="step-title">WiFi connected</h2>
      <div className="connected-badge">✓ Connected to your network</div>
      <p className="step-sub">Need to change networks later? Look for the <b>QDRN-Radar-Setup</b> hotspot on your phone's WiFi list and follow the prompts.</p>
      <div className="row">
        <button className="btn btn-primary btn-block" onClick={onNext}>Next: Location →</button>
      </div>
    </div>
  );
}

function LocationStep({ pin, onNext, onBack }: { pin: string; onNext: () => void; onBack: () => void }): JSX.Element {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [chosen, setChosen] = useState<GeoResult | null>(null);
  const [saving, setSaving] = useState(false);

  async function search(): Promise<void> {
    if (q.trim().length < 2) return;
    setResults(await geocodeCity(q.trim()));
  }
  async function save(): Promise<void> {
    if (!chosen) return;
    setSaving(true);
    // City-level only: round to ~city precision so the exact home isn't stored.
    const lat = Math.round(chosen.lat * 100) / 100;
    const lon = Math.round(chosen.lon * 100) / 100;
    const city = chosen.name.split(",").slice(0, 2).join(",").trim();
    await api.saveLocation(pin, city, lat, lon).catch(() => undefined);
    setSaving(false);
    onNext();
  }

  return (
    <div>
      <CaptainQ>
        Where am I stationed? Type your <b>town or city</b> and pick it from the list. I only
        keep it roughly — never your exact address — just enough to center the map. 🗺️
      </CaptainQ>
      <h2 className="step-title">Set your location</h2>
      <label className="label">Town / city</label>
      <form onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ display: "flex", gap: 8 }}>
        <input className="input" placeholder="e.g. Annapolis, MD" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn">Search</button>
      </form>
      {results.length > 0 && (
        <div className="geo-results">
          {results.map((r, i) => (
            <button key={i} onClick={() => { setChosen(r); setResults([]); setQ(r.name.split(",").slice(0, 2).join(", ")); }}>
              {r.name}
            </button>
          ))}
        </div>
      )}
      {chosen && <div className="connected-badge" style={{ marginTop: 12 }}>✓ {chosen.name.split(",").slice(0, 2).join(", ")}</div>}
      <div className="row">
        <button className="btn" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" disabled={!chosen || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Next →"}
        </button>
      </div>
    </div>
  );
}

function FlightAwareStep({ pin, onNext, onBack }: { pin: string; onNext: () => void; onBack: () => void }): JSX.Element {
  const [feederId, setFeederId] = useState("");
  const [aeroKey, setAeroKey] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    await api.saveKeys(pin, { piawareFeederId: feederId.trim(), flightAwareAeroApi: aeroKey.trim() }).catch(() => undefined);
    setSaving(false);
    onNext();
  }

  return (
    <div>
      <CaptainQ>
        Let's hook up <b>FlightAware</b>. Feeding them data from your radar earns you a free
        <b> Enterprise account</b>! Make an account, then come back and paste your details. You can
        skip and do this later if you like.
      </CaptainQ>
      <h2 className="step-title">Connect FlightAware</h2>
      <ol className="steplist">
        <li>Create a free account at <a className="helplink" href="https://flightaware.com/account/join/" target="_blank" rel="noreferrer">flightaware.com ↗</a></li>
        <li>Claim this device + get your <b>Feeder ID</b> at <a href="https://flightaware.com/adsb/piaware/claim" target="_blank" rel="noreferrer">piaware/claim ↗</a></li>
        <li>(Optional) Generate an <b>AeroAPI key</b> at <a href="https://www.flightaware.com/aeroapi/" target="_blank" rel="noreferrer">AeroAPI ↗</a> for richer flight info</li>
      </ol>
      <label className="label">PiAware Feeder ID</label>
      <input className="input" placeholder="xxxxxxxx-xxxx-..." value={feederId} onChange={(e) => setFeederId(e.target.value)} />
      <label className="label">AeroAPI key (optional)</label>
      <input className="input" placeholder="Paste key" value={aeroKey} onChange={(e) => setAeroKey(e.target.value)} />
      <div className="row">
        <button className="btn" onClick={onBack}>← Back</button>
        <button className="btn" onClick={onNext}>Skip</button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save →"}</button>
      </div>
    </div>
  );
}

function FlightRadarStep({ pin, onNext, onBack }: { pin: string; onNext: () => void; onBack: () => void }): JSX.Element {
  const [sharingKey, setSharingKey] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    await api.saveKeys(pin, { fr24SharingKey: sharingKey.trim(), flightRadar24Token: apiToken.trim() }).catch(() => undefined);
    setSaving(false);
    onNext();
  }

  return (
    <div>
      <CaptainQ>
        Now <b>FlightRadar24</b>. Same deal — share your data and you can score a free
        <b> Business plan</b>. Sign up, grab your <b>sharing key</b>, and paste it below.
      </CaptainQ>
      <h2 className="step-title">Connect FlightRadar24</h2>
      <ol className="steplist">
        <li>Sign up at <a className="helplink" href="https://www.flightradar24.com/" target="_blank" rel="noreferrer">flightradar24.com ↗</a></li>
        <li>Start sharing + get your <b>sharing key</b> at <a href="https://www.flightradar24.com/share-your-data" target="_blank" rel="noreferrer">share-your-data ↗</a></li>
      </ol>
      <label className="label">FR24 sharing key</label>
      <input className="input" placeholder="Paste sharing key" value={sharingKey} onChange={(e) => setSharingKey(e.target.value)} />
      <label className="label">FR24 API token (optional)</label>
      <input className="input" placeholder="Paste token" value={apiToken} onChange={(e) => setApiToken(e.target.value)} />
      <div className="row">
        <button className="btn" onClick={onBack}>← Back</button>
        <button className="btn" onClick={onNext}>Skip</button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Finish →"}</button>
      </div>
    </div>
  );
}

function DoneStep(): JSX.Element {
  return (
    <div>
      <CaptainQ>
        All set, Captain! I'm firing up your feeders now — FlightAware and FlightRadar24 will
        start receiving your data within a minute or two (that's what earns your free pro
        accounts). Tap any plane to see where it's headed. Fair winds! ✈️
      </CaptainQ>
      <h2 className="step-title">You're all set! 🎉</h2>
      <p className="step-sub">Your radar is up and running. Open the live map to start tracking aircraft overhead.</p>
      <div className="row">
        <a className="btn btn-primary btn-block" href={`${BASE}/`} style={{ textAlign: "center", textDecoration: "none" }}>
          Open the radar →
        </a>
      </div>
    </div>
  );
}
