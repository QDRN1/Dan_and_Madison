import { useEffect, useState } from "react";
import type { AdminSettings, AircraftClass, ConnStatus, Connections, FlightWatch, GatewayInfo, WifiNetwork, WifiScanResult } from "@qdrn/shared";
import { AIRCRAFT_CLASS_LABELS } from "@qdrn/shared";
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

      {/* 5a. Aircraft class filter — hide categories from the live map / list */}
      <ClassFilterSection />

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

      {/* Device admin (any PIN) — uptime/build, Update Device, Restart Radar. */}
      <DeviceAdminSection pin={pin} />

      {/* Super-admin (master PIN only) — destructive operations. */}
      {isMaster && <SuperAdminSection pin={pin} />}

      {/* 9. Change PIN */}
      <PinSection currentPin={pin} onChanged={(p) => { sessionStorage.setItem(PIN_KEY, p); setPin(p); }} />

      {/* 10. Logout — clears the sessionStorage PIN so the next visit (or
       *      anyone else on this device) has to re-enter the PIN. */}
      <button
        className="btn btn-block"
        style={{ marginTop: 4, background: "transparent", borderStyle: "dashed" }}
        onClick={() => {
          sessionStorage.removeItem(PIN_KEY);
          setUnlocked(false);
          setIsMaster(false);
          setS(null);
          setPin("");
          setEntry("");
        }}
      >
        Lock settings
      </button>
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

/** User-managed flight-watch list. Add a name + callsign + (optional) date
 *  and the poller fires a big alert when that exact flight enters the
 *  radar — only on the specified date (or always, if blank). */
/** Toggle which aircraft classes (commercial / cargo / private / military
 *  / helicopter / other) are shown on the live map and flights list. The
 *  same buckets back the popout reports' class filter dropdown.
 *  State lives in the radar store + localStorage so it survives reloads. */
function ClassFilterSection(): JSX.Element {
  const hidden = useRadar((s) => s.hiddenClasses);
  const toggle = useRadar((s) => s.toggleHiddenClass);
  const [expanded, setExpanded] = useState(false);
  const classes: AircraftClass[] = ["commercial", "cargo", "private", "military", "helicopter", "other"];
  const shownCount = classes.length - hidden.size;
  return (
    <div className="set-card">
      <button className="set-collapse-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted)" }}>
          Aircraft filter
        </span>
        <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>
          {hidden.size === 0 ? "all visible" : `${shownCount} of ${classes.length}`}
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Tap to hide a category from the live map and flights list. Same
            buckets work as a filter on the popout reports.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {classes.map((c) => {
              const isHidden = hidden.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  className={`btn class-toggle${isHidden ? "" : " on"}`}
                  onClick={() => toggle(c)}
                >
                  {isHidden ? "○" : "●"} {AIRCRAFT_CLASS_LABELS[c]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function WatchesSection({ pin }: { pin: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [watches, setWatches] = useState<FlightWatch[]>([]);
  const [draftName, setDraftName] = useState("");
  const [draftCallsign, setDraftCallsign] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const reload = async (): Promise<void> => {
    try { const r = await api.listWatches(pin); setWatches(r.watches ?? []); }
    catch { /* offline */ }
  };
  useEffect(() => {
    if (!expanded) return;
    void reload();
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, pin]);

  async function add(): Promise<void> {
    if (!draftCallsign.trim()) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.addWatch(pin, {
        callsign: draftCallsign.trim(),
        name: draftName.trim() || undefined,
        flightDate: draftDate || undefined,
      });
      if (r.ok) { setDraftName(""); setDraftCallsign(""); setDraftDate(""); await reload(); }
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
    <div className="set-card" data-tour="watch-a-flight">
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
            Give it a name (who's flying / what it's for), the callsign
            (DL2864, AAL100, BAW286…), and the date. When that exact flight
            crosses the radar on that day a big alert fires and the plane is
            selected on the map. IATA prefixes auto-convert to ICAO. Leave
            the date blank to watch indefinitely.
          </p>
          <input
            className="input"
            placeholder="Name (e.g. Dan's flight to Vegas)"
            value={draftName}
            onChange={(e) => { setDraftName(e.target.value); setMsg(""); }}
            maxLength={60}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              className="input"
              placeholder="DL2864"
              value={draftCallsign}
              onChange={(e) => { setDraftCallsign(e.target.value.toUpperCase()); setMsg(""); }}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              style={{ flex: 1 }}
            />
            <input
              className="input"
              type="date"
              value={draftDate}
              onChange={(e) => { setDraftDate(e.target.value); setMsg(""); }}
              style={{ flex: 1.2 }}
              title="Date the flight is operating (optional)"
            />
          </div>
          <button
            className="btn btn-primary btn-block"
            style={{ marginTop: 8 }}
            disabled={busy || !draftCallsign.trim()}
            onClick={() => void add()}
          >
            {busy ? "Saving…" : "Add watch"}
          </button>
          {msg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}
          {watches.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {watches.map((w) => {
                const isFired = Boolean(w.fired_at);
                return (
                  <div key={w.id} className="watch-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {w.name || w.raw_input}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {w.raw_input}
                        {w.raw_input.toUpperCase() !== w.callsign && <> ({w.callsign})</>}
                        {w.flight_date && <> · {fmtFlightDate(w.flight_date)}</>}
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {isFired
                          ? `✓ Seen ${fmtAgo(w.fired_at!)} · hex ${w.fired_hex?.toUpperCase()}`
                          : w.flight_date ? "Armed for the date" : "Watching…"}
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

function fmtFlightDate(iso: string): string {
  // iso = "YYYY-MM-DD". Build a Date at noon UTC so timezone fudging doesn't
  // slide the displayed date by a day.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
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

/** Device admin available to every PIN holder (the friend included).
 *  Surfaces the device-info block, Update Device (with an "Update
 *  available" badge when the host is behind origin/main), and Restart
 *  Radar. Update-available is polled at most once a day per browser. */
function DeviceAdminSection({ pin }: { pin: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [check, setCheck] = useState<{ behind: number; latestSha?: string; latestSubject?: string; latestAt?: string; subjects?: string[] } | null>(null);
  const setUpdateJob = useRadar((s) => s.setUpdateJob);
  const setUpdatePhase = useRadar((s) => s.setUpdatePhase);

  // Device info loads on first expand.
  useEffect(() => {
    if (!expanded || info) return;
    api.deviceInfo(pin).then(setInfo).catch(() => undefined);
  }, [expanded, info, pin]);

  // Daily update-available check. We cache the result + timestamp in
  // localStorage so opening Settings every few minutes doesn't hammer
  // `git fetch`. Runs on first expand and once per day after.
  useEffect(() => {
    if (!expanded) return;
    const KEY = "qdrn-update-check";
    let parsed: { at: number; data: { behind: number; latestSha?: string; latestSubject?: string; latestAt?: string; subjects?: string[] } } | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch { /* ignore */ }
    if (parsed?.data) setCheck(parsed.data);
    const fresh = parsed && Date.now() - parsed.at < 24 * 3600 * 1000;
    if (fresh) return;
    api.adminUpdateCheck(pin).then((r) => {
      if (!r.ok) return;
      const data = { behind: r.behind, latestSha: r.latestSha, latestSubject: r.latestSubject, latestAt: r.latestAt, subjects: r.subjects };
      setCheck(data);
      try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
    }).catch(() => undefined);
  }, [expanded, pin]);

  async function confirmAndRestart(): Promise<void> {
    if (!window.confirm("Restart the radar container? Live tracking drops for ~10 seconds.")) return;
    setBusy(true); setMsg("Restarting…");
    try {
      const r = await api.adminRestart(pin);
      setMsg(r.ok ? "Restart ✓" : `Restart failed: ${r.error ?? "unknown"}`);
      if (r.ok) setInfo(null);
    } catch (e) {
      setMsg(`Restart failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  /** Check first, then ask. Re-runs `git fetch` so the prompt reflects
   *  reality even if the cached daily check is stale, and never starts
   *  a build when there's nothing to apply (the old flow dropped you
   *  into the full-screen countdown even on no-op updates).
   *
   *  Falls back to a generic confirm when update-check itself fails —
   *  most commonly because qdrn-netd on the host is too old to know
   *  the `update-check` op (chicken-and-egg: the very update we want
   *  to install is what would teach it). Running the update anyway in
   *  that case is the right call. */
  async function handleUpdateClick(): Promise<void> {
    setBusy(true);
    setMsg("Checking for updates…");
    let r: Awaited<ReturnType<typeof api.adminUpdateCheck>> | null = null;
    let checkErr: string | null = null;
    try {
      r = await api.adminUpdateCheck(pin);
      if (!r.ok) checkErr = r.error ?? "unknown error";
    } catch (e) {
      checkErr = (e as Error).message;
    }

    if (r && r.ok) {
      const data = { behind: r.behind, latestSha: r.latestSha, latestSubject: r.latestSubject, latestAt: r.latestAt, subjects: r.subjects };
      setCheck(data);
      try { localStorage.setItem("qdrn-update-check", JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
      if (r.behind === 0) {
        const sha = r.latestSha?.slice(0, 7) ?? info?.buildSha?.slice(0, 7) ?? "?";
        setMsg(`Already on the latest build (${sha}). Nothing to update.`);
        setBusy(false);
        return;
      }
      // Full changelog (newest first) — users trust an update that says
      // what it changes. Capped at 8 lines so the confirm stays readable;
      // older qdrn-netd without `subjects` falls back to the single
      // latest subject.
      const lines = (r.subjects && r.subjects.length > 0 ? r.subjects : r.latestSubject ? [r.latestSubject] : [])
        .slice(0, 8)
        .map((s) => `  • ${s}`);
      const more = r.behind > lines.length ? `\n  …and ${r.behind - lines.length} more` : "";
      const changelog = lines.length > 0 ? `\n\nWhat's new:\n${lines.join("\n")}${more}` : "";
      const proceed = window.confirm(
        `${r.behind} update${r.behind === 1 ? "" : "s"} available.${changelog}\n\n` +
        "Do you want to proceed? The radar will be unavailable for ~30–60 seconds " +
        "while the new image builds, then the page will auto-reload.",
      );
      if (!proceed) { setMsg("Update cancelled."); setBusy(false); return; }
      await runUpdate({ pin, oldSha: info?.buildSha ?? null, setUpdateJob, setUpdatePhase, setMsg, setBusy, setInfo });
      return;
    }

    // Check failed — most likely qdrn-netd on the host hasn't been
    // restarted since this app started using update-check. Offer to
    // pull anyway; the update itself usually fixes the helper too.
    const proceedAnyway = window.confirm(
      `Couldn't check for updates: ${checkErr}\n\n` +
      "This usually means the host helper (qdrn-netd) hasn't been refreshed yet. " +
      "Proceed with the update anyway? If there are updates, they'll be pulled and " +
      "the radar will rebuild in ~30–60 seconds and auto-reload.",
    );
    if (!proceedAnyway) { setMsg(`Update check failed: ${checkErr}`); setBusy(false); return; }
    await runUpdate({ pin, oldSha: info?.buildSha ?? null, setUpdateJob, setUpdatePhase, setMsg, setBusy, setInfo });
  }

  const updateAvailable = (check?.behind ?? 0) > 0;

  return (
    <div className="set-card" style={{ borderColor: "var(--danger)" }}>
      <button
        className="set-collapse-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={{ flex: 1, textAlign: "left", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--danger)" }}>
          🛠 Admin
        </span>
        {updateAvailable && (
          <span className="pill warn" style={{ marginRight: 8, fontSize: 11 }}>
            Update available
          </span>
        )}
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
              <div>
                <b>Build:</b> {info.buildSha ? info.buildSha.slice(0, 7) : "unknown"}
                {info.buildAt && <span className="muted"> · {new Date(info.buildAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
              </div>
            </div>
          )}
          {updateAvailable && check && (
            <div style={{ fontSize: 12, padding: "8px 10px", border: "1px solid var(--accent)", borderRadius: 8, background: "rgba(163, 201, 64, 0.08)" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Update available · {check.behind} change{check.behind === 1 ? "" : "s"}
              </div>
              {(check.subjects && check.subjects.length > 0 ? check.subjects : check.latestSubject ? [check.latestSubject] : [])
                .slice(0, 6)
                .map((s, i) => (
                  <div key={i} className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>• {s}</div>
                ))}
              {check.behind > 6 && (
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>…and {check.behind - 6} more</div>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className={`btn ${updateAvailable ? "btn-primary" : ""}`}
              style={{ flex: 1, minWidth: 140 }}
              disabled={busy}
              onClick={() => void handleUpdateClick()}
            >
              Update Device
            </button>
            <button className="btn" style={{ flex: 1, minWidth: 140 }} disabled={busy} onClick={() => void confirmAndRestart()}>
              Restart Radar
            </button>
          </div>
          <AutoUpdateToggle pin={pin} />
          <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
            Update Device pulls the latest code and rebuilds the radar container. Restart Radar bounces just the container.
          </p>
          {msg && <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

/** Background-update opt-in. When ON the server polls daily and, if any
 *  commits are waiting on origin/main, pulls + rebuilds during the off-peak
 *  window (3-5 AM device-local time). Default OFF. */
function AutoUpdateToggle({ pin }: { pin: string }): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.settings(pin).then((s) => setEnabled(s.autoUpdateEnabled)).catch(() => setEnabled(false));
  }, [pin]);
  if (enabled == null) return <></>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Auto-update</div>
        <div className="muted" style={{ fontSize: 11 }}>
          Check daily and apply between 3–5 AM if updates are available.
        </div>
      </div>
      <button
        className={`btn ${enabled ? "btn-primary" : ""}`}
        style={{ padding: "6px 14px" }}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.saveAutoUpdate(pin, !enabled);
            if (r.ok) setEnabled(r.enabled);
          } finally { setBusy(false); }
        }}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

/** Master-PIN-only destructive ops. Same red styling, separate card so the
 *  friend never sees a "Reset stats" button. */
function SuperAdminSection({ pin }: { pin: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function runDestructive(label: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const code = window.prompt(`Type CONFIRM to ${label.toLowerCase()}:`);
    if (code == null) return;
    if (code.trim().toUpperCase() !== "CONFIRM") { setMsg(`${label} cancelled — code didn't match.`); return; }
    setBusy(true); setMsg(`${label}…`);
    try {
      const r = await fn();
      setMsg(r.ok ? `${label} ✓` : `${label} failed: ${r.error ?? "unknown"}`);
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
          🛠 Super admin
        </span>
        <span className="set-collapse-chev" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn" disabled={busy}
                  onClick={() => void runDestructive("Reset stats", () => api.adminResetStats(pin))}>
            Reset stats
          </button>
          <button className="btn" disabled={busy} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                  onClick={async () => {
                    // Reset device is "factory reset minus the parts that get you back in":
                    // wipes the SQLite DB entirely (sightings, settings, PIN, watches, etc.)
                    // but leaves .env (CF_TUNNEL_TOKEN), ~/.cloudflared/, Pi Connect, and
                    // baked WiFi profiles untouched. Friend lands on the CaptainQ wizard
                    // on next page load.
                    await runDestructive("Reset device", async () => {
                      const r = await api.adminResetDevice(pin);
                      if (!r.ok) return r;
                      // Restart the container so it boots with the fresh DB. (better-sqlite3
                      // has the DB open; restart lets it re-init clean.)
                      try { await api.adminRestart(pin); } catch { /* container will recycle anyway */ }
                      return r;
                    });
                  }}>
            Reset device (preserves CF tunnel + WiFi)
          </button>
          <button className="btn" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setMsg("Backfilling…");
                    try {
                      const r = await api.adminBackfillAchievements(pin);
                      setMsg(r.ok ? `Backfilled ${r.fired} unlocks from ${r.processed} sightings ✓` : `Backfill failed: ${r.error}`);
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
            Reset stats wipes the sightings/flagged/coverage/achievements tables. Settings, WiFi profiles, and the enrichment cache are kept.
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
  buildAt?: string;
}

/** Drives the full-screen UpdateOverlay: kicks off /admin/update,
 *  walks the user through Pulling → Building → Waiting → Reloading,
 *  and reloads the page automatically once a new build SHA appears.
 *  Confirmation happens upstream in handleUpdateClick (with the actual
 *  changelog) — this function assumes the user already said yes. */
async function runUpdate(args: {
  pin: string;
  oldSha: string | null;
  setUpdateJob: (j: import("../store").UpdateJob | null) => void;
  setUpdatePhase: (phase: string) => void;
  setMsg: (m: string) => void;
  setBusy: (b: boolean) => void;
  setInfo: (i: DeviceInfo | null) => void;
}): Promise<void> {
  const { pin, oldSha, setUpdateJob, setUpdatePhase, setMsg, setBusy, setInfo } = args;
  setBusy(true);
  setMsg("");
  setInfo(null);
  setUpdateJob({ startedAt: Date.now(), phase: "Pulling latest code…", oldSha });
  try {
    const r = await api.adminUpdate(pin);
    if (!r.ok) {
      setUpdateJob({ startedAt: Date.now(), phase: "", oldSha, error: r.error ?? "Unknown error from /admin/update" });
      setMsg(`Pull update failed: ${r.error ?? "unknown"}`);
      return;
    }
    setUpdatePhase("Rebuilding container… (~30–60s)");
    // Poll device-info every 2s for up to ~3 minutes. The container
    // is being recreated, so most polls error out — that's expected.
    // We're waiting for: (1) a successful response AND (2) a buildSha
    // different from the one we started with. Once we see it, switch
    // to "Reloading…" and refresh the page so the new bundle loads.
    const deadline = Date.now() + 180_000;
    let sawDown = false;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      try {
        const next = await api.deviceInfo(pin);
        if (!next.buildSha) continue;
        if (sawDown && next.buildSha !== oldSha) {
          setUpdatePhase(`New build ${next.buildSha.slice(0, 7)} — reloading…`);
          await new Promise((res) => setTimeout(res, 800));
          window.location.reload();
          return;
        }
        if (next.buildSha !== oldSha) {
          // SHA flipped without us ever seeing the container go down
          // (very fast build). Still a success.
          setUpdatePhase(`New build ${next.buildSha.slice(0, 7)} — reloading…`);
          await new Promise((res) => setTimeout(res, 800));
          window.location.reload();
          return;
        }
        // Same SHA still — keep waiting for the new container to swap in.
        setUpdatePhase("Building image…");
      } catch {
        // Container is mid-restart; this is the "Waiting for radar to
        // come back…" phase. Most of the elapsed time happens here.
        sawDown = true;
        setUpdatePhase("Waiting for radar to come back…");
      }
    }
    setUpdateJob({
      startedAt: Date.now(),
      phase: "",
      oldSha,
      error: "Update didn't finish within 3 minutes. SSH and check `docker compose logs qdrn-radar`. Tap Refresh to try loading anyway.",
    });
  } catch (e) {
    setUpdateJob({ startedAt: Date.now(), phase: "", oldSha, error: (e as Error).message });
  } finally {
    setBusy(false);
  }
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

      {(() => {
        // Hide owner-baked networks (HobbitHouse, LAN-Down-Under, …) unless
        // the SSID also shows up in the current scan, so the friend sees a
        // baked profile only when they're actually in range of it (and can
        // forget it if they want). Active networks are always shown.
        const visibleSsids = new Set<string>((scan ?? []).map((s) => s.ssid));
        const visibleNets = (nets ?? []).filter(
          (n) => n.active || !n.baked || visibleSsids.has(n.name),
        );
        if (visibleNets.length === 0 && !err) {
          return <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>No saved networks yet.</div>;
        }
        return (
        <div className="wifi-list" style={{ marginBottom: 10 }}>
          {visibleNets.map((n) => (
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
        );
      })()}

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
