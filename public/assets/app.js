/* PayOut — SPA кабинетов компании и исполнителя. Без зависимостей. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 0) => Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: 2 }) + ' ₽';
const fdate = (s, time) => { if (!s) return '—'; const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')); return time ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU'); };
const initials = (n) => String(n || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const maskCard = (c) => c ? '•••• ' + String(c).slice(-4) : '—';

let ME = null;
const can = (perm) => !!ME && ME.role === 'company' && (ME.perms.includes('*') || ME.perms.includes(perm));

async function api(url, body, method) {
  const opt = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const h0 = location.hash;
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  // ответ на GET пришёл после перехода на другую страницу — не рисуем устаревшие данные
  if (opt.method === 'GET' && location.hash !== h0 && url !== '/api/me') throw Object.assign(new Error('stale'), { stale: true });
  if (r.status === 401 && !url.includes('/auth/')) { ME = null; location.hash = '#/login'; throw new Error('Требуется вход'); }
  if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status);
  return j;
}
function toast(msg, err) {
  let w = $('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 4500);
}
const fail = (e) => { if (!e.stale) toast(e.message, true); };
function modal(html, { wide } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  const onKey = (e) => { if (e.key === 'Escape') { close(); removeEventListener('keydown', onKey); } }; addEventListener('keydown', onKey);
  return { el: bg, close };
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.innerHTML; btn.innerHTML = 'Подождите…'; } else if (btn.dataset.t) btn.innerHTML = btn.dataset.t; }

/* ---------- словари статусов ---------- */
const CT = { npd: 'Самозанятый', fl: 'Физлицо (ГПХ)', ip: 'ИП', eaeu: 'ЕАЭС' };
const NPD = { active: ['ok', 'НПД активен'], inactive: ['bad', 'Не самозанятый'], unknown: ['plain', 'Не проверен'], invalid: ['bad', 'ИНН некорректен'] };
const DOCST = { draft: ['plain', 'Черновик'], sent: ['info', 'Ждёт подписей'], signed_company: ['warn', 'Ждёт исполнителя'], signed_contractor: ['warn', 'Ждёт компанию'], signed: ['ok', 'Подписан'], revoked: ['plain', 'Отозван'] };
const PST = { draft: ['plain', 'Черновик'], processing: ['info', 'В обработке'], paid: ['ok', 'Выплачено'], failed: ['bad', 'Отклонено'], cancelled: ['plain', 'Отменено'] };
const TST = { open: ['info', 'Приём откликов'], in_progress: ['warn', 'В работе'], review: ['warn', 'На проверке'], done: ['ok', 'Завершено'], cancelled: ['plain', 'Отменено'] };
const OST = { new: ['info', 'Новая'], search: ['warn', 'Идёт подбор'], staffed: ['ok', 'Укомплектовано'], closed: ['plain', 'Закрыта'] };
const SST = { pending: ['info', 'Ожидает оплаты'], paid: ['warn', 'Оплачено'], distributed: ['ok', 'Распределено'] };
const chip = (map, k) => { const [c, t] = map[k] || ['plain', k]; return `<span class="chip ${c}">${esc(t)}</span>`; };
const DOCTYPES = { contract: 'Договор', act: 'Акт', task_order: 'Задание', nda: 'NDA' };

/* ---------- иконки ---------- */
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  home: I('<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'),
  users: I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.5"/>'),
  doc: I('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  task: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 10l2 2 4-4M8 16h8"/>'),
  people: I('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
  pay: I('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  split: I('<path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 22v-8"/>'),
  wallet: I('<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 13h2M2 10h20"/>'),
  plug: I('<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>'),
  team: I('<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  bell: I('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  out: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
};

/* ---------- роутер ---------- */
const routes = {};
const HOME = () => ME.role === 'company' ? '#/dashboard' : ME.role === 'admin' ? '#/admin' : '#/home';
const on = (p, fn) => { routes[p] = fn; };
function matchRoute(hash) {
  const [pathPart, qs] = hash.replace(/^#/, '').split('?');
  const parts = (pathPart || '/').split('/').filter(Boolean);
  for (const [p, fn] of Object.entries(routes)) {
    const pp = p.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {}; let ok = true;
    pp.forEach((seg, i) => { if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]); else if (seg !== parts[i]) ok = false; });
    if (ok) return { fn, params, query: Object.fromEntries(new URLSearchParams(qs || '')), path: '/' + parts.join('/') };
  }
  return null;
}
async function render() {
  const hash = location.hash || '#/';
  if (!ME && !/^#\/(login|register|forgot|reset|verify-email)/.test(hash)) {
    try { ME = await api('/api/me'); } catch { location.hash = '#/login'; return; }
  }
  let m = matchRoute(hash);
  if (!m || m.path === '/') { location.hash = ME ? HOME() : '#/login'; return; }
  try { await m.fn(m.params, m.query); } catch (e) { if (e.message !== 'Требуется вход' && !e.stale) { console.error(e); fail(e); } }
}
addEventListener('hashchange', () => { $$('.modal-bg').forEach((m) => m.remove()); render(); });

/* ---------- каркас ---------- */
const NAV_COMPANY = [
  ['Главное'], ['/dashboard', 'Обзор', 'home'], ['/contractors', 'Исполнители', 'users'], ['/documents', 'Документы', 'doc', 'docs'], ['/payouts', 'Выплаты', 'pay', 'drafts'],
  ['Сервисы'], ['/tasks', 'Биржа заданий', 'task', 'review'], ['/outstaff', 'Подбор персонала', 'people'], ['/splits', 'Сплит-платежи', 'split'], ['/employees', 'Сотрудники (КЭДО)', 'team'],
  ['Компания'], ['/balance', 'Баланс', 'wallet', null, 'balance'], ['/templates', 'Шаблоны документов', 'doc'], ['/integrations', 'Интеграции и API', 'plug', null, 'settings'], ['/team', 'Команда', 'people'], ['/audit', 'Журнал действий', 'search', null, 'audit'], ['/settings', 'Настройки', 'gear'],
];
const NAV_ADMIN = [
  ['Оператор'], ['/admin', 'Обзор', 'home'], ['/admin/leads', 'Заявки с сайта', 'bell'], ['/admin/outstaff', 'Подбор персонала', 'people'], ['/admin/companies', 'Компании', 'users'], ['/admin/invoices', 'Счета и поступления', 'wallet'],
  ['Система'], ['/admin/messages', 'Письма и SMS', 'doc'], ['/admin/jobs', 'Очередь задач', 'task'], ['/admin/audit', 'Журнал действий', 'search'],
];
const NAV_CONTRACTOR = [
  ['Кабинет'], ['/home', 'Главная', 'home'], ['/market', 'Биржа заданий', 'search'], ['/my-tasks', 'Мои задания', 'task'], ['/my-docs', 'Документы', 'doc'], ['/my-payouts', 'Выплаты и чеки', 'pay'], ['/profile', 'Профиль', 'user'], ['/security', 'Безопасность', 'gear'],
];
let BADGES = {};
function layout(title, content, actions = '') {
  const nav = (ME.role === 'company' ? NAV_COMPANY : ME.role === 'admin' ? NAV_ADMIN : NAV_CONTRACTOR).filter((n) => n.length === 1 || !n[4] || can(n[4]));
  const cur = '/' + (location.hash.replace(/^#\//, '').split(/[/?]/)[0] || '');
  const brand = (ME.company && ME.company.brand_name) || ME.brand;
  $('#app').innerHTML = `<div class="shell">
    <aside class="side" id="side">
      <a class="logo" href="/"><i></i>${esc(brand)}</a>
      ${nav.map((n) => n.length === 1 ? `<div class="grp">${n[0]}</div>` : `<a class="nl ${cur === n[0] ? 'on' : ''}" href="#${n[0]}">${IC[n[2]]}${n[1]}${n[3] && BADGES[n[3]] ? `<span class="badge">${BADGES[n[3]]}</span>` : ''}</a>`).join('')}
      <a class="nl ${cur === '/notifications' ? 'on' : ''}" href="#/notifications" style="margin-top:12px">${IC.bell}Уведомления${ME.unread ? `<span class="badge">${ME.unread}</span>` : ''}</a>
      <div class="me"><b>${esc(ME.name || ME.email)}</b>${esc(ME.company ? ME.company.name + ' · ' + ({ owner: 'владелец', accountant: 'бухгалтер', manager: 'менеджер' }[ME.team_role] || '') : ME.role === 'admin' ? 'Оператор' : 'Исполнитель')}<br>${ME.role === 'company' ? '<a href="#/security" style="color:#9FB0C0">Безопасность</a> · ' : ''}<a href="#" id="logout" style="color:#9FB0C0">Выйти</a></div>
    </aside>
    <div class="main">
      <div class="topbar"><button class="mob-btn" onclick="document.getElementById('side').classList.toggle('open')">☰</button><h1>${title}</h1>${actions}</div>
      <div class="page" id="page">${!ME.email_verified ? `<div class="risk-item warn" style="align-items:center;margin-bottom:14px">✉️ <span style="flex:1">Подтвердите email ${esc(ME.email)} — так вы сможете восстановить доступ.</span><button class="btn btn-ghost btn-sm" id="verifyReq">Отправить письмо</button></div>` : ''}${ME.company && ME.company.blocked ? '<div class="risk-item block" style="margin-bottom:14px">Компания заблокирована оператором. Операции недоступны, обратитесь в поддержку.</div>' : ''}${content}</div>
    </div></div>`;
  if ($('#verifyReq')) $('#verifyReq').onclick = async (e) => { try { const r = await api('/api/auth/email/verify-request', {}); toast('Письмо отправлено'); if (r.demo_link) modal(`<h3>Демо-режим</h3><p>Ссылка из письма:</p><a class="btn btn-primary" href="${r.demo_link}" data-close>Подтвердить email</a>`); } catch (err) { fail(err); } };
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('/api/auth/logout', {}); ME = null; location.href = '/'; };
  $$('.side a.nl').forEach((a) => a.addEventListener('click', () => $('#side').classList.remove('open')));
}
const emptyBox = (title, text, btn = '') => `<div class="empty"><b>${title}</b>${text}${btn ? `<div style="margin-top:14px">${btn}</div>` : ''}</div>`;

/* =========================================================
   АВТОРИЗАЦИЯ
   ========================================================= */
function authShell(inner) {
  $('#app').innerHTML = `<div class="auth"><div class="art"><a class="logo" href="/"><i></i>PayOut</a>
    <h2>Договоры, подписи и выплаты исполнителям — в одном окне.</h2>
    <div style="position:relative;z-index:1;color:#9FB0C0;font-size:14px">НПД · ИП · ГПХ · ЕАЭС · Open API</div></div>
    <div class="frm"><div>${inner}</div></div></div>`;
}
on('/login', async (_, qy) => {
  authShell(`<h2 style="font-size:30px">Вход</h2><p class="muted">Ещё нет аккаунта? <a href="#/register">Зарегистрируйтесь</a></p>
    <form id="f"><label class="f"><span>Email</span><input class="input" name="email" type="email" required autocomplete="username"></label>
    <label class="f"><span>Пароль</span><input class="input" name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn btn-primary btn-lg" style="width:100%">Войти</button></form>
    <p class="small" style="margin-top:12px"><a href="#/forgot">Забыли пароль?</a></p>
    <div class="card" style="margin-top:20px;padding:16px"><b class="small">Демо-доступ</b>
      <div class="row wrap" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-demo="demo@payout.ru">Компания (владелец)</button><button class="btn btn-ghost btn-sm" data-demo="buh@payout.ru">Бухгалтер</button><button class="btn btn-ghost btn-sm" data-demo="manager@payout.ru">Менеджер</button><button class="btn btn-ghost btn-sm" data-demo="ivan@payout.ru">Исполнитель</button><button class="btn btn-ghost btn-sm" data-demo="admin@payout.ru" data-pass="admin1234">Оператор</button></div></div>`);
  const f = $('#f');
  const done = async () => { ME = await api('/api/me'); location.hash = HOME(); };
  const go = async (email, password) => {
    const r = await api('/api/auth/login', { email, password });
    if (!r.need2fa) return done();
    authShell(`<h2 style="font-size:30px">Код из приложения</h2><p class="muted">Введите 6 цифр из Google Authenticator, Яндекс Ключа или другого приложения.</p>
      <form id="tf"><label class="f"><input class="input mono" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required autofocus style="font-size:22px;letter-spacing:.3em;text-align:center"></label><button class="btn btn-primary btn-lg" style="width:100%">Войти</button></form>
      <p class="small" style="margin-top:12px"><a href="#/login" onclick="api('/api/auth/logout',{}).catch(()=>{})">← Назад</a></p>`);
    $('#tf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/2fa', { code: e.target.code.value }); await done(); } catch (err) { fail(err); } };
  };
  f.onsubmit = (e) => { e.preventDefault(); const d = formData(f); go(d.email, d.password).catch(fail); };
  $$('[data-demo]').forEach((b) => b.onclick = () => go(b.dataset.demo, b.dataset.pass || 'demo1234').catch(fail));
  if (qy.demo) go('demo@payout.ru', 'demo1234').catch(fail);
});
on('/forgot', async () => {
  authShell(`<h2 style="font-size:30px">Восстановление пароля</h2><p class="muted">Пришлём ссылку для смены пароля на email.</p>
    <form id="f"><label class="f"><span>Email</span><input class="input" name="email" type="email" required></label><button class="btn btn-primary btn-lg" style="width:100%">Отправить ссылку</button></form>
    <p class="small" style="margin-top:12px"><a href="#/login">← Ко входу</a></p>`);
  $('#f').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/auth/password/forgot', formData(e.target));
    $('#f').outerHTML = `<div class="risk-item ok">Если такой email зарегистрирован, письмо уже отправлено. Ссылка действует 1 час.</div>${r.demo_link ? `<div class="demo-hint" style="margin-top:10px">Демо-режим: <a href="${r.demo_link}">ссылка из письма</a></div>` : ''}`; } catch (err) { fail(err); } };
});
on('/reset', async (_, qy) => {
  authShell(`<h2 style="font-size:30px">Новый пароль</h2><p class="muted">Минимум 8 символов, буквы и цифры. После смены вы выйдете на всех устройствах.</p>
    <form id="f"><label class="f"><span>Новый пароль</span><input class="input" name="password" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn btn-primary btn-lg" style="width:100%">Сохранить</button></form>`);
  $('#f').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/password/reset', { token: qy.token, password: e.target.password.value }); ME = null; toast('Пароль изменён, войдите заново'); location.hash = '#/login'; } catch (err) { fail(err); } };
});
on('/verify-email', async (_, qy) => {
  authShell(`<h2 style="font-size:30px">Подтверждение email</h2><p class="muted" id="st">Проверяем ссылку…</p><a class="btn btn-primary" href="#/">Продолжить</a>`);
  try { await api('/api/auth/email/verify', { token: qy.token }); $('#st').textContent = 'Email подтверждён ✓'; if (ME) ME.email_verified = true; } catch (err) { $('#st').textContent = err.message; }
});
on('/register', async (_, qy) => {
  let role = qy.role === 'contractor' ? 'contractor' : 'company';
  const draw = () => {
    authShell(`<h2 style="font-size:30px">Регистрация</h2><p class="muted">Уже есть аккаунт? <a href="#/login">Войти</a></p>
      <div class="seg"><button data-r="company" class="${role === 'company' ? 'on' : ''}">Я — компания</button><button data-r="contractor" class="${role === 'contractor' ? 'on' : ''}">Я — исполнитель</button></div>
      <form id="f">
        ${role === 'company' ? `<label class="f"><span>Название компании</span><input class="input" name="company_name" required placeholder="ООО «Ромашка»"></label>
        <label class="f"><span>ИНН компании <span class="muted">(можно позже)</span></span><input class="input mono" name="inn" maxlength="12"></label>` : ''}
        <label class="f"><span>Ваше имя</span><input class="input" name="name" required></label>
        <label class="f"><span>Телефон</span><input class="input" name="phone" type="tel" placeholder="+7…" required></label>
        <label class="f"><span>Email</span><input class="input" name="email" type="email" required></label>
        <label class="f"><span>Пароль (от 8 символов, буквы и цифры)</span><input class="input" name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <label class="check" style="margin-bottom:16px"><input type="checkbox" required> Согласен с <a href="/privacy" target="_blank">политикой обработки данных</a></label>
        <button class="btn btn-primary btn-lg" style="width:100%">Создать кабинет</button></form>`);
    $$('[data-r]').forEach((b) => b.onclick = () => { role = b.dataset.r; draw(); });
    $('#f').onsubmit = async (e) => {
      e.preventDefault(); const d = formData(e.target); d.role = role;
      try { await api('/api/auth/register', d); ME = await api('/api/me'); toast('Кабинет создан'); location.hash = role === 'company' ? '#/dashboard' : '#/profile'; } catch (err) { fail(err); }
    };
  };
  draw();
});

/* =========================================================
   ПОДПИСАНИЕ (общий модуль)
   ========================================================= */
async function signFlow(docIds, done) {
  let req;
  try { req = await api('/api/sign/request', { doc_ids: docIds }); } catch (e) { return fail(e); }
  const gk = ME.company && ME.company.sign_method === 'gosklyuch';
  const m = modal(`<h3>Подписание ${req.count > 1 ? req.count + ' документов' : 'документа'}</h3>
    <p class="muted">${gk ? 'Подтвердите подпись в приложении «Госключ» и введите код' : `Мы отправили код на ${esc(req.sent_to)}`}</p>
    ${req.demo_code ? `<div class="demo-hint">Демо-режим: код <b class="mono">${req.demo_code}</b> (в боевом режиме приходит по SMS)</div>` : ''}
    <div class="code-in">${'<input maxlength="1" inputmode="numeric">'.repeat(6)}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-brand" id="ok">Подписать</button></div>
    <p class="small muted" style="margin:14px 0 0">Подписывая, вы подтверждаете согласие с содержанием документов. Простая электронная подпись (63-ФЗ).</p>`);
  const ins = $$('.code-in input', m.el); ins[0].focus();
  ins.forEach((inp, i) => {
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, ''); if (inp.value && ins[i + 1]) ins[i + 1].focus(); if (ins.every((x) => x.value)) $('#ok', m.el).click(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && ins[i - 1]) ins[i - 1].focus(); });
    inp.addEventListener('paste', (e) => { const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6); if (t.length === 6) { e.preventDefault(); t.split('').forEach((c, j) => ins[j].value = c); $('#ok', m.el).click(); } });
  });
  $('#ok', m.el).onclick = async (e) => {
    busy(e.target, true);
    try { const r = await api('/api/sign/confirm', { request_id: req.request_id, code: ins.map((x) => x.value).join('') }); m.close(); toast(`Подписано документов: ${r.signed}`); done && done(); }
    catch (err) { busy(e.target, false); fail(err); ins.forEach((x) => x.value = ''); ins[0].focus(); }
  };
}
function viewDoc(id, after) {
  const m = modal(`<div class="card-h"><h3>Документ</h3><div class="row"><a class="btn btn-ghost btn-sm" href="/doc/${id}.pdf" target="_blank">Скачать PDF</a><a class="btn btn-ghost btn-sm" href="/doc/${id}" target="_blank">Открыть</a><button class="btn btn-ghost btn-sm" data-close>Закрыть</button></div></div>
    <iframe class="doc-frame" src="/doc/${id}"></iframe><div class="row" style="justify-content:flex-end;margin-top:14px" id="acts"></div>`, { wide: true });
  api('/api/documents/' + id).then(({ document: d }) => {
    const mine = ME.role === 'company' ? ['sent', 'signed_contractor'] : ['sent', 'signed_company'];
    if (d.sign_hash) $('#acts', m.el).innerHTML = `<a class="small" href="/verify/${d.sign_hash}" target="_blank" style="margin-right:auto">Проверка подлинности ↗</a>`;
    if (mine.includes(d.status) && (ME.role !== 'company' || (can('sign') && d.type !== 'kedo_consent'))) { $('#acts', m.el).innerHTML = `<button class="btn btn-brand">Подписать</button>`; $('#acts button', m.el).onclick = () => { m.close(); signFlow([id], after); }; }
  });
}

/* =========================================================
   КОМПАНИЯ
   ========================================================= */
async function refreshBadges() {
  try { const d = await api('/api/dashboard'); BADGES = { docs: d.stats.docsToSign, drafts: d.stats.drafts, review: d.stats.review }; return d; } catch { return null; }
}
on('/dashboard', async () => {
  const d = await refreshBadges(); ME = await api('/api/me');
  const s = d.stats, c = d.company;
  const max = Math.max(1, ...d.monthly.map((x) => x.v));
  const months = d.monthly.map((x) => ({ ...x, label: new Date(x.m + '-01').toLocaleDateString('ru-RU', { month: 'short' }) }));
  layout(`Добрый день${ME.name ? ', ' + esc(ME.name.split(' ')[0]) : ''}`, `
    <div class="kpis">
      <div class="kpi ink"><span>Баланс</span><b>${money(c.balance)}</b><small>Тариф «${esc({ start: 'Старт', business: 'Бизнес', enterprise: 'Корпорация' }[c.plan])}»</small></div>
      <div class="kpi"><span>Выплачено в этом месяце</span><b>${money(s.paidMonth)}</b><small>всего ${money(s.paidTotal)}</small></div>
      <div class="kpi"><span>Исполнители</span><b>${s.contractors}</b><small>${s.activeNpd} самозанятых с активным НПД</small></div>
      <div class="kpi"><span>Ждут вашей подписи</span><b>${s.docsToSign}</b><small>${s.docsWaiting} ждут исполнителей</small></div>
    </div>
    <div class="cols-2">
      <div class="card"><div class="card-h"><h3>Выплаты по месяцам</h3><a href="#/payouts" class="small">Все выплаты →</a></div>
        ${months.length ? `<div class="chart">${months.map((x) => `<div class="c"><em>${Math.round(x.v / 1000)}k</em><i style="height:${(x.v / max) * 100}%"></i><span>${x.label}</span></div>`).join('')}</div>` : emptyBox('Пока нет выплат', 'Здесь появится динамика')}
      </div>
      <div class="card"><h3>Что требует внимания</h3>
        ${s.docsToSign ? `<div class="risk-item warn">📝 <span>${s.docsToSign} документ(ов) ждут вашей подписи. <a href="#/documents?status=mine">Подписать</a></span></div>` : ''}
        ${s.review ? `<div class="risk-item warn">✅ <span>${s.review} задание(й) сданы на проверку. <a href="#/tasks">Принять</a></span></div>` : ''}
        ${s.drafts ? `<div class="risk-item warn">💸 <span>${s.drafts} выплат(ы) в черновиках. <a href="#/payouts?status=draft">Отправить</a></span></div>` : ''}
        ${d.risky.map((k) => `<div class="risk-item block">⚠️ <span><a href="#/contractors/${k.id}" style="color:inherit;font-weight:700">${esc(k.full_name)}</a>: статус НПД не подтверждён</span></div>`).join('')}
        ${c.balance < 50000 ? `<div class="risk-item warn">💳 <span>Низкий баланс. <a href="#/balance">Пополнить</a></span></div>` : ''}
        ${!s.docsToSign && !s.review && !s.drafts && !d.risky.length && c.balance >= 50000 ? '<div class="risk-item ok">✓ Всё в порядке</div>' : ''}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>Последние выплаты</h3><button class="btn btn-primary btn-sm" onclick="newPayout()">Новая выплата</button></div>
      ${d.recent.length ? `<table class="tbl"><tbody>${d.recent.map((p) => `<tr><td><div class="person"><span class="av">${initials(p.full_name)}</span><div><b>${esc(p.full_name)}</b><span>${esc(p.purpose || '')}</span></div></div></td><td>${fdate(p.created_at)}</td><td>${chip(PST, p.status)}</td><td class="num"><b>${money(p.amount)}</b></td></tr>`).join('')}</tbody></table>` : emptyBox('Выплат ещё нет', 'Пополните баланс и добавьте исполнителя')}
    </div>`,
    `${can('balance') ? '<a class="btn btn-ghost btn-sm" href="#/balance">Пополнить</a>' : ''}${can('payouts') ? '<button class="btn btn-primary btn-sm" onclick="newPayout()">Выплатить</button>' : ''}`);
});

/* ---------- Исполнители ---------- */
on('/contractors', async (_, qy) => {
  const params = new URLSearchParams(qy).toString();
  const { contractors } = await api('/api/contractors?' + params);
  layout('Исполнители', `
    <div class="toolbar">
      <div class="tabs">${[['', 'Все'], ['npd', 'Самозанятые'], ['ip', 'ИП'], ['fl', 'ГПХ'], ['eaeu', 'ЕАЭС']].map(([k, t]) => `<button class="${(qy.type || '') === k ? 'on' : ''}" data-type="${k}">${t}</button>`).join('')}</div>
      <input class="input" id="q" placeholder="Поиск по ФИО, ИНН, телефону" value="${esc(qy.q || '')}"><span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="chk">Перепроверить НПД</button>
      <a class="btn btn-ghost btn-sm" href="/api/export/contractors.csv">Экспорт CSV</a>
    </div>
    <div class="tbl-wrap">${contractors.length ? `<table class="tbl"><thead><tr><th>Исполнитель</th><th>Тип</th><th>ИНН</th><th>Статус</th><th>Договор</th><th>Реквизиты</th><th class="num">Выплачено</th></tr></thead><tbody>
      ${contractors.map((k) => `<tr class="click" data-id="${k.id}"><td><div class="person"><span class="av">${initials(k.full_name)}</span><div><b>${esc(k.full_name)}</b><span>${esc(k.specialty || k.phone || '')}</span></div></div></td>
      <td>${CT[k.type]}</td><td class="mono">${esc(k.inn || '—')}</td><td>${k.type === 'npd' ? chip(NPD, k.npd_status) : k.status === 'blocked' ? '<span class="chip bad">Заблокирован</span>' : k.user_id ? '<span class="chip ok">В сервисе</span>' : '<span class="chip plain">Приглашён</span>'}</td>
      <td>${k.has_contract ? '<span class="chip ok">Подписан</span>' : '<span class="chip warn">Нет</span>'}</td><td class="mono">${maskCard(k.card)}</td><td class="num">${money(k.paid_total)}</td></tr>`).join('')}
    </tbody></table>` : emptyBox('Исполнителей пока нет', 'Добавьте вручную, загрузите CSV или опубликуйте задание на бирже', '<button class="btn btn-primary" onclick="addContractor()">Добавить исполнителя</button>')}</div>`,
    `<button class="btn btn-ghost btn-sm" onclick="importContractors()">Импорт CSV</button><button class="btn btn-primary btn-sm" onclick="addContractor()">Добавить</button>`);
  $$('[data-type]').forEach((b) => b.onclick = () => { location.hash = '#/contractors?' + new URLSearchParams({ ...qy, type: b.dataset.type }); });
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { location.hash = '#/contractors?' + new URLSearchParams({ ...qy, q: e.target.value }); }, 400); };
  $$('tr[data-id]').forEach((r) => r.onclick = () => location.hash = '#/contractors/' + r.dataset.id);
  $('#chk').onclick = async (e) => { busy(e.target, true); try { const r = await api('/api/contractors/check-npd-all', {}); toast(`Проверено ${r.checked}, активны ${r.active}`); render(); } catch (err) { fail(err); busy(e.target, false); } };
  if (qy.q) { const i = $('#q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
});
function contractorForm(k = {}) {
  return `<div class="cols-2e"><label class="f"><span>Тип</span><select class="input" name="type">${Object.entries(CT).map(([v, t]) => `<option value="${v}" ${k.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f"><span>ФИО</span><input class="input" name="full_name" required value="${esc(k.full_name || '')}"></label></div>
    <div class="cols-2e"><label class="f"><span>ИНН</span><input class="input mono" name="inn" maxlength="12" value="${esc(k.inn || '')}"></label>
    <label class="f"><span>Специализация</span><input class="input" name="specialty" value="${esc(k.specialty || '')}" placeholder="Дизайн, доставка…"></label></div>
    <div class="cols-2e"><label class="f"><span>Телефон</span><input class="input" name="phone" value="${esc(k.phone || '')}"></label>
    <label class="f"><span>Email</span><input class="input" name="email" type="email" value="${esc(k.email || '')}"></label></div>
    <div class="cols-2e"><label class="f"><span>Номер карты</span><input class="input mono" name="card" inputmode="numeric" value="${esc(k.card || '')}" placeholder="2200 0000 0000 0004"></label>
    <label class="f"><span>Был сотрудником? Дата увольнения</span><input class="input" type="date" name="former_employee_until" value="${esc(k.former_employee_until || '')}"></label></div>
    <p class="small muted" style="margin-top:-6px">Бывшим сотрудникам нельзя платить как самозанятым 2 года после увольнения — платформа заблокирует такие выплаты.</p>`;
}
window.addContractor = () => {
  const m = modal(`<h3>Новый исполнитель</h3><form id="cf">${contractorForm()}
    <label class="check" style="margin-bottom:16px"><input type="checkbox" name="send_contract" checked> Сразу отправить договор на подпись</label>
    <p class="small muted">Если исполнитель уже есть в ${esc(ME.brand)}, он увидит приглашение в кабинете. Статус НПД проверим автоматически.</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Добавить</button></div></form>`);
  $('#cf', m.el).onsubmit = async (e) => {
    e.preventDefault(); const d = formData(e.target); d.send_contract = !!d.send_contract; d.card = (d.card || '').replace(/\s/g, '');
    busy(e.submitter, true);
    try { const r = await api('/api/contractors', d); m.close(); toast(r.contractor.type === 'npd' ? `Добавлен. Статус НПД: ${NPD[r.contractor.npd_status][1]}` : 'Исполнитель добавлен'); location.hash = '#/contractors/' + r.id; }
    catch (err) { busy(e.submitter, false); fail(err); }
  };
};
function parseCSV(text) {
  text = text.replace(/^﻿/, ''); const delim = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
window.importContractors = () => {
  const m = modal(`<h3>Импорт исполнителей</h3>
    <p class="muted">CSV или выгрузка из Excel («Сохранить как CSV»). Колонки: <span class="mono">ФИО; Тип; ИНН; Телефон; Email; Карта; Специализация</span>. Тип: npd, ip, fl, eaeu.</p>
    <a class="small" href="#" id="tpl">Скачать шаблон</a>
    <label class="f" style="margin-top:14px"><input type="file" accept=".csv,text/csv" class="input" style="padding:8px" id="file"></label>
    <div id="prev"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" id="go" disabled>Импортировать</button></div>`, { wide: true });
  let rows = [];
  $('#tpl', m.el).onclick = (e) => { e.preventDefault(); const blob = new Blob(['﻿ФИО;Тип;ИНН;Телефон;Email;Карта;Специализация\r\nИван Иванов;npd;500100732259;+79001234567;ivan@mail.ru;2200000000000004;Курьер\r\n'], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'contractors-template.csv'; a.click(); };
  $('#file', m.el).onchange = async (e) => {
    const data = parseCSV(await e.target.files[0].text()); const head = data.shift().map((h) => h.trim().toLowerCase());
    const col = (names) => head.findIndex((h) => names.some((n) => h.includes(n)));
    const ix = { full_name: col(['фио', 'name']), type: col(['тип', 'type']), inn: col(['инн', 'inn']), phone: col(['тел', 'phone']), email: col(['mail']), card: col(['карт', 'card']), specialty: col(['спец', 'spec']) };
    rows = data.map((r) => Object.fromEntries(Object.entries(ix).filter(([, i]) => i >= 0).map(([k, i]) => [k, (r[i] || '').trim()])));
    rows.forEach((r) => { const t = (r.type || '').toLowerCase(); r.type = /ип|ip/.test(t) ? 'ip' : /гпх|fl|физ/.test(t) ? 'fl' : /еаэс|eaeu/.test(t) ? 'eaeu' : 'npd'; r.card = (r.card || '').replace(/\D/g, ''); });
    $('#prev', m.el).innerHTML = `<div class="tbl-wrap" style="max-height:260px;margin-bottom:14px"><table class="tbl"><thead><tr><th>ФИО</th><th>Тип</th><th>ИНН</th><th>Телефон</th></tr></thead><tbody>${rows.slice(0, 50).map((r) => `<tr><td>${esc(r.full_name)}</td><td>${CT[r.type]}</td><td class="mono">${esc(r.inn)}</td><td>${esc(r.phone)}</td></tr>`).join('')}</tbody></table></div><p class="small muted">Найдено строк: ${rows.length}</p>`;
    $('#go', m.el).disabled = !rows.length;
  };
  $('#go', m.el).onclick = async (e) => {
    busy(e.target, true);
    try { const r = await api('/api/contractors/import', { rows }); m.close(); toast(`Добавлено: ${r.added}${r.errors.length ? `, ошибок: ${r.errors.length}` : ''}`); if (r.errors.length) modal(`<h3>Ошибки импорта</h3><ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><button class="btn btn-primary" data-close>Понятно</button>`); render(); }
    catch (err) { busy(e.target, false); fail(err); }
  };
};
on('/contractors/:id', async ({ id }) => {
  const d = await api('/api/contractors/' + id); const k = d.contractor;
  const pct = Math.min(100, (d.yearIncome / d.limit) * 100);
  layout(`<a href="#/contractors" class="muted" style="font-weight:600">Исполнители /</a> ${esc(k.full_name)}`, `
    <div class="cols-2">
      <div class="grid">
        <div class="card"><div class="card-h"><div class="person"><span class="av" style="width:48px;height:48px;font-size:16px">${initials(k.full_name)}</span><div><b style="font-size:18px">${esc(k.full_name)}</b><span>${CT[k.type]}${k.specialty ? ' · ' + esc(k.specialty) : ''}</span></div></div>
          <div class="row">${k.type === 'npd' ? chip(NPD, k.npd_status) : ''}${k.status === 'blocked' ? '<span class="chip bad">Заблокирован</span>' : ''}</div></div>
          <dl class="dl"><dt>ИНН</dt><dd class="mono">${esc(k.inn || '—')}</dd><dt>Телефон</dt><dd>${esc(k.phone || '—')}</dd><dt>Email</dt><dd>${esc(k.email || '—')}</dd><dt>Карта</dt><dd class="mono">${maskCard(k.card)}</dd><dt>Гражданство</dt><dd>${esc(k.citizenship || '—')}</dd>
          ${k.type === 'npd' ? `<dt>Проверка НПД</dt><dd>${fdate(k.npd_checked_at, true)} ${k.npd_source === 'demo' ? '<span class="chip plain">демо</span>' : k.npd_source === 'fns' ? '<span class="chip ok">ФНС</span>' : ''}</dd>` : ''}
          ${d.formerBanUntil ? `<dt>Бывший сотрудник</dt><dd style="color:var(--red)">уволен ${fdate(k.former_employee_until)}, выплаты как НПД запрещены до ${fdate(d.formerBanUntil)}</dd>` : ''}
          <dt>Аккаунт</dt><dd>${k.user_id ? 'Подключён к кабинету' : 'Не зарегистрирован <a href="#" id="inv">Отправить приглашение повторно</a>'}</dd></dl>
          <div class="row wrap" style="margin-top:18px"><button class="btn btn-primary btn-sm" id="pay">Выплатить</button><button class="btn btn-ghost btn-sm" id="doc">Отправить документ</button>
            ${k.type === 'npd' ? '<button class="btn btn-ghost btn-sm" id="npd">Проверить НПД</button>' : ''}<button class="btn btn-ghost btn-sm" id="edit">Редактировать</button>
            <button class="btn btn-ghost btn-sm" id="block">${k.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}</button></div>
        </div>
        <div class="card"><h3>Документы</h3>${d.documents.length ? `<table class="tbl"><tbody>${d.documents.map((x) => `<tr class="click" data-doc="${x.id}"><td>${esc(x.title)}</td><td>${fdate(x.created_at)}</td><td>${chip(DOCST, x.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Документов нет', '')}</div>
        <div class="card"><h3>Выплаты</h3>${d.payouts.length ? `<table class="tbl"><tbody>${d.payouts.map((p) => `<tr><td>${esc(p.purpose || '')}</td><td>${fdate(p.created_at)}</td><td>${chip(PST, p.status)}${p.fail_reason ? `<div class="small" style="color:var(--red)">${esc(p.fail_reason)}</div>` : ''}</td><td class="num">${money(p.amount)}</td><td>${p.receipt_number ? `<a href="/receipt/${p.receipt_number}" target="_blank">Чек</a>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyBox('Выплат нет', '')}</div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Риск-профиль</h3>${d.risks.length ? d.risks.map((r) => `<div class="risk-item ${r.level}">${r.level === 'block' ? '⛔' : '⚠️'} ${esc(r.text)}</div>`).join('') : '<div class="risk-item ok">✓ Рисков не обнаружено</div>'}</div>
        ${k.type === 'npd' ? `<div class="card"><h3>Лимит НПД ${new Date().getFullYear()}</h3><div class="row between small" style="margin-bottom:8px"><b>${money(d.yearIncome)}</b><span class="muted">из ${money(d.limit)}</span></div><div class="progress ${pct > 85 ? 'warn' : ''}"><i style="width:${pct}%"></i></div><p class="small muted" style="margin:10px 0 0">Учитываются выплаты всех компаний на платформе</p></div>` : ''}
      </div>
    </div>`);
  $$('[data-doc]').forEach((r) => r.onclick = () => viewDoc(r.dataset.doc, render));
  $('#pay').onclick = () => newPayout([{ contractor_id: k.id }]);
  if ($('#inv')) $('#inv').onclick = async (e) => { e.preventDefault(); try { await api(`/api/contractors/${k.id}/invite`, {}); toast('Приглашение отправлено'); } catch (err) { fail(err); } };
  $('#doc').onclick = () => newDocument([k.id]);
  if ($('#npd')) $('#npd').onclick = async (e) => { busy(e.target, true); try { const r = await api(`/api/contractors/${k.id}/check-npd`, {}); toast('Статус: ' + NPD[r.contractor.npd_status][1]); render(); } catch (err) { fail(err); busy(e.target, false); } };
  $('#block').onclick = async () => { await api('/api/contractors/' + k.id, { status: k.status === 'blocked' ? 'active' : 'blocked' }, 'PUT').catch(fail); render(); };
  $('#edit').onclick = () => {
    const m = modal(`<h3>Редактирование</h3><form id="ef">${contractorForm(k)}<div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Сохранить</button></div></form>`);
    $('#ef', m.el).onsubmit = async (e) => { e.preventDefault(); const f = formData(e.target); f.card = (f.card || '').replace(/\s/g, ''); if (!f.card) delete f.card; if (f.inn === '') delete f.inn; try { await api('/api/contractors/' + k.id, f, 'PUT'); m.close(); toast('Сохранено'); render(); } catch (err) { fail(err); } };
  };
});

/* ---------- Документы ---------- */
on('/documents', async (_, qy) => {
  const { documents } = await api('/api/documents?' + new URLSearchParams(qy));
  layout('Документы', `
    <div class="toolbar"><div class="tabs">${[['', 'Все'], ['contractor', 'Исполнители'], ['employee', 'Сотрудники']].map(([k, t]) => `<button class="${(qy.party || '') === k ? 'on' : ''}" data-party="${k}">${t}</button>`).join('')}</div><div class="tabs">${[['', 'Все'], ['mine', 'Ждут моей подписи'], ['signed_company', 'Ждут второй стороны'], ['signed', 'Подписанные']].map(([k, t]) => `<button class="${(qy.status || '') === k ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>
      <select class="input" id="type"><option value="">Все типы</option>${Object.entries(DOCTYPES).map(([k, t]) => `<option value="${k}" ${qy.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span class="spacer"></span>${can('sign') ? '<button class="btn btn-brand btn-sm" id="signSel" disabled>Подписать выбранные</button>' : ''}</div>
    <div class="tbl-wrap">${documents.length ? `<table class="tbl"><thead><tr><th><input type="checkbox" id="all"></th><th>Документ</th><th>Получатель</th><th>Создан</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>
      ${documents.map((x) => `<tr class="click" data-id="${x.id}"><td><input type="checkbox" class="sel" value="${x.id}" ${['sent', 'signed_contractor'].includes(x.status) && x.type !== 'kedo_consent' ? '' : 'disabled'}></td><td><b>${esc(x.title)}</b></td><td>${esc(x.full_name)}${x.party === 'employee' ? ' <span class="chip plain">сотрудник</span>' : ''}</td><td>${fdate(x.created_at)}</td><td class="num">${x.amount ? money(x.amount) : '—'}</td><td>${chip(DOCST, x.status)}</td></tr>`).join('')}
    </tbody></table>` : emptyBox('Документов нет', 'Создайте договор, акт или задание для исполнителей', '<button class="btn btn-primary" onclick="newDocument()">Создать документ</button>')}</div>`,
    `<button class="btn btn-primary btn-sm" onclick="newDocument()">Создать документ</button>`);
  $$('[data-st]').forEach((b) => b.onclick = () => location.hash = '#/documents?' + new URLSearchParams({ ...qy, status: b.dataset.st }));
  $$('[data-party]').forEach((b) => b.onclick = () => location.hash = '#/documents?' + new URLSearchParams({ ...qy, party: b.dataset.party }));
  $('#type').onchange = (e) => location.hash = '#/documents?' + new URLSearchParams({ ...qy, type: e.target.value });
  const upd = () => { const n = $$('.sel:checked').length; if (!$('#signSel')) return; $('#signSel').disabled = !n; $('#signSel').textContent = n ? `Подписать выбранные (${n})` : 'Подписать выбранные'; };
  $$('.sel').forEach((c) => { c.onclick = (e) => e.stopPropagation(); c.onchange = upd; });
  if ($('#all')) $('#all').onchange = (e) => { $$('.sel:not(:disabled)').forEach((c) => c.checked = e.target.checked); upd(); };
  $$('tr[data-id]').forEach((r) => r.onclick = () => viewDoc(r.dataset.id, render));
  if ($('#signSel')) $('#signSel').onclick = () => signFlow($$('.sel:checked').map((c) => +c.value), render);
});
window.newDocument = async (preselect = [], party = 'contractor') => {
  const [{ contractors }, { employees }, { templates: tpls }] = await Promise.all([api('/api/contractors'), api('/api/employees'), api('/api/templates')]);
  const STD = { contractor: { contract: 'Договор оказания услуг', act: 'Акт об оказании услуг', task_order: 'Задание', nda: 'Соглашение о неразглашении' },
    employee: { kedo_consent: 'Согласие на КЭДО', employment: 'Трудовой договор', hire_order: 'Приказ о приёме', vacation: 'Приказ об отпуске', lna: 'Лист ознакомления с ЛНА' } };
  const m = modal(`<h3>Новый документ</h3><div class="seg" id="pt"><button data-p="contractor">Исполнителям</button><button data-p="employee">Сотрудникам (КЭДО)</button></div><form id="df"></form>`, { wide: true });
  const draw = () => {
    $$('#pt button', m.el).forEach((b) => b.classList.toggle('on', b.dataset.p === party));
    const people = party === 'employee' ? employees : contractors;
    const own = tpls.filter((t) => t.party === party);
    $('#df', m.el).innerHTML = `
    <label class="f"><span>Шаблон</span><select class="input" name="type">${Object.entries(STD[party]).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}${own.length ? `<optgroup label="Свои шаблоны">${own.map((t) => `<option value="tpl:${t.id}">${esc(t.title)}</option>`).join('')}</optgroup>` : ''}</select></label>
    <label class="f"><span>${party === 'employee' ? 'Сотрудники' : 'Исполнители'} (можно несколько — документы создадутся пакетом)</span>
      <div class="tbl-wrap" style="max-height:200px">${people.length ? `<table class="tbl"><tbody>${people.map((k) => `<tr><td style="width:30px"><input type="checkbox" name="c" value="${k.id}" ${preselect.includes(k.id) ? 'checked' : ''}></td><td>${esc(k.full_name)}</td><td class="muted small">${party === 'employee' ? esc(k.position || '') + (k.kedo_consent ? '' : ' · <span style="color:var(--amber)">нет согласия на КЭДО</span>') : CT[k.type]}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small" style="padding:12px">Список пуст</p>'}</div></label>
    <label class="f"><span>Предмет / описание</span><input class="input" name="subject" placeholder="${party === 'employee' ? 'Например: отпуск с 01.07 по 14.07' : 'Например: разработка дизайна баннеров'}"></label>
    <div class="cols-2e"><label class="f"><span>Сумма, ₽ ${party === 'employee' ? '(оклад)' : '(для акта/задания)'}</span><input class="input" name="amount" type="number" min="0" step="0.01"></label>
    <label class="f"><span>Срок / действует до</span><input class="input" name="until" placeholder="31.12.2026"></label></div>
    ${can('sign') ? '<label class="check" style="margin-bottom:16px"><input type="checkbox" name="sign_now" checked> Сразу подписать со стороны компании</label>' : '<p class="small muted">Документы подпишет владелец или бухгалтер.</p>'}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Создать</button></div>`;
    $$('[data-close]', m.el).forEach((b) => b.onclick = m.close);
  };
  $$('#pt button', m.el).forEach((b) => b.onclick = () => { party = b.dataset.p; preselect = []; draw(); });
  draw();
  $('#df', m.el).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const ids = $$('input[name=c]:checked', f).map((c) => +c.value);
    if (!ids.length) return toast('Выберите получателей', true);
    const body = { subject: f.subject.value, amount: f.amount.value, until: f.until.value, [party === 'employee' ? 'employee_ids' : 'contractor_ids']: ids };
    if (f.type.value.startsWith('tpl:')) body.template_id = +f.type.value.slice(4); else body.type = f.type.value;
    try {
      const r = await api('/api/documents', body);
      m.close(); toast(`Создано документов: ${r.created.length}`);
      if (r.errors && r.errors.length) modal(`<h3>Не создано: ${r.errors.length}</h3>${r.errors.map((x) => `<div class="risk-item block">${esc(x)}</div>`).join('')}<button class="btn btn-primary" data-close>Понятно</button>`);
      if (f.sign_now && f.sign_now.checked && r.created.length) signFlow(r.created, render); else render();
    } catch (err) { fail(err); }
  };
};

/* ---------- Выплаты ---------- */
on('/payouts', async (_, qy) => {
  const { payouts, registries } = await api('/api/payouts?' + new URLSearchParams(qy));
  const tab = qy.view || 'list';
  layout('Выплаты', `
    <div class="toolbar"><div class="tabs"><button data-v="list" class="${tab === 'list' ? 'on' : ''}">Все выплаты</button><button data-v="reg" class="${tab === 'reg' ? 'on' : ''}">Реестры</button></div>
      ${tab === 'list' ? `<div class="tabs">${[['', 'Все'], ['draft', 'Черновики'], ['processing', 'В обработке'], ['paid', 'Выплачено'], ['failed', 'Отклонено']].map(([k, t]) => `<button class="${(qy.status || '') === k ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>` : ''}
      <span class="spacer"></span>${can('export') ? '<a class="btn btn-ghost btn-sm" href="/api/export/payouts.csv">CSV</a><a class="btn btn-ghost btn-sm" href="/api/export/1c.csv">Выгрузка в 1С</a>' : ''}
      ${tab === 'list' && can('payouts.send') ? '<button class="btn btn-brand btn-sm" id="sendSel" disabled>Отправить выбранные</button>' : ''}</div>
    ${tab === 'list' ? `<div class="tbl-wrap">${payouts.length ? `<table class="tbl"><thead><tr><th><input type="checkbox" id="all"></th><th>Исполнитель</th><th>Назначение</th><th>Дата</th><th class="num">Сумма</th><th class="num">Налог</th><th class="num">Комиссия</th><th>Статус</th><th></th></tr></thead><tbody>
      ${payouts.map((p) => `<tr><td><input type="checkbox" class="sel" value="${p.id}" ${['draft', 'failed'].includes(p.status) ? '' : 'disabled'}></td><td><a href="#/contractors/${p.contractor_id}"><b>${esc(p.full_name)}</b></a><div class="small muted">${CT[p.ctype]}</div></td><td class="small">${esc(p.purpose || '')}</td><td>${fdate(p.paid_at || p.created_at)}</td>
      <td class="num"><b>${money(p.amount)}</b></td><td class="num muted">${p.tax ? money(p.tax) : '—'}</td><td class="num muted">${money(p.commission)}</td><td>${chip(PST, p.status)}${p.fail_reason ? `<div class="small" style="color:var(--red);max-width:220px">${esc(p.fail_reason)}</div>` : ''}</td>
      <td>${p.receipt_number ? `<a href="/receipt/${p.receipt_number}" target="_blank" class="small">Чек</a>` : p.status === 'draft' ? `<a href="#" class="small" data-cancel="${p.id}" style="color:var(--muted)">Отменить</a>` : ''}</td></tr>`).join('')}
    </tbody></table>` : emptyBox('Выплат нет', 'Создайте разовую выплату или загрузите реестр', '<button class="btn btn-primary" onclick="newPayout()">Новая выплата</button>')}</div>`
    : `<div class="tbl-wrap">${registries.length ? `<table class="tbl"><thead><tr><th>Реестр</th><th>Создан</th><th class="num">Выплат</th><th class="num">Сумма</th><th>Итог</th></tr></thead><tbody>${registries.map((r) => `<tr class="click" data-reg="${r.id}"><td><b>${esc(r.title)}</b></td><td>${fdate(r.created_at)}</td><td class="num">${r.n}</td><td class="num">${money(r.total)}</td><td>${r.paid ? `<span class="chip ok">${r.paid} выплачено</span> ` : ''}${r.failed ? `<span class="chip bad">${r.failed} отклонено</span>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyBox('Реестров нет', 'Загрузите CSV с выплатами')}</div>`}`,
    `<button class="btn btn-ghost btn-sm" onclick="importPayouts()">Реестр из CSV</button><button class="btn btn-primary btn-sm" onclick="newPayout()">Новая выплата</button>`);
  $$('[data-v]').forEach((b) => b.onclick = () => location.hash = '#/payouts?view=' + b.dataset.v);
  $$('[data-st]').forEach((b) => b.onclick = () => location.hash = '#/payouts?' + new URLSearchParams({ status: b.dataset.st }));
  $$('[data-reg]').forEach((r) => r.onclick = () => location.hash = '#/payouts?registry_id=' + r.dataset.reg);
  $$('[data-cancel]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await api(`/api/payouts/${a.dataset.cancel}/cancel`, {}).catch(fail); render(); });
  const upd = () => { const n = $$('.sel:checked').length; if ($('#sendSel')) { $('#sendSel').disabled = !n; $('#sendSel').textContent = n ? `Отправить выбранные (${n})` : 'Отправить выбранные'; } };
  $$('.sel').forEach((c) => c.onchange = upd);
  if ($('#all')) $('#all').onchange = (e) => { $$('.sel:not(:disabled)').forEach((c) => c.checked = e.target.checked); upd(); };
  if ($('#sendSel')) $('#sendSel').onclick = async (e) => { busy(e.target, true); try { const r = await api('/api/payouts/send', { ids: $$('.sel:checked').map((c) => +c.value) }); reportSend(r.results); } catch (err) { fail(err); } render(); };
  if ($$('.chip.info').length) setTimeout(() => { if (location.hash.startsWith('#/payouts')) render(); }, 2500);
});
function reportSend(results) {
  const okN = results.filter((r) => r.ok).length, bad = results.filter((r) => !r.ok);
  if (okN) toast(`Отправлено в банк: ${okN}`);
  if (bad.length) modal(`<h3>Не отправлено: ${bad.length}</h3>${bad.map((b) => `<div class="risk-item block">⛔ ${esc(b.error)}</div>`).join('')}<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" data-close>Понятно</button></div>`);
}
window.newPayout = async (prefill = [{}]) => {
  const { contractors } = await api('/api/contractors');
  if (!contractors.length) { toast('Сначала добавьте исполнителя', true); location.hash = '#/contractors'; return; }
  const opts = (sel) => contractors.map((k) => `<option value="${k.id}" ${+sel === k.id ? 'selected' : ''}>${esc(k.full_name)} · ${CT[k.type]}</option>`).join('');
  const m = modal(`<h3>Новая выплата</h3>
    <div id="rows"></div><button class="btn btn-ghost btn-sm" id="add">+ Ещё исполнитель</button>
    <label class="f" style="margin-top:14px"><span>Назначение</span><input class="input" id="purpose" value="Оплата услуг по акту"></label>
    <div id="prev" style="margin:10px 0"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-ghost" id="draft">В черновик</button>${can('payouts.send') ? '<button class="btn btn-primary" id="send">Выплатить</button>' : ''}</div>
    ${can('payouts.send') ? '' : '<p class="small muted" style="margin:10px 0 0;text-align:right">Отправить выплату может владелец или бухгалтер</p>'}`, { wide: true });
  const rowsEl = $('#rows', m.el);
  const addRow = (p = {}) => { const d = document.createElement('div'); d.className = 'pay-row'; d.innerHTML = `<select class="input">${opts(p.contractor_id)}</select><input class="input" type="number" min="1" step="0.01" placeholder="Сумма, ₽" value="${p.amount || ''}"><button class="icon-btn" title="Убрать">×</button>`; rowsEl.appendChild(d); d.querySelector('button').onclick = () => { d.remove(); preview(); }; $$('select,input', d).forEach((x) => x.addEventListener('input', preview)); };
  prefill.forEach(addRow);
  $('#add', m.el).onclick = () => addRow();
  const items = () => $$('.pay-row', rowsEl).map((r) => ({ contractor_id: +r.children[0].value, amount: +r.children[1].value })).filter((x) => x.amount > 0);
  let t; async function preview() {
    clearTimeout(t); t = setTimeout(async () => {
      const it = items(); if (!it.length) { $('#prev', m.el).innerHTML = ''; return; }
      try {
        const p = await api('/api/payouts/preview', { items: it });
        $('#prev', m.el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Исполнитель</th><th class="num">Сумма</th><th class="num">Налог</th><th class="num">Получит</th><th class="num">Комиссия</th><th>Проверки</th></tr></thead><tbody>
          ${p.items.map((i) => `<tr><td>${esc(i.full_name)}</td><td class="num">${money(i.amount, 2)}</td><td class="num" title="${esc(i.taxNote)}">${i.tax ? money(i.tax, 2) : '—'}</td><td class="num">${money(i.net, 2)}</td><td class="num">${money(i.commission, 2)}</td>
          <td>${i.risks.length ? i.risks.map((r) => `<div class="small" style="color:${r.level === 'block' ? 'var(--red)' : 'var(--amber)'}">${r.level === 'block' ? '⛔' : '⚠️'} ${esc(r.text)}</div>`).join('') : '<span class="chip ok">ОК</span>'}</td></tr>`).join('')}
          </tbody></table></div><div class="row between" style="margin-top:10px"><span class="muted">Баланс: ${money(p.balance, 2)}</span><b style="font-size:18px">Спишется: ${money(p.total, 2)}</b></div>
          ${p.enough ? '' : '<div class="risk-item block" style="margin-top:8px">Недостаточно средств. <a href="#/balance" style="color:inherit;font-weight:700">Пополнить баланс</a></div>'}`;
      } catch (e) { $('#prev', m.el).innerHTML = `<div class="risk-item block">${esc(e.message)}</div>`; }
    }, 250);
  }
  preview();
  const submit = async (send, btn) => {
    const it = items(); if (!it.length) return toast('Укажите сумму', true);
    busy(btn, true);
    try { const r = await api('/api/payouts', { items: it, purpose: $('#purpose', m.el).value, send }); m.close(); if (location.hash.startsWith('#/payouts')) render(); else location.hash = '#/payouts'; setTimeout(() => (send ? reportSend(r.results) : toast('Сохранено в черновики')), 50); }
    catch (e) { busy(btn, false); fail(e); }
  };
  if ($('#send', m.el)) $('#send', m.el).onclick = (e) => submit(true, e.target);
  $('#draft', m.el).onclick = (e) => submit(false, e.target);
};
window.importPayouts = async () => {
  const { contractors } = await api('/api/contractors');
  const m = modal(`<h3>Реестр выплат из CSV</h3><p class="muted">Колонки: <span class="mono">ИНН; Сумма; Назначение</span> (или ФИО вместо ИНН). Исполнители должны быть добавлены заранее.</p>
    <label class="f"><span>Название реестра</span><input class="input" id="title" value="Реестр от ${new Date().toLocaleDateString('ru-RU')}"></label>
    <input type="file" accept=".csv" class="input" style="padding:8px" id="file"><div id="prev" style="margin-top:14px"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-ghost" id="draft" disabled>В черновики</button>${can('payouts.send') ? '<button class="btn btn-primary" id="go" disabled>Проверить и выплатить</button>' : ''}</div>`, { wide: true });
  let items = [];
  $('#file', m.el).onchange = async (e) => {
    const data = parseCSV(await e.target.files[0].text()); const head = data.shift().map((h) => h.toLowerCase());
    const ci = head.findIndex((h) => h.includes('инн')), ni = head.findIndex((h) => h.includes('фио')), si = head.findIndex((h) => h.includes('сумм')), pi = head.findIndex((h) => h.includes('назнач'));
    const errors = [];
    items = data.map((r, i) => {
      const k = contractors.find((c) => (ci >= 0 && c.inn === (r[ci] || '').trim()) || (ni >= 0 && c.full_name.toLowerCase() === (r[ni] || '').trim().toLowerCase()));
      const amount = parseFloat(String(r[si] || '').replace(/\s/g, '').replace(',', '.'));
      if (!k) { errors.push(`Строка ${i + 2}: исполнитель не найден`); return null; }
      if (!(amount > 0)) { errors.push(`Строка ${i + 2}: некорректная сумма`); return null; }
      return { contractor_id: k.id, full_name: k.full_name, amount, purpose: pi >= 0 ? r[pi] : undefined };
    }).filter(Boolean);
    $('#prev', m.el).innerHTML = `${errors.map((x) => `<div class="risk-item block">${esc(x)}</div>`).join('')}<p><b>${items.length}</b> выплат на сумму <b>${money(items.reduce((s, i) => s + i.amount, 0), 2)}</b></p>`;
    $('#draft', m.el).disabled = !items.length; if ($('#go', m.el)) $('#go', m.el).disabled = !items.length;
  };
  const go = async (send, btn) => { busy(btn, true); try { const r = await api('/api/payouts', { items, registry_title: $('#title', m.el).value, send }); m.close(); location.hash = '#/payouts?view=reg'; setTimeout(() => (send ? reportSend(r.results) : toast('Реестр сохранён')), 50); } catch (e) { busy(btn, false); fail(e); } };
  if ($('#go', m.el)) $('#go', m.el).onclick = (e) => go(true, e.target); $('#draft', m.el).onclick = (e) => go(false, e.target);
};

/* ---------- Биржа заданий (компания) ---------- */
on('/tasks', async () => {
  const { tasks } = await api('/api/tasks');
  layout('Биржа заданий', `
    <p class="muted" style="max-width:720px">Опубликуйте задание: исполнители платформы откликнутся. Когда вы выберете исполнителя, договор и задание создадутся автоматически, а после приёмки — акт и выплата.</p>
    <div class="tbl-wrap">${tasks.length ? `<table class="tbl"><thead><tr><th>Задание</th><th>Категория</th><th>Срок</th><th class="num">Бюджет</th><th>Отклики</th><th>Исполнитель</th><th>Статус</th></tr></thead><tbody>
      ${tasks.map((t) => `<tr class="click" data-id="${t.id}"><td><b>${esc(t.title)}</b><div class="small muted">${esc(t.city || '')}</div></td><td>${esc(t.category)}</td><td>${t.deadline ? fdate(t.deadline) : '—'}</td><td class="num">${money(t.budget)}</td><td>${t.responses || '—'}</td><td>${esc(t.contractor_name || '—')}</td><td>${chip(TST, t.status)}</td></tr>`).join('')}
    </tbody></table>` : emptyBox('Заданий нет', 'Опубликуйте первое задание', '<button class="btn btn-primary" onclick="newTask()">Создать задание</button>')}</div>`,
    `<button class="btn btn-primary btn-sm" onclick="newTask()">Создать задание</button>`);
  $$('tr[data-id]').forEach((r) => r.onclick = () => location.hash = '#/tasks/' + r.dataset.id);
});
const CATS = ['Дизайн', 'Разработка', 'Маркетинг', 'Тексты', 'Клининг', 'Логистика', 'Курьеры', 'Строительство', 'Склад', 'Промо и event', 'Образование', 'Красота и фитнес', 'Другое'];
window.newTask = async () => {
  const { contractors } = await api('/api/contractors');
  const m = modal(`<h3>Новое задание</h3><form id="tf">
    <label class="f"><span>Название</span><input class="input" name="title" required placeholder="Например: дизайн 5 баннеров"></label>
    <label class="f"><span>Описание</span><textarea class="input" name="description" placeholder="Что нужно сделать, требования, результат"></textarea></label>
    <div class="cols-2e"><label class="f"><span>Категория</span><select class="input" name="category">${CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>
    <label class="f"><span>Бюджет, ₽</span><input class="input" name="budget" type="number" min="1" required></label></div>
    <div class="cols-2e"><label class="f"><span>Срок</span><input class="input" name="deadline" type="date"></label><label class="f"><span>Город</span><input class="input" name="city" value="Удалённо"></label></div>
    <label class="f"><span>Исполнитель</span><select class="input" name="contractor_id"><option value="">Опубликовать на бирже — собрать отклики</option>${contractors.map((k) => `<option value="${k.id}">Назначить: ${esc(k.full_name)}</option>`).join('')}</select></label>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Создать</button></div></form>`);
  $('#tf', m.el).onsubmit = async (e) => { e.preventDefault(); const d = formData(e.target); if (!d.contractor_id) delete d.contractor_id; try { const r = await api('/api/tasks', d); m.close(); toast(d.contractor_id ? 'Задание назначено, документы отправлены' : 'Задание опубликовано'); location.hash = '#/tasks/' + r.id; } catch (err) { fail(err); } };
};
on('/tasks/:id', async ({ id }) => {
  const { task: t, responses } = await api('/api/tasks/' + id);
  layout(`<a href="#/tasks" class="muted" style="font-weight:600">Биржа /</a> ${esc(t.title)}`, `
    <div class="cols-2">
      <div class="card"><div class="card-h"><h3>${esc(t.title)}</h3>${chip(TST, t.status)}</div>
        <p style="white-space:pre-wrap">${esc(t.description || 'Без описания')}</p>
        <dl class="dl"><dt>Категория</dt><dd>${esc(t.category)}</dd><dt>Бюджет</dt><dd>${money(t.budget)}</dd><dt>Срок</dt><dd>${t.deadline ? fdate(t.deadline) : '—'}</dd><dt>Город</dt><dd>${esc(t.city || '—')}</dd></dl>
        <div class="row wrap" style="margin-top:18px">
          ${['in_progress', 'review'].includes(t.status) ? '<button class="btn btn-brand" id="accept">Принять работу → акт и выплата</button>' : ''}
          ${t.contractor_id ? `<a class="btn btn-ghost" href="#/contractors/${t.contractor_id}">Карточка исполнителя</a>` : ''}
          ${['open', 'in_progress'].includes(t.status) ? '<button class="btn btn-ghost" id="cancel">Отменить задание</button>' : ''}
        </div></div>
      <div class="card"><h3>Отклики (${responses.length})</h3>
        ${responses.length ? responses.map((r) => `<div class="list-it"><span class="av">${initials(r.name || r.email)}</span><div style="flex:1"><b>${esc(r.name || r.email)}</b><div class="small muted">${esc(r.message || '')}</div>${r.price ? `<div class="small"><b>${money(r.price)}</b></div>` : ''}</div>
          ${t.status === 'open' ? `<button class="btn btn-primary btn-sm" data-pick="${r.id}">Выбрать</button>` : r.status === 'accepted' ? '<span class="chip ok">Выбран</span>' : ''}</div>`).join('') : emptyBox('Пока нет откликов', t.status === 'open' ? 'Задание видно всем исполнителям платформы' : '')}</div>
    </div>`);
  $$('[data-pick]').forEach((b) => b.onclick = async () => { try { await api(`/api/tasks/${t.id}/assign`, { response_id: +b.dataset.pick }); toast('Исполнитель выбран. Договор и задание отправлены на подпись'); render(); } catch (e) { fail(e); } });
  if ($('#accept')) $('#accept').onclick = async () => {
    try {
      const r = await api(`/api/tasks/${t.id}/accept`, {});
      const m = modal(`<h3>Работа принята</h3><p>Акт создан, выплата подготовлена. Подпишите акт и отправьте оплату.</p><div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" data-close>Позже</button><button class="btn btn-brand" id="go">Подписать акт и выплатить</button></div>`);
      $('#go', m.el).onclick = () => { m.close(); signFlow([r.act_id], async () => { const s = await api('/api/payouts/send', { ids: [r.payout_id] }); reportSend(s.results); render(); }); };
      render();
    } catch (e) { fail(e); }
  };
  if ($('#cancel')) $('#cancel').onclick = async () => { await api(`/api/tasks/${t.id}/cancel`, {}).catch(fail); render(); };
});

/* ---------- Аутстаффинг ---------- */
on('/outstaff', async () => {
  const { requests } = await api('/api/outstaff');
  layout('Подбор персонала', `
    <div class="cols-2">
      <div class="tbl-wrap">${requests.length ? `<table class="tbl"><thead><tr><th>Специальность</th><th>Человек</th><th>Старт</th><th>Срок</th><th>Ставка</th><th>Статус</th></tr></thead><tbody>${requests.map((r) => `<tr><td><b>${esc(r.role)}</b><div class="small muted">${esc(r.city || '')} ${esc(r.description || '')}</div></td><td>${r.headcount}</td><td>${r.start_date ? fdate(r.start_date) : '—'}</td><td>${esc(r.duration || '—')}</td><td>${esc(r.rate || '—')}</td><td>${chip(OST, r.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Заявок нет', 'Опишите, кто вам нужен, — подберём за 1–3 дня')}</div>
      <div class="card"><h3>Новая заявка</h3><form id="of">
        <label class="f"><span>Кто нужен</span><input class="input" name="role" required placeholder="Комплектовщик, промоутер, курьер…"></label>
        <div class="cols-2e"><label class="f"><span>Сколько человек</span><input class="input" name="headcount" type="number" min="1" value="1"></label><label class="f"><span>Старт</span><input class="input" name="start_date" type="date"></label></div>
        <div class="cols-2e"><label class="f"><span>Срок работ</span><input class="input" name="duration" placeholder="2 недели"></label><label class="f"><span>Ставка</span><input class="input" name="rate" placeholder="от 700 ₽/час"></label></div>
        <label class="f"><span>Город / адрес</span><input class="input" name="city"></label>
        <label class="f"><span>Требования</span><textarea class="input" name="description"></textarea></label>
        <button class="btn btn-primary" style="width:100%">Отправить заявку</button></form>
        <p class="small muted" style="margin:12px 0 0">Подобранные люди появятся у вас в «Исполнителях» с подписанными договорами.</p></div>
    </div>`);
  $('#of').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/outstaff', formData(e.target)); toast('Заявка принята'); render(); } catch (err) { fail(err); } };
});

/* ---------- Сплит ---------- */
on('/splits', async () => {
  const { splits } = await api('/api/splits');
  layout('Сплит-платежи', `
    <p class="muted" style="max-width:760px">Выставьте клиенту ссылку на оплату. После оплаты деньги автоматически распределятся между исполнителями по долям, а агентское вознаграждение останется на вашем балансе.</p>
    <div class="tbl-wrap">${splits.length ? `<table class="tbl"><thead><tr><th>Назначение</th><th class="num">Сумма</th><th>Агентское</th><th>Получатели</th><th>Статус</th><th>Ссылка</th></tr></thead><tbody>${splits.map((s) => `<tr><td><b>${esc(s.title)}</b><div class="small muted">${fdate(s.created_at)}${s.payer_name ? ' · ' + esc(s.payer_name) : ''}</div></td><td class="num">${money(s.amount)}</td><td>${s.agency_fee_pct}% · ${money(s.amount * s.agency_fee_pct / 100)}</td><td class="small">${s.parts.map((p) => `${esc(p.full_name)} — ${p.share_pct}%`).join('<br>')}</td><td>${chip(SST, s.status)}</td><td><a href="/pay/${s.token}" target="_blank" class="small">Открыть</a> · <a href="#" class="small" data-copy="${location.origin}/pay/${s.token}">Копировать</a></td></tr>`).join('')}</tbody></table>` : emptyBox('Сплитов нет', 'Создайте ссылку на оплату', '<button class="btn btn-primary" onclick="newSplit()">Создать</button>')}</div>`,
    `<button class="btn btn-primary btn-sm" onclick="newSplit()">Новый сплит</button>`);
  $$('[data-copy]').forEach((a) => a.onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(a.dataset.copy).then(() => toast('Ссылка скопирована')); });
});
window.newSplit = async () => {
  const { contractors } = await api('/api/contractors');
  const m = modal(`<h3>Новый сплит-платёж</h3><form id="sf">
    <label class="f"><span>Назначение платежа</span><input class="input" name="title" required placeholder="Свадебная съёмка 12.12"></label>
    <div class="cols-2e"><label class="f"><span>Сумма для клиента, ₽</span><input class="input" name="amount" type="number" min="1" required></label><label class="f"><span>Агентское вознаграждение, %</span><input class="input" name="agency_fee_pct" type="number" min="0" max="99" step="0.1" value="15"></label></div>
    <span class="small" style="font-weight:600">Получатели и доли (сумма = 100%)</span><div id="parts" style="margin-top:6px"></div>
    <button type="button" class="btn btn-ghost btn-sm" id="add">+ Получатель</button><div id="sum" class="small muted" style="margin:10px 0"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Создать ссылку</button></div></form>`, { wide: true });
  const parts = $('#parts', m.el);
  const sum = () => { const s = $$('.split-row input', parts).reduce((a, i) => a + (+i.value || 0), 0); $('#sum', m.el).innerHTML = `Сумма долей: <b style="color:${Math.abs(s - 100) < .01 ? 'var(--brand)' : 'var(--red)'}">${s}%</b>`; };
  const add = (share = '') => { const d = document.createElement('div'); d.className = 'split-row'; d.innerHTML = `<select class="input">${contractors.map((k) => `<option value="${k.id}">${esc(k.full_name)}</option>`).join('')}</select><input class="input" type="number" min="1" max="100" placeholder="%" value="${share}"><button type="button" class="icon-btn">×</button>`; parts.appendChild(d); d.querySelector('button').onclick = () => { d.remove(); sum(); }; d.querySelector('input').oninput = sum; sum(); };
  add(100); $('#add', m.el).onclick = () => add();
  $('#sf', m.el).onsubmit = async (e) => {
    e.preventDefault(); const d = formData(e.target);
    d.parts = $$('.split-row', parts).map((r) => ({ contractor_id: +r.children[0].value, share_pct: +r.children[1].value }));
    try { const r = await api('/api/splits', d); m.close(); const url = location.origin + r.url;
      modal(`<h3>Ссылка на оплату готова</h3><div class="keybox">${esc(url)}</div><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${url}')">Копировать</button><a class="btn btn-primary" href="${r.url}" target="_blank">Открыть страницу оплаты</a></div>`);
      render(); } catch (err) { fail(err); }
  };
};

/* ---------- Баланс ---------- */
on('/balance', async () => {
  const b = await api('/api/balance');
  const TT = { topup: 'Пополнение', payout: 'Выплата', commission: 'Комиссия', tax: 'Налог', refund: 'Возврат', split_in: 'Сплит: поступление' };
  layout('Баланс', `
    <div class="kpis"><div class="kpi ink"><span>Доступно для выплат</span><b>${money(b.balance, 2)}</b><small>Номинальный счёт в банке-партнёре</small></div>
      <div class="kpi"><span>Пополнено всего</span><b>${money(b.transactions.filter((t) => t.type === 'topup').reduce((s, t) => s + t.amount, 0))}</b></div>
      <div class="kpi"><span>Комиссии</span><b>${money(-b.transactions.filter((t) => t.type === 'commission').reduce((s, t) => s + t.amount, 0))}</b></div>
      <div class="kpi"><span>Неоплаченные счета</span><b>${b.invoices.filter((i) => i.status === 'issued').length}</b></div></div>
    <div class="cols-2">
      <div class="card"><h3>Операции</h3>${b.transactions.length ? `<table class="tbl"><tbody>${b.transactions.map((t) => `<tr><td>${fdate(t.created_at, true)}</td><td><span class="chip plain">${TT[t.type] || t.type}</span></td><td class="small">${esc(t.description)}</td><td class="num" style="color:${t.amount > 0 ? 'var(--brand-2)' : 'inherit'}"><b>${t.amount ? (t.amount > 0 ? '+' : '') + money(t.amount, 2) : '—'}</b></td></tr>`).join('')}</tbody></table>` : emptyBox('Операций нет', '')}</div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Пополнить</h3><form id="inv"><label class="f"><span>Сумма, ₽</span><input class="input" name="amount" type="number" min="1000" step="0.01" required value="100000"></label><button class="btn btn-primary" style="width:100%">Выставить счёт</button></form>
          <p class="small muted" style="margin:12px 0 0">Оплатите счёт с расчётного счёта компании. Деньги зачисляются автоматически по выписке банка.</p></div>
        <div class="card"><h3>Счета</h3>${b.invoices.length ? b.invoices.map((i) => `<div class="list-it"><div style="flex:1"><a href="/invoice/${i.id}" target="_blank"><b>${esc(i.number)}</b></a><div class="small muted">${fdate(i.created_at)} · ${money(i.amount)}</div></div>${i.status === 'paid' ? '<span class="chip ok">Оплачен</span>' : b.demo ? `<button class="btn btn-ghost btn-sm" data-pay="${i.id}" title="Демо: эмулировать поступление">Эмулировать оплату</button>` : '<span class="chip info">Ожидает поступления</span>'}</div>`).join('') : '<p class="muted small">Счетов нет</p>'}</div>
      </div></div>`);
  $('#inv').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/invoices', formData(e.target)); window.open('/invoice/' + r.id, '_blank'); render(); } catch (err) { fail(err); } };
  $$('[data-pay]').forEach((bt) => bt.onclick = async () => { try { await api(`/api/invoices/${bt.dataset.pay}/pay`, {}); toast('Деньги зачислены'); render(); } catch (e) { fail(e); } });
});

/* ---------- Интеграции ---------- */
on('/integrations', async () => {
  const d = await api('/api/integrations');
  layout('Интеграции и API', `
    <div class="cols-2e">
      <div class="card"><div class="card-h"><h3>Ключи API</h3><a href="/developers" target="_blank" class="small">Документация →</a></div>
        ${d.keys.length ? d.keys.map((k) => `<div class="list-it"><div style="flex:1"><b>${esc(k.title)}</b><div class="mono small muted">${esc(k.prefix)}…${esc(k.last4)} · ${k.last_used_at ? 'использован ' + fdate(k.last_used_at, true) : 'не использовался'}</div></div><button class="btn btn-danger btn-sm" data-del="${k.id}">Отозвать</button></div>`).join('') : '<p class="muted">Ключей нет</p>'}
        <form id="kf" class="row" style="margin-top:12px"><input class="input" name="title" placeholder="Название, например «CRM»"><button class="btn btn-primary">Создать</button></form>
        <p class="small muted" style="margin:10px 0 0">Ключ показывается один раз и хранится у нас только в виде хеша.</p></div>
      <div class="card"><h3>Вебхуки</h3><p class="small muted">События: payout.paid, payout.failed, document.signed. До 6 повторов при ошибке.</p>
        <form id="wf" class="row"><input class="input" name="url" placeholder="https://your-crm.ru/hooks/payout" value="${esc(d.webhook_url || '')}"><button class="btn btn-primary">Сохранить</button></form>
        <div class="row wrap" style="margin-top:10px"><button class="btn btn-ghost btn-sm" id="test">Тестовое событие</button><button class="btn btn-ghost btn-sm" id="rot">Новый секрет подписи</button><span class="small muted">Секрет: <span class="mono">${esc(d.webhook_secret_hint || '—')}</span></span></div>
        <details style="margin-top:10px"><summary class="small" style="cursor:pointer">Как проверить подпись</summary><div class="code" style="margin-top:8px;font-size:12px">sig = HMAC_SHA256(secret, X-PayOut-Timestamp + "." + body)
assert "sha256=" + hex(sig) == X-PayOut-Signature</div></details>
        ${d.logs.length ? `<table class="tbl" style="margin-top:12px"><tbody>${d.logs.map((l) => `<tr><td class="small">${fdate(l.created_at, true)}</td><td class="mono small">${esc(l.event)}</td><td class="small">#${l.attempt}</td><td class="small">${esc(l.status)}</td></tr>`).join('')}</tbody></table>` : ''}</div>
      <div class="card"><h3>1С и Excel</h3><p class="muted small">Импорт исполнителей и реестров из CSV, выгрузка проведённых выплат для 1С.</p><div class="row wrap"><a class="btn btn-ghost btn-sm" href="/api/export/1c.csv">Выгрузка для 1С</a><a class="btn btn-ghost btn-sm" href="/api/export/payouts.csv">Все выплаты CSV</a><a class="btn btn-ghost btn-sm" href="/api/export/contractors.csv">Исполнители CSV</a></div></div>
      <div class="card"><h3>Госключ и White Label</h3><p class="muted small">Способ подписи и брендирование кабинета — в <a href="#/settings">Настройках</a>. White Label доступен на тарифе «Корпорация».</p></div>
    </div>`);
  $('#kf').onsubmit = async (e) => { e.preventDefault(); const r = await api('/api/integrations/keys', formData(e.target)).catch(fail); if (!r) return; const m = modal(`<h3>Ключ создан</h3><p class="muted">Скопируйте его сейчас — позже он будет недоступен.</p><div class="keybox">${esc(r.key)}</div><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn btn-primary" id="cp">Скопировать и закрыть</button></div>`); $('#cp', m.el).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(r.key); m.close(); render(); }; };
  $$('[data-del]').forEach((b) => b.onclick = async () => { if (!confirmBox('Отозвать ключ? Интеграции, которые его используют, перестанут работать.')) return; await api('/api/integrations/keys/' + b.dataset.del, undefined, 'DELETE').catch(fail); render(); });
  $('#wf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/integrations/webhook', formData(e.target), 'PUT'); toast('Сохранено'); render(); } catch (err) { fail(err); } };
  $('#test').onclick = async () => { await api('/api/integrations/webhook/test', {}).catch(fail); toast('Событие поставлено в очередь'); setTimeout(render, 1500); };
  $('#rot').onclick = async () => { const r = await api('/api/integrations/webhook/secret', {}).catch(fail); if (r) modal(`<h3>Новый секрет</h3><p class="muted">Обновите его в своей системе. Старый больше не действует.</p><div class="keybox">${esc(r.secret)}</div><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn btn-primary" data-close>Готово</button></div>`); };
});
const confirmBox = (t) => window.confirm(t);

/* ---------- Команда ---------- */
on('/team', async () => {
  const { users, roles, perms } = await api('/api/team');
  const PN = { view: 'просмотр', contractors: 'исполнители', documents: 'документы', sign: 'подпись', payouts: 'выплаты', 'payouts.send': 'отправка выплат', balance: 'баланс', splits: 'сплиты', export: 'выгрузки', employees: 'сотрудники', audit: 'журнал', tasks: 'биржа', outstaff: 'подбор' };
  const owner = ME.team_role === 'owner';
  layout('Команда', `<div class="cols-2">
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Сотрудник</th><th>Роль</th><th>2FA</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><div class="person"><span class="av">${initials(u.name || u.email)}</span><div><b>${esc(u.name || '—')}</b><span>${esc(u.email)}</span></div></div></td>
      <td>${owner && u.id !== ME.id ? `<select class="input" style="height:34px;width:auto" data-role="${u.id}">${Object.entries(roles).map(([k, t]) => `<option value="${k}" ${u.team_role === k ? 'selected' : ''}>${t}</option>`).join('')}</select>` : roles[u.team_role]}</td>
      <td>${u.totp_enabled ? '<span class="chip ok">вкл</span>' : '<span class="chip plain">нет</span>'}</td>
      <td>${owner && u.id !== ME.id ? `<button class="btn btn-ghost btn-sm" data-block="${u.id}" data-v="${u.blocked ? 0 : 1}">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button>` : u.id === ME.id ? '<span class="small muted">это вы</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="grid" style="align-content:start">
    ${owner ? `<div class="card"><h3>Пригласить</h3><form id="tf"><label class="f"><span>Email</span><input class="input" name="email" type="email" required></label><label class="f"><span>Имя</span><input class="input" name="name"></label>
      <label class="f"><span>Роль</span><select class="input" name="team_role"><option value="accountant">Бухгалтер</option><option value="manager">Менеджер</option><option value="owner">Владелец</option></select></label><button class="btn btn-primary" style="width:100%">Отправить приглашение</button></form></div>` : ''}
    <div class="card"><h3>Права ролей</h3>${Object.entries(roles).map(([k, t]) => `<div class="list-it" style="align-items:flex-start"><b style="width:100px;flex:none">${t}</b><span class="small muted">${perms[k].includes('*') ? 'все права, включая настройки, API и команду' : perms[k].map((x) => PN[x] || x).join(', ')}</span></div>`).join('')}</div></div></div>`);
  if ($('#tf')) $('#tf').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/team', formData(e.target)); modal(`<h3>Приглашение отправлено</h3><p>На ${esc(r.email)} ушло письмо со ссылкой для установки пароля.</p>${r.invite_link ? `<div class="demo-hint">Демо-режим: <a href="${r.invite_link}" target="_blank">ссылка из письма</a></div>` : ''}<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn btn-primary" data-close>Готово</button></div>`); render(); } catch (err) { fail(err); } };
  $$('[data-role]').forEach((sel) => sel.onchange = async () => { try { await api('/api/team/' + sel.dataset.role, { team_role: sel.value }, 'PUT'); toast('Роль изменена'); } catch (err) { fail(err); render(); } });
  $$('[data-block]').forEach((b) => b.onclick = async () => { await api('/api/team/' + b.dataset.block, { blocked: !!+b.dataset.v }, 'PUT').catch(fail); render(); });
});

/* ---------- Настройки ---------- */
on('/settings', async () => {
  const { company: c, plans } = await api('/api/company');
  const owner = can('settings');
  const f = (n, l, v, extra = '') => `<label class="f"><span>${l}</span><input class="input" name="${n}" value="${esc(v || '')}" ${extra} ${owner ? '' : 'disabled'}></label>`;
  layout('Настройки', `${owner ? '' : '<div class="risk-item warn" style="margin-bottom:14px">Изменять настройки может только владелец.</div>'}<div class="cols-2">
    <div class="card"><h3>Реквизиты компании</h3><form id="rf">
      ${f('name', 'Название', c.name, 'required')}<div class="cols-2e">${f('inn', 'ИНН', c.inn)}${f('kpp', 'КПП', c.kpp)}</div>
      <div class="cols-2e">${f('ogrn', 'ОГРН', c.ogrn)}${f('director', 'Подписант (в лице…)', c.director)}</div>${f('address', 'Юридический адрес', c.address)}
      <div class="cols-2e">${f('bank', 'Банк', c.bank)}${f('bik', 'БИК', c.bik)}</div>${f('account', 'Расчётный счёт', c.account)}
      <h3 style="margin-top:12px">Выплаты и уведомления</h3>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" name="tax_service" ${c.tax_service ? 'checked' : ''} ${owner ? '' : 'disabled'}> Удерживать и уплачивать НПД 6% за самозанятых</label>
      ${f('notify_emails', 'Email для уведомлений о выплатах (через запятую)', c.notify_emails, 'placeholder="buh@company.ru, ceo@company.ru"')}
      <label class="f"><span>Способ подписи документов компанией</span><select class="input" name="sign_method" ${owner ? '' : 'disabled'}><option value="sms" ${c.sign_method === 'sms' ? 'selected' : ''}>ПЭП — код по SMS</option><option value="gosklyuch" ${c.sign_method === 'gosklyuch' ? 'selected' : ''}>Госключ</option></select></label>
      <h3 style="margin-top:12px">White Label ${c.plan === 'enterprise' ? '' : '<span class="chip plain">тариф «Корпорация»</span>'}</h3>
      <div class="cols-2e">${f('brand_name', 'Название в кабинете', c.brand_name, `placeholder="Ваш бренд" ${c.plan === 'enterprise' ? '' : 'disabled'}`)}<label class="f"><span>Цвет бренда</span><input class="input" type="color" name="brand_color" value="${esc(c.brand_color || '#0F766E')}" style="padding:4px" ${owner ? '' : 'disabled'}></label></div>
      ${owner ? '<button class="btn btn-primary">Сохранить</button>' : ''}</form></div>
    <div class="card" style="align-self:start"><h3>Тариф</h3>${Object.entries(plans).map(([k, p]) => `<div class="list-it"><div style="flex:1"><b>${p.name}</b><div class="small muted">${p.fee}% · ${p.monthly ? p.monthly.toLocaleString('ru-RU') + ' ₽/мес' : 'без абонплаты'}</div></div>${c.plan === k ? '<span class="chip ok">Текущий</span>' : owner ? `<button class="btn btn-ghost btn-sm" data-plan="${k}">Перейти</button>` : ''}</div>`).join('')}<a href="/tariffs" target="_blank" class="small">Сравнить тарифы →</a></div></div>`);
  $('#rf').onsubmit = async (e) => { e.preventDefault(); const d = formData(e.target); d.tax_service = !!d.tax_service; if (c.plan !== 'enterprise') delete d.brand_name; try { await api('/api/company', d, 'PUT'); ME = await api('/api/me'); toast('Сохранено'); render(); } catch (err) { fail(err); } };
  $$('[data-plan]').forEach((b) => b.onclick = async () => { await api('/api/company/plan', { plan: b.dataset.plan }).catch(fail); toast('Тариф изменён'); render(); });
});

/* ---------- Безопасность (все роли) ---------- */
on('/security', async () => {
  const { sessions } = await api('/api/auth/sessions');
  layout('Безопасность', `<div class="cols-2e">
    <div class="card"><h3>Двухфакторная аутентификация</h3>
      ${ME.totp_enabled ? `<p><span class="chip ok">Включена</span></p><p class="small muted">При входе запрашивается код из приложения.</p><form id="d2"><div class="cols-2e"><label class="f"><span>Пароль</span><input class="input" name="password" type="password" required></label><label class="f"><span>Код из приложения</span><input class="input mono" name="code" maxlength="6" required></label></div><button class="btn btn-danger">Отключить 2FA</button></form>`
        : `<p class="small muted">Защитите вход кодом из Google Authenticator, Яндекс Ключа или 1Password. Особенно важно для владельца и бухгалтера.</p><button class="btn btn-primary" id="s2">Включить 2FA</button><div id="s2box"></div>`}</div>
    <div class="card"><h3>Смена пароля</h3><form id="pw"><label class="f"><span>Текущий пароль</span><input class="input" name="current" type="password" required autocomplete="current-password"></label><label class="f"><span>Новый пароль</span><input class="input" name="password" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn btn-primary">Сменить</button></form><p class="small muted" style="margin:10px 0 0">Другие сеансы будут завершены.</p></div>
    <div class="card" style="grid-column:1/-1"><div class="card-h"><h3>Активные сеансы</h3><button class="btn btn-ghost btn-sm" id="la">Выйти на всех других устройствах</button></div>
      <table class="tbl"><tbody>${sessions.map((x) => `<tr><td class="small">${esc((x.ua || '').slice(0, 80) || '—')}</td><td class="mono small">${esc(x.ip || '')}</td><td class="small">${fdate(x.last_seen, true)}</td><td>${x.current ? '<span class="chip ok">текущий</span>' : `<button class="btn btn-ghost btn-sm" data-s="${x.id}">Завершить</button>`}</td></tr>`).join('')}</tbody></table></div></div>`);
  if ($('#s2')) $('#s2').onclick = async () => {
    const r = await api('/api/auth/2fa/setup', {}).catch(fail); if (!r) return;
    $('#s2box').innerHTML = `<ol class="small" style="padding-left:18px;margin:14px 0"><li>Откройте приложение-аутентификатор и добавьте аккаунт вручную.</li><li>Введите секрет:<div class="keybox" style="margin:6px 0">${esc(r.secret.match(/.{1,4}/g).join(' '))}</div>или откройте <a href="${esc(r.otpauth)}">otpauth-ссылку</a> на телефоне.</li><li>Введите 6-значный код из приложения:</li></ol>
      <form id="e2" class="row"><input class="input mono" name="code" maxlength="6" inputmode="numeric" required style="max-width:160px"><button class="btn btn-brand">Подтвердить</button></form>`;
    $('#e2').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/2fa/enable', { code: e.target.code.value }); ME = await api('/api/me'); toast('2FA включена'); render(); } catch (err) { fail(err); } };
  };
  if ($('#d2')) $('#d2').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/2fa/disable', formData(e.target)); ME = await api('/api/me'); toast('2FA отключена'); render(); } catch (err) { fail(err); } };
  $('#pw').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/password/change', formData(e.target)); toast('Пароль изменён'); render(); } catch (err) { fail(err); } };
  $('#la').onclick = async () => { const r = await api('/api/auth/logout-all', {}).catch(fail); if (r) { toast(`Завершено сеансов: ${r.closed}`); render(); } };
  $$('[data-s]').forEach((b) => b.onclick = async () => { await api('/api/auth/sessions/' + b.dataset.s, undefined, 'DELETE').catch(fail); render(); });
});

/* ---------- Шаблоны документов ---------- */
on('/templates', async () => {
  const { templates, placeholders } = await api('/api/templates');
  layout('Шаблоны документов', `<div class="cols-2">
    <div class="tbl-wrap">${templates.length ? `<table class="tbl"><thead><tr><th>Шаблон</th><th>Для кого</th><th>Создан</th><th></th></tr></thead><tbody>${templates.map((t) => `<tr class="click" data-id="${t.id}"><td><b>${esc(t.title)}</b></td><td>${t.party === 'employee' ? 'Сотрудники' : 'Исполнители'}</td><td>${fdate(t.created_at)}</td><td>${can('documents') ? `<a href="#" class="small" data-del="${t.id}" style="color:var(--muted)">Удалить</a>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyBox('Своих шаблонов нет', 'Встроенные шаблоны: договор, акт, задание, NDA, кадровые документы. Добавьте свои — например, договор на фотосъёмку.')}</div>
    <div class="card"><h3>Как это работает</h3><p class="small">Пишите обычным текстом. Пустая строка — новый абзац, <span class="mono"># </span> — заголовок, <span class="mono">## </span> — подзаголовок. Подстановки:</p>
      <div class="pill-row">${placeholders.map((p) => `<span class="chip plain mono">{{${esc(p)}}}</span>`).join('')}</div>
      ${can('documents') ? '<button class="btn btn-primary" style="margin-top:16px" id="new">Новый шаблон</button>' : ''}</div></div>`, can('documents') ? '<button class="btn btn-primary btn-sm" id="new2">Новый шаблон</button>' : '');
  const edit = (t = { title: '', body: '# ДОГОВОР № {{номер}}\n\n{{дата}}\n\n{{компания}} и {{фио}} договорились: {{предмет}}.\n\nСтоимость: {{сумма}}.', party: 'contractor' }) => {
    const m = modal(`<h3>${t.id ? 'Редактирование шаблона' : 'Новый шаблон'}</h3><form id="tf"><div class="cols-2e"><label class="f"><span>Название</span><input class="input" name="title" required value="${esc(t.title)}"></label>
      <label class="f"><span>Для кого</span><select class="input" name="party"><option value="contractor" ${t.party === 'contractor' ? 'selected' : ''}>Исполнители</option><option value="employee" ${t.party === 'employee' ? 'selected' : ''}>Сотрудники</option></select></label></div>
      <div class="cols-2e"><label class="f"><span>Текст</span><textarea class="input mono" name="body" style="min-height:320px;font-size:13px">${esc(t.body)}</textarea></label><div><span class="small" style="font-weight:600">Предпросмотр</span><div id="pv" style="border:1px solid var(--line);border-radius:10px;padding:14px;height:320px;overflow:auto;font-family:'Times New Roman',serif;font-size:14px;margin-top:6px"></div></div></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Сохранить</button></div></form>`, { wide: true });
    let tm; const pv = () => { clearTimeout(tm); tm = setTimeout(async () => { const r = await api('/api/templates/preview', { body: $('#tf', m.el).body.value }).catch(() => null); if (r) $('#pv', m.el).innerHTML = r.html; }, 250); };
    $('#tf', m.el).body.oninput = pv; pv();
    $('#tf', m.el).onsubmit = async (e) => { e.preventDefault(); try { await api(t.id ? '/api/templates/' + t.id : '/api/templates', formData(e.target), t.id ? 'PUT' : 'POST'); m.close(); toast('Шаблон сохранён'); render(); } catch (err) { fail(err); } };
  };
  ['#new', '#new2'].forEach((id) => { if ($(id)) $(id).onclick = () => edit(); });
  $$('tr[data-id]').forEach((r) => r.onclick = (e) => { if (e.target.dataset.del) return; if (can('documents')) edit(templates.find((t) => t.id === +r.dataset.id)); });
  $$('[data-del]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); if (!confirmBox('Удалить шаблон?')) return; await api('/api/templates/' + a.dataset.del, undefined, 'DELETE'); render(); });
});

/* ---------- Сотрудники (КЭДО) ---------- */
on('/employees', async () => {
  const { employees } = await api('/api/employees');
  layout('Сотрудники · КЭДО', `<p class="muted" style="max-width:760px">Кадровый электронный документооборот по ст. 22.1–22.3 ТК РФ. Сотрудник получает приглашение и первым подписывает согласие на КЭДО. После этого ему можно отправлять трудовой договор, приказы и листы ознакомления.</p>
    <div class="tbl-wrap">${employees.length ? `<table class="tbl"><thead><tr><th>Сотрудник</th><th>Должность</th><th>Принят</th><th>Согласие на КЭДО</th><th>Ждут подписи</th></tr></thead><tbody>${employees.map((e) => `<tr class="click" data-id="${e.id}"><td><div class="person"><span class="av">${initials(e.full_name)}</span><div><b>${esc(e.full_name)}</b><span>${esc(e.email || e.phone || '')}</span></div></div></td><td>${esc(e.position || '—')}<div class="small muted">${esc(e.department || '')}</div></td><td>${e.hired_at ? fdate(e.hired_at) : '—'}</td><td>${e.kedo_consent ? '<span class="chip ok">Подписано</span>' : '<span class="chip warn">Ожидается</span>'}</td><td>${e.pending_docs || '—'}</td></tr>`).join('')}</tbody></table>` : emptyBox('Сотрудников нет', 'Добавьте сотрудника — он получит приглашение и согласие на КЭДО', can('employees') ? '<button class="btn btn-primary" onclick="addEmployee()">Добавить сотрудника</button>' : '')}</div>`,
    can('employees') ? `<button class="btn btn-ghost btn-sm" onclick="newDocument([], 'employee')">Кадровый документ</button><button class="btn btn-primary btn-sm" onclick="addEmployee()">Добавить</button>` : '');
  $$('tr[data-id]').forEach((r) => r.onclick = () => location.hash = '#/employees/' + r.dataset.id);
});
window.addEmployee = () => {
  const m = modal(`<h3>Новый сотрудник</h3><form id="ef"><label class="f"><span>ФИО</span><input class="input" name="full_name" required></label>
    <div class="cols-2e"><label class="f"><span>Должность</span><input class="input" name="position"></label><label class="f"><span>Подразделение</span><input class="input" name="department"></label></div>
    <div class="cols-2e"><label class="f"><span>Email</span><input class="input" name="email" type="email"></label><label class="f"><span>Телефон</span><input class="input" name="phone"></label></div>
    <div class="cols-2e"><label class="f"><span>Дата приёма</span><input class="input" name="hired_at" type="date"></label><label class="f"><span>СНИЛС</span><input class="input mono" name="snils"></label></div>
    <p class="small muted">Сотруднику уйдёт приглашение и согласие на КЭДО — первый документ, который он подпишет.</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Добавить</button></div></form>`);
  $('#ef', m.el).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/employees', formData(e.target)); m.close(); toast('Сотрудник добавлен, согласие отправлено'); location.hash = '#/employees/' + r.id; } catch (err) { fail(err); } };
};
on('/employees/:id', async ({ id }) => {
  const { employee: e, documents } = await api('/api/employees/' + id);
  layout(`<a href="#/employees" class="muted" style="font-weight:600">Сотрудники /</a> ${esc(e.full_name)}`, `<div class="cols-2">
    <div class="card"><h3>Кадровые документы</h3>${documents.length ? `<table class="tbl"><tbody>${documents.map((x) => `<tr class="click" data-doc="${x.id}"><td>${esc(x.title)}</td><td>${fdate(x.created_at)}</td><td>${chip(DOCST, x.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Документов нет', '')}
      ${can('employees') ? `<button class="btn btn-primary btn-sm" style="margin-top:14px" id="nd" ${e.kedo_consent ? '' : 'disabled title="Сначала сотрудник должен подписать согласие на КЭДО"'}>Новый документ</button>` : ''}</div>
    <div class="card" style="align-self:start"><dl class="dl"><dt>Должность</dt><dd>${esc(e.position || '—')}</dd><dt>Подразделение</dt><dd>${esc(e.department || '—')}</dd><dt>Email</dt><dd>${esc(e.email || '—')}</dd><dt>Телефон</dt><dd>${esc(e.phone || '—')}</dd><dt>Принят</dt><dd>${e.hired_at ? fdate(e.hired_at) : '—'}</dd><dt>Согласие на КЭДО</dt><dd>${e.kedo_consent ? 'подписано' : 'ожидается'}</dd><dt>Аккаунт</dt><dd>${e.user_id ? 'подключён' : 'приглашение отправлено'}</dd></dl></div></div>`);
  $$('[data-doc]').forEach((r) => r.onclick = () => viewDoc(r.dataset.doc, render));
  if ($('#nd')) $('#nd').onclick = () => newDocument([e.id], 'employee');
});

/* ---------- Журнал действий ---------- */
const AUDIT_NAMES = { 'auth.login': 'Вход', 'auth.register': 'Регистрация', 'auth.password_change': 'Смена пароля', 'auth.password_reset': 'Сброс пароля', 'auth.2fa_enabled': 'Включена 2FA', 'auth.2fa_disabled': 'Отключена 2FA', 'auth.logout_all': 'Выход на всех устройствах',
  'payout.create': 'Выплаты в черновики', 'payout.create_send': 'Выплаты созданы и отправлены', 'payout.send': 'Отправка выплат', 'payout.cancel': 'Отмена выплаты', 'document.create': 'Создание документов', 'document.sign': 'Подписание документов', 'document.revoke': 'Отзыв документа',
  'contractor.create': 'Новый исполнитель', 'contractor.update': 'Изменение исполнителя', 'contractor.import': 'Импорт исполнителей', 'company.update': 'Изменение настроек', 'company.plan': 'Смена тарифа', 'invoice.create': 'Счёт на пополнение', 'invoice.paid': 'Пополнение баланса',
  'apikey.create': 'Создан API-ключ', 'apikey.revoke': 'Отозван API-ключ', 'webhook.update': 'Изменён вебхук', 'webhook.secret_rotate': 'Новый секрет вебхука', 'team.invite': 'Приглашение в команду', 'team.update': 'Изменение роли', 'export': 'Выгрузка данных', 'task.create': 'Новое задание', 'task.assign': 'Выбран исполнитель', 'task.accept': 'Приёмка работы',
  'employee.create': 'Новый сотрудник', 'template.create': 'Новый шаблон', 'split.create': 'Новый сплит', 'outstaff.create': 'Заявка на подбор', 'api.payout.create': 'API: выплата', 'api.contractor.create': 'API: исполнитель' };
const auditTable = (items, withCompany) => items.length ? `<table class="tbl"><thead><tr><th>Когда</th>${withCompany ? '<th>Компания</th>' : ''}<th>Кто</th><th>Действие</th><th>Детали</th><th>IP</th></tr></thead><tbody>${items.map((a) => `<tr><td class="small">${fdate(a.created_at, true)}</td>${withCompany ? `<td class="small">${esc(a.company || '—')}</td>` : ''}<td class="small">${esc(a.actor || 'система')}</td><td>${esc(AUDIT_NAMES[a.action] || a.action)}</td><td class="small mono muted" style="max-width:320px;word-break:break-all">${esc([a.entity, a.details].filter(Boolean).join(' ')).slice(0, 160)}</td><td class="small mono">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table>` : emptyBox('Записей нет', '');
on('/audit', async () => {
  const { items } = await api('/api/audit');
  layout('Журнал действий', `<p class="muted">Кто и когда входил, подписывал документы, отправлял выплаты и менял настройки. Записи нельзя удалить.</p><div class="tbl-wrap">${auditTable(items)}</div>`);
});

/* ---------- Уведомления (общие) ---------- */
on('/notifications', async () => {
  const { items } = await api('/api/notifications');
  layout('Уведомления', `<div class="card">${items.length ? items.map((n) => `<div class="notice ${n.is_read ? 'read' : ''}"><span class="dot"></span><div><div>${esc(n.text)}</div><div class="small muted">${fdate(n.created_at, true)}</div></div></div>`).join('') : emptyBox('Уведомлений нет', '')}</div>`,
    `<button class="btn btn-ghost btn-sm" id="rd">Прочитать все</button>`);
  $('#rd').onclick = async () => { await api('/api/notifications/read', {}); ME.unread = 0; render(); };
});

/* =========================================================
   ИСПОЛНИТЕЛЬ
   ========================================================= */
on('/home', async () => {
  const s = await api('/api/me/summary'); ME = await api('/api/me');
  const p = s.profile || {}; const pct = Math.min(100, (s.yearIncome / s.limit) * 100);
  const paidYear = s.payouts.filter((x) => x.status === 'paid');
  const needProfile = !p.inn || !p.card;
  layout(`Привет${ME.name ? ', ' + esc(ME.name.split(' ')[0]) : ''}!`, `
    ${needProfile ? `<div class="risk-item warn" style="margin-bottom:16px">Заполните ИНН и карту в <a href="#/profile" style="color:inherit;font-weight:700">профиле</a>, чтобы получать выплаты</div>` : ''}
    <div class="kpis">
      <div class="kpi ink"><span>Получено в ${new Date().getFullYear()}</span><b>${money(paidYear.reduce((a, x) => a + x.net, 0))}</b><small>после налога</small></div>
      <div class="kpi"><span>Документы на подпись</span><b>${s.toSign}</b><small><a href="#/my-docs">Перейти</a></small></div>
      <div class="kpi"><span>Активные задания</span><b>${s.tasks.filter((t) => ['in_progress', 'review'].includes(t.status)).length}</b><small><a href="#/market">Найти ещё</a></small></div>
      <div class="kpi"><span>Статус НПД</span><div style="margin:10px 0 4px">${chip(NPD, p.npd_status || 'unknown')}</div><small><a href="#/profile">Проверить</a></small></div>
    </div>
    <div class="cols-2">
      <div class="card"><div class="card-h"><h3>Последние выплаты</h3><a href="#/my-payouts" class="small">Все →</a></div>${s.payouts.length ? `<table class="tbl"><tbody>${s.payouts.slice(0, 6).map((x) => `<tr><td><b>${esc(x.company_name)}</b><div class="small muted">${esc(x.purpose || '')}</div></td><td>${fdate(x.paid_at || x.created_at)}</td><td class="num"><b>${money(x.net, 2)}</b></td><td>${x.receipt_number ? `<a href="/receipt/${x.receipt_number}" target="_blank" class="small">Чек</a>` : chip(PST, x.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Выплат пока нет', 'Откликайтесь на задания на бирже', '<a class="btn btn-primary" href="#/market">Открыть биржу</a>')}</div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Лимит дохода НПД</h3><div class="row between small" style="margin-bottom:8px"><b>${money(s.yearIncome)}</b><span class="muted">из ${money(s.limit)}</span></div><div class="progress ${pct > 85 ? 'warn' : ''}"><i style="width:${pct}%"></i></div><p class="small muted" style="margin:10px 0 0">Осталось ${money(Math.max(0, s.limit - s.yearIncome))}</p></div>
        ${s.employers.length ? `<div class="card"><h3>Мои работодатели (КЭДО)</h3>${s.employers.map((c) => `<div class="list-it"><span class="av">${initials(c.name)}</span><div style="flex:1"><b>${esc(c.name)}</b><div class="small muted">${esc(c.position || '')}</div></div></div>`).join('')}</div>` : ''}
        <div class="card"><h3>Мои заказчики</h3>${s.companies.length ? s.companies.map((c) => `<div class="list-it"><span class="av">${initials(c.name)}</span><b style="flex:1">${esc(c.name)}</b></div>`).join('') : '<p class="muted small">Пока нет. Компания добавит вас по email или телефону, либо выберет на бирже.</p>'}</div>
      </div></div>`);
});
on('/market', async () => {
  const { tasks } = await api('/api/market');
  layout('Биржа заданий', `<div class="tasks-grid">${tasks.length ? tasks.map((t) => `<div class="task-card"><div class="row between"><span class="chip plain">${esc(t.category)}</span><span class="small muted">${esc(t.city || '')}</span></div>
    <h4>${esc(t.title)}</h4><p class="small muted" style="margin:0">${esc((t.description || '').slice(0, 160))}</p><div class="small muted">${esc(t.company)}${t.deadline ? ' · до ' + fdate(t.deadline) : ''}</div>
    <div class="row between" style="margin-top:auto"><span class="budget">${money(t.budget)}</span>${t.my_response ? '<span class="chip ok">Вы откликнулись</span>' : `<button class="btn btn-primary btn-sm" data-r="${t.id}" data-b="${t.budget}">Откликнуться</button>`}</div></div>`).join('') : emptyBox('Открытых заданий нет', 'Загляните позже')}</div>`);
  $$('[data-r]').forEach((b) => b.onclick = () => {
    const m = modal(`<h3>Отклик на задание</h3><form id="rf"><label class="f"><span>Сопроводительное сообщение</span><textarea class="input" name="message" placeholder="Опыт, сроки, вопросы"></textarea></label><label class="f"><span>Ваша цена, ₽</span><input class="input" name="price" type="number" value="${b.dataset.b}"></label><div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Отправить</button></div></form>`);
    $('#rf', m.el).onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/market/${b.dataset.r}/respond`, formData(e.target)); m.close(); toast('Отклик отправлен'); render(); } catch (err) { fail(err); } };
  });
});
on('/my-tasks', async () => {
  const s = await api('/api/me/summary');
  layout('Мои задания', `<div class="tbl-wrap">${s.tasks.length ? `<table class="tbl"><thead><tr><th>Задание</th><th>Заказчик</th><th>Срок</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${s.tasks.map((t) => `<tr><td><b>${esc(t.title)}</b><div class="small muted">${esc((t.description || '').slice(0, 100))}</div></td><td>${esc(t.company_name)}</td><td>${t.deadline ? fdate(t.deadline) : '—'}</td><td class="num">${money(t.budget)}</td><td>${chip(TST, t.status)}</td><td>${t.status === 'in_progress' ? `<button class="btn btn-brand btn-sm" data-done="${t.id}">Сдать работу</button>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyBox('Заданий нет', 'Найдите задание на бирже', '<a class="btn btn-primary" href="#/market">Биржа</a>')}</div>`);
  $$('[data-done]').forEach((b) => b.onclick = async () => { try { await api(`/api/me/tasks/${b.dataset.done}/done`, {}); toast('Работа сдана на проверку'); render(); } catch (e) { fail(e); } });
});
on('/my-docs', async () => {
  const { documents } = await api('/api/me/documents');
  const pending = documents.filter((d) => ['sent', 'signed_company'].includes(d.status));
  layout('Документы', `${pending.length ? `<div class="risk-item warn" style="margin-bottom:14px;align-items:center">📝 <span style="flex:1">Ждут вашей подписи: ${pending.length}</span><button class="btn btn-brand btn-sm" id="all">Подписать все</button></div>` : ''}
    <div class="tbl-wrap">${documents.length ? `<table class="tbl"><thead><tr><th>Документ</th><th>Заказчик</th><th>Дата</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>${documents.map((d) => `<tr class="click" data-id="${d.id}"><td><b>${esc(d.title)}</b>${d.party === 'employee' ? ' <span class="chip plain">кадровый</span>' : ''}</td><td>${esc(d.company_name)}</td><td>${fdate(d.created_at)}</td><td class="num">${d.amount ? money(d.amount) : '—'}</td><td>${chip(DOCST, d.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Документов нет', '')}</div>`);
  $$('tr[data-id]').forEach((r) => r.onclick = () => viewDoc(r.dataset.id, render));
  if ($('#all')) $('#all').onclick = () => signFlow(pending.map((d) => d.id), render);
});
on('/my-payouts', async () => {
  const s = await api('/api/me/summary');
  layout('Выплаты и чеки', `<div class="tbl-wrap">${s.payouts.length ? `<table class="tbl"><thead><tr><th>Заказчик</th><th>Назначение</th><th>Дата</th><th class="num">Начислено</th><th class="num">Налог</th><th class="num">Получено</th><th>Чек</th></tr></thead><tbody>${s.payouts.map((x) => `<tr><td>${esc(x.company_name)}</td><td class="small">${esc(x.purpose || '')}</td><td>${fdate(x.paid_at || x.created_at)}</td><td class="num">${money(x.amount, 2)}</td><td class="num muted">${x.tax ? money(x.tax, 2) : '—'}</td><td class="num"><b>${money(x.net, 2)}</b></td><td>${x.receipt_number ? `<a href="/receipt/${x.receipt_number}" target="_blank">№${esc(x.receipt_number)}</a>` : chip(PST, x.status)}</td></tr>`).join('')}</tbody></table>` : emptyBox('Выплат нет', '')}</div>`);
});
on('/profile', async () => {
  const s = await api('/api/me/summary'); const p = s.profile || {};
  layout('Профиль', `<div class="cols-2"><div class="card"><form id="pf">
    <label class="f"><span>ФИО</span><input class="input" name="name" value="${esc(p.full_name || ME.name || '')}" required></label>
    <div class="cols-2e"><label class="f"><span>Статус</span><select class="input" name="type">${Object.entries(CT).map(([k, t]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f"><span>ИНН</span><input class="input mono" name="inn" maxlength="12" value="${esc(p.inn || '')}"></label></div>
    <div class="cols-2e"><label class="f"><span>Телефон</span><input class="input" name="phone" value="${esc(p.phone || ME.phone || '')}"></label><label class="f"><span>Специализация</span><input class="input" name="specialty" value="${esc(p.specialty || '')}"></label></div>
    <label class="f"><span>Карта для выплат</span><input class="input mono" name="card" inputmode="numeric" placeholder="${p.card ? maskCard(p.card) : '2200 0000 0000 0004'}"></label>
    <button class="btn btn-primary">Сохранить</button></form></div>
    <div class="card" style="align-self:start"><h3>Статус самозанятого</h3><p>${chip(NPD, p.npd_status || 'unknown')}</p><p class="small muted">Проверяем по публичному сервису ФНС. Нет статуса? Зарегистрируйтесь в приложении «Мой налог» за 10 минут.</p><button class="btn btn-ghost" id="chk">Проверить сейчас</button></div></div>`);
  $('#pf').onsubmit = async (e) => { e.preventDefault(); const d = formData(e.target); d.card = (d.card || '').replace(/\s/g, ''); if (!d.card) delete d.card; try { await api('/api/me/profile', d, 'PUT'); toast('Профиль сохранён'); render(); } catch (err) { fail(err); } };
  $('#chk').onclick = async (e) => { busy(e.target, true); try { const r = await api('/api/me/check-npd', {}); toast('Статус: ' + NPD[r.status][1]); render(); } catch (err) { fail(err); busy(e.target, false); } };
});

/* =========================================================
   ОПЕРАТОР ПЛАТФОРМЫ
   ========================================================= */
on('/admin', async () => {
  const o = await api('/api/admin/overview');
  layout('Оператор платформы', `<div class="kpis">
    <div class="kpi ink"><span>Выплачено в этом месяце</span><b>${money(o.paidMonth)}</b><small>выручка ${money(o.revenueMonth)}</small></div>
    <div class="kpi"><span>Компании</span><b>${o.companies}</b><small>${o.contractors} исполнителей</small></div>
    <div class="kpi"><span>Новые заявки</span><b>${o.newLeads}</b><small><a href="#/admin/leads">Открыть</a></small></div>
    <div class="kpi"><span>Подбор в работе</span><b>${o.openOutstaff}</b><small><a href="#/admin/outstaff">Открыть</a></small></div></div>
    <div class="cols-2e">
      <div class="card"><h3>Требует внимания</h3>
        ${o.issuedInvoices ? `<div class="risk-item warn">💳 <span>${o.issuedInvoices} счетов ждут поступления. <a href="#/admin/invoices">Сверить</a></span></div>` : ''}
        ${o.failedJobs ? `<div class="risk-item block">⚙️ <span>${o.failedJobs} задач завершились ошибкой. <a href="#/admin/jobs">Посмотреть</a></span></div>` : ''}
        ${o.processing ? `<div class="risk-item warn">⏳ <span>${o.processing} выплат в обработке</span></div>` : ''}
        ${!o.issuedInvoices && !o.failedJobs && !o.processing ? '<div class="risk-item ok">✓ Всё в порядке</div>' : ''}</div>
      <div class="card"><h3>Мониторинг</h3><p class="small muted">Состояние сервиса: <a href="/healthz" target="_blank">/healthz</a>. Резервные копии БД создаются ежедневно, хранятся последние 7.</p></div></div>`);
});
const LEADST = { new: ['info', 'Новая'], in_work: ['warn', 'В работе'], won: ['ok', 'Клиент'], lost: ['plain', 'Отказ'] };
on('/admin/leads', async () => {
  const { leads } = await api('/api/admin/leads');
  layout('Заявки с сайта', `<div class="tbl-wrap">${leads.length ? `<table class="tbl"><thead><tr><th>Дата</th><th>Контакт</th><th>Компания</th><th>Сообщение</th><th>Статус</th><th>Заметка</th></tr></thead><tbody>${leads.map((l) => `<tr><td class="small">${fdate(l.created_at, true)}</td><td><b>${esc(l.name)}</b><div class="small muted">${esc(l.phone || '')} ${esc(l.email || '')}</div></td><td>${esc(l.company || '—')}<div class="small muted">${l.kind === 'contractor' ? 'исполнитель' : 'бизнес'}</div></td><td class="small" style="max-width:260px">${esc(l.message || '')}</td>
    <td><select class="input" style="height:34px;width:auto" data-l="${l.id}">${Object.entries(LEADST).map(([k, [, t]]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td><td><input class="input" style="height:34px" data-n="${l.id}" value="${esc(l.note || '')}" placeholder="—"></td></tr>`).join('')}</tbody></table>` : emptyBox('Заявок нет', '')}</div>`);
  $$('[data-l]').forEach((sel) => sel.onchange = () => api('/api/admin/leads/' + sel.dataset.l, { status: sel.value }, 'PUT').then(() => toast('Сохранено')).catch(fail));
  $$('[data-n]').forEach((inp) => inp.onchange = () => api('/api/admin/leads/' + inp.dataset.n, { note: inp.value }, 'PUT').then(() => toast('Сохранено')).catch(fail));
});
on('/admin/outstaff', async () => {
  const { requests } = await api('/api/admin/outstaff');
  layout('Подбор персонала', `<div class="tbl-wrap">${requests.length ? `<table class="tbl"><thead><tr><th>Компания</th><th>Кто нужен</th><th>Подобрано</th><th>Старт</th><th>Статус</th><th></th></tr></thead><tbody>${requests.map((r) => `<tr><td><b>${esc(r.company)}</b><div class="small muted">${fdate(r.created_at)}</div></td><td><b>${esc(r.role)}</b><div class="small muted">${esc(r.city || '')} · ${esc(r.rate || '')} · ${esc(r.description || '')}</div></td><td>${r.staffed} из ${r.headcount}</td><td>${r.start_date ? fdate(r.start_date) : '—'}</td>
    <td><select class="input" style="height:34px;width:auto" data-o="${r.id}">${Object.entries(OST).map(([k, [, t]]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td><td><button class="btn btn-primary btn-sm" data-add="${r.id}">+ Кандидат</button></td></tr>`).join('')}</tbody></table>` : emptyBox('Заявок нет', '')}</div>`);
  $$('[data-o]').forEach((sel) => sel.onchange = () => api('/api/admin/outstaff/' + sel.dataset.o, { status: sel.value }, 'PUT').then(() => toast('Статус обновлён, компания уведомлена')).catch(fail));
  $$('[data-add]').forEach((b) => b.onclick = () => {
    const m = modal(`<h3>Кандидат по заявке</h3><p class="small muted">Исполнитель будет добавлен в компанию-заказчика, ему уйдёт приглашение и договор на подпись.</p><form id="cf">${contractorForm()}<div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary">Добавить</button></div></form>`);
    $('#cf', m.el).onsubmit = async (e) => { e.preventDefault(); const d = formData(e.target); d.card = (d.card || '').replace(/\s/g, ''); try { await api(`/api/admin/outstaff/${b.dataset.add}/candidates`, d); m.close(); toast('Кандидат добавлен'); render(); } catch (err) { fail(err); } };
  });
});
on('/admin/companies', async () => {
  const { companies } = await api('/api/admin/companies');
  layout('Компании', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Компания</th><th>Тариф</th><th class="num">Баланс</th><th class="num">Выплачено</th><th>Исполнители</th><th></th></tr></thead><tbody>${companies.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="small muted">ИНН ${esc(c.inn || '—')} · с ${fdate(c.created_at)}</div></td>
    <td><select class="input" style="height:34px;width:auto" data-plan="${c.id}">${['start', 'business', 'enterprise'].map((p) => `<option value="${p}" ${c.plan === p ? 'selected' : ''}>${{ start: 'Старт', business: 'Бизнес', enterprise: 'Корпорация' }[p]}</option>`).join('')}</select></td>
    <td class="num">${money(c.balance, 2)}</td><td class="num">${money(c.paid_total)}</td><td>${c.contractors}</td><td><button class="btn ${c.blocked ? 'btn-ghost' : 'btn-danger'} btn-sm" data-block="${c.id}" data-v="${c.blocked ? 0 : 1}">${c.blocked ? 'Разблокировать' : 'Заблокировать'}</button></td></tr>`).join('')}</tbody></table></div>`);
  $$('[data-plan]').forEach((sel) => sel.onchange = () => api('/api/admin/companies/' + sel.dataset.plan, { plan: sel.value }, 'PUT').then(() => toast('Тариф изменён')).catch(fail));
  $$('[data-block]').forEach((b) => b.onclick = async () => { if (+b.dataset.v && !confirmBox('Заблокировать компанию? Все операции будут остановлены.')) return; await api('/api/admin/companies/' + b.dataset.block, { blocked: !!+b.dataset.v }, 'PUT').catch(fail); render(); });
});
on('/admin/invoices', async () => {
  const { invoices } = await api('/api/admin/invoices');
  layout('Счета и поступления', `<p class="muted">Пока автоматическая сверка с выпиской банка не подключена, поступления подтверждаются вручную по номеру счёта в назначении платежа.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Счёт</th><th>Компания</th><th>Дата</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>${invoices.map((i) => `<tr><td class="mono">${esc(i.number)}</td><td>${esc(i.company)}<div class="small muted">ИНН ${esc(i.inn || '—')}</div></td><td>${fdate(i.created_at)}</td><td class="num">${money(i.amount, 2)}</td><td>${i.status === 'paid' ? '<span class="chip ok">Зачислен</span>' : `<button class="btn btn-brand btn-sm" data-c="${i.id}">Подтвердить поступление</button>`}</td></tr>`).join('')}</tbody></table></div>`);
  $$('[data-c]').forEach((b) => b.onclick = async () => { if (!confirmBox('Подтвердить поступление денег по счёту?')) return; try { await api(`/api/admin/invoices/${b.dataset.c}/confirm`, {}); toast('Баланс компании пополнен'); render(); } catch (e) { fail(e); } });
});
on('/admin/messages', async () => {
  const { messages } = await api('/api/admin/messages');
  layout('Письма и SMS', `<p class="muted">Журнал исходящих сообщений. Без настроенного провайдера (SMS_PROVIDER, EMAIL_PROVIDER) сообщения только сохраняются здесь.</p>
    <div class="tbl-wrap">${messages.length ? `<table class="tbl"><thead><tr><th>Когда</th><th>Канал</th><th>Кому</th><th>Текст</th><th>Статус</th></tr></thead><tbody>${messages.map((x) => `<tr><td class="small">${fdate(x.created_at, true)}</td><td>${x.channel === 'sms' ? 'SMS' : 'Email'}</td><td class="small mono">${esc(x.to_addr)}</td><td class="small" style="max-width:420px;white-space:pre-wrap">${x.subject ? `<b>${esc(x.subject)}</b>\n` : ''}${esc(x.body).slice(0, 300)}</td><td>${x.status === 'sent' ? `<span class="chip ok">${esc(x.provider || 'sent')}</span>` : x.status === 'failed' ? `<span class="chip bad" title="${esc(x.provider_response || '')}">ошибка</span>` : '<span class="chip info">в очереди</span>'}</td></tr>`).join('')}</tbody></table>` : emptyBox('Сообщений нет', '')}</div>`);
});
on('/admin/jobs', async () => {
  const { stats, failed } = await api('/api/admin/jobs');
  layout('Очередь задач', `<div class="cols-2e"><div class="card"><h3>Статистика</h3><table class="tbl"><tbody>${stats.map((x) => `<tr><td class="mono small">${esc(x.type)}</td><td>${chip({ done: ['ok', 'выполнено'], queued: ['info', 'в очереди'], running: ['warn', 'выполняется'], failed: ['bad', 'ошибка'] }, x.status)}</td><td class="num">${x.n}</td></tr>`).join('')}</tbody></table></div>
    <div class="card"><h3>Ошибки</h3>${failed.length ? failed.map((j) => `<div class="list-it"><div style="flex:1"><b class="mono small">${esc(j.type)} #${j.id}</b><div class="small" style="color:var(--red)">${esc(j.last_error || '')}</div><div class="small muted">${esc(j.payload)}</div></div><button class="btn btn-ghost btn-sm" data-r="${j.id}">Повторить</button></div>`).join('') : '<div class="risk-item ok">Ошибок нет</div>'}</div></div>`);
  $$('[data-r]').forEach((b) => b.onclick = async () => { await api(`/api/admin/jobs/${b.dataset.r}/retry`, {}).catch(fail); toast('Задача поставлена в очередь'); render(); });
});
on('/admin/audit', async () => {
  const { items } = await api('/api/admin/audit');
  layout('Журнал действий', `<div class="tbl-wrap">${auditTable(items, true)}</div>`);
});

render();
