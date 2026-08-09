#!/usr/bin/env bash
# Push local dashbird state to a Hetzner VPS (code + gitignored personal data).
# Usage:
#   HETZNER_HOST=root@YOUR_SERVER_IP ./scripts/sync-to-hetzner.sh
# Optional: HETZNER_DIR=/opt/dashbird
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HETZNER_HOST:?Set HETZNER_HOST=root@your-server-ip}"
REMOTE_DIR="${HETZNER_DIR:-/opt/dashbird}"

# Anchor /data/ so we skip only the repo root data/ volume — not public/data/
# (unanchored "data/" also matched public/data and left admin bookmarks stuck).
RSYNC=(rsync -avz --delete
  --exclude node_modules
  --exclude .git
  --exclude .env
  --exclude /data/
)

echo "[dashbird] Syncing repo to ${HOST}:${REMOTE_DIR}/"
"${RSYNC[@]}" "$ROOT/" "${HOST}:${REMOTE_DIR}/"

echo "[dashbird] Syncing .env (if present locally)"
if [[ -f "$ROOT/.env" ]]; then
  rsync -avz "$ROOT/.env" "${HOST}:${REMOTE_DIR}/.env"
else
  echo "  (no local .env — configure on server from deploy/env.hetzner.example)"
fi

echo "[dashbird] Syncing persistent data/ (excluding Keep Notes)"
mkdir -p "$ROOT/data"
rsync -avz --exclude keep-notes/ --exclude keep-import/ \
  "$ROOT/data/" "${HOST}:${REMOTE_DIR}/data/" || true

for f in bookmarks-personal.json notes.md last-backup.txt; do
  if [[ -f "$ROOT/public/data/$f" ]]; then
    rsync -avz "$ROOT/public/data/$f" "${HOST}:${REMOTE_DIR}/public/data/$f"
  fi
done

echo "[dashbird] Remote restart"
ssh "$HOST" "cd ${REMOTE_DIR} && docker compose -f docker-compose.hetzner.yml up -d --build"

echo "[dashbird] Done. Open https://\$(grep ^DASHBOARD_DOMAIN= ${REMOTE_DIR}/.env 2>/dev/null | cut -d= -f2- || echo your-domain)/"
