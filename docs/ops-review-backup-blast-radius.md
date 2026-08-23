# Ops review: backup procedure & blast radius

Read-only investigation covering two dev requests:

- **[97d36a8f]** Review backup procedure, frequency, and rollback.
- **[9cde97e5]** Review blast radius.

Scope: `docker-compose*.yml`, `deploy/`, `scripts/`, `src/lib/data-backup-schedule.js`, `src/lib/trusted-device-auth.js`, `src/server.js`, `data/` on the LAN host, `docs/`, and `.cursor/rules`. No application code or config was changed; this is documentation only.

---

## Topic 1 — Backup procedure, frequency, and rollback [97d36a8f]

### Current state

**What data matters (all under `data/`, bind-mounted into the container):**

| Kind | Examples | Notes |
|------|----------|-------|
| SQLite DBs | `network.db` (CRM), `events-finder.db`, `telegram-intake.db`, `dev-requests.db`, `data/vikunja/db` (Vikunja todos) | Each is a single file with active `-wal`/`-shm` sidecars. |
| JSON stores | `tool-library.json`, `events-finder-*.json`, `gmail-*-summary*.json`, `dashboard-costs.json`, `network-*.json`, many caches | Mix of source-of-truth (tools, costs, criteria) and regenerable caches. |
| Assets / media | `network-assets/`, `tool-library-assets/`, `telegram-intake-media/`, `keep-notes/` | Binary; large share of backup size. |
| Secrets on disk | Gmail OAuth token files (`GMAIL_INTAKE_TOKENS_DIR` under `data/`) | Present inside `data/`, therefore inside every backup tarball (see gap #6). |
| Stale manual `.bak` | `events-finder.db.bak`, `network.db.bak`, `telegram-intake.db.bak` (all 2026‑07‑16) | One-off snapshots, not part of any schedule. |

**Backup mechanism that exists today — two independent paths:**

1. **In-app schedulers** (`src/lib/data-backup-schedule.js`, started from `src/server.js` at lines 240–241). Run inside the Node process on whichever host is up:
   - **Daily full tarball** → `data/backups/daily-YYYY-MM-DD.tar.gz`, default **03:15 America/Los_Angeles**, retain **14** days. Snapshots `network.db`, `events-finder.db`, `telegram-intake.db` via `VACUUM INTO` (consistent even with WAL), excludes `data/backups`, and adds `public/data/bookmarks-personal.json` + `public/data/bookmarks-work.json` + `public/data/notes.md`.
   - **Weekly tools+contacts** → `data/backups/tools-contacts-YYYY-MM-DD/`, default **Sunday 03:00**, retain **8** folders. Copies `network.db` (VACUUM), `network-assets/`, `tool-library.json`, `tool-library-assets/`, plus `manifest.json`.
   - Both write `public/data/last-backup.txt`, surfaced in the health sidebar via `/api/config`.
   - Config via `.env` (`DATA_BACKUP_*`); both default **on**.
2. **Cloud shell script** (`scripts/cloud-backup.sh`) intended to run on the VPS **via cron** (`15 3 * * *`) → `/var/backups/dashbird/dashbird-data-*.tar.gz`, `KEEP_DAYS=14`. Uses `sqlite3 .backup` to make `.bak` copies, then tars `data/`. This is a **separate, manually-installed** mechanism from the in-app scheduler.

**Off-host / sync:** `scripts/sync-to-cloud.sh` and `sync-from-cloud.sh` rsync between LAN and cloud, but `data/` is **excluded unless `SYNC_DATA=1`** is set explicitly. Even with `SYNC_DATA=1`, **Keep Notes** (`data/keep-notes/`, `data/keep-import/`) are never synced — each host keeps its own. These are manual, human-triggered.

**Rollback / restore:**
- Weekly CRM + tools: `node scripts/restore-tools-contacts-backup.mjs [YYYY-MM-DD|--list]` (stop stack first; it `rm -rf`s the destination then copies, and drops `network.db` WAL sidecars).
- Daily tarball: manual `tar -xzf data/backups/daily-*.tar.gz` from repo root (documented in `docs/backups.md`, incl. a clean-tree variant).
- Restore procedure is documented and the network-safety rule (`.cursor/rules/network-data-safety.mdc`) governs CRM restores.

**Observed on the LAN host now:** `data/backups/` holds `daily-2026-07-16/-17/-19`, `tools-contacts-2026-07-12` and `-07-19`, and one `events-finder-pre-merge-2026-07-16.db`. Host `crontab -l` is empty (expected on LAN; cloud cron unverified from here).

### Risks / gaps

1. **Backups live on the same disk as the live data** — `data/backups/` is inside the very `data/` tree it protects. A disk failure, accidental `rm -rf data`, or ransomware takes live data **and** all backups together. There is no *automatic* off-host copy (`sync-*.sh` is manual and defaults to skipping `data/`).
2. **Cloud backups are same-host too** — `cloud-backup.sh` writes to `/var/backups/dashbird` on the same VPS. If the Vultr instance is lost/terminated, its backups are lost with it.
3. **Cloud cron is manual and unverified** — nothing confirms `cloud-backup.sh` is installed or succeeding; it must be added by hand per `deploy-vultr.md`.
4. **A daily backup is already missing** — there is no `daily-2026-07-18.tar.gz`. The in-app scheduler only fires if the process is alive at the scheduled minute and there is **no catch-up on startup**, so a container that was down at 03:15 silently skips the day.
5. **No restore drill / no integrity verification** — backups are produced but never test-restored; `last-backup.txt` only proves a file was written, not that it restores.
6. **Backups are unencrypted and contain secrets** — Gmail OAuth tokens and other credentials inside `data/` end up in every tarball. Fine on a trusted disk, but any off-host copy would carry plaintext secrets.
7. **Not every DB gets a consistent snapshot** — only `network/events-finder/telegram-intake` are `VACUUM INTO`-snapshotted. `data/vikunja/db` and `dev-requests.db` (with active `-wal`/`-shm`) are tarred live and could be captured mid-write / inconsistent.
8. **Short retention** — 14 daily / 8 weekly. Corruption discovered more than ~2 weeks later is unrecoverable; there is no monthly/long-tier.
9. **Silent failure** — backup failures only `console.warn` to container logs; there is no alert.

### Recommendations (prioritized)

- **P0 — Get backups off the host, automatically.** Nightly push of `data/backups/` (or `data/`) to a second location: rsync/rclone to another drive or object storage (Backblaze B2 / S3), or cross-copy home↔cloud tarballs. This is the single highest-value fix and also shrinks blast radius.
- **P0 — Verify + alert.** Confirm the cloud cron is installed and running; add a simple check that alerts (email/Telegram) when `last-backup.txt` is older than ~26h or a tarball is missing.
- **P1 — Restore drill (quarterly).** Extract the latest tarball into a scratch tree, boot, run `npm run smoke:core`, record the result. Turns "we have backups" into "we can recover."
- **P1 — Encrypt off-host copies** (age/gpg) because `data/` carries OAuth tokens and secrets.
- **P1 — Snapshot all DBs consistently.** Add `dev-requests.db` and the Vikunja DB to the `VACUUM INTO` list (or quiesce writers during tar).
- **P2 — Startup catch-up.** On process start, if today's scheduled backup is missing, run it once (fixes the 07‑18-style gap from a container being down at 03:15).
- **P2 — Tiered retention.** Keep weekly/monthly rollups beyond 14 days for late-discovered corruption.
- **P2 — Consolidate the two paths.** The in-app scheduler and `cloud-backup.sh` diverge; document clearly which runs where, or standardize on one so the cloud host also benefits from `VACUUM INTO` snapshots.

---

## Topic 2 — Blast radius [9cde97e5]

### Current state

- **Deploy shape:** one **cloud** VPS (Vultr 2 GB, single region) behind Caddy (TLS + basic auth), and one **LAN** host (home Wi‑Fi, no public port-forward). Cloud is the daily driver; LAN is dev/Playwright. No replication, no failover, no standby.
- **Data:** each store is a **single file** (`network.db`, `events-finder.db`, `telegram-intake.db`, `dev-requests.db`, Vikunja DB). No clustering.
- **Auth:** cloud uses HTTP **basic auth** (bcrypt hash in `.env`) plus a **trusted-device bypass** (`src/lib/trusted-device-auth.js`): an HMAC-signed `dashbird_trusted` cookie for two allowlisted device UUIDs (home Linux laptop + phone). `/auth/device-bind?did=<uuid>` seeds the cookie and is **exempt from auth** (`isTrustedDeviceAuthExemptPath`, and the Caddyfile routes `/auth/device-bind` straight to the app). **LAN has no auth at all** (accepted for trusted Wi‑Fi).
- **External dependencies** (from `src/lib/*` + settings registry): **Apify** (paid Facebook-events scraper), **OpenRouter** (AI: daily/weekly Gmail summaries + relevance scoring), **Gmail API** (OAuth intake for events + summaries), **Telegram bot** (getUpdates intake — cloud is the sole consumer to avoid `Conflict`), **Supabase** (climate-dash), **Vikunja** (todos, separate container), **Home Assistant**, and free weather/air/geo APIs.
- **Host coupling (LAN):** `docker-compose.yml` bind-mounts the host DBus session bus, `/tmp/.X11-unix`, `/run/user`, and applications dirs, and the container runs as root — so the dashboard can drive the host desktop (open-app tiles).
- **Secrets:** a single `.env` holds every credential.
- **Deploy tooling:** `sync-to-cloud.sh` uses `rsync -avz --delete`; with `SYNC_DATA=1` it overwrites remote `data/`.

### Risks / gaps

1. **Single host = single point of failure.** Loss of the Vultr instance (or the home machine) is a full outage; if backups are on the same host (they are), it is also data loss. LAN + cloud do not back each other up automatically.
2. **Single DB file per store.** WAL corruption, a bad migration, or a bad `merge-*.mjs`/restore run hits the one authoritative file. The existence of `network-data-safety.mdc` and `events-finder-pre-merge-*.db` shows this has bitten before.
3. **Destructive deploy footgun.** `SYNC_DATA=1 sync-to-cloud.sh` (`rsync --delete`) can overwrite/wipe good cloud data from a stale local tree with no pre-sync snapshot on the remote.
4. **Auth bypass surface.** `/auth/device-bind` is unauthenticated; anyone who learns an allowlisted device **UUID** can bind and get passwordless access. Those UUIDs live in `docs/` and a rule file, so they are not truly secret. Revocation requires rotating `DASHBOARD_TRUSTED_DEVICE_SECRET` and rebuilding.
5. **LAN is fully open.** Any device/guest on the Wi‑Fi can read and mutate CRM/tools/events with no credentials.
6. **External-dependency degradation (mostly graceful, per `security-plan.md` §7 "fail closed"):**
   - **Apify down/over-budget:** no new Facebook events; cached feed still served. Non-fatal.
   - **OpenRouter down/keyless:** daily/weekly summaries and relevance scoring fail or degrade; dashboard still loads.
   - **Gmail token expiry/revoke:** events intake + summaries break until re-consent (redirect URI must match the origin).
   - **Telegram:** if both LAN and cloud poll the same bot token → `Conflict` and split/missing ingests (LAN disables it by default). Down → no intake.
   - **Supabase / Home Assistant / weather-air APIs:** individual panels degrade; core dashboard unaffected.
   - **Vikunja:** todos panel down; `depends_on … service_started` only, so dashboard boots regardless.
7. **Host blast radius on LAN.** The desktop-control mounts + root container mean a bug or exploit in the dashboard can act on the host desktop and read/write all of `data/`.
8. **Single `.env` blast radius.** One leaked file compromises every integration at once.
9. **No external alerting.** There is a health sidebar (`dashboard-check.js`, `last-backup.txt`) but no paging when the host, a backup, or a dependency fails.

### Recommendations (prioritized)

- **P0 — Off-host, automatic backups** (same fix as Topic 1 P0). This is the biggest blast-radius reducer: it converts host-loss from data-loss into recoverable downtime.
- **P1 — Make destructive deploys safe.** Have `SYNC_DATA=1` take a remote pre-sync snapshot before `--delete`, or drop `--delete` for `data/`. Add a confirmation/dry-run guard.
- **P1 — Harden the device-bind path.** Rate-limit `/auth/device-bind`, and/or require one basic-auth challenge before binding, so a known UUID alone can't grant passwordless access. Treat device UUIDs as secrets.
- **P1 — Guard migrations.** Always snapshot the target DB immediately before any migration or `merge-*.mjs` run (formalize what `events-finder-pre-merge-*.db` did ad hoc).
- **P2 — Reduce LAN exposure.** Even a light gate or guest-VLAN segmentation, since LAN currently allows anyone on Wi‑Fi to mutate CRM. At minimum, keep the accepted-risk note current.
- **P2 — Shrink container privilege.** Scope or drop the DBus/X11/applications mounts and run non-root where the desktop-control tiles aren't needed (especially anything internet-exposed).
- **P2 — Add failure alerting + a recovery runbook.** Alert on host down / disk full (silent backup failure) / stale `last-backup.txt`, and write a short "rebuild cloud from latest backup" runbook with target RTO/RPO.
- **P3 — Split secrets by blast radius** (e.g. separate the paid Apify token and Gmail OAuth from lower-value keys) so one leak doesn't compromise everything.

---

## Key takeaways

- Backups **exist and are automated** (in-app daily tarball + weekly CRM/tools, plus a cloud cron script) with documented restore paths — the mechanism is solid.
- The dominant weakness for **both** requests is the same: **backups sit on the same single host/disk as the live data, with no automatic off-host copy, no restore drills, and no failure alerting.** A daily backup is already silently missing (`2026-07-18`), and there is no startup catch-up.
- **Blast radius** is concentrated in: single host (no failover), single DB files, a `--delete` deploy footgun, an unauthenticated `/auth/device-bind` + open LAN, and a root container wired into the host desktop. External dependencies mostly degrade gracefully.
- Highest-leverage fix for both topics: **automatic, encrypted, off-host backups + verification/alerting**, followed by hardening destructive deploys and the device-bind path.
