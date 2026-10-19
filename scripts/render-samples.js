'use strict';
// Renders sample images with the SAME data as assets/reference/*.png so you can eyeball the match.
const fs = require('node:fs');
const path = require('node:path');
const { renderWeekly, renderMonthly } = require('../src/lib/renderer');
const out = path.join(__dirname, '..', 'tmp-samples');
fs.mkdirSync(out, { recursive: true });
const D = (day, date, pnl, trades, w, l, be, missed = 0) => ({ day, date, pnl, trades, w, l, be, missed });
function week(days, label, stats) {
  const total = days.reduce((s, d) => s + d.pnl, 0);
  const trades = days.reduce((s, d) => s + d.trades, 0), wins = days.reduce((s, d) => s + d.w, 0), losses = days.reduce((s, d) => s + d.l, 0), be = days.reduce((s, d) => s + d.be, 0);
  const best = days.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const f = (v) => (v > 0 ? `+$${v.toLocaleString('en-US')}` : v < 0 ? `\u2212$${Math.abs(v).toLocaleString('en-US')}` : '$0');
  return { kind: 'weekly', weekNo: 42, rangeLabel: label, days, weekend: null, total, symbol: '$', stats: [
    { k: 'WIN RATE', v: `${Math.round(100 * wins / trades)}%` }, { k: 'TRADES', v: String(trades) }, { k: 'W \u00b7 L \u00b7 BE', v: `${wins} \u00b7 ${losses} \u00b7 ${be}` },
    { k: 'MISSED', v: String(days.reduce((s, d) => s + d.missed, 0)) }, { k: 'BEST DAY', v: f(best.pnl), tone: best.pnl > 0 ? 'good' : 'bad' } ] };
}
fs.writeFileSync(path.join(out, 'weekly-green.png'), renderWeekly(week([D('MON', 'Oct 12', 1240, 3, 2, 1, 0), D('TUE', 'Oct 13', -480, 2, 0, 2, 0, 1), D('WED', 'Oct 14', 0, 1, 0, 0, 1), D('THU', 'Oct 15', 2150, 3, 3, 0, 0, 1), D('FRI', 'Oct 16', 420, 2, 2, 0, 0)], 'OCT 12 \u2013 16, 2026')));
fs.writeFileSync(path.join(out, 'weekly-red.png'), renderWeekly(week([D('MON', 'Oct 12', -620, 2, 0, 2, 0), D('TUE', 'Oct 13', 350, 2, 1, 1, 0, 1), D('WED', 'Oct 14', -910, 3, 1, 2, 0), D('THU', 'Oct 15', 0, 1, 0, 0, 1, 1), D('FRI', 'Oct 16', -180, 1, 0, 1, 0)], 'OCT 12 \u2013 16, 2026')));
const sep = { 1: [820, 2], 2: [-310, 1], 3: [1450, 3], 7: [240, 1], 8: [-690, 2], 9: [1980, 3], 10: [0, 1], 11: [530, 2], 14: [-420, 2], 15: [1100, 2], 16: [-260, 1], 17: [2310, 3], 21: [380, 1], 22: [-540, 2], 23: [760, 2], 24: [-180, 1], 25: [1620, 3], 28: [910, 2], 29: [-370, 1], 30: [1240, 2] };
const data = {}; for (const [d, [p, n]] of Object.entries(sep)) data[d] = { pnl: p, trades: n, w: p > 0 ? n : 0, l: p < 0 ? n : 0, be: p === 0 ? n : 0, missed: 0 };
const total = Object.values(data).reduce((s, d) => s + d.pnl, 0);
fs.writeFileSync(path.join(out, 'monthly.png'), renderMonthly({ kind: 'monthly', year: 2026, month: 9, monthLabel: 'SEPTEMBER 2026', monthShort: 'SEP', data, total, symbol: '$', stats: [
  { k: 'WIN RATE', v: '60%' }, { k: 'G \u00b7 R \u00b7 BE', v: '12 \u00b7 7 \u00b7 1' }, { k: 'BEST DAY', v: '+$2,310', tone: 'good' }, { k: 'WORST DAY', v: '\u2212$690', tone: 'bad' }, { k: 'AVG / DAY', v: '+$529' }, { k: 'MISSED', v: '5' } ] }));
console.log('rendered to', out);
