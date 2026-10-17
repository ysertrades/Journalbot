'use strict';
/**
 * PnL image renderer (weekly + monthly). Mirrors assets/reference/*.png.
 * All geometry lives in the LAYOUT constants below so nothing is hardcoded in the drawing code.
 */
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { DateTime } = require('luxon');
const { formatDollars, formatShort } = require('./money');

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
const PAD_X = 50, PAD_TOP = 56, PAD_BOTTOM = 38;
const BASE_K = { inter: 0.864, mono: 0.86, serif: 0.8 }; // baseline offset inside a line-height:1 box
const INNER_W = W - PAD_X * 2; // 1500

const THEMES = {
  win:  { a: '52,211,153',  hex: '#34d399', t1: '#86efac', g: '16,185,129', dark: '#020604', pill: '#04100a' },
  loss: { a: '248,113,113', hex: '#f87171', t1: '#fca5a5', g: '239,68,68',  dark: '#060202', pill: '#100404' },
  be:   { a: '251,191,36',  hex: '#fbbf24', t1: '#fde68a', g: '217,119,6',  dark: '#060502', pill: '#110d03' },
};
const OUT = { win: '52,211,153', loss: '248,113,113', be: '251,191,36', none: '148,163,184' };
const LABEL = { win: 'WIN', loss: 'LOSS', be: 'BREAKEVEN', none: 'NO TRADE' };
const CARD_BG = '#050810';

const themeFor = (total) => (total > 0 ? THEMES.win : total < 0 ? THEMES.loss : THEMES.be);
const outcomeOf = (d) => (!d || d.trades === 0 ? 'none' : d.pnl > 0 ? 'win' : d.pnl < 0 ? 'loss' : 'be');

/* ------------------------------ primitives ------------------------------ */
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function font(ctx, kind, size, weight = 400, italic = false) {
  const fam = kind === 'inter' ? 'Inter' : kind === 'mono' ? '"JB Mono"' : '"Instrument Serif"';
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${fam}`;
}
function setLS(ctx, px) { ctx.letterSpacing = `${px}px`; }
function measure(ctx, str, kind, size, weight, ls = 0, italic = false) {
  font(ctx, kind, size, weight, italic); setLS(ctx, ls);
  const w = ctx.measureText(str).width; setLS(ctx, 0); return w;
}
/** draw text with its line-height:1 box TOP at `top` */
function text(ctx, str, x, top, { kind = 'inter', size = 16, weight = 400, color = '#fff', align = 'left', ls = 0, italic = false, fill } = {}) {
  font(ctx, kind, size, weight, italic); setLS(ctx, ls);
  const w = ctx.measureText(str).width;
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fill ? fill(left, w) : color;
  ctx.fillText(str, left, top + size * BASE_K[kind]);
  setLS(ctx, 0);
  return w;
}
function hgrad(ctx, x0, x1, stops) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g;
}
function vgrad(ctx, y0, y1, stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g;
}
function glowText(ctx, str, x, top, opts, glowRgb, glowAlpha, blur) {
  ctx.save();
  ctx.shadowColor = `rgba(${glowRgb},${glowAlpha})`; ctx.shadowBlur = blur * SCALE;
  const w = text(ctx, str, x, top, opts);
  ctx.restore(); return w;
}
function shrinkText(ctx, str, maxW, { kind, size, weight, ls = 0, min = 14 }) {
  let s = size;
  while (s > min && measure(ctx, str, kind, s, weight, ls) > maxW) s -= 2;
  return s;
}
function icon(ctx, kind, cx, cy, size, color, stroke = 3.4) {
  const k = size / 24; ctx.save(); ctx.translate(cx - size / 2, cy - size / 2); ctx.scale(k, k);
  ctx.strokeStyle = color; ctx.lineWidth = stroke; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  if (kind === 'win') { ctx.moveTo(4, 12); ctx.lineTo(20, 12); ctx.moveTo(12, 4); ctx.lineTo(12, 20); }
  else if (kind === 'loss') { ctx.moveTo(4, 12); ctx.lineTo(20, 12); }
  else if (kind === 'be') { ctx.moveTo(5, 9); ctx.lineTo(19, 9); ctx.moveTo(5, 15); ctx.lineTo(19, 15); }
  else { ctx.moveTo(6, 7); ctx.lineTo(11, 12); ctx.lineTo(6, 17); ctx.moveTo(13, 7); ctx.lineTo(18, 12); ctx.lineTo(13, 17); }
  ctx.stroke(); ctx.restore();
}
/** rounded box with 2px gradient border (horizontal) and a fill painted inside it */
function gradBorderBox(ctx, x, y, w, h, r, borderStops, fillFn, bw = 2) {
  rr(ctx, x, y, w, h, r); ctx.fillStyle = hgrad(ctx, x, x + w, borderStops); ctx.fill();
  rr(ctx, x + bw, y + bw, w - bw * 2, h - bw * 2, Math.max(0, r - bw)); ctx.fillStyle = fillFn(x + bw, w - bw * 2); ctx.fill();
}

/* ------------------------------- shared parts ------------------------------- */
function background(ctx, t, H) {
  ctx.fillStyle = t.dark; ctx.fillRect(0, 0, W, H);
  // glows
  const g1 = ctx.createRadialGradient(W * 0.9, -H * 0.008, 0, W * 0.9, -H * 0.008, 760);
  g1.addColorStop(0, `rgba(${t.g},.38)`); g1.addColorStop(1, `rgba(${t.g},0)`);
  ctx.save(); ctx.translate(W * 0.9, -8); ctx.scale(900 / 760, 520 / 760); ctx.translate(-W * 0.9, 8); ctx.fillStyle = g1; ctx.fillRect(-2000, -2000, 6000, 6000); ctx.restore();
  ctx.save(); ctx.translate(W * 0.04, H * 1.08); ctx.scale(760 / 560, 420 / 560);
  const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, 560); g2.addColorStop(0, `rgba(${t.g},.14)`); g2.addColorStop(1, `rgba(${t.g},0)`);
  ctx.fillStyle = g2; ctx.fillRect(-3000, -3000, 6000, 6000); ctx.restore();
  // grid: 200px, offset 50px
  ctx.strokeStyle = `rgba(${t.a},.07)`; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 50; x < W; x += 200) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
  for (let y = 0; y < H; y += 200) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
  ctx.stroke();
}

function header(ctx, t, title, label, total, symbol, chip) {
  const top = PAD_TOP, hh = 124;
  const cy = top + hh / 2;
  // pill
  const wJ = measure(ctx, 'Journal', 'inter', 44, 500), wT = measure(ctx, title, 'inter', 44, 500);
  const pillW = 40 + 38 + 26 + wJ + 26 + 3 + 26 + wT + 48, pillH = 96, px = PAD_X, py = cy - pillH / 2;
  gradBorderBox(ctx, px, py, pillW, pillH, 48, [[0, t.hex], [1, `rgba(${t.a},.14)`]],
    (x, w) => hgrad(ctx, x, x + w, [[0, t.pill], [1, 'rgba(4,10,8,.55)']]));
  let cx = px + 40;
  ctx.save(); ctx.strokeStyle = t.hex; ctx.lineWidth = 2.6 * (38 / 24); ctx.lineCap = 'round'; ctx.beginPath();
  ctx.moveTo(cx + 3 * 38 / 24, cy); ctx.lineTo(cx + 21 * 38 / 24, cy); ctx.moveTo(cx + 19, cy - 19 + 3 * 38 / 24); ctx.lineTo(cx + 19, cy + 19 - 3 * 38 / 24);
  ctx.stroke(); ctx.restore();
  cx += 38 + 26;
  text(ctx, 'Journal', cx, cy - 22, { size: 44, weight: 500, color: '#fff' }); cx += wJ + 26;
  ctx.save(); ctx.shadowColor = 'rgba(255,255,255,.55)'; ctx.shadowBlur = 12 * SCALE; ctx.fillStyle = '#fff'; rr(ctx, cx, cy - 27, 3, 54, 1.5); ctx.fill(); ctx.restore();
  cx += 3 + 26;
  text(ctx, title, cx, cy - 22, { size: 44, weight: 500, fill: (l, w) => hgrad(ctx, l, l + w, [[0, '#fff'], [1, t.t1]]) });
  // total block (right aligned)
  const blockTop = top + (hh - (17 + 14 + 92)) / 2;
  text(ctx, label, W - PAD_X, blockTop, { kind: 'mono', size: 17, color: 'rgba(255,255,255,.5)', align: 'right', ls: 5.1 });
  const val = formatDollars(total, { symbol });
  const vw = glowText(ctx, val, W - PAD_X, blockTop + 17 + 14, { size: 92, weight: 800, align: 'right', ls: -1.84, fill: (l, w) => hgrad(ctx, l, l + w, [[0, '#fff'], [1, t.t1]]) }, t.a, 0.45, 28);
  if (chip) { // weekend chip left of the value
    const label2 = `+ WEEKEND ${formatDollars(chip, { symbol })}`;
    const cw = measure(ctx, label2, 'inter', 17, 600, 2.4) + 44, chx = W - PAD_X - vw - 34 - cw, chy = cy - 8;
    const o = chip > 0 ? OUT.win : chip < 0 ? OUT.loss : OUT.be;
    gradBorderBox(ctx, chx, chy, cw, 46, 23, [[0, `rgba(${o},.95)`], [1, `rgba(${o},.22)`]], () => CARD_BG);
    text(ctx, label2, chx + 22, chy + 23 - 8.5, { size: 17, weight: 600, color: `rgb(${o})`, ls: 2.4 });
  }
}

function statusPill(ctx, o, x, y, label) {
  const c = OUT[o], lw = measure(ctx, label, 'inter', 17, 600, 2.38);
  const w = 18 + 22 + 14 + 2 + 14 + lw + 22, h = 46;
  gradBorderBox(ctx, x, y, w, h, 23, [[0, `rgba(${c},.95)`], [1, `rgba(${c},.22)`]], () => '#05070c');
  icon(ctx, o, x + 18 + 11, y + h / 2, 22, `rgb(${c})`);
  ctx.fillStyle = '#fff'; ctx.fillRect(x + 18 + 22 + 14, y + h / 2 - 11, 2, 22);
  text(ctx, label, x + 18 + 22 + 14 + 2 + 14, y + h / 2 - 8.5, { size: 17, weight: 600, color: '#fff', ls: 2.38 });
}

/** cumulative line chart. pts: [{x, v}] in canvas coords; labelAll draws every value, otherwise only the last */
function curve(ctx, t, top, height, pts, { labelAll, caption, x0 = PAD_X, x1 = W - PAD_X, symbol }) {
  const base = top + height - 26, ytop = top + 44;
  const vals = pts.map((p) => p.v), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), rng = hi - lo || 1;
  const Y = (v) => base - ((v - lo) / rng) * (base - ytop);
  const zero = Y(0), ys = vals.map(Y);
  text(ctx, caption, x0, top + 16 - 16 * 0.86 + 0, { kind: 'mono', size: 16, color: 'rgba(255,255,255,.38)', ls: 4 });
  ctx.save(); ctx.setLineDash([6, 8]); ctx.strokeStyle = `rgba(${t.a},.28)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x1, zero); ctx.stroke(); ctx.restore();
  // area
  const minY = Math.min(...ys);
  ctx.beginPath(); ctx.moveTo(pts[0].x, zero); pts.forEach((p, i) => ctx.lineTo(p.x, ys[i])); ctx.lineTo(pts[pts.length - 1].x, zero); ctx.closePath();
  const ag = ctx.createLinearGradient(0, minY, 0, zero); ag.addColorStop(0, `rgba(${t.a},.30)`); ag.addColorStop(1, `rgba(${t.a},0)`);
  ctx.fillStyle = ag; ctx.fill();
  const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, ys[i]) : ctx.moveTo(p.x, ys[i]))); };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.save(); ctx.shadowColor = `rgba(${t.a},.9)`; ctx.shadowBlur = 10 * SCALE; ctx.strokeStyle = `rgba(${t.a},.7)`; ctx.lineWidth = 6; path(); ctx.stroke(); ctx.restore();
  if (pts.length > 1) {
    ctx.strokeStyle = hgrad(ctx, pts[0].x, pts[pts.length - 1].x, [[0, `rgba(${t.a},.45)`], [1, t.t1]]); ctx.lineWidth = 4; path(); ctx.stroke();
  }
  pts.forEach((p, i) => {
    if (!labelAll && i !== pts.length - 1) return;
    ctx.fillStyle = t.hex; ctx.beginPath(); ctx.arc(p.x, ys[i], 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(${t.a},.45)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, ys[i], labelAll ? 13 : 14, 0, Math.PI * 2); ctx.stroke();
    const s = formatDollars(p.v, { symbol });
    text(ctx, s, p.x, ys[i] - 24 - 19 * 0.86 + 0, { kind: 'mono', size: 19, color: t.t1, align: labelAll ? 'center' : 'right' });
  });
}

function statsStrip(ctx, t, top, stats, symbol, valueSize) {
  const n = stats.length, cw = INNER_W / n;
  stats.forEach((s, i) => {
    const x = PAD_X + i * cw, pad = i === 0 ? 0 : 28;
    if (i) { ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(x, top, 1, valueSize === 40 ? 81 : 75); }
    text(ctx, s.k, x + pad, top + 6, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.42)', ls: 3.9 });
    const col = s.tone === 'good' ? '#86efac' : s.tone === 'bad' ? '#fca5a5' : '#fff';
    text(ctx, s.v, x + pad, top + 6 + 15 + 14, { size: valueSize, weight: 600, color: col, ls: -valueSize * 0.01 });
  });
}

function footer(ctx, H) {
  const base = H - PAD_BOTTOM - 6;
  ctx.textBaseline = 'alphabetic'; font(ctx, 'mono', 18); setLS(ctx, 6.12); ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.textAlign = 'left';
  ctx.fillText('NQ \u00b7 ES \u00b7 YM \u2014 NEW YORK', PAD_X, base); setLS(ctx, 0);
  const wT = measure(ctx, 'trades', 'serif', 32, 400, 0, true);
  font(ctx, 'serif', 32, 400, true); ctx.fillStyle = hgrad(ctx, W - PAD_X - wT, W - PAD_X, [[0, '#fff'], [1, '#aab4cf']]);
  ctx.fillText('trades', W - PAD_X - wT, base);
  const wY = measure(ctx, 'YSER', 'inter', 28, 800, -0.28);
  font(ctx, 'inter', 28, 800); setLS(ctx, -0.28); ctx.fillStyle = '#fff'; ctx.fillText('YSER', W - PAD_X - wT - 10 - wY, base); setLS(ctx, 0);
}

/* ------------------------------- WEEKLY ------------------------------- */
const WK = { H: 1000, cardsTop: 220, cardH: 330, gap: 18, chartTop: 580, chartH: 190, statsTop: 790 };

function renderWeekly(week) {
  ensureFonts();
  const t = themeFor(week.total), sym = week.symbol || '$';
  const canvas = createCanvas(W * SCALE, WK.H * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  background(ctx, t, WK.H);
  header(ctx, t, 'Weekly PnL', `WEEK TOTAL \u00b7 ${week.rangeLabel}`, week.total, sym, week.weekend ? week.weekend.pnl : null);

  const cw = (INNER_W - 4 * WK.gap) / 5;
  week.days.forEach((d, i) => {
    const o = outcomeOf(d), c = OUT[o], x = PAD_X + i * (cw + WK.gap), y = WK.cardsTop;
    rr(ctx, x, y, cw, WK.cardH, 30); ctx.fillStyle = CARD_BG; ctx.fill();
    rr(ctx, x, y, cw, WK.cardH, 30); ctx.fillStyle = vgrad(ctx, y, y + WK.cardH, [[0, `rgba(${c},.13)`], [1, `rgba(${c},.025)`]]); ctx.fill();
    rr(ctx, x + 1, y + 1, cw - 2, WK.cardH - 2, 29); ctx.strokeStyle = `rgba(${c},.5)`; ctx.lineWidth = 2; ctx.stroke();
    const ix = x + 2 + 26, iw = cw - 4 - 52, innerTop = y + 2 + 28;
    text(ctx, d.day, ix, innerTop, { kind: 'mono', size: 22, color: `rgb(${c})`, ls: 6.6 });
    text(ctx, d.date, ix + iw, innerTop + 22 * 0.86 - 20 * 0.86, { kind: 'mono', size: 20, color: 'rgba(255,255,255,.45)', align: 'right' });
    const free = (WK.cardH - 4 - 28 - 26 - 22 - 58 - 79) / 2;
    const val = o === 'none' ? '\u2014' : formatDollars(d.pnl, { symbol: sym });
    const vs = shrinkText(ctx, val, iw, { kind: 'inter', size: 58, weight: 800, ls: -1.16 });
    const vtop = innerTop + 22 + free + (58 - vs) / 2;
    if (o === 'none') text(ctx, val, ix, vtop, { size: vs, weight: 800, color: 'rgba(255,255,255,.25)', ls: -1.16 });
    else glowText(ctx, val, ix, vtop, { size: vs, weight: 800, color: `rgb(${c})`, ls: -1.16 }, c, 0.35, 30);
    const cbTop = innerTop + 22 + free + 58 + free;
    statusPill(ctx, o, ix, cbTop, LABEL[o]);
    const tally = o === 'none' ? '0 trades' : `${d.w}W \u00b7 ${d.l}L${d.be ? ` \u00b7 ${d.be}BE` : ''}`;
    text(ctx, tally, ix, cbTop + 46 + 14, { kind: 'mono', size: 19, color: 'rgba(255,255,255,.5)', ls: 1.14 });
  });

  let run = 0;
  const pts = week.days.map((d, i) => { run += d.pnl; return { x: PAD_X + i * (cw + WK.gap) + cw / 2, v: run }; });
  curve(ctx, t, WK.chartTop, WK.chartH, pts, { labelAll: true, caption: 'CUMULATIVE PNL', symbol: sym });
  statsStrip(ctx, t, WK.statsTop, week.stats, sym, 40);
  footer(ctx, WK.H);
  return canvas.toBuffer('image/png');
}

/* ------------------------------- MONTHLY ------------------------------- */
function renderMonthly(month) {
  ensureFonts();
  const sym = month.symbol || '$', t = themeFor(month.total);
  const cal = []; // Monday-first weeks of date objects
  let cur = DateTime.fromObject({ year: month.year, month: month.month, day: 1 }).startOf('week');
  const last = DateTime.fromObject({ year: month.year, month: month.month, day: 1 }).endOf('month');
  while (cur <= last) { cal.push(Array.from({ length: 7 }, (_, i) => cur.plus({ days: i }))); cur = cur.plus({ weeks: 1 }); }
  const rows = cal.length, CELL_H = 128, GAP = 12;
  const gridTop = 245, gridH = rows * CELL_H + (rows - 1) * GAP;
  const chartTop = gridTop + gridH + 36, chartH = 170, statsTop = chartTop + chartH + 20;
  const H = statsTop + 75 + 78 + PAD_BOTTOM + 40;
  const canvas = createCanvas(W * SCALE, H * SCALE), ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  background(ctx, t, H);
  header(ctx, t, 'Monthly PnL', `MONTH TOTAL \u00b7 ${month.monthLabel}`, month.total, sym, null);

  const unit = (INNER_W - 7 * GAP) / 8.2, colW = [...Array(7).fill(unit), unit * 1.2];
  const colX = []; { let x = PAD_X; colW.forEach((w) => { colX.push(x); x += w + GAP; }); }
  // weekday labels
  ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'WEEKLY'].forEach((n, i) => {
    const col = i === 7 ? t.hex : i > 4 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.55)';
    text(ctx, n, colX[i] + colW[i] / 2 + 2.55, 214, { kind: 'mono', size: 17, color: col, align: 'center', ls: 5.1 });
  });

  let wkNo = 0;
  cal.forEach((week, r) => {
    const y = gridTop + r * (CELL_H + GAP); let wp = 0, wd = 0;
    week.forEach((dt, i) => {
      const x = colX[i], w = colW[i], inMonth = dt.month === month.month;
      if (!inMonth) {
        ctx.save(); ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 2; rr(ctx, x + 1, y + 1, w - 2, CELL_H - 2, 19); ctx.stroke(); ctx.restore();
        text(ctx, String(dt.day), x + 2 + 16, y + 2 + 14, { kind: 'mono', size: 19, color: 'rgba(255,255,255,.14)' });
        return;
      }
      const d = month.data[dt.day], weekend = i > 4, o = d ? outcomeOf(d) : 'none';
      if (d && d.trades) { wp += d.pnl; wd += 1; }
      if (weekend && !(d && d.trades)) {
        rr(ctx, x, y, w, CELL_H, 20); ctx.fillStyle = '#03050a'; ctx.fill();
        ctx.save(); rr(ctx, x, y, w, CELL_H, 20); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,.025)'; ctx.lineWidth = 8;
        for (let k = -CELL_H; k < w + CELL_H; k += 22.6) { ctx.beginPath(); ctx.moveTo(x + k, y + CELL_H); ctx.lineTo(x + k + CELL_H, y); ctx.stroke(); } ctx.restore();
        rr(ctx, x + 1, y + 1, w - 2, CELL_H - 2, 19); ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 2; ctx.stroke();
        text(ctx, String(dt.day), x + 2 + 16, y + 2 + 14, { kind: 'mono', size: 19, color: 'rgba(255,255,255,.22)' });
        return;
      }
      const c = OUT[o];
      rr(ctx, x, y, w, CELL_H, 20); ctx.fillStyle = o === 'none' ? '#04060b' : CARD_BG; ctx.fill();
      if (o !== 'none') { rr(ctx, x, y, w, CELL_H, 20); ctx.fillStyle = vgrad(ctx, y, y + CELL_H, [[0, `rgba(${c},.14)`], [1, `rgba(${c},.03)`]]); ctx.fill(); }
      rr(ctx, x + 1, y + 1, w - 2, CELL_H - 2, 19); ctx.strokeStyle = o === 'none' ? 'rgba(255,255,255,.08)' : `rgba(${c},.45)`; ctx.lineWidth = 2; ctx.stroke();
      text(ctx, String(dt.day), x + 2 + 16, y + 2 + 14, { kind: 'mono', size: 19, color: 'rgba(255,255,255,.5)' });
      const label = o === 'none' ? '\u2014' : o === 'be' ? 'BE' : formatDollars(d.pnl, { symbol: sym });
      const maxW = w - 24, sz = shrinkText(ctx, label, maxW, { kind: 'inter', size: 30, weight: o === 'none' ? 500 : 800, ls: -0.6 });
      const ty = y + CELL_H - 2 - 22 - sz;
      if (o === 'none') text(ctx, label, x + w / 2, ty, { size: sz, weight: 500, color: 'rgba(255,255,255,.2)', align: 'center', ls: -0.6 });
      else glowText(ctx, label, x + w / 2, ty, { size: sz, weight: 800, color: `rgb(${c})`, align: 'center', ls: -0.6 }, c, 0.35, 22);
    });
    // weekly capsule
    wkNo += 1;
    const wo = wd ? (wp > 0 ? 'win' : wp < 0 ? 'loss' : 'be') : 'none', wc = OUT[wo], x = colX[7], w = colW[7];
    gradBorderBox(ctx, x, y, w, CELL_H, 64, [[0, `rgba(${wc},.95)`], [1, `rgba(${wc},.22)`]], () => '#05070c');
    const top0 = y + (CELL_H - 87) / 2, cxm = x + w / 2;
    text(ctx, `WEEK ${wkNo}`, cxm + 2.4, top0, { kind: 'mono', size: 16, color: 'rgba(255,255,255,.55)', align: 'center', ls: 4.8 });
    const wl = wd ? formatDollars(wp, { symbol: sym }) : '\u2014';
    const ws = shrinkText(ctx, wl, w - 40, { kind: 'inter', size: 34, weight: 800, ls: -0.68 });
    text(ctx, wl, cxm, top0 + 27 + (34 - ws) / 2, { size: ws, weight: 800, color: `rgb(${wc})`, align: 'center', ls: -0.68 });
    text(ctx, `${wd} trading day${wd === 1 ? '' : 's'}`, cxm, top0 + 72, { kind: 'mono', size: 15, color: 'rgba(255,255,255,.4)', align: 'center', ls: 0.9 });
  });

  // equity curve (one point per day that has trades)
  const traded = Object.keys(month.data).map(Number).filter((d) => month.data[d].trades > 0).sort((a, b) => a - b);
  let run = 0;
  const vals = traded.map((d) => (run += month.data[d].pnl));
  if (vals.length) {
    const n = vals.length, pts = vals.map((v, i) => ({ x: PAD_X + (n === 1 ? INNER_W : (i * INNER_W) / (n - 1)), v }));
    curve(ctx, t, chartTop, chartH, pts, { labelAll: false, caption: `EQUITY CURVE \u00b7 ${month.monthShort}`, symbol: sym });
  } else {
    text(ctx, `EQUITY CURVE \u00b7 ${month.monthShort}`, PAD_X, chartTop, { kind: 'mono', size: 16, color: 'rgba(255,255,255,.38)', ls: 4 });
    text(ctx, 'No trades logged this month', PAD_X, chartTop + 80, { kind: 'mono', size: 18, color: 'rgba(255,255,255,.3)', ls: 2 });
  }
  statsStrip(ctx, t, statsTop, month.stats, sym, 34);
  footer(ctx, H);
  return canvas.toBuffer('image/png');
}

module.exports = { renderWeekly, renderMonthly, ensureFonts };
