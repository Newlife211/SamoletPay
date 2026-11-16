'use strict';
/**
 * Исходящие письма и SMS. Каждое сообщение сохраняется в таблицу messages
 * и отправляется фоновой задачей через провайдера:
 *   SMS:   SMS_PROVIDER=smsru  + SMSRU_API_ID           (https://sms.ru)
 *   Email: EMAIL_PROVIDER=unisender + UNISENDER_API_KEY + EMAIL_FROM  (Unisender Go)
 * По умолчанию провайдер «log»: сообщение остаётся в журнале (видно оператору).
 */
const { q } = require('./db');

const APP_URL = (process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');
const BRAND = process.env.BRAND || 'PayOut';

function enqueue(channel, to, subject, body) {
  if (!to) return null;
  const id = Number(q.run('INSERT INTO messages (channel,to_addr,subject,body) VALUES (?,?,?,?)', channel, String(to).trim(), subject || null, body).lastInsertRowid);
  require('./jobs').enqueue('message.send', { id });
  return id;
}
const email = (to, subject, body) => enqueue('email', to, subject, body);
const sms = (to, body) => enqueue('sms', to, null, body);

async function deliver(id) {
  const m = q.get('SELECT * FROM messages WHERE id=?', id);
  if (!m || m.status === 'sent') return;
  let provider = 'log', resp = 'stored';
  if (m.channel === 'sms' && process.env.SMS_PROVIDER === 'smsru' && process.env.SMSRU_API_ID) {
    provider = 'smsru';
    const url = `https://sms.ru/sms/send?api_id=${encodeURIComponent(process.env.SMSRU_API_ID)}&to=${encodeURIComponent(m.to_addr.replace(/\D/g, ''))}&msg=${encodeURIComponent(m.body)}&json=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    resp = JSON.stringify(j).slice(0, 500);
    if (j.status !== 'OK') throw new Error('sms.ru: ' + resp);
  } else if (m.channel === 'email' && process.env.EMAIL_PROVIDER === 'unisender' && process.env.UNISENDER_API_KEY) {
    provider = 'unisender';
    const r = await fetch('https://go1.unisender.ru/ru/transactional/api/v1/email/send.json', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.UNISENDER_API_KEY },
      body: JSON.stringify({ message: { recipients: [{ email: m.to_addr }], subject: m.subject, from_email: process.env.EMAIL_FROM || 'noreply@payout.example', from_name: BRAND, body: { plaintext: m.body } } }),
    });
    resp = (await r.text()).slice(0, 500);
    if (!r.ok) throw new Error('unisender: ' + resp);
  }
  q.run(`UPDATE messages SET status='sent', provider=?, provider_response=? WHERE id=?`, provider, resp, id);
}

/* ---------- шаблоны сообщений ---------- */
const T = {
  invite: (who, company, kind) => [`${company} приглашает вас в ${BRAND}`,
    `Здравствуйте, ${who}!\n\n${company} добавил(а) вас как ${kind === 'employee' ? 'сотрудника для кадрового ЭДО' : 'исполнителя'}. Зарегистрируйтесь по ссылке, чтобы подписывать документы${kind === 'employee' ? '' : ' и получать выплаты'}:\n${APP_URL}/app#/register?role=contractor\n\nКоманда ${BRAND}`],
  signCode: (code) => `${BRAND}: код подписи ${code}. Никому не сообщайте его.`,
  reset: (link) => [`Восстановление пароля ${BRAND}`, `Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):\n${link}\n\nЕсли вы не запрашивали восстановление, просто проигнорируйте письмо.`],
  verify: (link) => [`Подтвердите email в ${BRAND}`, `Подтвердите адрес, перейдя по ссылке:\n${link}`],
  payoutPaid: (company, who, amount) => [`Выплата проведена: ${who}`, `${company}: выплата исполнителю ${who} на сумму ${amount} проведена.`],
  docToSign: (company, title) => `${BRAND}: ${company} отправил(а) документ «${title}» на подпись. ${APP_URL}/app`,
};

module.exports = { email, sms, deliver, T, APP_URL };
