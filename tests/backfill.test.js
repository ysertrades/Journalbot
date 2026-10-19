'use strict';
// Trades imported before the journal kept time, size and hold time: the ledger
// reads what it can from the post's note, and re-uploading the CSV fills the rest
// in without importing anything twice.
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `backfill-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/lib/db');
const { readTrades, toFields, durationMs } = require('../src/lib/csv-import');
const { tradesData } = require('../src/lib/pnl');
const { classifyTrades } = require('../src/interaction-handlers/journal-modals');
const TZ = 'America/New_York';

const CSV = [
  'symbol,side,quantity,entry_price,entry_time,exit_price,exit_time,pnl',
  'NQ,long,2,29872.88,2026-10-19T13:36:00Z,29893,2026-10-19T13:42:12Z,797',
].join('\n');

test('hold-time cells in every common shape', () => {
  assert.equal(durationMs('00:13:05'), 785000);
  assert.equal(durationMs('13:05'), 785000);
  assert.equal(durationMs('1.02:00:00'), 93600000);
  assert.equal(durationMs('1h 2m 3s'), 3723000);
  assert.equal(durationMs('13 min'), 780000);
  assert.equal(durationMs('785'), 785000);
  assert.equal(durationMs(''), null); assert.equal(durationMs('n/a'), null); assert.equal(durationMs('0'), null);
});

test('a duration column gives the hold and open time, without changing the trade’s identity', () => {
  const plain = readTrades('symbol,exit_time,pnl\nNQ,2026-10-19T13:42:12Z,797', TZ).trades[0];
  const withDur = readTrades('symbol,exit_time,duration,pnl\nNQ,2026-10-19T13:42:12Z,00:06:12,797', TZ).trades[0];
  assert.equal(withDur.held, '6m 12s');
  assert.equal(withDur.opened, Date.parse('2026-10-19T13:36:00Z'));
  assert.deepEqual(withDur.keys, plain.keys);        // a file exported before and after this change still dedupes
  // a date-only file has no real time: none is invented
  const dayOnly = readTrades('symbol,date,pnl\nNQ,2026-10-19,797', TZ).trades[0];
  assert.equal(toFields(dayOnly)._at, undefined);
  assert.ok(toFields(withDur)._at);
});

test('an older import shows size and hold from its note, and a re-upload fills time, size and hold', () => {
  const [t] = readTrades(CSV, TZ).trades;
  // the way trades were stored before: no _at / _qty / _held, details only in the note
  const old = { instrument: 'NQ', direction: 'Long', date: t.date, entry: t.entry, exit: t.exit, pnl_cents: t.pnl_cents, setup: '100K eval', why: 'Imported · 2 contracts · exit 29893 · held 6m 12s' };
  db.insertEntry({ guild_id: 'gb', user_id: 'u', outcome: 'win', instrument: 'NQ', direction: 'Long', session: null, setup: '100K eval', entry: t.entry, stop: null, target: null, exit: t.exit,
    r_multiple: null, pnl_cents: t.pnl_cents, potential_cents: null, followed_plan: null, fields_json: JSON.stringify(old), date_local: t.date, forum_id: 'F', thread_id: 'P1', message_id: 'P1', image_name: null, created_at: 1 });
  db.upsertPnl({ thread_id: 'P1', container_id: 'P1', guild_id: 'gb', forum_id: 'F', outcome: 'win', pnl_cents: t.pnl_cents, date_local: t.date, source: 'bot' });
  db.markImported('gb', t.keys, 'P1');

  let row = tradesData('gb', 'day', TZ, '$', t.date).trades[0];
  assert.equal(row.qty, 2); assert.equal(row.held, '6m 12s'); assert.equal(row.time, null);

  const { fresh, imported } = classifyTrades('gb', readTrades(CSV, TZ).trades);
  assert.equal(fresh.length, 0); assert.equal(imported.length, 1);
  assert.equal(db.backfillImported('gb', imported), 1);
  row = tradesData('gb', 'day', TZ, '$', t.date).trades[0];
  assert.equal(row.time, '09:36'); assert.equal(row.qty, 2); assert.equal(row.held, '6m 12s');
  assert.equal(db.backfillImported('gb', imported), 0);      // nothing left to fill: a third upload changes nothing
  // what was already stored is never overwritten
  const f = JSON.parse(db.editableTrades('gb')[0].fields_json);
  assert.equal(f.why, old.why); assert.equal(f.setup, '100K eval');
});
