# jayhasty.com setup (DNS, email, subdomains)

One-time cutover from Squarespace to **Cloudflare DNS** + **Google Workspace** + your **Vultr** box (public portfolio + private Dashbird).

**URL rule:** use **subdomains for separate apps**, paths for pages inside the portfolio.

**Target layout**

| Host | Purpose |
|------|---------|
| `jayhasty.com` | Public portfolio (Featured-card site from `portfolio/products/website`) |
| `www.jayhasty.com` | Redirect → apex |
| `portfolio.jayhasty.com` | Alias → same static portfolio |
| `dashbird.jayhasty.com` | Private Dashbird (auth) |
| `calclaim.jayhasty.com` | Public CalClaim demo (later — Railway `CNAME` or Vultr proxy) |
| `otherproject.jayhasty.com` | Add later — same subdomain pattern |
| `you@example.com` | Gmail via Google Workspace |

Prefer `calclaim.jayhasty.com` / `dashbird.jayhasty.com` over `jayhasty.com/calclaim` — separate deploys, TLS, and auth stay isolated.

**Rough cost after cutover:** ~$10/yr domain (Cloudflare Registrar) + ~$7/mo Google Workspace + Vultr you already pay. **Cancel Squarespace website** (~$16+/mo saved).

---

## Before you start

Collect these:

1. **Vultr IPv4** — Vultr dashboard → your instance, or the Vultr dashboard IPv4.
2. **Squarespace login** — domain `jayhasty.com` is registered there today (or already on Cloudflare NS).
3. **Credit card** — Google Workspace (~$7/mo).
4. **15–30 minutes** — DNS can take up to an hour to propagate; domain *transfer* to Cloudflare can take days (optional — use Cloudflare nameservers first for speed).

**Portfolio publish path:** from `portfolio/products/website`, run `/usr/bin/npm run build:deploy` → copies static export into `dashbird/deploy/jayhasty-site/`. Multi-site Caddy is `deploy/Caddyfile.cloud.multisite` — **do not activate it until DNS A records are grey-cloud to Vultr** (Part 1), or ACME will fail and can burn Let's Encrypt rate limits. Until then, keep a single-host Caddyfile; after DNS is ready, activate multisite (`cp deploy/Caddyfile.cloud.multisite deploy/Caddyfile.cloud`).

**Current blocker (as of 2026-08):** Cloudflare NS are live, but apex/`portfolio` resolve through **orange proxy** and return **HTTP 525**. Flip those records to **DNS only (grey cloud)** pointing at the Vultr IP before Part 3.

---

## Part 1 — Cloudflare (DNS hub)

### 1.1 Add the domain to Cloudflare

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site** → enter `jayhasty.com`.
2. Pick the **Free** plan.
3. Cloudflare scans existing DNS — review later; you'll replace records in step 1.3.
4. Cloudflare shows **two nameservers** (e.g. `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`). Keep this tab open.

### 1.2 Point Squarespace to Cloudflare nameservers

1. Squarespace → **Settings** → **Domains** → `jayhasty.com`.
2. **DNS Settings** → **Custom nameservers** (or **Use third-party nameservers**).
3. Paste Cloudflare's two nameservers → save.
4. Wait until Cloudflare shows the site as **Active** (often 15–60 min; up to 24h).

You can cancel the Squarespace **website** subscription once DNS works on Cloudflare. Keep domain registration at Squarespace until you transfer (Part 1.4) or leave it there and only pay renewal (~$20/yr — Cloudflare is cheaper).

### 1.3 DNS records in Cloudflare

In Cloudflare → **DNS** → **Records**, delete Squarespace website records you don't need (old `CNAME` to Squarespace, etc.).

Add these (replace `YOUR_VULTR_IP` with your actual IPv4):

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| `A` | `@` | `YOUR_VULTR_IP` | DNS only (grey cloud) |
| `A` | `www` | `YOUR_VULTR_IP` | DNS only |
| `A` | `dashbird` | `YOUR_VULTR_IP` | DNS only |
| `A` | `portfolio` | `YOUR_VULTR_IP` | DNS only |
| `A` or `CNAME` | `calclaim` | Vultr IP **or** Railway/Pages target | DNS only (or CF Pages orange OK) |

**Grey cloud (DNS only)** for hosts terminated by Caddy on Vultr — Caddy owns TLS. **Orange proxy → HTTP 525** if origin has no cert yet (this is the current `jayhasty.com` failure mode).

Future apps: add `A` / `CNAME` `otherproject` → Vultr or Pages — **not** `jayhasty.com/otherproject`.

### 1.4 (Optional, recommended) Transfer domain to Cloudflare Registrar

Cheaper renewals (~$10/yr for `.com`):

1. Squarespace → domain → **Unlock** + copy **authorization code**.
2. Cloudflare → **Domain Registration** → **Transfer** → `jayhasty.com` + auth code.
3. Approve transfer email; wait 5–7 days. DNS stays on Cloudflare throughout.

---

## Part 2 — Google Workspace (`you@example.com`)

Do this **after** Cloudflare DNS is Active (Part 1.2).

### 2.1 Sign up

1. [workspace.google.com](https://workspace.google.com) → **Get started**.
2. Business name: your choice (e.g. "Jay Hasty").
3. Number of employees: **Just you**.
4. **Yes** — you have a domain → enter `jayhasty.com`.
5. Create admin user: **`jay`** → full address **`you@example.com`**. Choose a strong password.
6. Complete billing (~**$7/mo** Business Starter).

### 2.2 Verify domain ownership

Google Admin → **Account** → **Domains** → **Manage domains** → **Verify domain**.

Google offers a **TXT** record, e.g.:

```text
google-site-verification=xxxxxxxxxxxx
```

In Cloudflare DNS:

| Type | Name | Content |
|------|------|---------|
| `TXT` | `@` | `google-site-verification=...` (paste full value) |

Save → back in Google Admin → **Verify**. Can take a few minutes.

### 2.3 MX records (mail delivery)

Google Admin → **Activate Gmail** (or **Set up Gmail**). Use Google's **manual** MX setup if prompted.

In Cloudflare, add **all** of these (delete any old Squarespace MX records):

| Type | Name | Mail server | Priority |
|------|------|-------------|----------|
| `MX` | `@` | `aspmx.l.google.com` | 1 |
| `MX` | `@` | `alt1.aspmx.l.google.com` | 5 |
| `MX` | `@` | `alt2.aspmx.l.google.com` | 5 |
| `MX` | `@` | `alt3.aspmx.l.google.com` | 10 |
| `MX` | `@` | `alt4.aspmx.l.google.com` | 10 |

Use exactly what Google's setup wizard shows if it differs.

### 2.4 SPF (sender policy)

| Type | Name | Content |
|------|------|---------|
| `TXT` | `@` | `v=spf1 include:_spf.google.com ~all` |

If a TXT record already exists on `@`, merge SPF into one TXT (only one SPF per domain).

### 2.5 DKIM (sign outgoing mail)

Google Admin → **Apps** → **Google Workspace** → **Gmail** → **Authenticate email** → **Generate new record**.

Google gives a hostname like `google._domainkey` and a long TXT value.

| Type | Name | Content |
|------|------|---------|
| `TXT` | `google._domainkey` | (paste Google's value) |

Back in Admin → **Start authentication**.

### 2.6 DMARC (recommended)

| Type | Name | Content |
|------|------|---------|
| `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@example.com` |

Start with `p=none`; tighten to `quarantine` / `reject` later once mail is stable.

### 2.7 Test email

1. Open [mail.google.com](https://mail.google.com) → sign in as **`you@example.com`**.
2. Send a test to your personal Gmail; reply back.
3. Check spam folder on first messages.

**Mobile:** add the account in Gmail app (Google account type, not "other").

---

## Part 3 — Vultr (sites + Dashbird)

### 3.1 Update `.env` on the VPS

SSH to the server (`ssh root@YOUR_VULTR_IP`), edit `/opt/dashbird/.env`:

```bash
JAYHASTY_ROOT_DOMAIN=jayhasty.com
PORTFOLIO_DOMAIN=portfolio.jayhasty.com
DASHBOARD_DOMAIN=dashbird.jayhasty.com
DASHBOARD_LAN_ORIGIN=https://dashbird.jayhasty.com
VIKUNJA_SERVICE_PUBLICURL=https://dashbird.jayhasty.com/
CADDY_EMAIL=you@example.com
```

Keep existing auth hashes, API keys, and secrets unchanged.

If Gmail OAuth is configured for Events Finder, set:

```bash
GMAIL_OAUTH_REDIRECT_URI=https://dashbird.jayhasty.com/api/events-finder-gmail/oauth/callback
```

(Path is `/api/events-finder-gmail/oauth/callback`.)

### 3.2 Publish portfolio + sync + activate multi-site Caddy

From the portfolio website (local):

```bash
cd ~/jayprograms/portfolio/products/website
/usr/bin/npm run build:deploy
```

That writes static HTML into `~/jayprograms/dashbird/deploy/jayhasty-site/`.

From the dashbird repo root:

```bash
CLOUD_HOST=root@YOUR_VULTR_IP ./scripts/sync-to-cloud.sh
```

Do **not** use `SYNC_ENV=1` unless you intend to overwrite the server `.env` — edit `.env` on the server manually (step 3.1).

On the VPS, switch Caddy to the multi-site file (compose already mounts `deploy/jayhasty-site` → `/srv/jayhasty`):

```bash
cd /opt/dashbird
cp deploy/Caddyfile.cloud.multisite deploy/Caddyfile.cloud
```

### 3.3 Restart the cloud stack

On the VPS:

```bash
cd /opt/dashbird
docker compose -f docker-compose.cloud.yml up -d --build --force-recreate caddy dashboard
docker compose -f docker-compose.cloud.yml logs -f caddy
```

Caddy should obtain Let's Encrypt certs for all four hostnames. First visit may take 1–2 minutes per domain. Only do this **after** Cloudflare A records point at Vultr (grey cloud).

### 3.4 Re-bind trusted devices (one-time per device)

Open once on each device (enter basic-auth password if prompted):

- **Home Linux:** `https://dashbird.jayhasty.com/auth/device-bind?did=YOUR_LAPTOP_DEVICE_UUID`
- **Phone:** `https://dashbird.jayhasty.com/auth/device-bind?did=YOUR_PHONE_DEVICE_UUID`

Update phone/laptop bookmarks to `https://dashbird.jayhasty.com`.

### 3.5 Google Cloud OAuth (Events Finder Gmail)

If you use Dashbird Gmail ingest:

1. [Google Cloud Console](https://console.cloud.google.com) → your project → **APIs & Services** → **Credentials** → OAuth client.
2. **Authorized redirect URIs** → add:
   `https://dashbird.jayhasty.com/api/events-finder-gmail/oauth/callback`
3. In Dashbird → Events Finder → reconnect Gmail OAuth.

---

## Part 4 — Smoke tests

| Check | URL / action |
|-------|----------------|
| Portfolio home (Featured cards) | `https://jayhasty.com` |
| www redirect | `https://www.jayhasty.com` → apex |
| Portfolio alias | `https://portfolio.jayhasty.com` |
| Dashbird loads | `https://dashbird.jayhasty.com` (auth or trusted device) |
| Receive mail | Send to `you@example.com` from outside |
| Send mail | Send from `you@example.com` to yourself |
| TLS | Padlock on all HTTPS URLs |
| DNS not proxied | `dig +short jayhasty.com` returns Vultr IP (not Cloudflare `104.21.*` / `172.67.*`) |

---

## Part 5 — Cancel Squarespace

1. Confirm all checks above pass.
2. Squarespace → **Settings** → **Billing** → cancel **website** plan.
3. If domain transferred to Cloudflare (Part 1.4), remove domain from Squarespace when transfer completes.
4. Export anything you want from the old Squarespace site (text, images) before canceling.

---

## Adding `calclaim.jayhasty.com` / `otherproject.jayhasty.com` later

**CalClaim (Vultr + Caddy — current):**

1. **Cloudflare:** `A` `calclaim` → Vultr IP. **Proxied (orange) is fine** (same pattern as live `dashbird`); fighting the grey-cloud toggle kept deleting this record and causing NXDOMAIN after deploys.
2. Put `CLOUDFLARE_API_TOKEN` (Zone DNS Edit on `jayhasty.com`) in `calclaim/.env` so `scripts/sync-to-cloud.sh` upserts the record every deploy via `scripts/ensure-calclaim-dns.sh`.
3. On VPS: set `CALCLAIM_DOMAIN=calclaim.jayhasty.com` in `/opt/dashbird/.env`, use multisite Caddy with the calclaim `reverse_proxy` block.
4. From `calclaim/`: `CLOUD_HOST=root@VULTR_IP ./scripts/sync-to-cloud.sh` (deploys `/opt/calclaim`, upserts DNS, verifies public HTTPS).
5. Recreate Caddy if the site block is new: `docker compose -f docker-compose.cloud.yml up -d --force-recreate caddy` in `/opt/dashbird`.
6. Do **not** put CalClaim under `jayhasty.com/calclaim`.

**CalClaim (Railway alternative):** `CNAME` `calclaim` → Railway hostname instead of Vultr `A`, then set the same `PUBLIC_BASE_URL`.

**Other apps on Vultr:**

1. **Cloudflare:** `A` record `otherproject` → Vultr IP (DNS only).
2. **Caddy:** new site block in `deploy/Caddyfile.cloud` (static files or `reverse_proxy`).
3. **Compose:** mount volume if serving static files.
4. Sync + `docker compose -f docker-compose.cloud.yml up -d` on VPS.

Public projects can also use **Cloudflare Pages** (`CNAME otherproject` → `your-project.pages.dev`) instead of Vultr.

---

## Troubleshooting

**Cloudflare site not Active** — nameservers at Squarespace must match Cloudflare exactly; wait up to 24h.

**Caddy cert errors** — records must be grey-cloud DNS-only; ports 80/443 open on Vultr firewall.

**Mail not arriving** — confirm MX points to Google only; SPF/DKIM TXT present; wait 1–24h after DNS change.

**Gmail OAuth fails** — redirect URI in Google Cloud must match `.env` exactly (https, no trailing slash on origin).

**502 on dashbird** — `docker compose -f docker-compose.cloud.yml ps` and `logs dashboard`.

---

## Related

- Cloud stack env template: [`deploy/env.cloud.example`](../deploy/env.cloud.example)
- Vultr deploy overview: [`deploy-vultr.md`](deploy-vultr.md)
- Security tiers: [`security-plan.md`](security-plan.md)
