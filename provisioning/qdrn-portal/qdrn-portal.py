#!/usr/bin/env python3
"""QDRN captive portal — listed when the Pi is in hotspot mode.

Pure Flask app. Lists nearby WiFi networks via `nmcli`, lets the user pick one
and enter a password, then calls `nmcli device wifi connect` to join. The
companion qdrn-watcher service brings up the NetworkManager hotspot connection
and starts this Flask app whenever the Pi can't reach any other network.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time

from flask import Flask, request, send_from_directory

app = Flask(__name__)

HOTSPOT_SSID = "QDRN-Radar-Setup"
STATIC_DIR = os.environ.get("QDRN_STATIC_DIR", "/usr/local/share/qdrn-portal/static")

PAGE = """<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<title>QDRN Radar setup</title>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=theme-color content="#001533">
<link rel="icon" type="image/png" href="/static/captain-q.png">
<style>
:root {{
  --bg: #001533;
  --bg-2: #000a1f;
  --surface: #002D72;
  --surface-2: rgba(0, 45, 114, 0.55);
  --accent: #A3C940;
  --accent-glow: rgba(163, 201, 64, 0.4);
  --text: #F0F0F0;
  --muted: #9fb0c9;
  --border: rgba(163, 201, 64, 0.18);
  --danger: #ff7676;
}}
*, ::before, ::after {{ box-sizing: border-box; }}
html {{ -webkit-tap-highlight-color: transparent; }}
body {{
  margin: 0 auto;
  padding: 0 18px calc(48px + env(safe-area-inset-bottom));
  max-width: 480px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: radial-gradient(ellipse at top, var(--bg), var(--bg-2));
  color: var(--text);
  min-height: 100vh;
  line-height: 1.45;
  animation: fadeIn .45s ease-out;
}}
@keyframes fadeIn {{
  from {{ opacity: 0; transform: translateY(6px); }}
  to {{ opacity: 1; transform: none; }}
}}

.logo-wrap {{
  text-align: center;
  padding: calc(36px + env(safe-area-inset-top)) 0 12px;
}}
.logo-wrap img {{
  height: 64px;
  width: auto;
  max-width: 80%;
  filter: drop-shadow(0 4px 14px rgba(0,0,0,.5));
}}
.subtitle {{
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  margin: 0 0 22px;
  font-weight: 500;
  letter-spacing: 0.02em;
}}

/* Cards / messages */
.msg {{
  background: var(--surface-2);
  border: 1px solid var(--accent);
  border-radius: 14px;
  padding: 18px;
  margin: 16px 0;
  text-align: center;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}}
.msg.err {{ border-color: var(--danger); }}
.msg b {{ color: var(--accent); }}

.empty {{
  text-align: center;
  padding: 30px 18px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  margin: 18px 0;
}}

/* Network list */
.nets {{ display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }}
.net {{
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  text-align: left;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 13px 14px;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: transform .14s ease, border-color .14s ease, background .14s ease;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: slideIn .3s ease-out backwards;
}}
.nets > form:nth-child(1) .net {{ animation-delay: .02s; }}
.nets > form:nth-child(2) .net {{ animation-delay: .05s; }}
.nets > form:nth-child(3) .net {{ animation-delay: .08s; }}
.nets > form:nth-child(4) .net {{ animation-delay: .11s; }}
.nets > form:nth-child(5) .net {{ animation-delay: .14s; }}
.nets > form:nth-child(6) .net {{ animation-delay: .17s; }}
.nets > form:nth-child(7) .net {{ animation-delay: .20s; }}
.nets > form:nth-child(8) .net {{ animation-delay: .23s; }}
@keyframes slideIn {{
  from {{ opacity: 0; transform: translateY(8px); }}
  to {{ opacity: 1; transform: none; }}
}}
.net:hover, .net:focus {{
  border-color: var(--accent);
  background: rgba(0, 45, 114, .85);
  outline: none;
  transform: translateY(-1px);
}}
.net:active {{ transform: translateY(0); }}
.net-info {{ flex: 1; min-width: 0; }}
.ssid {{
  font-weight: 600;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 7px;
  overflow: hidden;
}}
.ssid-text {{
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}}
.meta {{
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}}
.lock {{
  width: 11px;
  height: 11px;
  fill: var(--muted);
  flex-shrink: 0;
}}

/* Signal bars */
.signal {{
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 18px;
  flex-shrink: 0;
}}
.signal .bar {{
  width: 3px;
  background: rgba(159, 176, 201, .3);
  border-radius: 2px;
  transition: background .2s ease;
}}
.signal .b1 {{ height: 6px; }}
.signal .b2 {{ height: 10px; }}
.signal .b3 {{ height: 14px; }}
.signal .b4 {{ height: 18px; }}
.signal.s1 .b1,
.signal.s2 .b1, .signal.s2 .b2,
.signal.s3 .b1, .signal.s3 .b2, .signal.s3 .b3,
.signal.s4 .bar {{ background: var(--accent); }}

/* Form */
input, .primary, .ghost {{
  width: 100%;
  font-size: 16px;
  font-family: inherit;
  margin: 0;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}}
input::placeholder {{ color: var(--muted); opacity: 0.8; }}
input:focus {{
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}}
.primary {{
  background: var(--accent);
  color: var(--bg);
  font-weight: 700;
  border: none;
  cursor: pointer;
  transition: transform .1s ease, box-shadow .18s ease;
  margin-top: 12px;
}}
.primary:hover {{ box-shadow: 0 6px 22px var(--accent-glow); }}
.primary:active {{ transform: scale(.985); }}
.primary:disabled {{ opacity: 0.6; cursor: wait; }}

.ghost {{
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: border-color .15s ease, color .15s ease;
}}
.ghost:hover {{ border-color: var(--accent); color: var(--accent); }}
.ghost:hover svg {{ animation: spin 1s linear infinite; }}
.ghost svg {{ width: 14px; height: 14px; fill: currentColor; }}
@keyframes spin {{ to {{ transform: rotate(360deg); }} }}

/* Radar sweep */
.radar {{
  position: relative;
  width: 140px;
  height: 140px;
  margin: 26px auto 14px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 40px var(--accent-glow), inset 0 0 20px rgba(163, 201, 64, .08);
  overflow: hidden;
}}
.radar::before {{
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 50%;
  height: 50%;
  background: conic-gradient(from 0deg, var(--accent), rgba(163, 201, 64, 0.0) 30%);
  transform-origin: 0 0;
  animation: sweep 2.5s linear infinite;
}}
.radar::after {{
  content: "";
  position: absolute;
  inset: 32%;
  border: 1px solid rgba(163, 201, 64, .35);
  border-radius: 50%;
  box-shadow: inset 0 0 8px rgba(163, 201, 64, .2);
}}
@keyframes sweep {{ to {{ transform: rotate(360deg); }} }}

.center {{ text-align: center; }}
.sub {{ color: var(--muted); font-size: 13px; }}
.back {{ display: inline-block; margin-top: 14px; color: var(--accent); text-decoration: none; font-size: 14px; }}
.back:hover {{ text-decoration: underline; }}
a {{ color: var(--accent); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
</style>
</head>
<body>
<div class="logo-wrap">
  <img src="/static/logo.png" alt="QDRN Radar">
</div>
{body}
</body>
</html>"""

LOCK_SVG = (
    '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true">'
    '<path d="M11 7V5a3 3 0 1 0-6 0v2H4v7h8V7h-1zm-5-2a2 2 0 1 1 4 0v2H6V5z"/>'
    '</svg>'
)
REFRESH_SVG = (
    '<svg viewBox="0 0 16 16" aria-hidden="true">'
    '<path d="M13.65 2.34a8 8 0 1 0 2.06 8.96L13.7 10.6a6 6 0 1 1-1.56-6.85L9 6.5h7v-7l-2.35 2.34z"/>'
    '</svg>'
)


def shell(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(cmd, returncode=124,
                                           stdout=e.stdout or "", stderr="timeout")


def scan_wifis() -> list[tuple[str, str, int]]:
    """(ssid, security, signal%) for nearby networks, deduped, sorted by signal."""
    shell(["nmcli", "device", "wifi", "rescan"], timeout=12)
    r = shell(["nmcli", "-t", "-f", "SSID,SECURITY,SIGNAL", "device", "wifi", "list"])
    nets: list[tuple[str, str, int]] = []
    seen: set[str] = set()
    for line in r.stdout.split("\n"):
        if not line.strip():
            continue
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        ssid, sec, sig = parts[0], parts[1], parts[2]
        if not ssid or ssid in seen or ssid == HOTSPOT_SSID:
            continue
        seen.add(ssid)
        try:
            sig_i = int(sig)
        except ValueError:
            sig_i = 0
        nets.append((ssid, sec or "open", sig_i))
    nets.sort(key=lambda n: -n[2])
    return nets


def signal_class(sig: int) -> int:
    if sig >= 75:
        return 4
    if sig >= 50:
        return 3
    if sig >= 25:
        return 2
    return 1


def page(body: str) -> str:
    return PAGE.format(body=body)


@app.route("/static/<path:filename>")
def serve_static(filename: str):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/")
def index() -> str:
    nets = scan_wifis()
    if not nets:
        return page(
            '<div class="empty">'
            '<div class="sub">No WiFi networks visible yet.</div>'
            '<div class="sub" style="margin-top:4px">Make sure the radar is near your router.</div>'
            '</div>'
            '<form action="/" method="get">'
            f'<button type="submit" class="ghost">{REFRESH_SVG} Scan again</button>'
            '</form>'
        )
    parts = ['<p class="subtitle">Pick your home WiFi to set up the radar</p>',
             '<div class="nets">']
    for ssid, sec, sig in nets:
        s = signal_class(sig)
        sec_kind = "open" if sec in ("", "--", "open") else sec.split(" ")[0]
        is_secured = sec_kind != "open"
        lock_html = LOCK_SVG if is_secured else ''
        parts.append(
            '<form action="/auth" method="post">'
            f'<input type="hidden" name="ssid" value="{ssid}">'
            '<button class="net" type="submit">'
            f'<div class="signal s{s}">'
            '<span class="bar b1"></span><span class="bar b2"></span>'
            '<span class="bar b3"></span><span class="bar b4"></span>'
            '</div>'
            '<div class="net-info">'
            f'<div class="ssid"><span class="ssid-text">{ssid}</span>{lock_html}</div>'
            f'<div class="meta">{sec_kind} · signal {sig}%</div>'
            '</div>'
            '</button>'
            '</form>'
        )
    parts.append('</div>')
    parts.append(
        '<form action="/" method="get">'
        f'<button type="submit" class="ghost">{REFRESH_SVG} Scan again</button>'
        '</form>'
    )
    return page("\n".join(parts))


@app.route("/auth", methods=["POST"])
def auth() -> str:
    ssid = (request.form.get("ssid") or "").strip()
    if not ssid:
        return page('<div class="msg err">No network selected.</div>'
                    '<a class="back" href="/">← Back</a>')
    return page(
        '<div class="msg">'
        f'<div class="sub" style="margin-bottom:14px">Connecting to <b>{ssid}</b>. Enter the WiFi password:</div>'
        '<form action="/connect" method="post" autocomplete="off" '
        'onsubmit="this.querySelector(\'.primary\').disabled=true;this.querySelector(\'.primary\').textContent=\'Connecting…\';">'
        f'<input type="hidden" name="ssid" value="{ssid}">'
        '<input type="password" name="password" placeholder="WiFi password" '
        'autofocus autocapitalize="off" autocorrect="off" spellcheck="false">'
        '<button type="submit" class="primary">Connect</button>'
        '</form>'
        '</div>'
        '<div class="center"><a class="back" href="/">← Pick a different network</a></div>'
    )


def _join_async(ssid: str, password: str) -> None:
    """Background nmcli connect so the response can finish before the hotspot drops."""
    time.sleep(1)
    cmd = ["nmcli", "device", "wifi", "connect", ssid]
    if password:
        cmd += ["password", password]
    shell(cmd, timeout=60)


@app.route("/connect", methods=["POST"])
def connect() -> str:
    ssid = (request.form.get("ssid") or "").strip()
    password = request.form.get("password") or ""
    if not ssid:
        return page('<div class="msg err">No network selected.</div>'
                    '<a class="back" href="/">← Back</a>')
    threading.Thread(target=_join_async, args=(ssid, password), daemon=True).start()
    return page(
        '<div class="radar"></div>'
        f'<div class="msg">📡 Joining <b>{ssid}</b>…</div>'
        '<div class="sub center">The <b>QDRN-Radar-Setup</b> network will disappear in '
        'a few seconds — that\'s expected. The radar is moving to your home WiFi.</div>'
        '<div class="sub center" style="margin-top:18px">'
        'If your phone is still on <b>QDRN-Radar-Setup</b> after ~30 seconds, '
        'the connection failed — <a href="/">come back and try again</a>.</div>'
    )


# Captive-portal probe URLs across Android / iOS / Windows. Returning the
# portal directly (instead of a redirect) is more reliable across phones.
@app.route("/generate_204")
@app.route("/gen_204")
@app.route("/hotspot-detect.html")
@app.route("/library/test/success.html")
@app.route("/ncsi.txt")
@app.route("/connecttest.txt")
@app.route("/<path:_p>")
def catchall(_p: str | None = None) -> str:
    return index()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80)
