'use strict';
/* Кабинет физлица: исполнитель и/или сотрудник (КЭДО) */
const { q, K } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const { R, str } = require('../http');
const { httpError, notify } = L;

const myLinks = (user) => q.all('SELECT k.*, c.name company_name FROM contractors k JOIN companies c ON c.id=k.company_id WHERE k.user_id=?', user.id);
const myJobs = (user) => q.all('SELECT e.*, c.name company_name FROM employees e JOIN companies c ON c.id=e.company_id WHERE e.user_id=?', user.id);

R.get('/api/me/summary', 'contractor', async (ctx) => {
  const links = myLinks(ctx.user); const ids = links.map((l) => Number(l.id)); const inList = ids.length ? ids.join(',') : '0';
  const own = JSON.parse(ctx.user.profile || '{}');
  const profile = links[0] ? { ...links[0], ...own, npd_status: links[0].npd_status, npd_checked_at: links[0].npd_checked_at } : { ...own, full_name: own.full_name || ctx.user.name, phone: ctx.user.phone, email: ctx.user.email };
  return {
    profile, companies: links.map((l) => ({ id: l.company_id, name: l.company_name, status: l.status })), employers: myJobs(ctx.user).map((e) => ({ id: e.company_id, name: e.company_name, position: e.position })),
    yearIncome: links[0] ? L.yearIncome(links[0]) : 0, limit: L.NPD_YEAR_LIMIT,
    toSign: q.get(`SELECT COUNT(*) n FROM documents d LEFT JOIN employees e ON e.id=d.employee_id WHERE (d.contractor_id IN (${inList}) OR e.user_id=?) AND d.status IN ('sent','signed_company')`, ctx.user.id).n,
    payouts: q.all(`SELECT p.*, c.name company_name FROM payouts p JOIN companies c ON c.id=p.company_id WHERE p.contractor_id IN (${inList}) AND p.status IN ('paid','processing') ORDER BY p.id DESC LIMIT 200`),
    tasks: q.all(`SELECT t.*, c.name company_name FROM tasks t JOIN companies c ON c.id=t.company_id WHERE t.contractor_id IN (${inList}) ORDER BY t.id DESC`),
  };
});
R.put('/api/me/profile', 'contractor', async (ctx) => {
  const b = ctx.body;
  const inn = b.inn ? String(b.inn).replace(/\D/g, '') : '';
  if (inn && !L.validInn(inn)) throw httpError(400, 'Некорректный ИНН');
  const card = b.card ? String(b.card).replace(/\D/g, '') : '';
  if (card && !L.luhn(card)) throw httpError(400, 'Некорректный номер карты');
  const type = L.CONTRACTOR_TYPES[b.type] ? b.type : null;
  const name = str(b.name, 200) || null, phone = str(b.phone, 40) || null, specialty = str(b.specialty, 120) || null;
  q.run('UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone) WHERE id=?', name, phone, ctx.user.id);
  const prev = JSON.parse(ctx.user.profile || '{}');
  const prof = { ...prev, full_name: name || prev.full_name, inn: inn || prev.inn, card: card || prev.card, type: type || prev.type || 'npd', specialty: specialty || prev.specialty };
  q.run('UPDATE users SET profile=? WHERE id=?', JSON.stringify(prof), ctx.user.id);
  for (const l of myLinks(ctx.user)) q.run(`UPDATE contractors SET full_name=COALESCE(?,full_name), inn=COALESCE(?,inn), card=COALESCE(?,card), type=COALESCE(?,type), specialty=COALESCE(?,specialty), phone=COALESCE(?,phone) WHERE id=?`, name, inn || null, card || null, type, specialty, phone, l.id);
  S.audit(ctx, 'profile.update', null, { card: !!card, inn: !!inn });
  return { ok: true };
});
R.post('/api/me/check-npd', { auth: 'contractor', limit: [10, 10 * 60e3, (c) => 'np' + c.user.id] }, async (ctx) => {
  const links = myLinks(ctx.user);
  if (!links.length) {
    const prof = JSON.parse(ctx.user.profile || '{}');
    if (!prof.inn) throw httpError(400, 'Укажите ИНН в профиле');
    const r = await L.checkNpd(prof.inn);
    Object.assign(prof, { npd_status: r.status, npd_source: r.source, npd_checked_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    q.run('UPDATE users SET profile=? WHERE id=?', JSON.stringify(prof), ctx.user.id);
    return { status: r.status, source: r.source };
  }
  let r; for (const l of links) r = await svc.refreshNpd(l);
  return { status: r.npd_status, source: r.npd_source };
});
R.get('/api/me/documents', 'contractor', async (ctx) => ({
  documents: q.all(`SELECT d.id,d.party,d.type,d.number,d.title,d.status,d.amount,d.created_at,c.name company_name FROM documents d
    LEFT JOIN contractors k ON k.id=d.contractor_id LEFT JOIN employees e ON e.id=d.employee_id JOIN companies c ON c.id=d.company_id
    WHERE (k.user_id=? OR e.user_id=?) AND d.status<>'revoked' ORDER BY d.id DESC`, ctx.user.id, ctx.user.id),
}));
R.get('/api/market', 'contractor', async (ctx) => ({
  tasks: q.all(`SELECT t.id,t.title,t.description,t.category,t.budget,t.deadline,t.city,t.created_at,c.name company,
    (SELECT status FROM responses r WHERE r.task_id=t.id AND r.user_id=?) my_response
    FROM tasks t JOIN companies c ON c.id=t.company_id WHERE t.status='open' AND t.is_public=1 AND c.blocked=0 ORDER BY t.id DESC LIMIT 200`, ctx.user.id),
}));
R.post('/api/market/:id/respond', { auth: 'contractor', limit: [30, 3600e3, (c) => 'resp' + c.user.id] }, async (ctx) => {
  const t = q.get(`SELECT * FROM tasks WHERE id=? AND status='open' AND is_public=1`, ctx.params.id);
  if (!t) throw httpError(404, 'Задание недоступно');
  const price = ctx.body.price ? Number(ctx.body.price) : null;
  if (price !== null && !(price > 0 && price < 10e6)) throw httpError(400, 'Некорректная цена');
  try { q.run('INSERT INTO responses (task_id,user_id,message,price) VALUES (?,?,?,?)', t.id, ctx.user.id, str(ctx.body.message, 2000), price ? K(price) : null); }
  catch { throw httpError(409, 'Вы уже откликнулись'); }
  notify({ company_id: t.company_id, kind: 'task', text: `Новый отклик на задание «${t.title}» от ${ctx.user.name || ctx.user.email}` });
  return { ok: true };
});
R.post('/api/me/tasks/:id/done', 'contractor', async (ctx) => {
  const t = q.get(`SELECT t.* FROM tasks t JOIN contractors k ON k.id=t.contractor_id WHERE t.id=? AND k.user_id=?`, ctx.params.id, ctx.user.id);
  if (!t || t.status !== 'in_progress') throw httpError(409, 'Задание нельзя сдать');
  q.run(`UPDATE tasks SET status='review' WHERE id=?`, t.id);
  notify({ company_id: t.company_id, kind: 'task', text: `Задание «${t.title}» сдано на проверку` });
  return { ok: true };
});
