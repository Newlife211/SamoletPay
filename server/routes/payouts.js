'use strict';
const { q, K, R: toR } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const { R, num, str } = require('../http');
const { contractorOf } = require('./contractors');
const { httpError } = L;

const cid = (ctx) => ctx.user.company_id;
const company = (ctx) => q.get('SELECT * FROM companies WHERE id=?', cid(ctx));

R.post('/api/payouts/preview', { auth: 'company', perm: 'payouts' }, async (ctx) => {
  const c = company(ctx);
  const items = (ctx.body.items || []).slice(0, 5000).map((it) => {
    const k = contractorOf(ctx, it.contractor_id); const amount = num(it.amount, 'Сумма должна быть больше 0', 10e6);
    const calc = L.calcPayout(c, k, amount);
    return { contractor_id: k.id, full_name: k.full_name, type: k.type, amount: calc.amount, commission: calc.commission, tax: calc.tax, net: calc.net, debit: calc.debit, taxNote: calc.taxNote, risks: L.riskCheck(c, k, amount), _k: calc.k.debit };
  });
  const totalK = items.reduce((s, i) => s + i._k, 0);
  items.forEach((i) => delete i._k);
  return { items, total: toR(totalK), balance: c.balance, enough: K(c.balance) >= totalK };
});
R.post('/api/payouts', { auth: 'company', perm: 'payouts' }, async (ctx) => {
  const c = company(ctx); const b = ctx.body;
  const items = Array.isArray(b.items) ? b.items.slice(0, 5000) : [];
  if (!items.length) throw httpError(400, 'Добавьте хотя бы одну выплату');
  if (b.send && !S.can(ctx.user, 'payouts.send')) throw httpError(403, 'Отправлять выплаты может владелец или бухгалтер. Сохраните в черновики.');
  const ids = q.tx(() => {
    const regId = items.length > 1 || b.registry_title ? Number(q.run('INSERT INTO registries (company_id,title) VALUES (?,?)', c.id, str(b.registry_title, 200) || `Реестр от ${new Date().toLocaleDateString('ru-RU')}`).lastInsertRowid) : null;
    return items.map((it) => svc.createPayout(c, contractorOf(ctx, it.contractor_id), num(it.amount, 'Сумма должна быть больше 0', 10e6), { registry_id: regId, purpose: it.purpose || b.purpose, created_by: ctx.user.id }));
  });
  const results = [];
  if (b.send) for (const id of ids) { try { svc.sendPayout(c.id, id); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: e.message }); } }
  S.audit(ctx, b.send ? 'payout.create_send' : 'payout.create', null, { ids, total: items.reduce((s, i) => s + Number(i.amount), 0) });
  return { ids, results };
});
R.post('/api/payouts/send', { auth: 'company', perm: 'payouts.send' }, async (ctx) => {
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 5000) : [];
  const results = ids.map((id) => { try { svc.sendPayout(cid(ctx), Number(id)); return { id, ok: true }; } catch (e) { return { id, ok: false, error: e.message }; } });
  S.audit(ctx, 'payout.send', null, { ok: results.filter((r) => r.ok).map((r) => r.id), failed: results.filter((r) => !r.ok).length });
  return { results };
});
R.post('/api/payouts/:id/cancel', { auth: 'company', perm: 'payouts' }, async (ctx) => {
  const ch = q.run(`UPDATE payouts SET status='cancelled' WHERE id=? AND company_id=? AND status IN ('draft','failed')`, ctx.params.id, cid(ctx)).changes;
  if (!ch) throw httpError(409, 'Можно отменить только черновик или отклонённую выплату');
  S.audit(ctx, 'payout.cancel', 'payout:' + ctx.params.id);
  return { ok: true };
});
R.get('/api/payouts', { auth: 'company', perm: 'view' }, async (ctx) => {
  const s = ctx.query, args = [cid(ctx)]; let w = 'p.company_id=?';
  if (s.status) { w += ' AND p.status=?'; args.push(s.status); }
  if (s.registry_id) { w += ' AND p.registry_id=?'; args.push(s.registry_id); }
  if (s.q) { w += ' AND k.full_name LIKE ?'; args.push(`%${s.q}%`); }
  return {
    payouts: q.all(`SELECT p.*, k.full_name, k.type ctype FROM payouts p JOIN contractors k ON k.id=p.contractor_id WHERE ${w} ORDER BY p.id DESC LIMIT 500`, ...args),
    registries: q.all(`SELECT r.*, COUNT(p.id) n, SUM(p.amount) total, SUM(p.status='paid') paid, SUM(p.status='failed') failed FROM registries r LEFT JOIN payouts p ON p.registry_id=r.id WHERE r.company_id=? GROUP BY r.id ORDER BY r.id DESC`, cid(ctx)),
  };
});

/* ---------- выгрузки ---------- */
function csv(rows, cols) {
  const e = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; // защита от CSV-инъекций
  return '﻿' + [cols.map((c) => c[1]).join(';'), ...rows.map((r) => cols.map((c) => e(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(';'))].join('\r\n');
}
const rub = (v) => Number(v || 0).toFixed(2).replace('.', ',');
R.get('/api/export/:kind', { auth: 'company', perm: 'export' }, async (ctx) => {
  let body, name;
  if (ctx.params.kind === 'payouts.csv' || ctx.params.kind === '1c.csv') {
    const rows = q.all(`SELECT p.*, k.full_name, k.inn, k.type FROM payouts p JOIN contractors k ON k.id=p.contractor_id WHERE p.company_id=? ORDER BY p.id`, cid(ctx));
    body = ctx.params.kind === '1c.csv'
      ? csv(rows.filter((r) => r.status === 'paid'), [[(r) => (r.paid_at || '').slice(0, 10).split('-').reverse().join('.'), 'Дата'], ['id', 'НомерДок'], ['full_name', 'Контрагент'], ['inn', 'ИНН'], [(r) => rub(r.amount), 'Сумма'], [(r) => rub(r.tax), 'Налог'], [(r) => rub(r.commission), 'Комиссия'], ['purpose', 'НазначениеПлатежа'], ['receipt_number', 'ЧекНПД'], ['bank_ref', 'БанкРеф']])
      : csv(rows, [['id', 'ID'], ['created_at', 'Создана'], ['full_name', 'Исполнитель'], ['inn', 'ИНН'], [(r) => rub(r.amount), 'Сумма'], [(r) => rub(r.commission), 'Комиссия'], [(r) => rub(r.tax), 'Налог'], [(r) => rub(r.net), 'К получению'], ['status', 'Статус'], ['receipt_number', 'Чек'], ['purpose', 'Назначение']]);
    name = ctx.params.kind;
  } else if (ctx.params.kind === 'contractors.csv') {
    body = csv(q.all('SELECT * FROM contractors WHERE company_id=?', cid(ctx)), [['full_name', 'ФИО'], ['type', 'Тип'], ['inn', 'ИНН'], ['phone', 'Телефон'], ['email', 'Email'], ['card', 'Карта'], ['npd_status', 'Статус НПД'], ['specialty', 'Специализация']]);
    name = 'contractors.csv';
  } else throw httpError(404, 'Неизвестный формат');
  S.audit(ctx, 'export', null, { kind: name });
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  ctx.res.end(body);
});
