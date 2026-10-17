'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `dest-${process.pid}.sqlite`);
process.env.OWNER_ID = 'u1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType } = require('discord.js');
const db = require('../src/lib/db');
const { routeTarget, ledgerThreads, allForums } = require('../src/lib/routing');
const { postJournal } = require('../src/lib/poster');
const { scanLedger, scanLedgerMessage, scanGuild } = require('../src/lib/scanner');
const { pickPanel } = require('../src/lib/panels');
const { handleSettings } = require('../src/interaction-handlers/settings-components');
const { JournalComponents } = require('../src/interaction-handlers/journal-components');

const S = (o) => ({ ...db.DEFAULTS, ...o });

test('routing priority: existing post > outcome forum > default forum', () => {
  const s = S({ default_forum_id: 'DEF', outcome_forums: { loss: 'LF' }, outcome_threads: { win: { thread: 'T1', forum: 'F1' } } });
  assert.deepEqual(routeTarget(s, 'win'), { forumId: 'F1', threadId: 'T1' });
  assert.deepEqual(routeTarget(s, 'loss'), { forumId: 'LF', threadId: null });
  assert.deepEqual(routeTarget(s, 'be'), { forumId: 'DEF', threadId: null });
  assert.deepEqual(ledgerThreads(s), { T1: ['win'] });
  assert.deepEqual(allForums(s).sort(), ['DEF', 'F1', 'LF']);
});

test('existing-post destinations persist; clearing one removes it', () => {
  db.saveSettings('gd', { outcome_threads: { win: { thread: 'T1', forum: 'F1' }, loss: { thread: 'T2', forum: 'F1' } } });
  assert.deepEqual(db.getSettings('gd').outcome_threads.loss, { thread: 'T2', forum: 'F1' });
  db.saveSettings('gd', { outcome_threads: { ...db.getSettings('gd').outcome_threads, loss: null } });
  assert.deepEqual(Object.keys(db.getSettings('gd').outcome_threads), ['win']);
});

const draftFor = (o, extra = {}) => ({ id: 'd', userId: 'u1', guildId: 'g1', forumId: 'F1', outcome: o, image: null,
  fields: { instrument: 'NQ', direction: 'Long', date: '2026-10-14', pnl_cents: o === 'loss' ? -30000 : 125000, _thread: 'T1', ...extra } });

function fakeThread(over = {}) {
  const sent = [];
  const t = { id: 'T1', parentId: 'F1', parent: { type: ChannelType.GuildForum }, archived: false, locked: false, isThread: () => true, sent,
    send: async (p) => { const m = { id: `M${sent.length + 1}`, content: p.content || '' }; sent.push(p); return m; },
    setArchived: async () => { t.archived = false; t.reopened = true; }, ...over };
  return t;
}
const guildWith = (t) => ({ id: 'g1', emojis: { cache: { find: () => undefined } }, channels: { fetch: async (id) => (id === 'T1' ? t : null) } });

test('postJournal adds the trade to the existing post instead of creating a new one, keyed by the new message', async () => {
  const t = fakeThread();
  const res = await postJournal({ guild: guildWith(t), draft: draftFor('win'), settings: S({}) });
  assert.equal(res.existing, true); assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].flags, 32768);
  assert.ok(!JSON.stringify(t.sent[0].components).includes('_thread'));
  const row = db.getPnlEntry('M1');
  assert.equal(row.container_id, 'T1'); assert.equal(row.forum_id, 'F1'); assert.equal(row.pnl_cents, 125000); assert.equal(row.outcome, 'win');
});

test('a second trade in the same post gets its own entry; archived posts are reopened; locked posts are refused', async () => {
  const t = fakeThread({ archived: true });
  t.send = async (p) => ({ id: `N${Math.random()}` , content: '' });
  await postJournal({ guild: guildWith(t), draft: draftFor('loss'), settings: S({}) });
  assert.equal(t.reopened, true);
  assert.equal(db.pnlKeysForContainer('T1').length >= 2, true);
  await assert.rejects(postJournal({ guild: guildWith(fakeThread({ locked: true })), draft: draftFor('win'), settings: S({}) }), /locked/);
  await assert.rejects(postJournal({ guild: guildWith(null), draft: draftFor('win'), settings: S({}) }), /no longer exists/);
});

// ---- scanning trades inside a destination post ----
const msg = (id, text, ts) => ({ id, createdTimestamp: ts, content: text, components: [] });
const coll = (arr) => new Collection(arr.map((m) => [m.id, m]));
function ledgerThread(messages) {
  const all = messages.slice().sort((a, b) => b.createdTimestamp - a.createdTimestamp);   // newest first like Discord
  return { id: 'L1', parentId: 'F2', guildId: 'g1', messages: { fetch: async ({ limit, before }) => {
    const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
    return coll(all.slice(start, start + limit));
  } } };
}
test('scanLedger reads one entry per trade message, ignores chatter, honours the post outcome, and drops deleted messages', async () => {
  const s = S({ timezone: 'America/New_York', outcome_threads: { loss: { thread: 'L1', forum: 'F2' } } });
  const ms = [
    msg('a1', '## LOSS\n-# 13 Oct 2026\nPNL: 480', Date.parse('2026-10-13T15:00:00Z')),
    msg('a2', 'nice trade bro', Date.parse('2026-10-13T16:00:00Z')),
    msg('a3', '- PNL: 120', Date.parse('2026-10-14T15:00:00Z')),            // no heading: the post is the Loss destination
    msg('a4', 'PNL: -75', Date.parse('2026-10-15T15:00:00Z')),
  ];
  const t = ledgerThread(ms);
  const r = await scanLedger(t, s);
  assert.equal(r.updated, 3);
  assert.equal(db.getPnlEntry('a1').pnl_cents, -48000); assert.equal(db.getPnlEntry('a1').date_local, '2026-10-13');
  assert.equal(db.getPnlEntry('a3').pnl_cents, -12000); assert.equal(db.getPnlEntry('a3').outcome, 'loss');
  assert.equal(db.getPnlEntry('a4').pnl_cents, -7500);
  assert.equal(db.getPnlEntry('a2'), undefined);
  assert.equal(db.getPnlEntry('a1').container_id, 'L1');
  // a trade is deleted while the bot was offline
  const r2 = await scanLedger(ledgerThread(ms.filter((m) => m.id !== 'a3')), s);
  assert.equal(r2.removed, 1); assert.equal(db.getPnlEntry('a3'), undefined);
  // an edit is picked up message by message
  scanLedgerMessage(t, msg('a4', 'PNL: -90', Date.parse('2026-10-15T15:00:00Z')), s, { force: true });
  assert.equal(db.getPnlEntry('a4').pnl_cents, -9000);
});

test('a Missed destination post only counts messages that are explicitly missed trades', async () => {
  const s = S({ outcome_threads: { missed: { thread: 'L9', forum: 'F2' } } });
  const t = { ...ledgerThread([msg('m1', 'random chat', 1), msg('m2', '## MISSED\nPOTENTIAL: 900', 2)]), id: 'L9' };
  await scanLedger(t, s);
  assert.equal(db.getPnlEntry('m1'), undefined);
  assert.equal(db.getPnlEntry('m2').outcome, 'missed'); assert.equal(db.getPnlEntry('m2').pnl_cents, 0);
});

test('scanGuild scans destination posts message by message and keeps their entries when listing the forum', async () => {
  const s = S({ forums: [], outcome_threads: { win: { thread: 'L5', forum: 'F5' } } });
  const t = { ...ledgerThread([msg('w1', '## WIN\nPNL: 500', Date.parse('2026-10-12T15:00:00Z'))]), id: 'L5', parentId: 'F5', name: 'Wins' };
  const forum = { id: 'F5', type: ChannelType.GuildForum, availableTags: [], threads: { fetchArchived: async () => ({ threads: new Collection(), hasMore: false }) } };
  const guild = { id: 'g1', channels: { fetch: async (id) => (id === 'F5' ? forum : id === 'L5' ? t : null), fetchActiveThreads: async () => ({ threads: new Collection([['L5', t]]) }) } };
  const sum = await scanGuild(guild, s);
  assert.equal(db.getPnlEntry('w1').pnl_cents, 50000);
  assert.equal(sum.errors.length, 0);
  assert.equal((await scanGuild(guild, s)).removed, 0);                 // second pass must not delete ledger entries
  assert.equal(db.getPnlEntry('w1').pnl_cents, 50000);
});

// ---- settings picker ----
test('pickPanel groups posts under the chosen forum, paginates, and stays under 40 components', () => {
  const posts = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `Post ${i + 1}`, archived: i === 3, locked: false }));
  const count = (n) => 1 + (n.components ? n.components.reduce((a, c) => a + count(c), 0) : 0) + (n.accessory ? 1 : 0);
  const p1 = pickPanel({ key: 'win', forumId: '99', posts, page: 0, settings: S({ outcome_threads: { win: { thread: '2', forum: '99' } } }) }).toJSON();
  assert.ok(count(p1) <= 40);
  const j = JSON.stringify(p1);
  assert.ok(j.includes('js:pick:win:thread:99:0') && j.includes('js:pick:win:page:99:1') && j.includes('<#99>'));
  const opts = JSON.parse(j) && (function find(n) { if (n.options) return n.options; for (const c of n.components || []) { const r = find(c); if (r) return r; } return null; })(p1);
  assert.equal(opts.length, 25); assert.ok(opts.find((o) => o.value === '2').default === true);
  assert.ok(opts.every((o) => o.label.length <= 100 && o.label.length >= 1));
  const noForum = JSON.stringify(pickPanel({ key: 'win', forumId: null, posts: [], page: 0, settings: S({}) }).toJSON());
  assert.ok(!noForum.includes('js:pick:win:thread'));
});

function fakeSettingsI(customId, values = []) {
  const calls = [];
  const forum = { id: 'F1', type: ChannelType.GuildForum, availableTags: [], threads: { fetchArchived: async () => ({ threads: new Collection(), hasMore: false }) } };
  const t1 = { id: 'T1', name: 'Wins', parentId: 'F1', archived: false, locked: false, createdTimestamp: 2 }, t2 = { id: 'T2', name: 'Losses', parentId: 'F1', archived: true, locked: false, createdTimestamp: 1 };
  return { calls, customId, values, guildId: 'gp', user: { id: 'u1' }, memberPermissions: { has: () => true },
    guild: { id: 'gp', channels: { fetch: async (id) => (id === 'F1' ? forum : null), fetchActiveThreads: async () => ({ threads: new Collection([['T1', t1]]) }) } },
    deferUpdate: async () => calls.push(['defer']), editReply: async (p) => { calls.push(['edit', p]); }, isFromMessage: () => true };
}
test('settings flow: Choose -> pick forum -> pick post saves the destination; New post each time and Clear work', async () => {
  const run = async (id, values) => { const i = fakeSettingsI(id, values); await handleSettings(i); return i; };
  let i = await run('js:outcomes:edit:win');
  assert.match(JSON.stringify(i.calls.at(-1)[1].components[0].toJSON()), /js:pick:win:forum/);
  i = await run('js:pick:win:forum', ['F1']);
  assert.match(JSON.stringify(i.calls.at(-1)[1].components[0].toJSON()), /js:pick:win:thread:F1:0/);       // posts of that forum are listed
  await run('js:pick:win:thread:F1:0', ['T1']);
  assert.deepEqual(db.getSettings('gp').outcome_threads.win, { thread: 'T1', forum: 'F1' });
  await run('js:pick:loss:new:F1');
  assert.equal(db.getSettings('gp').outcome_forums.loss, 'F1');
  await run('js:pick:win:clear');
  assert.equal(db.getSettings('gp').outcome_threads.win, undefined);
  assert.equal(db.getSettings('gp').outcome_forums.loss, 'F1');                                              // unrelated outcome untouched
});

test('/journal: choosing an outcome targets its existing post; a manual forum pick overrides it', async () => {
  db.saveSettings('gj', { default_forum_id: 'DEF', outcome_threads: { win: { thread: 'T9', forum: 'F9' } } });
  const d = db.createDraft({ userId: 'u1', guildId: 'gj', forumId: 'DEF' });
  const click = (action, arg, values) => JournalComponents.prototype.run.call({ container: { logger: { error() {} } } },
    { user: { id: 'u1' }, guildId: 'gj', guild: { emojis: { cache: { find: () => undefined } } }, memberPermissions: { has: () => true }, values, update: async () => {} }, { id: d.id, action, arg });
  await click('o', 'win');
  assert.equal(db.getDraft(d.id).fields._thread, 'T9'); assert.equal(db.getDraft(d.id).forumId, 'F9');
  await click('o', 'loss');
  assert.equal(db.getDraft(d.id).fields._thread, undefined); assert.equal(db.getDraft(d.id).forumId, 'DEF');
  await click('o', 'win'); await click('forum', undefined, ['OTHER']);
  assert.equal(db.getDraft(d.id).fields._thread, undefined); assert.equal(db.getDraft(d.id).forumId, 'OTHER');
});
