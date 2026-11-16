# Деплой тестового стенда PayOut на Oracle Cloud

Схема: **Oracle Cloud** (бесплатный сервер) → **Cloudflare Tunnel** (бесплатно, порты открывать не нужно) → **ваш домен** с HTTPS.
Время: около 40 минут, почти всё уходит на регистрации.

```
Браузер ──HTTPS──▶ Cloudflare ◀──исходящий туннель── сервер Oracle (PayOut на 127.0.0.1:3000)
```

---

## Шаг 1. Сервер в Oracle Cloud (~15 мин)

1. Зарегистрируйтесь на https://signup.cloud.oracle.com.
   - **Home Region: Germany Central (Frankfurt) или Netherlands Northwest (Amsterdam)** — потом не сменить.
   - Карта нужна только для проверки личности. Российские карты обычно не принимаются.
2. Откройте ☰ → Compute → Instances → **Create instance**:
   - **Name:** `payout`;
   - **Image:** Change image → **Canonical Ubuntu 24.04**;
   - **Shape:** Change shape → **Ampere → VM.Standard.A1.Flex**, **1 OCPU / 6 GB** (максимум бесплатно — 2 OCPU / 12 GB на все машины);
   - **Networking:** оставьте «Automatically assign public IPv4 address»;
   - **Add SSH keys:** «Generate a key pair for me» → **Save private key** (файл `ssh-key-….key`);
   - нажмите **Create**.
3. Ошибка «Out of capacity» — нормальное дело для Oracle. Выберите другой **Availability domain** (AD-2, AD-3) или повторите через 1–2 часа. Временный вариант — бесплатная машина **VM.Standard.E2.1.Micro** (1 ГБ, x86), её хватит для теста.
4. Когда машина станет **Running**, скопируйте **Public IP address**.
5. Рекомендуется: Billing → **Upgrade to Pay As You Go**. В пределах бесплатных лимитов денег не списывают, зато Oracle не отключит «простаивающую» машину. Сразу поставьте Budget alert на $1.

> В режиме туннеля порты 80/443 в Security List открывать **не нужно**.

## Шаг 2. Домен и Cloudflare (~15 мин)

**Вариант A — бесплатный домен `имя.dpdns.org`:**
1. https://dash.domain.digitalplat.org → регистрация → Domain Registration → выберите имя в зоне **.dpdns.org** или **.qzz.io** (бесплатно).
2. Зарегистрируйтесь на https://dash.cloudflare.com → **Add a domain** → введите домен → тариф **Free**.
3. Cloudflare покажет два NS-сервера (`xxx.ns.cloudflare.com`). Впишите их в панели DigitalPlat как nameservers домена.
4. Дождитесь, пока Cloudflare напишет «Active» (от 5 минут до нескольких часов).

**Вариант B — свой домен (.com и т. п.):** Cloudflare → Domain Registration → **Register Domains**. Домен сразу работает на DNS Cloudflare.

**Создание туннеля:**
1. Cloudflare → **Zero Trust** (бесплатный план, при первом входе попросит выбрать имя команды) → **Networks → Tunnels → Create a tunnel** → **Cloudflared** → имя `payout`.
2. На экране установки выберите **Debian / arm64**. Скопируйте из команды **токен** — длинную строку после `--token` или `service install`. Саму команду выполнять не нужно, это сделает скрипт.
3. Далее → вкладка **Public Hostname**:
   - Subdomain: пусто (или `app`), Domain: ваш домен;
   - Service: **HTTP**, URL: **localhost:3000**;
   - нажмите **Save tunnel**.

## Шаг 3. Деплой (~5 мин, одна команда)

На своём компьютере (Windows — PowerShell, Mac/Linux — терминал):

```bash
scp -i путь/к/ssh-key.key payout.zip ubuntu@IP_СЕРВЕРА:~
ssh -i путь/к/ssh-key.key ubuntu@IP_СЕРВЕРА
```

> Mac/Linux: если ssh ругается на права ключа, выполните `chmod 600 путь/к/ssh-key.key`.

На сервере:

```bash
sudo apt-get update && sudo apt-get install -y unzip
unzip payout.zip && cd payout
sudo bash deploy/install.sh --domain ваш-домен.dpdns.org --tunnel ВАШ_ТОКЕН --password Test2026
```

`--password` закрывает стенд паролем от посторонних (логин любой). Уберите этот параметр, если стенд должен быть открытым.

Скрипт сам:
- поставит Node.js 22 и cloudflared;
- создаст службу с автозапуском и изоляцией;
- подключит туннель;
- включит автоматические обновления безопасности;
- проверит, что всё работает.

В конце он покажет адрес и демо-доступы. Откройте `https://ваш-домен` — сайт должен работать сразу.

### Запасной режим без Cloudflare

Если туннель не нужен, сертификат можно получить напрямую через Caddy. Для этого откройте порты: Instance → Subnet → Security List → Add Ingress Rules → `0.0.0.0/0`, TCP, порты 80 и 443. Затем:

```bash
sudo bash deploy/install.sh --domain auto --email ваш@email.ru        # адрес вида 1-2-3-4.sslip.io
sudo bash deploy/install.sh --domain ваш-домен --email ваш@email.ru   # A-запись домена → IP сервера
```

## Шаг 4. Что тестировать

| Роль | Вход (пароль `demo1234`) | Что смотреть |
|---|---|---|
| Компания | demo@payout.ru | Выплаты, документы, биржа, КЭДО, шаблоны, 2FA в разделе «Безопасность» |
| Бухгалтер / менеджер | buh@payout.ru / manager@payout.ru | Разница в правах |
| Исполнитель | ivan@payout.ru | Биржа, подпись документов, чеки |
| Оператор | admin@payout.ru / `admin1234` | Заявки, подтверждение счетов, журнал SMS |

Стенд работает в демо-режиме: код подписи показывается на экране, оплату счёта можно эмулировать кнопкой, письма и SMS видны оператору в разделе «Письма и SMS». Реальные деньги и SMS не отправляются.

## Обслуживание

```bash
journalctl -u payout -f                      # логи приложения
journalctl -u cloudflared -f                 # логи туннеля
sudo systemctl restart payout                # перезапуск
sudo bash deploy/update.sh                   # обновление из папки новой версии (с бэкапом базы)
sudo bash /opt/payout/deploy/reset-demo.sh   # вернуть исходные демо-данные
sudo nano /etc/payout.env                    # настройки (после правки — restart)
```

Файлы на сервере: код в `/opt/payout`, база в `/var/lib/payout/payout.db`, ежедневные копии в `/var/lib/payout/backups`.

## Если что-то не так

| Симптом | Что сделать |
|---|---|
| Out of capacity при создании машины | Другой Availability domain, повтор через 1–2 ч или временно E2.1.Micro |
| Сайт открывается с ошибкой 502 / 1033 | `systemctl status payout cloudflared`. Проверьте, что в Public Hostname указано `http://localhost:3000` |
| «туннель не запустился» в конце скрипта | Скопирован неполный токен — создайте новый в Zero Trust и перезапустите скрипт с ним |
| Домен не открывается | Cloudflare ещё не активировал домен (статус Pending) — подождите |
| Забыли пароль стенда | `sudo nano /etc/payout.env` → `SITE_PASSWORD=…` → `sudo systemctl restart payout` |

Важно: этот стенд предназначен для теста. Для боевого запуска с данными исполнителей из РФ нужен сервер в России (152-ФЗ). Скрипт установки там тот же.
