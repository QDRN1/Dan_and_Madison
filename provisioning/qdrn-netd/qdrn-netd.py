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
import time

SOCK_PATH = "/run/qdrn-net.sock"
MAX_REQ = 16 * 1024
CMD_TIMEOUT = 25


def shell(cmd: list[str], timeout: int = CMD_TIMEOUT, env: dict | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(cmd, 124, e.stdout or "", "timeout")


def _baked_ssids() -> set:
    """SSIDs from provisioning/baked-wifi.local.conf (the file is gitignored
    and lives on the host alongside the repo). Read fresh on every list call
    so the UI reflects deletions without us having to restart qdrn-netd.
    Returns an empty set if the file isn't present (e.g. fresh install with
    no baked networks)."""
    repo = os.environ.get("QDRN_REPO", "/opt/qdrn")
    path = os.path.join(repo, "provisioning", "baked-wifi.local.conf")
    out: set = set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                ssid = line.split("\t", 1)[0].strip()
                if ssid:
                    out.add(ssid)
    except OSError:
        pass
    return out


def list_wifi() -> dict:
    r = shell([
        "nmcli", "-t",
        "-f", "NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,DEVICE,STATE",
        "connection", "show",
    ])
    baked = _baked_ssids()
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
            # Owner-baked profile (HobbitHouse, LAN-Down-Under, …). The
            # Settings UI hides these from the saved list unless the SSID
            # also shows up in the latest scan — so the friend doesn't see
            # networks they have no business seeing.
            "baked": name in baked,
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
    """`git pull` the repo + rebuild the radar container from the freshly
    pulled source. Only the radar container churns (`--no-deps`) so the
    feeders stay running.

    qdrn-radar is a locally-built image (no registry), so the old
    `docker compose pull qdrn-radar` step erroneously tried to fetch
    qdrn-radar:latest from Docker Hub and failed with "pull access
    denied". `up -d --build` builds it from the working tree instead.
    We also export QDRN_BUILD_SHA / QDRN_BUILD_AT from the just-pulled
    commit so the Build line on the admin card matches what's running.

    The docker compose step is detached (Popen + start_new_session) so
    we can respond to the caller BEFORE it kills the container that's
    holding the HTTP request. Without this, Cloudflare returns 502
    every single time even though the update succeeded — the upstream
    just stopped existing mid-response.

    qdrn-netd runs as root but the repo typically lives in a regular
    user's home dir (e.g. /home/skytrack/Dan_and_Madison). Git's CVE
    -2022-24765 protection refuses to operate when the invoking UID
    differs from the repo owner unless `safe.directory` says it's OK,
    so we pass it inline. Per-invocation is cleaner than touching the
    root user's global git config."""
    repo = os.environ.get("QDRN_REPO", "/opt/qdrn")
    if not os.path.isdir(repo):
        return {"ok": False, "error": f"QDRN_REPO not found: {repo}"}
    git_safe = ["git", "-c", f"safe.directory={repo}", "-C", repo]
    pull = shell(git_safe + ["pull", "--ff-only"], timeout=120)
    if pull.returncode != 0:
        return {"ok": False, "error": f"git pull: {(pull.stderr or pull.stdout).strip()[:400]}"}
    # Stamp the build with the SHA we just pulled, so the admin "Build"
    # line reflects what's actually running.
    sha = shell(git_safe + ["rev-parse", "--short", "HEAD"], timeout=10)
    build_at = shell(git_safe + ["log", "-1", "--format=%cI", "HEAD"], timeout=10)
    env = os.environ.copy()
    if sha.returncode == 0 and sha.stdout.strip():
        env["QDRN_BUILD_SHA"] = sha.stdout.strip()
    if build_at.returncode == 0 and build_at.stdout.strip():
        env["QDRN_BUILD_AT"] = build_at.stdout.strip()
    # Fire-and-forget: the build+recreate step kills the qdrn-radar
    # container (the one calling us), so blocking on completion is
    # guaranteed to return 502 to the browser. Log to a file so the
    # outcome is recoverable for troubleshooting.
    compose = ["docker", "compose", "-f", os.path.join(repo, "docker-compose.yml"),
               "up", "-d", "--no-deps", "--build", "qdrn-radar"]
    log_path = "/var/log/qdrn-update.log"
    try:
        log_fh = open(log_path, "a")
        log_fh.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%S')} : {' '.join(compose)} ---\n")
        log_fh.flush()
    except OSError:
        log_fh = subprocess.DEVNULL
    subprocess.Popen(
        compose,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    new_sha = sha.stdout.strip() or "?"
    return {"ok": True, "sha": new_sha, "log": log_path}


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
