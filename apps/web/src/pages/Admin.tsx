import { useEffect, useState } from "react";
import type { ServiceStatus } from "@qdrn/shared";
import { BASE } from "../api";

const ADMIN = `${BASE}/admin/api`;

async function aget<T>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN}${path}`);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}
async function apost(path: string): Promise<void> {
  await fetch(`${ADMIN}${path}`, { method: "POST" });
}

export function Admin(): JSX.Element {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [whoami, setWhoami] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [logName, setLogName] = useState<string | null>(null);
  const [logs, setLogs] = useState("");

  async function refresh(): Promise<void> {
    try {
      const [svc, who] = await Promise.all([
        aget<ServiceStatus[]>("/services"),
        aget<{ email: string | null }>("/whoami"),
      ]);
      setServices(svc);
      setWhoami(who.email);
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

        {logName && (
          <div className="glass" style={{ padding: 18, marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Logs · {logName}</h2>
            <pre className="mono scroll" style={{ maxHeight: 360, overflow: "auto", fontSize: 12, background: "rgba(0,0,0,0.4)", padding: 12, borderRadius: 8 }}>
              {logs}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
