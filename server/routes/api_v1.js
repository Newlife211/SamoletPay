'use strict';
/* Open API v1 — аутентификация по X-Api-Key, поддержка Idempotency-Key для выплат */
const { q } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const { R, num, str } = require('../http');
const { httpError } = L;

const cid = (ctx) => ctx.user.company_id;
const contractorOf = (ctx, id) => { const k = q.get('SELECT * FROM contractors WHERE id=? AND company_id=?', id, cid(ctx)); if (!k) throw httpError(404, 'contractor not found'); return k; };
const PAYOUT_FIELDS = 'id,contractor_id,amount,commission,tax,net,status,fail_reason,receipt_number,purpose,idempotency_key,created_at,paid_at';

R.get('/api/v1/balance', 'api', async (ctx) => ({ balance: q.get('SELECT balance FROM companies WHERE id=?', cid(ctx)).balance, currency: 'RUB' }));
R.get('/api/v1/contractors', 'api', async (ctx) => ({ data: q.all('SELECT id,type,full_name,inn,phone,email,npd_status,npd_checked_at,status FROM contractors WHERE company_id=? ORDER BY id', cid(ctx)) }));
R.get('/api/v1/contractors/:id', 'api', async (ctx) => { const k = contractorOf(ctx, ctx.params.id); return { id: k.id, type: k.type, full_name: k.full_name, inn: k.inn, npd_status: k.npd_status, status: k.status, year_income: L.yearIncome(k) }; });
R.post('/api/v1/contractors', 'api', async (ctx) => {
  const id = svc.insertContractor(cid(ctx), ctx.body);
  const k = await svc.refreshNpd(q.get('SELECT * FROM contractors WHERE id=?', id));
  S.audit(ctx, 'api.contractor.create', 'contractor:' + id);
  return { id, npd_status: k.npd_status };
});
R.get('/api/v1/payouts', 'api', async (ctx) => {
  const args = [cid(ctx)]; let w = 'company_id=?';
  if (ctx.query.status) { w += ' AND status=?'; args.push(ctx.query.status); }
  if (ctx.query.since_id) { w += ' AND id>?'; args.push(Number(ctx.query.since_id)); }
  return { data: q.all(`SELECT ${PAYOUT_FIELDS} FROM payouts WHERE ${w} ORDER BY id DESC LIMIT 500`, ...args) };
});
R.get('/api/v1/payouts/:id', 'api', async (ctx) => {
  const p = q.get(`SELECT ${PAYOUT_FIELDS} FROM payouts WHERE id=? AND company_id=?`, ctx.params.id, cid(ctx));
  if (!p) throw httpError(404, 'payout not found');
  return p;
});
R.post('/api/v1/payouts', 'api', async (ctx) => {
  const c = q.get('SELECT * FROM companies WHERE id=?', cid(ctx));
  const idem = str(ctx.req.headers['idempotency-key'] || ctx.body.idempotency_key, 100) || null;
  if (idem) {
    const ex = q.get(`SELECT ${PAYOUT_FIELDS} FROM payouts WHERE company_id=? AND idempotency_key=?`, c.id, idem);
    if (ex) { ctx.res.setHeader('Idempotent-Replayed', 'true'); return ex; }
  }
  const k = contractorOf(ctx, ctx.body.contractor_id);
  const amount = num(ctx.body.amount, 'amount must be > 0', 10e6);
  const id = svc.createPayout(c, k, amount, { purpose: ctx.body.purpose, idempotency_key: idem });
  try { svc.sendPayout(c.id, id); } catch (e) { q.run(`UPDATE payouts SET status='failed', fail_reason=? WHERE id=?`, e.message, id); }
  S.audit(ctx, 'api.payout.create', 'payout:' + id, { amount, idem });
  return q.get(`SELECT ${PAYOUT_FIELDS} FROM payouts WHERE id=?`, id);
});
