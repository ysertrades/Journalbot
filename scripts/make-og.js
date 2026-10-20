'use strict';
/**
 * Draws the link banner (Open Graph image) that Discord, X, iMessage and Slack show under a link to the site.
 *   node scripts/make-og.js        writes src/web/public/img/og.png (1200 x 630)
 * The same palette, fonts and ledger mark as the site and the PnL cards: "the open", 09:30:00.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FD = path.join(__dirname, '..', 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(FD, 'Inter-Medium.ttf'), 'Inter');
GlobalFonts.registerFromPath(path.join(FD, 'Inter-SemiBold.ttf'), 'Inter');
GlobalFonts.registerFromPath(path.join(FD, 'Inter-ExtraBold.ttf'), 'Inter');
GlobalFonts.registerFromPath(path.join(FD, 'JetBrainsMono-Regular.ttf'), 'JB Mono');
GlobalFonts.registerFromPath(path.join(FD, 'InstrumentSerif-Italic.ttf'), 'Instrument Serif');

const W = 1200, H = 630;
const C = { floor: '#0b0c0e', panel: '#131417', panel2: '#191b1f', panel3: '#22252b', line: 'rgba(255,255,255,.08)', line2: 'rgba(255,255,255,.14)',
  ink: '#eeeff2', soft: '#a3a7b0', grey: '#6b707a', win: '#3ccf7a', loss: '#f87171', amber: '#f5b84b' };

const cv = createCanvas(W, H);
let x = cv.getContext('2d');
const ctxSwap = (c) => { x = c; };

const rr = (X, Y, w, h, r) => { x.beginPath(); x.roundRect(X, Y, w, h, r); };
function panel(X, Y, w, h, r = 22, fill = C.panel) {
  x.save(); x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 40; x.shadowOffsetY = 24; rr(X, Y, w, h, r); x.fillStyle = fill; x.fill(); x.restore();
  rr(X + 0.5, Y + 0.5, w - 1, h - 1, r); x.strokeStyle = C.line2; x.lineWidth = 1; x.stroke();
}
const text = (s, X, Y, font, color, o = {}) => { x.font = font; x.fillStyle = color; x.textAlign = o.align || 'left'; x.textBaseline = o.base || 'alphabetic'; if (o.ls) x.letterSpacing = o.ls; x.fillText(s, X, Y); x.letterSpacing = '0px'; return x.measureText(s).width; };

/* ── the floor: flat and dark, an even dot grid; no gradients, no glow ── */
x.fillStyle = C.floor; x.fillRect(0, 0, W, H);
x.fillStyle = 'rgba(255,255,255,.07)';
for (let gy = 14; gy < H; gy += 28) for (let gx = 14; gx < W; gx += 28) { x.beginPath(); x.arc(gx, gy, 1.1, 0, Math.PI * 2); x.fill(); }

/* ── the equity line: one clean stroke from the bottom left up to 09:30:00 ── */
const pts = [[0, 560], [120, 548], [200, 520], [280, 532], [360, 488], [440, 500], [520, 452], [600, 470], [690, 404], [770, 420], [860, 330], [940, 350], [1030, 240], [1100, 200], [1160, 128]];
const curve = () => { x.beginPath(); x.moveTo(...pts[0]); for (let i = 1; i < pts.length; i++) { const [px, py] = pts[i - 1], [qx, qy] = pts[i]; x.bezierCurveTo((px + qx) / 2, py, (px + qx) / 2, qy, qx, qy); } };
curve(); x.strokeStyle = C.win; x.lineWidth = 4; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke();
x.setLineDash([3, 8]); x.beginPath(); x.moveTo(0, 590); x.lineTo(W, 590); x.strokeStyle = C.line2; x.lineWidth = 1; x.stroke(); x.setLineDash([]);
x.beginPath(); x.arc(1160, 128, 17, 0, Math.PI * 2); x.strokeStyle = 'rgba(60,207,122,.45)'; x.lineWidth = 2; x.stroke();
x.beginPath(); x.arc(1160, 128, 8, 0, Math.PI * 2); x.fillStyle = C.win; x.fill();

/* ── the cards, floating at a tilt over the line ── */
function tilted(cx, cy, deg, draw) { x.save(); x.translate(cx, cy); x.rotate((deg * Math.PI) / 180); draw(); x.restore(); }
// win rate
tilted(980, 300, 7, () => {
  panel(-120, -70, 240, 140);
  rr(-96, -71.5, 44, 3, 2); x.fillStyle = C.grey; x.fill();
  text('WIN RATE', -96, -30, '400 13px "JB Mono"', C.grey, { ls: '2px' });
  text('71%', -96, 30, '800 46px Inter', C.ink, { ls: '-2px' });
  x.lineWidth = 10; x.beginPath(); x.arc(64, 0, 34, 0, Math.PI * 2); x.strokeStyle = C.panel3; x.stroke();
  x.beginPath(); x.arc(64, 0, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * 0.71); x.strokeStyle = C.win; x.lineCap = 'round'; x.stroke();
});
// October calendar
tilted(1062, 500, -5, () => {
  panel(-130, -86, 260, 172);
  rr(-106, -87.5, 44, 3, 2); x.fillStyle = C.win; x.fill();
  text('OCTOBER', -106, -48, '400 13px "JB Mono"', C.grey, { ls: '2px' });
  const cells = 'grggg gygrg ggrgg'.replace(/ /g, '');
  [...cells].forEach((c, i) => { const cx = -106 + (i % 5) * 43, cy = -28 + Math.floor(i / 5) * 34; rr(cx, cy, 37, 27, 7);
    x.fillStyle = c === 'g' ? 'rgba(60,207,122,.55)' : c === 'r' ? 'rgba(248,113,113,.55)' : 'rgba(245,184,75,.55)'; x.fill(); });
});
// today, the hero card
tilted(830, 175, -6, () => {
  panel(-150, -78, 300, 156, 24, C.panel2);
  rr(-124, -79.5, 44, 3, 2); x.fillStyle = C.win; x.fill();
  text('TODAY', -124, -38, '400 13px "JB Mono"', C.grey, { ls: '2px' });
  text('+$2,150', -124, 18, '800 50px Inter', C.win, { ls: '-2px' });
  const bars = [30, 45, 38, 62, 55, 78, 70, 100];
  bars.forEach((h, i) => { const bh = 30 * h / 100; rr(-124 + i * 32, 56 - bh, 26, bh, 4); x.fillStyle = i === 2 ? C.loss : C.win; x.globalAlpha = 0.85; x.fill(); x.globalAlpha = 1; });
});
// the import chip
tilted(912, 404, -3, () => {
  x.save(); x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 30; x.shadowOffsetY = 16; rr(-120, -26, 240, 52, 26); x.fillStyle = C.panel2; x.fill(); x.restore();
  rr(-119.5, -25.5, 239, 51, 26); x.strokeStyle = C.line2; x.stroke();
  x.beginPath(); x.arc(-92, 0, 6, 0, Math.PI * 2); x.fillStyle = C.win; x.fill();
  x.beginPath(); x.arc(-92, 0, 11, 0, Math.PI * 2); x.fillStyle = 'rgba(60,207,122,.2)'; x.fill();
  text('Imported 14 trades', -72, 1, '600 19px Inter', C.ink, { base: 'middle' });
});

/* ── the words ── */
// the mark
x.save(); x.translate(72, 64);
rr(0, 0, 64, 64, 18); x.fillStyle = C.panel; x.fill(); rr(0.5, 0.5, 63, 63, 18); x.strokeStyle = C.line2; x.stroke();
x.lineCap = 'round'; x.lineWidth = 5;
for (const [y, w, c] of [[24, 22, C.win], [33, 14, C.ink], [42, 18, 'rgba(238,239,242,.55)']]) { x.beginPath(); x.moveTo(17, y); x.lineTo(17 + w, y); x.strokeStyle = c; x.stroke(); }
x.beginPath(); x.arc(46, 40, 5, 0, Math.PI * 2); x.fillStyle = C.win; x.fill();
x.restore();
let wx = 152 + text('YSER', 152, 107, '800 30px Inter', C.ink, { ls: '-0.5px' });
text('journal', wx + 9, 107, '400 36px "Instrument Serif"', C.soft);

// the clock: the market opens
rr(72, 168, 236, 40, 20); x.fillStyle = 'rgba(60,207,122,.10)'; x.fill(); rr(72.5, 168.5, 235, 39, 20); x.strokeStyle = 'rgba(60,207,122,.35)'; x.stroke();
x.beginPath(); x.arc(96, 188, 5, 0, Math.PI * 2); x.fillStyle = C.win; x.fill();
text('09:30:00 · OPEN', 112, 189, '400 16px "JB Mono"', C.win, { base: 'middle', ls: '2px' });

text('Every trade,', 68, 318, '800 86px Inter', C.ink, { ls: '-4px' });
text('journaled in Discord.', 70, 404, '400 92px "Instrument Serif"', C.soft, { ls: '-1px' });

// what you get, as tags
let tx = 72;
for (const t of ['/journal in 30s', 'CSV import', 'PnL cards', 'Live web journal']) {
  x.font = '600 19px Inter'; const w = x.measureText(t).width + 34;
  rr(tx, 456, w, 44, 22); x.fillStyle = C.panel; x.fill(); rr(tx + 0.5, 456.5, w - 1, 43, 22); x.strokeStyle = C.line2; x.stroke();
  text(t, tx + 17, 479, '600 19px Inter', C.ink, { base: 'middle' }); tx += w + 10;
}

const out = path.join(__dirname, '..', 'src', 'web', 'public', 'img', 'og.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(`wrote ${path.relative(process.cwd(), out)} (${W}x${H}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);

// the home-screen icon for phones (iOS rounds the corners itself): the ledger mark on the floor
{
  const S = 180, ic = createCanvas(S, S), c = ic.getContext('2d'), k = S / 64;
  c.fillStyle = C.floor; c.fillRect(0, 0, S, S);
  c.lineCap = 'round'; c.lineWidth = 5 * k;
  for (const [y, w, col] of [[24, 22, C.win], [33, 14, C.ink], [42, 18, 'rgba(238,239,242,.55)']]) { c.beginPath(); c.moveTo(17 * k, y * k); c.lineTo((17 + w) * k, y * k); c.strokeStyle = col; c.stroke(); }
  c.beginPath(); c.arc(46 * k, 40 * k, 5 * k, 0, Math.PI * 2); c.fillStyle = C.win; c.fill();
  const f = path.join(path.dirname(out), 'icon-180.png'); fs.writeFileSync(f, ic.toBuffer('image/png')); console.log(`wrote ${path.relative(process.cwd(), f)}`);
}
