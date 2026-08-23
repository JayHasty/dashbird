#!/usr/bin/env bash
# Push local dashbird to a public VPS (Vultr Silicon Valley + jayhasty.com).
# Usage:
#   CLOUD_HOST=root@YOUR_SERVER_IP ./scripts/sync-to-cloud.sh
#   # or set CLOUD_HOST once in .env
# Optional:
#   CLOUD_DIR=/opt/dashbird
#   SYNC_DATA=1          # also rsync data/ + public/data bookmarks (not Keep Notes)
#   SYNC_DATA_CONFIRM=1  # required with SYNC_DATA=1 to actually push (else dry-run)
#   SYNC_ENV=1           # push local .env to the server
#   COMPOSE_FILE=docker-compose.cloud.yml
#
# Keep Notes (`data/keep-notes/`) and Takeout staging (`data/keep-import/`) are
# intentionally NOT synced — LAN and cloud each keep their own notes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${CLOUD_HOST:-}"
REMOTE_DIR="${CLOUD_DIR:-/opt/dashbird}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
SYNC_DATA="${SYNC_DATA:-0}"
SYNC_ENV="${SYNC_ENV:-0}"

# Relative to data/ transfer root.
RSYNC_DATA_EXCLUDES=(
  --exclude keep-notes/
  --exclude keep-import/
)

if [[ -z "$HOST" && -f "$ROOT/.env" ]]; then
  HOST="$(grep -E '^CLOUD_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"
fi
HOST="${HOST:?Set CLOUD_HOST=root@your-server-ip (env or .env)}"

# Anchor /data/ so we skip only the repo root data/ volume — not public/data/
# (unanchored "data/" also matched public/data and left admin bookmarks stuck on VPS).
#
# bookmarks-work.json is gitignored live data. It MUST be excluded from --delete
# so CI (no local copy) cannot wipe cloud Admin tiles; when the laptop has a copy
# we push it explicitly below.
RSYNC_CODE=(rsync -avz --delete
  --exclude node_modules
  --exclude .git
  --exclude .env
  --exclude /data/
  --exclude 'public/data/bookmarks-personal.json'
  --exclude 'public/data/bookmarks-work.json'
  --exclude 'public/data/bookmarks-*.json.bak'
  --exclude 'public/data/notes.md'
  --exclude 'public/data/last-backup.txt'
  --exclude 'public/data/phone-lan-url.txt'
)

echo "[dashbird] Syncing repo code to ${HOST}:${REMOTE_DIR}/"
ssh "$HOST" "mkdir -p '${REMOTE_DIR}/data' '${REMOTE_DIR}/public/data' '${REMOTE_DIR}/data/vikunja/db' '${REMOTE_DIR}/data/vikunja/files'"
"${RSYNC_CODE[@]}" "$ROOT/" "${HOST}:${REMOTE_DIR}/"

# Push Admin bookmarks when present locally (never delete remote when absent).
WORK_BM="$ROOT/public/data/bookmarks-work.json"
if [[ -f "$WORK_BM" ]]; then
  echo "[dashbird] Syncing Admin bookmarks (public/data/bookmarks-work.json)"
  rsync -avz "$WORK_BM" "${HOST}:${REMOTE_DIR}/public/data/bookmarks-work.json"
  LOCAL_SUM="$(sha256sum "$WORK_BM" | awk '{print $1}')"
  REMOTE_SUM="$(ssh "$HOST" "sha256sum '${REMOTE_DIR}/public/data/bookmarks-work.json'" | awk '{print $1}')"
  if [[ "$LOCAL_SUM" != "$REMOTE_SUM" ]]; then
    echo "[dashbird] ERROR: public/data/bookmarks-work.json mismatch after rsync (local=${LOCAL_SUM} remote=${REMOTE_SUM})" >&2
    exit 1
  fi
  if ! grep -q '"Deployed projects"' "$WORK_BM"; then
    echo "[dashbird] ERROR: local bookmarks-work.json missing Deployed projects section" >&2
    exit 1
  fi
  echo "[dashbird] Verified admin bookmarks synced (sha256=${LOCAL_SUM})"
else
  echo "[dashbird] No local bookmarks-work.json — leaving cloud Admin bookmarks untouched"
fi

GUIDE_MD="$ROOT/data/gmail-daily-summary-guide.md"
if [[ -f "$GUIDE_MD" ]]; then
  echo "[dashbird] Syncing Daily Summary guide (learned preferences md only)"
  rsync -avz "$GUIDE_MD" "${HOST}:${REMOTE_DIR}/data/gmail-daily-summary-guide.md"
fi

if [[ "$SYNC_ENV" == "1" ]]; then
  echo "[dashbird] Syncing .env (if present locally)"
  if [[ -f "$ROOT/.env" ]]; then
    rsync -avz "$ROOT/.env" "${HOST}:${REMOTE_DIR}/.env"
  else
    echo "  (no local .env — configure on server from deploy/env.cloud.example)"
  fi
fi

if [[ "$SYNC_DATA" == "1" ]]; then
  mkdir -p "$ROOT/data"
  echo "[dashbird] data/ sync excludes Keep Notes (keep-notes/, keep-import/) — LAN and cloud stay separate"
  if [[ "${SYNC_DATA_CONFIRM:-0}" != "1" ]]; then
    # Footgun guard: pushing a stale local data/ can clobber good cloud data. Default to a
    # dry run so you can see exactly what would change before committing.
    echo "[dashbird] SYNC_DATA=1 DRY RUN — no changes made. Files that WOULD be pushed:"
    rsync -avzn "${RSYNC_DATA_EXCLUDES[@]}" "$ROOT/data/" "${HOST}:${REMOTE_DIR}/data/" || true
    echo "[dashbird] Re-run with SYNC_DATA_CONFIRM=1 to actually push data/ (remote is snapshotted first)."
  else
    SNAP="/var/backups/dashbird/pre-sync-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    echo "[dashbird] Snapshotting remote data/ → ${SNAP} (rollback point) before overwrite"
    ssh "$HOST" "mkdir -p /var/backups/dashbird && tar -czf '${SNAP}' -C '${REMOTE_DIR}' data" \
      || echo "  (remote snapshot failed — continuing, but you have no rollback point)"
    echo "[dashbird] Pushing persistent data/ (tools, network, events, assets — never commit these)"
    rsync -avz "${RSYNC_DATA_EXCLUDES[@]}" "$ROOT/data/" "${HOST}:${REMOTE_DIR}/data/"

    for f in bookmarks-personal.json bookmarks-work.json notes.md last-backup.txt; do
      if [[ -f "$ROOT/public/data/$f" ]]; then
        rsync -avz "$ROOT/public/data/$f" "${HOST}:${REMOTE_DIR}/public/data/$f"
      fi
    done
  fi
fi

echo "[dashbird] Remote rebuild + recreate (${COMPOSE_FILE})"
# src/ and public/ are bind-mounted. `up --build` alone often reuses the same
# container when the image layer is unchanged, so Node keeps stale ESM modules
# in memory even though the files on disk were rsynced. Force-recreate the
# dashboard (and caddy, which depends on it) so the new code is actually loaded.
ssh "$HOST" "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' up -d --build --force-recreate dashboard caddy"

DOMAIN="$(ssh "$HOST" "grep -E '^DASHBOARD_DOMAIN=' '${REMOTE_DIR}/.env' 2>/dev/null | cut -d= -f2-" || true)"
echo "[dashbird] Done. Open https://${DOMAIN:-dashbird.jayhasty.com}/"
echo "[dashbird] Hard-refresh the browser (or close the Big Events popout) so cached JS is not reused."
echo "[dashbird] New tool Playwright snapshots: enrich on LAN, then SYNC_DATA=1 ./scripts/sync-to-cloud.sh"
