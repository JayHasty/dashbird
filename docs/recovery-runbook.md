# Dashbird recovery runbook

How to get back up and running when something breaks — from "one DB got corrupted" up to
"the whole Vultr VPS is gone." Pair this with [`backups.md`](backups.md) (what the backups
are) and [`security-plan.md`](security-plan.md) (§9 incident response).

## Targets

- **RPO (max data loss): ~24h.** Daily tarball at 03:15 PT + off-host encrypted copy. Worst
  case you lose less than a day of changes.
- **RTO (time to restore): ~30–60 min** for a full cloud rebuild once you have a server and
  the latest tarball in hand.

## What you need to recover

1. The repo (GitHub `heyhastyjay/dashbird`).
2. A backup tarball — in priority order:
   - Newest **off-host** copy (encrypted `.age`/`.gpg` on the rclone remote — survives losing the VPS).
   - `data/backups/daily-YYYY-MM-DD.tar.gz` on a surviving host (LAN or cloud).
   - Weekly CRM/tools folder `data/backups/tools-contacts-YYYY-MM-DD/` (CRM + Tool Library only).
3. The server `.env` (secrets). Keep a copy in your password manager — it is **not** in git
   and it is **not** the same as the data backup. Without it you can restore data but must
   re-enter API keys and re-consent Gmail OAuth.
4. The backup **decryption key** (age private key / gpg passphrase). Store it separately from
   the backups themselves.

---

## Scenario A — One SQLite DB corrupted or a bad migration/merge

Smallest blast radius; do not rebuild the host.

1. Stop the stack so nothing holds the DB open:
   ```bash
   cd /opt/dashbird && docker compose -f docker-compose.cloud.yml down   # cloud
   # or on LAN: cd ~/jayprograms/dashbird && docker compose down
   ```
2. Restore just that store:
   - **CRM / Tool Library** (preferred, has a dedicated script):
     ```bash
     node scripts/restore-tools-contacts-backup.mjs --list
     node scripts/restore-tools-contacts-backup.mjs 2026-07-19
     ```
   - **Any other DB** — pull the file out of the daily tarball into a scratch dir, then copy it in:
     ```bash
     mkdir -p /tmp/restore && tar -xzf data/backups/daily-2026-07-19.tar.gz -C /tmp/restore data/events-finder.db
     cp /tmp/restore/data/events-finder.db data/events-finder.db
     rm -f data/events-finder.db-wal data/events-finder.db-shm   # drop stale WAL sidecars
     ```
3. Bring it back and verify:
   ```bash
   docker compose -f docker-compose.cloud.yml up -d --build && docker compose logs -f lan-url
   npm run smoke:core
   ```

> Before any future `merge-*.mjs` or migration, snapshot the target DB first (this is what the
> ad-hoc `events-finder-pre-merge-*.db` was). The daily backup covers you, but an explicit
> pre-merge copy is faster to roll back to.

---

## Scenario B — Cloud app broken but VPS alive (bad deploy, wedged container)

1. Roll code back and rebuild:
   ```bash
   cd /opt/dashbird && git log --oneline -5 && git checkout <last-good-sha>
   docker compose -f docker-compose.cloud.yml down && docker compose -f docker-compose.cloud.yml up -d --build
   docker compose -f docker-compose.cloud.yml logs lan-url
   ```
2. If a bad `SYNC_DATA_CONFIRM=1` push clobbered data, restore from the automatic pre-sync
   snapshot the deploy took: `/var/backups/dashbird/pre-sync-*.tar.gz` (see Scenario A step 2
   to extract), or from the latest daily/off-host tarball.

---

## Scenario C — VPS lost entirely (terminated, disk dead, region down)

Full rebuild on a fresh server. This is why off-host backups exist.

1. **Provision** a new Vultr instance (Debian/Ubuntu, 2 GB+), install Docker + compose, open
   firewall ports **22, 80, 443** only (see [`deploy-vultr.md`](deploy-vultr.md)).
2. **Point DNS**: update Cloudflare A records for `dashbird.jayhasty.com` (and portfolio hosts) to the new IPv4 (grey cloud).
3. **Get the code**:
   ```bash
   git clone https://github.com/heyhastyjay/dashbird /opt/dashbird && cd /opt/dashbird
   ```
4. **Restore secrets**: recreate `.env` from your password-manager copy (or
   `cp deploy/env.cloud.example .env` and refill). Ensure `DASHBOARD_DOMAIN`, basic-auth hash,
   and `DASHBOARD_TRUSTED_DEVICE_*` are set.
5. **Fetch + decrypt the latest off-host backup**:
   ```bash
   rclone copy b2:my-bucket/dashbird/ /tmp/restore/ --include 'daily-*.age'   # newest
   age -d -i ~/.dashbird-backup.key -o /tmp/restore/daily.tar.gz /tmp/restore/daily-*.age
   # gpg fallback: gpg --batch --passphrase "$DASHBIRD_GPG_PASSPHRASE" -d -o /tmp/restore/daily.tar.gz /tmp/restore/daily-*.gpg
   ```
6. **Unpack data into place**:
   ```bash
   tar -xzf /tmp/restore/daily.tar.gz -C /opt/dashbird
   # tarball already contains data/... and public/data/{bookmarks-personal.json,notes.md}
   rm -f data/*.db-wal data/*.db-shm data/vikunja/db/*.db-wal data/vikunja/db/*.db-shm
   ```
7. **Boot + verify**:
   ```bash
   docker compose -f docker-compose.cloud.yml up -d --build
   docker compose -f docker-compose.cloud.yml logs lan-url
   npm run smoke:core
   ```
8. **Re-auth if needed**: Gmail OAuth may need re-consent if the token was excluded/expired;
   confirm the redirect URI matches the (possibly new) origin.
9. **Re-bind trusted devices**: from each trusted device, visit
   `https://<domain>/auth/device-bind?did=<id>` and enter the basic-auth password once (bind
   now requires it — see below), then no password on later visits.

---

## Scenario D — Suspected compromise / malicious agent

1. **Contain**: `docker compose down`; if a specific route is implicated, disable it.
2. **Rotate every secret in `.env`** (OpenRouter, Apify, Telegram bot token, Gmail OAuth
   client, Vikunja, Apollo, Supabase). One `.env` = every integration, so rotate all.
3. **Assess** what the process could reach: CRM/events/tools DBs, Gmail tokens on disk, and —
   on LAN only — the host desktop (DBus/X11 mounts, root container).
4. **Restore data** from a backup taken *before* the suspected compromise (pick an older daily
   tarball; this is why retention matters).
5. **Rebuild clean**: fresh image (`up -d --build`), verify with `npm run smoke:core`.
6. **Review** the `data/dev-requests` inbox for injected instructions before running any agent
   against it (untrusted text there is executed by coding agents with repo access).

---

## Verify backups are actually working (do this, don't assume)

- **Health signal**: the sidebar reads `public/data/last-backup.txt` (in-app) and
  `public/data/last-offsite-backup.txt` (host script). Stale = investigate.
- **Automatic alert**: the app sends a Telegram alert if the newest daily tarball is older than
  `DATA_BACKUP_MAX_AGE_HOURS` (default 26h). The host script alerts on upload failure.
- **Quarterly restore drill** (turns "we have backups" into "we can recover"):
  ```bash
  mkdir -p /tmp/drill && tar -xzf data/backups/daily-$(date +%F).tar.gz -C /tmp/drill
  ls /tmp/drill/data/*.db   # confirm all five DBs present and non-zero
  ```

## Off-host storage cost note

Enabling `DASHBIRD_OFFSITE_REMOTE` (Backblaze B2 / S3) introduces a small recurring cost
(B2 is ~$6/TB-month; Dashbird's `data/` is well under a GB, so cents/month). Per the costs
rule, add a line item to `src/data/dashboard-costs.default.json` when you turn this on.
