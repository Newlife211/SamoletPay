#!/usr/bin/env bash
# Сброс тестового стенда к исходным демо-данным (текущая база сохраняется в backups)
set -euo pipefail
DATA_DIR=/var/lib/payout
[ "$(id -u)" -eq 0 ] || { echo "запустите через sudo"; exit 1; }
systemctl stop payout
if [ -f "$DATA_DIR/payout.db" ]; then
  mv "$DATA_DIR/payout.db" "$DATA_DIR/backups/reset-$(date +%Y%m%d-%H%M%S).db"
  rm -f "$DATA_DIR/payout.db-wal" "$DATA_DIR/payout.db-shm"
fi
systemctl start payout
echo "Стенд сброшен: демо-данные созданы заново."
