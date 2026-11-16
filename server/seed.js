'use strict';
const crypto = require('node:crypto');
const { q, K } = require('./db');
const L = require('./logic');
const S = require('./security');

function innFL(seed) {
  const d = String(seed).padStart(10, '7').slice(0, 10).split('').map(Number);
  const c = (w, arr) => (w.reduce((s, k, i) => s + k * arr[i], 0) % 11) % 10;
  d.push(c([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d));
  d.push(c([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d));
  return d.join('');
}
function cardNum(prefix) {
  const d = (prefix + '000000000000000').slice(0, 15).split('').map(Number);
  let s = 0; d.slice().reverse().forEach((x, i) => { if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } s += x; });
  return d.join('') + ((10 - (s % 10)) % 10);
}
// ИНН, для которого демо-проверка НПД даёт нужный результат
const innFor = (s, active) => { let x = s, v; do { v = innFL(x++); } while ((Number(v[11]) % 5 !== 0) !== active); return v; };

function seed() {
  const mk = (email, pass, role, companyId, name, phone, team = 'owner') => {
    const { hash, salt } = S.hashPassword(pass);
    return Number(q.run('INSERT INTO users (email,phone,name,pass_hash,salt,role,company_id,team_role,email_verified) VALUES (?,?,?,?,?,?,?,?,1)', email, phone, name, hash, salt, role, companyId, team).lastInsertRowid);
  };
  const cId = Number(q.run(`INSERT INTO companies (name,inn,kpp,ogrn,address,bank,bik,account,director,balance,plan,notify_emails,webhook_secret)
    VALUES ('ООО «Северный ветер»','7707083893','770701001','1027700132195','г. Москва, ул. Тверская, д. 1','АО «Т-Банк»','044525974','40702810900000012345','Иванова А. С.',0,'business','buh@severveter.ru',?)`, S.token(24)).lastInsertRowid);
  mk('demo@samoletpay.ru', 'demo1234', 'company', cId, 'Анна Иванова', '+79001234567');
  mk('buh@samoletpay.ru', 'demo1234', 'company', cId, 'Олег Бухгалтеров', '+79001112233', 'accountant');
  mk('manager@samoletpay.ru', 'demo1234', 'company', cId, 'Мария Менеджерова', '+79001112244', 'manager');
  mk('admin@samoletpay.ru', 'admin1234', 'admin', null, 'Оператор платформы', null);
  const contractorUser = mk('ivan@samoletpay.ru', 'demo1234', 'contractor', null, 'Иван Петров', '+79005556677');

  const people = [
    ['Иван Петров', 'npd', 'Курьерская доставка', 'ivan@samoletpay.ru', '+79005556677', 123456781],
    ['Мария Соколова', 'npd', 'Дизайн', 'maria@example.com', '+79005550001', 234567812],
    ['Алексей Кузнецов', 'npd', 'Разработка', 'alex@example.com', '+79005550002', 345678123],
    ['Екатерина Смирнова', 'ip', 'Бухгалтерские услуги', 'kate@example.com', '+79005550003', 456781234],
    ['Дмитрий Волков', 'npd', 'Клининг', 'dima@example.com', '+79005550004', 567812345],
    ['Нурлан Ахметов', 'eaeu', 'Строительные работы', 'nurlan@example.com', '+77015550005', 678123456],
    ['Ольга Морозова', 'fl', 'Преподавание', 'olga@example.com', '+79005550006', 781234567],
    ['Сергей Новиков', 'npd', 'Фитнес-тренер', 'sergey@example.com', '+79005550007', 812345670],
    ['Павел Орлов', 'npd', 'Маркетинг', 'pavel@example.com', '+79005550008', 912345671],
  ];
  const kIds = people.map(([name, type, spec, email, phone, s], i) => {
    const npd = type === 'npd' ? (i === 4 ? 'inactive' : 'active') : 'unknown';
    // Павел Орлов — уволился 8 месяцев назад: выплаты как самозанятому заблокированы
    const fired = i === 8 ? new Date(Date.now() - 240 * 864e5).toISOString().slice(0, 10) : null;
    return Number(q.run(`INSERT INTO contractors (company_id,user_id,type,full_name,inn,phone,email,card,specialty,npd_status,npd_checked_at,npd_source,status,former_employee_until)
      VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),'demo','active',?)`, cId, i === 0 ? contractorUser : null, type, name, innFor(s, i !== 4), phone, email, cardNum('22004' + (s % 1e10)), spec, npd, fired).lastInsertRowid);
  });

  kIds.forEach((id, i) => {
    const docId = L.createDocument(cId, { contractor_id: id }, 'contract', { subject: people[i][2] });
    if (i < 6 || i === 8) {
      const d = q.get('SELECT * FROM documents WHERE id=?', docId);
      const h = crypto.createHash('sha256').update(d.body + docId).digest('hex');
      q.run(`UPDATE documents SET status='signed', company_signed_at=datetime('now','-40 day'), company_signer='Анна Иванова', contractor_signed_at=datetime('now','-39 day'), sign_hash=? WHERE id=?`, h, docId);
    }
  });

  // сотрудники для КЭДО
  const e1 = Number(q.run(`INSERT INTO employees (company_id,full_name,position,department,email,phone,hired_at,kedo_consent,status) VALUES (?,?,?,?,?,?,date('now','-300 day'),1,'active')`, cId, 'Елена Кадрова', 'Офис-менеджер', 'Администрация', 'elena@example.com', '+79005551001').lastInsertRowid);
  const e2 = Number(q.run(`INSERT INTO employees (company_id,full_name,position,department,email,phone,hired_at) VALUES (?,?,?,?,?,?,date('now','-5 day'))`, cId, 'Игорь Новичков', 'Менеджер по продажам', 'Продажи', 'igor@example.com', '+79005551002').lastInsertRowid);
  L.createDocument(cId, { employee_id: e2 }, 'kedo_consent', {});
  L.createDocument(cId, { employee_id: e1 }, 'lna', { subject: 'Положение о защите персональных данных' });

  // пополнение и история выплат за полгода (всё в копейках)
  const company = q.get('SELECT * FROM companies WHERE id=?', cId);
  let balanceK = K(3_000_000);
  q.run(`INSERT INTO invoices (company_id,number,amount,status,created_at) VALUES (?,?,?,?,datetime('now','-170 day'))`, cId, `СЧ-${cId}-0001`, balanceK, 'paid');
  q.run(`INSERT INTO transactions (company_id,type,amount,description,created_at) VALUES (?,?,?,?,datetime('now','-170 day'))`, cId, 'topup', balanceK, `Пополнение по счёту СЧ-${cId}-0001`);
  for (let m = 5; m >= 0; m--) {
    const reg = Number(q.run(`INSERT INTO registries (company_id,title,status,created_at) VALUES (?,?,'done',datetime('now',?))`, cId, `Выплаты за ${monthName(m)}`, `-${m * 30 + 2} day`).lastInsertRowid);
    [0, 1, 2, 3, 5, 7].forEach((ki, j) => {
      const k = q.get('SELECT * FROM contractors WHERE id=?', kIds[ki]);
      const amount = Math.round((25000 + ((m * 7 + j * 13) % 9) * 6500) / 100) * 100;
      const c = L.calcPayout(company, k, amount);
      const when = `-${m * 30 + 1} day`;
      q.run(`INSERT INTO payouts (company_id,contractor_id,registry_id,amount,commission,tax,net,purpose,status,receipt_number,bank_ref,paid_at,created_at)
        VALUES (?,?,?,?,?,?,?,?, 'paid', ?, ?, datetime('now',?), datetime('now',?))`, cId, k.id, reg, c.k.amount, c.k.commission, c.k.tax, c.k.net, `Оплата услуг: ${k.specialty}`,
        k.type === 'npd' ? '20' + crypto.randomBytes(5).toString('hex') : null, 'DEMO-SEED', when, when);
      q.run(`INSERT INTO transactions (company_id,type,amount,description,created_at) VALUES (?,?,?,?,datetime('now',?))`, cId, 'payout', -c.k.amount, `Выплата ${k.full_name}`, when);
      q.run(`INSERT INTO transactions (company_id,type,amount,description,created_at) VALUES (?,?,?,?,datetime('now',?))`, cId, 'commission', -c.k.commission, 'Комиссия сервиса', when);
      balanceK -= c.k.debit;
    });
  }
  q.run('UPDATE companies SET balance=? WHERE id=?', balanceK, cId);

  const t = (title, cat, budget, desc, city, status = 'open', k = null) => q.run(`INSERT INTO tasks (company_id,title,description,category,budget,deadline,city,status,contractor_id) VALUES (?,?,?,?,?,date('now','+7 day'),?,?,?)`, cId, title, desc, cat, K(budget), city, status, k);
  t('Дизайн лендинга для акции', 'Дизайн', 45000, 'Нужен одностраничный сайт в фирменном стиле, 3 итерации правок.', 'Удалённо');
  t('Генеральная уборка офиса 300 м²', 'Клининг', 18000, 'Суббота, с 10:00. Инвентарь наш.', 'Москва');
  t('Доставка документов по городу', 'Логистика', 3500, '5 адресов, в течение дня.', 'Москва', 'in_progress', kIds[0]);
  t('Вёрстка email-рассылки', 'Разработка', 12000, 'Адаптивный шаблон под 3 почтовых клиента.', 'Удалённо');

  q.run(`INSERT INTO outstaff (company_id,role,headcount,start_date,duration,rate,city,description,status) VALUES (?,?,?,date('now','+3 day'),'2 месяца','от 900 ₽/час','Москва','Сборка заказов на складе','search')`, cId, 'Комплектовщик', 5);
  q.run(`INSERT INTO leads (kind,name,phone,company,message) VALUES ('business','Алексей','+79990000000','ООО «Клин-Сервис»','Хотим перевести 40 клинеров на самозанятость')`);
  q.run(`INSERT INTO templates (company_id,party,title,body) VALUES (?,?,?,?)`, cId, 'contractor', 'Договор на фотосъёмку',
    '# ДОГОВОР НА ФОТОСЪЁМКУ № {{номер}}\n\n{{дата}}\n\n{{компания}} (ИНН {{компания.инн}}) и {{фио}} (ИНН {{инн}}) договорились о проведении фотосъёмки: {{предмет}}.\n\n## Стоимость\n\nСтоимость работ — {{сумма}}. Срок сдачи материалов — {{срок}}.\n\n## Права\n\nИсключительные права на фотографии переходят к Заказчику с момента оплаты.');
  L.notify({ company_id: cId, kind: 'risk', text: 'Дмитрий Волков: статус самозанятого не подтверждён ФНС — выплаты приостановлены' });
  L.notify({ company_id: cId, kind: 'risk', text: 'Павел Орлов уволился менее 2 лет назад — выплаты как самозанятому заблокированы' });
  console.log('Демо-данные: demo@samoletpay.ru / buh@samoletpay.ru / manager@samoletpay.ru / ivan@samoletpay.ru — пароль demo1234; оператор admin@samoletpay.ru / admin1234');
}
function monthName(back) { const d = new Date(); d.setMonth(d.getMonth() - back); return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }); }

module.exports = { seed, innFL, cardNum, innFor };
if (require.main === module) seed();
