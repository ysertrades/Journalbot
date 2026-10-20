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

  // ── motion: one loop eases the scroll, its speed and the pointer, and every scene reads from it ──
  // Nothing jumps to where the wheel or the finger put it: each value glides toward its target, frame
  // by frame, and the loop sleeps once everything has settled. Scenes are CSS: they only read the vars.
  //   --x  the hero leaving (0 → 1): the board tilts toward you and its cards lift apart, the copy drifts up
  //   --e  each [data-s] element entering (0 → 1), with its own offset for a stagger
  //   --v  scroll speed, which leans the marquee; --mo slides it along with the page
  const plane = $('#plane'), mock = $('#mock'), hero = $('.hero'), copy = $('.hero-copy'), marquee = $('.marquee'), track = $('.track');
  const scenes = $$('[data-s]');
  if (reduce) scenes.forEach((el) => el.style.setProperty('--e', '1'));
  else {
    const fine = matchMedia('(hover: hover)').matches;
    const m = { y: scrollY, ly: scrollY, v: 0, px: 0, py: 0, tx: 0, ty: 0, x: -1 };
    let tops = [], heroH = 1, half = 1, vh = innerHeight, raf = 0, last = 0;
    const measure = () => {
      vh = innerHeight; heroH = Math.max(1, hero ? hero.offsetHeight : 1); half = Math.max(1, (track?.scrollWidth || 2) / 2);
      // from the layout (offsetTop), never the painted box: a scene's own motion must not move where it starts
      tops = scenes.map((el) => { let y = 0; for (let n = el; n; n = n.offsetParent) y += n.offsetTop; return y; });
    };
    const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
    const put = (el, k, v) => { if (el && el['_' + k] !== v) { el['_' + k] = v; el.style.setProperty(k, v); } };
    const frame = (t) => {
      const dt = Math.min(64, last ? t - last : 16.7); last = t;
      const ease = (r) => 1 - Math.pow(1 - r, dt / 16.7);                // the same glide at 60 Hz and at 120 Hz
      const target = scrollY;
      m.y += (target - m.y) * ease(0.14);
      m.v += ((target - m.ly) / (dt / 16.7) - m.v) * ease(0.1); m.ly = target;
      m.px += (m.tx - m.px) * ease(0.08); m.py += (m.ty - m.py) * ease(0.08);

      const x = clamp(m.y / (heroH * 0.85));
      if (Math.abs(x - m.x) > 0.0004 || fine) {
        m.x = x;
        put(plane, '--rx', `${(52 - x * 20 - m.py * 10).toFixed(2)}deg`);
        put(plane, '--rz', `${(-24 + x * 30 + m.px * 12).toFixed(2)}deg`);
        put(plane, '--lift', `${(-x * 60).toFixed(1)}px`);
        put(plane, '--sp', x.toFixed(3));
        put(copy, '--x', x.toFixed(3));
      }
      scenes.forEach((el, i) => {
        const raw = (vh - (tops[i] - m.y)) / (vh * 0.6) - (+el.dataset.s || 0);
        put(el, '--e', clamp(raw).toFixed(3));
      });
      if (mock && fine) { put(mock, '--my', `${(m.px * 7).toFixed(2)}deg`); put(mock, '--mx', `${(6 - m.py * 6).toFixed(2)}deg`); }
      put(marquee, '--v', Math.max(-14, Math.min(14, m.v * 0.35)).toFixed(2));
      put(track, '--mo', `${(-(m.y * 0.45) % half).toFixed(1)}px`);

      const settled = Math.abs(target - m.y) < 0.3 && Math.abs(m.v) < 0.02 && Math.abs(m.tx - m.px) < 0.001 && Math.abs(m.ty - m.py) < 0.001;
      raf = settled ? 0 : requestAnimationFrame(frame);
      if (settled) last = 0;
    };
    const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
    addEventListener('scroll', wake, { passive: true });
    addEventListener('resize', () => { measure(); wake(); });
    if (fine) addEventListener('pointermove', (e) => { m.tx = e.clientX / innerWidth - 0.5; m.ty = e.clientY / innerHeight - 0.5; wake(); }, { passive: true });
    addEventListener('load', () => { measure(); wake(); });
    document.fonts?.ready.then(() => { measure(); wake(); });
    measure(); wake();
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
