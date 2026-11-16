# Деплой SamoletPay на платный VPS (DigitalOcean, Contabo и любые другие)

Подходит любой VPS с **Ubuntu 22.04/24.04** и **1 ГБ памяти и больше**. Время: около 15 минут.

## 1. Создать сервер

**DigitalOcean** (почасовая оплата, сервер можно удалить в любой момент):
1. Зарегистрируйтесь на https://www.digitalocean.com.
2. **Create → Droplets**:
   - Region: **Frankfurt** или **Amsterdam**;
   - Image: **Ubuntu 24.04 (LTS) x64**;
   - Size: **Basic → Regular → 1 GB / 1 CPU** (или 2 GB для запаса);
   - Authentication: **Password** (придумайте надёжный root-пароль) или SSH key;
   - нажмите **Create Droplet** и скопируйте IP.

**Contabo / Hostinger / другие:** закажите VPS с **Ubuntu 24.04** в Европе. Данные для входа (IP и root-пароль) придут на почту.

## 2. Войти на сервер

- **DigitalOcean:** откройте дроплет → **Access → Launch Droplet Console**. Терминал откроется прямо в браузере.
- **Другие провайдеры:** на своём компьютере выполните `ssh root@IP_СЕРВЕРА` и введите пароль из письма.

## 3. Установить (одна команда)

```bash
apt-get update && apt-get install -y git && git clone https://github.com/Newlife211/SamoletPay.git && cd SamoletPay && bash deploy/install.sh --domain auto --email ваш@email.ru --password Test2026
```

- `--domain auto` даёт адрес вида `https://1-2-3-4.sslip.io` без покупки домена.
- `--password Test2026` закрывает стенд от посторонних (логин любой). Уберите, если стенд должен быть открытым.
- Если репозиторий приватный, git спросит логин GitHub и вместо пароля — **Personal Access Token**: GitHub → Settings → Developer settings → Fine-grained tokens, доступ Contents: Read.

Скрипт сам поставит Node.js и Caddy, выпустит HTTPS-сертификат, запустит сервис с автозапуском и включит обновления безопасности. В конце он покажет адрес и демо-доступы.

## 4. Свой домен через Cloudflare (по желанию)

1. Cloudflare → ваш домен → **DNS → Add record**: тип **A**, имя `app` (или `@`), значение — IP сервера, Proxy: **DNS only** (серое облако).
2. На сервере выполните:

```bash
cd ~/SamoletPay && bash deploy/install.sh --domain app.ваш-домен.ru --email ваш@email.ru --password Test2026
```

Когда сертификат выпустится, можно включить оранжевое облако (Proxy). Тогда в Cloudflare → SSL/TLS выберите режим **Full (strict)**.

## Обслуживание

```bash
journalctl -u samoletpay -f                                  # логи
systemctl restart samoletpay                                 # перезапуск
cd ~/SamoletPay && git pull && bash deploy/update.sh         # обновление из GitHub
bash /opt/samoletpay/deploy/reset-demo.sh                    # вернуть демо-данные
```

Если вход выполнен под обычным пользователем, а не под root, добавляйте `sudo` перед командами.
