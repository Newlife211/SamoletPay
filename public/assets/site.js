/* Общий хедер/футер, заявки, проверка НПД для публичных страниц */
(function () {
  const BRAND = 'PayOut';
  const path = location.pathname;
  const nav = [['/', 'Бизнесу'], ['/contractors', 'Исполнителям'], ['/tariffs', 'Тарифы'], ['/knowledge', 'База знаний'], ['/developers', 'API']];
  const h = document.getElementById('site-h');
  if (h) {
    h.className = 'site-h';
    h.innerHTML = `<div class="container">
      <a class="logo" href="/"><i></i>${BRAND}</a>
      <nav id="nav">${nav.map(([u, t]) => `<a href="${u}" class="${u === path ? 'on' : ''}">${t}</a>`).join('')}</nav>
      <div class="acts"><a class="btn btn-ghost btn-sm" href="/app#/login">Войти</a><a class="btn btn-primary btn-sm" href="/app#/register">Начать бесплатно</a>
      <button class="burger" aria-label="Меню" onclick="document.getElementById('nav').classList.toggle('open')"><span></span><span></span><span></span></button></div></div>`;
    addEventListener('scroll', () => h.classList.toggle('scrolled', scrollY > 8), { passive: true });
  }
  const f = document.getElementById('site-f');
  if (f) {
    f.className = 'site-f';
    f.innerHTML = `<div class="container"><div class="cols">
      <div><a class="logo" href="/"><i></i>${BRAND}</a><p style="margin-top:14px;max-width:300px">Договоры, подписи и выплаты исполнителям — в одном окне. Без бумаги и ручной сверки.</p>
        <p><a href="tel:+78000000000" style="display:inline;font-weight:700;color:var(--ink)">8 800 000-00-00</a><br><span class="muted">Ежедневно 9:00–21:00 МСК, чат — 24/7</span></p></div>
      <div><h5>Продукт</h5><a href="/#solutions">Решения</a><a href="/tariffs">Тарифы и калькулятор</a><a href="/developers">Open API</a><a href="/app#/register">Регистрация</a></div>
      <div><h5>Исполнителям</h5><a href="/contractors">Как получать выплаты</a><a href="/contractors#check">Проверить статус НПД</a><a href="/app#/register?role=contractor">Кабинет исполнителя</a></div>
      <div><h5>Компания</h5><a href="/knowledge">База знаний</a><a href="/knowledge#faq">Вопросы и ответы</a><a href="/privacy">Политика конфиденциальности</a><a href="mailto:hello@payout.example">hello@payout.example</a></div>
    </div><div class="legal"><span>© ${new Date().getFullYear()} ${BRAND}. Реквизиты оператора публикуются после регистрации юрлица.</span><span>Расчёты через номинальные счета банков-партнёров</span></div></div>`;
  }

  window.toast = function (msg, err) {
    let w = document.querySelector('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 4200);
  };
  async function post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Ошибка'); return j;
  }
  // формы заявок
  document.querySelectorAll('form[data-lead]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form)); data.kind = form.dataset.lead;
    try { await post('/api/leads', data); form.innerHTML = '<h3>Спасибо!</h3><p class="muted">Мы свяжемся с вами в течение 15 минут в рабочее время.</p>'; }
    catch (err) { toast(err.message, true); }
  }));
  // проверка НПД
  document.querySelectorAll('form[data-npd]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = form.querySelector('.npd-res'); out.textContent = 'Проверяем в ФНС…';
    try {
      const r = await post('/api/public/npd-check', { inn: form.inn.value });
      out.innerHTML = r.status === 'active' ? `<span class="chip ok">Самозанятый</span> ${r.message || ''}` : r.status === 'invalid' ? `<span class="chip bad">Ошибка</span> ${r.message}` : `<span class="chip warn">Не самозанятый</span> ${r.message || ''}`;
    } catch (err) { out.textContent = err.message; }
  }));
  // лёгкая анимация чисел
  document.querySelectorAll('[data-count]').forEach((el) => {
    const end = +el.dataset.count, suf = el.dataset.suffix || ''; let s = 0;
    const io = new IntersectionObserver(([en]) => { if (!en.isIntersecting) return; io.disconnect();
      const t0 = performance.now(); const tick = (t) => { const p = Math.min(1, (t - t0) / 900); el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))).toLocaleString('ru-RU') + suf; if (p < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    io.observe(el);
  });
})();
