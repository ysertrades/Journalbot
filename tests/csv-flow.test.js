'use strict';
// The whole CSV import: upload in the journal panel -> preview -> import ->
// posts land in each outcome's destination, PnL is recorded, and uploading
// the same file again imports nothing twice.
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `csvflow-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const db = require('../src/lib/db');
const { journalPanel } = require('../src/lib/panels');
const { JournalModals } = require('../src/interaction-handlers/journal-modals');
const { JournalComponents } = require('../src/interaction-handlers/journal-components');

const CSV = [
  'symbol,side,quantity,entry_price,entry_time,exit_price,exit_time,pnl,fee,commission',
  'NQ,long,1,21480,2026-10-15T13:31:00Z,21510,2026-10-15T13:45:00Z,600,1.00,1.00',
  'ES,short,1,5912,2026-10-15T14:02:00Z,5920,2026-10-15T14:10:00Z,-400,1.00,1.00',
  'YM,long,1,42000,2026-10-15T15:00:00Z,42000,2026-10-15T15:05:00Z,0,0,0',
].join('\n');

// win and loss forums create new posts; breakeven goes into an existing post
function fakeGuild(log) {
  const forum = (id) => ({ id, type: ChannelType.GuildForum, availableTags: [], threads: { create: async (o) => { log.push({ forum: id, title: o.name }); return { id: `post-${log.length}`, send: async () => ({}) }; } } });
  const ledger = { id: 'LEDGER', parentId: 'FBE', parent: { type: ChannelType.GuildForum }, isThread: () => true, locked: false, archived: false,
    send: async () => { log.push({ forum: 'FBE', into: 'LEDGER' }); return { id: `msg-${log.length}` }; } };
  const chans = { FW: forum('FW'), FL: forum('FL'), LEDGER: ledger };
  return { id: 'gc', channels: { fetch: async (id) => chans[id] || null }, emojis: { cache: { find: () => undefined } } };
}
const settingsPatch = { outcome_forums: { win: 'FW', loss: 'FL' }, outcome_threads: { be: { forum: 'FBE', thread: 'LEDGER' } } };
const PERM = { has: () => true };
global.fetch = async () => ({ ok: true, text: async () => CSV });

function flattenText(c) { return JSON.stringify(c.toJSON ? c.toJSON() : c); }

test('the journal panel offers a CSV upload below everything', () => {
  const d = db.createDraft({ userId: 'u', guildId: 'gc' }).id;
  const json = journalPanel(db.getDraft(d), { emojis: { cache: { find: () => undefined } } }, db.getSettings('gc')).toJSON();
  const last = json.components[json.components.length - 1];
  assert.match(JSON.stringify(last), /Import trades from a CSV/);
  assert.match(JSON.stringify(last), new RegExp(`jr:${d}:csv`));
});

test('upload -> preview -> import posts each outcome to its place, then a re-upload finds nothing new', async () => {
  db.saveSettings('gc', settingsPatch);
  const log = [], guild = fakeGuild(log), id = db.createDraft({ userId: 'u', guildId: 'gc' }).id;
  let shown;
  const modal = () => ({ customId: `jrm:${id}:csv`, user: { id: 'u' }, guildId: 'gc', guild, memberPermissions: PERM, isFromMessage: () => true,
    fields: { getUploadedFiles: () => ({ first: () => ({ name: 'hyperprop.csv', size: CSV.length, url: 'https://cdn.example/x.csv', contentType: 'text/csv' }) }), getTextInputValue: () => 'Hyperprop' },
    update: async (p) => { shown = p; }, reply: async (p) => { shown = p; } });
  await JournalModals.prototype.run.call(Object.create(JournalModals.prototype), modal(), { type: 'draft', id, kind: 'csv' });
  const preview = flattenText(shown.components[0]);
  assert.match(preview, /Import preview/); assert.match(preview, /Import 3 trades/);
  assert.match(preview, /fees taken off/);

  const edits = [];
  const click = { customId: `jr:${id}:csvgo`, user: { id: 'u' }, guildId: 'gc', guild, memberPermissions: PERM,
    update: async (p) => edits.push(p), editReply: async (p) => edits.push(p), reply: async (p) => edits.push(p) };
  await JournalComponents.prototype.run.call(Object.create(JournalComponents.prototype, { container: { value: { logger: { error: console.error } } } }), click, { id, action: 'csvgo' });
  assert.deepEqual(log.map((l) => l.forum).sort(), ['FBE', 'FL', 'FW']);
  assert.ok(log.find((l) => l.forum === 'FBE').into === 'LEDGER', 'breakeven went into the existing post');
  const final = flattenText(edits.at(-1).components[0]);
  assert.match(final, /Imported 3 trades/);
  const rows = db.pnlBetween('gc', '2026-10-15', '2026-10-15');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.pnl_cents).sort((a, b) => a - b), [-40200, 0, 59800]);   // fees taken off

  // the same file again
  await JournalModals.prototype.run.call(Object.create(JournalModals.prototype), modal(), { type: 'draft', id, kind: 'csv' });
  const again = flattenText(shown.components[0]);
  assert.match(again, /already in your journal/); assert.match(again, /Nothing to import/);
});

test('a non-CSV file is refused back in the panel', async () => {
  const id = db.createDraft({ userId: 'u', guildId: 'gc' }).id;
  let shown;
  const i = { user: { id: 'u' }, guildId: 'gc', guild: { emojis: { cache: { find: () => undefined } } }, memberPermissions: PERM, isFromMessage: () => true,
    fields: { getUploadedFiles: () => ({ first: () => ({ name: 'chart.png', size: 10, url: 'x', contentType: 'image/png' }) }), getTextInputValue: () => '' },
    update: async (p) => { shown = p; } };
  await JournalModals.prototype.run.call(Object.create(JournalModals.prototype), i, { type: 'draft', id, kind: 'csv' });
  assert.match(flattenText(shown.components[0]), /isn't a CSV/);
});

test('a later export: old trades reworded (rounding, no seconds, no fees) are recognised; only the new ones import', async () => {
  // same three trades as CSV above, exported again differently, plus two new trades from the next day
  const LATER = [
    'Symbol;Side;Qty;Entry Price;Entry Time;Exit Price;Exit Time;Net P&L',
    'NQU6;Long;1;21480.00;2026-10-15 09:31;21510.00;2026-10-15 09:45;598.00',
    'ESU6;Short;1;5912.00;2026-10-15 10:02;5920.00;2026-10-15 10:10;(402.00)',
    'YMU6;Long;1;42000;2026-10-15 11:00;42000;2026-10-15 11:05;0',
    'NQU6;Short;2;21600;2026-10-16 09:40;21580;2026-10-16 09:52;800',
    'ESU6;Long;1;5930;2026-10-16 10:20;5926;2026-10-16 10:31;-200',
  ].join('\n');
  global.fetch = async () => ({ ok: true, text: async () => LATER });
  const log = [], guild = fakeGuild(log), id = db.createDraft({ userId: 'u', guildId: 'gc' }).id;
  // one of tomorrow's trades was already journaled by hand with /journal (not imported)
  db.upsertPnl({ thread_id: 'HAND1', container_id: 'HAND1', guild_id: 'gc', forum_id: 'FW', outcome: 'win', pnl_cents: 80000, date_local: '2026-10-16', source: 'bot', updated_at: Date.now() });
  db.insertEntry({ guild_id: 'gc', user_id: 'u', outcome: 'win', instrument: 'NQ', direction: 'Short', session: null, setup: null, entry: null, stop: null, target: null, exit: null,
    r_multiple: null, pnl_cents: 80000, potential_cents: null, followed_plan: null, fields_json: '{}', date_local: '2026-10-16', forum_id: 'FW', thread_id: 'HAND1', message_id: 'HAND1', image_name: null, created_at: Date.now() });
  let shown;
  await JournalModals.prototype.run.call(Object.create(JournalModals.prototype), {
    user: { id: 'u' }, guildId: 'gc', guild, memberPermissions: PERM, isFromMessage: () => true,
    fields: { getUploadedFiles: () => ({ first: () => ({ name: 'week2.csv', size: LATER.length, url: 'x', contentType: 'text/csv' }) }), getTextInputValue: () => '' },
    update: async (p) => { shown = p; } }, { type: 'draft', id, kind: 'csv' });
  const preview = flattenText(shown.components[0]);
  assert.match(preview, /1 new/); assert.match(preview, /3 already imported/); assert.match(preview, /1 already journaled by hand/);
  assert.match(preview, /Last import/); assert.match(preview, /Include 1 hand-logged/);
  assert.match(preview, /Import 1 trade\b/);

  const edits = [], click = (action) => ({ customId: `jr:${id}:${action}`, user: { id: 'u' }, guildId: 'gc', guild, memberPermissions: PERM,
    update: async (p) => edits.push(p), editReply: async (p) => edits.push(p), reply: async (p) => edits.push(p) });
  const self = Object.create(JournalComponents.prototype, { container: { value: { logger: { error: console.error } } } });
  await JournalComponents.prototype.run.call(self, click('csvgo'), { id, action: 'csvgo' });
  assert.equal(log.length, 1, 'only the genuinely new trade was posted');
  assert.match(flattenText(edits.at(-1).components[0]), /Imported 1 trade\b/);
});

test('classifyTrades: a broker trade id survives any change to the row', () => {
  const { readTrades } = require('../src/lib/csv-import');
  const { classifyTrades } = require('../src/interaction-handlers/journal-modals');
  const a = readTrades('trade_id,symbol,side,pnl,exit_time\nT-77,NQ,long,500,2026-09-01 10:00\n', 'America/New_York').trades;
  db.markImported('gid', a[0].keys, 'm1');
  const b = readTrades('trade_id,symbol,side,pnl,exit_time\nT-77,NQ,long,495.5,2026-09-01 10:03:59\n', 'America/New_York').trades;
  assert.equal(classifyTrades('gid', b).dupes, 1);
  const c2 = readTrades('trade_id,symbol,side,pnl,exit_time\nT-78,NQ,long,495.5,2026-09-01 10:03:59\n', 'America/New_York').trades;
  assert.equal(classifyTrades('gid', c2).fresh.length, 1);
});