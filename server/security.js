'use strict';
const crypto = require('node:crypto');
const { q } = require('./db');

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const token = (n = 24) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- пароли ---------- */
function hashPassword(pass, salt = token(16)) {
  return { hash: crypto.scryptSync(pass, salt, 64).toString('hex'), salt };
}
function checkPassword(pass, salt, hash) {
  const h = crypto.scryptSync(String(pass), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'Пароль — минимум 8 символов';
  if (!/\d/.test(p) || !/[A-Za-zА-Яа-яЁё]/.test(p)) return 'Пароль должен содержать буквы и цифры';
  if (/^(12345678|password1|qwerty123)$/i.test(p)) return 'Слишком простой пароль';
  return null;
}

/* ---------- ограничение частоты (скользящее окно в памяти) ----------
   Для нескольких инстансов заменить на Redis; интерфейс тот же. */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return { ok: b.n <= limit, retryAfter: Math.ceil((b.reset - now) / 1000), left: Math.max(0, limit - b.n) };
}
function resetLimit(key) { buckets.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60e3).unref();

/* ---------- TOTP (RFC 6238), совместим с Google Authenticator / Яндекс Ключ ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  s = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const totpSecret = () => base32Encode(crypto.randomBytes(20));
function totpNow(secret, t = Date.now()) { return hotp(secret, Math.floor(t / 30000)); }
function totpVerify(secret, code, t = Date.now()) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const c = Math.floor(t / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(hotp(secret, c + d)), Buffer.from(code)));
}

/* ---------- сессии: в cookie токен, в БД — только хеш ---------- */
function createSession(userId, { ip, ua, pending2fa = false } = {}) {
  const t = token(32);
  const ttl = pending2fa ? "'+10 minutes'" : `'+${SESSION_DAYS} days'`;
  q.run(`INSERT INTO sessions (token_hash,user_id,ip,ua,pending_2fa,expires_at) VALUES (?,?,?,?,?,datetime('now',${ttl}))`, sha256(t), userId, ip || null, (ua || '').slice(0, 200), pending2fa ? 1 : 0);
  return t;
}
function sessionByToken(t) {
  if (!t) return null;
  const s = q.get(`SELECT s.*, u.blocked FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > datetime('now')`, sha256(t));
  if (!s || s.blocked) return null;
  // скользящее продление не чаще раза в час
  q.run(`UPDATE sessions SET last_seen=datetime('now') WHERE token_hash=? AND last_seen < datetime('now','-1 hour')`, s.token_hash);
  return s;
}
const cleanupSessions = () => q.run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).changes;

/* ---------- одноразовые токены (сброс пароля, подтверждение email) ---------- */
function issueUserToken(userId, kind, hours) {
  const t = token(24);
  q.run(`INSERT INTO user_tokens (token_hash,user_id,kind,expires_at) VALUES (?,?,?,datetime('now',?))`, sha256(t), userId, kind, `+${hours} hours`);
  return t;
}
function consumeUserToken(t, kind) {
  const r = q.get(`SELECT * FROM user_tokens WHERE token_hash=? AND kind=? AND used=0 AND expires_at > datetime('now')`, sha256(t || ''), kind);
  if (!r) return null;
  q.run('UPDATE user_tokens SET used=1 WHERE token_hash=?', r.token_hash);
  return r.user_id;
}

/* ---------- API-ключи: хранится только SHA-256 ---------- */
function newApiKey() { const key = 'po_live_' + token(20); return { key, hash: sha256(key), prefix: key.slice(0, 12), last4: key.slice(-4) }; }

/* ---------- HMAC подпись вебхуков ---------- */
function signWebhook(secret, body, ts) { return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'); }

/* ---------- роли в команде ---------- */
const PERMS = {
  owner: ['*'],
  accountant: ['view', 'contractors', 'documents', 'sign', 'payouts', 'payouts.send', 'balance', 'splits', 'export', 'employees', 'audit'],
  manager: ['view', 'contractors', 'documents', 'payouts', 'tasks', 'outstaff', 'splits', 'employees'],
};
const ROLE_NAMES = { owner: 'Владелец', accountant: 'Бухгалтер', manager: 'Менеджер' };
function can(user, perm) {
  if (!user || user.role !== 'company') return false;
  const p = PERMS[user.team_role] || [];
  return p.includes('*') || p.includes(perm);
}

/* ---------- журнал действий ---------- */
function audit(ctx, action, entity = null, details = null) {
  const u = ctx && ctx.user;
  q.run('INSERT INTO audit_log (company_id,user_id,actor,action,entity,details,ip) VALUES (?,?,?,?,?,?,?)',
    u ? u.company_id || null : null, u ? u.id || null : null, u ? (u.email || (u.api ? 'API' : null)) : 'system',
    action, entity, details ? JSON.stringify(details).slice(0, 2000) : null, ctx && ctx.ip || null);
}

module.exports = {
  token, sha256, hashPassword, checkPassword, passwordProblem, rateLimit, resetLimit,
  totpSecret, totpNow, totpVerify, base32Encode, createSession, sessionByToken, cleanupSessions,
  issueUserToken, consumeUserToken, newApiKey, signWebhook, PERMS, ROLE_NAMES, can, audit, SESSION_DAYS,
};
