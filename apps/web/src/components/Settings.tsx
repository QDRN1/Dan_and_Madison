import { useEffect, useState } from "react";
import type { AdminSettings, ConnStatus, Connections, FlightWatch, GatewayInfo, WifiNetwork, WifiScanResult } from "@qdrn/shared";
import { BASE, api, cityCenter, geocodeCity, type GeoResult } from "../api";
import { useRadar, type IconTheme } from "../store";

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
    case "blocked":
      return { cls: "warn", label: "over limit" };
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
  const [isMaster, setIsMaster] = useState(false);
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
      // Check whether this PIN authenticated via the master override so the
      // hidden admin card can appear. /setup/verify-pin returns { master:true }
      // only when the master PIN was provided; user PIN never sets it true.
      api.verifyPin(p).then((r) => setIsMaster(Boolean(r.master))).catch(() => setIsMaster(false));
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
      {/* 1. WiFi */}
      <WifiSection pin={pin} />

      {/* 2. Pilot name */}
      <NameEditor pin={pin} initial={s.pilotName} onSaved={() => void refreshConfig()} />

      {/* 3. Location — standalone (was nested in Connections) */}
      <LocationSection
        pin={pin}
        city={s.receiver.city}
        county={s.receiver.county}
        onSaved={async () => { await load(pin); await refreshConfig(); }}
      />

      {/* 4. Map plane icon (Theme) */}
      <IconThemeSection />

      {/* 5. "Not on my radar" — adsb.lol fill-in for planes outside reception */}
      <OffRadarSection pin={pin} enabled={s.offRadarEnabled} onChanged={() => void load(pin)} />

      {/* 5b. Flight watches (custom alerts on a specific callsign) */}
      <WatchesSection pin={pin} />

      {/* 6. Shared API gateway */}
      <GatewaySection pin={pin} gateway={s.gateway} status={conn?.gateway} info={conn?.gatewayInfo} onSaved={() => void load(pin)} />

      {/* 7. Connections — flat, never collapsed (adsb.lol pinned on top) */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="label">Connections</div>
          <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={checking} onClick={() => void loadConn(pin, true)}>
            {checking ? "Checking…" : "Re-check"}
          </button>
        </div>
        <AdsblolPill
          pin={pin}
          enabled={s.adsblolEnabled}
          status={conn?.adsblol}
          expanded={open === "adsblol"}
          onToggle={() => setOpen(open === "adsblol" ? null : "adsblol")}
          onChanged={() => void load(pin)}
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

      {/* 8. AeroAPI usage + spend guard (direct mode; the gateway meters its own) */}
      {!(s.gateway.url && s.gateway.key) && <AeroSection pin={pin} aero={s.aero} onChanged={() => void load(pin)} />}

      {/* Owner-only admin (master PIN) */}
      {isMaster && <AdminSection pin={pin} />}

      {/* 9. Change PIN */}
      <PinSection currentPin={pin} onChanged={(p) => { sessionStorage.setItem(PIN_KEY, p); setPin(p); }} />
    </div>
  );
}

function NameEditor({ pin, initial, onSaved }: { pin: string; initial: string; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Pilot name
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {initial?.trim() || "—"}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
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
      )}
    </div>
  );
}

/** Standalone collapsible Location card (was nested under Connections as a
 *  pill, but the user wants it as a top-level item so its current city is
 *  always visible without expanding Connections). */
function LocationSection({
  pin, city, county, onSaved,
}: { pin: string; city: string; county?: string; onSaved: () => void }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  return (
    <div className="set-card">
      <button className="set-collapse-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Location
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {city}{county ? ` · ${county}` : ""}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="Address or city (we center on the nearest town)" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)} />
            <button className="btn" onClick={() => q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)}>Search</button>
          </div>
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} className="btn set-result"
              onClick={async () => {
                const center = r.city ? await cityCenter(r.city, r.state) : null;
                const lat = Math.round((center?.lat ?? r.lat) * 100) / 100;
                const lon = Math.round((center?.lon ?? r.lon) * 100) / 100;
                await api.saveLocation(pin, r.label, lat, lon, r.county);
                setExpanded(false);
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
            <input className="input" placeholder="Address or city (we center on the nearest town)" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)} />
            <button className="btn" onClick={() => q.trim().length >= 2 && geocodeCity(q.trim()).then(setResults)}>Search</button>
          </div>
          {results.map((r) => (
            <button key={`${r.lat},${r.lon}`} className="btn set-result"
              onClick={async () => {
                // Try to snap to city center; fall back to the address coords.
                const center = r.city ? await cityCenter(r.city, r.state) : null;
                const lat = Math.round((center?.lat ?? r.lat) * 100) / 100;
                const lon = Math.round((center?.lon ?? r.lon) * 100) / 100;
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

/** adsb.lol pinned to the top of Connections. Same row layout as KeyPill so
 *  the list reads as a single column of services; on expand the body is a
 *  short paragraph + an on/off toggle (no key to paste). */
function AdsblolPill({
  pin, enabled, status, expanded, onToggle, onChanged,
}: {
  pin: string;
  enabled: boolean;
  status: ConnStatus | undefined;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const st = ADSB_STATUS[status ?? (enabled ? "unknown" : "unset")];
  return (
    <div className="set-pill-wrap">
      <button className={`set-pill ${st.cls}`} onClick={onToggle}>
        <span className="dot" />
        <span className="set-pill-label">adsb.lol routes</span>
        <span className="set-pill-val">{st.label}</span>
      </button>
      {expanded && (
        <div className="set-pill-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Free position-aware route source — picks the leg the plane is
            actually flying when a callsign has a multi-stop rotation.
            Disable only if all lookups go through AeroAPI.
          </p>
          <button
            className="btn btn-block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await api.saveAdsblol(pin, !enabled); onChanged(); }
              finally { setBusy(false); }
            }}
          >
            {busy ? "Saving…" : enabled ? "Disable adsb.lol" : "Enable adsb.lol"}
          </button>
        </div>
      )}
    </div>
  );
}

const GW_STATUS: Record<ConnStatus, { cls: string; label: string }> = {
  ok: { cls: "on", label: "active" },
  blocked: { cls: "warn", label: "over limit — using free routes" },
  invalid: { cls: "bad", label: "bad device key" },
  down: { cls: "bad", label: "unreachable" },
  error: { cls: "warn", label: "error" },
  unknown: { cls: "warn", label: "unknown" },
  unset: { cls: "", label: "off" },
};

function GatewaySection({
  pin, gateway, status, info, onSaved,
}: {
  pin: string;
  gateway: AdminSettings["gateway"];
  status: ConnStatus | undefined;
  info: GatewayInfo | undefined;
  onSaved: () => void;
}): JSX.Element {
  const [url, setUrl] = useState(gateway.url);
  const [key, setKey] = useState(gateway.key);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const configured = Boolean(gateway.url && gateway.key);
  const st = GW_STATUS[status ?? (configured ? "unknown" : "unset")];
  const pct = info?.limit && info.limit > 0 && info.used != null ? Math.min(100, Math.round((info.used / info.limit) * 100)) : null;
  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Shared API gateway
        </span>
        <span className={`set-pill ${st.cls}`} style={{ width: "auto", padding: "3px 10px", gap: 7, marginRight: 6 }}>
          <span className="dot" /> {st.label}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Route paid lookups through your gateway (ops.qdrn.io) instead of a local key. Leave blank to use a local key.
          </p>

          {configured && info && (info.used != null || info.limit != null) && (
            <>
              <div className="muted" style={{ fontSize: 12 }}>
                {info.used ?? "?"}{info.limit ? ` / ${info.limit}` : ""} used
                {info.remaining != null ? ` · ${info.remaining} left` : ""}
                {info.resets ? ` · resets ${new Date(info.resets).toLocaleDateString()}` : info.resets === null ? " · no reset" : ""}
              </div>
              {pct != null && (
                <div style={{ height: 6, margin: "8px 0", borderRadius: 3, background: "rgba(128,128,128,0.22)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, borderRadius: 3, background: status === "blocked" ? "var(--danger)" : "var(--accent)" }} />
                </div>
              )}
            </>
          )}

          <input className="input" style={{ marginBottom: 8 }} placeholder="https://api.qdrn.io" value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }} />
          <input className="input" placeholder="Device key" value={key} onChange={(e) => { setKey(e.target.value); setSaved(false); }} />
          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={async () => { await api.saveGateway(pin, url.trim(), key.trim()); setSaved(true); onSaved(); }}>
            {saved ? "Saved ✓" : "Save gateway"}
          </button>
        </div>
      )}
    </div>
  );
}

function signalLevel(signal: number): 1 | 2 | 3 | 4 {
  if (signal >= 75) return 4;
  if (signal >= 50) return 3;
  if (signal >= 25) return 2;
  return 1;
}

function SignalBars({ signal }: { signal?: number }): JSX.Element {
  const lvl = signal == null ? 0 : signalLevel(signal);
  return (
    <span className={`signal s${lvl}`}>
      <span className="bar b1" /><span className="bar b2" />
      <span className="bar b3" /><span className="bar b4" />
    </span>
  );
}

const ADSB_STATUS: Record<ConnStatus, { cls: string; label: string }> = {
  ok: { cls: "on", label: "reachable" },
  blocked: { cls: "warn", label: "blocked" },
  invalid: { cls: "bad", label: "invalid" },
  down: { cls: "bad", label: "unreachable" },
  error: { cls: "warn", label: "error" },
  unknown: { cls: "warn", label: "unknown" },
  unset: { cls: "", label: "off" },
};

function OffRadarSection({
  pin, enabled, onChanged,
}: { pin: string; enabled: boolean; onChanged: () => void }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Off-radar fill (adsb.lol)
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>{enabled ? "on" : "off"}</span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Pulls planes within ~1.2× your widest range ring from the adsb.lol
            global feed so terrain shadows / horizon drop-outs aren't dead
            zones. Off-radar planes render dimmed and tagged 📡 in the list.
            Local readings always win. Refreshes every 20s; respects the
            master adsb.lol toggle.
          </p>
          <button
            className="btn btn-block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await api.saveOffRadar(pin, !enabled); onChanged(); }
              finally { setBusy(false); }
            }}
          >
            {busy ? "Saving…" : enabled ? "Disable off-radar fill" : "Enable off-radar fill"}
          </button>
        </div>
      )}
    </div>
  );
}

/** User-managed flight-watch list. Add a callsign (e.g. DL2864) and the
 *  poller fires a big alert when that exact flight enters the radar. */
function WatchesSection({ pin }: { pin: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [watches, setWatches] = useState<FlightWatch[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const reload = async (): Promise<void> => {
    try { const r = await api.listWatches(pin); setWatches(r.watches ?? []); }
    catch { /* offline */ }
  };
  useEffect(() => {
    if (!expanded) return;
    void reload();
    // Live re-poll while expanded so a fresh fire shows up without manual refresh.
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, pin]);

  async function add(): Promise<void> {
    if (!draft.trim()) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.addWatch(pin, draft.trim());
      if (r.ok) { setDraft(""); await reload(); }
      else setMsg(r.error ?? "Couldn't add.");
    } finally { setBusy(false); }
  }
  async function remove(id: number): Promise<void> {
    setBusy(true);
    try { await api.removeWatch(pin, id); await reload(); } finally { setBusy(false); }
  }
  async function reArm(id: number): Promise<void> {
    setBusy(true);
    try { await api.clearWatchFire(pin, id); await reload(); } finally { setBusy(false); }
  }

  const active = watches.filter((w) => !w.expires_at || w.expires_at > Date.now()).length;
  const fired = watches.filter((w) => w.fired_at).length;

  return (
    <div className="set-card">
      <button className="set-collapse-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Watch a flight
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>
          {watches.length === 0 ? "none" : `${active} watching${fired ? ` · ${fired} hit` : ""}`}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Add a callsign (DL2864, AAL100, BAW286). When that exact flight
            crosses the radar a big alert fires at the top and the plane is
            selected on the map. IATA prefixes are auto-converted to ICAO,
            so "DL" matches the "DAL" the receiver sees.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="DL2864"
              value={draft}
              onChange={(e) => { setDraft(e.target.value.toUpperCase()); setMsg(""); }}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void add()}>
              {busy ? "…" : "Add"}
            </button>
          </div>
          {msg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}
          {watches.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {watches.map((w) => {
                const isFired = Boolean(w.fired_at);
                return (
                  <div key={w.id} className="watch-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>
                        {w.raw_input}
                        {w.raw_input.toUpperCase() !== w.callsign && (
                          <span className="muted" style={{ fontWeight: 500, marginLeft: 6, fontSize: 12 }}>({w.callsign})</span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {isFired
                          ? `Seen ${fmtAgo(w.fired_at!)} · hex ${w.fired_hex?.toUpperCase()}`
                          : "Watching…"}
                      </div>
                    </div>
                    {isFired && (
                      <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} disabled={busy} onClick={() => void reArm(w.id)}>
                        Re-arm
                      </button>
                    )}
                    <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} disabled={busy} onClick={() => void remove(w.id)}>
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const ICON_CHOICES: { id: IconTheme; emoji: string; label: string; sub: string }[] = [
  { id: "plane", emoji: "✈️", label: "Classic", sub: "The airliner you know." },
  { id: "paw",   emoji: "🐾", label: "Paw prints", sub: "For Madison." },
  { id: "heart", emoji: "💛", label: "Hearts", sub: "Love is in the air." },
  { id: "ufo",   emoji: "🛸", label: "UFOs", sub: "It's classified." },
];

function IconThemeSection(): JSX.Element {
  const iconTheme = useRadar((s) => s.iconTheme);
  const setIconTheme = useRadar((s) => s.setIconTheme);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Map plane icon
        </span>
        <span style={{ marginRight: 6, fontSize: 18 }}>
          {ICON_CHOICES.find((c) => c.id === iconTheme)?.emoji ?? "✈️"}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {ICON_CHOICES.map((c) => (
            <button
              key={c.id}
              className={`btn icon-choice${iconTheme === c.id ? " active" : ""}`}
              onClick={() => setIconTheme(c.id)}
              type="button"
            >
              <span style={{ fontSize: 22 }}>{c.emoji}</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{c.label}</span>
              <span className="muted" style={{ fontSize: 11 }}>{c.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminSection({ pin }: { pin: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!expanded || info) return;
    api.deviceInfo(pin).then(setInfo).catch(() => undefined);
  }, [expanded, info, pin]);

  // CONFIRM is collected via a prompt AFTER clicking the destructive button.
  // Less to look at when admin is closed, harder to fat-finger from the wrong
  // device.
  async function runDestructive(label: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const code = window.prompt(`Type CONFIRM to ${label.toLowerCase()}:`);
    if (code == null) return; // cancelled
    if (code.trim().toUpperCase() !== "CONFIRM") { setMsg(`${label} cancelled — code didn't match.`); return; }
    setBusy(true); setMsg(`${label}…`);
    try {
      const r = await fn();
      setMsg(r.ok ? `${label} ✓` : `${label} failed: ${r.error ?? "unknown"}`);
      if (r.ok) setInfo(null);
    } catch (e) {
      setMsg(`${label} failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="set-card" style={{ borderColor: "var(--danger)" }}>
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--danger)" }}>
          🛠 Admin (owner)
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {info && (
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div><b>Uptime:</b> {info.uptimeHuman}</div>
              <div><b>Load:</b> {info.load1.toFixed(2)}, {info.load5.toFixed(2)}, {info.load15.toFixed(2)}</div>
              <div><b>Disk:</b> {info.diskUsedPct}% used ({info.diskFreeHuman} free)</div>
              <div><b>CPU temp:</b> {info.cpuTempF != null ? `${info.cpuTempF.toFixed(0)} °F` : "—"}</div>
              <div><b>Sightings rows:</b> {info.sightingsCount.toLocaleString()}</div>
              <div><b>Achievements:</b> {info.achievementsEarned}/{info.achievementsTotal} earned</div>
              <div><b>Build:</b> {info.buildSha?.slice(0, 7) ?? "unknown"}</div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" style={{ flex: 1, minWidth: 140 }} disabled={busy}
                    onClick={() => void runDestructive("Reset stats", () => api.adminResetStats(pin))}>
              Reset stats
            </button>
            <button className="btn" style={{ flex: 1, minWidth: 140 }} disabled={busy}
                    onClick={() => void runDestructive("Pull update", () => api.adminUpdate(pin))}>
              Pull update + restart
            </button>
            <button className="btn" style={{ flex: 1, minWidth: 140 }} disabled={busy}
                    onClick={() => void runDestructive("Restart radar", () => api.adminRestart(pin))}>
              Restart radar
            </button>
          </div>
          <button className="btn" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setMsg("Backfilling…");
                    try {
                      const r = await api.adminBackfillAchievements(pin);
                      setMsg(r.ok ? `Backfilled ${r.fired} unlocks from ${r.processed} sightings ✓` : `Backfill failed: ${r.error}`);
                      if (r.ok) setInfo(null);
                    } finally { setBusy(false); }
                  }}>
            Backfill achievements from sightings
          </button>
          <button className="btn" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setMsg("Probing achievement engine…");
                    try {
                      const d = await api.adminDiagnoseAchievements(pin);
                      const head = `rows ${d.rows}/${d.defined} · unlocked ${d.populated} · incStmt ${d.incStmtWorked ? "OK" : "FAIL"}`;
                      const fs = `first_sighting ${d.firstSightingBefore} → ${d.firstSightingAfter}`;
                      const top = d.topUnlocked.map((t) => `${t.id}=${t.count}`).join(", ") || "none";
                      const types = d.topTypes.map((t) => `${t.typeCode}=${t.count}`).join(", ") || "none";
                      const a38 = d.a38xSightings.length === 0
                        ? "no A38x rows in sightings — no Airbus A380 has been spotted yet"
                        : d.a38xSightings.map((s) => `${s.typeCode}${s.flight ? ` (${s.flight.trim()})` : ""}${s.operator ? ` · ${s.operator}` : ""}`).join("\n");
                      setMsg(`${head}\n${fs}${d.incStmtError ? `\nerror: ${d.incStmtError}` : ""}\ntop unlocked: ${top}\n\ntop types: ${types}\n\nA38x rows:\n${a38}`);
                    } finally { setBusy(false); }
                  }}>
            Diagnose achievement engine
          </button>
          <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
            Reset stats wipes the sightings/flagged/coverage/achievements tables (settings + WiFi profiles are kept).
            Pull update runs <code>git pull &amp;&amp; docker compose pull &amp;&amp; up -d</code> on the host.
          </p>
          {msg && <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

interface DeviceInfo {
  uptimeHuman: string;
  load1: number; load5: number; load15: number;
  diskUsedPct: number; diskFreeHuman: string;
  cpuTempF: number | null;
  sightingsCount: number;
  achievementsEarned: number; achievementsTotal: number;
  buildSha?: string;
}

function PinSection({ currentPin, onChanged }: { currentPin: string; onChanged: (newPin: string) => void }): JSX.Element {
  const [cur, setCur] = useState("");
  const [nxt, setNxt] = useState("");
  const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState(false);

  const digits = (s: string) => s.replace(/\D/g, "").slice(0, 6);

  async function change(): Promise<void> {
    if (!/^\d{4,6}$/.test(nxt)) { setMsg("New PIN must be 4–6 digits."); return; }
    if (nxt !== conf) { setMsg("New PINs don't match."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await api.setPin(nxt, cur);
      if (r.ok) {
        setMsg("PIN changed.");
        setCur(""); setNxt(""); setConf("");
        onChanged(nxt);
      } else {
        setMsg("Current PIN didn't match.");
      }
    } catch (e) {
      setMsg(`Couldn't change: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  async function resetToDefault(): Promise<void> {
    const master = window.prompt("Owner code required to reset the user PIN to default:");
    if (!master) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.resetUserPin(master);
      if (r.ok) {
        setMsg(`User PIN reset to ${r.pin}.`);
        onChanged(r.pin);
      } else {
        setMsg("Owner code didn't match.");
      }
    } catch (e) {
      setMsg(`Reset failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Change PIN
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <input className="input" inputMode="numeric" type="password" placeholder="Current PIN (or owner code)"
                 value={cur} onChange={(e) => { setCur(digits(e.target.value)); setMsg(""); }} />
          <input className="input" inputMode="numeric" type="password" placeholder="New PIN (4–6 digits)" style={{ marginTop: 8 }}
                 value={nxt} onChange={(e) => { setNxt(digits(e.target.value)); setMsg(""); }} />
          <input className="input" inputMode="numeric" type="password" placeholder="Confirm new PIN" style={{ marginTop: 8 }}
                 value={conf} onChange={(e) => { setConf(digits(e.target.value)); setMsg(""); }} />
          <button className="btn btn-primary" style={{ marginTop: 8 }}
                  disabled={busy || !cur || !nxt || !conf} onClick={() => void change()}>
            {busy ? "Saving…" : "Change PIN"}
          </button>
          <button className="btn" style={{ marginTop: 8, background: "transparent", borderStyle: "dashed", width: "100%" }}
                  disabled={busy} onClick={() => void resetToDefault()}>
            Forgot PIN? Reset to default
          </button>
          {msg && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

function WifiSection({ pin }: { pin: string }): JSX.Element {
  const [nets, setNets] = useState<WifiNetwork[] | null>(null);
  const [scan, setScan] = useState<WifiScanResult[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [pwDraft, setPwDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSsid, setAddSsid] = useState("");
  const [addPw, setAddPw] = useState("");
  const [expanded, setExpanded] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true); setErr("");
    try {
      const r = await api.wifiList(pin);
      if (!r.ok) { setErr(r.error ?? "couldn't list networks"); setNets([]); }
      else setNets(r.networks ?? []);
    } catch (e) {
      setErr((e as Error).message); setNets([]);
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function doScan(): Promise<void> {
    setScanning(true); setMsg("");
    try {
      const r = await api.wifiScan(pin);
      if (r.ok) setScan(r.networks ?? []);
      else setMsg(`Scan failed: ${r.error ?? "unknown"}`);
    } catch (e) { setMsg(`Scan failed: ${(e as Error).message}`); }
    finally { setScanning(false); }
  }

  async function connectTo(target: { name?: string; uuid?: string }, displayName: string): Promise<void> {
    if (!window.confirm(`Switch the radar to "${displayName}"?\n\nThe current WiFi will drop briefly while it connects — you may need to reload this page once it's back.`)) return;
    setBusy(true); setMsg(`Switching to ${displayName}…`);
    try {
      const r = await api.wifiConnect(pin, target);
      if (r.ok) { setMsg(`Switched to ${displayName}.`); await refresh(); }
      else setMsg(`Couldn't switch: ${r.error ?? "unknown"}`);
    } catch (e) { setMsg(`Couldn't switch: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function joinNew(ssid: string, password: string): Promise<void> {
    if (!window.confirm(`Save "${ssid}" and switch the radar to it now?\n\nThe current WiFi will drop briefly.`)) return;
    setBusy(true); setMsg(`Joining ${ssid}…`);
    try {
      const a = await api.wifiAdd(pin, ssid, password, 50);
      if (!a.ok) { setMsg(`Add failed: ${a.error ?? "unknown"}`); return; }
      const c = await api.wifiConnect(pin, { name: ssid });
      if (c.ok) {
        setMsg(`Connected to ${ssid}.`);
        setPasswordFor(null); setPwDraft(""); setScan(null);
        await refresh();
      } else {
        setMsg(`Saved but couldn't connect: ${c.error ?? "unknown"}`);
        await refresh();
      }
    } finally { setBusy(false); }
  }

  async function addOnly(): Promise<void> {
    const s = addSsid.trim();
    if (!s) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.wifiAdd(pin, s, addPw, 50);
      if (r.ok) {
        setMsg(`Saved "${s}". The radar will auto-join it when in range.`);
        setAddSsid(""); setAddPw(""); setAddOpen(false);
        await refresh();
      } else setMsg(`Add failed: ${r.error ?? "unknown"}`);
    } finally { setBusy(false); }
  }

  async function removeOne(n: WifiNetwork): Promise<void> {
    if (!window.confirm(`Remove saved network "${n.name}"? The radar won't auto-join it anymore.`)) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.wifiRemove(pin, { uuid: n.uuid, name: n.name });
      if (r.ok) await refresh();
      else setMsg(`Remove failed: ${r.error ?? "unknown"}`);
    } finally { setBusy(false); }
  }

  const active = nets?.find((n) => n.active)?.name;

  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          WiFi networks
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active ?? (nets ? `${nets.length} saved` : "…")}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {!expanded ? null : (
      <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={loading} onClick={() => void refresh()}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {err && <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {nets && nets.length === 0 && !err && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>No saved networks yet.</div>
      )}

      {nets && nets.length > 0 && (
        <div className="wifi-list" style={{ marginBottom: 10 }}>
          {nets.map((n) => (
            <div key={n.uuid || n.name} className={`wifi-row${n.active ? " active" : ""}`}>
              <span className="dot wifi-dot" style={{ background: n.active ? "var(--accent)" : "var(--muted)" }} />
              <div className="wifi-info">
                <div className="wifi-name">{n.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {n.active ? "connected · " : ""}
                  {n.autoconnect ? `auto · priority ${n.priority}` : "manual"}
                </div>
              </div>
              {n.active ? (
                <span className="pill" style={{ background: "var(--accent)", color: "var(--bg)", border: "none" }}>Active</span>
              ) : (
                <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy}
                        onClick={() => void connectTo({ uuid: n.uuid, name: n.name }, n.name)}>
                  Connect
                </button>
              )}
              <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy}
                      onClick={() => void removeOne(n)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Scan section */}
      <button className="btn btn-block" disabled={scanning} onClick={() => void doScan()} style={{ marginBottom: 8 }}>
        {scanning ? "Scanning…" : (scan ? "Scan again" : "Scan for nearby networks")}
      </button>

      {scan && scan.length === 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>Nothing nearby. Move closer to a WiFi router and scan again.</div>
      )}

      {scan && scan.length > 0 && (
        <div className="wifi-list" style={{ marginBottom: 10 }}>
          {scan.map((s) => {
            const saved = (nets ?? []).find((n) => n.name === s.ssid);
            if (passwordFor === s.ssid) {
              return (
                <div key={s.ssid} className="wifi-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SignalBars signal={s.signal} />
                    <div className="wifi-name" style={{ flex: 1 }}>{s.ssid}</div>
                  </div>
                  <input className="input" type="password" placeholder="WiFi password"
                         value={pwDraft} onChange={(e) => setPwDraft(e.target.value)}
                         autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy}
                            onClick={() => void joinNew(s.ssid, pwDraft)}>
                      Save & connect
                    </button>
                    <button className="btn" onClick={() => { setPasswordFor(null); setPwDraft(""); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <button key={s.ssid} className="wifi-row wifi-row-btn" disabled={busy}
                      onClick={() => {
                        if (saved) void connectTo({ uuid: saved.uuid, name: saved.name }, saved.name);
                        else if (s.secured) { setPasswordFor(s.ssid); setPwDraft(""); }
                        else void joinNew(s.ssid, "");
                      }}>
                <SignalBars signal={s.signal} />
                <div className="wifi-info">
                  <div className="wifi-name">
                    {s.ssid} {s.secured && <span className="muted" style={{ fontSize: 11 }}>🔒</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.security || "open"} · signal {s.signal}%
                  </div>
                </div>
                {saved && <span className="pill" style={{ fontSize: 10 }}>saved</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Manual add (hidden networks) */}
      <button className="btn" style={{ background: "transparent", borderStyle: "dashed", width: "100%" }}
              onClick={() => setAddOpen(!addOpen)}>
        {addOpen ? "Cancel" : "+ Add a hidden network"}
      </button>
      {addOpen && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <input className="input" placeholder="SSID" value={addSsid}
                 onChange={(e) => { setAddSsid(e.target.value); setMsg(""); }} />
          <input className="input" type="password" placeholder="Password (leave blank if open)" value={addPw}
                 onChange={(e) => { setAddPw(e.target.value); setMsg(""); }} />
          <button className="btn btn-primary" disabled={busy || !addSsid.trim()} onClick={() => void addOnly()}>
            {busy ? "Saving…" : "Save (don't connect now)"}
          </button>
        </div>
      )}

      {msg && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
      </div>
      )}
    </div>
  );
}

function AeroSection({ pin, aero, onChanged }: { pin: string; aero: AdminSettings["aero"]; onChanged: () => void }): JSX.Element {
  const [cap, setCap] = useState("");
  const [expanded, setExpanded] = useState(false);
  const pct = aero.cap > 0 ? Math.min(100, Math.round((aero.used / aero.cap) * 100)) : 100;
  const over = aero.cap > 0 && aero.used >= aero.cap;
  const status = !aero.keyPresent ? "no key" : aero.enabled ? `${aero.used}${aero.cap ? `/${aero.cap}` : ""}` : "off";
  return (
    <div className="set-card">
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          AeroAPI usage
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>{status}</span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
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
      )}
    </div>
  );
}
