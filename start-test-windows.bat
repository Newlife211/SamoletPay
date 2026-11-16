@echo off
chcp 65001 >nul
title PayOut — тестовый запуск
cd /d "%~dp0"

echo.
echo  ==============================================
echo    PayOut: запуск тестового стенда с публичной ссылкой
echo  ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Устанавливаю Node.js...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js установлен. ЗАКРОЙТЕ это окно и запустите файл ещё раз.
  pause
  exit /b
)

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [2/3] Устанавливаю Cloudflare Tunnel ^(cloudflared^)...
  winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
  echo.
  echo cloudflared установлен. ЗАКРОЙТЕ это окно и запустите файл ещё раз.
  pause
  exit /b
)

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo Нужна более новая версия Node.js ^(22.5 или выше^). Обновите: winget upgrade OpenJS.NodeJS.LTS
  pause
  exit /b
)

echo [3/3] Запускаю PayOut в отдельном окне...
start "PayOut — сервер (не закрывайте)" cmd /k "set TRUST_PROXY=1&& set NPD_OFFLINE=0&& node --no-warnings server/index.js"
timeout /t 3 >nul

echo.
echo  Сейчас появится публичная ссылка вида https://....trycloudflare.com
echo  Её можно открывать с любого устройства и отправлять коллегам.
echo  Пока это окно открыто — стенд работает. Закрыли окно — ссылка перестала работать.
echo.
echo  Демо-доступы (пароль demo1234): demo@payout.ru, buh@payout.ru, manager@payout.ru, ivan@payout.ru
echo  Оператор: admin@payout.ru / admin1234
echo.
cloudflared tunnel --url http://localhost:3000
pause
