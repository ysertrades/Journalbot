'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `trades-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/lib/db');
const { tradesData } = require('../src/lib/pnl');
const { renderTrades, tradePages } = require('../src/lib/renderer');
const { tradesMessage, pickerPanel } = require('../src/lib/trades-view');
const { TradesCommand } = require('../src/commands/trades');
const { TradesComponents } = require('../src/interaction-handlers/trades-components');
const TZ = 'America/New_York';

const put = (key, date, outcome, cents, f = {}) => {
  db.upsertPnl({ thread_id: key, container_id: key, guild_id: 'gt', forum_id: 'F', outcome, pnl_cents: cents, potential_cents: f.potential ?? null, date_local: date, source: 'bot', updated_at: f.updated || 1 });
  if (f.instrument) db.insertEntry({ guild_id: 'gt', user_id: 'u', outcome, instrument: f.instrument, direction: f.direction || 'Long', session: null, setup: f.setup || null, entry: f.entry || null, stop: null, target: null, exit: f.exit || null,
    r_multiple: f.r ?? null, pnl_cents: cents, potential_cents: null, followed_plan: null, fields_json: JSON.stringify({ _at: f.at, _qty: f.qty, _held: f.held }), date_local: date, forum_id: 'F', thread_id: key, message_id: key, image_name: null, created_at: 5 });
};
put('a', '2026-10-15', 'win', 124000, { instrument: 'NQ', at: Date.parse('2026-10-15T13:31:00Z'), qty: 2, held: '13m', entry: '21480', exit: '21510', r: 2.5 });
put('b', '2026-10-15', 'loss', -31000, { instrument: 'ES', direction: 'Short', at: Date.parse('2026-10-15T14:02:00Z') });
put('c', '2026-10-15', 'missed', 0, { potential: 90000 });
put('d', '2026-10-13', 'win', 50000, { instrument: 'NQ', at: Date.parse('2026-10-13T13:40:00Z') });
put('e', '2026-10-02', 'loss', -20000, { instrument: 'YM' });          // earlier in the month, another week
put('z', '2026-09-30', 'win', 99900, { instrument: 'NQ' });           // outside October entirely

test('tradesData: day, week and month pick the right trades, in time order, with stats', () => {
  const day = tradesData('gt', 'day', TZ, '$', '2026-10-15');
  assert.deepEqual(day.trades.map((t) => t.key), ['a', 'b', 'c']);
  assert.equal(day.trades[0].time, '09:31'); assert.equal(day.trades[0].qty, 2); assert.equal(day.trades[0].held, '13m');
  assert.equal(day.count, 2); assert.equal(day.missed, 1); assert.equal(day.net, 930); assert.equal(day.winRate, 50);
  assert.equal(day.profitFactor.toFixed(2), '4.00'); assert.equal(day.best.key, 'a');
  const wk = tradesData('gt', 'week', TZ, '$', '2026-10-15');
  assert.deepEqual(wk.trades.map((t) => t.key), ['d', 'a', 'b', 'c']); assert.equal(wk.start, '2026-10-12'); assert.equal(wk.end, '2026-10-18');
  const mo = tradesData('gt', 'month', TZ, '$', '2026-10-15');
  assert.equal(mo.trades.length, 5); assert.equal(mo.lead, 'October'); assert.ok(!mo.trades.some((t) => t.key === 'z'));
  assert.deepEqual(mo.symbols.map((s) => s.symbol).sort(), ['ES', 'NQ', 'YM']);
  const none = tradesData('gt', 'week', TZ, '$', '2026-11-20');
  assert.equal(none.count, 0); assert.equal(none.winRate, null); assert.equal(none.profitFactor, null);
});

test('renderTrades: a PNG for every period, pages clamp, an empty period still draws', () => {
  for (const r of ['day', 'week', 'month']) {
    const out = renderTrades(tradesData('gt', r, TZ, '$', '2026-10-15'));
    assert.ok(out.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))); assert.equal(out.buffer.readUInt32BE(16), 3200);
  }
  const many = { range: 'month', lead: 'X', label: 'X', symbol: '$', count: 40, w: 20, l: 20, be: 0, missed: 0, net: 0, grossWin: 2000, grossLoss: -2000,
    trades: Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, outcome: i % 2 ? 'loss' : 'win', pnl: i % 2 ? -100 : 100 })) };
  assert.equal(tradePages(many), 3);
  assert.equal(renderTrades(many, 99).page, 2); assert.equal(renderTrades(many, -5).page, 0);
  assert.equal(renderTrades({ trades: [] }).pages, 1);
  assert.ok(renderTrades({}).buffer.length > 1000);
});

test('/trades replies privately with the period picker', async () => {
  let reply;
  await TradesCommand.prototype.chatInputRun.call({}, { guild: { id: 'gt' }, guildId: 'gt', user: { id: 'u' }, memberPermissions: { has: () => true }, reply: async (p) => { reply = p; } });
  assert.equal(reply.flags & 64, 64); assert.equal(reply.flags & 32768, 32768);
  const json = JSON.stringify(reply.components[0].toJSON());
  for (const v of ['"day"', '"week"', '"month"', 'tr:range']) assert.ok(json.includes(v), v);
  assert.ok(JSON.stringify(pickerPanel().toJSON()).includes('Choose a period'));
});

test('picking a period acknowledges at once, then shows the ledger image with the picker kept', async () => {
  const self = Object.create(TradesComponents.prototype, { container: { value: { logger: { error: console.error, warn() {} } } } });
  const calls = [];
  const i = { customId: 'tr:range', values: ['week'], guildId: 'gt', guild: { id: 'gt', channels: { fetch: async () => null } }, user: { id: 'u' }, memberPermissions: { has: () => true },
    deferUpdate: async () => calls.push('defer'), editReply: async (p) => calls.push(p), reply: async (p) => calls.push(p) };
  const parsed = TradesComponents.prototype.parse.call({ some: (x) => ({ x }), none: () => null }, i);
  assert.deepEqual(parsed.x, { range: 'week', page: 0, anchor: null, account: null });
  await TradesComponents.prototype.run.call(self, i, parsed.x);
  assert.equal(calls[0], 'defer');
  const last = calls.at(-1);
  assert.equal(last.files.length, 1); assert.deepEqual(last.attachments, []);
  const json = JSON.stringify(last.components[0].toJSON());
  assert.ok(json.includes('attachment://trades-week-')); assert.ok(json.includes('tr:range'));
});

test('page buttons carry everything needed; malformed ids are ignored', () => {
  const parse = (customId) => TradesComponents.prototype.parse.call({ some: (x) => x, none: () => null }, { customId });
  assert.deepEqual(parse('tr:pg:month:2:2026-10-15'), { range: 'month', page: 2, anchor: '2026-10-15', account: null });
  assert.deepEqual(parse('tr:pg:month:2:2026-10-15:7'), { range: 'month', page: 2, anchor: '2026-10-15', account: 7 });
  assert.equal(parse('tr:pg:month:2:2026-10-15:x'), null);
  assert.equal(parse('tr:pg:year:2:2026-10-15'), null);
  assert.equal(parse('tr:pg:month:x:2026-10-15'), null);
  assert.equal(parse('tr:pg:month:1:yesterday'), null);
  assert.equal(parse('tr:noop:month'), null);
  assert.equal(parse('jr:abc:o:win'), null);
  // a month long enough to page shows the buttons, and stays under Discord's 40 components
  for (let k = 0; k < 30; k++) put(`m${k}`, `2026-10-${String(1 + (k % 28)).padStart(2, '0')}`, k % 3 ? 'win' : 'loss', k % 3 ? 10000 : -5000, { instrument: 'NQ' });
  const msg = tradesMessage('gt', db.getSettings('gt'), 'month', 1, '2026-10-15');
  assert.ok(msg.pages > 1); assert.equal(msg.page, 1);
  const json = JSON.stringify(msg.components[0].toJSON());
  assert.ok(json.includes('tr:pg:month:0:2026-10-15')); assert.ok(json.includes('tr:pg:month:2:2026-10-15'));
  const count = (o) => (o && typeof o === 'object' ? (o.type ? 1 : 0) + Object.values(o).reduce((s, v) => s + count(v), 0) : 0);
  assert.ok(count(msg.components[0].toJSON()) <= 40);
});
