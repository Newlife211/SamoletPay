'use strict';
const { q } = require('../db');
const L = require('../logic');
const svc = require('../services');
const { R, need, str } = require('../http');
const { httpError } = L;

R.get('/api/public/plans', null, async () => ({ plans: L.PLANS, npdLimit: L.NPD_YEAR_LIMIT }));
R.post('/api/leads', { auth: null, limit: [5, 3600e3] }, async (ctx) => {
  const b = ctx.body;
  need(b.name, 'Укажите имя'); if (!b.phone && !b.email) throw httpError(400, 'Укажите телефон или email');
  q.run('INSERT INTO leads (kind,name,phone,email,company,message) VALUES (?,?,?,?,?,?)', str(b.kind, 20) || 'business', str(b.name, 120), str(b.phone, 60), str(b.email, 120), str(b.company, 200), str(b.message, 2000));
  return { ok: true };
});
R.post('/api/public/npd-check', { auth: null, limit: [20, 10 * 60e3] }, async (ctx) => L.checkNpd(String(ctx.body.inn || '').replace(/\D/g, '')));
R.get('/api/public/tasks', null, async () => ({
  tasks: q.all(`SELECT t.id,t.title,t.category,t.budget,t.deadline,t.city,t.created_at,c.name company FROM tasks t JOIN companies c ON c.id=t.company_id
                WHERE t.status='open' AND t.is_public=1 AND c.blocked=0 ORDER BY t.id DESC LIMIT 30`),
}));
R.get('/api/public/split/:token', null, async (ctx) => {
  const s = q.get('SELECT s.id,s.title,s.amount,s.status,c.name company FROM splits s JOIN companies c ON c.id=s.company_id WHERE s.token=?', ctx.params.token);
  if (!s) throw httpError(404, 'Платёж не найден');
  return s;
});
R.post('/api/public/split/:token/pay', { auth: null, limit: [10, 10 * 60e3] }, async (ctx) => {
  const s = q.get('SELECT * FROM splits WHERE token=?', ctx.params.token);
  if (!s) throw httpError(404, 'Платёж не найден');
  if (s.status !== 'pending') throw httpError(409, 'Платёж уже оплачен');
  if (!L.luhn(ctx.body.card)) throw httpError(400, 'Проверьте номер карты');
  svc.distributeSplit(s, need(ctx.body.payer_name, 'Укажите имя плательщика').slice(0, 120));
  return { ok: true };
});
// публичная проверка подлинности подписанного документа по SHA-256
R.get('/api/public/verify/:hash', { auth: null, limit: [60, 60e3] }, async (ctx) => {
  const h = String(ctx.params.hash).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw httpError(400, 'Некорректная контрольная сумма');
  const d = q.get(`SELECT d.number, d.title, d.type, d.company_signed_at, d.contractor_signed_at, d.created_at, c.name company,
    COALESCE(k.full_name, e.full_name) person FROM documents d JOIN companies c ON c.id=d.company_id
    LEFT JOIN contractors k ON k.id=d.contractor_id LEFT JOIN employees e ON e.id=d.employee_id WHERE d.sign_hash=? AND d.status='signed'`, h);
  if (!d) return { valid: false };
  const mask = (n) => String(n || '').split(' ').map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ');
  return { valid: true, ...d, person: mask(d.person) };
});
R.get('/healthz', null, async () => {
  const j = q.get(`SELECT COUNT(*) n FROM jobs WHERE status='queued' AND run_at < ?`, Date.now() - 60e3).n;
  return { ok: true, db: 'ok', stuck_jobs: j, time: new Date().toISOString() };
});
