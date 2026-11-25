#!/bin/sh
# Runs backup.sh once at start and then every BACKUP_EVERY_HOURS (default 24).
while true; do
  sh /ops/backup.sh || echo "[backup] run failed, will retry next cycle"
  sleep $(( ${BACKUP_EVERY_HOURS:-24} * 3600 ))
done
