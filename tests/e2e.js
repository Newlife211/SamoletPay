// E2E: полный цикл компании и исполнителя + скриншоты. Запуск: node tests/e2e.js (сервер на :3000)
const { chromium } = require(process.env.PW || 'playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.argv[2] || 'shots';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); }); return p; };
  const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: false });
  const step = (t) => console.log('✓', t);

  const p = await mk();
  for (const [u, n] of [['/', '01-landing'], ['/tariffs', '02-tariffs'], ['/contractors', '03-for-contractors'], ['/developers', '04-api']]) { await p.goto(BASE + u); await p.waitForTimeout(500); await shot(p, n); }
  await p.goto(BASE + '/'); await p.fill('form[data-npd] input[name=inn]', '500100732259'); await p.click('form[data-npd] button'); await p.waitForSelector('.npd-res .chip'); step('публичная проверка НПД');
  await p.screenshot({ path: `${OUT}/01b-landing-full.png`, fullPage: true });

  // регистрация новой компании
  await p.goto(BASE + '/app#/register'); await p.waitForSelector('#f');
  await p.fill('[name=company_name]', 'ООО «Тест»'); await p.fill('[name=name]', 'Пётр Тестов'); await p.fill('[name=phone]', '+79990001122');
  await p.fill('[name=email]', 'new@test.ru'); await p.fill('[name=password]', 'Str0ngPass2026'); await p.check('input[type=checkbox]'); await p.click('#f button');
  await p.waitForSelector('.kpis'); step('регистрация компании');

  // демо-компания
  const c = await mk();
  await c.goto(BASE + '/app#/login'); await c.click('[data-demo="demo@payout.ru"]'); await c.waitForSelector('.chart'); await shot(c, '10-dashboard'); step('вход в демо-кабинет');
  await c.goto(BASE + '/app#/contractors'); await c.waitForSelector('tr[data-id]'); await shot(c, '11-contractors');
  await c.click('tr[data-id]'); await c.waitForSelector('.dl'); await shot(c, '12-contractor-card');
  // добавить исполнителя
  await c.goto(BASE + '/app#/contractors'); await c.waitForSelector('tr[data-id]'); await c.click('text=Добавить');
  await c.fill('#cf [name=full_name]', 'Анна Новая'); await c.fill('#cf [name=inn]', '500100732259'); await c.fill('#cf [name=card]', '2200000000000004'); await c.fill('#cf [name=email]', 'anna@new.ru');
  await c.click('#cf button.btn-primary'); await c.waitForSelector('.dl'); step('добавлен исполнитель');
  // документы: подписать пачкой
  await c.goto(BASE + '/app#/documents?status=mine'); await c.waitForSelector('.sel'); await shot(c, '13-documents');
  await c.check('#all'); await c.click('#signSel'); await c.waitForSelector('.demo-hint');
  const code = (await c.textContent('.demo-hint b')).trim(); await shot(c, '14-sign-modal');
  const ins = await c.$$('.code-in input'); for (let i = 0; i < 6; i++) await ins[i].fill(code[i]);
  await c.waitForSelector('.code-in', { state: 'detached' }); step('пакетная подпись документов');
  // выплата с превью рисков
  await c.goto(BASE + '/app#/payouts'); await c.waitForSelector('.tbl'); await c.click('.topbar >> text=Новая выплата');
  await c.selectOption('.pay-row select', { label: 'Мария Соколова · Самозанятый' }); await c.fill('.pay-row input', '15000');
  await c.click('#add'); const rows = await c.$$('.pay-row'); await (await rows[1].$('select')).selectOption({ label: 'Дмитрий Волков · Самозанятый' }); await (await rows[1].$('input')).fill('5000');
  await c.waitForSelector('#prev .tbl'); await c.waitForTimeout(400); await shot(c, '15-payout-preview');
  await c.click('#send'); await c.waitForSelector('text=Не отправлено'); await shot(c, '16-payout-blocked'); await c.click('[data-close]'); step('выплата + блокировка рисковой');
  await c.waitForTimeout(2500); await c.goto(BASE + '/app#/payouts?status=paid'); await c.waitForSelector('a[href^="/receipt/"]');
  const rc = await c.getAttribute('a[href^="/receipt/"]', 'href'); step('выплата проведена, чек ' + rc);
  // биржа: создать задание
  await c.goto(BASE + '/app#/tasks'); await c.waitForSelector('.tbl'); await shot(c, '17-tasks'); await c.click('.topbar >> text=Создать задание');
  await c.fill('#tf [name=title]', 'Тестовое задание E2E'); await c.fill('#tf [name=budget]', '7000'); await c.click('#tf button.btn-primary'); await c.waitForSelector('h3:has-text("Отклики (")'); step('задание опубликовано');
  const taskUrl = c.url();
  // сплит
  await c.goto(BASE + '/app#/splits'); await c.click('.topbar >> text=Новый сплит'); await c.fill('#sf [name=title]', 'Фотосессия'); await c.fill('#sf [name=amount]', '20000');
  await c.click('#sf button.btn-primary'); await c.waitForSelector('.keybox'); const payUrl = (await c.textContent('.keybox')).trim(); step('сплит создан');
  // баланс, интеграции, настройки
  for (const [h, n] of [['/balance', '18-balance'], ['/integrations', '19-integrations'], ['/settings', '20-settings'], ['/outstaff', '21-outstaff']]) { await c.goto(BASE + '/app#' + h); await c.waitForSelector('.card'); await shot(c, n); }
  await c.goto(BASE + '/app#/integrations'); await c.fill('#kf [name=title]', 'CRM'); await c.click('#kf button'); await c.waitForSelector('.keybox');
  const apiKey = (await c.textContent('.keybox')).trim(); step('API-ключ выпущен');

  // клиент платит сплит
  const pay = await mk(); await pay.goto(payUrl); await pay.fill('[name=payer_name]', 'Клиент'); await pay.fill('[name=card]', '2200000000000004');
  await pay.fill('input[placeholder="12/29"]', '12/29'); await pay.fill('input[placeholder="•••"]', '123'); await shot(pay, '30-pay-page'); await pay.click('button'); await pay.waitForSelector('text=Оплата прошла'); step('клиент оплатил сплит');

  // исполнитель
  const k = await mk(); await k.goto(BASE + '/app#/login'); await k.click('[data-demo="ivan@payout.ru"]'); await k.waitForSelector('.kpis'); await shot(k, '40-contractor-home'); step('кабинет исполнителя');
  await k.goto(BASE + '/app#/market'); await k.waitForSelector('.task-card'); await shot(k, '41-market');
  await k.click('.task-card:has-text("Тестовое задание E2E") [data-r]'); await k.fill('#rf [name=message]', 'Сделаю за день'); await k.click('#rf button.btn-primary'); await k.waitForSelector('text=Вы откликнулись'); step('отклик на задание');
  // компания выбирает исполнителя
  await c.goto(taskUrl); await c.waitForSelector('[data-pick]'); await c.click('[data-pick]'); await c.waitForSelector('#accept'); step('исполнитель выбран, документы созданы');
  // исполнитель подписывает документы и сдаёт работу
  await k.goto(BASE + '/app#/my-docs'); await k.waitForSelector('#all'); await shot(k, '42-contractor-docs'); await k.click('#all'); await k.waitForSelector('.demo-hint');
  const code2 = (await k.textContent('.demo-hint b')).trim(); const ins2 = await k.$$('.code-in input'); for (let i = 0; i < 6; i++) await ins2[i].fill(code2[i]);
  await k.waitForSelector('.code-in', { state: 'detached' }); step('исполнитель подписал документы');
  await k.goto(BASE + '/app#/my-tasks'); await k.click('.tbl tr:has-text("Тестовое задание E2E") [data-done]'); await k.waitForSelector('text=На проверке'); step('работа сдана');
  // компания принимает → акт → выплата
  await c.goto(taskUrl); await c.reload(); await c.waitForSelector('#accept'); await c.click('#accept'); await c.click('#go'); await c.waitForSelector('.demo-hint');
  const code3 = (await c.textContent('.demo-hint b')).trim(); const ins3 = await c.$$('.code-in input'); for (let i = 0; i < 6; i++) await ins3[i].fill(code3[i]);
  await c.waitForSelector('text=Отправлено в банк'); step('акт подписан, выплата отправлена');
  await c.waitForTimeout(2500);
  await k.goto(BASE + '/app#/my-payouts'); await k.waitForSelector('.tbl'); await shot(k, '43-contractor-payouts');
  const has = await k.$('td:has-text("Тестовое задание E2E")'); if (!has) errors.push('выплата по заданию не дошла до исполнителя'); else step('исполнитель получил выплату по заданию');
  await k.goto(BASE + '/app#/profile'); await k.waitForSelector('#pf'); await shot(k, '44-contractor-profile');

  // Open API
  const r = await fetch(BASE + '/api/v1/contractors', { headers: { 'X-Api-Key': apiKey } }); const j = await r.json();
  if (!r.ok || !j.data.length) errors.push('Open API не работает'); else step(`Open API: ${j.data.length} исполнителей`);
  // документ и чек
  await c.goto(BASE + rc); await shot(c, '50-receipt');
  await c.goto(BASE + '/app#/notifications'); await c.waitForSelector('.card'); await shot(c, '51-notifications');
  // мобильная версия
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const mp = await mob.newPage();
  await mp.goto(BASE + '/'); await mp.waitForTimeout(400); await mp.screenshot({ path: `${OUT}/60-mobile-landing.png` });

  await browser.close();
  console.log(errors.length ? '\nОШИБКИ:\n' + errors.join('\n') : '\nВсе сценарии пройдены без ошибок');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
