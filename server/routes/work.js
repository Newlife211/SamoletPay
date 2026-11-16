'use strict';
const { q, K } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const { R, need, num, str } = require('../http');
const { contractorOf } = require('./contractors');
const { httpError, notify } = L;

const cid = (ctx) => ctx.user.company_id;

/* ================= биржа заданий ================= */
R.get('/api/tasks', { auth: 'company', perm: 'view' }, async (ctx) => ({
  tasks: q.all(`SELECT t.*, k.full_name contractor_name, (SELECT COUNT(*) FROM responses r WHERE r.task_id=t.id) responses
                FROM tasks t LEFT JOIN contractors k ON k.id=t.contractor_id WHERE t.company_id=? ORDER BY t.id DESC`, cid(ctx)),
}));
R.post('/api/tasks', { auth: 'company', perm: 'tasks' }, async (ctx) => {
  const b = ctx.body;
  const id = Number(q.run('INSERT INTO tasks (company_id,title,description,category,budget,deadline,city,is_public) VALUES (?,?,?,?,?,?,?,?)',
    cid(ctx), need(b.title, 'Укажите название').slice(0, 200), str(b.description, 5000), str(b.category, 60) || 'Другое', K(num(b.budget, 'Укажите бюджет', 10e6)), str(b.deadline, 10) || null, str(b.city, 100) || 'Удалённо', b.is_public === false ? 0 : 1).lastInsertRowid);
  if (b.contractor_id) assignTask(ctx, id, contractorOf(ctx, b.contractor_id));
  S.audit(ctx, 'task.create', 'task:' + id);
  return { id };
});
function taskOf(ctx, id) { const t = q.get('SELECT * FROM tasks WHERE id=? AND company_id=?', id, cid(ctx)); if (!t) throw httpError(404, 'Задание не найдено'); return t; }
function assignTask(ctx, taskId, k) {
  const t = taskOf(ctx, taskId);
  q.run(`UPDATE tasks SET status='in_progress', contractor_id=? WHERE id=?`, k.id, t.id);
  if (!q.get(`SELECT id FROM documents WHERE contractor_id=? AND type IN ('contract','custom') AND status<>'revoked'`, k.id)) L.createDocument(cid(ctx), { contractor_id: k.id }, 'contract', { subject: t.category });
  L.createDocument(cid(ctx), { contractor_id: k.id }, 'task_order', { subject: t.title + (t.description ? '. ' + t.description : ''), amount: t.budget, until: t.deadline, task_id: t.id });
  if (k.user_id) notify({ user_id: k.user_id, kind: 'task', text: `Вас выбрали исполнителем задания «${t.title}»` });
}
R.get('/api/tasks/:id', { auth: 'company', perm: 'view' }, async (ctx) => {
  const t = taskOf(ctx, ctx.params.id);
  return { task: t, responses: q.all(`SELECT r.*, u.name, u.email FROM responses r JOIN users u ON u.id=r.user_id WHERE r.task_id=? ORDER BY r.id`, t.id) };
});
R.post('/api/tasks/:id/assign', { auth: 'company', perm: 'tasks' }, async (ctx) => {
  const t = taskOf(ctx, ctx.params.id);
  if (t.status !== 'open') throw httpError(409, 'Исполнитель уже выбран');
  let k;
  if (ctx.body.response_id) {
    const r = q.get('SELECT * FROM responses WHERE id=? AND task_id=?', ctx.body.response_id, t.id);
    if (!r) throw httpError(404, 'Отклик не найден');
    const u = q.get('SELECT * FROM users WHERE id=?', r.user_id);
    k = q.get('SELECT * FROM contractors WHERE company_id=? AND user_id=?', cid(ctx), u.id);
    if (!k) {
      const prof = q.get('SELECT * FROM contractors WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id) || JSON.parse(u.profile || '{}');
      const id = Number(q.run(`INSERT INTO contractors (company_id,user_id,type,full_name,inn,phone,email,card,specialty,npd_status,npd_checked_at,npd_source,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active')`,
        cid(ctx), u.id, prof.type || 'npd', prof.full_name || u.name || u.email, prof.inn || null, u.phone || '', u.email, prof.card || null, prof.specialty || null, prof.npd_status || 'unknown', prof.npd_checked_at || null, prof.npd_source || null).lastInsertRowid);
      k = q.get('SELECT * FROM contractors WHERE id=?', id);
    }
    if (r.price) q.run('UPDATE tasks SET budget=? WHERE id=?', K(r.price), t.id);
    q.run(`UPDATE responses SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE task_id=?`, r.id, t.id);
  } else k = contractorOf(ctx, ctx.body.contractor_id);
  assignTask(ctx, t.id, k);
  S.audit(ctx, 'task.assign', 'task:' + t.id, { contractor_id: k.id });
  return { ok: true };
});
R.post('/api/tasks/:id/accept', { auth: 'company', perm: 'tasks' }, async (ctx) => {
  const t = taskOf(ctx, ctx.params.id);
  if (!['in_progress', 'review'].includes(t.status)) throw httpError(409, 'Задание нельзя принять в текущем статусе');
  const k = q.get('SELECT * FROM contractors WHERE id=?', t.contractor_id);
  const c = q.get('SELECT * FROM companies WHERE id=?', cid(ctx));
  const contract = q.get(`SELECT number FROM documents WHERE contractor_id=? AND type='contract' ORDER BY id DESC LIMIT 1`, k.id);
  const { actId, pid } = q.tx(() => {
    if (q.run(`UPDATE tasks SET status='done' WHERE id=? AND status IN ('in_progress','review')`, t.id).changes !== 1) throw httpError(409, 'Задание уже принято');
    const actId = L.createDocument(c.id, { contractor_id: k.id }, 'act', { subject: t.title, amount: t.budget, contract: contract && contract.number, task_id: t.id });
    const pid = svc.createPayout(c, k, t.budget, { task_id: t.id, purpose: `Оплата по заданию «${t.title}»`, created_by: ctx.user.id });
    return { actId, pid };
  });
  S.audit(ctx, 'task.accept', 'task:' + t.id, { act: actId, payout: pid });
  return { act_id: actId, payout_id: pid };
});
R.post('/api/tasks/:id/cancel', { auth: 'company', perm: 'tasks' }, async (ctx) => {
  const ch = q.run(`UPDATE tasks SET status='cancelled' WHERE id=? AND company_id=? AND status IN ('open','in_progress')`, ctx.params.id, cid(ctx)).changes;
  if (!ch) throw httpError(409, 'Задание нельзя отменить');
  return { ok: true };
});

/* ================= подбор персонала ================= */
R.get('/api/outstaff', { auth: 'company', perm: 'view' }, async (ctx) => ({ requests: q.all('SELECT * FROM outstaff WHERE company_id=? ORDER BY id DESC', cid(ctx)) }));
R.post('/api/outstaff', { auth: 'company', perm: 'outstaff' }, async (ctx) => {
  const b = ctx.body;
  const id = q.run('INSERT INTO outstaff (company_id,role,headcount,start_date,duration,rate,city,description) VALUES (?,?,?,?,?,?,?,?)',
    cid(ctx), need(b.role, 'Укажите специальность').slice(0, 120), Math.min(500, Math.max(1, Number(b.headcount) || 1)), str(b.start_date, 10) || null, str(b.duration, 60), str(b.rate, 60), str(b.city, 120), str(b.description, 3000)).lastInsertRowid;
  notify({ company_id: cid(ctx), kind: 'outstaff', text: `Заявка на подбор «${b.role}» принята. Менеджер свяжется в течение 2 часов.` });
  S.audit(ctx, 'outstaff.create', 'outstaff:' + id);
  return { ok: true };
});

/* ================= сплит-платежи ================= */
R.get('/api/splits', { auth: 'company', perm: 'view' }, async (ctx) => ({
  splits: q.all('SELECT * FROM splits WHERE company_id=? ORDER BY id DESC', cid(ctx)).map((s) => ({ ...s, parts: q.all('SELECT sp.*, k.full_name FROM split_parts sp JOIN contractors k ON k.id=sp.contractor_id WHERE split_id=?', s.id) })),
}));
R.post('/api/splits', { auth: 'company', perm: 'splits' }, async (ctx) => {
  const b = ctx.body; const parts = Array.isArray(b.parts) ? b.parts.slice(0, 50) : [];
  if (!parts.length) throw httpError(400, 'Добавьте получателей');
  const totalShare = parts.reduce((s, p) => s + Number(p.share_pct || 0), 0);
  if (Math.abs(totalShare - 100) > 0.01) throw httpError(400, `Сумма долей должна быть 100% (сейчас ${totalShare}%)`);
  if (new Set(parts.map((p) => p.contractor_id)).size !== parts.length) throw httpError(400, 'Получатели повторяются');
  const fee = Number(b.agency_fee_pct ?? 10); if (!(fee >= 0 && fee < 100)) throw httpError(400, 'Агентское вознаграждение 0–99%');
  const t = S.token(12);
  const id = q.tx(() => {
    const id = Number(q.run('INSERT INTO splits (company_id,title,amount,agency_fee_pct,token) VALUES (?,?,?,?,?)', cid(ctx), need(b.title, 'Укажите назначение').slice(0, 200), K(num(b.amount, 'Укажите сумму', 10e6)), fee, t).lastInsertRowid);
    for (const p of parts) { contractorOf(ctx, p.contractor_id); q.run('INSERT INTO split_parts (split_id,contractor_id,share_pct) VALUES (?,?,?)', id, p.contractor_id, Number(p.share_pct)); }
    return id;
  });
  S.audit(ctx, 'split.create', 'split:' + id);
  return { id, token: t, url: `/pay/${t}` };
});
