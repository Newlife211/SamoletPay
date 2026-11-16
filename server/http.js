'use strict';
const { q } = require('./db');
const S = require('./security');
const { httpError } = require('./logic');

const routes = [];
/**
 * route(method, pattern, opts, handler)
 * opts.auth: null | 'any' | 'company' | 'contractor' | 'admin' | 'api'
 * opts.perm: право в команде (см. security.PERMS)
 * opts.limit: [лимит, окноМс, ключ?] — ограничение частоты
 */
function route(method, pattern, opts, handler) {
  if (typeof opts === 'string' || opts === null) opts = { auth: opts };
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, ...opts, handler });
}
const R = {
  get: (p, o, h) => route('GET', p, o, h), post: (p, o, h) => route('POST', p, o, h),
  put: (p, o, h) => route('PUT', p, o, h), del: (p, o, h) => route('DELETE', p, o, h),
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    // Cloudflare Tunnel / CDN передаёт реальный IP в CF-Connecting-IP, nginx/Caddy — в X-Forwarded-For
    const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) return String(ip);
  }
  return req.socket.remoteAddress || '';
}
const SECURE = process.env.COOKIE_SECURE === '1';
function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`);
}
function clearSessionCookie(res) { res.setHeader('Set-Cookie', `sid=; Path=/; Max-Age=0${SECURE ? '; Secure' : ''}`); }

/** Пользователь по cookie. allowPending — для шага ввода кода 2FA. */
function sessionUser(req, allowPending = false) {
  const s = S.sessionByToken(parseCookies(req).sid);
  if (!s || (s.pending_2fa && !allowPending)) return null;
  const u = q.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) return null;
  u._session = s;
  return u;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(httpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(httpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, data, headers = {}) {
  const isStr = typeof data === 'string';
  res.writeHead(status, { 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? data : JSON.stringify(data));
}

/* ---------- валидация ---------- */
const need = (v, msg) => { if (v === undefined || v === null || String(v).trim() === '') throw httpError(400, msg); return typeof v === 'string' ? v.trim() : v; };
const num = (v, msg, max = 1e9) => { const n = Number(v); if (!isFinite(n) || n <= 0 || n > max) throw httpError(400, msg); return Math.round(n * 100) / 100; };
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function apiUser(req) {
  const key = String(req.headers['x-api-key'] || '');
  const k = key && q.get('SELECT * FROM api_keys WHERE key_hash=?', S.sha256(key));
  if (!k) throw httpError(401, 'Неверный X-Api-Key');
  q.run(`UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?`, k.id);
  const owner = q.get(`SELECT * FROM users WHERE company_id=? AND team_role='owner' LIMIT 1`, k.company_id);
  return { ...owner, company_id: k.company_id, team_role: 'owner', api: true, email: 'API:' + (k.title || k.prefix) };
}

async function dispatch(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) throw httpError(404, 'Метод не найден');
  const m = url.pathname.match(r.re);
  const ctx = { req, res, url, ip: clientIp(req), query: Object.fromEntries(url.searchParams), params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };

  if (r.auth === 'api') {
    const rl = S.rateLimit('api:' + String(req.headers['x-api-key'] || '').slice(0, 16), 600, 60e3);
    if (!rl.ok) throw httpError(429, 'Превышен лимит 600 запросов в минуту');
    ctx.user = apiUser(req);
  } else if (r.auth) {
    ctx.user = sessionUser(req, r.allowPending);
    if (!ctx.user) throw httpError(401, 'Требуется вход');
    if (ctx.user.blocked) throw httpError(403, 'Учётная запись заблокирована');
    if (r.auth !== 'any' && ctx.user.role !== r.auth) throw httpError(403, 'Недоступно для вашей роли');
    // CSRF: изменяющие запросы принимаются только с нашего origin
    if (req.method !== 'GET') {
      const origin = req.headers.origin || req.headers.referer;
      if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, 'Запрос с чужого сайта отклонён');
    }
  }
  if (ctx.user && ctx.user.role === 'company') {
    if (r.perm && !S.can(ctx.user, r.perm)) throw httpError(403, `Недостаточно прав (роль «${S.ROLE_NAMES[ctx.user.team_role] || ctx.user.team_role}»)`);
    if (req.method !== 'GET' && !r.allowBlocked) {
      const c = q.get('SELECT blocked FROM companies WHERE id=?', ctx.user.company_id);
      if (c && c.blocked) throw httpError(403, 'Компания заблокирована оператором. Обратитесь в поддержку.');
    }
  }
  ctx.body = req.method === 'GET' ? {} : await readBody(req);
  if (r.limit) {
    const [limit, win, keyFn] = r.limit;
    const lk = `${r.method}${r.re.source}:${keyFn ? keyFn(ctx) : ctx.ip}`;
    const rl = S.rateLimit(lk, limit, win);
    if (!rl.ok) { res.setHeader('Retry-After', rl.retryAfter); throw httpError(429, `Слишком много попыток. Повторите через ${Math.ceil(rl.retryAfter / 60)} мин.`); }
  }
  const out = await r.handler(ctx);
  if (out !== undefined && !res.headersSent) send(res, 200, out);
}

module.exports = { R, routes, dispatch, send, need, num, str, parseCookies, sessionUser, setSessionCookie, clearSessionCookie, clientIp };
