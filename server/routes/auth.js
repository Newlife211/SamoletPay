'use strict';
const { q } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const mailer = require('../mailer');
const { R, need, setSessionCookie, clearSessionCookie, parseCookies } = require('../http');
const { httpError, notify } = L;

const DEMO = process.env.DEMO_MODE !== '0';
const startSession = (ctx, userId, pending2fa = false) => {
  const t = S.createSession(userId, { ip: ctx.ip, ua: ctx.req.headers['user-agent'], pending2fa });
  setSessionCookie(ctx.res, t, pending2fa ? 600 : S.SESSION_DAYS * 86400);
};
const emailKey = (ctx) => ctx.ip + ':' + String(ctx.body && ctx.body.email || '').toLowerCase();

function sendVerify(user) {
  const t = S.issueUserToken(user.id, 'verify', 72);
  const [s, b] = mailer.T.verify(`${mailer.APP_URL}/app#/verify-email?token=${t}`);
  mailer.email(user.email, s, b);
  return t;
}

R.post('/api/auth/register', { auth: null, limit: [10, 3600e3] }, async (ctx) => {
  const b = ctx.body;
  const email = need(b.email, 'Укажите email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Некорректный email');
  const pp = S.passwordProblem(b.password); if (pp) throw httpError(400, pp);
  if (q.get('SELECT id FROM users WHERE email=?', email)) throw httpError(409, 'Пользователь с таким email уже есть');
  const role = b.role === 'contractor' ? 'contractor' : 'company';
  const { hash, salt } = S.hashPassword(b.password);
  const user = q.tx(() => {
    let companyId = null;
    if (role === 'company') {
      const name = need(b.company_name, 'Укажите название компании').slice(0, 200);
      if (b.inn && !L.validInn(String(b.inn))) throw httpError(400, 'Некорректный ИНН компании');
      companyId = Number(q.run('INSERT INTO companies (name, inn, webhook_secret) VALUES (?,?,?)', name, b.inn || null, S.token(24)).lastInsertRowid);
    }
    const id = Number(q.run('INSERT INTO users (email,phone,name,pass_hash,salt,role,company_id) VALUES (?,?,?,?,?,?,?)',
      email, String(b.phone || '').trim() || null, String(b.name || '').slice(0, 120) || null, hash, salt, role, companyId).lastInsertRowid);
    return q.get('SELECT * FROM users WHERE id=?', id);
  });
  if (role === 'contractor') svc.linkContractorUser(user);
  else notify({ company_id: user.company_id, kind: 'info', text: 'Добро пожаловать! Пополните баланс и добавьте первых исполнителей.' });
  sendVerify(user);
  S.audit({ user, ip: ctx.ip }, 'auth.register');
  startSession(ctx, user.id);
  return { ok: true, role };
});

R.post('/api/auth/login', { auth: null, limit: [10, 15 * 60e3, emailKey] }, async (ctx) => {
  const u = q.get('SELECT * FROM users WHERE email=?', String(ctx.body.email || '').toLowerCase().trim());
  if (!u || !S.checkPassword(String(ctx.body.password || ''), u.salt, u.pass_hash)) throw httpError(401, 'Неверный email или пароль');
  if (u.blocked) throw httpError(403, 'Учётная запись заблокирована');
  if (u.totp_enabled) { startSession(ctx, u.id, true); return { ok: true, need2fa: true }; }
  startSession(ctx, u.id);
  S.audit({ user: u, ip: ctx.ip }, 'auth.login');
  return { ok: true, role: u.role };
});
R.post('/api/auth/2fa', { auth: 'any', allowPending: true, limit: [6, 10 * 60e3, (c) => parseCookies(c.req).sid || c.ip] }, async (ctx) => {
  const s = ctx.user._session;
  if (!s.pending_2fa) return { ok: true, role: ctx.user.role };
  if (!S.totpVerify(ctx.user.totp_secret, ctx.body.code)) throw httpError(400, 'Неверный код из приложения');
  q.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash);
  startSession(ctx, ctx.user.id);
  S.audit(ctx, 'auth.login', null, { twofa: true });
  return { ok: true, role: ctx.user.role };
});
R.post('/api/auth/logout', { auth: 'any', allowPending: true }, async (ctx) => {
  q.run('DELETE FROM sessions WHERE token_hash=?', ctx.user._session.token_hash);
  clearSessionCookie(ctx.res);
  return { ok: true };
});
R.post('/api/auth/logout-all', 'any', async (ctx) => {
  const n = q.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', ctx.user.id, ctx.user._session.token_hash).changes;
  S.audit(ctx, 'auth.logout_all', null, { sessions: n });
  return { ok: true, closed: n };
});
R.get('/api/auth/sessions', 'any', async (ctx) => ({
  sessions: q.all(`SELECT token_hash, ip, ua, created_at, last_seen FROM sessions WHERE user_id=? AND pending_2fa=0 AND expires_at > datetime('now') ORDER BY last_seen DESC`, ctx.user.id)
    .map((s) => ({ id: s.token_hash.slice(0, 16), ip: s.ip, ua: s.ua, created_at: s.created_at, last_seen: s.last_seen, current: s.token_hash === ctx.user._session.token_hash })),
}));
R.del('/api/auth/sessions/:id', 'any', async (ctx) => {
  q.run(`DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,16)=? AND token_hash<>?`, ctx.user.id, ctx.params.id, ctx.user._session.token_hash);
  return { ok: true };
});

R.get('/api/me', 'any', async (ctx) => {
  const u = ctx.user;
  const unread = q.get('SELECT COUNT(*) n FROM notifications WHERE is_read=0 AND (user_id=? OR company_id=?)', u.id, u.company_id || -1).n;
  const company = u.company_id ? q.get('SELECT id,name,inn,balance,plan,brand_name,brand_color,sign_method,blocked FROM companies WHERE id=?', u.company_id) : null;
  return {
    id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, team_role: u.team_role, email_verified: !!u.email_verified, totp_enabled: !!u.totp_enabled,
    perms: u.role === 'company' ? S.PERMS[u.team_role] || [] : [], company, unread, brand: L.BRAND, demo: DEMO,
  };
});

/* ---------- пароль ---------- */
R.post('/api/auth/password/forgot', { auth: null, limit: [5, 3600e3] }, async (ctx) => {
  const u = q.get('SELECT * FROM users WHERE email=?', String(ctx.body.email || '').toLowerCase().trim());
  let demoLink;
  if (u && !u.blocked) {
    const t = S.issueUserToken(u.id, 'reset', 1);
    const link = `${mailer.APP_URL}/app#/reset?token=${t}`;
    const [s, b] = mailer.T.reset(link); mailer.email(u.email, s, b);
    if (DEMO) demoLink = '/app#/reset?token=' + t;
  }
  // одинаковый ответ, чтобы нельзя было узнать, зарегистрирован ли email
  return { ok: true, demo_link: demoLink };
});
R.post('/api/auth/password/reset', { auth: null, limit: [10, 3600e3] }, async (ctx) => {
  const pp = S.passwordProblem(ctx.body.password); if (pp) throw httpError(400, pp);
  const userId = S.consumeUserToken(ctx.body.token, 'reset');
  if (!userId) throw httpError(400, 'Ссылка недействительна или устарела');
  const { hash, salt } = S.hashPassword(ctx.body.password);
  q.run('UPDATE users SET pass_hash=?, salt=?, email_verified=1 WHERE id=?', hash, salt, userId);
  q.run('DELETE FROM sessions WHERE user_id=?', userId); // выход на всех устройствах
  S.audit({ user: q.get('SELECT * FROM users WHERE id=?', userId), ip: ctx.ip }, 'auth.password_reset');
  return { ok: true };
});
R.post('/api/auth/password/change', { auth: 'any', limit: [10, 3600e3] }, async (ctx) => {
  if (!S.checkPassword(String(ctx.body.current || ''), ctx.user.salt, ctx.user.pass_hash)) throw httpError(400, 'Текущий пароль указан неверно');
  const pp = S.passwordProblem(ctx.body.password); if (pp) throw httpError(400, pp);
  const { hash, salt } = S.hashPassword(ctx.body.password);
  q.run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash, salt, ctx.user.id);
  q.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', ctx.user.id, ctx.user._session.token_hash);
  S.audit(ctx, 'auth.password_change');
  return { ok: true };
});

/* ---------- email ---------- */
R.post('/api/auth/email/verify-request', { auth: 'any', limit: [3, 3600e3, (c) => 'v' + (c.user ? c.user.id : c.ip)] }, async (ctx) => {
  if (ctx.user.email_verified) return { ok: true };
  const t = sendVerify(ctx.user);
  return { ok: true, demo_link: DEMO ? '/app#/verify-email?token=' + t : undefined };
});
R.post('/api/auth/email/verify', { auth: null, limit: [20, 3600e3] }, async (ctx) => {
  const userId = S.consumeUserToken(ctx.body.token, 'verify');
  if (!userId) throw httpError(400, 'Ссылка недействительна или устарела');
  q.run('UPDATE users SET email_verified=1 WHERE id=?', userId);
  return { ok: true };
});

/* ---------- двухфакторная аутентификация ---------- */
R.post('/api/auth/2fa/setup', 'any', async (ctx) => {
  if (ctx.user.totp_enabled) throw httpError(409, '2FA уже включена');
  const secret = S.totpSecret();
  q.run('UPDATE users SET totp_secret=? WHERE id=?', secret, ctx.user.id);
  const label = encodeURIComponent(`${L.BRAND}:${ctx.user.email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(L.BRAND)}&digits=6&period=30` };
});
R.post('/api/auth/2fa/enable', { auth: 'any', limit: [10, 10 * 60e3, (c) => 'e' + c.user?.id] }, async (ctx) => {
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!u.totp_secret || !S.totpVerify(u.totp_secret, ctx.body.code)) throw httpError(400, 'Неверный код. Проверьте время на телефоне.');
  q.run('UPDATE users SET totp_enabled=1 WHERE id=?', u.id);
  S.audit(ctx, 'auth.2fa_enabled');
  return { ok: true };
});
R.post('/api/auth/2fa/disable', { auth: 'any', limit: [10, 10 * 60e3, (c) => 'd' + c.user?.id] }, async (ctx) => {
  if (!S.checkPassword(String(ctx.body.password || ''), ctx.user.salt, ctx.user.pass_hash)) throw httpError(400, 'Неверный пароль');
  if (!S.totpVerify(ctx.user.totp_secret, ctx.body.code)) throw httpError(400, 'Неверный код');
  q.run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', ctx.user.id);
  S.audit(ctx, 'auth.2fa_disabled');
  return { ok: true };
});

/* ---------- уведомления ---------- */
R.get('/api/notifications', 'any', async (ctx) => ({ items: q.all('SELECT * FROM notifications WHERE user_id=? OR company_id=? ORDER BY id DESC LIMIT 100', ctx.user.id, ctx.user.company_id || -1) }));
R.post('/api/notifications/read', 'any', async (ctx) => { q.run('UPDATE notifications SET is_read=1 WHERE user_id=? OR company_id=?', ctx.user.id, ctx.user.company_id || -1); return { ok: true }; });
