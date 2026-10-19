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
