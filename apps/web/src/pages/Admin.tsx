import { useEffect, useState } from "react";
import type { AeroApiStatus, ReceiverInfo, ServiceStatus } from "@qdrn/shared";
import { BASE, geocodeCity, type GeoResult } from "../api";
import { ThemeToggle } from "../components/ThemeToggle";

interface KeyStatus {
  flightAwareConnected: boolean;
  flightRadar24Connected: boolean;
  fr24SharingKeySet: boolean;
  piawareFeederIdSet: boolean;
}

const ADMIN = `${BASE}/admin/api`;

async function aget<T>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN}${path}`);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}
async function apost(path: string, body?: unknown): Promise<{ ok: boolean }> {
  const res = await fetch(`${ADMIN}${path}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok };
}

export function Admin(): JSX.Element {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [whoami, setWhoami] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [logName, setLogName] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [newPin, setNewPin] = useState("");
  const [deviceMsg, setDeviceMsg] = useState("");

  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [keysMsg, setKeysMsg] = useState("");

  const [receiver, setReceiver] = useState<ReceiverInfo | null>(null);
  const [geoQuery, setGeoQuery] = useState("");
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [locMsg, setLocMsg] = useState("");

  const [aero, setAero] = useState<AeroApiStatus | null>(null);
  const [capInput, setCapInput] = useState("");
  const [aeroMsg, setAeroMsg] = useState("");

  async function saveKeys(): Promise<void> {
    const payload = Object.fromEntries(Object.entries(keyInputs).filter(([, v]) => v.trim() !== ""));
    if (Object.keys(payload).length === 0) {
      setKeysMsg("Nothing to save.");
      return;
    }
    const r = await apost("/keys", payload);
    setKeysMsg(r.ok ? "Saved. Routes will use the new keys immediately." : "Save failed.");
    setKeyInputs({});
    await refresh();
  }

  async function searchCity(): Promise<void> {
    if (geoQuery.trim().length < 2) return;
    setGeoResults(await geocodeCity(geoQuery.trim()).catch(() => []));
  }

  async function pickCity(g: GeoResult): Promise<void> {
    const r = await apost("/location", { city: g.name.split(",").slice(0, 2).join(",").trim(), lat: g.lat, lon: g.lon });
    setLocMsg(r.ok ? "Location updated." : "Update failed.");
    setGeoResults([]);
    setGeoQuery("");
    await refresh();
  }

  async function saveAero(patch: { enabled?: boolean; cap?: number }): Promise<void> {
    const r = await apost("/aeroapi", patch);
    setAeroMsg(r.ok ? "Saved." : "Save failed.");
    await refresh();
  }

  async function changePin(): Promise<void> {
    if (!/^\d{4,6}$/.test(newPin)) {
      setDeviceMsg("PIN must be 4–6 digits.");
      return;
    }
    const r = await apost("/device/set-pin", { pin: newPin });
    setDeviceMsg(r.ok ? "PIN updated." : "Failed to set PIN.");
    setNewPin("");
  }

  async function resetDevice(): Promise<void> {
    if (!window.confirm("Factory reset? This wipes the PIN, location, API keys and stats so the device can be set up fresh. Feeding keeps running.")) return;
    const r = await apost("/device/reset");
    setDeviceMsg(r.ok ? "Device reset — re-onboard at /md/setup." : "Reset failed.");
  }

  async function refresh(): Promise<void> {
    try {
      const [svc, who, keys, loc, ae] = await Promise.all([
        aget<ServiceStatus[]>("/services"),
        aget<{ email: string | null }>("/whoami"),
        aget<KeyStatus>("/keys"),
        aget<ReceiverInfo>("/location"),
        aget<AeroApiStatus>("/aeroapi"),
      ]);
      setServices(svc);
      setWhoami(who.email);
      setKeyStatus(keys);
      setReceiver(loc);
      setAero(ae);
      setError(false);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, []);

  async function viewLogs(name: string): Promise<void> {
    setLogName(name);
    const r = await aget<{ logs: string }>(`/logs/${name}?lines=300`).catch(() => ({ logs: "(unavailable)" }));
    setLogs(r.logs);
  }

  return (
    <div style={{ minHeight: "100%", background: "var(--bg-grad)", padding: "24px 16px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>QDRN Radar · Admin Console</h1>
          <span className="pill">hidden</span>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {whoami ? `Signed in via Cloudflare Access as ${whoami}` : "Protected by Cloudflare Access"}
        </p>

        {error && (
          <div className="glass" style={{ padding: 16, borderColor: "var(--danger)" }}>
            Couldn't reach the admin API. In production this page is gated by Cloudflare Access —
            make sure your Access policy allows your email and the tunnel is up.
          </div>
        )}

        <div className="glass" style={{ padding: 18, marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Services</h2>
          {services.map((s) => (
            <div key={s.name} className="stat-row" style={{ alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className={`pill${s.running ? "" : " danger"}`}>{s.running ? "running" : "down"}</span>
                <span style={{ fontWeight: 700 }}>{s.name}</span>
                {s.health && s.health !== "unknown" && <span className="muted" style={{ fontSize: 12 }}>{s.health}</span>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ padding: "6px 12px" }} onClick={() => void viewLogs(s.name)}>Logs</button>
                <button className="btn" style={{ padding: "6px 12px" }} onClick={() => void apost(`/services/${s.name}/restart`).then(refresh)}>Restart</button>
              </div>
            </div>
          ))}
          {services.length === 0 && !error && <div className="muted">Loading…</div>}
        </div>

        {aero && (
          <div className="glass" style={{ padding: 18, marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>AeroAPI usage &amp; spend guard</h2>
            {aeroMsg && <div className="pill" style={{ marginBottom: 12 }}>{aeroMsg}</div>}
            {!aero.keyPresent && (
              <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                No FlightAware key set — routes use free sources only. Add a key under “API keys” below.
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <span style={{ fontWeight: 700 }}>Paid lookups</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {aero.used} used this month ({aero.month}){aero.cap > 0 ? ` · cap ${aero.cap}` : " · no cap"}
                </div>
              </div>
              <button className="btn" style={{ padding: "6px 12px", whiteSpace: "nowrap" }} onClick={() => void saveAero({ enabled: !aero.enabled })}>
                {aero.enabled ? "Disable (free only)" : "Enable"}
              </button>
            </div>
            <div style={{ height: 6, margin: "10px 0", borderRadius: 3, background: "rgba(128,128,128,0.22)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 3,
                  width: aero.cap > 0 ? `${Math.min(100, Math.round((aero.used / aero.cap) * 100))}%` : "100%",
                  background: aero.cap > 0 && aero.used >= aero.cap ? "var(--danger)" : "var(--accent)",
                }}
              />
            </div>
            <div className="label">Monthly cap (0 = unlimited)</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input"
                inputMode="numeric"
                placeholder={String(aero.cap)}
                value={capInput}
                onChange={(e) => setCapInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
              <button
                className="btn"
                style={{ whiteSpace: "nowrap" }}
                onClick={() => {
                  void saveAero({ cap: Number(capInput || aero.cap) });
                  setCapInput("");
                }}
              >
                Set cap
              </button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              FlightAware gives ~$5/month free credit (more for ADS-B feeders). Past the cap, routes fall back to free
              sources until next month.
            </p>
          </div>
        )}

        <div className="glass" style={{ padding: 18, marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>API keys</h2>
          {keysMsg && <div className="pill" style={{ marginBottom: 12 }}>{keysMsg}</div>}
          {(
            [
              ["flightAwareAeroApi", "FlightAware AeroAPI key", keyStatus?.flightAwareConnected],
              ["flightRadar24Token", "FlightRadar24 API token", keyStatus?.flightRadar24Connected],
              ["fr24SharingKey", "FR24 sharing key (feeder)", keyStatus?.fr24SharingKeySet],
              ["piawareFeederId", "PiAware feeder ID", keyStatus?.piawareFeederIdSet],
            ] as const
          ).map(([field, lbl, set]) => (
            <div key={field} style={{ marginBottom: 10 }}>
              <div className="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {lbl} <span className={`pill${set ? "" : " danger"}`}>{set ? "set" : "not set"}</span>
              </div>
              <input
                className="input"
                placeholder={set ? "•••••••• (leave blank to keep)" : "Paste value"}
                value={keyInputs[field] ?? ""}
                onChange={(e) => setKeyInputs((s) => ({ ...s, [field]: e.target.value }))}
              />
            </div>
          ))}
          <button className="btn" onClick={() => void saveKeys()}>Save keys</button>
        </div>

        <div className="glass" style={{ padding: 18, marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Location</h2>
          {locMsg && <div className="pill" style={{ marginBottom: 12 }}>{locMsg}</div>}
          {receiver && (
            <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              Current: {receiver.city} ({receiver.lat.toFixed(3)}, {receiver.lon.toFixed(3)})
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="Search a city…"
              value={geoQuery}
              onChange={(e) => setGeoQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void searchCity()}
            />
            <button className="btn" style={{ whiteSpace: "nowrap" }} onClick={() => void searchCity()}>Search</button>
          </div>
          {geoResults.map((g) => (
            <button
              key={`${g.lat},${g.lon}`}
              className="btn"
              style={{ display: "block", width: "100%", textAlign: "left", marginTop: 8, fontWeight: 500 }}
              onClick={() => void pickCity(g)}
            >
              {g.name}
            </button>
          ))}
        </div>

        <div className="glass" style={{ padding: 18, marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Device</h2>
          {deviceMsg && <div className="pill" style={{ marginBottom: 12 }}>{deviceMsg}</div>}

          <div className="label">Owner PIN</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              inputMode="numeric"
              placeholder="New 4–6 digit PIN"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button className="btn" style={{ whiteSpace: "nowrap" }} onClick={() => void changePin()}>Set PIN</button>
          </div>

          <div className="label" style={{ marginTop: 18 }}>Factory reset</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Wipes the PIN, location, API keys and stats so a new owner can run the CaptainQ
            setup from scratch. Feeding (FR24 / FlightAware) keeps running.
          </p>
          <button className="btn" style={{ borderColor: "var(--danger)", color: "var(--danger)" }} onClick={() => void resetDevice()}>
            Reset device
          </button>
        </div>

        {logName && (
          <div className="glass" style={{ padding: 18, marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Logs · {logName}</h2>
            <pre className="mono scroll" style={{ maxHeight: 360, overflow: "auto", fontSize: 12, background: "var(--code-bg)", color: "var(--code-fg)", padding: 12, borderRadius: 8 }}>
              {logs}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
