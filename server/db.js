'use strict';
/**
 * Хранилище. Деньги хранятся в КОПЕЙКАХ (INTEGER). Обёртка q автоматически
 * переводит денежные поля в рубли при чтении; при записи передавайте K(рубли).
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'samoletpay.db');
const SCHEMA_VERSION = 2;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = new DatabaseSync(DB_PATH);
const ver = db.prepare('PRAGMA user_version').get().user_version;
const hasTables = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'`).get().n > 0;
if (hasTables && ver < SCHEMA_VERSION) {
  // MVP до запуска: старая схема (рубли в REAL) несовместима — сохраняем копию и создаём новую БД
  db.close();
  const bak = DB_PATH + '.v' + ver + '.' + Date.now() + '.bak';
  fs.renameSync(DB_PATH, bak);
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} }
  console.warn(`[db] Схема v${ver} устарела, копия сохранена в ${bak}. Создана новая БД v${SCHEMA_VERSION}.`);
  db = new DatabaseSync(DB_PATH);
}
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, inn TEXT, kpp TEXT, ogrn TEXT, address TEXT, bank TEXT, bik TEXT, account TEXT, director TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  plan TEXT NOT NULL DEFAULT 'start',
  tax_service INTEGER NOT NULL DEFAULT 1,
  brand_color TEXT DEFAULT '#0F766E', brand_name TEXT,
  webhook_url TEXT, webhook_secret TEXT,
  sign_method TEXT NOT NULL DEFAULT 'sms',
  notify_emails TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL, phone TEXT, name TEXT,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('company','contractor','admin')),
  company_id INTEGER REFERENCES companies(id),
  team_role TEXT DEFAULT 'owner',
  profile TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT, ua TEXT,
  pending_2fa INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reset','verify')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'npd' CHECK (type IN ('npd','fl','ip','eaeu')),
  full_name TEXT NOT NULL, inn TEXT, phone TEXT, email TEXT,
  card TEXT, bank_account TEXT, bik TEXT,
  citizenship TEXT DEFAULT 'РФ', specialty TEXT,
  former_employee_until TEXT,
  npd_status TEXT NOT NULL DEFAULT 'unknown', npd_checked_at TEXT, npd_source TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_contr_company ON contractors(company_id);
CREATE INDEX IF NOT EXISTS ix_contr_user ON contractors(user_id);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER REFERENCES users(id),
  full_name TEXT NOT NULL, position TEXT, department TEXT,
  email TEXT, phone TEXT, inn TEXT, snils TEXT,
  hired_at TEXT, fired_at TEXT,
  kedo_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  party TEXT NOT NULL CHECK (party IN ('contractor','employee')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  party TEXT NOT NULL DEFAULT 'contractor' CHECK (party IN ('contractor','employee')),
  contractor_id INTEGER REFERENCES contractors(id),
  employee_id INTEGER REFERENCES employees(id),
  type TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  amount INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  company_signed_at TEXT, company_signer TEXT, contractor_signed_at TEXT,
  sign_hash TEXT, task_id INTEGER, template_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (contractor_id IS NOT NULL OR employee_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_docs_company ON documents(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_docs_hash ON documents(sign_hash) WHERE sign_hash IS NOT NULL;
-- подписанный документ неизменяем
CREATE TRIGGER IF NOT EXISTS tr_docs_immutable BEFORE UPDATE ON documents
  WHEN OLD.status = 'signed' AND (NEW.body <> OLD.body OR NEW.amount IS NOT OLD.amount OR NEW.status <> OLD.status OR NEW.sign_hash IS NOT OLD.sign_hash)
  BEGIN SELECT RAISE(ABORT, 'Подписанный документ изменять нельзя'); END;
CREATE TRIGGER IF NOT EXISTS tr_docs_nodelete BEFORE DELETE ON documents WHEN OLD.status = 'signed'
  BEGIN SELECT RAISE(ABORT, 'Подписанный документ удалять нельзя'); END;
CREATE TABLE IF NOT EXISTS sign_codes (
  id INTEGER PRIMARY KEY,
  doc_ids TEXT NOT NULL, user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, description TEXT, category TEXT,
  budget INTEGER NOT NULL, deadline TEXT, city TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  contractor_id INTEGER REFERENCES contractors(id),
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT, price INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, user_id)
);
CREATE TABLE IF NOT EXISTS registries (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contractor_id INTEGER NOT NULL REFERENCES contractors(id),
  registry_id INTEGER REFERENCES registries(id), split_id INTEGER, task_id INTEGER,
  amount INTEGER NOT NULL CHECK (amount > 0),
  commission INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  fail_reason TEXT, receipt_number TEXT, bank_ref TEXT,
  idempotency_key TEXT,
  created_by INTEGER,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payout_idem ON payouts(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payouts_company ON payouts(company_id, status);
CREATE INDEX IF NOT EXISTS ix_payouts_contractor ON payouts(contractor_id);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL, amount INTEGER NOT NULL, description TEXT, ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  number TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS splits (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, amount INTEGER NOT NULL,
  agency_fee_pct REAL NOT NULL DEFAULT 10,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payer_name TEXT, paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS split_parts (
  id INTEGER PRIMARY KEY,
  split_id INTEGER NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id),
  share_pct REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outstaff (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL, headcount INTEGER NOT NULL DEFAULT 1,
  start_date TEXT, duration TEXT, rate TEXT, city TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'new', manager_note TEXT, staffed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT, key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, last4 TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL, event TEXT, url TEXT, status TEXT, attempt INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  company_id INTEGER, user_id INTEGER, kind TEXT, text TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  kind TEXT, name TEXT, phone TEXT, email TEXT, company TEXT, message TEXT,
  status TEXT NOT NULL DEFAULT 'new', note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  to_addr TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', provider TEXT, provider_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL, last_error TEXT, unique_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_unique ON jobs(unique_key) WHERE unique_key IS NOT NULL AND status IN ('queued','running');
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  company_id INTEGER, user_id INTEGER, actor TEXT,
  action TEXT NOT NULL, entity TEXT, details TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_company ON audit_log(company_id, id);
`);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

/* ---------- деньги ---------- */
const MONEY_KEYS = new Set(['balance', 'amount', 'commission', 'tax', 'net', 'budget', 'price', 'total', 'paid_total', 'paid_month', 'year_income', 'debit']);
const K = (rub) => Math.round(Number(rub) * 100);           // рубли → копейки
const R = (kop) => (kop === null || kop === undefined ? kop : Number(kop) / 100); // копейки → рубли
function conv(row) {
  if (!row) return row;
  const o = { ...row };
  for (const k in o) if (MONEY_KEYS.has(k) && typeof o[k] === 'number') o[k] = R(o[k]);
  return o;
}

const q = {
  get: (sql, ...p) => conv(db.prepare(sql).get(...p)),
  all: (sql, ...p) => db.prepare(sql).all(...p).map(conv),
  run: (sql, ...p) => db.prepare(sql).run(...p),
  raw: (sql, ...p) => db.prepare(sql).get(...p), // без конвертации (значения в копейках)
  tx(fn) {
    if (q._depth) { q._depth++; try { return fn(); } finally { q._depth--; } }
    q._depth = 1; db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { q._depth = 0; }
  },
  _depth: 0,
};

module.exports = { db: () => db, q, K, R, DB_PATH, SCHEMA_VERSION };
