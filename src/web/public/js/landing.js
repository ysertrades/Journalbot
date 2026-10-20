'use strict';
/* The landing page: reveals on scroll, a pointer-tilted stage, live counts, the card switcher. */
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // rise into place once, as each part scrolls in
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  const stage = $('.stage');
  const start = () => { stage?.classList.remove('pre'); stage?.classList.add('land'); $$('.reveal, .mock').forEach((el) => io.observe(el)); };

  // the intro, "the open": on every visit and every refresh, start to finish. The curtain is the page's
  // first paint (index.html styles it inline), so the page underneath never flashes before it.
  const intro = $('#intro');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';   // a refresh opens at the top, where the curtain lifts
  scrollTo(0, 0);
  if (!intro) start();
  else {
    document.documentElement.style.overflow = 'hidden';
    const clock = $('#intro-clock'), ticks = ['09:29:57', '09:29:58', '09:29:59', '09:30:00'];
    // with reduced motion the open still happens, just without the travel: quicker, and the line appears instead of drawing
    const beat = reduce ? 160 : 330, hold = reduce ? 700 : 1700;
    ticks.forEach((t, i) => setTimeout(() => { clock.textContent = t; if (i === ticks.length - 1) intro.classList.add('open'); }, 520 + i * beat));
    setTimeout(() => {
      intro.classList.add('lift'); document.documentElement.style.overflow = '';
      setTimeout(start, 380);                                   // the hero rises as the curtain clears it
      setTimeout(() => intro.classList.add('gone'), 1150);
    }, 520 + 3 * beat + hold);                                  // the line draws, "Market open." lands, then the curtain lifts
  }

  // the stage and the web mock lean toward the pointer
  const plane = $('#plane'), mock = $('#mock');
  if (!reduce && matchMedia('(hover: hover)').matches) {
    let raf = 0;
    addEventListener('pointermove', (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
        if (plane) { plane.style.setProperty('--rx', `${52 - y * 10}deg`); plane.style.setProperty('--rz', `${-24 + x * 12}deg`); }
        if (mock) { const r = mock.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) { mock.style.setProperty('--my', `${x * 6}deg`); mock.style.setProperty('--mx', `${6 - y * 6}deg`); } }
      });
    }, { passive: true });
  }

  // live numbers: count up from zero
  const count = (el, to) => {
    if (reduce || !to) { el.textContent = Number(to || 0).toLocaleString('en-US'); return; }
    const t0 = performance.now(), dur = 1400;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  fetch('/api/public').then((r) => r.json()).then((d) => {
    $$('[data-count]').forEach((el) => count(el, d[el.dataset.count]));
    $('#live-line').textContent = d.online ? `online in ${d.servers} server${d.servers === 1 ? '' : 's'}` : 'starting';
    if (d.invite) $$('.invite-link').forEach((a) => { a.href = d.invite; a.hidden = false; a.target = '_blank'; a.rel = 'noopener'; });
    if (!d.login) $$('#hero-login').forEach((a) => { a.href = '/app'; });
  }).catch(() => {});

  // the card switcher: kind x theme, crossfading
  const names = { 'daily-pnl': 'daily-pnl-sample', weekly: 'weekly-sample', monthly: 'monthly-sample', trades: 'trades-sample' };
  const light = { 'daily-pnl': 'daily-pnl-sample', weekly: 'weekly-pnl-sample-green', monthly: 'monthly-pnl-sample', trades: 'trades-sample' };
  let kind = 'daily-pnl', dark = true;
  const img = $('#card-img');
  const show = () => {
    const src = `/samples/${dark ? `dark-${names[kind]}` : light[kind]}.png`;
    img.classList.add('swap');
    const pre = new Image(); pre.onload = () => { img.src = src; requestAnimationFrame(() => img.classList.remove('swap')); }; pre.src = src;
  };
  $$('#card-tabs button').forEach((b) => b.addEventListener('click', () => { $$('#card-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); kind = b.dataset.card; show(); }));
  $$('#theme-tabs button').forEach((b) => b.addEventListener('click', () => { $$('#theme-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); dark = !!b.dataset.theme; show(); }));
})();
