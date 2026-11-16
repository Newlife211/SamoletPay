#!/usr/bin/env bash
# SamoletPay: тестовый запуск с публичной ссылкой (macOS / Linux). Запуск: bash start-test.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null; then
  echo "Нужен Node.js 22.5+: https://nodejs.org (или: brew install node)"; exit 1
fi
node -e "require('node:sqlite')" 2>/dev/null || { echo "Обновите Node.js до 22.5+ (сейчас $(node -v))"; exit 1; }
if ! command -v cloudflared >/dev/null; then
  if command -v brew >/dev/null; then brew install cloudflared
  else echo "Установите cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; fi
fi

TRUST_PROXY=1 node --no-warnings server/index.js &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
sleep 2
echo
echo "Сейчас появится публичная ссылка https://....trycloudflare.com — пока окно открыто, стенд работает."
echo "Демо-доступы (пароль demo1234): demo@, buh@, manager@, ivan@samoletpay.ru; оператор admin@samoletpay.ru / admin1234"
echo
cloudflared tunnel --url http://localhost:3000
