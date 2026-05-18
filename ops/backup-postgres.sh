#!/usr/bin/env bash
# PRD-8: nightly Postgres backup.
#
# Run on the VPS (NOT inside the api container — needs host disk and access
# to the postgres service via `docker compose exec`). Sample crontab:
#
#   0 3 * * * /opt/sos-security/back/ops/backup-postgres.sh >> /var/log/sos-security-backup.log 2>&1
#
# Required env (export in cron file or systemd unit):
#   BACKUP_DIR        — local directory to store dumps (e.g. /var/backups/sos-security)
#   COMPOSE_PROJECT   — docker compose project dir (defaults to script's parent of ops/)
#   RETENTION_DAYS    — how long to keep dumps (default 14)
#   POSTGRES_USER     — db user (default `postgres`)
#   POSTGRES_DB       — db name (default `alarm_sos`)
#
# Optional: upload to S3-compatible storage by setting S3_TARGET, e.g.
#   S3_TARGET=s3://sos-security-backups/postgres/ aws s3 cp ...
# (uncomment the rclone/aws block at the bottom and adapt).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/sos-security}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-$(cd "$(dirname "$0")/.." && pwd)}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-alarm_sos}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/${PG_DB}-${STAMP}.sql.gz"

echo "[$(date -u +%FT%TZ)] backup start → $OUT"

# Stream pg_dump out of the postgres container, gzip on the host, fail fast on
# any non-zero exit anywhere in the pipeline.
set -o pipefail
docker compose --project-directory "$COMPOSE_PROJECT" \
  -f "$COMPOSE_PROJECT/docker-compose.prod.yml" exec -T postgres \
  pg_dump -U "$PG_USER" --format=plain --no-owner --no-privileges "$PG_DB" \
  | gzip -9 > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date -u +%FT%TZ)] backup ok ($SIZE)"

# Retention — delete dumps older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -name "${PG_DB}-*.sql.gz" -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

# --- Optional off-site upload ---------------------------------------------
# Uncomment one of these once you've configured creds.
#
# # rclone (Backblaze B2 / Wasabi / etc.):
# rclone copy "$OUT" "remote:sos-security-backups/postgres/" --quiet
#
# # AWS CLI (S3):
# aws s3 cp "$OUT" "$S3_TARGET" --only-show-errors
# --------------------------------------------------------------------------

echo "[$(date -u +%FT%TZ)] done"
