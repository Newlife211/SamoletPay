#!/usr/bin/env bash
# Обновление кода на сервере без потери данных. Запуск из папки репозитория:
#   cd ~/SamoletPay && git pull && sudo bash deploy/update.sh
set -euo pipefail
APP_DIR=/opt/samoletpay; DATA_DIR=/var/lib/samoletpay
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "запустите через sudo"; exit 1; }
[ -f "$SRC_DIR/server/index.js" ] || { echo "запускайте из папки проекта"; exit 1; }

echo "==> Резервная копия базы"
[ -f "$DATA_DIR/samoletpay.db" ] && sqlite3 "$DATA_DIR/samoletpay.db" ".backup '$DATA_DIR/backups/before-update-$(date +%Y%m%d-%H%M%S).db'"

echo "==> Новый код"
tar -C "$SRC_DIR" --exclude='./.git' --exclude='./data' --exclude='./shots' -cf - . | tar -C "$APP_DIR" -xf -
chown -R root:root "$APP_DIR"

echo "==> Перезапуск"
systemctl restart samoletpay
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/healthz && echo && echo "Обновлено."
