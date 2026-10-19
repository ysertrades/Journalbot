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
// daily cards (4:5)
const { renderDaily } = require('../src/lib/renderer');
const T = (instrument, direction, outcome, pnl, r, setup, potential = null) => ({ instrument, direction, outcome, pnl, r, setup, potential, at: 0 });
const dayOf = (trades, weekday, dateLabel, week) => {
  const counted = trades.filter((t) => t.outcome !== 'missed');
  const total = counted.reduce((s, t) => s + t.pnl, 0), w = counted.filter((t) => t.pnl > 0).length, l = counted.filter((t) => t.pnl < 0).length;
  const rs = counted.filter((t) => typeof t.r === 'number');
  return { kind: 'daily', symbol: '$', weekday, dateLabel, trades, total, count: counted.length, w, l, be: counted.length - w - l,
    missed: trades.length - counted.length, winRate: counted.length ? Math.round((100 * w) / counted.length) : null,
    rSum: rs.length ? rs.reduce((s, t) => s + t.r, 0) : null, best: counted.length ? counted.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null,
    week, weekTotal: week.reduce((s, d) => s + d.pnl, 0) };
};
const wk = (today, vals) => ['MON', 'TUE', 'WED', 'THU', 'FRI'].map((d, i) => ({ day: d, pnl: vals[i], trades: vals[i] ? 1 : 0, today: i === today }));
fs.writeFileSync(path.join(out, 'daily-green.png'), renderDaily(dayOf([
  T('NQ', 'Long', 'win', 1240, 2.5, 'London open sweep'), T('ES', 'Short', 'loss', -310, -1, 'Failed breakdown'),
  T('NQ', 'Long', 'win', 980, 2, 'NY AM continuation'), T('YM', 'Short', 'win', 240, 0.8, 'Lunch fade'),
], 'Thursday', 'OCT 15, 2026', wk(3, [1240, -480, 0, 2150, 0]))));
fs.writeFileSync(path.join(out, 'daily-red.png'), renderDaily(dayOf([
  T('ES', 'Long', 'loss', -620, -1, 'Chased the open'), T('NQ', 'Short', 'win', 180, 0.6, 'Quick scalp'),
  T('NQ', null, 'missed', 0, null, 'Hesitated on the retest', 1450), T(null, null, 'loss', -540, null, null),
], 'Tuesday', 'OCT 13, 2026', wk(1, [620, -980, 0, 0, 0]))));
// a busy day: dense curve labels and more symbols than the book row fits
const busy = ['NQ', 'NQ', 'ES', 'MNQ', 'NQ', 'CL', 'GC', 'ES', 'NQ', 'RTY', 'NQ', 'YM', 'NQ', 'ES'].map((s, i) => T(s, i % 2 ? 'Short' : 'Long', i % 3 === 2 ? 'loss' : 'win', i % 3 === 2 ? -180 - i * 10 : 120 + i * 35, null, null));
fs.writeFileSync(path.join(out, 'daily-busy.png'), renderDaily(dayOf(busy, 'Wednesday', 'OCT 14, 2026', wk(2, [620, -980, 1890, 0, 0]))));
fs.writeFileSync(path.join(out, 'daily-empty.png'), renderDaily(dayOf([], 'Saturday', 'OCT 17, 2026', wk(-1, [1240, -480, 0, 2150, 420]))));
console.log('rendered to', out);
