# Working notes for Claude in this repo

## NEVER suggest destructive shell commands without a verified backup first

Burned on 2026-06-11: I gave the user a multi-step "scorched earth" reset
that included `rm -f .env` and `rm -rf data/` with the backup step listed
*after* the destructive commands as "belt-and-suspenders." The user ran
the destructive lines before the backup line and lost the `CF_TUNNEL_TOKEN`
along with the rest of the `.env`.

### Hard rules going forward

- **Never** issue any destructive command in this repo (rm, `compose down
  --volumes`, `git reset --hard`, dropping tables, wiping SD cards,
  reset/reflash recipes, etc.) unless the response begins with an
  explicit backup step that the user must run first.
- Treat **`.env`, `data/qdrn-radar.db`, `data/feeder.env`,
  `provisioning/baked-wifi.local.conf`, and anything under `~/.cloudflared/`**
  as load-bearing secrets/state. Each is irrecoverable from this repo
  alone. Back up every time, every command, no exceptions.
- The backup must verify, not just copy. Always include a `cat` / `grep`
  /`ls` line that proves the backup landed and contains the expected
  content. Don't trust that `cp` succeeded silently.
- If a backup command is impractical or the user has already run the
  destructive command, switch to recovery mode (pull values from running
  containers, search the disk, Cloudflare dashboard) — but always
  acknowledge the destructive step shipped without a guard first.
- Phrase optional/recovery steps clearly. "Insurance" / "belt and
  suspenders" / "if you want" makes users skip them. Mandatory steps go
  before destructive commands as numbered steps the user must execute
  in order.
- Prefer non-destructive paths by default. The "friend-fresh" wipe (drop
  the SQLite DB but keep `.env`) is almost always the right answer for
  resetting; recommend it first, mention scorched earth only with the
  guard rails in place.
