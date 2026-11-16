'use strict';
/**
 * Персистентная очередь задач на SQLite. Переживает перезапуск сервера:
 * задачи в статусе running при старте возвращаются в очередь.
 * Повторы с экспоненциальной задержкой, unique_key защищает от дублей.
 */
const { q } = require('./db');

const handlers = {};
const register = (type, fn) => { handlers[type] = fn; };

function enqueue(type, payload = {}, { delayMs = 0, uniqueKey = null, maxAttempts = 5 } = {}) {
  try {
    return Number(q.run('INSERT INTO jobs (type,payload,run_at,unique_key,max_attempts) VALUES (?,?,?,?,?)',
      type, JSON.stringify(payload), Date.now() + delayMs, uniqueKey, maxAttempts).lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return null; // такая задача уже в очереди
    throw e;
  }
}

let timer = null, busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (let i = 0; i < 20; i++) {
      const job = q.get(`SELECT * FROM jobs WHERE status='queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1`, Date.now());
      if (!job) break;
      const claimed = q.run(`UPDATE jobs SET status='running', attempts=attempts+1, updated_at=datetime('now') WHERE id=? AND status='queued'`, job.id).changes;
      if (!claimed) continue;
      const fn = handlers[job.type];
      try {
        if (!fn) throw new Error('Нет обработчика ' + job.type);
        await fn(JSON.parse(job.payload), job);
        q.run(`UPDATE jobs SET status='done', last_error=NULL, updated_at=datetime('now') WHERE id=?`, job.id);
      } catch (e) {
        const attempts = job.attempts + 1;
        const final = attempts >= job.max_attempts || e.permanent;
        q.run(`UPDATE jobs SET status=?, last_error=?, run_at=?, updated_at=datetime('now') WHERE id=?`,
          final ? 'failed' : 'queued', String(e.message).slice(0, 500), Date.now() + Math.min(3600e3, 2000 * 2 ** attempts), job.id);
        if (final && handlers[job.type + ':failed']) { try { await handlers[job.type + ':failed'](JSON.parse(job.payload), e); } catch {} }
        if (!e.quiet) console.error(`[job ${job.id} ${job.type}] попытка ${attempts}:`, e.message);
      }
    }
  } finally { busy = false; }
}

/* периодические задачи: раз в interval, по ключу — без дублей */
const schedules = [];
function every(type, intervalMs, payload = {}) { schedules.push({ type, intervalMs, payload, next: Date.now() + 5000 }); }
function runSchedules() {
  const now = Date.now();
  for (const s of schedules) if (s.next <= now) { enqueue(s.type, s.payload, { uniqueKey: 'sched:' + s.type, maxAttempts: 1 }); s.next = now + s.intervalMs; }
}

function start(pollMs = Number(process.env.JOBS_POLL_MS || 400)) {
  q.run(`UPDATE jobs SET status='queued' WHERE status='running'`); // восстановление после падения
  timer = setInterval(() => { runSchedules(); tick(); }, pollMs);
  timer.unref && timer.unref();
}
function stop() { clearInterval(timer); }
const drain = async () => { for (let i = 0; i < 50; i++) { await tick(); if (!q.get(`SELECT id FROM jobs WHERE status IN ('queued','running') AND run_at<=?`, Date.now())) return; } };

module.exports = { register, enqueue, start, stop, every, tick, drain };
