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

/* the landing page's palette */
const C = {
  floor: '#f9fbfb', floor2: '#eef0f4', ink: '#15171c', ink2: '#2a2d36', grey: '#8b8b92', soft: '#5b5f6b',
  line: 'rgba(26,33,51,.08)', card: '#0c0d10', card2: '#16181d', shadow: '26,33,51', blurple: '#5865f2',
};
/* outcome colours: bright on the dark cards, deeper on the light floor */
const OUT = {
  win:  { rgb: '60,207,122',  hex: '#3ccf7a', deep: '#159a52', word: 'WIN' },
  loss: { rgb: '248,113,113', hex: '#f87171', deep: '#d33c3c', word: 'LOSS' },
  be:   { rgb: '245,184,75',  hex: '#f5b84b', deep: '#b97a0c', word: 'BREAKEVEN' },
  none: { rgb: '148,163,184', hex: '#94a3b8', deep: '#8b8b92', word: 'NO TRADE' },
};
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
  ctx.save(); ctx.shadowColor = `rgba(${C.shadow},${alpha})`; ctx.shadowBlur = blur * SCALE; ctx.shadowOffsetY = y * SCALE; fn(); ctx.restore();
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
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, C.floor); g.addColorStop(1, C.floor2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // the soft grid, fading toward the edges
  const grid = createCanvas(W, H), gx = grid.getContext('2d');
  gx.strokeStyle = `rgba(${C.shadow},.06)`; gx.lineWidth = 1; gx.beginPath();
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
  shadowed(ctx, () => { rr(ctx, PAD, pillY, pillW, pillH, 23); ctx.fillStyle = '#ffffff'; ctx.fill(); }, { blur: 18, y: 8, alpha: 0.12 });
  rr(ctx, PAD + 0.5, pillY + 0.5, pillW - 1, pillH - 1, 23); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, PAD + 10, pillY + 10, 26, 26, 8); ctx.fillStyle = C.ink; ctx.fill();
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
    rr(ctx, cx, cy, cw, 40, 20); ctx.fillStyle = '#ffffff'; ctx.fill();
    rr(ctx, cx + 0.5, cy + 0.5, cw - 1, 39, 20); ctx.strokeStyle = `rgba(${o.rgb},.55)`; ctx.lineWidth = 1.5; ctx.stroke();
    text(ctx, s, cx + 18, cy + 13, { size: 15, weight: 600, color: o.deep, ls: 1.6 });
  }
}

/* ----------------------------- dark glass card ---------------------------- */
function glassCard(ctx, x, y, w, h, r, o, { lift = true, faint = false } = {}) {
  const c = OUT[o];
  const body = () => { rr(ctx, x, y, w, h, r); ctx.fillStyle = C.card; ctx.fill(); };
  if (lift) shadowed(ctx, body, { blur: 34, y: 20, alpha: faint ? 0.14 : 0.28 }); else body();
  rr(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, o === 'none' ? 'rgba(255,255,255,.035)' : `rgba(${c.rgb},.16)`); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fill();
  // a lit top edge and a hairline
  rr(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, r - 0.75); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1.5; ctx.stroke();
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
  ctx.save(); ctx.setLineDash([4, 8]); ctx.strokeStyle = `rgba(${C.shadow},.22)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x1, zero); ctx.stroke(); ctx.restore();
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
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(p.x, ys[i], isLast ? 10 : 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = o.hex; ctx.beginPath(); ctx.arc(p.x, ys[i], isLast ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
    // value tag: a small white pill above the point
    const s = formatDollars(p.v, { symbol }), tw = measure(ctx, s, 'mono', 16) + 22;
    let tx = labelAll ? p.x - tw / 2 : p.x - tw; tx = Math.max(x0, Math.min(x1 - tw, tx));
    const ty = ys[i] - 52;
    shadowed(ctx, () => { rr(ctx, tx, ty, tw, 30, 15); ctx.fillStyle = isLast ? C.ink : '#ffffff'; ctx.fill(); }, { blur: 12, y: 5, alpha: 0.12 });
    text(ctx, s, tx + 11, ty + 8, { kind: 'mono', size: 16, color: isLast ? '#ffffff' : o.deep });
  });
}

/* --------------------------------- stats --------------------------------- */
function stats(ctx, top, list, h = 92) {
  const n = list.length, gap = 14, cw = (INNER_W - gap * (n - 1)) / n;
  list.forEach((s, i) => {
    const x = PAD + i * (cw + gap);
    shadowed(ctx, () => { rr(ctx, x, top, cw, h, 22); ctx.fillStyle = '#ffffff'; ctx.fill(); }, { blur: 22, y: 10, alpha: 0.1 });
    rr(ctx, x + 0.5, top + 0.5, cw - 1, h - 1, 22); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
    text(ctx, s.k, x + 22, top + 20, { kind: 'mono', size: 13, color: C.grey, ls: 3 });
    const col = s.tone === 'good' ? OUT.win.deep : s.tone === 'bad' ? OUT.loss.deep : C.ink;
    const vs = shrink(ctx, String(s.v), cw - 44, { size: 34, weight: 800, ls: -1 });
    text(ctx, String(s.v), x + 22, top + 44, { size: vs, weight: 800, color: col, ls: -vs * 0.03 });
  });
}

/* --------------------------------- footer -------------------------------- */
function footer(ctx, H, W = 1600, PAD = 56) {
  const base = H - 40;
  ctx.fillStyle = `rgba(${C.shadow},.08)`; ctx.fillRect(PAD, base - 44, W - PAD * 2, 1);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  font(ctx, 'mono', 15); setLS(ctx, 5); ctx.fillStyle = C.grey;
  ctx.fillText('NQ · ES · YM — NEW YORK', PAD, base); setLS(ctx, 0);
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
      text(ctx, 'BEST', x + cw / 2, y - 5, { size: 11, weight: 600, color: C.ink, align: 'center', ls: 2 });
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
        ctx.save(); ctx.setLineDash([5, 7]); ctx.strokeStyle = `rgba(${C.shadow},.12)`; ctx.lineWidth = 1.2; rr(ctx, x + 1, y + 1, w - 2, CELL_H - 2, 18); ctx.stroke(); ctx.restore();
        text(ctx, String(dt.day), x + 16, y + 14, { kind: 'mono', size: 15, color: 'rgba(139,139,146,.45)' });
        return;
      }
      if (d && d.trades) { wp += d.pnl; wd += 1; }
      if (o === 'none') { // an untraded day: a white card resting on the floor (weekends hatched)
        rr(ctx, x, y, w, CELL_H, 18); ctx.fillStyle = weekend ? 'rgba(255,255,255,.55)' : '#ffffff'; ctx.fill();
        if (weekend) {
          ctx.save(); rr(ctx, x, y, w, CELL_H, 18); ctx.clip(); ctx.strokeStyle = `rgba(${C.shadow},.05)`; ctx.lineWidth = 6;
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
    shadowed(ctx, () => { rr(ctx, x, y, w, CELL_H, 30); ctx.fillStyle = C.ink; ctx.fill(); }, { blur: 26, y: 14, alpha: 0.22 });
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
 * One day on a 1080x1350 card (4:5, the feed size): the weekday headline
 * with its italic turn, the day's PnL large, then "the tape" (a dark glass
 * card with a running-PnL step chart and every trade as a row), and the week
 * around it as a strip of five days with today lit.
 */
const DW = 1080, DH = 1350, DPAD = 56, DINNER = DW - DPAD * 2;

function renderDaily(day) {
  ensureFonts();
  const sym = day.symbol || '$';
  const canvas = createCanvas(DW * SCALE, DH * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  floor(ctx, DH, DW);
  const trades = day.trades || [];
  const counted = trades.filter((t) => t.outcome !== 'missed');
  const empty = counted.length === 0;
  const tone = empty ? 'none' : toneOf(day.total), t = OUT[tone];

  // the pill and the date
  const kicker = 'Journal · Daily PnL', kw = measure(ctx, kicker, 'inter', 17, 600, 0.2), pw = 12 + 26 + 12 + kw + 22;
  shadowed(ctx, () => { rr(ctx, DPAD, 48, pw, 46, 23); ctx.fillStyle = '#ffffff'; ctx.fill(); }, { blur: 18, y: 8, alpha: 0.12 });
  rr(ctx, DPAD + 0.5, 48.5, pw - 1, 45, 23); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
  rr(ctx, DPAD + 10, 58, 26, 26, 8); ctx.fillStyle = C.ink; ctx.fill();
  ctx.fillStyle = t.hex; ctx.beginPath(); ctx.arc(DPAD + 23, 71, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(${t.rgb},.35)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(DPAD + 23, 71, 8, 0, Math.PI * 2); ctx.stroke();
  text(ctx, kicker, DPAD + 50, 63, { size: 17, weight: 600, color: C.ink2, ls: 0.2 });
  text(ctx, day.dateLabel || '', DW - DPAD, 64, { kind: 'mono', size: 15, color: C.grey, align: 'right', ls: 4 });

  // "Thursday, a green day."
  const turn = empty ? (trades.length ? 'only missed.' : 'no trades.') : day.total > 0 ? 'a green day.' : day.total < 0 ? 'a red day.' : 'dead flat.';
  const lead = `${day.weekday || 'Today'},`;
  const hs = shrink(ctx, lead, DINNER * 0.55, { size: 68, weight: 800, ls: -3 });
  const lw = text(ctx, lead, DPAD, 128, { size: hs, weight: 800, ls: -hs * 0.045 });
  const ts = Math.min(hs * 1.08, 76);
  text(ctx, turn, DPAD + lw + 16, 128 + hs * 0.08, { kind: 'serif', size: ts, italic: true, color: C.grey, ls: -0.5 });
  ctx.fillStyle = empty ? `rgba(${OUT.none.rgb},.35)` : `rgba(${t.rgb},.55)`;
  rr(ctx, DPAD + lw + 20, 128 + hs + 12, Math.min(measure(ctx, turn, 'serif', ts, 400, -0.5, true) - 8, 200), 4, 2); ctx.fill();

  // the day's PnL, large
  const val = formatDollars(day.total || 0, { symbol: sym });
  const vs = shrink(ctx, val, DINNER, { size: 168, weight: 800, ls: -7 });
  text(ctx, val, DPAD - 4, 240, { size: vs, weight: 800, color: empty ? C.grey : t.deep, ls: -vs * 0.045 });
  const parts = [];
  if (day.count) parts.push(`${day.count} TRADE${day.count === 1 ? '' : 'S'}`);
  if (day.count) parts.push(`${day.w}W · ${day.l}L${day.be ? ` · ${day.be}BE` : ''}`);
  if (day.winRate != null) parts.push(`${day.winRate}% WIN RATE`);
  if (day.rSum != null) parts.push(`${day.rSum > 0 ? '+' : ''}${Number(day.rSum.toFixed(2))}R`);
  if (day.missed) parts.push(`${day.missed} MISSED`);
  text(ctx, parts.join('  ·  ') || 'NOTHING LOGGED FOR THIS DAY', DPAD, 240 + vs + 22, { kind: 'mono', size: 16, color: C.soft, ls: 2.4 });

  // the tape: a dark glass card
  const cx = DPAD, cy = 470, cw = DINNER, ch = 560;
  glassCard(ctx, cx, cy, cw, ch, 32, tone, { faint: empty });
  text(ctx, 'THE TAPE', cx + 30, cy + 28, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.45)', ls: 4 });
  text(ctx, 'RUNNING PNL', cx + cw - 30, cy + 28, { kind: 'mono', size: 13, color: 'rgba(255,255,255,.3)', align: 'right', ls: 4 });
  if (!trades.length) {
    text(ctx, 'No trades logged', cx + cw / 2, cy + ch / 2 - 24, { kind: 'serif', size: 48, italic: true, color: 'rgba(255,255,255,.5)', align: 'center' });
    text(ctx, 'log one with /journal', cx + cw / 2, cy + ch / 2 + 36, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.3)', align: 'center', ls: 1 });
  } else {
    // the step chart: flat between trades, a step at each one
    const gx0 = cx + 30, gx1 = cx + cw - 30, gy0 = cy + 66, gy1 = cy + 206;
    let run = 0; const vals = [0, ...counted.map((x) => (run += x.pnl))];
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), rng = hi - lo || 1;
    const Y = (v) => gy1 - ((v - lo) / rng) * (gy1 - gy0), X = (i) => gx0 + (i * (gx1 - gx0)) / Math.max(1, vals.length - 1);
    ctx.save(); ctx.setLineDash([4, 7]); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(gx0, Y(0)); ctx.lineTo(gx1, Y(0)); ctx.stroke(); ctx.restore();
    const step = () => { ctx.beginPath(); ctx.moveTo(X(0), Y(0)); for (let i = 1; i < vals.length; i++) { ctx.lineTo(X(i), Y(vals[i - 1])); ctx.lineTo(X(i), Y(vals[i])); } };
    ctx.save(); step(); ctx.lineTo(X(vals.length - 1), Y(0)); ctx.closePath(); ctx.clip();
    const ag = ctx.createLinearGradient(0, gy0, 0, gy1); ag.addColorStop(0, `rgba(${t.rgb},.32)`); ag.addColorStop(1, `rgba(${t.rgb},0)`);
    ctx.fillStyle = ag; ctx.fillRect(gx0, gy0 - 10, gx1 - gx0, gy1 - gy0 + 20); ctx.restore();
    ctx.save(); ctx.shadowColor = `rgba(${t.rgb},.8)`; ctx.shadowBlur = 10 * SCALE; ctx.strokeStyle = t.hex; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; step(); ctx.stroke(); ctx.restore();
    for (let i = 1; i < vals.length; i++) {
      const o = OUT[toneOf(counted[i - 1].pnl)];
      ctx.fillStyle = C.card; ctx.beginPath(); ctx.arc(X(i), Y(vals[i]), 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = o.hex; ctx.lineWidth = 3; ctx.stroke();
    }
    const endLbl = formatDollars(vals[vals.length - 1], { symbol: sym });
    const ey = Y(vals[vals.length - 1]); text(ctx, endLbl, gx1 - 18, ey - 30 < gy0 - 8 ? ey + 14 : ey - 30, { kind: 'mono', size: 16, color: t.hex, align: 'right' });

    // the trades, one row each
    // rows grow to fill the card when there are only a few trades
    const rowTop = cy + 236, avail = ch - 236 - 28, rowH = Math.max(56, Math.min(72, Math.floor(avail / Math.max(4, trades.length)))), maxRows = Math.floor(avail / rowH);
    const shown = trades.length > maxRows ? trades.slice(0, maxRows - 1) : trades;
    let ci = 0;
    shown.forEach((tr, i) => {
      const y = rowTop + i * rowH + (rowH - 56) / 2, o = tr.outcome === 'missed' ? 'missed' : outcomeOf({ trades: 1, pnl: tr.pnl });
      const oc = o === 'missed' ? { hex: '#8b93a3', rgb: '139,147,163' } : OUT[o];
      if (i) { ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(cx + 30, rowTop + i * rowH - 1, cw - 60, 1); }
      // index chip
      rr(ctx, cx + 30, y + 12, 32, 32, 10); ctx.fillStyle = `rgba(${oc.rgb},.14)`; ctx.fill();
      text(ctx, tr.outcome === 'missed' ? '×' : String(++ci), cx + 46, y + 19, { kind: 'mono', size: 16, color: oc.hex, align: 'center' });
      // name and setup
      const name = (tr.instrument || (tr.outcome === 'missed' ? 'Missed trade' : `Trade ${ci}`)).toUpperCase().slice(0, 18);
      const nw = text(ctx, name, cx + 76, y + 13, { size: 19, weight: 700, color: '#ffffff', ls: 0.2 });
      if (tr.setup) text(ctx, String(tr.setup).slice(0, 34), cx + 76, y + 37, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.38)' });
      // direction pill
      let px = cx + 76 + nw + 12;
      const dir = tr.direction ? String(tr.direction).toUpperCase().slice(0, 5) : null;
      if (dir) {
        const long = /^L|BUY/.test(dir), dw = measure(ctx, dir, 'inter', 11, 700, 1.6) + 18;
        rr(ctx, px, y + 13, dw, 22, 11); ctx.strokeStyle = long ? `rgba(${OUT.win.rgb},.5)` : `rgba(${OUT.loss.rgb},.5)`; ctx.lineWidth = 1.2; ctx.stroke();
        text(ctx, dir, px + 9, y + 18.5, { size: 11, weight: 700, color: long ? OUT.win.hex : OUT.loss.hex, ls: 1.6 });
        px += dw + 10;
      }
      // R, then the PnL on the right
      const right = cx + cw - 30;
      if (tr.outcome === 'missed') {
        text(ctx, 'MISSED', right, y + 14, { size: 13, weight: 700, color: oc.hex, align: 'right', ls: 2 });
        if (tr.potential) text(ctx, `${formatDollars(tr.potential, { symbol: sym })} potential`, right, y + 36, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.35)', align: 'right' });
      } else {
        const pv = formatDollars(tr.pnl, { symbol: sym });
        text(ctx, pv, right, y + 13, { size: 24, weight: 800, color: oc.hex, align: 'right', ls: -0.6 });
        if (typeof tr.r === 'number' && !Number.isNaN(tr.r)) text(ctx, `${tr.r > 0 ? '+' : ''}${Number(tr.r.toFixed(2))}R`, right, y + 40, { kind: 'mono', size: 12, color: 'rgba(255,255,255,.4)', align: 'right' });
        if (day.best && tr === day.best && counted.length > 1 && tr.pnl > 0) star(ctx, right - measure(ctx, pv, 'inter', 24, 800, -0.6) - 16, y + 25, 7, '#ffffff');
      }
    });
    if (trades.length > shown.length) {
      text(ctx, `+ ${trades.length - shown.length} more trade${trades.length - shown.length === 1 ? '' : 's'}`, cx + cw / 2, rowTop + shown.length * rowH + 18, { kind: 'mono', size: 14, color: 'rgba(255,255,255,.45)', align: 'center', ls: 1 });
    }
  }

  // the week around it: five small cards, today lit
  const week = day.week || [];
  const sy = 1062;
  text(ctx, 'THIS WEEK', DPAD, sy, { kind: 'mono', size: 13, color: C.grey, ls: 4 });
  if (day.weekTotal != null) text(ctx, formatDollars(day.weekTotal, { symbol: sym }), DW - DPAD, sy - 1, { kind: 'mono', size: 15, color: OUT[toneOf(day.weekTotal)].deep, align: 'right' });
  const gap = 12, sw = (DINNER - gap * 4) / 5, sh = 108, top = sy + 26;
  const maxAbs = Math.max(1, ...week.map((d) => Math.abs(d.pnl)));
  week.forEach((d, i) => {
    const x = DPAD + i * (sw + gap), lit = d.today, o = d.trades ? toneOf(d.pnl) : 'none';
    const body = () => { rr(ctx, x, top, sw, sh, 20); ctx.fillStyle = lit ? C.ink : '#ffffff'; ctx.fill(); };
    shadowed(ctx, body, { blur: lit ? 26 : 16, y: lit ? 14 : 8, alpha: lit ? 0.26 : 0.08 });
    if (!lit) { rr(ctx, x + 0.5, top + 0.5, sw - 1, sh - 1, 20); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke(); }
    text(ctx, d.day, x + 16, top + 14, { kind: 'mono', size: 13, color: lit ? 'rgba(255,255,255,.6)' : C.grey, ls: 3 });
    // a bar from the mid line: up for green, down for red
    const mid = top + 54, bh = d.trades ? Math.max(3, (Math.abs(d.pnl) / maxAbs) * 16) : 0;
    ctx.fillStyle = lit ? 'rgba(255,255,255,.12)' : `rgba(${C.shadow},.08)`; ctx.fillRect(x + 16, mid, sw - 32, 1);
    if (bh) { rr(ctx, x + sw / 2 - 9, d.pnl >= 0 ? mid - bh : mid + 1, 18, bh, 4); ctx.fillStyle = lit ? OUT[o].hex : OUT[o].deep; ctx.fill(); }
    const lbl = d.trades ? formatDollars(d.pnl, { symbol: sym }) : '—';
    const ls2 = shrink(ctx, lbl, sw - 24, { kind: 'mono', size: 14, weight: 400 });
    text(ctx, lbl, x + sw / 2, top + sh - 26, { kind: 'mono', size: ls2, color: lit ? '#ffffff' : d.trades ? OUT[o].deep : C.grey, align: 'center' });
  });

  footer(ctx, DH, DW, DPAD);
  return canvas.toBuffer('image/png');
}

module.exports = { renderWeekly, renderMonthly, renderDaily, ensureFonts };
