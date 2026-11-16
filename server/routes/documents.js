'use strict';
const crypto = require('node:crypto');
const { q } = require('../db');
const L = require('../logic');
const S = require('../security');
const svc = require('../services');
const mailer = require('../mailer');
const { R, need, str } = require('../http');
const { httpError, notify } = L;

const DEMO = process.env.DEMO_MODE !== '0';
const cid = (ctx) => ctx.user.company_id;
const MAX_CODE_ATTEMPTS = 5;

R.get('/api/documents', { auth: 'company', perm: 'view' }, async (ctx) => {
  const s = ctx.query, args = [cid(ctx)]; let w = 'd.company_id=?';
  if (s.status === 'mine') w += ` AND d.status IN ('sent','signed_contractor') AND d.type<>'kedo_consent'`;
  else if (s.status) { w += ' AND d.status=?'; args.push(s.status); }
  if (s.type) { w += ' AND d.type=?'; args.push(s.type); }
  if (s.party) { w += ' AND d.party=?'; args.push(s.party); }
  return {
    documents: q.all(`SELECT d.id,d.party,d.type,d.number,d.title,d.status,d.amount,d.created_at,d.company_signed_at,d.contractor_signed_at, COALESCE(k.full_name,e.full_name) full_name
      FROM documents d LEFT JOIN contractors k ON k.id=d.contractor_id LEFT JOIN employees e ON e.id=d.employee_id WHERE ${w} ORDER BY d.id DESC LIMIT 500`, ...args),
    templates: Object.fromEntries(Object.entries(L.TEMPLATES).map(([k, v]) => [k, { title: v.title, party: v.party }])),
    custom: q.all('SELECT id,title,party FROM templates WHERE company_id=? ORDER BY id DESC', cid(ctx)),
  };
});
R.post('/api/documents', { auth: 'company', perm: 'documents' }, async (ctx) => {
  const b = ctx.body;
  const targets = [
    ...(Array.isArray(b.contractor_ids) ? b.contractor_ids : b.contractor_id ? [b.contractor_id] : []).map((id) => ({ contractor_id: Number(id) })),
    ...(Array.isArray(b.employee_ids) ? b.employee_ids : b.employee_id ? [b.employee_id] : []).map((id) => ({ employee_id: Number(id) })),
  ].slice(0, 1000);
  if (!targets.length) throw httpError(400, 'Выберите получателей');
  const extra = { subject: str(b.subject, 1000), amount: b.amount ? Number(b.amount) : null, until: str(b.until, 40), template_id: b.template_id ? Number(b.template_id) : null };
  const created = [], errors = [];
  for (const t of targets) { try { created.push(L.createDocument(cid(ctx), t, b.type, extra)); } catch (e) { if (targets.length === 1) throw e; errors.push(e.message); } }
  S.audit(ctx, 'document.create', null, { type: b.type || 'custom', count: created.length });
  return { created, errors };
});

function docForUser(user, id) {
  const d = q.get(`SELECT d.*, COALESCE(k.full_name, e.full_name) full_name, COALESCE(k.user_id, e.user_id) person_user_id, c.name company_name
    FROM documents d LEFT JOIN contractors k ON k.id=d.contractor_id LEFT JOIN employees e ON e.id=d.employee_id JOIN companies c ON c.id=d.company_id WHERE d.id=?`, id);
  if (!d) throw httpError(404, 'Документ не найден');
  if (user.role === 'company' && d.company_id !== user.company_id) throw httpError(404, 'Документ не найден');
  if (user.role === 'contractor' && d.person_user_id !== user.id) throw httpError(404, 'Документ не найден');
  return d;
}
R.get('/api/documents/:id', 'any', async (ctx) => ({ document: docForUser(ctx.user, ctx.params.id) }));
R.post('/api/documents/:id/revoke', { auth: 'company', perm: 'documents' }, async (ctx) => {
  const d = docForUser(ctx.user, ctx.params.id);
  if (d.status === 'signed') throw httpError(409, 'Подписанный документ нельзя отозвать — оформите соглашение о расторжении');
  q.run(`UPDATE documents SET status='revoked' WHERE id=?`, d.id);
  S.audit(ctx, 'document.revoke', 'document:' + d.id);
  return { ok: true };
});

/* ---------- подписание ПЭП ---------- */
function signableIds(user, ids) {
  // согласие на КЭДО — односторонний документ работника, компания его не подписывает
  return ids.slice(0, 500).map((id) => docForUser(user, id)).filter((d) => user.role === 'company'
    ? ['sent', 'signed_contractor'].includes(d.status) && d.type !== 'kedo_consent' : ['sent', 'signed_company'].includes(d.status)).map((d) => d.id);
}
R.post('/api/sign/request', { auth: 'any', limit: [10, 10 * 60e3, (c) => 'sr' + c.user.id] }, async (ctx) => {
  if (ctx.user.role === 'company' && !S.can(ctx.user, 'sign')) throw httpError(403, 'Подписывать документы от имени компании может владелец или бухгалтер');
  const ids = signableIds(ctx.user, Array.isArray(ctx.body.doc_ids) ? ctx.body.doc_ids : []);
  if (!ids.length) throw httpError(400, 'Нет документов, ожидающих вашей подписи');
  const code = String(crypto.randomInt(100000, 1000000));
  const id = q.run('INSERT INTO sign_codes (doc_ids,user_id,code_hash,expires_at) VALUES (?,?,?,?)', ids.join(','), ctx.user.id, S.sha256(code + ':' + ctx.user.id), Date.now() + 5 * 60e3).lastInsertRowid;
  const company = ctx.user.company_id ? q.get('SELECT sign_method FROM companies WHERE id=?', ctx.user.company_id) : null;
  const gk = company && company.sign_method === 'gosklyuch';
  if (!gk) { if (ctx.user.phone) mailer.sms(ctx.user.phone, mailer.T.signCode(code)); else mailer.email(ctx.user.email, 'Код подписи', mailer.T.signCode(code)); }
  const mask = (p) => p.replace(/^(\+?\d{2})\d+(\d{4})$/, (m, a, b) => a + '•••••' + b);
  return { request_id: Number(id), count: ids.length, sent_to: gk ? 'Госключ' : ctx.user.phone ? mask(ctx.user.phone) : ctx.user.email, demo_code: DEMO ? code : undefined };
});
R.post('/api/sign/confirm', { auth: 'any', limit: [20, 10 * 60e3, (c) => 'sc' + c.user.id] }, async (ctx) => {
  const r = q.get('SELECT * FROM sign_codes WHERE id=? AND user_id=?', ctx.body.request_id, ctx.user.id);
  if (!r || r.used) throw httpError(400, 'Запрос подписи не найден, запросите новый код');
  if (Date.now() > r.expires_at) throw httpError(400, 'Код истёк, запросите новый');
  if (r.attempts >= MAX_CODE_ATTEMPTS) throw httpError(429, 'Превышено число попыток, запросите новый код');
  const ok = S.sha256(String(ctx.body.code || '').trim() + ':' + ctx.user.id) === r.code_hash;
  if (!ok) {
    q.run('UPDATE sign_codes SET attempts=attempts+1 WHERE id=?', r.id);
    const left = MAX_CODE_ATTEMPTS - r.attempts - 1;
    if (left <= 0) q.run('UPDATE sign_codes SET used=1 WHERE id=?', r.id);
    throw httpError(400, left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Неверный код. Запросите новый');
  }
  q.run('UPDATE sign_codes SET used=1 WHERE id=?', r.id);
  const ids = signableIds(ctx.user, r.doc_ids.split(',').map(Number));
  const signer = ctx.user.name || ctx.user.email;
  q.tx(() => {
    for (const id of ids) {
      const d = q.get('SELECT * FROM documents WHERE id=?', id);
      let status;
      if (ctx.user.role === 'company') {
        status = d.status === 'signed_contractor' ? 'signed' : 'signed_company';
        q.run(`UPDATE documents SET status=?, company_signed_at=datetime('now'), company_signer=? WHERE id=?`, status === 'signed' ? 'signed_company_tmp' : status, signer, id);
      } else {
        status = d.status === 'signed_company' || d.type === 'kedo_consent' ? 'signed' : 'signed_contractor';
        q.run(`UPDATE documents SET status=?, contractor_signed_at=datetime('now') WHERE id=?`, status === 'signed' ? 'signed_contractor_tmp' : status, id);
      }
      if (status === 'signed') {
        const f = q.get('SELECT * FROM documents WHERE id=?', id);
        const hash = crypto.createHash('sha256').update([f.number, f.body, f.company_signed_at, f.company_signer, f.contractor_signed_at, f.amount ?? ''].join('␞')).digest('hex');
        q.run(`UPDATE documents SET status='signed', sign_hash=? WHERE id=?`, hash, id);
        notify({ company_id: f.company_id, kind: 'doc', text: `Документ ${f.number} подписан обеими сторонами` });
        svc.webhook(f.company_id, 'document.signed', { id, number: f.number, hash });
      }
      if (d.type === 'kedo_consent' && ctx.user.role === 'contractor') q.run('UPDATE employees SET kedo_consent=1, status=? WHERE id=?', 'active', d.employee_id);
    }
  });
  S.audit(ctx, 'document.sign', null, { ids, method: 'pep' });
  return { signed: ids.length };
});

/* ---------- собственные шаблоны ---------- */
R.get('/api/templates', { auth: 'company', perm: 'view' }, async (ctx) => ({
  templates: q.all('SELECT * FROM templates WHERE company_id=? ORDER BY id DESC', cid(ctx)),
  placeholders: Object.keys(L.PLACEHOLDERS),
}));
R.post('/api/templates', { auth: 'company', perm: 'documents' }, async (ctx) => {
  const b = ctx.body;
  const party = b.party === 'employee' ? 'employee' : 'contractor';
  const id = q.run('INSERT INTO templates (company_id,party,title,body) VALUES (?,?,?,?)', cid(ctx), party, need(b.title, 'Укажите название').slice(0, 200), need(b.body, 'Текст шаблона пуст').slice(0, 50000)).lastInsertRowid;
  S.audit(ctx, 'template.create', 'template:' + id);
  return { id: Number(id) };
});
R.put('/api/templates/:id', { auth: 'company', perm: 'documents' }, async (ctx) => {
  const t = q.get('SELECT * FROM templates WHERE id=? AND company_id=?', ctx.params.id, cid(ctx)); if (!t) throw httpError(404, 'Шаблон не найден');
  q.run('UPDATE templates SET title=?, body=?, party=? WHERE id=?', str(ctx.body.title, 200) || t.title, String(ctx.body.body || t.body).slice(0, 50000), ctx.body.party === 'employee' ? 'employee' : ctx.body.party === 'contractor' ? 'contractor' : t.party, t.id);
  return { ok: true };
});
R.del('/api/templates/:id', { auth: 'company', perm: 'documents' }, async (ctx) => { q.run('DELETE FROM templates WHERE id=? AND company_id=?', ctx.params.id, cid(ctx)); return { ok: true }; });
R.post('/api/templates/preview', { auth: 'company', perm: 'view' }, async (ctx) => {
  const c = q.get('SELECT * FROM companies WHERE id=?', cid(ctx));
  return { html: L.renderCustom(String(ctx.body.body || ''), c, { full_name: 'Иванов Иван Иванович', inn: '500100732259', position: 'Дизайнер' }, { number: 'ДОК-2026-0001', subject: 'Пример предмета', amount: 15000, until: '31.12.2026' }) };
});

module.exports = { docForUser };
