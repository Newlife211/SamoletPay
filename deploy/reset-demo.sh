#!/usr/bin/env bash
# Сброс тестового стенда к исходным демо-данным (текущая база сохраняется в backups)
set -euo pipefail
DATA_DIR=/var/lib/samoletpay
[ "$(id -u)" -eq 0 ] || { echo "запустите через sudo"; exit 1; }
systemctl stop samoletpay
if [ -f "$DATA_DIR/samoletpay.db" ]; then
  mv "$DATA_DIR/samoletpay.db" "$DATA_DIR/backups/reset-$(date +%Y%m%d-%H%M%S).db"
  rm -f "$DATA_DIR/samoletpay.db-wal" "$DATA_DIR/samoletpay.db-shm"
fi
systemctl start samoletpay
echo "Стенд сброшен: демо-данные созданы заново."
