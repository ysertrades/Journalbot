'use strict';
/* The tab icon, alive. The ledger mark plays "the open" when the page loads: three bars draw in, the dot
   pops, a ring ripples out. While you are on the page the dot breathes now and then. In the journal it
   carries today's tone (green up, red down, grey flat), and a trade that arrives live from Discord replays
   the open, with a count on the icon and in the title while you are on another tab.
   Drawn on a canvas and swapped in as the icon; browsers that keep the first icon (Safari) keep the SVG. */
(() => {
  const link = document.querySelector('link[rel="icon"]');
  const cv = document.createElement('canvas'), S = 64; cv.width = cv.height = S;
  const c = cv.getContext && cv.getContext('2d');
  if (!link || !c) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COL = { win: '#3ccf7a', loss: '#f87171', be: '#a3a7b0', flat: '#a3a7b0', ink: '#eeeff2' };
  const RING = { win: '60,207,122', loss: '248,113,113', be: '163,167,176', flat: '163,167,176' };
  const st = { tone: 'win', badge: 0, anim: null, t0: 0, timer: 0, last: '' };
  const clamp = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
  const out = (k) => 1 - Math.pow(1 - clamp(k), 3);
  const back = (k) => { k = clamp(k); const a = 1.9; return 1 + (a + 1) * Math.pow(k - 1, 3) + a * Math.pow(k - 1, 2); };   // lands with a little overshoot

  const REST = { bars: [1, 1, 1], dot: 1, ring: -1 };
  // each animation: its length, and the mark at time t (ms)
  const ANIM = {
    open: { ms: 1700, at: (t) => ({ bars: [0, 1, 2].map((i) => out((t - 120 - i * 170) / 340)), dot: back((t - 700) / 460), ring: t > 950 ? (t - 950) / 750 : -1 }) },
    ping: { ms: 1300, at: (t) => ({ bars: [0, 1, 2].map((i) => out((t - i * 80) / 260)), dot: back((t - 260) / 420), ring: t > 320 ? (t - 320) / 900 : -1 }) },
    breath: { ms: 1100, at: (t) => ({ bars: [1, 1, 1], dot: 1 + 0.18 * Math.sin(Math.PI * clamp(t / 700)), ring: t / 1100 }) },
  };

  function draw(f) {
    c.clearRect(0, 0, S, S);
    c.beginPath(); c.roundRect(0, 0, S, S, 16); c.fillStyle = '#0b0c0e'; c.fill();
    c.beginPath(); c.roundRect(1, 1, S - 2, S - 2, 15); c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 2; c.stroke();
    c.lineCap = 'round'; c.lineWidth = 5;
    [[24, 22, COL.win, 1], [33, 14, COL.ink, 1], [42, 18, COL.ink, 0.55]].forEach(([y, w, col, a], i) => {
      const k = f.bars[i]; if (k <= 0.01) return;
      c.globalAlpha = a; c.strokeStyle = col; c.beginPath(); c.moveTo(18, y); c.lineTo(18 + w * k, y); c.stroke();
    });
    c.globalAlpha = 1;
    if (f.ring >= 0 && f.ring < 1) { c.beginPath(); c.arc(46, 40, 5 + f.ring * 15, 0, Math.PI * 2); c.strokeStyle = `rgba(${RING[st.tone]},${((1 - f.ring) * 0.9).toFixed(3)})`; c.lineWidth = 3; c.stroke(); }
    if (f.dot > 0.01) { c.beginPath(); c.arc(46, 40, 5 * f.dot, 0, Math.PI * 2); c.fillStyle = COL[st.tone]; c.fill(); }
    if (st.badge) {   // the count of trades that arrived while you were away
      const s = st.badge > 9 ? '9+' : String(st.badge);
      c.beginPath(); c.arc(47, 17, 15, 0, Math.PI * 2); c.fillStyle = COL.win; c.fill(); c.lineWidth = 4; c.strokeStyle = '#0b0c0e'; c.stroke();
      c.fillStyle = '#04140b'; c.font = `800 ${s.length > 1 ? 15 : 20}px Inter, system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s, 47, 18);
    }
    const url = cv.toDataURL('image/png');
    if (url !== st.last) { st.last = url; link.type = 'image/png'; link.href = url; }
  }
  function frame() {
    const a = ANIM[st.anim]; if (!a) return;
    const t = performance.now() - st.t0;
    if (t >= a.ms) { st.anim = null; draw(REST); return; }
    draw(a.at(t));
    st.timer = setTimeout(frame, 1000 / 24);
  }
  /** a hidden tab gets one timer tick a second at best: there it simply shows where the animation ends */
  function play(name) {
    if (reduce || document.hidden) { draw(REST); return; }
    clearTimeout(st.timer); st.anim = name; st.t0 = performance.now(); frame();
  }
  setInterval(() => { if (!st.anim && !document.hidden && !reduce) play('breath'); }, 8000);

  const plain = () => document.title.replace(/^\(\d+\+?\) /, '');
  function setBadge(n) {
    st.badge = n;
    document.title = n ? `(${n > 9 ? '9+' : n}) ${plain()}` : plain();
    if (!st.anim) draw(REST);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.badge) { setBadge(0); play('ping'); } });

  window.JBIcon = {
    /** today's result: 'win', 'loss', 'be' or 'flat' */
    tone(t) { const n = COL[t] ? t : 'flat'; if (n === st.tone) return; st.tone = n; if (!st.anim) draw(REST); },
    /** a trade just arrived: replay the open, and count it while the tab is in the background */
    arrived() { if (document.hidden) setBadge(st.badge + 1); else play('ping'); },
  };
  if (document.fonts?.load) document.fonts.load('800 20px Inter').catch(() => {});
  play('open');
})();
