# Cloudflare Tunnel + Access (radar.qdrn.io/md)

The Pi has no public IP. A Cloudflare Tunnel gives `radar.qdrn.io/md` a stable,
HTTPS address and lets you SSH in remotely — no port forwarding, no dynamic DNS.

## Option A — Token mode (recommended, turnkey)

1. Cloudflare Zero Trust dashboard → **Networks → Tunnels → Create a tunnel**
   (Cloudflared). Name it `qdrn-radar`. Copy the **tunnel token**.
2. Put it in `.env` as `CF_TUNNEL_TOKEN=...`. The `cloudflared` service in
   `docker-compose.yml` runs it automatically.
3. In the tunnel's **Public Hostnames**, add:
   - `radar.qdrn.io` → `http://qdrn-radar:8080`
   - `ssh.radar.qdrn.io` → `ssh://localhost:22`  (for remote SSH)

## Option B — Config file mode

Use `config.example.yml` (see the steps in that file) if you prefer to manage
the tunnel from the Pi with a credentials JSON.

## Hidden admin page (Cloudflare Access)

The app's admin console is at `radar.qdrn.io/md/admin`. Lock it down at the edge:

1. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: `radar.qdrn.io`  **Path:** `/md/admin`
   (and add a second app/path for `/md/admin/api` so the API is gated too).
3. Policy: **Allow**, include rule **Emails → collin@qdrn.io** (add others as needed).
4. Cloudflare injects `Cf-Access-Authenticated-User-Email`; the app re-checks it
   against `ADMIN_EMAILS` in `.env` (defense in depth).

The friend-facing setup wizard at `/md/setup` is **not** behind Access — it uses
the simple device PIN (`SETUP_PIN`) so your non-technical friend can use it, but
randoms can't change settings.

## Remote SSH

With `ssh.radar.qdrn.io` routed (above) and Access configured for it:

```
# one-time on your laptop:
cloudflared access ssh-config --hostname ssh.radar.qdrn.io --short-lived-cert
# then:
ssh pi@ssh.radar.qdrn.io
```

Make sure SSH is enabled on the Pi (`sudo raspi-config` → Interface Options → SSH,
or `provisioning/install.sh` does this for you).
