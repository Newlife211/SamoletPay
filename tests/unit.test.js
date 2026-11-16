// Модульные тесты: node --test tests/
'use strict';
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'payout-')), 'test.db');
process.env.NPD_OFFLINE = '1';
process.env.PAYOUT_DELAY_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, K, R } = require('../server/db');
const L = require('../server/logic');
const S = require('../server/security');
const jobs = require('../server/jobs');
const svc = require('../server/services');
const pdf = require('../server/pdf');
const { innFor, cardNum } = require('../server/seed');

test('ИНН: контрольные суммы', () => {
  assert.equal(L.validInn('7707083893'), true);
  assert.equal(L.validInn('7707083894'), false);
  assert.equal(L.validInn('500100732259'), true);
  assert.equal(L.validInn('500100732258'), false);
  assert.equal(L.validInn('abc'), false);
});
test('карта: алгоритм Луна', () => {
  assert.equal(L.luhn('2200000000000004'), true);
  assert.equal(L.luhn('2200000000000005'), false);
  assert.equal(L.luhn('123'), false);
});
test('копейки: конвертация без потерь', () => {
  assert.equal(K(0.1) + K(0.2), K(0.3));
  assert.equal(K(10000.55), 1000055);
  assert.equal(R(1000055), 10000.55);
});
test('расчёт выплаты: НПД, НДФЛ, ИП', () => {
  const c = { plan: 'business', tax_service: 1 };
  const a = L.calcPayout(c, { type: 'npd' }, 10000.55);
  assert.deepEqual([a.commission, a.tax, a.net, a.debit], [190.01, 600.03, 9400.52, 10190.56]);
  assert.equal(a.k.amount, a.k.net + a.k.tax);
  const b = L.calcPayout(c, { type: 'fl' }, 1000); assert.equal(b.tax, 130);
  const i = L.calcPayout({ plan: 'start', tax_service: 1 }, { type: 'ip' }, 1000); assert.deepEqual([i.tax, i.commission], [0, 30]);
  const off = L.calcPayout({ plan: 'start', tax_service: 0 }, { type: 'npd' }, 1000); assert.equal(off.tax, 0);
});
test('TOTP: тестовый вектор RFC 6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(S.totpNow(secret, 59 * 1000), '287082');
  assert.equal(S.totpNow(secret, 1111111109 * 1000), '081804');
  assert.equal(S.totpVerify(secret, '287082', 59 * 1000), true);
  assert.equal(S.totpVerify(secret, '000000', 59 * 1000), false);
});
test('пароли и правила сложности', () => {
  const { hash, salt } = S.hashPassword('Secret123');
  assert.equal(S.checkPassword('Secret123', salt, hash), true);
  assert.equal(S.checkPassword('secret123', salt, hash), false);
  assert.ok(S.passwordProblem('short1'));
  assert.ok(S.passwordProblem('onlyletters'));
  assert.equal(S.passwordProblem('Good pass 1'), null);
});
test('ограничение частоты', () => {
  for (let i = 0; i < 3; i++) assert.equal(S.rateLimit('t', 3, 1000).ok, true);
  assert.equal(S.rateLimit('t', 3, 1000).ok, false);
});
test('права ролей', () => {
  assert.equal(S.can({ role: 'company', team_role: 'owner' }, 'settings'), true);
  assert.equal(S.can({ role: 'company', team_role: 'accountant' }, 'payouts.send'), true);
  assert.equal(S.can({ role: 'company', team_role: 'manager' }, 'payouts.send'), false);
  assert.equal(S.can({ role: 'company', team_role: 'manager' }, 'sign'), false);
  assert.equal(S.can({ role: 'contractor' }, 'view'), false);
});
test('свои шаблоны экранируют HTML', () => {
  const html = L.renderCustom('# Заголовок\n\n{{фио}} <script>x</script>', { name: 'ООО' }, { full_name: '<b>Иван</b>' }, { number: '1' });
  assert.match(html, /<h2>Заголовок<\/h2>/);
  assert.doesNotMatch(html, /<script>|<b>Иван/);
});
test('подпись вебхука HMAC детерминирована', () => {
  assert.equal(S.signWebhook('s', '{}', 1), S.signWebhook('s', '{}', 1));
  assert.notEqual(S.signWebhook('s', '{}', 1), S.signWebhook('t', '{}', 1));
});
test('PDF: валидный файл с кириллицей', () => {
  const b = pdf.build(pdf.blocksOf('<h2>ДОГОВОР</h2><p>Текст <b>жирный</b></p><table><tr><td>Итого</td><td>1 ₽</td></tr></table>'), { title: 'Тест' });
  assert.equal(b.slice(0, 8).toString(), '%PDF-1.7');
  assert.match(b.slice(-6).toString(), /%%EOF/);
});

/* ---------- интеграционные: БД + очередь ---------- */
function setupCompany(balance = 100000) {
  const id = Number(q.run('INSERT INTO companies (name,inn,balance,plan,webhook_secret) VALUES (?,?,?,?,?)', 'Тест', '7707083893', K(balance), 'start', 'x').lastInsertRowid);
  return q.get('SELECT * FROM companies WHERE id=?', id);
}
function addContractor(companyId, extra = {}) {
  const id = svc.insertContractor(companyId, { type: 'npd', full_name: 'Тест Тестов', inn: innFor(100000000 + Math.floor(Math.random() * 8e8), true), card: cardNum('2200400' + Math.floor(Math.random() * 1e7)), ...extra });
  q.run(`UPDATE contractors SET npd_status='active', npd_checked_at=datetime('now') WHERE id=?`, id);
  return q.get('SELECT * FROM contractors WHERE id=?', id);
}

test('выплата: списание, проведение, чек', async () => {
  const c = setupCompany(100000); const k = addContractor(c.id);
  const id = svc.createPayout(c, k, 1000);
  svc.sendPayout(c.id, id);
  assert.equal(q.get('SELECT balance FROM companies WHERE id=?', c.id).balance, 100000 - 1030);
  assert.throws(() => svc.sendPayout(c.id, id), /уже отправлена/);
  await jobs.drain();
  const p = q.get('SELECT * FROM payouts WHERE id=?', id);
  assert.equal(p.status, 'paid'); assert.ok(p.receipt_number);
});
test('выплата: отказ банка → возврат денег ровно один раз', async () => {
  const c = setupCompany(5000); const k = addContractor(c.id, { card: cardNum('22000000000000') });
  q.run('UPDATE contractors SET card=? WHERE id=?', '2200000000000002'.replace(/.$/, '2'), k.id); // оканчивается на 0002 → банк отклонит
  const id = svc.createPayout(c, k, 1000);
  svc.sendPayout(c.id, id);
  await jobs.drain();
  assert.equal(q.get('SELECT status FROM payouts WHERE id=?', id).status, 'failed');
  assert.equal(q.get('SELECT balance FROM companies WHERE id=?', c.id).balance, 5000);
  assert.equal(svc.refundPayout(id, 'повтор'), false); // повторный возврат невозможен
});
test('выплата: недостаточно средств и блокировки', () => {
  const c = setupCompany(100); const k = addContractor(c.id);
  assert.throws(() => svc.sendPayout(c.id, svc.createPayout(c, k, 1000)), /Недостаточно средств/);
  const c2 = setupCompany(100000); const fired = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
  const k2 = addContractor(c2.id, { former_employee_until: fired });
  assert.throws(() => svc.sendPayout(c2.id, svc.createPayout(c2, k2, 1000)), /Бывший сотрудник/);
});
test('выплата: идемпотентный ключ', () => {
  const c = setupCompany(100000); const k = addContractor(c.id);
  svc.createPayout(c, k, 500, { idempotency_key: 'abc' });
  assert.throws(() => svc.createPayout(c, k, 500, { idempotency_key: 'abc' }), /Idempotency-Key/);
});
test('лимит НПД 2,4 млн', () => {
  const c = setupCompany(10); const k = addContractor(c.id);
  q.run(`INSERT INTO payouts (company_id,contractor_id,amount,status) VALUES (?,?,?,'paid')`, c.id, k.id, K(2_350_000));
  const risks = L.riskCheck(c, k, 100000);
  assert.ok(risks.some((r) => r.code === 'npd_limit' && r.level === 'block'));
});
test('подписанный документ неизменяем', () => {
  const c = setupCompany(); const k = addContractor(c.id);
  const id = L.createDocument(c.id, { contractor_id: k.id }, 'nda', {});
  q.run(`UPDATE documents SET status='signed', sign_hash=? WHERE id=?`, 'f'.repeat(64), id);
  assert.throws(() => q.run(`UPDATE documents SET body='подмена' WHERE id=?`, id), /изменять нельзя/);
  assert.throws(() => q.run('DELETE FROM documents WHERE id=?', id), /удалять нельзя/);
});
test('КЭДО: без согласия кадровые документы не создаются', () => {
  const c = setupCompany();
  const e = Number(q.run('INSERT INTO employees (company_id,full_name,email) VALUES (?,?,?)', c.id, 'Сотрудник', 'e@e.ru').lastInsertRowid);
  assert.throws(() => L.createDocument(c.id, { employee_id: e }, 'vacation', {}), /согласие на КЭДО/);
  assert.ok(L.createDocument(c.id, { employee_id: e }, 'kedo_consent', {}));
});
test('сплит: доли в копейках без потерь', async () => {
  const c = setupCompany(0); const k1 = addContractor(c.id), k2 = addContractor(c.id), k3 = addContractor(c.id);
  const sid = Number(q.run('INSERT INTO splits (company_id,title,amount,agency_fee_pct,token) VALUES (?,?,?,?,?)', c.id, 'Сплит', K(1000), 10, S.token(6)).lastInsertRowid);
  for (const k of [k1, k2, k3]) q.run('INSERT INTO split_parts (split_id,contractor_id,share_pct) VALUES (?,?,?)', sid, k.id, 100 / 3);
  svc.distributeSplit(q.get('SELECT * FROM splits WHERE id=?', sid), 'Клиент');
  const sum = q.get('SELECT SUM(amount) total FROM payouts WHERE split_id=?', sid).total;
  assert.equal(sum, 900);
  await jobs.drain();
});
test('очередь: повтор после ошибки', async () => {
  let n = 0; jobs.register('t.flaky', async () => { n++; if (n < 2) throw Object.assign(new Error('flaky'), { quiet: true }); });
  const id = jobs.enqueue('t.flaky', {});
  await jobs.tick(); q.run('UPDATE jobs SET run_at=0 WHERE id=?', id); await jobs.tick();
  assert.equal(q.get('SELECT status FROM jobs WHERE id=?', id).status, 'done');
});
