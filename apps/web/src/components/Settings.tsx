import { useEffect, useState } from "react";
import type { AdminSettings, ConnStatus, Connections } from "@qdrn/shared";
import { BASE, api, geocodeCity, type GeoResult } from "../api";
import { useRadar } from "../store";

const PIN_KEY = "qdrn-pin";

const KEY_FIELDS: { field: keyof AdminSettings["keys"]; label: string; feeder: boolean }[] = [
  { field: "flightAwareAeroApi", label: "FlightAware AeroAPI", feeder: false },
  { field: "piawareFeederId", label: "PiAware Feeder ID", feeder: true },
  { field: "fr24SharingKey", label: "FR24 Sharing Key", feeder: true },
  { field: "flightRadar24Token", label: "FR24 API Token", feeder: false },
];

function statusInfo(status: ConnStatus | undefined, set: boolean, feeder: boolean): { cls: string; label: string } {
  const st = status ?? (set ? "unknown" : "unset");
  switch (st) {
    case "ok":
      return { cls: "on", label: feeder ? "feeding" : "connected" };
    case "invalid":
      return { cls: "bad", label: "invalid key" };
    case "down":
      return { cls: "bad", label: "not feeding" };
    case "error":
      return { cls: "warn", label: "error" };
    case "unknown":
      return set ? { cls: "warn", label: "set (unverified)" } : { cls: "", label: "not set" };
    default:
      return { cls: "", label: "not set" };
  }
}

export function Settings(): JSX.Element {
  const setConfig = useRadar((s) => s.setConfig);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [entry, setEntry] = useState("");
  const [err, setErr] = useState(false);
  const [s, setS] = useState<AdminSettings | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pinSet, setPinSet] = useState(true);
  const [conn, setConn] = useState<Connections | null>(null);
  const [checking, setChecking] = useState(false);

  async function loadConn(p: string, force = false): Promise<void> {
    setChecking(true);
    try {
      setConn(await api.connections(p, force));
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  }

  async function load(p: string): Promise<boolean> {
    try {
      const data = await api.settings(p);
      setS(data);
      setPin(p);
      setUnlocked(true);
      setErr(false);
      sessionStorage.setItem(PIN_KEY, p);
      void loadConn(p);
      return true;
    } catch {
      sessionStorage.removeItem(PIN_KEY);
      return false;
    }
  }

  useEffect(() => {
    api.pinStatus().then((p) => setPinSet(p.pinSet)).catch(() => undefined);
    const saved = sessionStorage.getItem(PIN_KEY);
    if (saved) void load(saved);
  }, []);

  async function refreshConfig(): Promise<void> {
    await api.config().then(setConfig).catch(() => undefined);
  }

  if (!unlocked) {
    if (!pinSet) {
      return (
        <div className="scroll" style={{ flex: 1 }}>
          <p className="muted" style={{ fontSize: 13 }}>
            This radar hasn't been set up yet. Run the one-time guided setup to create a PIN and set your location.
          </p>
          <a className="btn btn-primary btn-block" href={`${BASE}/setup`} style={{ textAlign: "center", textDecoration: "none" }}>
            Start setup →
          </a>
        </div>
      );
    }
    return (
      <div className="scroll" style={{ flex: 1 }}>
        <p className="muted" style={{ fontSize: 13 }}>Enter your device PIN to view and change settings.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            inputMode="numeric"
            type="password"
            placeholder="PIN"
            value={entry}
            onChange={(e) => { setEntry(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(false); }}
            onKeyDown={(e) => e.key === "Enter" && entry.length >= 4 && void load(entry).then((ok) => !ok && setErr(true))}
          />
          <button className="btn btn-primary" disabled={entry.length < 4} onClick={() => void load(entry).then((ok) => !ok && setErr(true))}>
            Unlock
          </button>
        </div>
        {err && <div style={{ color: "var(--danger)", marginTop: 8 }}>That PIN didn't work.</div>}
      </div>
    );
  }

  if (!s) return <div className="muted" style={{ padding: 12 }}>Loading…</div>;

  return (
    <div className="scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Pilot name */}
      <NameEditor pin={pin} initial={s.pilotName} onSaved={() => void refreshConfig()} />

      {/* Connection pills */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="label">Connections</div>
          <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={checking} onClick={() => void loadConn(pin, true)}>
            {checking ? "Checking…" : "Re-check"}
          </button>
        </div>
        <LocationPill
          pin={pin}
          city={s.receiver.city}
          county={s.receiver.county}
          expanded={open === "location"}
          onToggle={() => setOpen(open === "location" ? null : "location")}
          onSaved={async () => { await load(pin); await refreshConfig(); setOpen(null); }}
        />
        {KEY_FIELDS.map(({ field, label, feeder }) => (
          <KeyPill
            key={field}
            label={label}
            value={s.keys[field]}
            status={conn?.[field]}
            feeder={feeder}
            expanded={open === field}
            onToggle={() => setOpen(open === field ? null : field)}
            onSave={async (v) => { await api.saveKeys(pin, { [field]: v }); await load(pin); setOpen(null); }}
          />
        ))}
      </div>

      {/* Shared API gateway */}
      <GatewaySection pin={pin} gateway={s.gateway} onSaved={() => void load(pin)} />

      {/* AeroAPI usage + spend guard (direct mode; the gateway meters its own) */}
      {!(s.gateway.url && s.gateway.key) && <AeroSection pin={pin} aero={s.aero} onChanged={() => void load(pin)} />}

      {/* WiFi */}
      <div className="set-card">
        <div className="label" style={{ marginTop: 0 }}>WiFi network</div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          To join a different WiFi, the radar opens a <b>“QDRN-Radar-Setup”</b> hotspot when it can't reach a known
          network. Power-cycle it where the old network is unavailable, connect your phone to that hotspot, and pick
          the new network. (Switching from here isn't possible — the radar app can't change the Pi's WiFi directly.)
        </p>
      </div>
    </div>
  );
}

function NameEditor({ pin, initial, onSaved }: { pin: string; initial: string; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(initial);
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <div className="label" style={{ marginTop: 0 }}>Pilot name</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          placeholder="e.g. Collin (blank → “Hello Pilot!”)"
          value={name}
          maxLength={40}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
        />
        <button className="btn" onClick={async () => { await api.saveName(pin, name); setSaved(true); onSaved(); }}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}

function LocationPill({
  pin, city, county, expanded, onToggle, onSaved,
}: { pin: string; city: string; county?: string; expanded: boolean; onToggle: () => void; onSaved: () => void }): JSX.Element {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  return (
    <div className="set-pill-wrap">
      <button className="set-pill on" onClick={onToggle}>
        <span className="dot" />
        <span className="set-pill-label">Location</span>
        <span className="set-pill-val">{city}{county ? ` · ${county}` : ""}</span>
      </button>
      {expanded && (
        <div className="set-pill-body">
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="Search a city…" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)} />
            <button className="btn" onClick={() => q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)}>Search</button>
          </div>
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} className="btn set-result"
              onClick={async () => {
                const lat = Math.round(r.lat * 100) / 100;
                const lon = Math.round(r.lon * 100) / 100;
                await api.saveLocation(pin, r.label, lat, lon, r.county);
                onSaved();
              }}>
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function KeyPill({
  label, value, status, feeder, expanded, onToggle, onSave,
}: {
  label: string;
  value: string;
  status: ConnStatus | undefined;
  feeder: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSave: (v: string) => Promise<void>;
}): JSX.Element {
  const set = value.trim().length > 0;
  const { cls, label: statusLabel } = statusInfo(status, set, feeder);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="set-pill-wrap">
      <button className={`set-pill ${cls}`} onClick={onToggle}>
        <span className="dot" />
        <span className="set-pill-label">{label}</span>
        <span className="set-pill-val">{statusLabel}</span>
      </button>
      {expanded && (
        <div className="set-pill-body">
          <input className="input" placeholder="Paste value" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => void onSave(draft.trim())}>Save</button>
        </div>
      )}
    </div>
  );
}

function GatewaySection({
  pin, gateway, onSaved,
}: { pin: string; gateway: AdminSettings["gateway"]; onSaved: () => void }): JSX.Element {
  const [url, setUrl] = useState(gateway.url);
  const [key, setKey] = useState(gateway.key);
  const [saved, setSaved] = useState(false);
  const on = Boolean(gateway.url && gateway.key);
  return (
    <div className="set-card">
      <div className="label" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
        Shared API gateway <span className={`pill${on ? "" : " danger"}`}>{on ? "active" : "off"}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Route paid lookups through your gateway (ops.qdrn.io) instead of a local key. Leave blank to use a local key.
      </p>
      <input className="input" style={{ marginBottom: 8 }} placeholder="https://ops.qdrn.io" value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }} />
      <input className="input" placeholder="Device key" value={key} onChange={(e) => { setKey(e.target.value); setSaved(false); }} />
      <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={async () => { await api.saveGateway(pin, url.trim(), key.trim()); setSaved(true); onSaved(); }}>
        {saved ? "Saved ✓" : "Save gateway"}
      </button>
    </div>
  );
}

function AeroSection({ pin, aero, onChanged }: { pin: string; aero: AdminSettings["aero"]; onChanged: () => void }): JSX.Element {
  const [cap, setCap] = useState("");
  const pct = aero.cap > 0 ? Math.min(100, Math.round((aero.used / aero.cap) * 100)) : 100;
  const over = aero.cap > 0 && aero.used >= aero.cap;
  return (
    <div className="set-card">
      <div className="label" style={{ marginTop: 0 }}>AeroAPI usage</div>
      {!aero.keyPresent && <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>No FlightAware key — routes use free sources only.</div>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          {aero.used} used in {aero.month}{aero.cap > 0 ? ` · cap ${aero.cap}` : " · no cap"}
        </div>
        <button className="btn" style={{ padding: "6px 12px", whiteSpace: "nowrap" }}
          onClick={async () => { await api.saveAero(pin, { enabled: !aero.enabled }); onChanged(); }}>
          {aero.enabled ? "Disable (free only)" : "Enable"}
        </button>
      </div>
      <div style={{ height: 6, margin: "10px 0", borderRadius: 3, background: "rgba(128,128,128,0.22)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: 3, background: over ? "var(--danger)" : "var(--accent)" }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" inputMode="numeric" placeholder={`cap (${aero.cap || "0 = unlimited"})`} value={cap}
          onChange={(e) => setCap(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button className="btn" onClick={async () => { await api.saveAero(pin, { cap: Number(cap || aero.cap) }); setCap(""); onChanged(); }}>Set cap</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        Free tier is ~$5/month of credit (more for ADS-B feeders). Past the cap, routes fall back to free sources.
      </p>
    </div>
  );
}
