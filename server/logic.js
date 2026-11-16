'use strict';
const { q, K, R } = require('./db');
const mailer = require('./mailer');

const BRAND = process.env.BRAND || 'SamoletPay';

const PLANS = {
  start:      { name: 'Старт',      fee: 3.0, monthly: 0,     contractors: 50,   desc: 'Для первых выплат и небольших команд' },
  business:   { name: 'Бизнес',     fee: 1.9, monthly: 4900,  contractors: 1000, desc: 'Регулярные массовые выплаты, API, 1С' },
  enterprise: { name: 'Корпорация', fee: 1.2, monthly: 19900, contractors: 1e9,  desc: 'White Label, SLA, выделенный менеджер' },
};
const NPD_YEAR_LIMIT = 2_400_000;
const NPD_TAX_RATE = 0.06, NDFL_RATE = 0.13;
const FORMER_EMPLOYEE_YEARS = 2;
const CONTRACTOR_TYPES = { npd: 'Самозанятый', fl: 'Физлицо (ГПХ)', ip: 'ИП', eaeu: 'Гражданин ЕАЭС' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round(n * 100) / 100;
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/* ---------- ИНН ---------- */
function validInn(inn) {
  if (!/^\d{10}$|^\d{12}$/.test(inn || '')) return false;
  const d = inn.split('').map(Number);
  const c = (w) => (w.reduce((s, k, i) => s + k * d[i], 0) % 11) % 10;
  if (inn.length === 10) return c([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return c([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && c([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}
function luhn(n) { n = String(n || '').replace(/\D/g, ''); if (n.length < 16 || n.length > 19) return false; let s = 0; n.split('').reverse().forEach((d, i) => { let x = +d; if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; }); return s % 10 === 0; }

/* ---------- Проверка статуса НПД ---------- */
async function checkNpd(inn) {
  if (!validInn(inn) || inn.length !== 12) return { status: 'invalid', source: 'validation', message: 'Некорректный ИНН физлица' };
  if (process.env.NPD_OFFLINE !== '1') {
    try {
      const r = await fetch('https://statusnpd.nalog.ru/api/v1/tracker/taxpayer_status', {
        method: 'POST', signal: AbortSignal.timeout(3500), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inn, requestDate: new Date().toISOString().slice(0, 10) }),
      });
      if (r.ok) { const j = await r.json(); return { status: j.status ? 'active' : 'inactive', source: 'fns', message: j.message }; }
    } catch { /* сеть недоступна — демо-режим ниже */ }
  }
  const active = Number(inn[11]) % 5 !== 0;
  return { status: active ? 'active' : 'inactive', source: 'demo', message: active ? 'Зарегистрирован как плательщик НПД (демо)' : 'Не является плательщиком НПД (демо)' };
}

/* ---------- Расчёт выплаты: всё в копейках, наружу — рубли ---------- */
function calcPayout(company, contractor, amountRub) {
  const plan = PLANS[company.plan] || PLANS.start;
  const a = K(amountRub);
  const commission = Math.round(a * plan.fee / 100);
  let tax = 0, taxNote = '';
  if (contractor.type === 'npd' && company.tax_service) { tax = Math.round(a * NPD_TAX_RATE); taxNote = 'НПД 6% удерживается и уплачивается за исполнителя'; }
  if (contractor.type === 'fl' || contractor.type === 'eaeu') { tax = Math.round(a * NDFL_RATE); taxNote = 'НДФЛ 13% удерживается налоговым агентом'; }
  const k = { amount: a, commission, tax, net: a - tax, debit: a + commission };
  return { k, amount: R(a), commission: R(commission), tax: R(tax), net: R(a - tax), debit: R(a + commission), taxNote };
}

/* ---------- Риск-проверки ---------- */
function yearIncome(contractor) {
  return q.get(`SELECT COALESCE(SUM(p.amount),0) year_income FROM payouts p JOIN contractors c ON c.id=p.contractor_id
    WHERE (c.id=? OR (c.inn IS NOT NULL AND c.inn<>'' AND c.inn=?)) AND p.status IN ('paid','processing')
    AND strftime('%Y',p.created_at)=strftime('%Y','now')`, contractor.id, contractor.inn || '#').year_income;
}
function formerEmployeeBan(contractor) {
  if (!contractor.former_employee_until) return null;
  const d = new Date(contractor.former_employee_until + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCFullYear(d.getUTCFullYear() + FORMER_EMPLOYEE_YEARS);
  return d > new Date() ? d.toISOString().slice(0, 10) : null;
}
function riskCheck(company, contractor, amount) {
  const issues = [];
  if (contractor.status === 'blocked') issues.push({ level: 'block', code: 'blocked', text: 'Исполнитель заблокирован' });
  if (!contractor.card && !contractor.bank_account) issues.push({ level: 'block', code: 'no_requisites', text: 'Не указаны реквизиты (карта или счёт)' });
  if (contractor.type === 'npd') {
    if (contractor.npd_status !== 'active') issues.push({ level: 'block', code: 'npd_status', text: 'Статус самозанятого не подтверждён' });
    const ban = formerEmployeeBan(contractor);
    if (ban) issues.push({ level: 'block', code: 'former_employee', text: `Бывший сотрудник: платить как самозанятому нельзя до ${ban.split('-').reverse().join('.')} (п. 8 ч. 2 ст. 6 422-ФЗ). Оформите договор ГПХ.` });
    const inc = yearIncome(contractor);
    if (inc + amount > NPD_YEAR_LIMIT) issues.push({ level: 'block', code: 'npd_limit', text: `Превышение годового лимита НПД 2,4 млн ₽ (уже ${Math.round(inc).toLocaleString('ru-RU')} ₽)` });
    else if (inc + amount > NPD_YEAR_LIMIT * 0.85) issues.push({ level: 'warn', code: 'npd_limit_near', text: 'Доход исполнителя приближается к лимиту НПД' });
    const checkedAgo = contractor.npd_checked_at ? (Date.now() - Date.parse(contractor.npd_checked_at.replace(' ', 'T') + 'Z')) / 864e5 : 999;
    if (checkedAgo > 1) issues.push({ level: 'warn', code: 'npd_stale', text: 'Статус НПД проверялся более суток назад — перепроверим перед перечислением' });
  }
  const signed = q.get(`SELECT id FROM documents WHERE contractor_id=? AND type IN ('contract','custom') AND status='signed' LIMIT 1`, contractor.id);
  if (!signed) issues.push({ level: 'warn', code: 'no_contract', text: 'Нет подписанного договора с исполнителем' });
  const n = q.get(`SELECT COUNT(*) n FROM payouts WHERE contractor_id=? AND status='paid' AND created_at > datetime('now','-90 day')`, contractor.id).n;
  if (n >= 12) issues.push({ level: 'warn', code: 'regular', text: 'Регулярные выплаты одному исполнителю — риск переквалификации в трудовые отношения' });
  return issues;
}

/* ---------- Шаблоны документов ---------- */
const fmtMoney = (n) => Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
const today = () => new Date().toLocaleDateString('ru-RU');
const personKind = (k) => k.type === 'npd' ? 'применяющий специальный налоговый режим «Налог на профессиональный доход»' : k.type === 'ip' ? 'индивидуальный предприниматель' : 'физическое лицо';

const TEMPLATES = {
  contract: { party: 'contractor', title: 'Договор оказания услуг', body: (c, k, x) => `
<h2>ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p><b>${esc(c.name)}</b>, ИНН ${esc(c.inn || '—')}, в лице ${esc(c.director || 'генерального директора')}, именуемое «Заказчик», и <b>${esc(k.full_name)}</b>, ИНН ${esc(k.inn || '—')}, ${personKind(k)}, именуемый «Исполнитель», заключили настоящий договор:</p>
<h3>1. Предмет договора</h3>
<p>1.1. Исполнитель обязуется по заданиям Заказчика оказывать услуги: ${esc(x.subject || k.specialty || 'по направлению деятельности Исполнителя')}, а Заказчик — принять и оплатить их.</p>
<p>1.2. Объём, сроки и стоимость услуг согласуются в заданиях, подписываемых в электронной форме на платформе ${esc(BRAND)}.</p>
<h3>2. Стоимость и порядок расчётов</h3>
<p>2.1. Оплата производится в течение 3 рабочих дней с момента подписания акта через номинальный счёт оператора платформы.</p>
${k.type === 'npd' ? '<p>2.2. Исполнитель поручает платформе формирование чека. Исполнитель обязуется уведомить Заказчика об утрате статуса плательщика НПД в течение 1 рабочего дня и подтверждает, что не являлся работником Заказчика в течение последних двух лет.</p>' : ''}
${k.type === 'fl' || k.type === 'eaeu' ? '<p>2.2. Заказчик выступает налоговым агентом и удерживает НДФЛ из суммы вознаграждения.</p>' : ''}
<h3>3. Электронный документооборот</h3>
<p>3.1. Стороны признают документы, подписанные простой электронной подписью (одноразовый код, направленный на телефон или email стороны), равнозначными документам на бумаге с собственноручной подписью (ст. 6 63-ФЗ).</p>
<h3>4. Прочие условия</h3>
<p>4.1. Исполнитель не является работником Заказчика, самостоятельно определяет способ и время оказания услуг.</p>
<p>4.2. Договор действует до ${esc(x.until || '31.12.' + new Date().getFullYear())} и может быть расторгнут любой стороной с уведомлением за 10 дней.</p>` },
  act: { party: 'contractor', title: 'Акт об оказании услуг', body: (c, k, x) => `
<h2>АКТ № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p>Заказчик: <b>${esc(c.name)}</b>, ИНН ${esc(c.inn || '—')}<br>Исполнитель: <b>${esc(k.full_name)}</b>, ИНН ${esc(k.inn || '—')}</p>
<p>Исполнитель оказал, а Заказчик принял услуги: <b>${esc(x.subject || 'услуги по заданию')}</b>${x.contract ? ` в рамках договора № ${esc(x.contract)}` : ''}.</p>
<table><tr><th>Наименование</th><th>Сумма</th></tr><tr><td>${esc(x.subject || 'Услуги')}</td><td>${fmtMoney(x.amount)}</td></tr><tr><th>Итого</th><th>${fmtMoney(x.amount)}</th></tr></table>
<p>НДС не облагается. Услуги оказаны в полном объёме и в срок. Стороны претензий не имеют.</p>` },
  task_order: { party: 'contractor', title: 'Задание на оказание услуг', body: (c, k, x) => `
<h2>ЗАДАНИЕ № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p>К договору между <b>${esc(c.name)}</b> и <b>${esc(k.full_name)}</b>.</p>
<p><b>Описание:</b> ${esc(x.subject || '—')}</p><p><b>Срок:</b> ${esc(x.until || 'по согласованию')}</p><p><b>Стоимость:</b> ${fmtMoney(x.amount)}</p>` },
  nda: { party: 'contractor', title: 'Соглашение о неразглашении', body: (c, k, x) => `
<h2>СОГЛАШЕНИЕ О НЕРАЗГЛАШЕНИИ № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p><b>${esc(c.name)}</b> и <b>${esc(k.full_name)}</b> договорились не раскрывать третьим лицам конфиденциальную информацию, полученную в ходе сотрудничества, в течение 3 лет с даты подписания.</p>` },

  /* ---- КЭДО: кадровые документы сотрудников (ст. 22.1–22.3 ТК РФ) ---- */
  kedo_consent: { party: 'employee', title: 'Согласие на электронный кадровый документооборот', body: (c, e, x) => `
<h2>СОГЛАСИЕ НА ВЗАИМОДЕЙСТВИЕ С РАБОТОДАТЕЛЕМ ПОСРЕДСТВОМ ЭЛЕКТРОННОГО ДОКУМЕНТООБОРОТА</h2><p class="r">${today()}</p>
<p>Я, <b>${esc(e.full_name)}</b>, ${esc(e.position || 'работник')}, в соответствии со ст. 22.1–22.3 Трудового кодекса РФ даю согласие ${esc(c.name)} (ИНН ${esc(c.inn || '—')}) на ведение кадровых документов в электронном виде с использованием платформы ${esc(BRAND)}.</p>
<p>Я уведомлён(а), что вправе отозвать согласие и получать документы на бумаге, письменно уведомив работодателя.</p>` },
  employment: { party: 'employee', title: 'Трудовой договор', body: (c, e, x) => `
<h2>ТРУДОВОЙ ДОГОВОР № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p><b>${esc(c.name)}</b> в лице ${esc(c.director || 'генерального директора')} («Работодатель») и <b>${esc(e.full_name)}</b> («Работник») заключили настоящий трудовой договор.</p>
<p>1. Работник принимается на должность <b>${esc(e.position || x.subject || '—')}</b>${e.department ? ` в подразделение «${esc(e.department)}»` : ''}.</p>
<p>2. Дата начала работы: ${esc(e.hired_at || x.until || today())}. Договор заключён на неопределённый срок.</p>
<p>3. Должностной оклад: ${fmtMoney(x.amount)} в месяц. Заработная плата выплачивается два раза в месяц.</p>
<p>4. Режим работы: пятидневная рабочая неделя, 40 часов. Ежегодный оплачиваемый отпуск — 28 календарных дней.</p>` },
  hire_order: { party: 'employee', title: 'Приказ о приёме на работу', body: (c, e, x) => `
<h2>ПРИКАЗ № ${esc(x.number)} О ПРИЁМЕ РАБОТНИКА НА РАБОТУ</h2><p class="r">${today()}</p>
<p>Принять <b>${esc(e.full_name)}</b> на должность ${esc(e.position || '—')} с ${esc(e.hired_at || today())}, оклад ${fmtMoney(x.amount)}.</p>
<p>С приказом работник ознакомлен(а).</p>` },
  vacation: { party: 'employee', title: 'Приказ о предоставлении отпуска', body: (c, e, x) => `
<h2>ПРИКАЗ № ${esc(x.number)} О ПРЕДОСТАВЛЕНИИ ОТПУСКА</h2><p class="r">${today()}</p>
<p>Предоставить <b>${esc(e.full_name)}</b>, ${esc(e.position || '')}, ежегодный оплачиваемый отпуск: ${esc(x.subject || 'период по графику отпусков')}.</p>` },
  lna: { party: 'employee', title: 'Лист ознакомления с локальными актами', body: (c, e, x) => `
<h2>ЛИСТ ОЗНАКОМЛЕНИЯ № ${esc(x.number)}</h2><p class="r">${today()}</p>
<p>Я, <b>${esc(e.full_name)}</b>, ознакомлен(а) с локальным нормативным актом: <b>${esc(x.subject || 'Правила внутреннего трудового распорядка')}</b>.</p>` },
};

/* ---------- пользовательские шаблоны: текст с плейсхолдерами {{...}} ---------- */
const PLACEHOLDERS = {
  'номер': (c, p, x) => x.number, 'дата': () => today(), 'компания': (c) => c.name, 'компания.инн': (c) => c.inn, 'компания.директор': (c) => c.director,
  'фио': (c, p) => p.full_name, 'инн': (c, p) => p.inn, 'должность': (c, p) => p.position || p.specialty, 'предмет': (c, p, x) => x.subject, 'сумма': (c, p, x) => fmtMoney(x.amount), 'срок': (c, p, x) => x.until,
};
function renderCustom(body, c, p, x) {
  const text = String(body).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key) => { const f = PLACEHOLDERS[key.toLowerCase()]; return f ? String(f(c, p, x) ?? '') : m; });
  return text.split(/\n{2,}/).map((para) => {
    const t = para.trim(); if (!t) return '';
    if (t.startsWith('# ')) return `<h2>${esc(t.slice(2))}</h2>`;
    if (t.startsWith('## ')) return `<h3>${esc(t.slice(3))}</h3>`;
    return `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

function nextNumber(companyId, type) {
  const prefix = { contract: 'Д', act: 'А', task_order: 'З', nda: 'NDA', employment: 'ТД', hire_order: 'П', vacation: 'О', lna: 'ЛО', kedo_consent: 'С', custom: 'ДОК' }[type] || 'DOC';
  const n = q.get('SELECT COUNT(*) n FROM documents WHERE company_id=? AND type=?', companyId, type).n + 1;
  return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

/** Создать документ для исполнителя или сотрудника. */
function createDocument(companyId, target, type, extra = {}) {
  const c = q.get('SELECT * FROM companies WHERE id=?', companyId);
  const isEmp = !!target.employee_id;
  const p = isEmp ? q.get('SELECT * FROM employees WHERE id=? AND company_id=?', target.employee_id, companyId)
    : q.get('SELECT * FROM contractors WHERE id=? AND company_id=?', target.contractor_id, companyId);
  if (!p) throw httpError(404, isEmp ? 'Сотрудник не найден' : 'Исполнитель не найден');
  let title, body, tplId = null;
  if (extra.template_id) {
    const t = q.get('SELECT * FROM templates WHERE id=? AND company_id=?', extra.template_id, companyId);
    if (!t) throw httpError(404, 'Шаблон не найден');
    if ((t.party === 'employee') !== isEmp) throw httpError(400, 'Шаблон предназначен для другой стороны');
    type = 'custom'; tplId = t.id; title = t.title;
    const number = nextNumber(companyId, type);
    body = renderCustom(t.body, c, p, { ...extra, number }); title = `${t.title} № ${number}`;
    return insertDoc(c, p, isEmp, type, number, title, body, extra, tplId);
  }
  const t = TEMPLATES[type];
  if (!t) throw httpError(400, 'Неизвестный тип документа');
  if ((t.party === 'employee') !== isEmp) throw httpError(400, 'Этот тип документа не подходит для выбранной стороны');
  if (isEmp && type !== 'kedo_consent' && !p.kedo_consent) throw httpError(409, `${p.full_name} ещё не подписал(а) согласие на КЭДО (ст. 22.1 ТК РФ)`);
  const number = nextNumber(companyId, type);
  body = t.body(c, p, { ...extra, number }); title = `${t.title} № ${number}`;
  return insertDoc(c, p, isEmp, type, number, title, body, extra, tplId);
}
function insertDoc(c, p, isEmp, type, number, title, body, extra, tplId) {
  const r = q.run(`INSERT INTO documents (company_id,party,contractor_id,employee_id,type,number,title,body,amount,task_id,template_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'sent')`,
    c.id, isEmp ? 'employee' : 'contractor', isEmp ? null : p.id, isEmp ? p.id : null, type, number, title, body, extra.amount ? K(extra.amount) : null, extra.task_id || null, tplId);
  if (p.user_id) notify({ user_id: p.user_id, kind: 'doc', text: `${c.name} отправил(а) документ «${title}» на подпись` });
  if (p.phone) mailer.sms(p.phone, mailer.T.docToSign(c.name, title));
  else if (p.email) mailer.email(p.email, 'Документ на подпись', mailer.T.docToSign(c.name, title));
  return Number(r.lastInsertRowid);
}

function notify({ company_id = null, user_id = null, kind = 'info', text }) {
  q.run('INSERT INTO notifications (company_id,user_id,kind,text) VALUES (?,?,?,?)', company_id, user_id, kind, text);
}

module.exports = {
  BRAND, PLANS, CONTRACTOR_TYPES, NPD_YEAR_LIMIT, round2, esc, validInn, luhn, checkNpd, calcPayout, riskCheck, yearIncome,
  formerEmployeeBan, TEMPLATES, PLACEHOLDERS, renderCustom, createDocument, httpError, notify, fmtMoney,
};
