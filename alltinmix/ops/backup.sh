#!/bin/sh
# Backs up the database and uploaded files, then deletes backups older than KEEP_DAYS.
# Used by the "backup" service in docker-compose.yml, and works on its own too:
#   DATABASE_URL=postgres://... BACKUP_DIR=./backups sh ops/backup.sh
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

DB_FILE="$BACKUP_DIR/db-$STAMP.sql.gz"
pg_dump --no-owner --clean --if-exists "$DATABASE_URL" | gzip -9 > "$DB_FILE.part"
# A dump that is nearly empty means something went wrong: do not keep it as a "good" backup.
if [ "$(wc -c < "$DB_FILE.part")" -lt 200 ]; then rm -f "$DB_FILE.part"; echo "[backup] FAILED: dump is empty" >&2; exit 1; fi
gzip -t "$DB_FILE.part"
mv "$DB_FILE.part" "$DB_FILE"
echo "[backup] database saved: $DB_FILE ($(wc -c < "$DB_FILE") bytes)"

for d in uploads private; do
  src="${FILES_DIR:-/data}/$d"
  if [ -d "$src" ]; then
    tar -czf "$BACKUP_DIR/$d-$STAMP.tar.gz" -C "$(dirname "$src")" "$d"
    echo "[backup] $d saved"
  fi
done

find "$BACKUP_DIR" -type f \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' -o -name 'private-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
echo "[backup] done. Keeping the last $KEEP_DAYS days."
# Optional off-site copy: set OFFSITE_CMD, for example  OFFSITE_CMD='rclone copy /backups remote:alltinmix-backups'
if [ -n "${OFFSITE_CMD:-}" ]; then sh -c "$OFFSITE_CMD" && echo "[backup] off-site copy done"; fi
