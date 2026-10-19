'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `theme-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const db = require('../src/lib/db');
const r = require('../src/lib/renderer');
const { resolveTheme } = require('../src/lib/theme');
const { settingsPanel } = require('../src/lib/panels');
const { handleSettings } = require('../src/interaction-handlers/settings-components');

const day = { kind: 'daily', symbol: '$', weekday: 'Thursday', dateLabel: 'OCT 15, 2026', total: 500, count: 1, w: 1, l: 0, be: 0, missed: 0, winRate: 100,
  trades: [{ instrument: 'NQ', direction: 'Long', outcome: 'win', pnl: 500, at: 0 }], best: { instrument: 'NQ', direction: 'Long', pnl: 500 }, week: [], weekTotal: 500 };
const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'].map((d, i) => ({ day: d, date: `Oct ${12 + i}`, pnl: i ? 100 : -50, trades: 1, w: i ? 1 : 0, l: i ? 0 : 1, be: 0, missed: 0 }));
const week = { weekNo: 42, rangeLabel: 'OCT 12 – 16', days, weekend: null, total: 350, symbol: '$', stats: [{ k: 'WIN RATE', v: '80%' }] };
const trades = { range: 'day', lead: 'Today', label: 'X', symbol: '$', count: 1, w: 1, l: 0, be: 0, missed: 0, net: 500, grossWin: 500, grossLoss: 0, profitFactor: Infinity,
  trades: [{ key: 'k', date: '2026-10-15', outcome: 'win', pnl: 500, instrument: 'NQ', direction: 'Long' }], symbols: [{ symbol: 'NQ', n: 1, pnl: 500 }] };

test('every card draws in both themes, the two differ, and a dark render never leaks into the next light one', () => {
  const light1 = r.renderDaily(day);
  const dark = r.renderDaily(day, { theme: 'dark' });
  const light2 = r.renderDaily(day, { theme: 'light' });
  assert.ok(!light1.equals(dark));
  assert.ok(light1.equals(light2), 'the palette is restored after a dark render');
  for (const [l, d] of [[r.renderWeekly(week), r.renderWeekly(week, { theme: 'dark' })], [r.renderTrades(trades).buffer, r.renderTrades(trades, 0, { theme: 'dark' }).buffer]]) {
    assert.equal(d.readUInt32BE(16), l.readUInt32BE(16)); assert.ok(!l.equals(d));
  }
  assert.ok(r.renderMonthly({ year: 2026, month: 9, monthLabel: 'SEPTEMBER 2026', monthShort: 'SEP', data: { 3: { pnl: 100, trades: 1, w: 1, l: 0, be: 0, missed: 0 } }, total: 100, symbol: '$', stats: [] }, { theme: 'dark' }).length > 1000);
  // an unknown theme falls back to Studio
  assert.ok(r.renderDaily(day, { theme: 'neon' }).equals(light1));
  assert.ok(r.renderThemeSwatch(day, 'auto').length > 1000);
});

test('the theme is stored per server; auto follows the clock in the server’s timezone', () => {
  assert.equal(db.getSettings('gt').theme, 'light');
  db.saveSettings('gt', { theme: 'dark' }); assert.equal(db.getSettings('gt').theme, 'dark');
  db.saveSettings('gt', { theme: 'bogus' }); assert.equal(db.getSettings('gt').theme, 'light');
  db.saveSettings('gt', { currency: '€' }); assert.equal(db.getSettings('gt').theme, 'light');   // other saves keep it
  const s = { theme: 'auto', timezone: 'America/New_York' };
  assert.equal(resolveTheme(s, DateTime.fromISO('2026-10-15T14:00:00', { zone: 'America/New_York' })), 'light');
  assert.equal(resolveTheme(s, DateTime.fromISO('2026-10-15T20:30:00', { zone: 'America/New_York' })), 'dark');
  assert.equal(resolveTheme(s, DateTime.fromISO('2026-10-15T06:59:00', { zone: 'America/New_York' })), 'dark');
  assert.equal(resolveTheme({ theme: 'dark' }), 'dark'); assert.equal(resolveTheme({}), 'light');
});

test('Settings → Appearance shows the preview and the three choices; picking one saves it and redraws', async () => {
  const json = JSON.stringify(settingsPanel('look', { ...db.getSettings('ga'), theme: 'light' }).toJSON());
  for (const k of ['attachment://theme-preview.png', 'js:look:theme_dark', 'js:look:theme_auto', 'js:look:prev_day', 'Studio', 'Night', 'Appearance']) assert.ok(json.includes(k), k);
  let out;
  const i = { customId: 'js:look:theme_dark', guildId: 'ga', user: { id: 'o' }, memberPermissions: { has: () => true }, values: [],
    deferUpdate: async () => {}, editReply: async (p) => { out = p; }, reply: async (p) => { out = p; } };
  await handleSettings(i);
  assert.equal(db.getSettings('ga').theme, 'dark');
  assert.equal(out.files.length, 1); assert.equal(out.files[0].name, 'theme-preview.png');
  assert.ok(JSON.stringify(out.components[0].toJSON()).includes('Night**  ·  in use'));
  // leaving the page drops the preview image
  i.customId = 'js:nav:schedule'; await handleSettings(i);
  assert.deepEqual(out.files, []); assert.deepEqual(out.attachments, []);
});
