'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { q } = require('./db');
const L = require('./logic');
const jobs = require('./jobs');
const svc = require('./services');
const { dispatch, send } = require('./http');

for (const r of ['auth', 'public', 'company', 'contractors', 'documents', 'payouts', 'work', 'person', 'api_v1', 'admin']) require('./routes/' + r);
const { handlePages } = require('./routes/pages');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/tariffs': 'tariffs.html', '/contractors': 'contractors.html', '/knowledge': 'knowledge.html', '/developers': 'developers.html', '/app': 'app.html', '/privacy': 'privacy.html' };
function serveStatic(res, pathname) {
  let file = PAGES[pathname];
  if (!file && pathname.startsWith('/pay/')) file = 'pay.html';
  if (!file) file = pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC, '404.html'), (e2, d2) => send(res, 404, e2 ? 'Not found' : d2.toString()));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

// Необязательная защита тестового стенда паролем (SITE_PASSWORD). Публичные адреса для клиентов и API не закрываются.
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SITE_OPEN = /^\/(healthz$|api\/v1\/|api\/public\/|pay\/|verify\/|receipt\/|assets\/)/;
function siteAuthOk(req, url) {
  if (!SITE_PASSWORD || SITE_OPEN.test(url.pathname)) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [, pass] = Buffer.from(m[1], 'base64').toString().split(/:(.*)/s);
  const a = Buffer.from(String(pass || '')), b = Buffer.from(SITE_PASSWORD);
  return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://x');
  if (!siteAuthOk(req, url)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PayOut test", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Тестовый стенд: требуется пароль'); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  if (process.env.COOKIE_SECURE === '1') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      res.setHeader('Cache-Control', 'no-store');
      await dispatch(req, res, url);
    } else {
      if (req.method === 'GET' && (await handlePages(req, res, url))) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(res, url.pathname);
    }
  } catch (e) {
    const status = e.status || (/CHECK constraint failed: balance/.test(e.message) ? 402 : /Подписанный документ/.test(e.message) ? 409 : 500);
    if (status === 500) console.error(JSON.stringify({ level: 'error', path: url.pathname, msg: e.message, stack: e.stack }));
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Внутренняя ошибка сервера' : status === 402 && !e.status ? 'Недостаточно средств на балансе' : e.message });
  } finally {
    if (process.env.LOG_REQUESTS === '1' && url.pathname.startsWith('/api/')) console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: url.pathname, s: res.statusCode, ms: Date.now() - t0 }));
  }
});

function start() {
  if (!q.get('SELECT id FROM users LIMIT 1') && process.env.SEED !== '0') require('./seed').seed();
  jobs.start();
  svc.startSchedules();
  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => console.log(`${L.BRAND} запущен: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
  const stop = () => { console.log('Остановка…'); jobs.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (require.main === module) start();
module.exports = { server, start };
