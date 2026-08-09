# Deploy dashbird on Vultr (Silicon Valley) + jayhasty.com

**Target:** always-on personal dashboard at `https://dashbird.jayhasty.com`  
**Plan:** Vultr Cloud Compute **2 GB**, region **Silicon Valley**, ~**$10/mo**  
**Image:** slim [`Dockerfile.cloud`](../Dockerfile.cloud) (no Playwright Chromium on the VPS)

LAN Docker ([`docker-compose.yml`](../docker-compose.yml)) remains for local desktop tiles / Playwright enrich. Cloud is the daily driver for search, bookmarks, tools (stored images), events, network, todos.

## Architecture

- **Caddy** — TLS (Let’s Encrypt) + HTTP basic auth → `dashboard:3000`
- **dashboard** — Node slim image; `data/` + `public/` bind-mounted
- **Vikunja** — todos; internal only; Dashbird proxies `/api/vikunja`
- **Tool images** — served from `data/tool-library-assets/` (snapshot once). `TOOL_LIBRARY_SCREENSHOT=0` on the VPS. New Playwright captures: enrich on LAN, then rsync.
- **Big Events research** — LAN finds event URLs / fliers via headless Chrome; the slim cloud image can't. Set `BRAVE_SEARCH_API_KEY` (free tier ≈ 2k/mo, $0 — https://api.search.brave.com) + `OPENROUTER_API_KEY` on the VPS so events added on cloud still discover the official URL, correct the name, and pull a thumbnail (search via Brave API; page fetch + name/date extraction over plain HTTPS). Without the keys, research on cloud is a no-op — enrich on LAN and `SYNC_DATA=1 ./scripts/sync-to-cloud.sh` instead.

## One-time server setup

1. Create Vultr **Shared CPU** / Cloud Compute **2 GB** in **Silicon Valley**, Ubuntu LTS, SSH access.
2. Point Cloudflare DNS A records for `dashbird.jayhasty.com` (and portfolio hosts) at the instance IPv4 — DNS only (grey cloud). See [`jayhasty-setup.md`](jayhasty-setup.md).
3. On the VPS:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/dashbird
```

4. From your laptop (repo root):

```bash
CLOUD_HOST=root@YOUR_VULTR_IP SYNC_DATA=0 SYNC_ENV=0 ./scripts/sync-to-cloud.sh
```

5. On the VPS, create `.env`:

```bash
cd /opt/dashbird
cp deploy/env.cloud.example .env
# edit: CADDY_EMAIL, DASHBOARD_BASIC_AUTH_HASH, DASHBOARD_TRUSTED_DEVICE_SECRET, DASHBOARD_TRUSTED_DEVICE_IDS, VIKUNJA_SERVICE_SECRET, API tokens
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOUR_PASSWORD'
# paste into DASHBOARD_BASIC_AUTH_HASH= with every `$` doubled for Compose:
#   $2a$14$abc...  →  $$2a$$14$$abc...
# trusted devices (passwordless for Jay home Linux + phone only):
#   openssl rand -base64 48  →  DASHBOARD_TRUSTED_DEVICE_SECRET=
#   DASHBOARD_TRUSTED_DEVICE_IDS=edd37155-3ffe-4d18-a775-d6cdcedbf343,1c0c1947-ad36-4032-aed5-00eb5b28e166
```

6. Bring up the stack:

```bash
cd /opt/dashbird
mkdir -p data/vikunja/db data/vikunja/files public/data
docker compose -f docker-compose.cloud.yml up -d --build
docker compose -f docker-compose.cloud.yml ps
```

7. **One-time per device** — open these bookmarks (no password after this):
   - **Home Linux laptop:** `https://dashbird.jayhasty.com/auth/device-bind?did=edd37155-3ffe-4d18-a775-d6cdcedbf343`
   - **Phone:** `https://dashbird.jayhasty.com/auth/device-bind?did=1c0c1947-ad36-4032-aed5-00eb5b28e166`
   Other browsers/devices still require basic auth every visit. Revoke trust by rotating `DASHBOARD_TRUSTED_DEVICE_SECRET` in `.env` and rebuilding.

If basic-auth credentials were generated on the server:

```bash
ssh root@YOUR_VULTR_IP 'cat /root/dashbird-basic-auth.txt'
```

Firewall: allow **22**, **80**, **443** (Vultr firewall group or `ufw`).

### LAN fallback + Playwright enrich

- Keep the home LAN stack available for a few days after cutover (read-only or stopped writers) so you can fall back if needed.
- **Daily driver:** bookmark `https://dashbird.jayhasty.com` on phone and laptop.
- **New tool screenshots:** on LAN (`docker-compose.yml` Playwright image), enrich the tool so PNGs land in `data/tool-library-assets/`, then:

```bash
CLOUD_HOST=root@YOUR_VULTR_IP SYNC_DATA=1 ./scripts/sync-to-cloud.sh
```

## Data cutover (personal data — never git)

On the LAN machine that has live `data/`:

```bash
# brief pause of local writers recommended
docker compose down   # local LAN stack, optional

CLOUD_HOST=root@YOUR_VULTR_IP SYNC_DATA=1 ./scripts/sync-to-cloud.sh
```

This rsyncs `data/` (tools, network DB, events, assets — **not** Keep Notes / `keep-import`), personal `public/data/*`, and `.env`, then rebuilds. Keep Notes stay local to each host.

Smoke checklist:

- [ ] Search focuses and Enter opens an engine tab
- [ ] Bookmarks tiles clickable
- [ ] Tool Library shows **stored** logos/snapshots
- [ ] Network / Events panels load
- [ ] Vikunja todos (after `VIKUNJA_TOKEN` set)
- [ ] Gmail OAuth redirect updated to `https://dashbird.jayhasty.com/...` and re-consented
- [ ] Telegram poller if used

Keep LAN offline or read-only for a few days as fallback.

## Code-only deploys (after cutover)

### From phone (Cursor app) — GitHub Actions

Push to `main` deploys code to Vultr automatically (no laptop SSH).

**One-time setup** (from the home laptop, once):

```bash
# needs: gh auth login, and SSH to the VPS already working
CLOUD_HOST=root@YOUR_VULTR_IP ./scripts/setup-phone-deploy.sh
```

That installs a deploy SSH key on the VPS and sets repo secrets `CLOUD_HOST` + `CLOUD_SSH_PRIVATE_KEY`.

**Phone workflow:**

1. Edit in Cursor on the phone (cloud agent is fine).
2. Commit and **push to `main`** (or merge a PR into `main`).
3. GitHub Action **Deploy cloud** rsyncs code → `/opt/dashbird` and rebuilds `dashboard` + `caddy`.
4. Hard-refresh `https://dashbird.jayhasty.com`.

Manual re-run: GitHub → Actions → **Deploy cloud** → Run workflow.

CI is **code-only** — it never syncs `data/` or `.env`. Tool PNGs / network DB still use the laptop path below.

### From laptop (rsync)

Default — no flags needed (reads `CLOUD_HOST` from `.env` if set):

```bash
./scripts/sync-to-cloud.sh
# or: CLOUD_HOST=root@YOUR_VULTR_IP ./scripts/sync-to-cloud.sh
```

To also push personal `data/` (tool PNGs, network DB, etc.): `SYNC_DATA=1 SYNC_DATA_CONFIRM=1 ./scripts/sync-to-cloud.sh`

## New tool screenshots (Playwright)

On **2 GB** cloud, Chromium capture is off. To add a snapshot for a new tool:

1. On LAN (Playwright image): enrich / add the tool so `data/tool-library-assets/` gets a PNG.
2. Rsync data up: `CLOUD_HOST=root@... SYNC_DATA=1 ./scripts/sync-to-cloud.sh`

Or upgrade Vultr to **4 GB (~$20)** and set `TOOL_LIBRARY_SCREENSHOT=1` (and use the Playwright Dockerfile if you choose).

## Nightly backups (on the VPS)

```bash
chmod +x /opt/dashbird/scripts/cloud-backup.sh
apt-get install -y sqlite3   # optional, for .backup
mkdir -p /var/backups/dashbird
crontab -e
# 15 3 * * * /opt/dashbird/scripts/cloud-backup.sh >> /var/log/dashbird-backup.log 2>&1
```

## Related

- Env template: [`deploy/env.cloud.example`](../deploy/env.cloud.example)
- Compose: [`docker-compose.cloud.yml`](../docker-compose.cloud.yml)
- Security: [`security-plan.md`](security-plan.md)
- Historical Hetzner notes: [`deploy-hetzner.md`](deploy-hetzner.md)
