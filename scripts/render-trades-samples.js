'use strict';
// Renders sample /trades ledgers (today, a week, a long month, empty) to tmp-samples/.
const fs = require('node:fs'), path = require('node:path');
const { renderTrades } = require('../src/lib/renderer');
const out = path.join(__dirname, '..', 'tmp-samples'); fs.mkdirSync(out, { recursive: true });
const T = (date, time, instrument, direction, outcome, pnl, extra = {}) => ({ key: `${date}${time}${instrument}`, date, time, instrument, direction, outcome, pnl, r: null, qty: 1, entry: null, exit: null, held: null, setup: null, ...extra });
function data(range, lead, label, trades) {
  const c = trades.filter((t) => t.outcome !== 'missed'), w = c.filter((t) => t.pnl > 0), l = c.filter((t) => t.pnl < 0);
  const sum = (x) => x.reduce((s, t) => s + t.pnl, 0);
  let streak = 0, run = 0; for (const t of c) { run = t.pnl > 0 ? run + 1 : 0; streak = Math.max(streak, run); }
  const by = {}; for (const t of c) { (by[t.instrument] ||= { symbol: t.instrument, n: 0, pnl: 0 }); by[t.instrument].n++; by[t.instrument].pnl += t.pnl; }
  const rs = c.filter((t) => typeof t.r === 'number');
  return { range, lead, label, symbol: '$', trades, count: c.length, w: w.length, l: l.length, be: c.length - w.length - l.length, missed: trades.length - c.length,
    net: sum(c), grossWin: sum(w), grossLoss: sum(l), winRate: c.length ? Math.round(100 * w.length / c.length) : null,
    profitFactor: sum(l) ? sum(w) / Math.abs(sum(l)) : (sum(w) ? Infinity : null), avgWin: w.length ? sum(w) / w.length : null, avgLoss: l.length ? sum(l) / l.length : null,
    best: c.length ? c.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null, streak, rSum: rs.length ? rs.reduce((s, t) => s + t.r, 0) : null,
    symbols: Object.values(by).sort((a, b) => b.n - a.n).slice(0, 4),
    longs: { n: c.filter((t) => t.direction === 'Long').length }, shorts: { n: c.filter((t) => t.direction === 'Short').length } };
}
const today = [
  T('2026-10-15', '09:31', 'NQ', 'Long', 'win', 1240, { r: 2.5, qty: 2, entry: '21480.25', exit: '21510.25', held: '13m 55s', setup: 'London sweep' }),
  T('2026-10-15', '10:02', 'ES', 'Short', 'loss', -310, { r: -1, entry: '5912', exit: '5920', held: '8m 0s', setup: 'Failed breakdown' }),
  T('2026-10-15', '10:44', 'NQ', 'Long', 'missed', 0, { potential: 900, setup: 'Hesitated on retest' }),
  T('2026-10-15', '11:20', 'NQ', 'Long', 'win', 980, { r: 2, qty: 1, entry: '21522', exit: '21571', held: '22m 10s' }),
  T('2026-10-15', '13:05', 'YM', 'Short', 'be', 0, { r: 0, entry: '42010', exit: '42010', held: '4m 2s' }),
];
fs.writeFileSync(path.join(out, 'trades-today.png'), renderTrades(data('day', 'Today', 'THURSDAY, OCT 15', today)).buffer);
const week = [
  T('2026-10-12', '09:40', 'NQ', 'Long', 'win', 620, { qty: 1, entry: '21300', exit: '21331', held: '9m 4s' }), T('2026-10-12', '10:15', 'ES', 'Short', 'win', 600, { qty: 2, entry: '5890', exit: '5884', held: '17m' }),
  T('2026-10-13', '09:33', 'NQ', 'Short', 'loss', -480, { qty: 1, entry: '21410', exit: '21434', held: '3m 50s' }),
  T('2026-10-14', '10:02', 'MNQ', 'Long', 'be', 0, { qty: 5, entry: '21450', exit: '21450', held: '6m' }),
  ...today,
  T('2026-10-16', '09:50', 'ES', 'Long', 'win', 420, { qty: 1, entry: '5925', exit: '5933.4', held: '31m' }),
];
fs.writeFileSync(path.join(out, 'trades-week.png'), renderTrades(data('week', 'This week', 'OCT 12 – 18, 2026', week)).buffer);
const month = []; for (let d = 1; d <= 30; d++) { if ([3, 4, 10, 11, 17, 18, 24, 25].includes(d)) continue; for (let k = 0; k < 2; k++) { const p = ((d * 37 + k * 53) % 13 - 5) * 90; month.push(T(`2026-09-${String(d).padStart(2, '0')}`, `${9 + k}:${(d * 7) % 60 < 10 ? '0' : ''}${(d * 7) % 60}`, ['NQ', 'ES', 'MNQ'][(d + k) % 3], (d + k) % 2 ? 'Short' : 'Long', p > 0 ? 'win' : p < 0 ? 'loss' : 'be', p, { qty: 1 + (d % 3), entry: String(21000 + d * 10), exit: String(21000 + d * 10 + p / 20), held: `${5 + d}m` })); } }
const md = data('month', 'September', 'SEPTEMBER 2026', month);
const r0 = renderTrades(md, 0); fs.writeFileSync(path.join(out, 'trades-month-p1.png'), r0.buffer);
fs.writeFileSync(path.join(out, 'trades-month-last.png'), renderTrades(md, r0.pages - 1).buffer);
fs.writeFileSync(path.join(out, 'trades-empty.png'), renderTrades(data('week', 'This week', 'OCT 19 – 25, 2026', [])).buffer);
console.log('pages in month:', r0.pages);
