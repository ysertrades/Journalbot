'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `session-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { DateTime } = require('luxon');
const db = require('../src/lib/db');
const { tradingDay, todayFor, previousDay, presetOf, describe } = require('../src/lib/session');
const { parseDateInput } = require('../src/lib/money');
const { readTrades } = require('../src/lib/csv-import');
const { resolveEntry, parseText } = require('../src/lib/parse');
const { planRedate, redatePanel, applyRedate } = require('../src/lib/redate');
const { settingsPanel } = require('../src/lib/panels');
const { handleSettings } = require('../src/interaction-handlers/settings-components');

const NY = 'America/New_York';
const at = (iso, zone = NY) => DateTime.fromISO(iso, { zone }).toMillis();
const fut = { timezone: NY, session_start: '18:00', session_zone: NY, session_fold: true };
const cal = { timezone: NY, session_start: '00:00', session_zone: NY, session_fold: false };

test('the futures day: 6 PM New York rolls to the next session, weekend evenings are Monday', () => {
  assert.equal(tradingDay(at('2026-10-19T17:59'), fut), '2026-10-19');     // Monday before the roll
  assert.equal(tradingDay(at('2026-10-19T18:00'), fut), '2026-10-20');     // Monday 6 PM opens Tuesday
  assert.equal(tradingDay(at('2026-10-19T19:15'), fut), '2026-10-20');
  assert.equal(tradingDay(at('2026-10-20T00:30'), fut), '2026-10-20');     // after midnight, still Tuesday's session
  assert.equal(tradingDay(at('2026-10-23T18:30'), fut), '2026-10-26');     // Friday evening -> Monday
  assert.equal(tradingDay(at('2026-10-25T18:05'), fut), '2026-10-26');     // Sunday's open is Monday
  assert.equal(tradingDay(at('2026-10-24T12:00'), fut), '2026-10-26');     // a Saturday trade folds into Monday
  // the roll is read on New York's clock even for a server in another timezone
  assert.equal(tradingDay(at('2026-10-20T00:30', 'Europe/Berlin'), { ...fut, timezone: 'Europe/Berlin' }), '2026-10-20');   // 18:30 Mon in New York
  assert.equal(tradingDay(at('2026-10-19T23:30'), cal), '2026-10-19');     // the calendar day stays the calendar day
  assert.equal(tradingDay(at('2026-10-24T12:00'), cal), '2026-10-24');
  assert.equal(previousDay('2026-10-26', fut), '2026-10-23'); assert.equal(previousDay('2026-10-26', cal), '2026-10-25');
  assert.equal(todayFor(fut, DateTime.fromISO('2026-10-19T20:00', { zone: NY })), '2026-10-20');
  assert.equal(presetOf(fut), 'futures'); assert.equal(presetOf(cal), 'calendar'); assert.equal(presetOf({ ...fut, session_start: '17:00' }), 'forex');
  assert.equal(presetOf({ ...fut, session_start: '16:00' }), 'custom');
  assert.match(describe(fut), /6:00 PM New York time/);
});

test('"today" in forms, imports and scanned posts all follow the session', () => {
  assert.equal(parseDateInput('today', NY, { today: '2026-10-20', yesterday: '2026-10-19' }), '2026-10-20');
  assert.equal(parseDateInput('yesterday', NY, { today: '2026-10-26', yesterday: '2026-10-23' }), '2026-10-23');
  assert.equal(parseDateInput('2026-10-14', NY, { today: '2026-10-20' }), '2026-10-14');                   // a typed date is kept
  const csv = 'symbol,exit_time,pnl\nNQ,2026-10-19T23:42:00Z,797\nES,2026-10-19T20:10:00Z,-120';          // 7:42 PM and 4:10 PM New York
  const plain = readTrades(csv, NY).trades, rolled = readTrades(csv, NY, (dt) => tradingDay(dt, fut)).trades;
  assert.deepEqual(rolled.map((t) => `${t.instrument}:${t.date}`).sort(), ['ES:2026-10-19', 'NQ:2026-10-20']);
  assert.deepEqual(rolled.map((t) => t.keys), plain.map((t) => t.keys));                                    // identity unchanged: no re-imports
  assert.equal(readTrades('symbol,date,pnl\nNQ,2026-10-19,797', NY, (dt) => tradingDay(dt, fut)).trades[0].date, '2026-10-19');   // date-only: as written
  const e = resolveEntry(parseText('PNL: +500'), { createdMs: at('2026-10-19T19:00'), tz: NY, dayOf: (ms) => tradingDay(ms, fut) });
  assert.equal(e.date_local, '2026-10-20');
  const written = resolveEntry(parseText('# WIN · NQ Long\n-# 19 Oct 2026\nPNL: +500'), { createdMs: at('2026-10-19T19:00'), tz: NY, dayOf: (ms) => tradingDay(ms, fut) });
  assert.equal(written.date_local, '2026-10-19');                                                         // a date in the post wins
});

// a bot post per trade: V2 messages that can be rewritten, one plain-text one that can't
const edits = [], threads = new Map();
function post(id, v2 = true) {
  const msg = { id, author: { id: 'bot' }, flags: { has: () => v2 }, attachments: new Collection(), edit: async (p) => { edits.push({ id, p }); return { attachments: new Collection() }; } };
  threads.set(id, { id, parentId: 'F', name: 'old', locked: false, archived: false, isThread: () => true, setName: async (n) => n, messages: { fetch: async (m) => (m === id ? msg : null) } });
}
const guild = { id: 'gs', client: { user: { id: 'bot' } }, emojis: { cache: new Collection() }, channels: { fetch: async (id) => threads.get(id) || null } };
function seed(key, date, fields, createdIso, v2 = true) {
  db.insertEntry({ guild_id: 'gs', user_id: 'u', outcome: 'win', instrument: 'NQ', direction: 'Long', session: null, setup: fields.setup || null, entry: null, stop: null, target: null, exit: null,
    r_multiple: null, pnl_cents: 79700, potential_cents: null, followed_plan: null, fields_json: JSON.stringify({ instrument: 'NQ', direction: 'Long', date, pnl_cents: 79700, ...fields }),
    date_local: date, forum_id: 'F', thread_id: key, message_id: key, image_name: null, created_at: at(createdIso) });
  db.upsertPnl({ thread_id: key, container_id: key, guild_id: 'gs', forum_id: 'F', outcome: 'win', pnl_cents: 79700, date_local: date, source: 'bot' });
  post(key, v2);
}

test('Fix past trades: imports and "today" entries after the roll move forward, typed dates stay, posts are rewritten', async () => {
  db.saveSettings('gs', { timezone: NY });
  seed('imp', '2026-10-19', { setup: 'Imported from CSV', why: 'Imported · 1 contract', _at: at('2026-10-19T19:42') }, '2026-10-19T20:00');
  seed('impDay', '2026-10-19', { setup: 'Imported from CSV', why: 'Imported · 1 contract', _at: at('2026-10-19T10:05') }, '2026-10-19T20:00');
  seed('today', '2026-10-19', {}, '2026-10-19T19:05');                          // logged at 7:05 PM as "today"
  seed('typed', '2026-10-16', {}, '2026-10-19T19:05');                          // logged Monday evening for last Friday, on purpose
  seed('plain', '2026-10-19', { setup: 'Imported from CSV', why: 'Imported', _at: at('2026-10-19T21:00') }, '2026-10-19T21:30', false);
  const s = db.getSettings('gs');
  const plan = planRedate('gs', s);
  assert.deepEqual(plan.map((m) => `${m.entry.message_id}:${m.from}->${m.to}`).sort(), ['imp:2026-10-19->2026-10-20', 'plain:2026-10-19->2026-10-20', 'today:2026-10-19->2026-10-20']);
  const preview = JSON.stringify(redatePanel('gs', s, plan).toJSON());
  for (const x of ['3 trades move', 'js:schedule:redate_go', 'Futures session', 'Tue Oct 20']) assert.ok(preview.includes(x), x);
  const progress = [];
  const realFetch = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
  let res; try { res = await applyRedate(guild, s, plan, async (d, t) => progress.push(`${d}/${t}`)); } finally { globalThis.fetch = realFetch; }
  assert.equal(res.moved, 2); assert.equal(res.journalOnly, 1); assert.deepEqual(res.failed, []);
  assert.equal(progress.at(-1), '3/3');
  for (const k of ['imp', 'today', 'plain']) assert.equal(db.getPnlEntry(k).date_local, '2026-10-20', k);
  assert.equal(db.getPnlEntry('plain').source, 'manual');                      // held so a scan can't read the old date back
  assert.equal(db.getPnlEntry('typed').date_local, '2026-10-16'); assert.equal(db.getPnlEntry('impDay').date_local, '2026-10-19');
  assert.ok(edits.some((e) => e.id === 'imp' && JSON.stringify(e.p.components[0].toJSON()).includes('20 Oct 2026')));
  assert.deepEqual(planRedate('gs', db.getSettings('gs')), []);                  // done: a second run finds nothing
  assert.ok(JSON.stringify(redatePanel('gs', s, []).toJSON()).includes('already on its trading day'));
});

test('Settings → Schedule: the trading day with an example, presets save, a custom start, the fix button', async () => {
  const page = JSON.stringify(settingsPanel('schedule', db.getSettings('gt')).toJSON());
  for (const x of ['Trading day', 'counts for **Tuesday**', 'js:schedule:session', 'js:schedule:redate', 'js:schedule:modal_sess']) assert.ok(page.includes(x), x);
  const run = async (customId, values = [], fields) => {
    let out;
    await handleSettings({ customId, guildId: 'gt', guild, user: { id: 'o' }, memberPermissions: { has: () => true }, values, fields,
      deferUpdate: async () => {}, editReply: async (p) => { out = p; }, reply: async (p) => { out = p; }, followUp: async (p) => { out = p; } });
    return out;
  };
  await run('js:schedule:session', ['calendar']);
  assert.equal(db.getSettings('gt').session_start, '00:00'); assert.equal(db.getSettings('gt').session_fold, false);
  assert.ok(JSON.stringify((await run('js:nav:schedule')).components[0].toJSON()).includes('calendar day it was taken'));
  await run('js:schedule:session', ['futures']);
  assert.equal(db.getSettings('gt').session_start, '18:00'); assert.equal(db.getSettings('gt').session_fold, true);
  await run('jsm:schedule:sess', [], { getTextInputValue: () => '16:30' });
  assert.equal(db.getSettings('gt').session_start, '16:30');
  const bad = await run('jsm:schedule:sess', [], { getTextInputValue: () => '7pm' });
  assert.ok(JSON.stringify(bad.components[0].toJSON()).includes('24h time'));
  const fix = await run('js:schedule:redate');
  assert.ok(JSON.stringify(fix.components[0].toJSON()).includes('Fix past trades'));
});
