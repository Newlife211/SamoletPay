'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { q, K, R, db, DB_PATH } = require('./db');
const L = require('./logic');
const S = require('./security');
const jobs = require('./jobs');
const mailer = require('./mailer');
const { httpError, notify } = L;

const PAYOUT_DELAY_MS = Number(process.env.PAYOUT_DELAY_MS || 1500);

/* ================= банк (адаптер) =================
   Боевая реализация: вызов API банка номинального счёта с идемпотентным ключом payout-<id>.
   Демо: карта, оканчивающаяся на 0002, отклоняется банком. */
const bank = {
  async transfer({ id, amountK, card, account }) {
    if (process.env.BANK_PROVIDER && process.env.BANK_PROVIDER !== 'demo') throw Object.assign(new Error('Банк-провайдер не настроен'), { permanent: true });
    if (card && card.endsWith('0002')) return { ok: false, reason: 'Банк получателя отклонил перевод (карта заблокирована)' };
    return { ok: true, ref: 'DEMO-' + id + '-' + Date.now().toString(36) };
  },
};

/* ================= исполнители ================= */
function insertContractor(companyId, b) {
  const type = L.CONTRACTOR_TYPES[b.type] ? b.type : 'npd';
  const full_name = String(b.full_name || '').trim().slice(0, 200);
  if (!full_name) throw httpError(400, 'Укажите ФИО');
  const inn = String(b.inn || '').replace(/\D/g, '');
  if (inn && !L.validInn(inn)) throw httpError(400, `Некорректный ИНН у «${full_name}»`);
  if (type === 'npd' && !inn) throw httpError(400, `Для самозанятого «${full_name}» нужен ИНН`);
  if (inn && q.get('SELECT id FROM contractors WHERE company_id=? AND inn=?', companyId, inn)) throw httpError(409, `Исполнитель с ИНН ${inn} уже добавлен`);
  const card = String(b.card || '').replace(/\D/g, '');
  if (card && !L.luhn(card)) throw httpError(400, `Некорректный номер карты у «${full_name}»`);
  const fe = b.former_employee_until && /^\d{4}-\d{2}-\d{2}$/.test(b.former_employee_until) ? b.former_employee_until : null;
  const email = String(b.email || '').toLowerCase().trim(), phone = String(b.phone || '').trim();
  const id = Number(q.run(`INSERT INTO contractors (company_id,type,full_name,inn,phone,email,card,bank_account,bik,citizenship,specialty,former_employee_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    companyId, type, full_name, inn || null, phone, email, card || null, b.bank_account || null, b.bik || null, b.citizenship || (type === 'eaeu' ? 'Казахстан' : 'РФ'), b.specialty || null, fe).lastInsertRowid);
  const u = q.get(`SELECT * FROM users WHERE role='contractor' AND ((email<>'' AND email=?) OR (phone<>'' AND phone=?))`, email || '#', phone || '#');
  const company = q.get('SELECT name FROM companies WHERE id=?', companyId);
  if (u) { q.run(`UPDATE contractors SET user_id=?, status='active' WHERE id=?`, u.id, id); notify({ user_id: u.id, text: `${company.name} добавил(а) вас исполнителем` }); }
  else {
    const [subj, text] = mailer.T.invite(full_name, company.name, 'contractor');
    if (email) mailer.email(email, subj, text); else if (phone) mailer.sms(phone, `${company.name} приглашает вас в ${L.BRAND}: ${mailer.APP_URL}/app#/register?role=contractor`);
  }
  return id;
}
async function refreshNpd(k) {
  if (k.type !== 'npd' || !k.inn) return k;
  const r = await L.checkNpd(k.inn);
  q.run(`UPDATE contractors SET npd_status=?, npd_source=?, npd_checked_at=datetime('now') WHERE id=?`, r.status, r.source, k.id);
  if (r.status !== 'active' && k.npd_status === 'active') notify({ company_id: k.company_id, kind: 'risk', text: `${k.full_name}: ФНС больше не подтверждает статус самозанятого` });
  return { ...k, npd_status: r.status, npd_source: r.source, npd_checked_at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
}
function linkContractorUser(user) {
  q.run(`UPDATE contractors SET user_id=?, status=CASE WHEN status='invited' THEN 'active' ELSE status END
         WHERE user_id IS NULL AND ((email<>'' AND lower(email)=lower(?)) OR (phone<>'' AND phone=?))`, user.id, user.email, user.phone || '#');
  q.run(`UPDATE employees SET user_id=?, status=CASE WHEN status='invited' THEN 'active' ELSE status END
         WHERE user_id IS NULL AND ((email<>'' AND lower(email)=lower(?)) OR (phone<>'' AND phone=?))`, user.id, user.email, user.phone || '#');
}

/* ================= выплаты ================= */
function createPayout(company, k, amountRub, extra = {}) {
  const calc = L.calcPayout(company, k, amountRub);
  try {
    return Number(q.run(`INSERT INTO payouts (company_id,contractor_id,registry_id,split_id,task_id,amount,commission,tax,net,purpose,idempotency_key,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      company.id, k.id, extra.registry_id || null, extra.split_id || null, extra.task_id || null, calc.k.amount, calc.k.commission, calc.k.tax, calc.k.net,
      String(extra.purpose || 'Оплата услуг').slice(0, 300), extra.idempotency_key || null, extra.created_by || null).lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(e.message) && extra.idempotency_key) { const ex = q.get('SELECT id FROM payouts WHERE company_id=? AND idempotency_key=?', company.id, extra.idempotency_key); e.existingId = ex && ex.id; e.status = 409; e.message = 'Выплата с таким Idempotency-Key уже создана'; }
    throw e;
  }
}
/** Списать с баланса и поставить в очередь на перечисление. Повторный вызов безопасен. */
function sendPayout(companyId, id) {
  q.tx(() => {
    const p = q.raw('SELECT * FROM payouts WHERE id=? AND company_id=?', id, companyId);
    if (!p) throw httpError(404, 'Выплата не найдена');
    if (!['draft', 'failed'].includes(p.status)) throw httpError(409, `Выплата #${id} уже отправлена`);
    const c = q.get('SELECT * FROM companies WHERE id=?', companyId);
    const k = q.get('SELECT * FROM contractors WHERE id=?', p.contractor_id);
    const blockers = L.riskCheck(c, k, R(p.amount)).filter((r) => r.level === 'block' && !(r.code === 'npd_status' && k.npd_status === 'unknown'));
    if (blockers.length) throw httpError(422, `${k.full_name}: ${blockers.map((b) => b.text).join('; ')}`);
    const debit = p.amount + p.commission;
    const bal = q.raw('SELECT balance FROM companies WHERE id=?', companyId).balance;
    if (bal < debit) throw httpError(402, `Недостаточно средств: нужно ${L.fmtMoney(R(debit))}, на балансе ${L.fmtMoney(R(bal))}`);
    q.run('UPDATE companies SET balance=balance-? WHERE id=?', debit, companyId);
    q.run('INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)', companyId, 'payout', -p.amount, `Выплата ${k.full_name}`, 'payout:' + id);
    q.run('INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)', companyId, 'commission', -p.commission, `Комиссия сервиса за выплату #${id}`, 'payout:' + id);
    q.run(`UPDATE payouts SET status='processing', fail_reason=NULL WHERE id=?`, id);
    jobs.enqueue('payout.process', { id }, { delayMs: PAYOUT_DELAY_MS, uniqueKey: 'payout:' + id, maxAttempts: 8 });
  });
}
function refundPayout(id, reason) {
  return q.tx(() => {
    const p = q.raw('SELECT * FROM payouts WHERE id=?', id);
    if (!p || p.status !== 'processing') return false;
    const debit = p.amount + p.commission;
    q.run(`UPDATE payouts SET status='failed', fail_reason=? WHERE id=? AND status='processing'`, reason, id);
    q.run('UPDATE companies SET balance=balance+? WHERE id=?', debit, p.company_id);
    q.run('INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)', p.company_id, 'refund', debit, `Возврат: выплата #${id} отклонена`, 'payout:' + id);
    return p;
  });
}
jobs.register('payout.process', async ({ id }) => {
  const p = q.get('SELECT * FROM payouts WHERE id=?', id);
  if (!p || p.status !== 'processing') return;
  let k = q.get('SELECT * FROM contractors WHERE id=?', p.contractor_id);
  if (k.type === 'npd') k = await refreshNpd(k); // перепроверка непосредственно перед перечислением
  let fail = null;
  if (k.type === 'npd' && k.npd_status !== 'active') fail = 'Исполнитель не является плательщиком НПД на дату выплаты';
  else if (k.type === 'npd' && L.formerEmployeeBan(k)) fail = 'Бывший сотрудник: выплата как самозанятому запрещена';
  else if (!k.card && !k.bank_account) fail = 'Нет реквизитов';
  let ref = null;
  if (!fail) { const t = await bank.transfer({ id, amountK: K(p.net), card: k.card, account: k.bank_account }); if (!t.ok) fail = t.reason; else ref = t.ref; }
  if (fail) {
    if (refundPayout(id, fail)) {
      notify({ company_id: p.company_id, kind: 'risk', text: `Выплата ${k.full_name} на ${L.fmtMoney(p.amount)} отклонена: ${fail}. Средства возвращены на баланс.` });
      webhook(p.company_id, 'payout.failed', { id, reason: fail });
    }
    return;
  }
  const receipt = k.type === 'npd' ? '20' + S.token(5) : null;
  const ok = q.run(`UPDATE payouts SET status='paid', paid_at=datetime('now'), receipt_number=?, bank_ref=? WHERE id=? AND status='processing'`, receipt, ref, id).changes;
  if (!ok) return;
  if (p.tax > 0) q.run('INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)', p.company_id, 'tax', 0, `Налог ${L.fmtMoney(p.tax)} удержан из выплаты #${id} и перечислен в ФНС`, 'payout:' + id);
  if (k.user_id) notify({ user_id: k.user_id, kind: 'payout', text: `Поступила выплата ${L.fmtMoney(p.net)}${receipt ? '. Чек сформирован автоматически' : ''}` });
  const c = q.get('SELECT name, notify_emails FROM companies WHERE id=?', p.company_id);
  notify({ company_id: p.company_id, kind: 'payout', text: `Выплата ${k.full_name} — ${L.fmtMoney(p.amount)} — проведена` });
  if (c.notify_emails) for (const e of c.notify_emails.split(/[,;\s]+/).filter((x) => /@/.test(x)).slice(0, 5)) { const [s, t] = mailer.T.payoutPaid(c.name, k.full_name, L.fmtMoney(p.amount)); mailer.email(e, s, t); }
  webhook(p.company_id, 'payout.paid', { id, amount: p.amount, net: p.net, contractor_id: k.id, receipt });
});
// после исчерпания попыток — возвращаем деньги, выплата не может «зависнуть»
jobs.register('payout.process:failed', async ({ id }, e) => { if (refundPayout(id, 'Техническая ошибка банка: ' + e.message)) notify({ company_id: q.get('SELECT company_id FROM payouts WHERE id=?', id).company_id, kind: 'risk', text: `Выплата #${id} не прошла по технической причине, средства возвращены` }); });

/* ================= сплит ================= */
function distributeSplit(s, payer) {
  const c = q.get('SELECT * FROM companies WHERE id=?', s.company_id);
  const parts = q.all('SELECT * FROM split_parts WHERE split_id=?', s.id);
  const totalK = K(s.amount), feeK = Math.round(totalK * s.agency_fee_pct / 100), poolK = totalK - feeK;
  const ids = q.tx(() => {
    const changed = q.run(`UPDATE splits SET status='paid', payer_name=?, paid_at=datetime('now') WHERE id=? AND status='pending'`, payer, s.id).changes;
    if (!changed) throw httpError(409, 'Платёж уже оплачен');
    q.run('UPDATE companies SET balance=balance+? WHERE id=?', totalK, c.id);
    q.run(`INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)`, c.id, 'split_in', totalK, `Оплата «${s.title}» от ${payer}`, 'split:' + s.id);
    // доли в копейках; остаток от округления — последнему получателю
    let left = poolK;
    return parts.map((p, i) => {
      const k = q.get('SELECT * FROM contractors WHERE id=?', p.contractor_id);
      const partK = i === parts.length - 1 ? left : Math.floor(poolK * p.share_pct / 100); left -= partK;
      return createPayout(c, k, R(partK), { split_id: s.id, purpose: `Сплит: ${s.title}` });
    });
  });
  notify({ company_id: c.id, kind: 'split', text: `Поступила оплата ${L.fmtMoney(s.amount)} по сплиту «${s.title}». Агентское вознаграждение ${L.fmtMoney(R(feeK))}.` });
  ids.forEach((id) => { try { sendPayout(c.id, id); } catch (e) { q.run(`UPDATE payouts SET fail_reason=? WHERE id=?`, e.message, id); } });
  q.run(`UPDATE splits SET status='distributed' WHERE id=?`, s.id);
}

/* ================= вебхуки с HMAC и повторами ================= */
function webhook(companyId, event, data) {
  const c = q.get('SELECT webhook_url FROM companies WHERE id=?', companyId);
  if (c && c.webhook_url) jobs.enqueue('webhook.deliver', { company_id: companyId, event, data, id: S.token(8) }, { maxAttempts: 6 });
}
jobs.register('webhook.deliver', async (pl, job) => {
  const c = q.get('SELECT webhook_url, webhook_secret FROM companies WHERE id=?', pl.company_id);
  if (!c || !c.webhook_url) return;
  const body = JSON.stringify({ id: pl.id, event: pl.event, data: pl.data, ts: new Date().toISOString() });
  const ts = Math.floor(Date.now() / 1000);
  let status;
  try {
    const r = await fetch(c.webhook_url, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', 'X-SamoletPay-Event': pl.event, 'X-SamoletPay-Timestamp': String(ts), 'X-SamoletPay-Signature': 'sha256=' + S.signWebhook(c.webhook_secret || '', body, ts) }, body });
    status = String(r.status);
    q.run('INSERT INTO webhook_logs (company_id,event,url,status,attempt) VALUES (?,?,?,?,?)', pl.company_id, pl.event, c.webhook_url, status, job.attempts + 1);
    if (r.status >= 300) throw Object.assign(new Error('HTTP ' + r.status), { quiet: true });
  } catch (e) {
    if (!status) q.run('INSERT INTO webhook_logs (company_id,event,url,status,attempt) VALUES (?,?,?,?,?)', pl.company_id, pl.event, c.webhook_url, 'error: ' + e.message, job.attempts + 1);
    e.quiet = true; throw e;
  }
});

/* ================= сообщения ================= */
jobs.register('message.send', async ({ id }) => mailer.deliver(id));
jobs.register('message.send:failed', async ({ id }, e) => q.run(`UPDATE messages SET status='failed', provider_response=? WHERE id=?`, String(e.message).slice(0, 500), id));

/* ================= регламентные задачи ================= */
jobs.register('npd.daily', async () => {
  // ФНС ограничивает частоту запросов, поэтому за запуск — не более 30 проверок
  const list = q.all(`SELECT * FROM contractors WHERE type='npd' AND inn IS NOT NULL AND (npd_checked_at IS NULL OR npd_checked_at < datetime('now','-20 hours')) ORDER BY npd_checked_at LIMIT 30`);
  for (const k of list) await refreshNpd(k);
});
jobs.register('sessions.cleanup', async () => { S.cleanupSessions(); q.run(`DELETE FROM user_tokens WHERE expires_at < datetime('now','-1 day')`); q.run(`DELETE FROM jobs WHERE status='done' AND created_at < datetime('now','-7 day')`); });
jobs.register('db.backup', async () => {
  const dir = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `samoletpay-${new Date().toISOString().slice(0, 10)}.db`);
  try { fs.unlinkSync(file); } catch {}
  db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = Number(process.env.BACKUP_KEEP || 7);
  fs.readdirSync(dir).filter((f) => /^samoletpay-.*\.db$/.test(f)).sort().slice(0, -keep).forEach((f) => fs.unlinkSync(path.join(dir, f)));
});
function startSchedules() {
  jobs.every('npd.daily', 60 * 60e3);
  jobs.every('sessions.cleanup', 60 * 60e3);
  jobs.every('db.backup', 24 * 60 * 60e3);
}

module.exports = { bank, insertContractor, refreshNpd, linkContractorUser, createPayout, sendPayout, refundPayout, distributeSplit, webhook, startSchedules };
