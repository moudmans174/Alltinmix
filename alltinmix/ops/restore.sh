#!/bin/sh
# Restores a database backup. THIS REPLACES THE CURRENT DATA.
#   DATABASE_URL=postgres://... sh ops/restore.sh /backups/db-20261125-020000.sql.gz
# Restore uploaded files with:  tar -xzf uploads-<stamp>.tar.gz -C /data
set -eu
FILE="${1:?Give the backup file, for example /backups/db-20261125-020000.sql.gz}"
[ -f "$FILE" ] || { echo "File not found: $FILE" >&2; exit 1; }
gzip -t "$FILE"
echo "This will REPLACE the data in $DATABASE_URL with $FILE."
printf "Type YES to continue: "; read -r ans
[ "$ans" = "YES" ] || { echo "Cancelled."; exit 1; }
gunzip -c "$FILE" | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
echo "Restore complete. Restart the backend."
