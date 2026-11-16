#!/usr/bin/env bash
# =====================================================================
#  SamoletPay — установка на VPS (Oracle Cloud / любой Ubuntu 22.04–24.04, ARM или x86)
#
#  Режим 1 — Cloudflare Tunnel (рекомендуется для Oracle: порты открывать не нужно)
#     sudo bash deploy/install.sh --domain samoletpay.dpdns.org --tunnel <ТОКЕН_ТУННЕЛЯ>
#
#  Режим 2 — прямой HTTPS через Caddy (нужно открыть порты 80/443 в облаке)
#     sudo bash deploy/install.sh --domain samoletpay.dpdns.org --email me@mail.ru
#     sudo bash deploy/install.sh --domain auto --email me@mail.ru     # адрес 1-2-3-4.sslip.io по IP
#
#  Дополнительно:
#     --password <пароль>   закрыть стенд паролем (логин любой, например tester)
#     --prod                боевой режим: без демо-данных и демо-кнопок
# =====================================================================
set -euo pipefail

DOMAIN=""; EMAIL=""; TUNNEL=""; SITE_PASS=""; PROD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --tunnel) TUNNEL="$2"; shift 2 ;;
    --password) SITE_PASS="$2"; shift 2 ;;
    --prod) PROD=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (см. --help)"; exit 1 ;;
  esac
done

APP_DIR=/opt/samoletpay; DATA_DIR=/var/lib/samoletpay; ENV_FILE=/etc/samoletpay.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите через sudo"
[ -n "$DOMAIN" ] || die "укажите --domain (см. --help)"
[ -n "$TUNNEL" ] || [ -n "$EMAIL" ] || die "для режима Caddy укажите --email (нужен Let's Encrypt), либо используйте --tunnel"
[ -f "$SRC_DIR/server/index.js" ] || die "не найден server/index.js — запускайте из папки проекта"
command -v apt-get >/dev/null || die "скрипт рассчитан на Ubuntu/Debian"
MODE=$([ -n "$TUNNEL" ] && echo tunnel || echo caddy)

if [ "$DOMAIN" = "auto" ]; then
  [ "$MODE" = caddy ] || die "--domain auto работает только без туннеля"
  IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
  DOMAIN="${IP//./-}.sslip.io"; say "Адрес стенда: $DOMAIN"
fi

say "Пакеты системы (режим: $MODE)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg sqlite3 unattended-upgrades

# машины с 1 ГБ памяти (GCP e2-micro, Oracle E2.1.Micro): файл подкачки, чтобы установка пакетов не падала по памяти
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 2000 ] && ! swapon --show | grep -q .; then
  say "Файл подкачки 1 ГБ (мало памяти)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e "require('node:sqlite')" 2>/dev/null || die "нужен Node.js 22.5+ (установлен $(node -v))"
echo "Node $(node -v) ($(uname -m))"

say "Пользователь и каталоги"
id samoletpay >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin samoletpay
mkdir -p "$APP_DIR" "$DATA_DIR/backups"
tar -C "$SRC_DIR" --exclude='./.git' --exclude='./data' --exclude='./shots' --exclude='./node_modules' -cf - . | tar -C "$APP_DIR" -xf -
chown -R root:root "$APP_DIR"; chown -R samoletpay:samoletpay "$DATA_DIR"; chmod 750 "$DATA_DIR"

say "Конфигурация $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=127.0.0.1
APP_URL=https://$DOMAIN
BRAND=SamoletPay
DB_PATH=$DATA_DIR/samoletpay.db
BACKUP_DIR=$DATA_DIR/backups
DEMO_MODE=$([ $PROD -eq 1 ] && echo 0 || echo 1)
SEED=$([ $PROD -eq 1 ] && echo 0 || echo 1)
COOKIE_SECURE=1
TRUST_PROXY=1
LOG_REQUESTS=1
SITE_PASSWORD=$SITE_PASS
# SMS_PROVIDER=smsru
# SMSRU_API_ID=
# EMAIL_PROVIDER=unisender
# UNISENDER_API_KEY=
# EMAIL_FROM=noreply@$DOMAIN
EOF
  chmod 640 "$ENV_FILE"; chown root:samoletpay "$ENV_FILE"
else
  sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" "$ENV_FILE"
  if grep -q '^SITE_PASSWORD=' "$ENV_FILE"; then sed -i "s#^SITE_PASSWORD=.*#SITE_PASSWORD=$SITE_PASS#" "$ENV_FILE"; else echo "SITE_PASSWORD=$SITE_PASS" >> "$ENV_FILE"; fi
fi

say "Сервис systemd"
cat > /etc/systemd/system/samoletpay.service <<EOF
[Unit]
Description=SamoletPay
After=network-online.target
Wants=network-online.target

[Service]
User=samoletpay
Group=samoletpay
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
MemoryMax=600M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable samoletpay >/dev/null
systemctl restart samoletpay

if [ "$MODE" = tunnel ]; then
  say "Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -y && apt-get install -y cloudflared
  fi
  # токен из панели Cloudflare: Zero Trust → Networks → Tunnels → Create → Cloudflared
  cloudflared service uninstall >/dev/null 2>&1 || true
  cloudflared service install "$TUNNEL"
  systemctl enable --now cloudflared >/dev/null 2>&1 || true
  systemctl restart cloudflared
  # Caddy в этом режиме не нужен
  systemctl disable --now caddy >/dev/null 2>&1 || true
else
  say "Caddy (HTTPS Let's Encrypt)"
  if ! command -v caddy >/dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  fi
  printf '{\n\temail %s\n}\n\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' "$EMAIL" "$DOMAIN" > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  systemctl enable caddy >/dev/null; systemctl reload caddy || systemctl restart caddy

  say "Порты 80/443 в системном файрволе"
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp; ufw allow 443/tcp; ufw allow OpenSSH; fi
  # образы Ubuntu в Oracle Cloud по умолчанию закрывают всё, кроме SSH, правилами iptables
  if iptables -L INPUT -n 2>/dev/null | grep -q REJECT; then
    for p in 443 80; do
      if ! iptables -C INPUT -m state --state NEW -p tcp --dport $p -j ACCEPT 2>/dev/null; then
        POS="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')"
        iptables -I INPUT "${POS:-1}" -m state --state NEW -p tcp --dport $p -j ACCEPT
      fi
    done
    command -v netfilter-persistent >/dev/null || apt-get install -y iptables-persistent
    netfilter-persistent save
  fi
fi

say "Автоматические обновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

say "Проверка"
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/healthz >/dev/null && echo "Приложение: OK" || { journalctl -u samoletpay -n 30 --no-pager; die "приложение не запустилось"; }
[ "$MODE" = tunnel ] && { sleep 3; systemctl is-active --quiet cloudflared && echo "Туннель: OK" || { journalctl -u cloudflared -n 20 --no-pager; die "туннель не запустился — проверьте токен"; }; }

cat <<EOF

────────────────────────────────────────────────────────────
  Готово: https://$DOMAIN
$( [ "$MODE" = tunnel ] && echo "  В Cloudflare у туннеля должен быть Public hostname: $DOMAIN → http://localhost:3000" )
$( [ "$MODE" = caddy ] && echo "  HTTPS-сертификат выпустится за 1–2 минуты. Если у облака есть свой файрвол" && echo "  (Oracle Security List, GCP firewall), в нём должны быть открыты порты 80 и 443" )
$( [ -n "$SITE_PASS" ] && echo "  Вход на стенд: логин любой (например tester), пароль $SITE_PASS" )
$( [ $PROD -eq 0 ] && printf '%s\n' "  Демо-доступы (пароль demo1234): demo@samoletpay.ru — компания, buh@ — бухгалтер," "  manager@ — менеджер, ivan@samoletpay.ru — исполнитель; admin@samoletpay.ru / admin1234 — оператор" )

  Логи:        journalctl -u samoletpay -f
  Перезапуск:  sudo systemctl restart samoletpay
  Обновление:  cd ~/SamoletPay && git pull && sudo bash deploy/update.sh
  Сброс демо:  sudo bash $APP_DIR/deploy/reset-demo.sh
────────────────────────────────────────────────────────────
EOF
