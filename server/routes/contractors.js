'use strict';
const { q } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const mailer = require('../mailer');
const { R, need, str } = require('../http');
const { httpError } = L;

const cid = (ctx) => ctx.user.company_id;
function contractorOf(ctx, id) {
  const k = q.get('SELECT * FROM contractors WHERE id=? AND company_id=?', id, cid(ctx));
  if (!k) throw httpError(404, 'Исполнитель не найден');
  return k;
}

R.get('/api/contractors', { auth: 'company', perm: 'view' }, async (ctx) => {
  const s = ctx.query; const args = [cid(ctx)]; let w = 'company_id=?';
  if (s.type) { w += ' AND type=?'; args.push(s.type); }
  if (s.status) { w += ' AND status=?'; args.push(s.status); }
  if (s.q) { w += ' AND (full_name LIKE ? OR inn LIKE ? OR phone LIKE ? OR email LIKE ?)'; const v = `%${s.q}%`; args.push(v, v, v, v); }
  return { contractors: q.all(`SELECT k.*, (SELECT COALESCE(SUM(amount),0) FROM payouts p WHERE p.contractor_id=k.id AND p.status='paid') paid_total,
     (SELECT COUNT(*) FROM documents d WHERE d.contractor_id=k.id AND d.type IN ('contract','custom') AND d.status='signed') has_contract
     FROM contractors k WHERE ${w} ORDER BY k.id DESC`, ...args) };
});
R.post('/api/contractors', { auth: 'company', perm: 'contractors' }, async (ctx) => {
  const id = svc.insertContractor(cid(ctx), ctx.body);
  const k = await svc.refreshNpd(q.get('SELECT * FROM contractors WHERE id=?', id));
  if (ctx.body.send_contract) L.createDocument(cid(ctx), { contractor_id: id }, 'contract', { subject: k.specialty });
  S.audit(ctx, 'contractor.create', 'contractor:' + id, { full_name: k.full_name, type: k.type });
  return { id, contractor: k };
});
R.post('/api/contractors/import', { auth: 'company', perm: 'contractors' }, async (ctx) => {
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows.slice(0, 5000) : [];
  if (!rows.length) throw httpError(400, 'Файл пуст');
  const result = { added: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    try { const id = svc.insertContractor(cid(ctx), r); result.added++; await svc.refreshNpd(q.get('SELECT * FROM contractors WHERE id=?', id)); }
    catch (e) { result.errors.push(`Строка ${i + 2}: ${e.message}`); }
  }
  S.audit(ctx, 'contractor.import', null, { added: result.added, errors: result.errors.length });
  return result;
});
R.post('/api/contractors/check-npd-all', { auth: 'company', perm: 'contractors', limit: [3, 60e3] }, async (ctx) => {
  const list = q.all(`SELECT * FROM contractors WHERE company_id=? AND type='npd' LIMIT 500`, cid(ctx));
  let active = 0; for (const k of list) if ((await svc.refreshNpd(k)).npd_status === 'active') active++;
  return { checked: list.length, active };
});
R.get('/api/contractors/:id', { auth: 'company', perm: 'view' }, async (ctx) => {
  const k = contractorOf(ctx, ctx.params.id);
  const c = q.get('SELECT * FROM companies WHERE id=?', cid(ctx));
  return {
    contractor: k,
    documents: q.all('SELECT id,type,number,title,status,amount,created_at FROM documents WHERE contractor_id=? ORDER BY id DESC', k.id),
    payouts: q.all('SELECT * FROM payouts WHERE contractor_id=? ORDER BY id DESC LIMIT 200', k.id),
    yearIncome: L.yearIncome(k), limit: L.NPD_YEAR_LIMIT, risks: L.riskCheck(c, k, 0), formerBanUntil: L.formerEmployeeBan(k),
  };
});
R.put('/api/contractors/:id', { auth: 'company', perm: 'contractors' }, async (ctx) => {
  const k = contractorOf(ctx, ctx.params.id); const b = { ...ctx.body };
  if (b.inn) { b.inn = String(b.inn).replace(/\D/g, ''); if (!L.validInn(b.inn)) throw httpError(400, 'Некорректный ИНН'); }
  if (b.card) { b.card = String(b.card).replace(/\D/g, ''); if (!L.luhn(b.card)) throw httpError(400, 'Некорректный номер карты'); }
  if (b.type && !L.CONTRACTOR_TYPES[b.type]) throw httpError(400, 'Неизвестный тип');
  if (b.status && !['active', 'blocked', 'invited'].includes(b.status)) throw httpError(400, 'Неизвестный статус');
  if ('former_employee_until' in b && b.former_employee_until && !/^\d{4}-\d{2}-\d{2}$/.test(b.former_employee_until)) throw httpError(400, 'Дата увольнения в формате ГГГГ-ММ-ДД');
  const fields = ['full_name', 'inn', 'phone', 'email', 'card', 'bank_account', 'bik', 'citizenship', 'specialty', 'type', 'status', 'former_employee_until'];
  for (const f of fields) if (f in b) q.run(`UPDATE contractors SET ${f}=? WHERE id=?`, b[f] === '' ? null : str(b[f], 200), k.id);
  S.audit(ctx, 'contractor.update', 'contractor:' + k.id, Object.keys(b).filter((f) => fields.includes(f)));
  return { contractor: q.get('SELECT * FROM contractors WHERE id=?', k.id) };
});
R.post('/api/contractors/:id/check-npd', { auth: 'company', perm: 'contractors', limit: [20, 60e3] }, async (ctx) => ({ contractor: await svc.refreshNpd(contractorOf(ctx, ctx.params.id)) }));
R.post('/api/contractors/:id/invite', { auth: 'company', perm: 'contractors', limit: [5, 3600e3, (c) => c.params.id] }, async (ctx) => {
  const k = contractorOf(ctx, ctx.params.id);
  if (k.user_id) throw httpError(409, 'Исполнитель уже зарегистрирован');
  const c = q.get('SELECT name FROM companies WHERE id=?', cid(ctx));
  const [s, t] = mailer.T.invite(k.full_name, c.name, 'contractor');
  if (k.email) mailer.email(k.email, s, t); else if (k.phone) mailer.sms(k.phone, `${c.name} приглашает вас в ${L.BRAND}: ${mailer.APP_URL}/app#/register?role=contractor`); else throw httpError(400, 'Нет email или телефона');
  return { ok: true };
});

/* ================= сотрудники (КЭДО) ================= */
function employeeOf(ctx, id) { const e = q.get('SELECT * FROM employees WHERE id=? AND company_id=?', id, cid(ctx)); if (!e) throw httpError(404, 'Сотрудник не найден'); return e; }
R.get('/api/employees', { auth: 'company', perm: 'view' }, async (ctx) => ({
  employees: q.all(`SELECT e.*, (SELECT COUNT(*) FROM documents d WHERE d.employee_id=e.id AND d.status IN ('sent','signed_company')) pending_docs FROM employees e WHERE company_id=? ORDER BY id DESC`, cid(ctx)),
}));
R.post('/api/employees', { auth: 'company', perm: 'employees' }, async (ctx) => {
  const b = ctx.body;
  const full_name = need(b.full_name, 'Укажите ФИО').slice(0, 200);
  if (!b.email && !b.phone) throw httpError(400, 'Нужен email или телефон для подписи документов');
  const email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 40);
  const id = Number(q.run('INSERT INTO employees (company_id,full_name,position,department,email,phone,inn,snils,hired_at) VALUES (?,?,?,?,?,?,?,?,?)',
    cid(ctx), full_name, str(b.position, 120), str(b.department, 120), email, phone, str(b.inn, 12) || null, str(b.snils, 14) || null, /^\d{4}-\d{2}-\d{2}$/.test(b.hired_at || '') ? b.hired_at : null).lastInsertRowid);
  const u = q.get(`SELECT * FROM users WHERE role='contractor' AND ((email<>'' AND email=?) OR (phone<>'' AND phone=?))`, email || '#', phone || '#');
  const c = q.get('SELECT name FROM companies WHERE id=?', cid(ctx));
  if (u) q.run(`UPDATE employees SET user_id=?, status='active' WHERE id=?`, u.id, id);
  else { const [s, t] = mailer.T.invite(full_name, c.name, 'employee'); if (email) mailer.email(email, s, t); else mailer.sms(phone, `${c.name}: подпишите кадровые документы в ${L.BRAND} — ${mailer.APP_URL}/app#/register?role=contractor`); }
  // первым документом — согласие на КЭДО (ст. 22.1 ТК РФ)
  L.createDocument(cid(ctx), { employee_id: id }, 'kedo_consent', {});
  S.audit(ctx, 'employee.create', 'employee:' + id, { full_name });
  return { id };
});
R.get('/api/employees/:id', { auth: 'company', perm: 'view' }, async (ctx) => {
  const e = employeeOf(ctx, ctx.params.id);
  return { employee: e, documents: q.all('SELECT id,type,number,title,status,amount,created_at FROM documents WHERE employee_id=? ORDER BY id DESC', e.id) };
});
R.put('/api/employees/:id', { auth: 'company', perm: 'employees' }, async (ctx) => {
  const e = employeeOf(ctx, ctx.params.id);
  for (const f of ['full_name', 'position', 'department', 'email', 'phone', 'inn', 'snils', 'hired_at', 'fired_at', 'status']) if (f in ctx.body) q.run(`UPDATE employees SET ${f}=? WHERE id=?`, str(ctx.body[f], 200) || null, e.id);
  S.audit(ctx, 'employee.update', 'employee:' + e.id, Object.keys(ctx.body));
  return { ok: true };
});

module.exports = { contractorOf };
