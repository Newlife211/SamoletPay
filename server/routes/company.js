'use strict';
const { q, K } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const mailer = require('../mailer');
const { R, need, num, str } = require('../http');
const { httpError, notify } = L;

const DEMO = process.env.DEMO_MODE !== '0';
const cid = (ctx) => ctx.user.company_id;
const company = (ctx) => q.get('SELECT * FROM companies WHERE id=?', cid(ctx));
const publicCompany = (c) => { const { webhook_secret, ...rest } = c; return rest; };

R.get('/api/dashboard', { auth: 'company', perm: 'view' }, async (ctx) => {
  const id = cid(ctx);
  const n = (sql) => q.get(sql, id).n || 0;
  const m = (sql) => q.get(sql, id).total || 0;
  return {
    company: publicCompany(company(ctx)),
    stats: {
      contractors: n('SELECT COUNT(*) n FROM contractors WHERE company_id=?'),
      activeNpd: n(`SELECT COUNT(*) n FROM contractors WHERE company_id=? AND type='npd' AND npd_status='active'`),
      paidMonth: m(`SELECT SUM(amount) total FROM payouts WHERE company_id=? AND status='paid' AND created_at >= date('now','start of month')`),
      paidTotal: m(`SELECT SUM(amount) total FROM payouts WHERE company_id=? AND status='paid'`),
      docsToSign: n(`SELECT COUNT(*) n FROM documents WHERE company_id=? AND status IN ('sent','signed_contractor') AND type<>'kedo_consent'`),
      docsWaiting: n(`SELECT COUNT(*) n FROM documents WHERE company_id=? AND status='signed_company'`),
      openTasks: n(`SELECT COUNT(*) n FROM tasks WHERE company_id=? AND status IN ('open','in_progress','review')`),
      review: n(`SELECT COUNT(*) n FROM tasks WHERE company_id=? AND status='review'`),
      drafts: n(`SELECT COUNT(*) n FROM payouts WHERE company_id=? AND status='draft'`),
      employees: n('SELECT COUNT(*) n FROM employees WHERE company_id=?'),
    },
    monthly: q.all(`SELECT strftime('%Y-%m', created_at) m, SUM(amount) total, COUNT(*) n FROM payouts WHERE company_id=? AND status='paid' AND created_at > datetime('now','-6 month') GROUP BY m ORDER BY m`, id),
    recent: q.all(`SELECT p.*, k.full_name FROM payouts p JOIN contractors k ON k.id=p.contractor_id WHERE p.company_id=? ORDER BY p.id DESC LIMIT 6`, id),
    risky: q.all(`SELECT id, full_name, npd_status FROM contractors WHERE company_id=? AND type='npd' AND npd_status<>'active' LIMIT 5`, id),
  };
});

R.get('/api/company', { auth: 'company', perm: 'view' }, async (ctx) => ({ company: publicCompany(company(ctx)), plans: L.PLANS }));
R.put('/api/company', { auth: 'company', perm: 'settings' }, async (ctx) => {
  const b = ctx.body;
  if (b.inn && !L.validInn(String(b.inn))) throw httpError(400, 'Некорректный ИНН');
  if (b.sign_method && !['sms', 'gosklyuch'].includes(b.sign_method)) throw httpError(400, 'Неизвестный способ подписи');
  if (b.brand_color && !/^#[0-9a-fA-F]{6}$/.test(b.brand_color)) throw httpError(400, 'Цвет в формате #RRGGBB');
  if (b.brand_name && company(ctx).plan !== 'enterprise') throw httpError(403, 'White Label доступен на тарифе «Корпорация»');
  const fields = ['name', 'inn', 'kpp', 'ogrn', 'address', 'bank', 'bik', 'account', 'director', 'notify_emails', 'brand_name', 'brand_color', 'sign_method'];
  const changed = {};
  for (const k of fields) if (k in b) { q.run(`UPDATE companies SET ${k}=? WHERE id=?`, str(b[k], 300) || null, cid(ctx)); changed[k] = true; }
  if ('tax_service' in b) { q.run('UPDATE companies SET tax_service=? WHERE id=?', b.tax_service ? 1 : 0, cid(ctx)); changed.tax_service = !!b.tax_service; }
  S.audit(ctx, 'company.update', 'company', Object.keys(changed));
  return { company: publicCompany(company(ctx)) };
});
R.post('/api/company/plan', { auth: 'company', perm: 'settings' }, async (ctx) => {
  if (!L.PLANS[ctx.body.plan]) throw httpError(400, 'Неизвестный тариф');
  q.run('UPDATE companies SET plan=? WHERE id=?', ctx.body.plan, cid(ctx));
  if (ctx.body.plan !== 'enterprise') q.run('UPDATE companies SET brand_name=NULL WHERE id=?', cid(ctx));
  notify({ company_id: cid(ctx), text: `Тариф изменён на «${L.PLANS[ctx.body.plan].name}»` });
  S.audit(ctx, 'company.plan', 'company', { plan: ctx.body.plan });
  return { ok: true };
});

/* ---------- баланс ---------- */
R.get('/api/balance', { auth: 'company', perm: 'balance' }, async (ctx) => ({
  balance: company(ctx).balance,
  transactions: q.all('SELECT * FROM transactions WHERE company_id=? ORDER BY id DESC LIMIT 300', cid(ctx)),
  invoices: q.all('SELECT * FROM invoices WHERE company_id=? ORDER BY id DESC', cid(ctx)),
  demo: DEMO,
}));
R.post('/api/invoices', { auth: 'company', perm: 'balance' }, async (ctx) => {
  const amount = num(ctx.body.amount, 'Укажите сумму от 1 000 ₽', 1e9); if (amount < 1000) throw httpError(400, 'Минимальная сумма пополнения — 1 000 ₽');
  const n = q.get('SELECT COUNT(*) n FROM invoices WHERE company_id=?', cid(ctx)).n + 1;
  const id = q.run('INSERT INTO invoices (company_id,number,amount) VALUES (?,?,?)', cid(ctx), `СЧ-${cid(ctx)}-${String(n).padStart(4, '0')}`, K(amount)).lastInsertRowid;
  S.audit(ctx, 'invoice.create', 'invoice:' + id, { amount });
  return { id: Number(id) };
});
// Боевой режим: зачисление по выписке банка (см. /api/admin/invoices/:id/confirm). В демо — кнопка в кабинете.
function confirmInvoice(inv, actorCtx) {
  q.tx(() => {
    if (q.run(`UPDATE invoices SET status='paid' WHERE id=? AND status='issued'`, inv.id).changes !== 1) throw httpError(409, 'Счёт уже оплачен');
    q.run('UPDATE companies SET balance=balance+? WHERE id=?', K(inv.amount), inv.company_id);
    q.run('INSERT INTO transactions (company_id,type,amount,description,ref) VALUES (?,?,?,?,?)', inv.company_id, 'topup', K(inv.amount), `Пополнение по счёту ${inv.number}`, 'inv:' + inv.id);
  });
  notify({ company_id: inv.company_id, kind: 'balance', text: `Баланс пополнен на ${L.fmtMoney(inv.amount)}` });
  S.audit(actorCtx, 'invoice.paid', 'invoice:' + inv.id, { amount: inv.amount });
}
R.post('/api/invoices/:id/pay', { auth: 'company', perm: 'balance' }, async (ctx) => {
  if (!DEMO) throw httpError(403, 'Пополнение зачисляется автоматически по выписке банка');
  const inv = q.get('SELECT * FROM invoices WHERE id=? AND company_id=?', ctx.params.id, cid(ctx));
  if (!inv) throw httpError(404, 'Счёт не найден');
  confirmInvoice(inv, ctx);
  return { ok: true };
});

/* ---------- интеграции ---------- */
R.get('/api/integrations', { auth: 'company', perm: 'settings' }, async (ctx) => {
  const c = company(ctx);
  return {
    keys: q.all('SELECT id,title,prefix,last4,last_used_at,created_at FROM api_keys WHERE company_id=? ORDER BY id DESC', cid(ctx)),
    webhook_url: c.webhook_url, webhook_secret_hint: c.webhook_secret ? c.webhook_secret.slice(0, 6) + '…' : null,
    logs: q.all('SELECT * FROM webhook_logs WHERE company_id=? ORDER BY id DESC LIMIT 30', cid(ctx)),
  };
});
R.post('/api/integrations/keys', { auth: 'company', perm: 'settings' }, async (ctx) => {
  const k = S.newApiKey();
  const id = q.run('INSERT INTO api_keys (company_id,title,key_hash,prefix,last4) VALUES (?,?,?,?,?)', cid(ctx), str(ctx.body.title, 80) || 'Ключ API', k.hash, k.prefix, k.last4).lastInsertRowid;
  S.audit(ctx, 'apikey.create', 'apikey:' + id);
  return { key: k.key };
});
R.del('/api/integrations/keys/:id', { auth: 'company', perm: 'settings' }, async (ctx) => {
  q.run('DELETE FROM api_keys WHERE id=? AND company_id=?', ctx.params.id, cid(ctx));
  S.audit(ctx, 'apikey.revoke', 'apikey:' + ctx.params.id);
  return { ok: true };
});
R.put('/api/integrations/webhook', { auth: 'company', perm: 'settings' }, async (ctx) => {
  const url = str(ctx.body.url, 500);
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw httpError(400, 'URL должен начинаться с http(s)://');
  if (url && process.env.DEMO_MODE === '0' && !url.startsWith('https://')) throw httpError(400, 'В боевом режиме допускается только https');
  q.run('UPDATE companies SET webhook_url=?, webhook_secret=COALESCE(webhook_secret, ?) WHERE id=?', url || null, S.token(24), cid(ctx));
  S.audit(ctx, 'webhook.update', null, { url });
  return { ok: true };
});
R.post('/api/integrations/webhook/secret', { auth: 'company', perm: 'settings' }, async (ctx) => {
  const secret = S.token(24);
  q.run('UPDATE companies SET webhook_secret=? WHERE id=?', secret, cid(ctx));
  S.audit(ctx, 'webhook.secret_rotate');
  return { secret };
});
R.post('/api/integrations/webhook/test', { auth: 'company', perm: 'settings', limit: [10, 60e3] }, async (ctx) => { svc.webhook(cid(ctx), 'test', { hello: 'world' }); return { ok: true }; });

/* ---------- команда ---------- */
R.get('/api/team', { auth: 'company', perm: 'view' }, async (ctx) => ({
  users: q.all('SELECT id,email,name,phone,team_role,totp_enabled,blocked,created_at FROM users WHERE company_id=?', cid(ctx)),
  roles: S.ROLE_NAMES, perms: S.PERMS,
}));
R.post('/api/team', { auth: 'company', perm: 'team' }, async (ctx) => {
  const email = need(ctx.body.email, 'Укажите email').toLowerCase();
  if (q.get('SELECT id FROM users WHERE email=?', email)) throw httpError(409, 'Пользователь уже существует');
  const role = S.ROLE_NAMES[ctx.body.team_role] ? ctx.body.team_role : 'manager';
  const pass = S.token(4) + 'A1';
  const { hash, salt } = S.hashPassword(pass);
  const id = q.run(`INSERT INTO users (email,name,pass_hash,salt,role,company_id,team_role) VALUES (?,?,?,?, 'company', ?,?)`, email, str(ctx.body.name, 120), hash, salt, cid(ctx), role).lastInsertRowid;
  const t = S.issueUserToken(Number(id), 'reset', 72);
  mailer.email(email, `Приглашение в ${L.BRAND}`, `${ctx.user.name || ctx.user.email} пригласил(а) вас в кабинет компании. Задайте пароль по ссылке (действует 72 часа):\n${mailer.APP_URL}/app#/reset?token=${t}`);
  S.audit(ctx, 'team.invite', 'user:' + id, { email, role });
  return { email, invite_link: DEMO ? '/app#/reset?token=' + t : undefined };
});
R.put('/api/team/:id', { auth: 'company', perm: 'team' }, async (ctx) => {
  const u = q.get('SELECT * FROM users WHERE id=? AND company_id=?', ctx.params.id, cid(ctx));
  if (!u) throw httpError(404, 'Сотрудник не найден');
  if (u.id === ctx.user.id) throw httpError(400, 'Нельзя изменить собственную роль');
  if ('team_role' in ctx.body) {
    if (!S.ROLE_NAMES[ctx.body.team_role]) throw httpError(400, 'Неизвестная роль');
    q.run('UPDATE users SET team_role=? WHERE id=?', ctx.body.team_role, u.id);
  }
  if ('blocked' in ctx.body) { q.run('UPDATE users SET blocked=? WHERE id=?', ctx.body.blocked ? 1 : 0, u.id); if (ctx.body.blocked) q.run('DELETE FROM sessions WHERE user_id=?', u.id); }
  S.audit(ctx, 'team.update', 'user:' + u.id, ctx.body);
  return { ok: true };
});

/* ---------- журнал действий ---------- */
R.get('/api/audit', { auth: 'company', perm: 'audit' }, async (ctx) => ({
  items: q.all('SELECT id,actor,action,entity,details,ip,created_at FROM audit_log WHERE company_id=? ORDER BY id DESC LIMIT 300', cid(ctx)),
}));

module.exports = { confirmInvoice };
