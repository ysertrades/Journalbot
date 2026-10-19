'use strict';
/**
 * PnL image renderer (weekly + monthly), in the studio look of the YSER
 * landing page: a bright floor with a soft grid, an ink headline with a serif
 * italic turn ("Week 42, in the green."), dark glass cards floating on the
 * floor with soft shadows, white pills for the numbers, an ink equity curve,
 * and the YSER trades sign-off.
 *
 * Same inputs and exports as before: renderWeekly(weekData) and
 * renderMonthly(monthData) from pnl.js, each returning a PNG buffer.
 */
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { DateTime } = require('luxon');
const { formatDollars } = require('./money');

const FD = path.join(__dirname, '..', '..', 'assets', 'fonts');
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(FD, 'Inter-Medium.ttf'), 'Inter');
  GlobalFonts.registerFromPath(path.join(FD, 'Inter-SemiBold.ttf'), 'Inter');
  GlobalFonts.registerFromPath(path.join(FD, 'Inter-ExtraBold.ttf'), 'Inter');
  GlobalFonts.registerFromPath(path.join(FD, 'JetBrainsMono-Regular.ttf'), 'JB Mono');
  GlobalFonts.registerFromPath(path.join(FD, 'InstrumentSerif-Italic.ttf'), 'Instrument Serif');
  fontsReady = true;
}

const SCALE = 2;
const W = 1600;
const PAD = 56;
const INNER_W = W - PAD * 2;
const BASE_K = { inter: 0.864, mono: 0.86, serif: 0.8 }; // baseline inside a line-height:1 box

/**
 * Two palettes over the same drawing. Studio is the landing page: a bright
 * floor, white paper tiles, dark glass cards. Night turns the room off: a
 * graphite floor with a faint aurora in the period's outcome colour, paper
 * tiles become smoked glass, and the glass cards glow in their outcome colour
 * instead of casting a shadow. Every draw reads C, so one swap themes a card.
 */
const THEMES = {
  light: {
    floor: '#f9fbfb', floor2: '#eef0f4', glow: '#ffffff', ink: '#15171c', ink2: '#2a2d36', inkInv: '#ffffff', grey: '#8b8b92', soft: '#5b5f6b',
    line: 'rgba(26,33,51,.08)', card: '#0c0d10', card2: '#16181d', shadow: '26,33,51', shadowK: 1, grid: '26,33,51', gridA: 0.06,
    paper: '#ffffff', paperDim: 'rgba(255,255,255,.55)', tile: '#15171c', capsule: '#15171c', blurple: '#5865f2', dark: false,
  },
  dark: {
    floor: '#0e1014', floor2: '#060709', glow: '#1c2029', ink: '#f2f3f6', ink2: '#d6d9e0', inkInv: '#0c0d10', grey: '#7c818d', soft: '#a3a9b5',
    line: 'rgba(255,255,255,.075)', card: '#111318', card2: '#181b21', shadow: '0,0,0', shadowK: 2.4, grid: '255,255,255', gridA: 0.045,
    paper: '#16191f', paperDim: 'rgba(22,25,31,.6)', tile: '#07080a', capsule: '#1f232b', blurple: '#7983ff', dark: true,
  },
};
const C = { ...THEMES.light, aurora: null };
/* outcome colours: bright on the dark cards, deeper on the light floor */
const OUT = {
  win:  { rgb: '60,207,122',  hex: '#3ccf7a', deep: '#159a52', word: 'WIN' },
  loss: { rgb: '248,113,113', hex: '#f87171', deep: '#d33c3c', word: 'LOSS' },
  be:   { rgb: '245,184,75',  hex: '#f5b84b', deep: '#b97a0c', word: 'BREAKEVEN' },
  none: { rgb: '148,163,184', hex: '#94a3b8', deep: '#8b8b92', word: 'NO TRADE' },
};
const DEEP_LIGHT = Object.fromEntries(Object.entries(OUT).map(([k, v]) => [k, v.deep]));

/**
 * Runs one render in a theme: 'light' | 'dark'. The aurora is the period's
 * tone (only Night draws it). Rendering is synchronous, so swapping the shared
 * palette and putting it back afterwards can never leak into another card.
 */
function withTheme(theme, tone, draw) {
  const prev = { ...C };
  Object.assign(C, THEMES[theme] || THEMES.light, { aurora: tone });
  // on a dark floor the "deep" text colours would sink; the bright ones read instead
  for (const k of Object.keys(OUT)) OUT[k].deep = C.dark ? (k === 'none' ? C.grey : OUT[k].hex) : DEEP_LIGHT[k];
  try { return draw(); } finally {
    Object.assign(C, prev);
    for (const k of Object.keys(OUT)) OUT[k].deep = DEEP_LIGHT[k];
  }
}
const toneFor = (total, empty) => (empty ? 'none' : total > 0 ? 'win' : total < 0 ? 'loss' : 'be');

const outcomeOf = (d) => (!d || d.trades === 0 ? 'none' : d.pnl > 0 ? 'win' : d.pnl < 0 ? 'loss' : 'be');
const toneOf = (v) => (v > 0 ? 'win' : v < 0 ? 'loss' : 'be');

/* ------------------------------ primitives ------------------------------ */
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function font(ctx, kind, size, weight = 400, italic = false) {
  const fam = kind === 'inter' ? 'Inter' : kind === 'mono' ? '"JB Mono"' : '"Instrument Serif"';
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${fam}`;
}
function setLS(ctx, px) { ctx.letterSpacing = `${px}px`; }
function measure(ctx, str, kind, size, weight = 400, ls = 0, italic = false) {
  font(ctx, kind, size, weight, italic); setLS(ctx, ls);
  const w = ctx.measureText(str).width; setLS(ctx, 0); return w;
}
/** text with its line-height:1 box TOP at `top`; returns its width */
function text(ctx, str, x, top, { kind = 'inter', size = 16, weight = 400, color = C.ink, align = 'left', ls = 0, italic = false } = {}) {
  font(ctx, kind, size, weight, italic); setLS(ctx, ls);
  const w = ctx.measureText(str).width;
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color;
  ctx.fillText(str, left, top + size * BASE_K[kind]);
  setLS(ctx, 0);
  return w;
}
function shrink(ctx, str, maxW, { kind = 'inter', size, weight = 800, ls = 0, min = 14 }) {
  let s = size;
  while (s > min && measure(ctx, str, kind, s, weight, ls) > maxW) s -= 2;
  return s;
}
function shadowed(ctx, fn, { blur = 30, y = 18, alpha = 0.22 } = {}) {
  ctx.save(); ctx.shadowColor = `rgba(${C.shadow},${Math.min(0.85, alpha * C.shadowK)})`; ctx.shadowBlur = blur * SCALE; ctx.shadowOffsetY = y * SCALE; fn(); ctx.restore();
}
function icon(ctx, kind, cx, cy, size, color, stroke = 3.2) {
  const k = size / 24; ctx.save(); ctx.translate(cx - size / 2, cy - size / 2); ctx.scale(k, k);
  ctx.strokeStyle = color; ctx.lineWidth = stroke; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  if (kind === 'win') { ctx.moveTo(6, 15); ctx.lineTo(12, 8); ctx.lineTo(18, 15); }
  else if (kind === 'loss') { ctx.moveTo(6, 9); ctx.lineTo(12, 16); ctx.lineTo(18, 9); }
  else if (kind === 'be') { ctx.moveTo(5, 10); ctx.lineTo(19, 10); ctx.moveTo(5, 15); ctx.lineTo(19, 15); }
  else { ctx.moveTo(7, 12); ctx.lineTo(17, 12); }
  ctx.stroke(); ctx.restore();
}

/** a five-point star (drawn: the bundled fonts have no ★ glyph) */
function star(ctx, cx, cy, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r * 0.45 : r;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
}

/* ------------------------------- the floor ------------------------------- */
function floor(ctx, H, W = 1600) {
  const g = ctx.createRadialGradient(W * 0.68, -40, 0, W * 0.68, -40, W * 0.95);
  g.addColorStop(0, C.glow); g.addColorStop(0.45, C.floor); g.addColorStop(1, C.floor2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Night: a faint aurora in the period's colour behind the headline, and a cool counter-glow low on the left
  if (C.dark) {
    const a = OUT[C.aurora && C.aurora !== 'none' ? C.aurora : 'none'];
    const au = ctx.createRadialGradient(W * 0.8, -H * 0.05, 0, W * 0.8, -H * 0.05, Math.max(W, H) * 0.7);
    au.addColorStop(0, `rgba(${a.rgb},${C.aurora && C.aurora !== 'none' ? 0.16 : 0.07})`); au.addColorStop(0.5, `rgba(${a.rgb},.04)`); au.addColorStop(1, `rgba(${a.rgb},0)`);
    ctx.fillStyle = au; ctx.fillRect(0, 0, W, H);
    const cg = ctx.createRadialGradient(-W * 0.1, H * 1.05, 0, -W * 0.1, H * 1.05, W * 0.7);
    cg.addColorStop(0, 'rgba(88,101,242,.07)'); cg.addColorStop(1, 'rgba(88,101,242,0)');
    ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H);
  }
  // the soft grid, fading toward the edges
  const grid = createCanvas(W, H), gx = grid.getContext('2d');
  gx.strokeStyle = `rgba(${C.grid},${C.gridA})`; gx.lineWidth = 1; gx.beginPath();
  for (let x = 0; x <= W; x += 40) { gx.moveTo(x + 0.5, 0); gx.lineTo(x + 0.5, H); }
  for (let y = 0; y <= H; y += 40) { gx.moveTo(0, y + 0.5); gx.lineTo(W, y + 0.5); }
  gx.stroke();
  gx.globalCompositeOperation = 'destination-in';
  const m = gx.createRadialGradient(W * 0.62, H * 0.28, 0, W * 0.62, H * 0.28, W * 0.75);
  m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.55, 'rgba(0,0,0,.55)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  gx.fillStyle = m; gx.fillRect(0, 0, W, H);
  ctx.drawImage(grid, 0, 0, W, H);
}

/* --------------------------------- header -------------------------------- */
/** pill, headline with its italic turn, and the total on the right */
function header(ctx, { kicker, lead, total, label, chip, symbol, empty }) {
  const t = OUT[toneOf(total)];
  // the pill: ink tile with a live dot, then the kicker
  const pillY = 46, pillH = 46, kw = measure(ctx, kicker, 'inter', 17, 600, 0.2);
  const pillW = 12 + 26 + 12 + kw + 22;
  shadowed(ctx, () => { rr(ctx, PAD, pillY, pillW, pillH, 23); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 18, y: 8, alpha: 0.12 });
  rr(ctx, PAD + 0.5, pillY + 0.5, pillW - 1, pillH - 1, 23); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, PAD + 10, pillY + 10, 26, 26, 8); ctx.fillStyle = C.tile; ctx.fill();
  ctx.fillStyle = empty ? OUT.none.hex : t.hex; ctx.beginPath(); ctx.arc(PAD + 23, pillY + 23, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(${empty ? OUT.none.rgb : t.rgb},.35)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(PAD + 23, pillY + 23, 8, 0, Math.PI * 2); ctx.stroke();
  text(ctx, kicker, PAD + 12 + 26 + 12, pillY + 15, { size: 17, weight: 600, color: C.ink2, ls: 0.2 });

  // the headline: "Week 42," in ink, then the italic turn in grey
  const turn = empty ? 'nothing logged.' : total > 0 ? 'in the green.' : total < 0 ? 'in the red.' : 'dead flat.';
  const hy = 122, hs = 74;
  const lw = text(ctx, `${lead},`, PAD, hy, { size: hs, weight: 800, ls: -hs * 0.045 });
  text(ctx, turn, PAD + lw + 18, hy + hs * 0.08, { kind: 'serif', size: hs * 1.08, italic: true, color: C.grey, ls: -0.5 });
  // a short underline in the outcome colour, under the italic word
  const uw = measure(ctx, turn, 'serif', hs * 1.08, 400, -0.5, true);
  ctx.fillStyle = empty ? `rgba(${OUT.none.rgb},.35)` : `rgba(${t.rgb},.55)`; rr(ctx, PAD + lw + 22, hy + hs + 12, Math.min(uw - 8, 220), 4, 2); ctx.fill();

  // the total, right aligned
  text(ctx, label, W - PAD, 56, { kind: 'mono', size: 15, color: C.grey, align: 'right', ls: 4 });
  const val = formatDollars(total, { symbol });
  const vs = shrink(ctx, val, 560, { size: 104, weight: 800, ls: -4 });
  const vw = text(ctx, val, W - PAD, 84, { size: vs, weight: 800, color: empty ? C.grey : t.deep, ls: -vs * 0.04, align: 'right' });
  if (chip != null) {
    const o = OUT[toneOf(chip)], s = `+ WEEKEND ${formatDollars(chip, { symbol })}`;
    const cw = measure(ctx, s, 'inter', 15, 600, 1.6) + 36, cx = W - PAD - vw - 26 - cw, cy = 84 + vs * 0.36;
    rr(ctx, cx, cy, cw, 40, 20); ctx.fillStyle = C.paper; ctx.fill();
    rr(ctx, cx + 0.5, cy + 0.5, cw - 1, 39, 20); ctx.strokeStyle = `rgba(${o.rgb},.55)`; ctx.lineWidth = 1.5; ctx.stroke();
    text(ctx, s, cx + 18, cy + 13, { size: 15, weight: 600, color: o.deep, ls: 1.6 });
  }
}

/* ----------------------------- dark glass card ---------------------------- */
function glassCard(ctx, x, y, w, h, r, o, { lift = true, faint = false } = {}) {
  const c = OUT[o];
  const body = () => { rr(ctx, x, y, w, h, r); ctx.fillStyle = C.card; ctx.fill(); };
  if (lift && C.dark) {   // Night: the card glows in its outcome colour instead of casting a shadow
    ctx.save();
    ctx.shadowColor = o === 'none' ? 'rgba(0,0,0,.55)' : `rgba(${c.rgb},${faint ? 0.1 : 0.22})`;
    ctx.shadowBlur = 44 * SCALE; ctx.shadowOffsetY = 12 * SCALE; body(); ctx.restore();
  } else if (lift) shadowed(ctx, body, { blur: 34, y: 20, alpha: faint ? 0.14 : 0.28 }); else body();
  rr(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, o === 'none' ? 'rgba(255,255,255,.035)' : `rgba(${c.rgb},.16)`); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fill();
  // a lit top edge and a hairline
  rr(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, r - 0.75); ctx.strokeStyle = C.dark ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.07)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip();
  const e = ctx.createLinearGradient(x, 0, x + w, 0);
  e.addColorStop(0, 'rgba(255,255,255,0)'); e.addColorStop(0.5, o === 'none' ? 'rgba(255,255,255,.16)' : `rgba(${c.rgb},.85)`); e.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = e; ctx.fillRect(x + 18, y, w - 36, 2);
  ctx.restore();
}
function outcomePill(ctx, o, x, y) {
  const c = OUT[o], lw = measure(ctx, c.word, 'inter', 14, 600, 2);
  const w = 12 + 20 + 8 + lw + 16, h = 34;
  rr(ctx, x, y, w, h, 17); ctx.fillStyle = `rgba(${c.rgb},.13)`; ctx.fill();
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 17); ctx.strokeStyle = `rgba(${c.rgb},.4)`; ctx.lineWidth = 1; ctx.stroke();
  icon(ctx, o, x + 12 + 10, y + h / 2, 18, c.hex, 3);
  text(ctx, c.word, x + 12 + 20 + 8, y + h / 2 - 7, { size: 14, weight: 600, color: c.hex, ls: 2 });
}

/* ------------------------------ equity curve ------------------------------ */
function curve(ctx, top, height, pts, { labelAll, caption, symbol, x0 = PAD, x1 = W - PAD }) {
  text(ctx, caption, x0, top, { kind: 'mono', size: 14, color: C.grey, ls: 4 });
  // the highest point sits low enough that its value tag clears the caption
  const base = top + height - 18, ytop = top + 84;
  const vals = pts.map((p) => p.v), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), rng = hi - lo || 1;
  const Y = (v) => base - ((v - lo) / rng) * (base - ytop);
  const zero = Y(0), ys = vals.map(Y);
  // the zero line
  ctx.save(); ctx.setLineDash([4, 8]); ctx.strokeStyle = `rgba(${C.grid},.22)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x1, zero); ctx.stroke(); ctx.restore();
  const last = vals[vals.length - 1], t = OUT[toneOf(last)];
  // area: green above zero, red below, fading to the line
  const area = () => { ctx.beginPath(); ctx.moveTo(pts[0].x, zero); pts.forEach((p, i) => ctx.lineTo(p.x, ys[i])); ctx.lineTo(pts[pts.length - 1].x, zero); ctx.closePath(); };
  ctx.save(); area(); ctx.clip();
  const up = ctx.createLinearGradient(0, ytop, 0, zero); up.addColorStop(0, `rgba(${OUT.win.rgb},.30)`); up.addColorStop(1, `rgba(${OUT.win.rgb},0)`);
  ctx.fillStyle = up; ctx.fillRect(x0 - 20, ytop - 40, x1 - x0 + 40, zero - ytop + 40);
  const dn = ctx.createLinearGradient(0, zero, 0, base); dn.addColorStop(0, `rgba(${OUT.loss.rgb},0)`); dn.addColorStop(1, `rgba(${OUT.loss.rgb},.28)`);
  ctx.fillStyle = dn; ctx.fillRect(x0 - 20, zero, x1 - x0 + 40, base - zero + 40);
  ctx.restore();
  // the line itself, in ink
  const line = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, ys[i]) : ctx.moveTo(p.x, ys[i]))); };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (pts.length > 1) { shadowed(ctx, () => { ctx.strokeStyle = C.ink; ctx.lineWidth = 3.5; line(); ctx.stroke(); }, { blur: 10, y: 6, alpha: 0.18 }); }
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    if (p.ghost || (!labelAll && !isLast)) return; // ghost: the $0 start, line only
    const o = OUT[toneOf(p.v)];
    ctx.fillStyle = C.paper; ctx.beginPath(); ctx.arc(p.x, ys[i], isLast ? 10 : 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = o.hex; ctx.beginPath(); ctx.arc(p.x, ys[i], isLast ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
    // value tag: a small white pill above the point
    const s = formatDollars(p.v, { symbol }), tw = measure(ctx, s, 'mono', 16) + 22;
    let tx = labelAll ? p.x - tw / 2 : p.x - tw; tx = Math.max(x0, Math.min(x1 - tw, tx));
    const ty = ys[i] - 52;
    shadowed(ctx, () => { rr(ctx, tx, ty, tw, 30, 15); ctx.fillStyle = isLast ? C.ink : C.paper; ctx.fill(); }, { blur: 12, y: 5, alpha: 0.12 });
    text(ctx, s, tx + 11, ty + 8, { kind: 'mono', size: 16, color: isLast ? C.inkInv : o.deep });
  });
}

/* --------------------------------- stats --------------------------------- */
function stats(ctx, top, list, h = 92) {
  const n = list.length, gap = 14, cw = (INNER_W - gap * (n - 1)) / n;
  list.forEach((s, i) => {
    const x = PAD + i * (cw + gap);
    shadowed(ctx, () => { rr(ctx, x, top, cw, h, 22); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 22, y: 10, alpha: 0.1 });
    rr(ctx, x + 0.5, top + 0.5, cw - 1, h - 1, 22); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    text(ctx, s.k, x + 22, top + 20, { kind: 'mono', size: 13, color: C.grey, ls: 3 });
    const col = s.tone === 'good' ? OUT.win.deep : s.tone === 'bad' ? OUT.loss.deep : C.ink;
    const vs = shrink(ctx, String(s.v), cw - 44, { size: 34, weight: 800, ls: -1 });
    text(ctx, String(s.v), x + 22, top + 44, { size: vs, weight: 800, color: col, ls: -vs * 0.03 });
  });
}

/* --------------------------------- footer -------------------------------- */
function footer(ctx, H, W = 1600, PAD = 56, left = 'NQ · ES · YM — NEW YORK') {
  const base = H - 40;
  ctx.fillStyle = `rgba(${C.grid},.08)`; ctx.fillRect(PAD, base - 44, W - PAD * 2, 1);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  font(ctx, 'mono', 15); setLS(ctx, 5); ctx.fillStyle = C.grey;
  ctx.fillText(left, PAD, base); setLS(ctx, 0);
  const wT = measure(ctx, 'trades', 'serif', 34, 400, 0, true);
  font(ctx, 'serif', 34, 400, true); ctx.fillStyle = C.grey; ctx.fillText('trades', W - PAD - wT, base + 2);
  const wY = measure(ctx, 'YSER', 'inter', 28, 800, -1);
  font(ctx, 'inter', 28, 800); setLS(ctx, -1); ctx.fillStyle = C.ink; ctx.fillText('YSER', W - PAD - wT - 10 - wY, base); setLS(ctx, 0);
}

/* ------------------------------- WEEKLY ------------------------------- */
const WK = { cardsTop: 262, cardH: 300, gap: 20, chartTop: 616, chartH: 176, statsTop: 822, H: 1060 };

function renderWeekly(week) {
  ensureFonts();
  const sym = week.symbol || '$';
  const canvas = createCanvas(W * SCALE, WK.H * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  floor(ctx, WK.H);
  const empty = !week.days.some((d) => d.trades > 0) && !(week.weekend && week.weekend.trades);
  header(ctx, {
    kicker: 'Journal · Weekly PnL', lead: week.weekNo ? `Week ${week.weekNo}` : 'This week',
    total: week.total, label: `WEEK TOTAL · ${week.rangeLabel}`, chip: week.weekend ? week.weekend.pnl : null, symbol: sym, empty,
  });

  const cw = (INNER_W - 4 * WK.gap) / 5;
  const traded = week.days.filter((d) => d.trades > 0);
  const best = traded.length > 1 ? traded.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const maxAbs = Math.max(1, ...week.days.map((d) => Math.abs(d.pnl)));
  week.days.forEach((d, i) => {
    const o = outcomeOf(d), c = OUT[o];
    // the cards float at slightly different heights, like the landing page's
    const x = PAD + i * (cw + WK.gap), y = WK.cardsTop + [0, 10, -4, 8, 2][i];
    glassCard(ctx, x, y, cw, WK.cardH, 28, o, { faint: o === 'none' });
    const ix = x + 24, iw = cw - 48;
    text(ctx, d.day, ix, y + 26, { kind: 'mono', size: 17, color: o === 'none' ? 'rgba(255,255,255,.35)' : c.hex, ls: 5 });
    text(ctx, d.date, x + cw - 24, y + 27, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.4)', align: 'right' });
    if (best && d === best && best.pnl > 0) {
      const bw = measure(ctx, 'BEST', 'inter', 11, 600, 2) + 22;
      rr(ctx, x + cw / 2 - bw / 2, y - 13, bw, 26, 13); ctx.fillStyle = '#ffffff'; ctx.fill();
      text(ctx, 'BEST', x + cw / 2, y - 5, { size: 11, weight: 600, color: '#15171c', align: 'center', ls: 2 });
    }
    const val = o === 'none' ? '—' : formatDollars(d.pnl, { symbol: sym });
    const vs = shrink(ctx, val, iw, { size: 54, weight: 800, ls: -1.6 });
    text(ctx, val, ix, y + 92 + (54 - vs) / 2, { size: vs, weight: 800, color: o === 'none' ? 'rgba(255,255,255,.22)' : '#ffffff', ls: -vs * 0.03 });
    // a bar showing the day's size against the week's biggest day
    const bw = iw * (o === 'none' ? 0 : Math.max(0.05, Math.abs(d.pnl) / maxAbs));
    rr(ctx, ix, y + 168, iw, 6, 3); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
    if (bw) { rr(ctx, ix, y + 168, bw, 6, 3); ctx.fillStyle = c.hex; ctx.fill(); }
    outcomePill(ctx, o, ix, y + 198);
    const tally = o === 'none' ? (d.missed ? `${d.missed} missed` : 'no trades') : `${d.w}W · ${d.l}L${d.be ? ` · ${d.be}BE` : ''}${d.missed ? ` · ${d.missed}M` : ''}`;
    text(ctx, tally, ix, y + 250, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.5)', ls: 1 });
  });

  if (traded.length) {
    let run = 0;
    const pts = week.days.map((d, i) => { run += d.pnl; return { x: PAD + i * (cw + WK.gap) + cw / 2, v: run }; });
    curve(ctx, WK.chartTop, WK.chartH, pts, { labelAll: true, caption: 'CUMULATIVE PNL', symbol: sym });
  } else {
    text(ctx, 'CUMULATIVE PNL', PAD, WK.chartTop, { kind: 'mono', size: 14, color: C.grey, ls: 4 });
    text(ctx, 'No trades logged this week', PAD, WK.chartTop + 70, { kind: 'serif', size: 40, italic: true, color: C.grey });
  }
  stats(ctx, WK.statsTop, week.stats || []);
  footer(ctx, WK.H);
  return canvas.toBuffer('image/png');
}

/* ------------------------------- MONTHLY ------------------------------- */
function renderMonthly(month) {
  ensureFonts();
  const sym = month.symbol || '$';
  const first = DateTime.fromObject({ year: month.year, month: month.month, day: 1 });
  const cal = []; // Monday-first weeks
  let cur = first.startOf('week');
  const last = first.endOf('month');
  while (cur <= last) { cal.push(Array.from({ length: 7 }, (_, i) => cur.plus({ days: i }))); cur = cur.plus({ weeks: 1 }); }
  const rows = cal.length, CELL_H = 118, GAP = 12;
  const labelsTop = 262, gridTop = 300, gridH = rows * CELL_H + (rows - 1) * GAP;
  const chartTop = gridTop + gridH + 44, chartH = 170, statsTop = chartTop + chartH + 26;
  const H = statsTop + 92 + 120;
  const canvas = createCanvas(W * SCALE, H * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  floor(ctx, H);
  const data = month.data || {};
  const empty = !Object.values(data).some((d) => d.trades > 0);
  const monthName = first.setLocale('en').toFormat('LLLL');
  header(ctx, { kicker: 'Journal · Monthly PnL', lead: monthName, total: month.total, label: `MONTH TOTAL · ${month.monthLabel}`, chip: null, symbol: sym, empty });

  const unit = (INNER_W - 7 * GAP) / 8.25, colW = [...Array(7).fill(unit), unit * 1.25];
  const colX = []; { let x = PAD; colW.forEach((w) => { colX.push(x); x += w + GAP; }); }
  ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'WEEK'].forEach((n, i) => {
    text(ctx, n, colX[i] + colW[i] / 2 + 2, labelsTop, { kind: 'mono', size: 14, color: i === 7 ? C.ink : i > 4 ? 'rgba(139,139,146,.6)' : C.grey, align: 'center', ls: 4 });
  });

  const traded = Object.keys(data).map(Number).filter((k) => data[k].trades > 0);
  const best = traded.length > 1 ? traded.reduce((a, b) => (data[b].pnl > data[a].pnl ? b : a)) : null;
  let wkNo = 0;
  cal.forEach((week, r) => {
    const y = gridTop + r * (CELL_H + GAP); let wp = 0, wd = 0;
    week.forEach((dt, i) => {
      const x = colX[i], w = colW[i], inMonth = dt.month === month.month;
      const d = inMonth ? data[dt.day] : null, o = d ? outcomeOf(d) : 'none', weekend = i > 4;
      if (!inMonth) { // outside the month: a dashed outline on the floor
        ctx.save(); ctx.setLineDash([5, 7]); ctx.strokeStyle = `rgba(${C.grid},.12)`; ctx.lineWidth = 1.2; rr(ctx, x + 1, y + 1, w - 2, CELL_H - 2, 18); ctx.stroke(); ctx.restore();
        text(ctx, String(dt.day), x + 16, y + 14, { kind: 'mono', size: 15, color: 'rgba(139,139,146,.45)' });
        return;
      }
      if (d && d.trades) { wp += d.pnl; wd += 1; }
      if (o === 'none') { // an untraded day: a white card resting on the floor (weekends hatched)
        rr(ctx, x, y, w, CELL_H, 18); ctx.fillStyle = weekend ? C.paperDim : C.paper; ctx.fill();
        if (weekend) {
          ctx.save(); rr(ctx, x, y, w, CELL_H, 18); ctx.clip(); ctx.strokeStyle = `rgba(${C.grid},.05)`; ctx.lineWidth = 6;
          for (let k = -CELL_H; k < w + CELL_H; k += 18) { ctx.beginPath(); ctx.moveTo(x + k, y + CELL_H); ctx.lineTo(x + k + CELL_H, y); ctx.stroke(); }
          ctx.restore();
        }
        rr(ctx, x + 0.5, y + 0.5, w - 1, CELL_H - 1, 18); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
        text(ctx, String(dt.day), x + 16, y + 14, { kind: 'mono', size: 15, color: weekend ? 'rgba(139,139,146,.6)' : C.grey });
        if (!weekend) text(ctx, d && d.missed ? `${d.missed} missed` : '—', x + w / 2, y + CELL_H - 40, { kind: 'mono', size: 15, color: 'rgba(139,139,146,.7)', align: 'center' });
        return;
      }
      // a traded day: a dark glass card lifted off the floor
      const c = OUT[o];
      glassCard(ctx, x, y, w, CELL_H, 18, o, { lift: true });
      text(ctx, String(dt.day), x + 16, y + 14, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.5)' });
      ctx.fillStyle = c.hex; ctx.beginPath(); ctx.arc(x + w - 20, y + 22, 4.5, 0, Math.PI * 2); ctx.fill();
      if (best !== null && dt.day === best && data[best].pnl > 0) star(ctx, x + w - 42, y + 22, 8, '#ffffff');
      const label = o === 'be' ? 'BE' : formatDollars(d.pnl, { symbol: sym });
      const sz = shrink(ctx, label, w - 24, { size: 28, weight: 800, ls: -0.8 });
      text(ctx, label, x + w / 2, y + CELL_H - 22 - sz, { size: sz, weight: 800, color: c.hex, align: 'center', ls: -sz * 0.03 });
    });
    // the week's total: an ink capsule
    wkNo += 1;
    const wo = wd ? toneOf(wp) : 'none', wc = OUT[wo], x = colX[7], w = colW[7];
    shadowed(ctx, () => { rr(ctx, x, y, w, CELL_H, 30); ctx.fillStyle = C.capsule; ctx.fill(); }, { blur: 26, y: 14, alpha: 0.22 });
    ctx.save(); rr(ctx, x, y, w, CELL_H, 30); ctx.clip(); ctx.fillStyle = wo === 'none' ? 'rgba(255,255,255,.08)' : wc.hex; ctx.fillRect(x, y + CELL_H - 4, w, 4); ctx.restore();
    const cx = x + w / 2;
    text(ctx, `WEEK ${wkNo}`, cx + 2, y + 18, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.5)', align: 'center', ls: 4 });
    const wl = wd ? formatDollars(wp, { symbol: sym }) : '—';
    const ws = shrink(ctx, wl, w - 32, { size: 32, weight: 800, ls: -0.8 });
    text(ctx, wl, cx, y + 44 + (32 - ws) / 2, { size: ws, weight: 800, color: wo === 'none' ? 'rgba(255,255,255,.3)' : wc.hex, align: 'center', ls: -ws * 0.03 });
    text(ctx, `${wd} trading day${wd === 1 ? '' : 's'}`, cx, y + 86, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.42)', align: 'center', ls: 0.6 });
  });

  // equity curve: one point per day that has trades
  const sorted = traded.slice().sort((a, b) => a - b);
  let run = 0;
  const vals = sorted.map((k) => (run += data[k].pnl));
  if (vals.length) {
    // starts from $0 at the left, so even a single trading day reads as a line
    const n = vals.length, pts = [{ x: PAD, v: 0, ghost: true }, ...vals.map((v, i) => ({ x: PAD + ((i + 1) * INNER_W) / n, v }))];
    curve(ctx, chartTop, chartH, pts, { labelAll: false, caption: `EQUITY CURVE · ${month.monthShort}`, symbol: sym });
  } else {
    text(ctx, `EQUITY CURVE · ${month.monthShort}`, PAD, chartTop, { kind: 'mono', size: 14, color: C.grey, ls: 4 });
    text(ctx, 'No trades logged this month', PAD, chartTop + 80, { kind: 'serif', size: 40, italic: true, color: C.grey });
  }
  stats(ctx, statsTop, month.stats || []);
  footer(ctx, H);
  return canvas.toBuffer('image/png');
}

/* ------------------------------- DAILY (4:5) ------------------------------- */
/**
 * One day on a 1080x1350 card (4:5, the feed size), kept quiet: the weekday
 * headline with its italic turn, the day's PnL large, then one dark glass
 * card holding a single smooth running-PnL curve (each trade a bead on it,
 * the close lit), a row of beads naming the day's outcomes, and three white
 * tiles: best trade, win rate, the week so far. The trade by trade detail
 * lives in /trades.
 */
const DW = 1080, DH = 1350, DPAD = 64, DINNER = DW - DPAD * 2;

/** a smooth path through points (monotone-ish cubic, no overshoot past neighbours) */
function smoothPath(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i], mx = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(mx, p0.y, mx, p1.y, p1.x, p1.y);
  }
}

const symOf = (t) => (t.instrument ? String(t.instrument).toUpperCase().slice(0, 8) : null);
/** the day's trades grouped by symbol, in the order each symbol was first traded; hand-typed trades with no symbol go last as OTHER */
function symbolBook(trades) {
  const m = new Map();
  for (const t of trades) {
    const s = symOf(t) || 'OTHER';
    if (!m.has(s)) m.set(s, { symbol: s, trades: [], net: 0 });
    const g = m.get(s); g.trades.push(t); if (t.outcome !== 'missed') g.net += t.pnl;
  }
  const out = [...m.values()];
  return [...out.filter((g) => g.symbol !== 'OTHER'), ...out.filter((g) => g.symbol === 'OTHER')];
}

function renderDaily(day, asCanvas = false) {
  ensureFonts();
  const sym = day.symbol || '$';
  const canvas = createCanvas(DW * SCALE, DH * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  floor(ctx, DH, DW);
  const trades = day.trades || [];
  const counted = trades.filter((t) => t.outcome !== 'missed');
  const empty = counted.length === 0;
  const tone = empty ? 'none' : toneOf(day.total), t = OUT[tone];

  // pill and date
  const kicker = 'Journal · Daily PnL', kw = measure(ctx, kicker, 'inter', 17, 600, 0.2), pw = 12 + 26 + 12 + kw + 22;
  shadowed(ctx, () => { rr(ctx, DPAD, 56, pw, 46, 23); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 18, y: 8, alpha: 0.12 });
  rr(ctx, DPAD + 0.5, 56.5, pw - 1, 45, 23); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, DPAD + 10, 66, 26, 26, 8); ctx.fillStyle = C.tile; ctx.fill();
  ctx.fillStyle = t.hex; ctx.beginPath(); ctx.arc(DPAD + 23, 79, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(${t.rgb},.35)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(DPAD + 23, 79, 8, 0, Math.PI * 2); ctx.stroke();
  text(ctx, kicker, DPAD + 50, 71, { size: 17, weight: 600, color: C.ink2, ls: 0.2 });
  text(ctx, day.dateLabel || '', DW - DPAD, 72, { kind: 'mono', size: 15, color: C.grey, align: 'right', ls: 4 });

  // "Thursday, a green day."
  const turn = empty ? (trades.length ? 'only missed.' : 'a quiet day.') : day.total > 0 ? 'a green day.' : day.total < 0 ? 'a red day.' : 'dead flat.';
  const lead = `${day.weekday || 'Today'},`;
  const hs = shrink(ctx, lead, DINNER * 0.55, { size: 70, weight: 800, ls: -3 });
  const lw = text(ctx, lead, DPAD, 150, { size: hs, weight: 800, ls: -hs * 0.045 });
  const ts = Math.min(hs * 1.08, 78);
  text(ctx, turn, DPAD + lw + 16, 150 + hs * 0.08, { kind: 'serif', size: ts, italic: true, color: C.grey, ls: -0.5 });
  ctx.fillStyle = empty ? `rgba(${OUT.none.rgb},.35)` : `rgba(${t.rgb},.55)`;
  rr(ctx, DPAD + lw + 20, 150 + hs + 12, Math.min(measure(ctx, turn, 'serif', ts, 400, -0.5, true) - 8, 200), 4, 2); ctx.fill();

  // the PnL, large, with one quiet line under it
  const val = formatDollars(day.total || 0, { symbol: sym });
  const vs = shrink(ctx, val, DINNER, { size: 176, weight: 800, ls: -7 });
  text(ctx, val, DPAD - 5, 268, { size: vs, weight: 800, color: empty ? C.grey : t.deep, ls: -vs * 0.045 });
  const parts = [];
  if (day.count) parts.push(`${day.count} TRADE${day.count === 1 ? '' : 'S'}`);
  if (day.rSum != null) parts.push(`${day.rSum > 0 ? '+' : ''}${Number(day.rSum.toFixed(2))}R`);
  if (day.missed) parts.push(`${day.missed} MISSED`);
  text(ctx, parts.join('   ·   ') || 'NOTHING LOGGED', DPAD, 268 + vs + 26, { kind: 'mono', size: 16, color: C.soft, ls: 3 });

  // the curve card: one smooth line, nothing else competing with it
  const cx = DPAD, cy = 560, cw = DINNER, ch = 440;
  glassCard(ctx, cx, cy, cw, ch, 34, tone, { faint: empty });
  text(ctx, 'THE DAY', cx + 34, cy + 32, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.45)', ls: 4 });
  if (!counted.length) {
    text(ctx, trades.length ? 'Nothing taken' : 'No trades', cx + cw / 2, cy + ch / 2 - 40, { kind: 'serif', size: 56, italic: true, color: 'rgba(255,255,255,.55)', align: 'center' });
    text(ctx, trades.length ? `${trades.length} missed, logged for the review` : 'flat book, clear head', cx + cw / 2, cy + ch / 2 + 32, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.32)', align: 'center', ls: 2 });
  } else {
    const gx0 = cx + 48, gx1 = cx + cw - 48, gy0 = cy + 96, gy1 = cy + ch - 132;
    let run = 0; const vals = [0, ...counted.map((x) => (run += x.pnl))];
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), rng = hi - lo || 1;
    const P = vals.map((v, i) => ({ x: gx0 + (i * (gx1 - gx0)) / Math.max(1, vals.length - 1), y: gy1 - ((v - lo) / rng) * (gy1 - gy0) }));
    const zy = gy1 - ((0 - lo) / rng) * (gy1 - gy0);
    ctx.save(); ctx.setLineDash([3, 9]); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(gx0, zy); ctx.lineTo(gx1, zy); ctx.stroke(); ctx.restore();
    text(ctx, `${sym}0`, gx0 - 6, zy - 22, { kind: 'mono', size: 11, color: 'rgba(255,255,255,.28)' });
    // soft area down to zero, then the glowing line
    ctx.save(); ctx.beginPath(); smoothPath(ctx, P); ctx.lineTo(P[P.length - 1].x, zy); ctx.lineTo(P[0].x, zy); ctx.closePath(); ctx.clip();
    const ag = ctx.createLinearGradient(0, gy0, 0, gy1); ag.addColorStop(0, `rgba(${t.rgb},.30)`); ag.addColorStop(1, `rgba(${t.rgb},0)`);
    ctx.fillStyle = ag; ctx.fillRect(gx0, gy0 - 20, gx1 - gx0, gy1 - gy0 + 40); ctx.restore();
    ctx.save(); ctx.shadowColor = `rgba(${t.rgb},.9)`; ctx.shadowBlur = 14 * SCALE; ctx.strokeStyle = t.hex; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); smoothPath(ctx, P); ctx.stroke(); ctx.restore();
    // each trade a small bead on the line; the close lit with a halo and its value
    for (let i = 1; i < P.length - 1; i++) {
      ctx.fillStyle = C.card; ctx.beginPath(); ctx.arc(P[i].x, P[i].y, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = OUT[toneOf(counted[i - 1].pnl)].hex; ctx.lineWidth = 2.5; ctx.stroke();
    }
    const end = P[P.length - 1];
    const pillAbove = !(end.y - 50 < gy0 - 30);
    const lbl = formatDollars(vals[vals.length - 1], { symbol: sym }), lwid = measure(ctx, lbl, 'mono', 15) + 24;
    const ly = pillAbove ? end.y - 50 : end.y + 18;
    const underPill = (x, y) => x + 22 > end.x - lwid + 12 && x - 22 < end.x + 12 && y + 16 > ly && y < ly + 30;
    // the symbol traded at each bead, written on the line like a chart annotation: above a step up, below a step down.
    // Dense days only name the bead where the symbol changes; very dense days leave the line clean.
    const step = (gx1 - gx0) / Math.max(1, P.length - 1);
    if (step >= 18) {
      counted.forEach((tr, i) => {
        const s = symOf(tr); if (!s) return;
        if (step < 44 && i > 0 && symOf(counted[i - 1]) === s) return;
        const p = P[i + 1], last = i === counted.length - 1;
        const up = last ? !pillAbove : tr.pnl >= 0;
        const y = Math.min(Math.max(up ? p.y - 30 : p.y + 14, cy + 58), gy1 + 14);
        const lx = Math.min(Math.max(p.x, gx0 + 10), gx1 - 10);
        if (!last && underPill(lx, y)) return;
        text(ctx, s, lx, y, { kind: 'mono', size: 11, weight: 600, color: 'rgba(255,255,255,.5)', align: 'center', ls: 1.5 });
      });
    }
    const halo = ctx.createRadialGradient(end.x, end.y, 0, end.x, end.y, 34); halo.addColorStop(0, `rgba(${t.rgb},.45)`); halo.addColorStop(1, `rgba(${t.rgb},0)`);
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(end.x, end.y, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(end.x, end.y, 8, 0, Math.PI * 2); ctx.fill();
    rr(ctx, end.x - lwid + 12, ly, lwid, 30, 15); ctx.fillStyle = '#ffffff'; ctx.fill();
    text(ctx, lbl, end.x - lwid + 24, ly + 8, { kind: 'mono', size: 15, color: '#15171c' });   // a white pill in both themes
    // the book: one glass chip per symbol, holding that symbol's outcome beads in order and its net
    const by = cy + ch - 64;
    text(ctx, 'BOOK', cx + 34, by - 7, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.35)', ls: 3 });
    const tally = `${day.w}W · ${day.l}L${day.be ? ` · ${day.be}BE` : ''}`;
    const tallyW = measure(ctx, tally, 'mono', 14, 400, 1);
    const book = symbolBook(trades);
    const netOf = (g) => (g.trades.some((t) => t.outcome !== 'missed') ? formatDollars(g.net, { symbol: sym }) : 'missed');
    const chipW = (g) => 16 + measure(ctx, g.symbol, 'inter', 16, 800, 0.4) + 12 + Math.min(g.trades.length, 8) * 14 + 8 + measure(ctx, netOf(g), 'mono', 14) + 16;
    const x0 = cx + 112, xMax = cx + cw - 34 - tallyW - 24;
    let x = x0, shown = 0;
    for (const g of book) {
      const w = chipW(g), more = book.length - shown - 1;
      if (x + w > xMax - (more ? 52 : 0)) break;
      const counts = g.trades.some((t) => t.outcome !== 'missed'), gt = counts ? OUT[toneOf(g.net)] : OUT.none;
      rr(ctx, x, by - 19, w, 38, 19); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
      rr(ctx, x + 0.5, by - 18.5, w - 1, 37, 18.5); ctx.strokeStyle = `rgba(${gt.rgb},.45)`; ctx.lineWidth = 1; ctx.stroke();
      let px = x + 16 + text(ctx, g.symbol, x + 16, by - 11, { size: 16, weight: 800, color: '#ffffff', ls: 0.4 }) + 12;
      for (const tr of g.trades.slice(0, 8)) {
        if (tr.outcome === 'missed') { ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(px + 5, by, 4.2, 0, Math.PI * 2); ctx.stroke(); }
        else { ctx.fillStyle = OUT[toneOf(tr.pnl)].hex; ctx.beginPath(); ctx.arc(px + 5, by, 5, 0, Math.PI * 2); ctx.fill(); }
        px += 14;
      }
      text(ctx, netOf(g), px + 8, by - 9, { kind: 'mono', size: 14, color: counts ? gt.hex : 'rgba(255,255,255,.4)' });
      x += w + 10; shown += 1;
    }
    if (shown < book.length) text(ctx, `+${book.length - shown}`, x + 2, by - 9, { kind: 'mono', size: 14, color: 'rgba(255,255,255,.45)' });
    text(ctx, tally, cx + cw - 34, by - 8, { kind: 'mono', size: 14, color: 'rgba(255,255,255,.55)', align: 'right', ls: 1 });
  }

  // three tiles, then the sign-off
  const best = day.best && counted.length ? day.best : null;
  const tiles = [
    { k: 'BEST TRADE', v: best ? formatDollars(best.pnl, { symbol: sym }) : '—', sub: best ? [best.instrument, best.direction].filter(Boolean).join(' · ').toUpperCase() || null : null, tone: best && best.pnl > 0 ? 'good' : best && best.pnl < 0 ? 'bad' : null },
    { k: 'WIN RATE', v: day.winRate == null ? '—' : `${day.winRate}%`, sub: day.count ? `${day.w} OF ${day.count}` : null },
    { k: 'WEEK SO FAR', v: day.weekTotal == null ? '—' : formatDollars(day.weekTotal, { symbol: sym }), sub: (day.week || []).filter((d) => d.trades).length ? `${(day.week || []).filter((d) => d.trades).length} DAY${(day.week || []).filter((d) => d.trades).length === 1 ? '' : 'S'} TRADED` : null, tone: day.weekTotal > 0 ? 'good' : day.weekTotal < 0 ? 'bad' : null },
  ];
  const gap = 16, tw = (DINNER - gap * 2) / 3, ty = 1036, th = 132;
  tiles.forEach((s, i) => {
    const x = DPAD + i * (tw + gap);
    shadowed(ctx, () => { rr(ctx, x, ty, tw, th, 26); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 24, y: 12, alpha: 0.1 });
    rr(ctx, x + 0.5, ty + 0.5, tw - 1, th - 1, 26); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    text(ctx, s.k, x + 24, ty + 24, { kind: 'mono', size: 12, color: C.grey, ls: 2.8 });
    const col = s.tone === 'good' ? OUT.win.deep : s.tone === 'bad' ? OUT.loss.deep : C.ink;
    const sz = shrink(ctx, s.v, tw - 48, { size: 38, weight: 800, ls: -1.2 });
    text(ctx, s.v, x + 24, ty + 50, { size: sz, weight: 800, color: col, ls: -sz * 0.03 });
    if (s.sub) text(ctx, s.sub, x + 24, ty + 102, { kind: 'mono', size: 12, color: C.soft, ls: 1.6 });
  });

  // the sign-off names what was actually traded today
  const traded = symbolBook(trades).map((g) => g.symbol).filter((s) => s !== 'OTHER').slice(0, 4);
  footer(ctx, DH, DW, DPAD, traded.length ? `${traded.join(' · ')} — NEW YORK` : undefined);
  return asCanvas ? canvas : canvas.toBuffer('image/png');
}

/* ------------------------------- TRADES (the ledger) ------------------------------- */
/**
 * Every trade in a period as a ledger, not a calendar: the headline and net,
 * a strip of stats, a "won vs lost" tug-of-war bar with the symbols traded,
 * then a dark glass ledger: one row per trade with a stripe in its outcome
 * colour, time, symbol and side, size, entry -> exit, hold time, R, and a
 * PnL bar growing left or right from the centre line. Week and month group
 * rows under day headers with the day's subtotal. Long periods page.
 */
const TR_PER_PAGE = 14;
const priceFmt = (v) => {
  const n = Number(String(v).replace(/,/g, ''));
  return v == null || v === '' ? null : Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v).slice(0, 10);
};

/** a drawn ∞ (lemniscate of Bernoulli) filling w×h from its top-left, in the weight of the bold numerals beside it */
function infinitySign(ctx, x, y, w, h, color) {
  const cx = x + w / 2, cy = y + h / 2, a = w / 2 - 3;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 5.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * Math.PI * 2, d = 1 + Math.sin(t) ** 2;
    const px = cx + (a * Math.cos(t)) / d, py = cy + ((a * Math.sin(t) * Math.cos(t)) / d) * (h / a) * 1.15;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.stroke(); ctx.restore();
}

function tradePages(data) {
  const n = (data.trades || []).length;
  return Math.max(1, Math.ceil(n / TR_PER_PAGE));
}

function renderTrades(data, page = 0) {
  ensureFonts();
  const sym = data.symbol || '$', trades = data.trades || [];
  const pages = tradePages(data), pg = Math.min(Math.max(0, page | 0), pages - 1);
  const slice = trades.slice(pg * TR_PER_PAGE, (pg + 1) * TR_PER_PAGE);
  const grouped = data.range !== 'day';
  // build the ledger's lines first so the image can be exactly as tall as it needs
  const lines = [];
  let lastDay = null;
  for (const t of slice) {
    if (grouped && t.date !== lastDay) {
      const day = trades.filter((x) => x.date === t.date && x.outcome !== 'missed');
      lines.push({ type: 'day', date: t.date, n: day.length, pnl: day.reduce((s, x) => s + x.pnl, 0) });
      lastDay = t.date;
    }
    lines.push({ type: 'trade', t, idx: trades.indexOf(t) + 1 });
  }
  const ROW = 64, DAYROW = 46, cardTop = 438;
  const ledgerH = trades.length ? 96 + lines.reduce((s, l) => s + (l.type === 'day' ? DAYROW : ROW), 0) + (pages > 1 ? 54 : 22) : 300;
  const H = cardTop + ledgerH + 150;
  const canvas = createCanvas(W * SCALE, H * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  floor(ctx, H);
  const empty = !data.count;
  const tone = empty ? 'none' : toneOf(data.net), t = OUT[tone];

  // pill, period label
  const kicker = 'Journal · Trades', kw = measure(ctx, kicker, 'inter', 17, 600, 0.2), pw = 12 + 26 + 12 + kw + 22;
  shadowed(ctx, () => { rr(ctx, PAD, 46, pw, 46, 23); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 18, y: 8, alpha: 0.12 });
  rr(ctx, PAD + 0.5, 46.5, pw - 1, 45, 23); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, PAD + 10, 56, 26, 26, 8); ctx.fillStyle = C.tile; ctx.fill();
  // a tiny ledger glyph in the tile: three lines
  ctx.strokeStyle = t.hex; ctx.lineWidth = 2; ctx.lineCap = 'round';
  [[63, 12], [69, 8], [75, 10]].forEach(([y, w]) => { ctx.beginPath(); ctx.moveTo(PAD + 17, y); ctx.lineTo(PAD + 17 + w, y); ctx.stroke(); });
  text(ctx, kicker, PAD + 50, 61, { size: 17, weight: 600, color: C.ink2, ls: 0.2 });
  text(ctx, data.label || '', W - PAD, 56, { kind: 'mono', size: 15, color: C.grey, align: 'right', ls: 4 });

  // "This week, 12 trades."
  const lead = `${data.lead || 'Trades'},`;
  const turn = empty ? (data.missed ? `${data.missed} missed, none taken.` : 'nothing logged yet.') : `${data.count} trade${data.count === 1 ? '' : 's'}.`;
  const hs = 74, lw = text(ctx, lead, PAD, 122, { size: hs, weight: 800, ls: -hs * 0.045 });
  text(ctx, turn, PAD + lw + 18, 122 + hs * 0.08, { kind: 'serif', size: hs * 1.08, italic: true, color: C.grey, ls: -0.5 });
  ctx.fillStyle = empty ? `rgba(${OUT.none.rgb},.35)` : `rgba(${t.rgb},.55)`;
  rr(ctx, PAD + lw + 22, 122 + hs + 12, Math.min(measure(ctx, turn, 'serif', hs * 1.08, 400, -0.5, true) - 8, 240), 4, 2); ctx.fill();
  text(ctx, 'NET', W - PAD, 92, { kind: 'mono', size: 14, color: C.grey, align: 'right', ls: 4 });
  const val = formatDollars(data.net || 0, { symbol: sym });
  const vs = shrink(ctx, val, 520, { size: 96, weight: 800, ls: -4 });
  text(ctx, val, W - PAD, 116, { size: vs, weight: 800, color: empty ? C.grey : t.deep, ls: -vs * 0.04, align: 'right' });

  // stat chips
  const pf = data.profitFactor;
  const chips = [
    { k: 'WIN RATE', v: data.winRate == null ? '—' : `${data.winRate}%`, sub: data.count ? `${data.w}W · ${data.l}L${data.be ? ` · ${data.be}BE` : ''}` : null },
    // no losses: the fonts have no ∞ glyph, so the sign is drawn, with a word on what it means
    pf === Infinity
      ? { k: 'PROFIT FACTOR', v: '', infinity: true, sub: 'NO LOSSES YET', tone: 'good' }
      : { k: 'PROFIT FACTOR', v: pf == null ? '—' : pf.toFixed(2), tone: pf == null ? null : pf >= 1 ? 'good' : 'bad', sub: pf != null ? `${sym}${pf.toFixed(2)} PER ${sym}1 LOST` : null },
    { k: 'AVG WIN', v: data.avgWin == null ? '—' : formatDollars(data.avgWin, { symbol: sym }), tone: data.avgWin ? 'good' : null },
    { k: 'AVG LOSS', v: data.avgLoss == null ? '—' : formatDollars(data.avgLoss, { symbol: sym }), tone: data.avgLoss ? 'bad' : null },
    { k: 'BEST STREAK', v: data.streak ? `${data.streak} win${data.streak === 1 ? '' : 's'}` : '—' },
    { k: 'LONG · SHORT', v: `${data.longs?.n || 0} · ${data.shorts?.n || 0}`, sub: data.rSum != null ? `${data.rSum > 0 ? '+' : ''}${Number(data.rSum.toFixed(2))}R total` : null },
  ];
  const gap = 14, chw = (INNER_W - gap * 5) / 6, chy = 244;
  chips.forEach((s, i) => {
    const x = PAD + i * (chw + gap);
    shadowed(ctx, () => { rr(ctx, x, chy, chw, 96, 22); ctx.fillStyle = C.paper; ctx.fill(); }, { blur: 22, y: 10, alpha: 0.1 });
    rr(ctx, x + 0.5, chy + 0.5, chw - 1, 95, 22); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    text(ctx, s.k, x + 20, chy + 18, { kind: 'mono', size: 12, color: C.grey, ls: 2.6 });
    const col = s.tone === 'good' ? OUT.win.deep : s.tone === 'bad' ? OUT.loss.deep : C.ink;
    if (s.infinity) infinitySign(ctx, x + 20, chy + 42, 56, 26, col);
    else {
      const sz = shrink(ctx, s.v, chw - 40, { size: 30, weight: 800, ls: -1 });
      text(ctx, s.v, x + 20, chy + 40, { size: sz, weight: 800, color: col, ls: -sz * 0.03 });
    }
    if (s.sub) text(ctx, s.sub, x + 20, chy + 76, { kind: 'mono', size: 12, color: C.soft });
  });

  // won vs lost: a tug-of-war bar, and the symbols traded
  const by = 366, bx = PAD, bw = INNER_W * 0.56;
  const won = Math.max(0, data.grossWin || 0), lost = Math.abs(data.grossLoss || 0), tot = won + lost;
  text(ctx, `WON ${formatDollars(won, { symbol: sym, sign: false })}`, bx, by - 2, { kind: 'mono', size: 13, color: OUT.win.deep, ls: 2 });
  text(ctx, `LOST ${formatDollars(lost, { symbol: sym, sign: false })}`, bx + bw, by - 2, { kind: 'mono', size: 13, color: OUT.loss.deep, align: 'right', ls: 2 });
  rr(ctx, bx, by + 20, bw, 12, 6); ctx.fillStyle = `rgba(${C.grid},.08)`; ctx.fill();
  if (tot > 0) {
    const split = bw * (won / tot);
    ctx.save(); rr(ctx, bx, by + 20, bw, 12, 6); ctx.clip();
    ctx.fillStyle = OUT.win.hex; ctx.fillRect(bx, by + 20, split, 12);
    ctx.fillStyle = OUT.loss.hex; ctx.fillRect(bx + split, by + 20, bw - split, 12);
    ctx.restore();
    // the knob sits on the split
    shadowed(ctx, () => { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(bx + split, by + 26, 11, 0, Math.PI * 2); ctx.fill(); }, { blur: 10, y: 4, alpha: 0.2 });
    ctx.fillStyle = '#15171c'; ctx.beginPath(); ctx.arc(bx + split, by + 26, 4.5, 0, Math.PI * 2); ctx.fill();
  }
  let sx = W - PAD;
  for (const s of [...(data.symbols || [])].reverse()) {
    const lbl = `${s.symbol} ×${s.n}`, pv = formatDollars(s.pnl, { symbol: sym });
    const w1 = measure(ctx, lbl, 'inter', 15, 700, 0.2), w2 = measure(ctx, pv, 'mono', 13), cw = 18 + w1 + 10 + w2 + 18;
    sx -= cw;
    rr(ctx, sx, by + 4, cw, 40, 20); ctx.fillStyle = C.capsule; ctx.fill();
    text(ctx, lbl, sx + 18, by + 16, { size: 15, weight: 700, color: '#ffffff', ls: 0.2 });
    text(ctx, pv, sx + 18 + w1 + 10, by + 17.5, { kind: 'mono', size: 13, color: OUT[toneOf(s.pnl)].hex });
    sx -= 10;
  }

  // the ledger
  const lx = PAD, lwid = INNER_W, ly = cardTop;
  glassCard(ctx, lx, ly, lwid, ledgerH, 30, tone, { faint: empty });
  if (!trades.length) {
    text(ctx, 'No trades logged', lx + lwid / 2, ly + ledgerH / 2 - 30, { kind: 'serif', size: 52, italic: true, color: 'rgba(255,255,255,.55)', align: 'center' });
    text(ctx, 'log one with /journal, or upload a CSV from the journal panel', lx + lwid / 2, ly + ledgerH / 2 + 36, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.32)', align: 'center', ls: 1 });
  } else {
    // column heads, and the period's running PnL as a sparkline on the right
    // columns with nothing to say on this page (no times, sizes, hold times or R logged) step aside, and the rest share the room
    const has = {
      time: slice.some((x) => x.time), size: slice.some((x) => x.qty), px: slice.some((x) => x.entry),
      held: slice.some((x) => x.held), r: slice.some((x) => typeof x.r === 'number' && !Number.isNaN(x.r)),
    };
    const WIDTHS = [['time', 98], ['sym', 290], ['size', 90], ['px', 340], ['held', 110], ['r', 160]].filter(([k]) => k === 'sym' || has[k]);
    const room = 1170 - 82, used = WIDTHS.reduce((s, [, w]) => s + w, 0), grow = Math.min(1.7, room / used);
    const COL = { idx: lx + 32, bar: lx + 1170, pnl: lx + lwid - 32 };
    let cx0 = lx + 82;
    for (const [k, w] of WIDTHS) { COL[k] = cx0; cx0 += w * grow; }
    const hy = ly + 28;
    text(ctx, 'THE LEDGER', COL.idx, hy, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.55)', ls: 4 });
    const counted = trades.filter((x) => x.outcome !== 'missed');
    if (counted.length > 1) {
      let run = 0; const eq = [0, ...counted.map((x) => (run += x.pnl))];
      const gx0 = lx + lwid - 330, gx1 = lx + lwid - 32, gy0 = ly + 18, gy1 = ly + 50;
      const lo = Math.min(...eq), hi = Math.max(...eq), rg = hi - lo || 1;
      ctx.beginPath(); eq.forEach((v, i) => { const x = gx0 + (i * (gx1 - gx0)) / (eq.length - 1), y = gy1 - ((v - lo) / rg) * (gy1 - gy0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.save(); ctx.shadowColor = `rgba(${t.rgb},.8)`; ctx.shadowBlur = 8 * SCALE; ctx.strokeStyle = t.hex; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
      text(ctx, 'RUNNING', gx0 - 14, hy, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.3)', align: 'right', ls: 3 });
    }
    const heads = [['time', 'TIME'], ['sym', 'SYMBOL'], ['size', 'SIZE'], ['px', 'ENTRY / EXIT'], ['held', 'HELD'], ['r', 'R']].filter(([k]) => COL[k] !== undefined).map(([k, s]) => [COL[k], s]);
    const h2 = ly + 70;
    heads.forEach(([x, s]) => text(ctx, s, x, h2, { kind: 'mono', size: 11, color: 'rgba(255,255,255,.32)', ls: 2.4 }));
    text(ctx, 'PNL', COL.pnl, h2, { kind: 'mono', size: 11, color: 'rgba(255,255,255,.32)', align: 'right', ls: 2.4 });
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(lx + 24, ly + 92, lwid - 48, 1);

    const maxAbs = Math.max(1, ...slice.map((x) => Math.abs(x.outcome === 'missed' ? 0 : x.pnl)));
    let y = ly + 96;
    for (const l of lines) {
      if (l.type === 'day') {
        const dd = DateTime.fromISO(l.date).setLocale('en');
        text(ctx, dd.toFormat('ccc · LLL d').toUpperCase(), COL.idx, y + 17, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.7)', ls: 3 });
        const o = l.n ? toneOf(l.pnl) : 'none';
        const s = l.n ? `${l.n} trade${l.n === 1 ? '' : 's'} · ${formatDollars(l.pnl, { symbol: sym })}` : 'missed only';
        const sw = measure(ctx, s, 'mono', 13) + 26;
        rr(ctx, COL.pnl - sw, y + 9, sw, 28, 14); ctx.fillStyle = l.n ? `rgba(${OUT[o].rgb},.14)` : 'rgba(255,255,255,.06)'; ctx.fill();
        text(ctx, s, COL.pnl - 13, y + 16.5, { kind: 'mono', size: 13, color: l.n ? OUT[o].hex : 'rgba(255,255,255,.45)', align: 'right' });
        y += DAYROW;
        continue;
      }
      const tr = l.t, missed = tr.outcome === 'missed';
      const o = missed ? 'none' : outcomeOf({ trades: 1, pnl: tr.pnl }), oc = missed ? { hex: '#8b93a3', rgb: '139,147,163' } : OUT[o];
      const cy = y + ROW / 2;
      // row hover-like wash on alternate rows, and the outcome stripe
      if (l.idx % 2 === 0) { rr(ctx, lx + 18, y + 4, lwid - 36, ROW - 8, 14); ctx.fillStyle = 'rgba(255,255,255,.025)'; ctx.fill(); }
      rr(ctx, lx + 18, y + 14, 4, ROW - 28, 2); ctx.fillStyle = oc.hex; ctx.fill();
      text(ctx, String(l.idx).padStart(2, '0'), COL.idx, cy - 8, { kind: 'mono', size: 14, color: 'rgba(255,255,255,.35)' });
      if (has.time) text(ctx, tr.time || '—', COL.time, cy - 8, { kind: 'mono', size: 15, color: tr.time ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.25)' });
      const name = (tr.instrument || 'TRADE').toUpperCase().slice(0, 10);
      const nw = text(ctx, name, COL.sym, cy - 11, { size: 21, weight: 800, color: missed ? 'rgba(255,255,255,.55)' : '#ffffff', ls: -0.2 });
      const dir = tr.direction ? String(tr.direction).toUpperCase().slice(0, 5) : null;
      if (dir) {
        const long = /^L|BUY/.test(dir), dw = measure(ctx, dir, 'inter', 11, 700, 1.6) + 18;
        rr(ctx, COL.sym + nw + 12, cy - 11, dw, 22, 11); ctx.strokeStyle = long ? `rgba(${OUT.win.rgb},.55)` : `rgba(${OUT.loss.rgb},.55)`; ctx.lineWidth = 1.2; ctx.stroke();
        text(ctx, dir, COL.sym + nw + 21, cy - 5.5, { size: 11, weight: 700, color: long ? OUT.win.hex : OUT.loss.hex, ls: 1.6 });
      }
      if (tr.setup && !/^Imported from CSV$/.test(tr.setup)) text(ctx, String(tr.setup).slice(0, 26), COL.sym, cy + 14, { kind: 'mono', size: 11, color: 'rgba(255,255,255,.32)' });
      if (has.size) text(ctx, tr.qty ? `${tr.qty}×` : '—', COL.size, cy - 8, { kind: 'mono', size: 15, color: tr.qty ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.25)' });
      const e1 = priceFmt(tr.entry), e2 = priceFmt(tr.exit);
      if (!has.px) { /* no prices on this page */ } else if (!e1) text(ctx, '—', COL.px, cy - 8, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.25)' });
      else {
        const w1 = text(ctx, e1, COL.px, cy - 8, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.7)' });
        if (e2) {   // a drawn arrow (the mono font has no arrow glyph), tinted by the outcome
          const ax = COL.px + w1 + 12;
          ctx.strokeStyle = `rgba(${oc.rgb},.8)`; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(ax, cy); ctx.lineTo(ax + 18, cy); ctx.moveTo(ax + 13, cy - 4.5); ctx.lineTo(ax + 18, cy); ctx.lineTo(ax + 13, cy + 4.5); ctx.stroke();
          text(ctx, e2, ax + 30, cy - 8, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.7)' });
        }
      }
      if (has.held) text(ctx, tr.held || '—', COL.held, cy - 8, { kind: 'mono', size: 15, color: tr.held ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.25)' });
      const rv = typeof tr.r === 'number' && !Number.isNaN(tr.r) ? `${tr.r > 0 ? '+' : ''}${Number(tr.r.toFixed(2))}R` : '—';
      if (has.r) text(ctx, rv, COL.r, cy - 8, { kind: 'mono', size: 15, color: rv === '—' ? 'rgba(255,255,255,.25)' : oc.hex });
      // the PnL bar: from the centre line, right for green, left for red
      const half = 70, mid = COL.bar;
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(mid, cy - 12, 1, 24);
      if (!missed && tr.pnl) {
        const len = Math.max(4, (Math.abs(tr.pnl) / maxAbs) * half);
        rr(ctx, tr.pnl > 0 ? mid + 2 : mid - 2 - len, cy - 5, len, 10, 5); ctx.fillStyle = oc.hex; ctx.fill();
      }
      if (missed) {
        text(ctx, 'MISSED', COL.pnl, cy - 13, { size: 13, weight: 700, color: oc.hex, align: 'right', ls: 2 });
        if (tr.potential) text(ctx, `${formatDollars(tr.potential, { symbol: sym })} potential`, COL.pnl, cy + 7, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.35)', align: 'right' });
      } else {
        const pv = formatDollars(tr.pnl, { symbol: sym });
        text(ctx, pv, COL.pnl, cy - 13, { size: 26, weight: 800, color: oc.hex, align: 'right', ls: -0.6 });
        if (data.best && tr.key === data.best.key && data.count > 1 && tr.pnl > 0) star(ctx, COL.pnl - measure(ctx, pv, 'inter', 26, 800, -0.6) - 16, cy, 7, '#ffffff');
      }
      y += ROW;
    }
    if (pages > 1) {
      ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(lx + 24, y + 8, lwid - 48, 1);
      text(ctx, `PAGE ${pg + 1} OF ${pages}  ·  TRADES ${pg * TR_PER_PAGE + 1}–${pg * TR_PER_PAGE + slice.length} OF ${trades.length}`, lx + lwid / 2, y + 22, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.45)', align: 'center', ls: 2.4 });
    }
  }
  const traded = (data.symbols || []).map((s) => String(s.symbol).toUpperCase()).filter(Boolean).slice(0, 4);
  footer(ctx, H, undefined, undefined, traded.length ? `${traded.join(' · ')} — NEW YORK` : undefined);
  return { buffer: canvas.toBuffer('image/png'), page: pg, pages };
}

/**
 * The Appearance page's preview: the same day drawn in Studio and in Night,
 * side by side on a floor that is half day, half night, with the one in use
 * marked. active: 'light' | 'dark' | 'auto' (auto marks both, "by the clock").
 */
function renderThemeSwatch(day, active = 'light') {
  ensureFonts();
  const SW = 1180, SH = 812, cw = 540, ch = 675, top = 40;
  const canvas = createCanvas(SW * SCALE, SH * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  // the floor: day on the left melting into night on the right
  const g = ctx.createLinearGradient(0, 0, SW, 0);
  g.addColorStop(0, THEMES.light.floor2); g.addColorStop(0.47, THEMES.light.floor); g.addColorStop(0.53, THEMES.dark.floor); g.addColorStop(1, THEMES.dark.floor2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, SW, SH);
  const sides = [['light', 'STUDIO', 40], ['dark', 'NIGHT', SW - 40 - cw]];
  for (const [theme, name, x] of sides) {
    const img = withTheme(theme, toneFor(day.total, !(day.trades || []).some((t) => t.outcome !== 'missed')), () => renderDaily(day, true));
    const on = active === theme || active === 'auto';
    ctx.save();
    ctx.shadowColor = theme === 'dark' ? 'rgba(0,0,0,.6)' : 'rgba(26,33,51,.22)'; ctx.shadowBlur = 30 * SCALE; ctx.shadowOffsetY = 14 * SCALE;
    rr(ctx, x, top, cw, ch, 22); ctx.fillStyle = theme === 'dark' ? THEMES.dark.floor : THEMES.light.floor; ctx.fill(); ctx.restore();
    ctx.save(); rr(ctx, x, top, cw, ch, 22); ctx.clip(); ctx.drawImage(img, x, top, cw, ch); ctx.restore();
    if (on) { rr(ctx, x - 6, top - 6, cw + 12, ch + 12, 27); ctx.strokeStyle = active === 'auto' ? 'rgba(121,131,255,.85)' : `rgba(${OUT.win.rgb},.9)`; ctx.lineWidth = 3; ctx.stroke(); }
    const ink = theme === 'dark' ? THEMES.dark.ink : THEMES.light.ink, grey = theme === 'dark' ? THEMES.dark.grey : THEMES.light.grey;
    const ly = top + ch + 34, lw = measure(ctx, name, 'mono', 16, 400, 5);
    const label = on ? (active === 'auto' ? (theme === 'light' ? 'BY DAY' : 'AFTER 7 PM') : 'IN USE') : '';
    const total = 22 + lw + (label ? 18 + measure(ctx, label, 'mono', 13, 400, 3) : 0), lx = x + cw / 2 - total / 2;
    ctx.fillStyle = on ? (active === 'auto' ? '#7983ff' : OUT.win.hex) : grey; ctx.beginPath(); ctx.arc(lx + 6, ly + 8, 5, 0, Math.PI * 2);
    if (on) ctx.fill(); else { ctx.lineWidth = 1.6; ctx.strokeStyle = grey; ctx.stroke(); }
    text(ctx, name, lx + 22, ly, { kind: 'mono', size: 16, color: on ? ink : grey, ls: 5 });
    if (label) text(ctx, label, lx + 22 + lw + 18, ly + 2, { kind: 'mono', size: 13, color: grey, ls: 3 });
  }
  return canvas.toBuffer('image/png');
}

// each card in a theme: opts.theme 'light' (default) | 'dark'
const weeklyEmpty = (w) => !w.days?.some((d) => d.trades > 0) && !(w.weekend && w.weekend.trades);
module.exports = {
  renderWeekly: (week, { theme } = {}) => withTheme(theme, toneFor(week.total, weeklyEmpty(week)), () => renderWeekly(week)),
  renderMonthly: (month, { theme } = {}) => withTheme(theme, toneFor(month.total, !Object.values(month.data || {}).some((d) => d.trades > 0)), () => renderMonthly(month)),
  renderDaily: (day, { theme } = {}) => withTheme(theme, toneFor(day.total, !(day.trades || []).some((t) => t.outcome !== 'missed')), () => renderDaily(day)),
  renderTrades: (data, page = 0, { theme } = {}) => withTheme(theme, toneFor(data.net, !data.count), () => renderTrades(data, page)),
  renderThemeSwatch, tradePages, ensureFonts, THEMES,
};
