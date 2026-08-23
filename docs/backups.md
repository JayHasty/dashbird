# Dashbird backups

Dashbird keeps two automatic backups of your live data (both on by default while the stack is running):

| Schedule | Output | Scope |
|----------|--------|-------|
| **Daily** — every day 03:15 `America/Los_Angeles` | `data/backups/daily-YYYY-MM-DD.tar.gz` | Full `data/` tree + `public/data/bookmarks-{personal,work}.json` + `public/data/notes.md` |
| **Weekly** — Sunday 03:00 same timezone | `data/backups/tools-contacts-YYYY-MM-DD/` | Network CRM (`network.db`, assets) + Tool Library (`tool-library.json`, assets) |

Both update **`public/data/last-backup.txt`**, which feeds the health sidebar via `/api/config`.

Backups are **gitignored** — they live only on disk under `data/backups/`.

## What is protected

**Daily tarball** includes everything under `data/` except `data/backups/` itself:

- SQLite: `network.db`, `events-finder.db`, `telegram-intake.db`, `dev-requests.db`, Vikunja DB/files
- JSON settings and caches (events, Gmail, costs, dev notes, etc.)
- Network + tool library assets, Telegram media, OAuth token files

All five SQLite databases are snapshotted with `VACUUM INTO` before tar so the archive gets
consistent DB copies even while the app is running. If one snapshot fails (e.g. Vikunja locked
mid-write) that DB falls back to its live file and the rest of the backup still completes.

**Startup catch-up:** if the container was down at 03:15 and today's tarball is missing, the
scheduler runs one immediately on boot (`DATA_BACKUP_CATCHUP=1`, default on), so a restart no
longer silently skips a day.

**Staleness alert:** if the newest daily tarball is older than `DATA_BACKUP_MAX_AGE_HOURS`
(default 26h), the app sends a Telegram alert once/day (uses `TELEGRAM_BOT_TOKEN` +
`DATA_BACKUP_ALERT_CHAT_ID`, falling back to the first `TELEGRAM_ALLOWED_CHAT_IDS`).

**Weekly folder** is a lighter, structured restore path focused on CRM + tools (see restore script below).

## Configuration (`.env`)

```bash
# Daily full-data (default on)
# DATA_BACKUP_DAILY=0          # disable
# DATA_BACKUP_DAILY_HOUR=3
# DATA_BACKUP_DAILY_MINUTE=15
# DATA_BACKUP_DAILY_RETAIN=14  # days of daily tarballs

# Weekly tools + contacts (default on)
# DATA_BACKUP_WEEKLY=0
# DATA_BACKUP_WEEKLY_DOW=0     # 0=Sun … 6=Sat
# DATA_BACKUP_WEEKLY_HOUR=3
# DATA_BACKUP_WEEKLY_MINUTE=0
# DATA_BACKUP_WEEKLY_TZ=America/Los_Angeles
# DATA_BACKUP_DIR=data/backups
# DATA_BACKUP_RETAIN=8         # weekly folders
```

Schedulers run inside the Node process (`src/lib/data-backup-schedule.js`), started from `src/server.js` with Docker Compose.

## Restore: weekly tools + contacts

**Stop the stack first** so SQLite is not open during the copy:

```bash
docker compose down
node scripts/restore-tools-contacts-backup.mjs --list
node scripts/restore-tools-contacts-backup.mjs              # latest
node scripts/restore-tools-contacts-backup.mjs 2026-07-12   # specific date
docker compose up -d --build
```

## Restore: daily full tarball

1. **Stop the stack:** `docker compose down`
2. **Pick a backup:** `ls data/backups/daily-*.tar.gz`
3. **Extract** (from repo root; overwrites matching paths under `data/`):

   ```bash
   tar -xzf data/backups/daily-2026-07-16.tar.gz
   ```

   This restores `data/` and any included `public/data/` files.
4. **Start again:** `docker compose up -d --build`

To restore into a clean tree, move aside the current `data/` first:

```bash
docker compose down
mv data data.old.$(date +%Y%m%d)
mkdir -p data
tar -xzf data.old.*/backups/daily-2026-07-16.tar.gz   # adjust path to your backup file
docker compose up -d --build
```

## Cloud VPS (Vultr) — off-host encrypted copies

`scripts/cloud-backup.sh` runs on the host cron **after** the in-app daily job. It takes the
newest in-app tarball, **encrypts** it (never ships plaintext — `data/` holds OAuth tokens),
uploads it **off the VPS** via rclone, prunes, and alerts on failure. With no offsite env set
it degrades to a local encrypted/plain copy + prune, so it is safe to install as-is.

```bash
chmod +x /opt/dashbird/scripts/cloud-backup.sh
apt-get install -y sqlite3 age rclone      # age for encryption, rclone for upload
rclone config                              # set up a remote, e.g. Backblaze B2 → "b2"
mkdir -p /var/backups/dashbird
# In /opt/dashbird/.env (see deploy/env.cloud.example):
#   DASHBIRD_OFFSITE_REMOTE=b2:my-bucket/dashbird
#   DASHBIRD_AGE_RECIPIENT=age1...            (public key; keep the private key OFF the VPS)
crontab -e
# Run 15 min after the 03:15 in-app backup so it ships the fresh tarball:
# 30 3 * * * cd /opt/dashbird && set -a && . ./.env && set +a && ./scripts/cloud-backup.sh >> /var/log/dashbird-backup.log 2>&1
```

Recovery (fetch + decrypt) is in [`recovery-runbook.md`](recovery-runbook.md) Scenario C.
See [`deploy-vultr.md`](deploy-vultr.md) for full cloud setup.

## Manual / on-demand backup

While the stack is running you can trigger exports from Node (e.g. in a one-off container shell):

```bash
docker compose exec dashboard node -e "
  import('./src/lib/data-backup-schedule.js').then(m =>
    m.runDailyDataBackup().then(r => console.log(r))
  )
"
```

Or copy the weekly CRM/tools backup:

```bash
docker compose exec dashboard node -e "
  import('./src/lib/data-backup-schedule.js').then(m =>
    m.runToolsContactsBackup().then(r => console.log(r))
  )
"
```

## Offsite copies

Local daily tarballs protect against bad edits and disk failure on one machine. For
fire/theft/host loss, use `scripts/cloud-backup.sh` (above) to ship encrypted tarballs to
object storage automatically. `sync-to-cloud.sh` (LAN↔VPS) is a manual helper, not a backup —
`SYNC_DATA=1` now defaults to a **dry run** and takes a remote pre-sync snapshot before
overwriting (re-run with `SYNC_DATA_CONFIRM=1` to commit).

## Related

- Recovery runbook (get back up and running): [`recovery-runbook.md`](recovery-runbook.md)
- Network restore safety: [`.cursor/rules/network-data-safety.mdc`](../.cursor/rules/network-data-safety.mdc)
- Security plan (cloud): [`security-plan.md`](security-plan.md)
- Cloud sync: [`scripts/sync-to-cloud.sh`](../scripts/sync-to-cloud.sh)
