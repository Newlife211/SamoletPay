// E2E №2: безопасность, роли, КЭДО, шаблоны, PDF, кабинет оператора. Запуск: node tests/e2e2.js shots
const { chromium } = require(process.env.PW || 'playwright');
const fs = require('fs');
const S = require('../server/security');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.argv[2] || 'shots';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const step = (t) => console.log('✓', t);
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('dialog', (d) => d.accept());
    return p; };
  const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
  const login = async (p, email, pass = 'demo1234') => { await p.goto(BASE + '/app#/login'); await p.fill('#f [name=email]', email); await p.fill('#f [name=password]', pass); await p.click('#f button'); };
  const code = async (p) => { await p.waitForSelector('.demo-hint b'); const c = (await p.textContent('.demo-hint b')).trim(); const ins = await p.$$('.code-in input'); for (let i = 0; i < 6; i++) await ins[i].fill(c[i]); await p.waitForSelector('.code-in', { state: 'detached' }); };
  const apiAs = (p, url, body, method) => p.evaluate(async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; }, [url, body, method]);

  /* --- роли: менеджер --- */
  const m = await mk(); await login(m, 'manager@payout.ru'); await m.waitForSelector('.kpis');
  const nav = await m.textContent('.side');
  if (/Баланс|Интеграции/.test(nav)) errors.push('менеджер видит Баланс/Интеграции');
  await m.goto(BASE + '/app#/payouts'); await m.waitForSelector('.tbl'); await m.click('.topbar >> text=Новая выплата'); await m.waitForSelector('.pay-row');
  if (await m.$('#send')) errors.push('менеджеру доступна кнопка «Выплатить»'); await shot(m, '70-manager-payout');
  const r403 = await apiAs(m, '/api/payouts/send', { ids: [1] }); if (r403.status !== 403) errors.push('API отправки выплат не вернул 403 менеджеру: ' + r403.status);
  const r403b = await apiAs(m, '/api/integrations/keys', { title: 'x' }); if (r403b.status !== 403) errors.push('менеджер создал API-ключ');
  step('роль «Менеджер»: нет доступа к отправке выплат, балансу и API');

  /* --- восстановление пароля --- */
  const b = await mk(); await b.goto(BASE + '/app#/forgot'); await b.fill('[name=email]', 'buh@payout.ru'); await b.click('#f button');
  await b.waitForSelector('.demo-hint a'); await b.click('.demo-hint a'); await b.waitForSelector('[name=password]');
  await b.fill('[name=password]', 'NewBuh2026'); await b.click('#f button'); await b.waitForSelector('#f [name=email]');
  await login(b, 'buh@payout.ru', 'demo1234'); await b.waitForSelector('.toast.err'); // старый пароль больше не подходит
  await login(b, 'buh@payout.ru', 'NewBuh2026'); await b.waitForSelector('.kpis'); step('сброс пароля по ссылке, старый пароль отклонён');

  /* --- 2FA для владельца --- */
  const o = await mk(); await login(o, 'demo@payout.ru'); await o.waitForSelector('.kpis');
  await o.goto(BASE + '/app#/security'); await o.click('#s2'); await o.waitForSelector('#s2box .keybox');
  const secret = (await o.textContent('#s2box .keybox')).replace(/\s/g, '');
  await o.fill('#e2 [name=code]', S.totpNow(secret)); await o.click('#e2 button'); await o.waitForSelector('text=Включена'); await shot(o, '71-security-2fa');
  const o2 = await mk(); await login(o2, 'demo@payout.ru'); await o2.waitForSelector('#tf [name=code]'); await shot(o2, '72-login-2fa');
  await o2.fill('#tf [name=code]', '000000'); await o2.click('#tf button'); await o2.waitForSelector('.toast.err');
  await o2.fill('#tf [name=code]', S.totpNow(secret)); await o2.click('#tf button'); await o2.waitForSelector('.kpis'); step('2FA: включение, вход по коду, неверный код отклонён');

  /* --- бывший сотрудник --- */
  const blocked = await apiAs(o, '/api/payouts', { items: [{ contractor_id: 9, amount: 1000 }], send: true });
  if (!blocked.json.results || blocked.json.results[0].ok || !/Бывший сотрудник/.test(blocked.json.results[0].error)) errors.push('выплата бывшему сотруднику не заблокирована');
  else step('выплата бывшему сотруднику заблокирована');

  /* --- шаблоны --- */
  await o.goto(BASE + '/app#/templates'); await o.waitForSelector('tr[data-id]'); await o.click('tr[data-id]'); await o.waitForSelector('#pv h2'); await shot(o, '73-template-editor'); await o.click('[data-close]');
  await o.goto(BASE + '/app#/documents'); await o.waitForSelector('.tbl'); await o.click('.topbar >> text=Создать документ');
  await o.waitForSelector('#df select[name=type]'); const opt = await o.$eval('#df select[name=type] optgroup option', (x) => x.value);
  await o.selectOption('#df select[name=type]', opt); await o.check('#df input[name=c] >> nth=1'); await o.fill('#df [name=subject]', 'Съёмка каталога'); await o.fill('#df [name=amount]', '25000');
  await o.click('#df button.btn-primary'); await code(o); step('документ из собственного шаблона создан и подписан компанией');

  /* --- КЭДО --- */
  await o.goto(BASE + '/app#/employees'); await o.waitForSelector('.tbl'); await shot(o, '74-employees'); await o.click('.topbar >> text=Добавить');
  await o.fill('#ef [name=full_name]', 'Ирина Тестова'); await o.fill('#ef [name=position]', 'Дизайнер'); await o.fill('#ef [name=email]', 'irina@test.ru'); await o.click('#ef button.btn-primary');
  await o.waitForSelector('text=Кадровые документы'); const empUrl = o.url();
  const e = await mk(); await e.goto(BASE + '/app#/register?role=contractor'); await e.waitForSelector('#f');
  await e.fill('[name=name]', 'Ирина Тестова'); await e.fill('[name=phone]', '+79990002233'); await e.fill('[name=email]', 'irina@test.ru'); await e.fill('[name=password]', 'Irina2026x'); await e.check('#f input[type=checkbox]'); await e.click('#f button');
  await e.waitForSelector('#pf'); await e.goto(BASE + '/app#/my-docs'); await e.waitForSelector('#all'); await e.click('#all'); await code(e); step('сотрудник зарегистрировался и подписал согласие на КЭДО');
  await o.goto(empUrl); await o.reload(); await o.waitForSelector('#nd:not([disabled])'); await o.click('#nd');
  await o.selectOption('#df select[name=type]', 'vacation'); await o.fill('#df [name=subject]', 'с 01.07 по 14.07'); await o.click('#df button.btn-primary'); await code(o);
  await e.goto(BASE + '/app#/home'); await e.goto(BASE + '/app#/my-docs'); await e.waitForSelector('#all'); await e.click('#all'); await code(e);
  await o.goto(empUrl); await o.reload(); await o.waitForSelector('tr[data-doc]'); await shot(o, '75-employee-card');
  const docId = await o.$eval('tr[data-doc]', (x) => x.dataset.doc);
  const pdfRes = await o.request.get(BASE + '/doc/' + docId + '.pdf'); const pdfBuf = await pdfRes.body();
  if (pdfRes.headers()['content-type'] !== 'application/pdf' || pdfBuf.slice(0, 5).toString() !== '%PDF-') errors.push('PDF не сформирован'); else { fs.writeFileSync(`${OUT}/doc.pdf`, pdfBuf); step(`приказ об отпуске подписан обеими сторонами, PDF ${Math.round(pdfBuf.length / 1024)} КБ`); }
  const d = await apiAs(o, '/api/documents/' + docId); const hash = d.json.document.sign_hash;
  await o.goto(BASE + '/verify/' + hash); await o.waitForSelector('text=Документ подлинный'); await shot(o, '76-verify');
  await o.goto(BASE + '/verify/' + 'a'.repeat(64)); await o.waitForSelector('text=не найден'); step('проверка подлинности по SHA-256');

  /* --- журнал --- */
  await o.goto(BASE + '/app#/audit'); await o.waitForSelector('text=Подписание документов'); await shot(o, '77-audit'); step('журнал действий');

  /* --- пополнение через оператора --- */
  const inv = await apiAs(o, '/api/invoices', { amount: 50000 });
  const a = await mk(); await login(a, 'admin@payout.ru', 'admin1234'); await a.waitForSelector('.kpis'); await shot(a, '80-admin');
  await a.goto(BASE + '/app#/admin/invoices'); await a.waitForSelector(`[data-c="${inv.json.id}"]`); await a.click(`[data-c="${inv.json.id}"]`); await a.waitForSelector('text=Баланс компании пополнен'); step('оператор подтвердил поступление');
  await a.goto(BASE + '/app#/admin/outstaff'); await a.waitForSelector('[data-add]'); await shot(a, '81-admin-outstaff'); await a.click('[data-add]');
  await a.fill('#cf [name=full_name]', 'Кандидат Складов'); await a.fill('#cf [name=inn]', '500100732259'); await a.fill('#cf [name=card]', '2200000000000004'); await a.fill('#cf [name=phone]', '+79991234567');
  await a.click('#cf button.btn-primary'); await a.waitForSelector('text=1 из 5'); step('оператор добавил кандидата в компанию');
  await a.goto(BASE + '/app#/admin/messages'); await a.waitForSelector('text=код подписи'); await shot(a, '82-admin-messages'); step('журнал SMS и писем');
  await a.goto(BASE + '/app#/admin/leads'); await a.waitForSelector('[data-l]'); await a.goto(BASE + '/app#/admin/jobs'); await a.waitForSelector('.card');
  const forb = await apiAs(o, '/api/admin/overview'); if (forb.status !== 403) errors.push('компания получила доступ к API оператора');

  /* --- Open API: идемпотентность --- */
  const key = (await apiAs(o, '/api/integrations/keys', { title: 'e2e' })).json.key;
  const call = () => fetch(BASE + '/api/v1/payouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'Idempotency-Key': 'order-777' }, body: JSON.stringify({ contractor_id: 2, amount: 1234.56 }) }).then((r) => r.json());
  const p1 = await call(), p2 = await call();
  if (p1.id !== p2.id) errors.push('Idempotency-Key не сработал'); else step(`Open API: повтор с Idempotency-Key вернул ту же выплату #${p1.id}`);
  const bad = await fetch(BASE + '/api/v1/balance', { headers: { 'X-Api-Key': 'po_live_wrong' } }); if (bad.status !== 401) errors.push('неверный ключ не отклонён');

  await browser.close();
  console.log(errors.length ? '\nОШИБКИ:\n' + errors.join('\n') : '\nВсе сценарии пройдены без ошибок');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message.split('\n').slice(0, 3).join('\n')); process.exit(1); });
