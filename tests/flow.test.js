'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `flow-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { ChannelType } = require('discord.js');
const db = require('../src/lib/db');
const { dueJobs } = require('../src/lib/reports');
const { postJournal } = require('../src/lib/poster');
const { scanThread } = require('../src/lib/scanner');
const { journalPanel } = require('../src/lib/panels');
const { JournalModals } = require('../src/interaction-handlers/journal-modals');

const TZ = 'America/New_York';
const base = db.getSettings('g1');
const ny = (s) => DateTime.fromISO(s, { zone: TZ });

test('weekly job is due Friday 17:00, with a 6h catch-up window and stable period key', () => {
  assert.equal(dueJobs(base, ny('2026-10-16T16:59:00')).length, 0);
  const j = dueJobs(base, ny('2026-10-16T17:00:30'));
  assert.deepEqual(j.map((x) => [x.kind, x.key, x.late]), [['weekly', 'weekly:2026-W42', false]]);
  assert.equal(dueJobs(base, ny('2026-10-16T22:30:00'))[0].late, true);
  assert.equal(dueJobs(base, ny('2026-10-16T23:30:00')).length, 0);
  assert.equal(dueJobs(base, ny('2026-10-15T17:00:00')).length, 0);
});

test('month-end job fires only on the last day; weekly and monthly can coincide', () => {
  assert.equal(dueJobs(base, ny('2026-10-30T17:00:00')).filter((j) => j.kind === 'monthly').length, 0);
  const j = dueJobs(base, ny('2026-10-31T17:00:00'));
  assert.deepEqual(j.map((x) => x.key), ['monthly:2026-10']);
  assert.equal(dueJobs({ ...base, month_enabled: false }, ny('2026-10-31T17:00:00')).length, 0);
  // 2026-07-31 is a Friday: both due
  assert.deepEqual(dueJobs(base, ny('2026-07-31T17:00:00')).map((x) => x.kind).sort(), ['monthly', 'weekly']);
});

test('report claims are idempotent and retry at most 3 times', () => {
  assert.equal(db.claimReport('g1', 'weekly', 'k1'), true);
  assert.equal(db.claimReport('g1', 'weekly', 'k1'), false);       // pending: someone else is on it
  db.finishReport('g1', 'weekly', 'k1', { messageId: '1' });
  assert.equal(db.claimReport('g1', 'weekly', 'k1'), false);       // posted: never again
  assert.equal(db.claimReport('g1', 'weekly', 'k2'), true);
  db.finishReport('g1', 'weekly', 'k2', { error: 'x' });
  assert.equal(db.claimReport('g1', 'weekly', 'k2'), true);
  db.finishReport('g1', 'weekly', 'k2', { error: 'x' });
  assert.equal(db.claimReport('g1', 'weekly', 'k2'), true);
  db.finishReport('g1', 'weekly', 'k2', { error: 'x' });
  assert.equal(db.claimReport('g1', 'weekly', 'k2'), false);
});

function fakeGuild(created) {
  const forum = {
    id: 'F1', type: ChannelType.GuildForum, parentId: null,
    availableTags: [{ id: 't-win', name: 'Win' }, { id: 't-loss', name: 'Loss' }],
    threads: { create: async (o) => { created.push(o); return { id: 'T1', send: async () => {}, createdTimestamp: Date.now() }; } },
  };
  return { id: 'g1', forum, channels: { fetch: async (id) => (id === 'F1' ? forum : null) }, emojis: { cache: { find: () => undefined, some: () => false } } };
}

test('postJournal creates a tagged V2 post and records a signed PnL row', async () => {
  const created = [], guild = fakeGuild(created);
  const draft = { id: 'd', userId: 'u1', guildId: 'g1', forumId: 'F1', outcome: 'loss', image: null,
    fields: { instrument: 'NQ', direction: 'Short', date: '2026-10-14', pnl_cents: -48000, r: -1, why: 'sweep' } };
  const res = await postJournal({ guild, draft, settings: base });
  assert.equal(res.tagApplied, true);
  assert.deepEqual(created[0].appliedTags, ['t-loss']);
  assert.match(created[0].name, /480/);
  assert.equal(created[0].message.flags, 32768);
  const row = db.getPnlEntry('T1');
  assert.equal(row.pnl_cents, -48000); assert.equal(row.outcome, 'loss'); assert.equal(row.date_local, '2026-10-14');
});

test('posting a missed trade never counts PnL', async () => {
  const created = [], guild = fakeGuild(created);
  const draft = { id: 'd2', userId: 'u1', guildId: 'g1', forumId: 'F1', outcome: 'missed', image: null,
    fields: { instrument: 'ES', direction: 'Long', date: '2026-10-15', pnl_cents: 0, potential_cents: 90000 } };
  await postJournal({ guild, draft, settings: base });
  assert.equal(db.getPnlEntry('T1').pnl_cents, 0);
  assert.equal(db.getPnlEntry('T1').potential_cents, 90000);
});

test('scanner reads PnL from the starter message, tags win over text, keeps manual edits', async () => {
  const forum = { id: 'F9', type: ChannelType.GuildForum, availableTags: [{ id: 'a', name: 'Loss' }] };
  const mk = (text) => ({ id: 'S1', guildId: 'g1', parent: forum, createdTimestamp: Date.parse('2026-10-13T15:00:00Z'), appliedTags: ['a'],
    fetchStarterMessage: async () => ({ content: '', components: [{ type: 17, components: [{ type: 10, content: text }] }] }) });
  const s = { ...base, forums: ['F9'] };
  assert.equal(await scanThread(mk('## LOSS\n-# 13 Oct 2026\nPNL: 480'), s), 'updated');
  assert.equal(db.getPnlEntry('S1').pnl_cents, -48000);
  assert.equal(await scanThread(mk('## LOSS\n-# 13 Oct 2026\nPNL: 480'), s), 'unchanged');
  assert.equal(await scanThread(mk('no pnl here'), s), 'unparsed');
  assert.equal(db.getPnlEntry('S1'), undefined);
  db.upsertPnl({ thread_id: 'S1', guild_id: 'g1', forum_id: 'F9', outcome: 'win', pnl_cents: 100, date_local: '2026-10-13', source: 'manual' });
  assert.equal(await scanThread(mk('## LOSS\nPNL: 480'), s), 'unchanged');
  assert.equal(db.getPnlEntry('S1').pnl_cents, 100);
});

function fakeModal(draftId, kind, values, selects = {}) {
  let out;
  return { out: () => out, customId: `jrm:${draftId}:${kind}`, user: { id: 'u1' }, guildId: 'g1', guild: { emojis: { cache: { find: () => undefined } } },
    memberPermissions: { has: () => true },
    fields: { getTextInputValue: (k) => values[k] ?? '', getStringSelectValues: (k) => (selects[k] ? [selects[k]] : []) },
    isFromMessage: () => true, update: async (p) => { out = p; } };
}

test('modal flow fills a draft and the panel becomes ready to post', async () => {
  process.env.OWNER_ID = 'u1';
  const settings = db.saveSettings('g1', { default_forum_id: 'F1' });
  const d = db.createDraft({ userId: 'u1', guildId: 'g1', forumId: settings.default_forum_id });
  const run = (i, kind) => JournalModals.prototype.run.call({}, i, { type: 'draft', id: d.id, kind });
  let draft = db.getDraft(d.id); draft.outcome = 'loss'; db.saveDraft(draft);
  await run(fakeModal(d.id, 'trade', { instrument: 'nq', date: '2026-10-14', setup: 'a`b' }, { direction: 'Short', session: 'NY AM' }), 'trade');
  let i = fakeModal(d.id, 'result', { pnl: '$1,250.50', r: '2' }); await run(i, 'result');
  draft = db.getDraft(d.id);
  assert.equal(draft.fields.instrument, 'NQ'); assert.equal(draft.fields.pnl_cents, -125050);   // loss => negative
  assert.equal(draft.fields.r, 2); assert.equal(draft.fields.setup, "a'b");
  await run(fakeModal(d.id, 'result', { pnl: 'abc' }), 'result');
  assert.equal(db.getDraft(d.id).fields.pnl_cents, -125050);                                      // invalid input keeps old value
  const panel = journalPanel(draft, { emojis: { cache: { find: () => undefined } } }, settings).toJSON();
  assert.match(JSON.stringify(panel), /ready to post/);
});
