'use strict';
// The PnL images render for every shape of data the bot can hand them:
// a normal week/month, an empty one, huge numbers and other currencies,
// a single trade, weekend trades, and six-row months.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderWeekly, renderMonthly, renderDaily } = require('../src/lib/renderer');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const size = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
function isPng(buf, minH) {
  assert.ok(Buffer.isBuffer(buf), 'a buffer');
  assert.ok(buf.subarray(0, 8).equals(PNG), 'a PNG');
  const { w, h } = size(buf);
  assert.equal(w, 3200, 'rendered at 2x of 1600');
  assert.ok(h >= minH, `tall enough (${h})`);
}
const day = (d, date, pnl, trades, w = 0, l = 0, be = 0, missed = 0) => ({ day: d, date, pnl, trades, w, l, be, missed });
const NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const week = (vals, extra = {}) => {
  const days = NAMES.map((n, i) => vals[i] || day(n, `Oct ${12 + i}`, 0, 0));
  return { weekNo: 42, rangeLabel: 'OCT 12 – 16, 2026', days, weekend: null, total: days.reduce((s, d) => s + d.pnl, 0), symbol: '$',
    stats: [{ k: 'WIN RATE', v: '50%' }, { k: 'TRADES', v: '2' }, { k: 'W · L · BE', v: '1 · 1 · 0' }, { k: 'MISSED', v: '0' }, { k: 'BEST DAY', v: '+$1', tone: 'good' }], ...extra };
};
const month = (year, m, data) => ({ year, month: m, monthLabel: 'X', monthShort: 'X', symbol: '$', data, total: Object.values(data).reduce((s, d) => s + d.pnl, 0),
  stats: [{ k: 'WIN RATE', v: '—' }, { k: 'G · R · BE', v: '0 · 0 · 0' }, { k: 'BEST DAY', v: '—' }, { k: 'WORST DAY', v: '—' }, { k: 'AVG / DAY', v: '—' }, { k: 'MISSED', v: '0' }] });

test('weekly: a normal week, red and green days', () => {
  isPng(renderWeekly(week([day('MON', 'Oct 12', 1240, 3, 2, 1), day('TUE', 'Oct 13', -480, 2, 0, 2, 0, 1), day('WED', 'Oct 14', 0, 1, 0, 0, 1)])), 1800);
});
test('weekly: nothing logged at all', () => {
  isPng(renderWeekly(week([])), 1800);
});
test('weekly: huge numbers, euro, weekend chip, no week number', () => {
  const w = week([day('MON', 'Dec 28', 1234567, 4, 4), day('TUE', 'Dec 29', -987654, 3, 0, 3)], { symbol: '€', weekNo: undefined, weekend: { pnl: -250, trades: 1, w: 0, l: 1, be: 0, missed: 0 } });
  isPng(renderWeekly(w), 1800);
});
test('weekly: missing stats does not throw', () => {
  isPng(renderWeekly({ ...week([day('MON', 'Oct 12', 5, 1, 1)]), stats: undefined }), 1800);
});
test('monthly: a full month', () => {
  const data = {}; for (let d = 1; d <= 30; d++) if (d % 7 !== 5 && d % 7 !== 6) data[d] = { pnl: (d % 3 - 1) * 100 * d, trades: 1, w: 1, l: 0, be: 0, missed: 0 };
  isPng(renderMonthly(month(2026, 9, data)), 2000);
});
test('monthly: empty, six-row month (August 2026)', () => {
  const buf = renderMonthly(month(2026, 8, {}));
  isPng(buf, 2000);
  assert.ok(size(buf).h > size(renderMonthly(month(2026, 2, {}))).h, 'six rows make a taller image than five');
});
test('monthly: a single trading day', () => {
  isPng(renderMonthly(month(2026, 2, { 17: { pnl: -75, trades: 1, w: 0, l: 1, be: 0, missed: 0 } })), 2000);
});

const dayOf = (trades, extra = {}) => ({ weekday: 'Thursday', dateLabel: 'OCT 15, 2026', symbol: '$', trades, total: trades.reduce((s, t) => s + (t.outcome === 'missed' ? 0 : t.pnl), 0),
  count: trades.filter((t) => t.outcome !== 'missed').length, w: 0, l: 0, be: 0, missed: 0, winRate: null, rSum: null, best: null,
  week: NAMES.map((d, i) => ({ day: d, pnl: i * 100, trades: i ? 1 : 0, today: i === 3 })), weekTotal: 1000, ...extra });
const isCard = (buf) => { assert.ok(buf.subarray(0, 8).equals(PNG)); const { w, h } = size(buf); assert.equal(w, 2160); assert.equal(h, 2700); };
test('daily: a 4:5 card for a normal day', () => {
  isCard(renderDaily(dayOf([{ outcome: 'win', pnl: 1240, instrument: 'NQ', direction: 'Long', r: 2.5, setup: 'sweep' }, { outcome: 'loss', pnl: -310, instrument: 'ES', direction: 'Short', r: -1 }, { outcome: 'missed', pnl: 0, potential: 900 }])));
});
test('daily: empty, missed-only, many trades and odd data still render 4:5', () => {
  isCard(renderDaily(dayOf([])));
  isCard(renderDaily(dayOf([{ outcome: 'missed', pnl: 0 }])));
  isCard(renderDaily(dayOf(Array.from({ length: 14 }, (_, i) => ({ outcome: i % 2 ? 'loss' : 'win', pnl: i % 2 ? -50 : 120, instrument: 'A very long instrument name here' }))))); 
  isCard(renderDaily({ trades: undefined, week: undefined }));
  isCard(renderDaily(dayOf([{ outcome: 'win', pnl: 1234567 }], { symbol: '€', weekday: 'Wednesday' })));
});
