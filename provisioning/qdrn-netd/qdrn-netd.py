#!/usr/bin/env python3
"""QDRN host network helper.

Tiny Unix-socket service the radar container talks to so it can list / add /
remove NetworkManager WiFi profiles without needing nmcli or D-Bus access
inside the container. Socket lives at /run/qdrn-net.sock; docker-compose
mounts the same path into the radar container.

Authentication is the radar server's PIN-gated endpoint that proxies to us —
this socket is intentionally 0666 so the containerized server can connect
regardless of its UID.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess

SOCK_PATH = "/run/qdrn-net.sock"
MAX_REQ = 16 * 1024
CMD_TIMEOUT = 25


def shell(cmd: list[str], timeout: int = CMD_TIMEOUT) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(cmd, 124, e.stdout or "", "timeout")


def list_wifi() -> dict:
    r = shell([
        "nmcli", "-t",
        "-f", "NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,DEVICE,STATE",
        "connection", "show",
    ])
    out = []
    for line in r.stdout.split("\n"):
        if not line.strip():
            continue
        parts = line.split(":")
        if len(parts) < 7:
            continue
        name, uuid, kind, ac, prio, device, state = parts[:7]
        if kind != "802-11-wireless":
            continue
        try:
            prio_i = int(prio)
        except ValueError:
            prio_i = 0
        out.append({
            "name": name,
            "uuid": uuid,
            "autoconnect": ac == "yes",
            "priority": prio_i,
            "active": bool(device) and state == "activated",
        })
    return {"ok": True, "networks": out}


def add_wifi(req: dict) -> dict:
    ssid = (req.get("ssid") or "").strip()
    password = req.get("password") or ""
    try:
        priority = int(req.get("priority") or 50)
    except (TypeError, ValueError):
        priority = 50
    if not ssid:
        return {"ok": False, "error": "ssid required"}

    # If a profile with that name already exists, replace it (idempotent edits).
    shell(["nmcli", "connection", "delete", ssid], timeout=5)

    cmd = [
        "nmcli", "connection", "add", "type", "wifi",
        "con-name", ssid, "ssid", ssid,
        "connection.autoconnect", "yes",
        "connection.autoconnect-priority", str(priority),
    ]
    if password:
        cmd += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
    r = shell(cmd)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout).strip() or "nmcli add failed"}
    return {"ok": True}


def remove_wifi(req: dict) -> dict:
    target = (req.get("uuid") or req.get("name") or "").strip()
    if not target:
        return {"ok": False, "error": "name or uuid required"}
    r = shell(["nmcli", "connection", "delete", target])
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "").strip() or "delete failed"}
    return {"ok": True}


def connect_wifi(req: dict) -> dict:
    """Activate a saved NetworkManager profile (switch to it). Triggers a brief
    WiFi handoff — the existing connection drops while NM brings up the new one."""
    target = (req.get("uuid") or req.get("name") or "").strip()
    if not target:
        return {"ok": False, "error": "name or uuid required"}
    r = shell(["nmcli", "connection", "up", target], timeout=45)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout).strip() or "activation failed"}
    return {"ok": True}


def scan_wifi(_req: dict) -> dict:
    """Force a fresh WiFi scan and return nearby APs (deduped, signal-sorted).
    Uses `nmcli ... --rescan yes` so we BLOCK on the scan completing — the
    older "rescan; then list" approach returned stale data because rescan
    returns before the radio finishes hopping channels."""
    r = shell(
        ["nmcli", "--escape", "no", "-t",
         "-f", "SSID,SECURITY,SIGNAL", "device", "wifi", "list", "--rescan", "yes"],
        timeout=20,
    )
    nets, seen = [], set()
    for line in r.stdout.split("\n"):
        if not line.strip():
            continue
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        ssid, sec, sig = parts[0], parts[1], parts[2]
        # Drop empty (hidden) SSIDs, our own setup hotspot, and dups.
        if not ssid or ssid in seen or ssid == "QDRN-Radar-Setup":
            continue
        seen.add(ssid)
        try:
            sig_i = int(sig)
        except ValueError:
            sig_i = 0
        nets.append({
            "ssid": ssid,
            "secured": bool(sec) and sec not in ("--", "open"),
            "security": sec or "open",
            "signal": sig_i,
        })
    nets.sort(key=lambda n: -n["signal"])
    return {"ok": True, "networks": nets}


def restart_radar(_req: dict) -> dict:
    """Bounce only the qdrn-radar container — feeders stay up. No-op if
    docker isn't reachable (dev shell)."""
    repo = os.environ.get("QDRN_REPO", "/opt/qdrn")
    r = shell(["docker", "compose", "-f", os.path.join(repo, "docker-compose.yml"), "restart", "qdrn-radar"], timeout=60)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout).strip() or "compose restart failed"}
    return {"ok": True}


def update_radar(_req: dict) -> dict:
    """`git pull` the repo + pull the latest container image + re-up the
    radar. Only the radar container churns (`--no-deps`) so the feeders
    stay running.

    qdrn-netd runs as root but the repo typically lives in a regular
    user's home dir (e.g. /home/skytrack/Dan_and_Madison). Git's CVE
    -2022-24765 protection refuses to operate when the invoking UID
    differs from the repo owner unless `safe.directory` says it's OK,
    so we pass it inline. Per-invocation is cleaner than touching the
    root user's global git config."""
    repo = os.environ.get("QDRN_REPO", "/opt/qdrn")
    if not os.path.isdir(repo):
        return {"ok": False, "error": f"QDRN_REPO not found: {repo}"}
    compose = ["docker", "compose", "-f", os.path.join(repo, "docker-compose.yml")]
    steps = [
        (["git", "-c", f"safe.directory={repo}", "-C", repo, "pull", "--ff-only"], 120),
        (compose + ["pull", "qdrn-radar"], 600),
        (compose + ["up", "-d", "--no-deps", "qdrn-radar"], 600),
    ]
    for cmd, timeout in steps:
        r = shell(cmd, timeout=timeout)
        if r.returncode != 0:
            return {"ok": False, "error": f"{' '.join(cmd)}: {(r.stderr or r.stdout).strip()[:400]}"}
    return {"ok": True}


def handle(req: dict) -> dict:
    op = req.get("op")
    if op == "list":
        return list_wifi()
    if op == "add":
        return add_wifi(req)
    if op == "remove":
        return remove_wifi(req)
    if op == "connect":
        return connect_wifi(req)
    if op == "scan":
        return scan_wifi(req)
    if op == "restart":
        return restart_radar(req)
    if op == "update":
        return update_radar(req)
    return {"ok": False, "error": f"unknown op: {op!r}"}


def main() -> None:
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(SOCK_PATH)
    os.chmod(SOCK_PATH, 0o666)
    s.listen(8)
    print(f"qdrn-netd listening on {SOCK_PATH}", flush=True)
    while True:
        try:
            conn, _ = s.accept()
        except KeyboardInterrupt:
            break
        try:
            conn.settimeout(CMD_TIMEOUT + 5)
            buf = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                if b"\n" in chunk or len(buf) > MAX_REQ:
                    break
            try:
                req = json.loads(buf.decode().strip() or "{}")
                resp = handle(req)
            except Exception as e:
                resp = {"ok": False, "error": f"bad request: {e}"}
            conn.sendall((json.dumps(resp) + "\n").encode())
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
