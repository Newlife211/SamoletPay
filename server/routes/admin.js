'use strict';
/* Кабинет оператора платформы: заявки, подбор, компании, счета, сообщения, очередь задач */
const { q } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const { R, str } = require('../http');
const { confirmInvoice } = require('./company');
const { httpError, notify } = L;

R.get('/api/admin/overview', 'admin', async () => ({
  companies: q.get('SELECT COUNT(*) n FROM companies').n,
  contractors: q.get('SELECT COUNT(*) n FROM contractors').n,
  paidMonth: q.get(`SELECT COALESCE(SUM(amount),0) total FROM payouts WHERE status='paid' AND created_at >= date('now','start of month')`).total,
  revenueMonth: q.get(`SELECT COALESCE(SUM(commission),0) total FROM payouts WHERE status='paid' AND created_at >= date('now','start of month')`).total,
  newLeads: q.get(`SELECT COUNT(*) n FROM leads WHERE status='new'`).n,
  openOutstaff: q.get(`SELECT COUNT(*) n FROM outstaff WHERE status IN ('new','search')`).n,
  issuedInvoices: q.get(`SELECT COUNT(*) n FROM invoices WHERE status='issued'`).n,
  failedJobs: q.get(`SELECT COUNT(*) n FROM jobs WHERE status='failed'`).n,
  processing: q.get(`SELECT COUNT(*) n FROM payouts WHERE status='processing'`).n,
}));
R.get('/api/admin/leads', 'admin', async () => ({ leads: q.all('SELECT * FROM leads ORDER BY id DESC LIMIT 500') }));
R.put('/api/admin/leads/:id', 'admin', async (ctx) => {
  if (ctx.body.status && !['new', 'in_work', 'won', 'lost'].includes(ctx.body.status)) throw httpError(400, 'Неизвестный статус');
  q.run('UPDATE leads SET status=COALESCE(?,status), note=COALESCE(?,note) WHERE id=?', ctx.body.status || null, ctx.body.note ?? null, ctx.params.id);
  return { ok: true };
});
R.get('/api/admin/outstaff', 'admin', async () => ({ requests: q.all('SELECT o.*, c.name company FROM outstaff o JOIN companies c ON c.id=o.company_id ORDER BY o.id DESC') }));
R.put('/api/admin/outstaff/:id', 'admin', async (ctx) => {
  const o = q.get('SELECT * FROM outstaff WHERE id=?', ctx.params.id); if (!o) throw httpError(404, 'Заявка не найдена');
  if (ctx.body.status && !['new', 'search', 'staffed', 'closed'].includes(ctx.body.status)) throw httpError(400, 'Неизвестный статус');
  q.run('UPDATE outstaff SET status=COALESCE(?,status), manager_note=COALESCE(?,manager_note) WHERE id=?', ctx.body.status || null, ctx.body.manager_note ?? null, o.id);
  if (ctx.body.status && ctx.body.status !== o.status) notify({ company_id: o.company_id, kind: 'outstaff', text: `Заявка «${o.role}»: статус — ${{ new: 'новая', search: 'идёт подбор', staffed: 'укомплектовано', closed: 'закрыта' }[ctx.body.status]}` });
  S.audit(ctx, 'admin.outstaff', 'outstaff:' + o.id, ctx.body);
  return { ok: true };
});
// оператор добавляет подобранного кандидата прямо в компанию-заказчика и отправляет договор
R.post('/api/admin/outstaff/:id/candidates', 'admin', async (ctx) => {
  const o = q.get('SELECT * FROM outstaff WHERE id=?', ctx.params.id); if (!o) throw httpError(404, 'Заявка не найдена');
  const id = svc.insertContractor(o.company_id, { ...ctx.body, specialty: ctx.body.specialty || o.role });
  await svc.refreshNpd(q.get('SELECT * FROM contractors WHERE id=?', id));
  L.createDocument(o.company_id, { contractor_id: id }, 'contract', { subject: o.role });
  q.run(`UPDATE outstaff SET staffed=staffed+1, status=CASE WHEN staffed+1>=headcount THEN 'staffed' ELSE 'search' END WHERE id=?`, o.id);
  notify({ company_id: o.company_id, kind: 'outstaff', text: `По заявке «${o.role}» подобран исполнитель ${ctx.body.full_name}. Договор отправлен на подпись.` });
  S.audit(ctx, 'admin.outstaff_candidate', 'outstaff:' + o.id, { contractor_id: id });
  return { id };
});
R.get('/api/admin/companies', 'admin', async () => ({
  companies: q.all(`SELECT c.id,c.name,c.inn,c.balance,c.plan,c.blocked,c.created_at,
    (SELECT COUNT(*) FROM contractors k WHERE k.company_id=c.id) contractors,
    (SELECT COALESCE(SUM(amount),0) FROM payouts p WHERE p.company_id=c.id AND p.status='paid') paid_total
    FROM companies c ORDER BY c.id DESC`),
}));
R.put('/api/admin/companies/:id', 'admin', async (ctx) => {
  if ('blocked' in ctx.body) q.run('UPDATE companies SET blocked=? WHERE id=?', ctx.body.blocked ? 1 : 0, ctx.params.id);
  if (ctx.body.plan && L.PLANS[ctx.body.plan]) q.run('UPDATE companies SET plan=? WHERE id=?', ctx.body.plan, ctx.params.id);
  S.audit(ctx, 'admin.company', 'company:' + ctx.params.id, ctx.body);
  return { ok: true };
});
R.get('/api/admin/invoices', 'admin', async () => ({ invoices: q.all(`SELECT i.*, c.name company, c.inn FROM invoices i JOIN companies c ON c.id=i.company_id ORDER BY i.status='issued' DESC, i.id DESC LIMIT 300`) }));
// ручное подтверждение поступления по выписке (до подключения автоматической сверки)
R.post('/api/admin/invoices/:id/confirm', 'admin', async (ctx) => {
  const inv = q.get('SELECT * FROM invoices WHERE id=?', ctx.params.id); if (!inv) throw httpError(404, 'Счёт не найден');
  confirmInvoice(inv, ctx);
  return { ok: true };
});
R.get('/api/admin/messages', 'admin', async () => ({ messages: q.all('SELECT * FROM messages ORDER BY id DESC LIMIT 200') }));
R.get('/api/admin/jobs', 'admin', async () => ({
  stats: q.all('SELECT type, status, COUNT(*) n FROM jobs GROUP BY type, status ORDER BY type'),
  failed: q.all(`SELECT * FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 50`),
}));
R.post('/api/admin/jobs/:id/retry', 'admin', async (ctx) => {
  q.run(`UPDATE jobs SET status='queued', attempts=0, run_at=? WHERE id=? AND status='failed'`, Date.now(), ctx.params.id);
  return { ok: true };
});
R.get('/api/admin/audit', 'admin', async () => ({ items: q.all('SELECT a.*, c.name company FROM audit_log a LEFT JOIN companies c ON c.id=a.company_id ORDER BY a.id DESC LIMIT 300') }));
