#!/bin/sh
# Перезапуск dev-сервера с чистой БД (только для локальных тестов)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "server/index.js"; sleep 0.3
rm -f "$ROOT"/data/payout.db "$ROOT"/data/payout.db-wal "$ROOT"/data/payout.db-shm
cd "$ROOT" && NPD_OFFLINE=1 PAYOUT_DELAY_MS=600 nohup node --no-warnings server/index.js > /tmp/srv.log 2>&1 &
sleep 1.5
