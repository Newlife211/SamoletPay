'use strict';
/* Серверные страницы: документ (HTML/PDF), чек, счёт, проверка подлинности */
const { q } = require('../db');
const L = require('../logic');
const pdf = require('../pdf');
const mailer = require('../mailer');
const { send, sessionUser } = require('../http');
const { docForUser } = require('./documents');
const esc = L.esc;

const PRINT_CSS = `<style>body{font-family:"Times New Roman",serif;max-width:780px;margin:40px auto;padding:0 24px;color:#111;line-height:1.5}h2{text-align:center;font-size:18px}h3{font-size:15px;margin-top:20px}.r{text-align:right}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px 8px;text-align:left}
.stamps{display:flex;gap:16px;margin-top:32px;font-family:system-ui,sans-serif}.stamp{flex:1;border:2px solid #0F766E;border-radius:10px;padding:10px 12px;color:#0F766E;font-size:12px}.stamp.no{border-color:#bbb;color:#888;border-style:dashed}.stamp b{display:block;font-size:13px;margin-bottom:4px}
.bar{font-family:system-ui,sans-serif;background:#f4f4f2;padding:10px 14px;border-radius:8px;display:flex;justify-content:space-between;gap:12px;margin-bottom:24px;font-size:13px}.bar a{margin-left:12px}@media print{.bar{display:none}}</style>`;
const page = (title, inner, css = PRINT_CSS) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${css}</head><body>${inner}</body></html>`;
const toLogin = (res) => { res.writeHead(302, { Location: '/app#/login' }); res.end(); return true; };
const verifyUrl = (h) => `${mailer.APP_URL}/verify/${h}`;

async function handlePages(req, res, url) {
  let m;
  if ((m = url.pathname.match(/^\/doc\/(\d+)(\.pdf)?$/))) {
    const user = sessionUser(req); if (!user) return toLogin(res);
    let d; try { d = docForUser(user, m[1]); } catch { return send(res, 404, page('Не найдено', '<h2>Документ не найден</h2>')), true; }
    const second = d.party === 'employee' ? 'Работник' : 'Исполнитель', first = d.party === 'employee' ? 'Работодатель' : 'Заказчик';
    if (m[2]) {
      const buf = pdf.documentPdf(d, { companyName: d.company_name, personName: d.full_name, verifyUrl: d.sign_hash ? verifyUrl(d.sign_hash) : null });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${encodeURIComponent(d.number)}.pdf"`, 'Cache-Control': 'private, no-store' });
      res.end(buf); return true;
    }
    const st = (who, at, extra) => at ? `<div class="stamp"><b>Подписано ПЭП · ${who}</b>${esc(extra)}<br>${esc(at)} UTC</div>` : `<div class="stamp no"><b>${who}</b>Ожидает подписи</div>`;
    send(res, 200, page(d.title, `<div class="bar"><span>${esc(L.BRAND)} · ${esc(d.title)}</span><span><a href="/doc/${d.id}.pdf">Скачать PDF</a><a href="#" onclick="print();return false">Печать</a></span></div>${d.body}
      <div class="stamps">${d.type === 'kedo_consent' ? '' : st(first, d.company_signed_at, d.company_name + (d.company_signer ? ', ' + d.company_signer : ''))}${st(second, d.contractor_signed_at, d.full_name)}</div>
      ${d.sign_hash ? `<p style="font:11px monospace;color:#666;margin-top:16px">SHA-256: ${d.sign_hash}<br>Проверка подлинности: <a href="/verify/${d.sign_hash}">${esc(verifyUrl(d.sign_hash))}</a></p>` : ''}`));
    return true;
  }
  if ((m = url.pathname.match(/^\/verify\/([0-9a-fA-F]{64})$/))) {
    const h = m[1].toLowerCase();
    const d = q.get(`SELECT d.number,d.title,d.company_signed_at,d.contractor_signed_at,c.name company FROM documents d JOIN companies c ON c.id=d.company_id WHERE d.sign_hash=? AND d.status='signed'`, h);
    const css = `<style>body{font-family:system-ui,sans-serif;background:#F6F5F1;display:flex;justify-content:center;padding:60px 16px;color:#0B1B2B}.c{background:#fff;border:1px solid #E4E2DB;border-radius:18px;padding:28px;max-width:520px;width:100%}.ok{color:#0B5F58}.bad{color:#B42318}dl{display:grid;grid-template-columns:150px 1fr;gap:8px;font-size:14px}dt{color:#6B7785}code{font-size:11px;word-break:break-all;color:#6B7785}</style>`;
    send(res, d ? 200 : 404, page('Проверка документа', d ? `<div class="c"><h2 class="ok">✓ Документ подлинный</h2><p>Документ с такой контрольной суммой подписан обеими сторонами на платформе ${esc(L.BRAND)} и не изменялся.</p>
      <dl><dt>Документ</dt><dd>${esc(d.title)}</dd><dt>Сторона 1</dt><dd>${esc(d.company)}</dd><dt>Подписан</dt><dd>${esc(d.company_signed_at)} / ${esc(d.contractor_signed_at)} UTC</dd></dl><p><code>${h}</code></p></div>`
      : `<div class="c"><h2 class="bad">✗ Документ не найден</h2><p>Подписанного документа с такой контрольной суммой нет. Возможно, документ был изменён.</p><p><code>${h}</code></p></div>`, css));
    return true;
  }
  if ((m = url.pathname.match(/^\/receipt\/(\w{6,40})$/))) {
    const p = q.get(`SELECT p.*, k.full_name, k.inn, c.name company, c.inn company_inn FROM payouts p JOIN contractors k ON k.id=p.contractor_id JOIN companies c ON c.id=p.company_id WHERE p.receipt_number=?`, m[1]);
    if (!p) return send(res, 404, page('Чек не найден', '<h2>Чек не найден</h2>')), true;
    send(res, 200, page(`Чек №${p.receipt_number}`, `<div class="r"><h1>Чек № ${esc(p.receipt_number)}</h1><div class="cc">${esc(p.paid_at || '')} UTC</div><div class="hr"></div>
<div>${esc(p.full_name)}</div><div>ИНН ${esc(p.inn || '—')}</div><div>Режим НО: НПД</div><div class="hr"></div>
<div class="row"><span>1. ${esc(p.purpose || 'Услуги')}</span></div><div class="row big"><span>Итого:</span><span>${L.fmtMoney(p.amount)}</span></div><div class="hr"></div>
<div>Покупатель: ${esc(p.company)}</div><div>ИНН покупателя: ${esc(p.company_inn || '—')}</div>
<div class="note">Чек сформирован ${esc(L.BRAND)} от имени налогоплательщика.${process.env.DEMO_MODE !== '0' ? ' Демо-режим: в боевой версии чек регистрируется в ФНС через API партнёра «Мой налог».' : ''}</div></div>`,
    `<style>body{background:#eef0ee;font-family:ui-monospace,Menlo,monospace;display:flex;justify-content:center;padding:40px 12px}.r{background:#fff;width:340px;padding:24px;border-radius:4px;box-shadow:0 8px 30px #0001;font-size:13px}.r h1{font-size:15px;text-align:center;margin:0 0 4px}.cc{text-align:center;color:#666}.row{display:flex;justify-content:space-between;margin:6px 0}.hr{border-top:1px dashed #aaa;margin:12px 0}.big{font-size:18px;font-weight:700}.note{font-size:11px;color:#888;margin-top:14px}</style>`));
    return true;
  }
  if ((m = url.pathname.match(/^\/invoice\/(\d+)$/))) {
    const user = sessionUser(req); if (!user || user.role !== 'company') return toLogin(res);
    const inv = q.get('SELECT * FROM invoices WHERE id=? AND company_id=?', m[1], user.company_id);
    if (!inv) return send(res, 404, page('Не найдено', '<h2>Счёт не найден</h2>')), true;
    const c = q.get('SELECT * FROM companies WHERE id=?', user.company_id);
    send(res, 200, page('Счёт ' + inv.number, `<div class="bar"><span>${esc(L.BRAND)}</span><a href="#" onclick="print();return false">Печать / PDF</a></div>
      <h2>СЧЁТ НА ОПЛАТУ № ${esc(inv.number)} от ${new Date(inv.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ru-RU')}</h2>
      <table><tr><th>Получатель</th><td>${esc(process.env.OPERATOR_NAME || 'ООО «' + L.BRAND + '»')} (номинальный счёт)<br>${esc(process.env.OPERATOR_REQUISITES || 'Реквизиты номинального счёта указываются оператором при подключении банка')}</td></tr>
      <tr><th>Плательщик</th><td>${esc(c.name)}, ИНН ${esc(c.inn || '—')}</td></tr></table>
      <table><tr><th>Назначение</th><th>Сумма</th></tr><tr><td>Пополнение номинального счёта для выплат исполнителям. Без НДС</td><td>${L.fmtMoney(inv.amount)}</td></tr></table>
      <p>В назначении платежа обязательно укажите: «Пополнение по счёту ${esc(inv.number)}».</p>`));
    return true;
  }
  return false;
}
module.exports = { handlePages };
