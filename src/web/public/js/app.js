'use strict';
/* The web journal and control panel. One page, hash routes, no framework. */
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = Charts.esc;
  const embedded = window.top !== window;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const S = { me: null, gid: store.get('jb_gid'), guild: null, csrf: null, token: (() => { try { return sessionStorage.getItem('jb_token'); } catch { return null; } })(), currency: '$', range: store.get('jb_range') || 'week' };
  const OUT = { win: { label: 'Win', c: 'var(--win)', a: 'var(--win-a)', e: '🟢' }, loss: { label: 'Loss', c: 'var(--loss)', a: 'var(--loss-a)', e: '🔴' }, be: { label: 'Breakeven', c: 'var(--be)', a: 'var(--be-a)', e: '🟡' }, missed: { label: 'Missed', c: 'var(--missed)', a: 'rgba(148,163,184,.12)', e: '🔵' } };
  const RANGES = [['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['d30', '30D'], ['d90', '90D'], ['year', 'Year'], ['all', 'All']];
  const RANGE_WORD = { day: 'Today', week: 'This week', month: 'This month', d30: 'Last 30 days', d90: 'Last 90 days', year: 'This year', all: 'All time' };

  /* ---------- helpers ---------- */
  const money = (v, sign = true) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    // cents only under a thousand, like the cards: +$12,120 reads faster than +$12,120.37
    const a = Math.abs(v), cents = a < 1000 && a % 1, s = a.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return v > 0 ? `${sign ? '+' : ''}${S.currency}${s}` : v < 0 ? `−${S.currency}${s}` : `${S.currency}0`;
  };
  const tone = (v) => (v > 0 ? 'win' : v < 0 ? 'loss' : 'be');
  /** a calendar day on a phone: +797, −1.2k, +12k (no symbol, no cents) */
  const short = (v) => { const a = Math.abs(v), s = a >= 10000 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(a)}`; return v > 0 ? `+${s}` : v < 0 ? `−${s}` : '0'; };
  const day = (iso, f = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', f);
  const turn = (v, n) => (!n ? 'nothing logged.' : v > 0 ? 'in the green.' : v < 0 ? 'in the red.' : 'dead flat.');
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json' };
    if (S.token) headers.authorization = `Bearer ${S.token}`;
    if (method !== 'GET') { headers['x-csrf'] = S.csrf || ''; headers['content-type'] = 'application/json'; }
    const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (res.status === 401) { showGate(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data?.detail || data?.error || `Request failed (${res.status})`);
    return data;
  }
  const g = (p) => `/api/g/${S.gid}/${p}`;
  async function blobUrl(path) {   // card images need the session header inside an embed
    const res = await fetch(path, { headers: S.token ? { authorization: `Bearer ${S.token}` } : {}, credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not draw that card');
    return URL.createObjectURL(await res.blob());
  }
  function toast(text, kind = 'ok', ms = 4200) {
    const t = document.createElement('div'); t.className = `toast ${kind}`;
    t.innerHTML = `<span class="ti">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i'}</span><span>${text}</span>`;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }
  const busy = (btn, on) => { if (btn) btn.classList.toggle('busy', on); };
  const countUp = (node, to, fmt) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || typeof to !== 'number') { node.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); node.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); else node.textContent = fmt(to); };
    requestAnimationFrame(step);
  };
  const readFile = (file, as = 'dataURL') => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; as === 'text' ? r.readAsText(file) : r.readAsDataURL(file); });

  /* ---------- sign in ---------- */
  function showGate(text) {
    $('#splash')?.classList.add('done'); setTimeout(() => $('#splash')?.classList.add('gone'), 800);
    $('#shell').hidden = true; $('#gate').hidden = false; document.body.classList.remove('booting');
    if (text) $('#gate-text').textContent = text;
    if (embedded) $('#gate-home').hidden = true;
  }
  $('#gate-login').addEventListener('click', () => {
    if (!embedded) { location.href = `/auth/login?next=${encodeURIComponent(`/app${location.hash}`)}`; return; }
    // inside Whop (or any iframe): Discord can't be framed, so sign in through a small window
    const h = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/[^\w-]/g, '').slice(0, 40);
    const w = window.open(`/auth/login?popup=1&h=${h}`, 'jb-login', 'width=520,height=760');
    if (!w) { toast('Allow pop-ups to sign in.', 'err'); return; }
    let tries = 0;
    const poll = setInterval(async () => {   // the fallback when the popup can't post back
      if (++tries > 90) return clearInterval(poll);
      try { const r = await fetch(`/auth/handoff?h=${h}`); if (r.ok) { const d = await r.json(); clearInterval(poll); adopt(d.token); } } catch { /* keep polling */ }
    }, 1500);
    addEventListener('message', function onMsg(e) {
      if (e.origin !== location.origin || e.data?.type !== 'jb-auth' || !e.data.token) return;
      removeEventListener('message', onMsg); clearInterval(poll); adopt(e.data.token);
    });
  });
  function adopt(token) { S.token = token; try { sessionStorage.setItem('jb_token', token); } catch { /* memory only */ } boot(); }
  $('#logout').addEventListener('click', async () => {
    try { sessionStorage.removeItem('jb_token'); } catch { /* */ }
    S.token = null; await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}); showGate('Signed out. See you after the close.');
  });

  /* ---------- boot and the server switcher ---------- */
  async function boot() {
    let me;
    try { me = await api('/api/me'); } catch { return showGate('The journal is starting up. Try again in a moment.'); }
    if (!me.signedIn) return showGate(me.login ? null : 'Login is not set up on this host yet. Add the Discord variables and restart the bot.');
    S.me = me; S.csrf = me.csrf;
    if (!me.guilds.length) return showGate('None of your servers have the journal bot yet, or the journal there is limited to other people. Add the bot, then sign in again.');
    if (!me.guilds.some((x) => x.id === S.gid)) S.gid = me.guilds[0].id;
    $('#splash-t').textContent = `Opening ${S.me.guilds.find((x) => x.id === S.gid)?.name || 'your journal'}`;
    $('#gate').hidden = true; $('#shell').hidden = false;
    $('#me-name').textContent = me.user.name; if (me.user.avatar) $('#me-av').src = me.user.avatar;
    pickGuild(S.gid, false);
    document.body.classList.remove('booting');
    $('#shell').classList.add('intro');
    [...$('#nav').children, ...$('.side-foot').children].forEach((c, i) => c.style.setProperty('--i', i));
    await route();
    landSplash();
  }
  /** the splash's mark flies to the sidebar's logo and becomes it; on a phone it simply fades */
  function landSplash() {
    const sp = $('#splash'); if (!sp || sp.classList.contains('gone')) return;
    const mark = $('#splash-mark'), target = $('.side .brand img'), to = target.getBoundingClientRect(), from = mark.getBoundingClientRect();
    sp.classList.add('fly');
    if (to.width && innerWidth > 900 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const s = to.width / (mark.offsetWidth || 64);   // its real size, not mid pop-in
      mark.style.borderRadius = '30%';
      mark.style.transform = `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${s})`;
      setTimeout(() => { $('#shell').classList.add('landed'); sp.classList.add('done'); }, 760);
    } else { sp.classList.add('done'); $('#shell').classList.add('landed'); }
    setTimeout(() => { sp.classList.add('gone'); $('#shell').classList.remove('intro'); }, 1500);
  }
  function pickGuild(id, rerender = true) {
    S.gid = id; S.guild = S.me.guilds.find((x) => x.id === id); store.set('jb_gid', id);
    $('#server-name').textContent = S.guild.name;
    const ic = $('#server-ic'); ic.style.backgroundImage = S.guild.icon ? `url("${S.guild.icon}")` : ''; ic.textContent = S.guild.icon ? '' : S.guild.name.slice(0, 1).toUpperCase();
    document.body.classList.toggle('can-manage', !!S.guild.manage);
    if (rerender) route();
  }
  $('#server-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#server-menu'); m.hidden = !m.hidden;
    m.innerHTML = S.me.guilds.map((x) => `<button data-id="${x.id}" class="${x.id === S.gid ? 'on' : ''}"><span class="ic" style="${x.icon ? `background-image:url('${esc(x.icon)}')` : ''}"></span>${esc(x.name)}</button>`).join('');
  });
  $('#server-menu').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { $('#server-menu').hidden = true; pickGuild(b.dataset.id); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('#server-menu, #server-btn')) $('#server-menu').hidden = true; });
  $('#burger').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#nav-scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));

  /* ---------- router ---------- */
  const PAGES = {
    overview: { k: 'Journal', t: 'Overview', run: overview }, calendar: { k: 'Journal', t: 'Calendar', run: calendar }, trades: { k: 'Journal', t: 'Trades', run: trades },
    insights: { k: 'Journal', t: 'Insights', run: insights }, log: { k: 'Add', t: 'Log a trade', run: logTrade }, import: { k: 'Add', t: 'Import CSV', run: importCsv },
    cards: { k: 'Add', t: 'Cards', run: cards }, settings: { k: 'Bot', t: 'Control panel', run: settings },
  };
  let routeSeq = 0;
  async function route() {
    if (!S.me) return;
    const [name, qs] = (location.hash.replace(/^#\/?/, '') || 'overview').split('?');
    const page = PAGES[name] || PAGES.overview, key = PAGES[name] ? name : 'overview';
    if (key === 'settings' && !S.guild.manage) { location.hash = '#/overview'; return; }
    const seq = ++routeSeq, view = $('#view');
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === key));
    document.body.classList.remove('nav-open');
    if ($('#drawer').classList.contains('on')) closeDrawer();
    // the old page fades up and out; the page keeps its height so nothing below it jumps
    view.style.minHeight = `${view.offsetHeight}px`;
    view.classList.remove('entering'); view.classList.add('leaving');
    if (scrollY > 0) scrollTo({ top: 0, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 180));
    if (seq !== routeSeq) return;
    $('#page-kicker').textContent = `${page.k} · ${S.guild.name}`; $('#page-title').innerHTML = esc(page.t); $('#top-tools').innerHTML = '';
    // a skeleton only when the data is slow, so a quick page never flashes one
    const sk = setTimeout(() => {
      if (seq !== routeSeq || view.dataset.ready === String(seq)) return;
      view.innerHTML = '<div class="grid g-main"><div class="sk" style="height:320px"></div><div class="sk" style="height:320px"></div></div><div class="kpis">' + '<div class="sk" style="height:86px"></div>'.repeat(6) + '</div>';
      view.classList.remove('leaving');
    }, 260);
    try { await page.run(view, new URLSearchParams(qs || ''), seq); }
    catch (e) { if (seq === routeSeq) view.innerHTML = `<div class="card empty"><span class="em">Something went sideways</span><span>${esc(e.message)}</span><button class="btn" id="retry">Try again</button></div>`; $('#retry')?.addEventListener('click', route); }
    clearTimeout(sk);
    if (seq !== routeSeq) return;
    view.dataset.ready = String(seq);
    enter(view);
  }
  /** the new page rises in piece by piece, then lets go of the held height */
  function enter(view) {
    [...view.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 8)));
    view.classList.remove('leaving', 'entering'); void view.offsetWidth; view.classList.add('entering');
    setTimeout(() => { view.classList.remove('entering'); view.style.minHeight = ''; }, 1100);
  }
  addEventListener('hashchange', route);
  const rangeSeg = (current, onPick, list = RANGES) => {
    const s = document.createElement('div'); s.className = 'seg';
    s.innerHTML = list.map(([k, l]) => `<button data-r="${k}" class="${k === current ? 'on' : ''}">${l}</button>`).join('');
    s.addEventListener('click', (e) => { const b = e.target.closest('button[data-r]'); if (!b) return; $$('button', s).forEach((x) => x.classList.toggle('on', x === b)); onPick(b.dataset.r); });
    return s;
  };

  /* ---------- overview ---------- */
  async function overview(view, qs, seq) {
    const tools = $('#top-tools');
    tools.appendChild(rangeSeg(S.range, (r) => { S.range = r; store.set('jb_range', r); route(); }));
    const d = await api(g(`overview?range=${S.range}`)); if (seq !== routeSeq) return;
    S.currency = d.currency || '$';
    const st = d.stats, word = RANGE_WORD[S.range];
    $('#page-title').innerHTML = `${esc(word)}, <em>${turn(st.net, st.count)}</em>`;
    const pf = st.profitFactor === 'inf' ? '∞' : st.profitFactor ?? '—';
    view.innerHTML = `
      <div class="grid g-main">
        <section class="card tabbed" style="--tab:var(--${st.count ? tone(st.net) : 'grey'})">
          <div class="card-h"><span class="kicker">${esc(day(d.start, { month: 'short', day: 'numeric' }))} – ${esc(day(d.end, { month: 'short', day: 'numeric', year: 'numeric' }))}</span><a class="btn sm" href="#/cards">Make a card</a></div>
          <div class="hero-num"><span class="big ${st.count ? tone(st.net) : 'muted'}" id="ov-net">${money(st.net ?? 0)}</span>
            <span class="sub">${st.count} trade${st.count === 1 ? '' : 's'}${st.winRate !== null ? ` · ${st.winRate}% win rate` : ''}${st.rSum !== null ? ` · ${st.rSum > 0 ? '+' : ''}${st.rSum}R` : ''}${st.missed ? ` · ${st.missed} missed` : ''}</span></div>
          <div id="eq" style="margin-top:18px"></div>
        </section>
        <section class="card">
          <div class="card-h"><h3>Today</h3><span class="kicker">${esc(day(d.today))}</span></div>
          <div class="hero-num"><span class="big ${d.todayStats.count ? tone(d.todayStats.net) : 'muted'}" style="font-size:44px">${money(d.todayStats.net ?? 0)}</span>
            <span class="sub">${d.todayStats.count ? `${d.todayStats.w}W · ${d.todayStats.l}L${d.todayStats.be ? ` · ${d.todayStats.be}BE` : ''}` : 'No trades yet today'}</span></div>
          <div style="margin:18px 0 10px" class="card-h"><h3>${esc(d.calendar.label.charAt(0) + d.calendar.label.slice(1).toLowerCase())}</h3><a class="kicker" href="#/calendar" style="text-decoration:none">Open calendar →</a></div>
          ${miniCal(d.calendar, d.today)}
          <a class="btn white" href="#/log" style="margin-top:16px;width:100%">Log a trade</a>
        </section>
      </div>
      <div class="kpis">
        ${kpi('Win rate', st.winRate !== null ? `${st.winRate}%` : '—', `${st.w}W · ${st.l}L${st.be ? ` · ${st.be}BE` : ''}`)}
        ${kpi('Profit factor', pf, st.grossLoss ? `${money(st.grossWin, false)} won / ${money(Math.abs(st.grossLoss), false)} lost` : 'no losses yet', st.profitFactor === 'inf' || st.profitFactor >= 1 ? 'win' : st.profitFactor !== null ? 'loss' : '')}
        ${kpi('Expectancy', money(st.expectancy), 'per trade', tone(st.expectancy || 0))}
        ${kpi('Avg win · loss', `${money(st.avgWin)}`, `avg loss ${money(st.avgLoss)}`, 'win')}
        ${kpi('Max drawdown', money(st.maxDrawdown || 0), 'from the high', st.maxDrawdown ? 'loss' : '')}
        ${kpi('Best streak', `${st.streak} win${st.streak === 1 ? '' : 's'}`, st.current.n ? `now ${st.current.n} ${st.current.kind === 'w' ? 'win' : st.current.kind === 'l' ? 'loss' : 'BE'}${st.current.n === 1 ? '' : st.current.kind === 'l' ? 'es' : 's'} in a row` : '')}
      </div>
      <div class="grid g2">
        <section class="card"><div class="card-h"><h3>Latest trades</h3><a class="kicker" href="#/trades" style="text-decoration:none">All trades →</a></div><div class="list" id="recent">${d.recent.length ? d.recent.map(tradeLi).join('') : '<div class="empty"><span class="em">Quiet so far</span><span>Log one, or drop a CSV.</span></div>'}</div></section>
        <section class="card"><div class="card-h"><h3>Worth a look</h3></div><div class="list">
          ${d.insights.completeness.charts ? `<a class="li" href="#/trades?lens=nochart&range=${S.range}" style="text-decoration:none"><span>📷</span><span><div class="t1">${d.insights.completeness.charts} trade${d.insights.completeness.charts === 1 ? '' : 's'} without a chart</div><div class="t2">add them while you remember the setup</div></span><span class="muted">→</span></a>` : ''}
          ${d.insights.completeness.notes ? `<a class="li" href="#/trades?lens=nonotes&range=${S.range}" style="text-decoration:none"><span>✍️</span><span><div class="t1">${d.insights.completeness.notes} without notes</div><div class="t2">why you took it, what you'd change</div></span><span class="muted">→</span></a>` : ''}
          ${st.bestDay ? `<div class="li" data-day="${st.bestDay.date}"><span class="win">▲</span><span><div class="t1">Best day ${money(st.bestDay.pnl)}</div><div class="t2">${esc(day(st.bestDay.date))} · ${st.bestDay.n} trade${st.bestDay.n === 1 ? '' : 's'}</div></span><span class="muted">→</span></div>` : ''}
          ${st.worstDay && st.worstDay.pnl < 0 ? `<div class="li" data-day="${st.worstDay.date}"><span class="loss">▼</span><span><div class="t1">Worst day ${money(st.worstDay.pnl)}</div><div class="t2">${esc(day(st.worstDay.date))}</div></span><span class="muted">→</span></div>` : ''}
          <div class="li" style="cursor:default"><span>⚖️</span><span><div class="t1">Long ${money(st.longs.pnl)} · Short ${money(st.shorts.pnl)}</div><div class="t2">${st.longs.n} long · ${st.shorts.n} short</div></span><span></span></div>
          <div class="li" style="cursor:default"><span>📅</span><span><div class="t1">${st.greenDays} green · ${st.redDays} red day${st.redDays === 1 ? '' : 's'}</div><div class="t2">${st.tradingDays} trading day${st.tradingDays === 1 ? '' : 's'}</div></span><span></span></div>
        </div></section>
      </div>
      <div class="grid g2">
        <section class="card"><div class="card-h"><h3>By symbol</h3><a class="kicker" href="#/insights" style="text-decoration:none">Insights →</a></div><div id="by-sym"></div></section>
        <section class="card"><div class="card-h"><h3>By weekday</h3></div><div id="by-wd"></div></section>
      </div>`;
    countUp($('#ov-net'), st.net ?? 0, (v) => money(Math.round(v * 100) / 100));
    Charts.equity($('#eq'), st.equity.map((p) => ({ v: p.v, label: day(p.date) })), { money: (v) => money(v), height: 210 });
    Charts.bars($('#by-sym'), d.insights.bySymbol.slice(0, 6), { money: (v) => money(v) });
    Charts.bars($('#by-wd'), d.insights.byWeekday, { money: (v) => money(v) });
    wireTrades(view, d.recent);
    $$('[data-day]', view).forEach((n) => n.addEventListener('click', () => openDay(n.dataset.day)));
  }
  const kpi = (k, v, s, t = '') => `<div class="kpi"><span class="kicker">${esc(k)}</span><span class="v ${t}">${esc(String(v))}</span><span class="s">${esc(s || '')}</span></div>`;
  function miniCal(cal, today) {
    const first = new Date(cal.year, cal.month - 1, 1), lead = (first.getDay() + 6) % 7, dim = new Date(cal.year, cal.month, 0).getDate();
    const max = Math.max(1, ...Object.values(cal.days).map((x) => Math.abs(x.pnl)));
    let cells = '<b class="x"></b>'.repeat(lead);
    for (let i = 1; i <= dim; i++) {
      const x = cal.days[i], iso = `${cal.year}-${String(cal.month).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      const c = x && x.trades ? (x.pnl > 0 ? 'g' : x.pnl < 0 ? 'r' : 'y') : '';
      cells += `<b class="${c}${iso === today ? ' t' : ''}" style="--a:${x && x.trades ? (0.25 + 0.6 * Math.abs(x.pnl) / max).toFixed(2) : 0}" title="${iso}${x && x.trades ? ` · ${money(x.pnl)}` : ''}">${i}</b>`;
    }
    return `<div class="mini-cal">${cells}</div>`;
  }
  const tradeLi = (t) => `<div class="li" data-key="${esc(t.key)}"><span class="stripe" style="background:${OUT[t.outcome].c}"></span><span><div class="t1">${esc(t.instrument || 'Trade')} ${esc(t.direction || '')}${t.setup ? ` <span class="muted" style="font-weight:500">· ${esc(t.setup)}</span>` : ''}</div><div class="t2">${esc(day(t.date))}${t.time ? ` · ${t.time}` : ''}${t.r !== null ? ` · ${t.r > 0 ? '+' : ''}${t.r}R` : ''}</div></span><span class="money ${t.outcome === 'missed' ? 'missed' : tone(t.pnl)}">${t.outcome === 'missed' ? 'Missed' : money(t.pnl)}</span></div>`;
  function wireTrades(root, list) {
    const by = new Map(list.map((t) => [t.key, t]));
    $$('[data-key]', root).forEach((n) => n.addEventListener('click', () => { const t = by.get(n.dataset.key); if (t) openTrade(t); }));
  }

  /* ---------- calendar ---------- */
  async function calendar(view, qs, seq) {
    const month = qs.get('m') || '';
    const d = await api(g(`calendar${month ? `?month=${month}` : ''}`)); if (seq !== routeSeq) return;
    S.currency = d.currency || '$';
    const [y, mo] = d.month.split('-').map(Number);
    const prev = new Date(y, mo - 2, 1), next = new Date(y, mo, 1), fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    $('#page-title').innerHTML = `${esc(new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))}, <em>${turn(d.total, d.tradedDays)}</em>`;
    $('#top-tools').innerHTML = `<a class="btn icon" href="#/calendar?m=${fmt(prev)}" aria-label="Previous month">‹</a><a class="btn sm" href="#/calendar">This month</a><a class="btn icon" href="#/calendar?m=${fmt(next)}" aria-label="Next month">›</a>`;
    const by = {}; for (const t of d.trades) (by[t.date] ||= []).push(t);
    const first = new Date(y, mo - 1, 1), lead = (first.getDay() + 6) % 7, dim = new Date(y, mo, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let i = 1; i <= dim; i++) cells.push(i);
    while (cells.length % 7) cells.push(null);
    let html = '', wk = 0;
    for (let r = 0; r < cells.length; r += 7) {
      let wp = 0, wn = 0;
      for (const c of cells.slice(r, r + 7)) {
        if (!c) { html += '<div class="day out"></div>'; continue; }
        const iso = `${d.month}-${String(c).padStart(2, '0')}`, x = d.days[c], has = x && (x.trades || x.missed);
        if (x && x.trades) { wp += x.pnl; wn += 1; }
        const tn = x && x.trades ? tone(x.pnl) : 'missed';
        html += `<div class="day${has ? ' has' : ''}${iso === d.today ? ' today' : ''}" ${has ? `data-day="${iso}" style="--tab:var(--${tn})"` : ''}><span class="dn">${c}</span>${has ? `<span><div class="dv ${x.trades ? tone(x.pnl) : 'missed'}">${x.trades ? money(x.pnl) : 'missed'}</div><div class="ds ${x.trades ? tone(x.pnl) : 'missed'}">${x.trades ? short(x.pnl) : '·'}</div><div class="dc">${x.trades ? `${x.trades} trade${x.trades === 1 ? '' : 's'}` : ''}${x.missed ? ` · ${x.missed}M` : ''}</div></span>` : ''}</div>`;
      }
      wk += 1;
      html += `<div class="wk"><span class="k">WEEK ${wk}</span><span class="v ${wn ? tone(wp) : 'muted'}">${wn ? money(Math.round(wp * 100) / 100) : '—'}</span><span class="k">${wn} day${wn === 1 ? '' : 's'}</span></div>`;
    }
    const st = d.stats;
    view.innerHTML = `
      <div class="kpis">${kpi('Month', money(d.total), `${d.tradedDays} trading days`, tone(d.total))}${kpi('Green days', `${d.green}`, `${d.red} red`, 'win')}${kpi('Win rate', st.winRate !== null ? `${st.winRate}%` : '—', `${st.count} trades`)}${kpi('Best day', st.bestDay ? money(st.bestDay.pnl) : '—', st.bestDay ? day(st.bestDay.date) : '', 'win')}${kpi('Worst day', st.worstDay ? money(st.worstDay.pnl) : '—', st.worstDay ? day(st.worstDay.date) : '', st.worstDay && st.worstDay.pnl < 0 ? 'loss' : '')}${kpi('Avg per day', d.tradedDays ? money(Math.round((d.total / d.tradedDays) * 100) / 100) : '—', 'trading days only')}</div>
      <section class="card"><div class="cal">${['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((x) => `<span class="dh">${x}</span>`).join('')}<span class="dh wkh">WEEK</span>${html}</div></section>`;
    S.dayCache = by;
    $$('[data-day]', view).forEach((n) => n.addEventListener('click', () => openDay(n.dataset.day, by[n.dataset.day])));
  }
  async function openDay(iso, list) {
    if (!list) { const d = await api(g(`trades?range=custom&from=${iso}&to=${iso}`)); list = d.trades.slice().reverse(); }
    const net = list.filter((t) => t.outcome !== 'missed').reduce((s, t) => s + t.pnl, 0);
    drawer(`<div class="drawer-h"><div><span class="kicker">${esc(day(iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</span><h2 class="${tone(net)}">${money(Math.round(net * 100) / 100)}</h2></div><button class="btn icon ghost" data-close>✕</button></div>
      <div class="list" id="day-list">${list.map(tradeLi).join('') || '<div class="empty">No trades.</div>'}</div>
      <div class="filters"><button class="btn white" id="day-card">See the day card</button><a class="btn" href="#/trades?range=custom&from=${iso}&to=${iso}">In the ledger</a></div><div id="day-img"></div>`);
    wireTrades($('#drawer-in'), list);
    $('#day-card').addEventListener('click', async (e) => {
      busy(e.target, true);
      try { const u = await blobUrl(g(`card/day?date=${iso}`)); $('#day-img').innerHTML = `<img class="chart-img" src="${u}" alt="Day card"><a class="btn sm" download="day-${iso}.png" href="${u}" style="margin-top:10px">Download</a>`; } catch (er) { toast(er.message, 'err'); }
      busy(e.target, false);
    });
  }

  /* ---------- trades ---------- */
  async function trades(view, qs, seq) {
    const st = { range: qs.get('range') || 'month', from: qs.get('from') || '', to: qs.get('to') || '', outcome: qs.get('outcome') || '', symbol: qs.get('symbol') || '', lens: qs.get('lens') || '', q: qs.get('q') || '', page: 0 };
    view.innerHTML = `<section class="card"><div class="filters" id="tf">
        <select class="select" id="f-range">${RANGES.map(([k, l]) => `<option value="${k}" ${k === st.range ? 'selected' : ''}>${RANGE_WORD[k]}</option>`).join('')}${st.range === 'custom' ? `<option value="custom" selected>${esc(st.from)} → ${esc(st.to)}</option>` : ''}</select>
        <select class="select" id="f-out"><option value="">All outcomes</option>${Object.entries(OUT).map(([k, o]) => `<option value="${k}" ${k === st.outcome ? 'selected' : ''}>${o.e} ${o.label}</option>`).join('')}</select>
        <select class="select" id="f-sym"><option value="">All symbols</option></select>
        <select class="select" id="f-lens"><option value="">Newest first</option><option value="big" ${st.lens === 'big' ? 'selected' : ''}>Biggest first</option><option value="nochart" ${st.lens === 'nochart' ? 'selected' : ''}>Missing a chart</option><option value="nonotes" ${st.lens === 'nonotes' ? 'selected' : ''}>Missing notes</option></select>
        <input class="input search" id="f-q" placeholder="Search: NQ short, orb, 1240, friday…" value="${esc(st.q)}">
      </div></section><section class="card" id="tbl-card"><div class="sk" style="height:300px"></div></section>`;
    const load = async () => {
      const p = new URLSearchParams({ range: st.range, page: st.page }); for (const k of ['from', 'to', 'outcome', 'symbol', 'lens', 'q']) if (st[k]) p.set(k, st[k]);
      const d = await api(g(`trades?${p}`)); if (seq !== routeSeq) return;
      S.currency = d.currency || '$';
      const symSel = $('#f-sym'); symSel.innerHTML = `<option value="">All symbols</option>${d.symbols.map((s) => `<option ${s === st.symbol ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
      const x = d.stats;
      $('#page-title').innerHTML = `${d.total} trade${d.total === 1 ? '' : 's'}, <em>${x.count ? money(x.net) : 'none yet'}</em>`;
      $('#tbl-card').innerHTML = !d.trades.length ? '<div class="empty"><span class="em">Nothing matches</span><span>Loosen a filter or search for something else.</span></div>' : `
        <div class="card-h"><span class="kicker">${x.winRate !== null ? `${x.winRate}% win rate · ` : ''}PF ${x.profitFactor === 'inf' ? '∞' : x.profitFactor ?? '—'} · expectancy ${money(x.expectancy)}</span><span class="kicker">page ${d.page + 1} of ${d.pages}</span></div>
        <div class="tcards">${d.trades.map((t) => `<div class="tc" data-key="${esc(t.key)}" style="--tab:${OUT[t.outcome].c}">
          <span class="a">${esc(t.instrument || '—')}${t.direction ? `<span class="side-tag ${/^l/i.test(t.direction) ? 'win' : 'loss'}">${esc(t.direction)}</span>` : ''}</span>
          <span class="m ${t.outcome === 'missed' ? 'missed' : tone(t.pnl)}">${t.outcome === 'missed' ? 'Missed' : money(t.pnl)}</span>
          <span class="b">${esc(day(t.date))}${t.time ? ` · ${t.time}` : ''}</span><span class="c">${t.r !== null ? `${t.r > 0 ? '+' : ''}${t.r}R` : ''}${t.hasChart ? ' 📷' : ''}${t.hasNotes ? ' ✍️' : ''}</span>
          ${t.qty || t.entry || t.held ? `<span class="chips">${t.qty ? `<span>${t.qty}×</span>` : ''}${t.entry ? `<span>${esc(t.entry)}${t.exit ? ` → ${esc(t.exit)}` : ''}</span>` : ''}${t.held ? `<span>⏱ ${esc(t.held)}</span>` : ''}</span>` : ''}
        </div>`).join('')}</div>
        <div class="tbl-wrap ledger"><table class="tbl"><thead><tr><th>Date</th><th>Symbol</th><th>Size</th><th>Entry → exit</th><th>Held</th><th>R</th><th>Notes</th><th class="r">PnL</th></tr></thead><tbody>
        ${d.trades.map((t) => `<tr class="row" data-key="${esc(t.key)}"><td><span class="stripe" style="background:${OUT[t.outcome].c}"></span>${esc(day(t.date))}<span class="muted mono"> ${t.time || ''}</span></td>
          <td class="sym">${esc(t.instrument || '—')}${t.direction ? `<span class="side-tag ${/^l/i.test(t.direction) ? 'win' : 'loss'}">${esc(t.direction)}</span>` : ''}</td><td class="mono">${t.qty ? `${t.qty}×` : '—'}</td>
          <td class="mono">${t.entry ? `${esc(t.entry)}${t.exit ? ` → ${esc(t.exit)}` : ''}` : '—'}</td><td class="mono">${esc(t.held || '—')}</td><td class="mono ${t.r > 0 ? 'win' : t.r < 0 ? 'loss' : ''}">${t.r !== null ? `${t.r > 0 ? '+' : ''}${t.r}R` : '—'}</td>
          <td><span class="flags"><i class="${t.hasChart ? 'on' : ''}" title="chart">📷</i><i class="${t.hasNotes ? 'on' : ''}" title="notes">✍️</i></span></td><td class="r money ${t.outcome === 'missed' ? 'missed' : tone(t.pnl)}">${t.outcome === 'missed' ? `Missed${t.potential ? ` <span class="muted">(${money(t.potential)})</span>` : ''}` : money(t.pnl)}</td></tr>`).join('')}
        </tbody></table></div>
        ${d.pages > 1 ? `<div class="filters" style="justify-content:center;margin-top:12px"><button class="btn sm" id="pg-prev" ${d.page ? '' : 'disabled'}>‹ Newer</button><button class="btn sm" id="pg-next" ${d.page < d.pages - 1 ? '' : 'disabled'}>Older ›</button></div>` : ''}`;
      wireTrades($('#tbl-card'), d.trades);
      $('#pg-prev')?.addEventListener('click', () => { st.page -= 1; load(); }); $('#pg-next')?.addEventListener('click', () => { st.page += 1; load(); });
    };
    const re = () => { st.page = 0; load(); };
    $('#f-range').addEventListener('change', (e) => { st.range = e.target.value; re(); });
    $('#f-out').addEventListener('change', (e) => { st.outcome = e.target.value; re(); });
    $('#f-sym').addEventListener('change', (e) => { st.symbol = e.target.value; re(); });
    $('#f-lens').addEventListener('change', (e) => { st.lens = e.target.value; re(); });
    let tmr; $('#f-q').addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { st.q = e.target.value.trim(); re(); }, 260); });
    await load();
  }

  /* ---------- one trade: read it, edit it ---------- */
  function openTrade(t) {
    const o = OUT[t.outcome];
    const ro = !t.editable;
    const v = (k) => esc(t[k] ?? '');
    drawer(`<div class="drawer-h"><div><span class="kicker">${o.e} ${o.label.toUpperCase()} · ${esc(day(t.date, { weekday: 'long', month: 'short', day: 'numeric' }))}${t.time ? ` · ${t.time}` : ''}</span>
        <h2>${esc(t.instrument || 'Trade')} <em>${esc((t.direction || '').toLowerCase())}</em></h2><span class="money ${t.outcome === 'missed' ? 'missed' : tone(t.pnl)}" style="font-size:30px">${t.outcome === 'missed' ? 'Missed' : money(t.pnl)}</span></div><button class="btn icon ghost" data-close>✕</button></div>
      <div class="pairs"><div><i>SIZE</i><b>${t.qty ? `${t.qty}×` : '—'}</b></div><div><i>HELD</i><b>${esc(t.held || '—')}</b></div><div><i>R</i><b>${t.r !== null ? `${t.r > 0 ? '+' : ''}${t.r}R` : '—'}</b></div></div>
      ${ro ? '<div class="note">Typed by hand in Discord, so it is edited there. Its PnL and date still count everywhere.</div>' : ''}
      <form class="form" id="tf-form" ${ro ? 'inert' : ''}>
        <div class="row2"><label class="field"><span>Instrument</span><input class="input" name="instrument" value="${v('instrument')}" maxlength="20"></label>
          <label class="field"><span>Direction</span><select class="select" name="direction"><option ${t.direction === 'Long' ? 'selected' : ''}>Long</option><option ${t.direction === 'Short' ? 'selected' : ''}>Short</option></select></label></div>
        <div class="row2"><label class="field"><span>Trading day</span><input class="input" name="date" type="date" value="${t.date}"></label>
          <label class="field"><span>Session</span><select class="select" name="session">${['', 'Asia', 'London', 'NY AM', 'NY PM', 'Other'].map((s) => `<option value="${s}" ${s === (t.session || '') ? 'selected' : ''}>${s || '—'}</option>`).join('')}</select></label></div>
        <label class="field"><span>Setup</span><input class="input" name="setup" value="${v('setup')}" maxlength="100" placeholder="HTF sweep → CISD"></label>
        ${t.outcome === 'missed' ? `<label class="field"><span>Potential PnL (not counted)</span><input class="input" name="potential" value="${t.potential ?? ''}"></label>`
          : `<div class="row2"><label class="field"><span>PnL</span><input class="input" name="pnl" value="${Math.abs(t.pnl)}" inputmode="decimal"></label><label class="field"><span>R multiple</span><input class="input" name="r" value="${t.r ?? ''}" inputmode="decimal"></label></div>`}
        <div class="row4"><label class="field"><span>Entry</span><input class="input" name="entry" value="${v('entry')}"></label><label class="field"><span>Stop</span><input class="input" name="stop" value="${v('stop')}"></label><label class="field"><span>Target</span><input class="input" name="target" value="${v('target')}"></label><label class="field"><span>Exit</span><input class="input" name="exit" value="${v('exit')}"></label></div>
        <label class="field"><span>${t.outcome === 'missed' ? 'Why I missed it' : 'Why I took it'}</span><textarea class="input" name="why" maxlength="400">${esc(t.notes.why || '')}</textarea></label>
        <div class="row2"><label class="field"><span>${t.outcome === 'loss' ? 'What went wrong' : t.outcome === 'win' ? 'What I did right' : 'Note'}</span><input class="input" name="p1" value="${esc(t.notes.p1 || '')}" maxlength="200"></label><label class="field"><span>And</span><input class="input" name="p2" value="${esc(t.notes.p2 || '')}" maxlength="200"></label></div>
        <label class="field"><span>${t.outcome === 'loss' || t.outcome === 'missed' ? 'Rule for next time' : 'Lesson'}</span><textarea class="input" name="lesson" maxlength="300">${esc(t.notes.lesson || '')}</textarea></label>
        <label class="field"><span>Followed the plan?</span><select class="select" name="followed"><option value="">—</option><option ${t.followed === 'YES' ? 'selected' : ''}>YES</option><option ${t.followed === 'NO' ? 'selected' : ''}>NO</option></select></label>
        <div class="field"><span>Chart</span><div class="drop" id="pic-drop"><span class="big">${t.hasChart ? 'Replace the chart' : 'Drop the chart here'}</span><span>png, jpg, webp or gif · up to 8 MB · or click to pick</span></div><input type="file" id="pic-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          ${t.hasChart ? '<label class="filters" style="gap:10px;margin-top:6px"><button type="button" class="switch" id="rm-pic" aria-pressed="false"></button><span class="soft">Remove the chart on save</span></label>' : ''}</div>
      </form>
      <div class="sticky-foot"><a class="btn ghost" href="${esc(t.link)}" target="_blank" rel="noopener">Open in Discord ↗</a>${ro ? '' : '<button class="btn white" id="tf-save">Save · rewrites the post</button>'}</div>`);
    if (ro) return;
    let image = null, removeChart = false;
    dropZone($('#pic-drop'), $('#pic-file'), async (file) => {
      if (file.size > 8 * 1024 * 1024) return toast('That picture is over 8 MB.', 'err');
      const url = await readFile(file); image = { name: file.name, type: file.type, data: url.split(',')[1] };
      $('#pic-drop').innerHTML = `<img src="${url}" alt="New chart"><span class="soft">${esc(file.name)} · replaces the chart on save</span>`;
    }, 'image/');
    $('#rm-pic')?.addEventListener('click', (e) => { removeChart = !removeChart; e.currentTarget.classList.toggle('on', removeChart); });
    $('#tf-save').addEventListener('click', async (e) => {
      const f = Object.fromEntries(new FormData($('#tf-form')));
      const body = { ...f, ...(image ? { image } : {}), ...(removeChart ? { removeChart: true } : {}) };
      busy(e.currentTarget, true);
      try {
        const r = await api(g(`trades/${t.id}`), { method: 'PATCH', body });
        toast(r.unchanged ? 'Nothing changed.' : `Saved: ${esc(r.changed.join(', '))}. The post is rewritten.`, r.unchanged ? 'info' : 'ok');
        if (!r.unchanged) { closeDrawer(); route(); }
      } catch (er) { toast(esc(er.message), 'err'); }
      busy(e.currentTarget, false);
    });
  }
  function dropZone(zone, input, onFile, kind) {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f && (!kind || f.type.startsWith(kind) || /\.(csv|txt|tsv)$/i.test(f.name))) onFile(f); });
  }

  /* ---------- drawer and palette ---------- */
  function drawer(html) {
    $('#drawer-in').innerHTML = html; $('#drawer').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false');
    [...$('#drawer-in').children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 8)));   // its parts rise in as it slides
    const sc = $('#scrim'); sc.hidden = false; requestAnimationFrame(() => sc.classList.add('on'));
    $$('[data-close]', $('#drawer')).forEach((b) => b.addEventListener('click', closeDrawer));
  }
  function closeDrawer() { $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); const sc = $('#scrim'); sc.classList.remove('on'); setTimeout(() => { sc.hidden = true; }, 350); }
  $('#scrim').addEventListener('click', closeDrawer);
  const PAL = [['Overview', '#/overview'], ['Calendar', '#/calendar'], ['Trades', '#/trades'], ['Insights', '#/insights'], ['Log a trade', '#/log'], ['Import CSV', '#/import'], ['Cards', '#/cards'], ['Control panel', '#/settings'],
    ['Trades missing a chart', '#/trades?lens=nochart&range=all'], ['Trades missing notes', '#/trades?lens=nonotes&range=all'], ['Biggest trades this month', '#/trades?lens=big&range=month']];
  function palette(open) {
    const p = $('#palette'); p.hidden = !open; if (!open) return;
    const input = $('#palette-input'); input.value = ''; input.focus(); let sel = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const items = PAL.filter(([l, h]) => (S.guild.manage || h !== '#/settings') && (!q || l.toLowerCase().includes(q)));
      if (q) items.push([`Search trades for “${input.value.trim()}”`, `#/trades?range=all&q=${encodeURIComponent(input.value.trim())}`]);
      sel = Math.min(sel, items.length - 1);
      $('#palette-list').innerHTML = items.map(([l, h], i) => `<button data-h="${esc(h)}" class="${i === sel ? 'on' : ''}">${esc(l)}<small>${h.startsWith('#/trades?range=all&q') ? 'search' : 'go'}</small></button>`).join('');
      return items;
    };
    let items = draw();
    input.oninput = () => { sel = 0; items = draw(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); items = draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); items = draw(); e.preventDefault(); }
      if (e.key === 'Enter' && items[sel]) { location.hash = items[sel][1]; palette(false); }
      if (e.key === 'Escape') palette(false);
    };
    $('#palette-list').onclick = (e) => { const b = e.target.closest('button[data-h]'); if (b) { location.hash = b.dataset.h; palette(false); } };
  }
  $('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') palette(false); });
  $('#palette-btn').addEventListener('click', () => palette(true));
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.me) { e.preventDefault(); palette($('#palette').hidden); }
    if (e.key === 'Escape') { closeDrawer(); palette(false); }
  });

  /* ---------- insights ---------- */
  async function insights(view, qs, seq) {
    const r = qs.get('range') || 'd90';
    $('#top-tools').appendChild(rangeSeg(r, (x) => { location.hash = `#/insights?range=${x}`; }, RANGES.filter(([k]) => k !== 'day')));
    const d = await api(g(`insights?range=${r}`)); if (seq !== routeSeq) return;
    S.currency = d.currency || '$';
    const i = d.insights, st = d.stats;
    $('#page-title').innerHTML = `Where the edge is, <em>${esc(RANGE_WORD[r].toLowerCase())}.</em>`;
    const card = (t, id, sub = '') => `<section class="card"><div class="card-h"><h3>${t}</h3><span class="kicker">${sub}</span></div><div id="${id}"></div></section>`;
    view.innerHTML = `
      <div class="kpis">${kpi('Net', money(st.net), `${st.count} trades`, tone(st.net))}${kpi('Win rate', st.winRate !== null ? `${st.winRate}%` : '—', `${st.w}W · ${st.l}L`)}${kpi('Avg R', st.avgR !== null ? `${st.avgR > 0 ? '+' : ''}${st.avgR}R` : '—', st.rSum !== null ? `${st.rSum}R total` : 'log R to see it')}${kpi('Held on wins', i.hold.win !== null ? `${i.hold.win}m` : '—', i.hold.n ? `on losses ${i.hold.loss ?? '—'}m` : 'from imports', '')}${kpi('Plan followed', i.discipline.tracked ? `${Math.round((100 * i.discipline.followed) / i.discipline.tracked)}%` : '—', i.discipline.tracked ? `${money(i.discipline.pnlFollowed)} when followed` : 'answer "followed plan?"', i.discipline.tracked ? 'win' : '')}${kpi('Broke the plan', i.discipline.tracked ? money(i.discipline.pnlBroke) : '—', 'what it cost', i.discipline.pnlBroke < 0 ? 'loss' : '')}</div>
      <div class="grid g2">${card('By symbol', 'i-sym', 'net · trades · win rate')}${card('By setup', 'i-setup', 'best setups first')}</div>
      <div class="grid g2">${card('By weekday', 'i-wd')}${card('By session', 'i-ses')}</div>
      <div class="grid g2"><section class="card"><div class="card-h"><h3>By hour</h3><span class="kicker">when you make it, when you give it back</span></div><div id="i-hour"></div></section>${card('Long vs short', 'i-side')}</div>
      <section class="card"><div class="card-h"><h3>R distribution</h3><span class="kicker">how your trades end, in R</span></div><div id="i-r"></div></section>`;
    Charts.bars($('#i-sym'), i.bySymbol, { money });
    Charts.bars($('#i-setup'), i.bySetup, { money });
    Charts.bars($('#i-wd'), i.byWeekday, { money });
    Charts.bars($('#i-ses'), i.bySession, { money });
    Charts.hours($('#i-hour'), i.byHour, { money });
    Charts.bars($('#i-side'), i.bySide, { money });
    const max = Math.max(1, ...i.rDist.map((x) => x.n));
    $('#i-r').innerHTML = `<div style="display:grid;grid-template-columns:repeat(${i.rDist.length},1fr);gap:8px;align-items:end;height:170px">${i.rDist.map((x, k) => `<div style="display:grid;gap:6px;justify-items:center;align-self:end"><span class="mono soft" style="font-size:12px">${x.n}</span><span style="width:100%;height:${Math.max(4, (x.n / max) * 120)}px;border-radius:8px;background:var(--${k < 3 ? 'loss' : 'win'});opacity:.8;animation:barin .9s var(--ease) both;transform-origin:bottom"></span><span class="mono muted" style="font-size:11px;text-align:center">${esc(x.label)}</span></div>`).join('')}</div>`;
  }

  /* ---------- log a trade ---------- */
  async function logTrade(view) {
    $('#page-title').innerHTML = 'Log a trade, <em>while it\'s fresh.</em>';
    let outcome = 'win', image = null;
    view.innerHTML = `<div class="grid g-main"><section class="card"><form class="form" id="lg">
      <div class="field"><span>Outcome</span><div class="outcomes">${Object.entries(OUT).map(([k, o]) => `<button type="button" class="oc ${k === 'win' ? 'on' : ''}" data-o="${k}" style="--c:${o.c};--ca:${o.a}">${o.e} ${o.label}<small>${k === 'missed' ? 'not counted' : k === 'be' ? 'about flat' : k === 'win' ? 'green' : 'red'}</small></button>`).join('')}</div></div>
      <div class="row3"><label class="field"><span>Instrument</span><input class="input" name="instrument" placeholder="NQ" maxlength="20" required></label>
        <label class="field"><span>Direction</span><select class="select" name="direction"><option>Long</option><option>Short</option></select></label>
        <label class="field"><span>Trading day</span><input class="input" name="date" placeholder="today" value="today"><small>today, yesterday or a date · after 6 PM ET "today" is the next session</small></label></div>
      <div class="row2"><label class="field"><span>Session</span><select class="select" name="session"><option value="">—</option><option>Asia</option><option>London</option><option>NY AM</option><option>NY PM</option><option>Other</option></select></label>
        <label class="field"><span>Setup</span><input class="input" name="setup" placeholder="HTF sweep → CISD" maxlength="100"></label></div>
      <div class="row2" id="lg-money"><label class="field"><span>PnL</span><input class="input" name="pnl" placeholder="1250" inputmode="decimal"></label><label class="field"><span>R multiple</span><input class="input" name="r" placeholder="2.5" inputmode="decimal"></label></div>
      <div class="row4"><label class="field"><span>Entry</span><input class="input" name="entry"></label><label class="field"><span>Stop</span><input class="input" name="stop"></label><label class="field"><span>Target</span><input class="input" name="target"></label><label class="field"><span>Exit</span><input class="input" name="exit"></label></div>
      <label class="field"><span>Why I took it</span><textarea class="input" name="why" maxlength="400"></textarea></label>
      <div class="row2"><label class="field"><span>What I did right / wrong</span><input class="input" name="p1" maxlength="200"></label><label class="field"><span>And</span><input class="input" name="p2" maxlength="200"></label></div>
      <div class="row2"><label class="field"><span>Lesson</span><input class="input" name="lesson" maxlength="300"></label><label class="field"><span>Followed the plan?</span><select class="select" name="followed"><option value="">—</option><option>YES</option><option>NO</option></select></label></div>
    </form></section>
    <section class="card"><div class="card-h"><h3>Chart</h3><span class="kicker">optional</span></div><div class="drop" id="lg-drop"><span class="big">Drop the chart</span><span>png, jpg, webp or gif · up to 8 MB</span></div><input type="file" id="lg-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      <div class="note" style="margin-top:14px">It posts to this outcome's forum, like <code>/journal</code> does, and counts in every card right away.</div>
      <button class="btn white lg" id="lg-post" style="width:100%;margin-top:14px">Post to the journal</button></section></div>`;
    $$('.oc', view).forEach((b) => b.addEventListener('click', () => {
      outcome = b.dataset.o; $$('.oc', view).forEach((x) => x.classList.toggle('on', x === b));
      $('#lg-money').innerHTML = outcome === 'missed' ? '<label class="field"><span>Potential PnL (not counted)</span><input class="input" name="potential" placeholder="900"></label>'
        : `<label class="field"><span>PnL</span><input class="input" name="pnl" placeholder="${outcome === 'loss' ? '480 (made negative)' : '1250'}" inputmode="decimal"></label>${outcome === 'be' ? '' : '<label class="field"><span>R multiple</span><input class="input" name="r" placeholder="2.5" inputmode="decimal"></label>'}`;
    }));
    dropZone($('#lg-drop'), $('#lg-file'), async (file) => {
      if (file.size > 8 * 1024 * 1024) return toast('That picture is over 8 MB.', 'err');
      const url = await readFile(file); image = { name: file.name, type: file.type, data: url.split(',')[1] };
      $('#lg-drop').innerHTML = `<img src="${url}" alt="Chart"><span class="soft">${esc(file.name)}</span>`;
    }, 'image/');
    $('#lg-post').addEventListener('click', async (e) => {
      const f = Object.fromEntries(new FormData($('#lg')));
      busy(e.currentTarget, true);
      try {
        const r = await api(g('journal'), { method: 'POST', body: { ...f, outcome, ...(image ? { image } : {}) } });
        toast(`Posted for ${esc(day(r.date))}. <a href="${esc(r.link)}" target="_blank" rel="noopener">Open in Discord ↗</a>`, 'ok', 7000);
        route();
      } catch (er) { toast(esc(er.message), 'err', 6000); }
      busy(e.currentTarget, false);
    });
  }

  /* ---------- import ---------- */
  async function importCsv(view) {
    $('#page-title').innerHTML = 'Import trades, <em>never twice.</em>';
    view.innerHTML = `<div class="grid g-main"><section class="card"><div class="drop" id="csv-drop" style="min-height:220px"><span class="big">Drop your trade history</span><span>A .csv from Hyperprop, Tradovate, TopstepX or any sheet with a symbol and a PnL · up to 2 MB</span></div><input type="file" id="csv-file" accept=".csv,.txt,.tsv,text/csv" hidden>
      <label class="field" style="margin-top:14px"><span>Label these trades (optional)</span><input class="input" id="csv-tag" placeholder="Hyperprop · eval 100K" maxlength="60"></label></section>
      <section class="card"><div class="card-h"><h3>How matching works</h3></div><div class="list">
        <div class="li" style="cursor:default"><span>🪪</span><span><div class="t1">Your broker's trade id</div><div class="t2">when the file has one, the strongest match</div></span><span></span></div>
        <div class="li" style="cursor:default"><span>🧬</span><span><div class="t1">Symbol, side, size and times</div><div class="t2">to the minute, so rounding never re-imports</div></span><span></span></div>
        <div class="li" style="cursor:default"><span>✋</span><span><div class="t1">Trades you logged by hand</div><div class="t2">same day, symbol and PnL: held back for you to decide</div></span><span></span></div>
      </div></section></div><div id="csv-out"></div>`;
    dropZone($('#csv-drop'), $('#csv-file'), async (file) => {
      if (file.size > 2 * 1024 * 1024) return toast('That file is over 2 MB. Export a shorter range.', 'err');
      $('#csv-drop').innerHTML = `<span class="big">Reading ${esc(file.name)}…</span>`;
      try {
        const csv = await readFile(file, 'text');
        const p = await api(g('import/preview'), { method: 'POST', body: { csv, name: file.name, tag: $('#csv-tag').value } });
        $('#csv-drop').innerHTML = `<span class="big">${esc(file.name)}</span><span>${esc(p.format)} · drop another file to replace it</span>`;
        preview(p);
      } catch (er) { $('#csv-drop').innerHTML = '<span class="big">Drop your trade history</span>'; toast(esc(er.message), 'err', 7000); }
    });
    const preview = (p) => {
      const net = p.fresh.reduce((s, t) => s + t.pnl, 0);
      $('#csv-out').innerHTML = `<section class="card tabbed" style="--tab:var(--${p.fresh.length ? tone(net) : 'grey'})">
        <div class="card-h"><h3>✨ ${p.fresh.length} new · ♻️ ${p.dupes} already imported${p.manual.length ? ` · ✋ ${p.manual.length} logged by hand` : ''}${p.backfilled ? ` · 🔧 ${p.backfilled} older imports filled in` : ''}</h3><span class="kicker">${p.lastRun ? `last import ${esc(new Date(p.lastRun.at).toLocaleDateString())}` : 'first import'}</span></div>
        ${p.fresh.length ? `<div class="hero-num"><span class="big ${tone(net)}" style="font-size:52px">${money(Math.round(net * 100) / 100)}</span><span class="sub mono">${esc(p.spark)}</span></div>` : '<div class="empty"><span class="em">You\'re up to date</span><span>Every trade in this file is already in your journal.</span></div>'}
        ${p.noDestination.length ? `<div class="note warn" style="margin-top:12px">No forum is set for ${p.noDestination.map((o) => OUT[o].label).join(', ')}: those trades are skipped. Set them in the control panel → Forums.</div>` : ''}
        ${p.fresh.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Day</th><th>Symbol</th><th>Size</th><th>Entry → exit</th><th>Held</th><th class="r">PnL</th></tr></thead><tbody>${p.fresh.slice(-12).reverse().map((t) => `<tr><td><span class="stripe" style="background:${OUT[t.outcome].c}"></span>${esc(day(t.date))}</td><td class="sym">${esc(t.instrument)} <span class="muted">${esc(t.direction || '')}</span></td><td class="mono">${t.qty ? `${t.qty}×` : '—'}</td><td class="mono">${t.entry ? `${esc(t.entry)} → ${esc(t.exit || '')}` : '—'}</td><td class="mono">${esc(t.held || '—')}</td><td class="r money ${tone(t.pnl)}">${money(t.pnl)}</td></tr>`).join('')}</tbody></table></div>${p.fresh.length > 12 ? `<p class="muted" style="margin-top:8px">and ${p.fresh.length - 12} earlier</p>` : ''}` : ''}
        ${p.skipped.length ? `<p class="muted" style="margin-top:10px">⏭️ ${p.skipped.length} rows skipped: ${esc([...new Set(p.skipped.map((s) => s.why))].join(', '))}</p>` : ''}
        <div class="filters" style="margin-top:16px">${p.manual.length ? '<label class="filters" style="gap:10px"><button type="button" class="switch" id="inc-man"></button><span class="soft">Also import the hand-logged lookalikes</span></label>' : ''}<span style="flex:1"></span><button class="btn white" id="csv-go" ${p.fresh.length || p.manual.length ? '' : 'disabled'}>Import ${p.fresh.length} trade${p.fresh.length === 1 ? '' : 's'}</button></div>
        <div id="csv-prog" hidden style="margin-top:16px"><div class="prog"><i id="csv-bar"></i></div><p class="muted mono" id="csv-pt" style="margin-top:8px"></p></div></section>`;
      let inc = false;
      $('#inc-man')?.addEventListener('click', (e) => { inc = !inc; e.currentTarget.classList.toggle('on', inc); $('#csv-go').textContent = `Import ${p.fresh.length + (inc ? p.manual.length : 0)} trades`; });
      $('#csv-go').addEventListener('click', async (e) => {
        busy(e.currentTarget, true);
        try {
          await api(g(`import/${p.id}/run`), { method: 'POST', body: { includeManual: inc } });
          $('#csv-prog').hidden = false;
          const tick = async () => {
            const j = await api(g(`jobs/${p.id}`));
            $('#csv-bar').style.width = `${j.total ? (100 * j.done) / j.total : 100}%`; $('#csv-pt').textContent = `${j.done}/${j.total}${j.last ? ` · ${j.last}` : ''}`;
            if (j.state === 'running') return setTimeout(tick, 1200);
            busy(e.target, false);
            if (j.state === 'done') { const r = j.result, n = r.win + r.loss + r.be; toast(`Imported ${n} trade${n === 1 ? '' : 's'} · ${money(Math.round(r.net * 100) / 100)}${r.failed.length ? ` · ${r.failed.length} failed` : ''}`, r.failed.length ? 'info' : 'ok', 7000); $('#csv-go').textContent = 'Done'; }
            else toast(esc(j.error || 'The import stopped.'), 'err');
          };
          tick();
        } catch (er) { busy(e.currentTarget, false); toast(esc(er.message), 'err'); }
      });
    };
  }

  /* ---------- cards ---------- */
  async function cards(view) {
    $('#page-title').innerHTML = 'Cards, <em>ready to post.</em>';
    const today = (await api(g('settings')).catch(() => null))?.session?.today || new Date().toISOString().slice(0, 10);   // the trading day, not the browser's
    const st = { kind: 'day', date: today, theme: '', range: 'week' };
    view.innerHTML = `<div class="grid g-main"><section class="card"><div class="cards-preview"><img id="cp" alt="Card preview"></div></section>
      <section class="card"><div class="form">
        <div class="field"><span>Card</span><div class="seg" id="ck">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['trades', 'Ledger']].map(([k, l]) => `<button data-k="${k}" class="${k === 'day' ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <label class="field"><span>Any day inside it</span><input class="input" type="date" id="cd" value="${today}"></label>
        <div class="field" id="cr-f" hidden><span>Ledger period</span><div class="seg" id="cr">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => `<button data-k="${k}" class="${k === 'week' ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="field"><span>Theme</span><div class="seg" id="ct"><button data-k="" class="on">Server's</button><button data-k="light">Studio</button><button data-k="dark">Night</button></div></div>
        <div class="filters"><a class="btn white" id="cdl" download>Download PNG</a>${S.guild.manage ? '<button class="btn" id="cpost">Post to the report channel</button>' : ''}</div>
        <div class="note">Cards use the trading day: after 6 PM New York, a day belongs to the next session.</div>
      </div></section></div>`;
    let last = null;
    const draw = async () => {
      const img = $('#cp'); img.classList.add('loading');
      const p = new URLSearchParams({ date: st.date }); if (st.theme) p.set('theme', st.theme); if (st.kind === 'trades') p.set('range', st.range);
      try { const u = await blobUrl(g(`card/${st.kind}?${p}`)); if (last) URL.revokeObjectURL(last); last = u; img.src = u; $('#cdl').href = u; $('#cdl').download = `${st.kind}-${st.date}.png`; } catch (e) { toast(esc(e.message), 'err'); }
      img.classList.remove('loading');
    };
    const segPick = (id, key) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; $$(`${id} button`).forEach((x) => x.classList.toggle('on', x === b)); st[key] = b.dataset.k; $('#cr-f').hidden = st.kind !== 'trades'; draw(); });
    segPick('#ck', 'kind'); segPick('#ct', 'theme'); segPick('#cr', 'range');
    $('#cd').addEventListener('change', (e) => { st.date = e.target.value || today; draw(); });
    $('#cpost')?.addEventListener('click', async (e) => {
      if (st.kind === 'trades') return toast('The ledger is for you; the report channel gets day, week and month cards.', 'info');
      busy(e.currentTarget, true);
      try { const r = await api(g('action/post'), { method: 'POST', body: { kind: st.kind, date: st.date } }); toast(`Posted to #${esc(r.channel)}.`); } catch (er) { toast(esc(er.message), 'err'); }
      busy(e.currentTarget, false);
    });
    draw();
  }

  /* ---------- control panel ---------- */
  async function settings(view, qs, seq) {
    const tab = qs.get('tab') || 'general';
    const d = await api(g('settings')); if (seq !== routeSeq) return;
    $('#page-title').innerHTML = 'Control panel, <em>no slash commands.</em>';
    const T = [['general', 'General'], ['forums', 'Forums'], ['reports', 'Reports'], ['day', 'Trading day'], ['look', 'Appearance'], ['tools', 'Maintenance'], ['embed', 'Embed & hosting']];
    const s = d.settings, opt = (list, cur, none = '— none —') => `<option value="">${none}</option>${list.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
    const row = (t, desc, ctl) => `<div class="set-row"><div><div class="t">${t}</div><div class="d">${desc}</div></div><div class="ctl">${ctl}</div></div>`;
    const sw = (k, on) => `<button class="switch ${on ? 'on' : ''}" data-switch="${k}" aria-pressed="${on}"></button>`;
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const body = {
      general: `${row('Timezone', 'Report times and trade times are shown in it', `<input class="input" data-k="timezone" value="${esc(s.timezone)}" style="width:220px">`)}
        ${row('Currency', 'The symbol in front of every amount', `<input class="input" data-k="currency" value="${esc(s.currency)}" maxlength="3" style="width:80px">`)}
        ${row('Show R multiples', 'In posts and on cards, when an R is logged', sw('show_r', s.show_r))}
        ${row('Who can use the journal', s.allowed_users.length ? `${s.allowed_users.length} selected user${s.allowed_users.length === 1 ? '' : 's'} (change in <code>/journal-settings</code> → Advanced)` : 'Anyone with Manage Server', '')}`,
      forums: `${['win', 'loss', 'be', 'missed'].map((o) => row(`${OUT[o].e} ${OUT[o].label}`, s.outcome_threads?.[o]?.thread ? 'Goes into an existing post (picked in Discord). Choose a forum to post new ones instead.' : 'A new post in this forum each time', `<select class="select" data-of="${o}" style="width:240px">${opt(d.forums, s.outcome_forums?.[o], s.outcome_threads?.[o]?.thread ? '— existing post —' : '— default forum —')}</select>`)).join('')}
        ${row('Default forum', 'Used for outcomes without their own', `<select class="select" data-k="default_forum_id" style="width:240px">${opt(d.forums, s.default_forum_id)}</select>`)}`,
      reports: `${row('Report channel', 'Where the weekly and month-end cards are posted', `<select class="select" data-k="report_channel_id" style="width:240px">${opt(d.text, s.report_channel_id)}</select>`)}
        ${row('Weekly report', `Every ${DAYS[s.weekly_day - 1]} at ${esc(s.weekly_time)}`, `<select class="select" data-k="weekly_day" style="width:150px">${DAYS.map((x, i) => `<option value="${i + 1}" ${i + 1 === s.weekly_day ? 'selected' : ''}>${x}</option>`).join('')}</select><input class="input" data-k="weekly_time" value="${esc(s.weekly_time)}" style="width:90px">${sw('weekly_enabled', s.weekly_enabled)}`)}
        ${row('Month-end report', `The last day of each month at ${esc(s.month_time)}`, `<input class="input" data-k="month_time" value="${esc(s.month_time)}" style="width:90px">${sw('month_enabled', s.month_enabled)}`)}
        ${row('Ping a role', 'Mentioned on scheduled reports', `<select class="select" data-k="ping_role_id" style="width:220px">${opt(d.roles, s.ping_role_id)}</select>`)}
        ${row('Post now', 'Send this week or this month to the report channel', '<button class="btn sm" data-post="week">Weekly</button><button class="btn sm" data-post="month">Monthly</button>')}`,
      day: `${row('When the trading day starts', esc(d.session.describe), `<select class="select" data-session style="width:230px">${Object.entries(d.session.presets).map(([k, p]) => `<option value="${k}" ${k === d.session.preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}${d.session.preset === 'custom' ? `<option value="custom" selected>Custom: ${esc(d.session.start)}</option>` : ''}</select>`)}
        ${row('Custom start', 'A start time on New York\'s clock, 24h', `<input class="input" id="sess-start" value="${esc(s.session_start)}" style="width:90px"><button class="btn sm" id="sess-save">Use it</button>`)}
        ${row('Today is', `The trading day right now: <b>${esc(day(d.session.today, { weekday: 'long', month: 'short', day: 'numeric' }))}</b>`, '')}
        ${row('Fix past trades', 'Move trades logged before this rule to their trading day; posts are rewritten', '<button class="btn sm" id="redate-plan">Preview</button>')}<div id="redate-out"></div>`,
      look: `${row('Card theme', 'Every image the bot draws', `<div class="seg" data-theme>${[['light', 'Studio'], ['dark', 'Night'], ['auto', 'Auto']].map(([k, l]) => `<button data-v="${k}" class="${s.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
        <div class="grid g2" style="margin-top:12px"><div class="cards-preview" style="min-height:0"><img src="/samples/daily-pnl-sample.png" alt="Studio"></div><div class="cards-preview" style="min-height:0"><img src="/samples/dark-daily-pnl-sample.png" alt="Night"></div></div>`,
      tools: `${row('Rescan the forums', 'Re-read every journal post and rebuild PnL', '<button class="btn sm" id="rescan">Rescan</button>')}
        ${row('Health check', 'Permissions in every forum and channel the bot uses', '<button class="btn sm" id="health">Check</button>')}<div id="tool-out"></div>`,
      embed: `<div class="note">Add these in your host's variables, then restart the bot. Values in &lt;angle brackets&gt; are yours to fill in.</div>
        <div class="code">${esc(`SERVER_PORT=<the port your host gives you>
PUBLIC_BASE_URL=${location.origin}
DISCORD_CLIENT_ID=<your bot's application id>
DISCORD_CLIENT_SECRET=<OAuth2 → Client secret>
SESSION_SECRET=<any long random text>
PANEL_FRAME_ANCESTORS=https://whop.com https://*.whop.com`)}</div>
        ${row('Discord redirect', 'Add this exact URL in the Developer Portal → OAuth2 → Redirects', `<code>${esc(location.origin)}/auth/callback</code>`)}
        ${row('Whop app view', 'In your Whop app, set the experience view to this address', `<code>${esc(location.origin)}/experiences/[experienceId]</code>`)}
        ${row('Embedding', S.me.embed ? 'On: the panel may be framed by the sites in PANEL_FRAME_ANCESTORS' : 'Off: set PANEL_FRAME_ANCESTORS to allow Whop', S.me.embed ? '<span class="badge win">on</span>' : '<span class="badge">off</span>')}`,
    };
    view.innerHTML = `<div class="tabs">${T.map(([k, l]) => `<a class="btn sm ${k === tab ? 'white' : ''}" href="#/settings?tab=${k}">${l}</a>`).join('')}</div><section class="card" id="set">${body[tab]}</section>`;
    const save = async (patch, msg = 'Saved') => { try { await api(g('settings'), { method: 'PATCH', body: patch }); toast(msg); } catch (e) { toast(esc(e.message), 'err'); route(); } };
    $$('[data-k]', view).forEach((n) => n.addEventListener('change', () => save({ [n.dataset.k]: n.dataset.k === 'weekly_day' ? Number(n.value) : n.value || null })));
    $$('[data-of]', view).forEach((n) => n.addEventListener('change', () => save({ outcome_forums: { [n.dataset.of]: n.value || null } })));
    $$('[data-switch]', view).forEach((n) => n.addEventListener('click', () => { const on = !n.classList.contains('on'); n.classList.toggle('on', on); save({ [n.dataset.switch]: on }); }));
    $('[data-session]', view)?.addEventListener('change', (e) => { if (e.target.value !== 'custom') save({ session: e.target.value }, 'Trading day updated').then(route); });
    $('#sess-save')?.addEventListener('click', () => save({ session: 'custom', session_start: $('#sess-start').value, session_fold: true }, 'Trading day updated').then(route));
    $('[data-theme]', view)?.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; $$('[data-theme] button').forEach((x) => x.classList.toggle('on', x === b)); save({ theme: b.dataset.v }, `Cards are ${b.textContent} now`); });
    $$('[data-post]', view).forEach((b) => b.addEventListener('click', async () => { busy(b, true); try { const r = await api(g('action/post'), { method: 'POST', body: { kind: b.dataset.post } }); toast(`Posted to #${esc(r.channel)}.`); } catch (e) { toast(esc(e.message), 'err'); } busy(b, false); }));
    $('#rescan')?.addEventListener('click', async (e) => { busy(e.target, true); try { const r = await api(g('action/rescan'), { method: 'POST' }); $('#tool-out').innerHTML = `<div class="note">${esc(r.summary).replace(/\n/g, '<br>')}</div>`; } catch (er) { toast(esc(er.message), 'err'); } busy(e.target, false); });
    $('#health')?.addEventListener('click', async (e) => { busy(e.target, true); try { const r = await api(g('action/health'), { method: 'POST' }); $('#tool-out').innerHTML = `<div class="note">${r.lines.map((l) => esc(l).replace(/&lt;#(\d+)&gt;/g, '#channel')).join('<br>')}</div>`; } catch (er) { toast(esc(er.message), 'err'); } busy(e.target, false); });
    $('#redate-plan')?.addEventListener('click', async (e) => {
      busy(e.target, true);
      try {
        const r = await api(g('action/redate-plan'), { method: 'POST' });
        $('#redate-out').innerHTML = !r.count ? '<div class="note">✅ Every trade is already on its trading day.</div>' : `<div class="note"><b>${r.count} trade${r.count === 1 ? '' : 's'} move to the next session</b><br>${r.moves.map((m) => `${esc(m.instrument || '?')} ${money(m.pnl)} · ${esc(day(m.from))} → <b>${esc(day(m.to))}</b>`).join('<br>')}</div><button class="btn white sm" id="redate-go" style="margin-top:10px">Move ${r.count} trade${r.count === 1 ? '' : 's'}</button><div class="prog" style="margin-top:10px" hidden id="rd-p"><i id="rd-b"></i></div>`;
        $('#redate-go')?.addEventListener('click', async (ev) => {
          busy(ev.target, true);
          const j0 = await api(g('action/redate'), { method: 'POST' }); $('#rd-p').hidden = false;
          const tick = async () => { const j = await api(g(`jobs/${j0.id}`)); $('#rd-b').style.width = `${j.total ? (100 * j.done) / j.total : 100}%`; if (j.state === 'running') return setTimeout(tick, 1200); busy(ev.target, false); toast(j.state === 'done' ? `Moved ${j.result.moved + j.result.journalOnly} trades.` : esc(j.error || 'Stopped'), j.state === 'done' ? 'ok' : 'err'); };
          tick();
        });
      } catch (er) { toast(esc(er.message), 'err'); }
      busy(e.target, false);
    });
  }

  boot();
})();
