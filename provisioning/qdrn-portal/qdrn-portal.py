#!/usr/bin/env python3
"""QDRN captive portal — listed when the Pi is in hotspot mode.

Pure Flask app. Lists nearby WiFi networks via `nmcli`, lets the owner pick one
and enter a password, then calls `nmcli device wifi connect` to switch. The
companion qdrn-watcher service brings up the NetworkManager hotspot connection
and starts this Flask app whenever the Pi can't reach any other network.
"""
from __future__ import annotations

import subprocess
import threading
import time

from flask import Flask, request

app = Flask(__name__)

HOTSPOT_SSID = "QDRN-Radar-Setup"

PAGE = """<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<title>QDRN Radar setup</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
  :root {{ --bg:#001533; --surface:#002D72; --accent:#A3C940; --text:#F0F0F0; --muted:#9fb0c9; --border:#1c3a72; --danger:#ff7676; }}
  * {{ box-sizing:border-box; }}
  body {{ font-family:-apple-system,system-ui,sans-serif; background:var(--bg); color:var(--text); padding:24px 18px 40px; max-width:480px; margin:0 auto; line-height:1.4; }}
  h1 {{ color:var(--accent); font-size:22px; margin:0 0 4px; }}
  .sub {{ color:var(--muted); font-size:13px; margin-bottom:18px; }}
  button.net {{ display:block; width:100%; text-align:left; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin:8px 0; color:var(--text); cursor:pointer; font:inherit; }}
  button.net:hover, button.net:focus {{ border-color:var(--accent); outline:none; }}
  .ssid {{ font-weight:700; font-size:15px; }}
  .meta {{ font-size:11px; color:var(--muted); margin-top:3px; letter-spacing:.03em; text-transform:uppercase; }}
  input, button.primary {{ width:100%; padding:13px; margin:8px 0; font-size:16px; border-radius:10px; border:1px solid var(--border); background:var(--surface); color:var(--text); }}
  input:focus {{ outline:none; border-color:var(--accent); }}
  button.primary {{ background:var(--accent); color:var(--bg); font-weight:700; border:none; cursor:pointer; }}
  .msg {{ padding:14px; background:var(--surface); border:1px solid var(--accent); border-radius:10px; margin:14px 0; }}
  .msg.err {{ border-color:var(--danger); }}
  a {{ color:var(--accent); }}
  code {{ font-size:12px; word-break:break-all; }}
</style>
</head>
<body>
<h1>🛰 QDRN Radar setup</h1>
{body}
</body>
</html>"""


def shell(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(cmd, returncode=124,
                                           stdout=e.stdout or "", stderr="timeout")


def scan_wifis() -> list[tuple[str, str, int]]:
    """(ssid, security, signal%) for nearby networks, deduped, by signal."""
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


def page(body: str) -> str:
    return PAGE.format(body=body)


@app.route("/")
def index() -> str:
    nets = scan_wifis()
    if not nets:
        return page(
            '<div class="sub">No WiFi networks visible yet.</div>'
            '<a href="/">↻ Scan again</a>'
        )
    items = [
        '<div class="sub">Pick your WiFi network to connect this radar:</div>'
    ]
    for ssid, sec, sig in nets:
        sec_kind = "open" if sec in ("", "--", "open") else sec.split(" ")[0]
        items.append(
            '<form action="/auth" method="post">'
            f'<input type="hidden" name="ssid" value="{ssid}">'
            f'<button class="net" type="submit">'
            f'<div class="ssid">{ssid}</div>'
            f'<div class="meta">{sec_kind} · signal {sig}%</div>'
            '</button></form>'
        )
    return page("\n".join(items))


@app.route("/auth", methods=["POST"])
def auth() -> str:
    ssid = (request.form.get("ssid") or "").strip()
    if not ssid:
        return page(
            '<div class="msg err">No network selected.</div>'
            '<a href="/">← Back</a>'
        )
    return page(
        f'<div class="sub">Connecting to <b>{ssid}</b>. Enter its WiFi password:</div>'
        '<form action="/connect" method="post">'
        f'<input type="hidden" name="ssid" value="{ssid}">'
        '<input type="password" name="password" placeholder="WiFi password" '
        'autofocus autocapitalize="off" autocorrect="off" spellcheck="false">'
        '<button type="submit" class="primary">Connect</button>'
        '</form>'
        '<div style="margin-top:12px"><a href="/">← Pick a different network</a></div>'
    )


def _join_async(ssid: str, password: str) -> None:
    """Do the nmcli connect in a background thread so the Flask response can be
    delivered BEFORE the hotspot (and therefore this connection) goes away."""
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
        return page(
            '<div class="msg err">No network selected.</div>'
            '<a href="/">← Back</a>'
        )
    threading.Thread(
        target=_join_async, args=(ssid, password), daemon=True
    ).start()
    return page(
        f'<div class="msg">📡 Joining <b>{ssid}</b>…</div>'
        '<div class="sub">In a few seconds, this <b>QDRN-Radar-Setup</b> '
        'network will disappear — that\'s expected. The radar is switching '
        'to your home WiFi.</div>'
        '<div class="sub">If your phone is still on QDRN-Radar-Setup after '
        '~30 seconds, the connection failed — '
        '<a href="/">come back and try again</a>.</div>'
    )


# Captive-portal probe URLs: Android, iOS, Windows all poll a known URL on
# join. Returning the portal HTML (instead of the expected response) tells
# the OS this is a captive portal, which pops the page automatically.
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
    # Plain Flask dev server is fine here — a captive portal is one user,
    # very low traffic, and pulling in gunicorn would just add weight.
    app.run(host="0.0.0.0", port=80)
