'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `routing-${process.pid}.sqlite`);
process.env.OWNER_ID = 'u1';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = require('../src/lib/db');
const { routeForum, allForums } = require('../src/lib/routing');
const { JournalComponents } = require('../src/interaction-handlers/journal-components');
const { PnlCommand } = require('../src/commands/pnl');
const { settingsPanel } = require('../src/lib/panels');

test('each outcome routes to its own forum, falling back to the default forum', () => {
  const s = { default_forum_id: 'DEF', outcome_forums: { win: 'W', loss: 'L' } };
  assert.equal(routeForum(s, 'win'), 'W'); assert.equal(routeForum(s, 'loss'), 'L');
  assert.equal(routeForum(s, 'be'), 'DEF'); assert.equal(routeForum(s, 'missed'), 'DEF');
  assert.equal(routeForum({ outcome_forums: {} }, 'win'), null);
  assert.deepEqual(allForums({ forums: ['X', 'W'], default_forum_id: 'DEF', outcome_forums: { win: 'W', loss: 'L' } }).sort(), ['DEF', 'L', 'W', 'X']);
});

test('outcome forums persist, and clearing one removes it', () => {
  db.saveSettings('g1', { outcome_forums: { win: 'W', loss: 'L', be: 'B', missed: 'M' } });
  assert.deepEqual(db.getSettings('g1').outcome_forums, { win: 'W', loss: 'L', be: 'B', missed: 'M' });
  db.saveSettings('g1', { outcome_forums: { ...db.getSettings('g1').outcome_forums, be: null } });
  assert.deepEqual(db.getSettings('g1').outcome_forums, { win: 'W', loss: 'L', missed: 'M' });
  assert.equal(db.getSettings('g1').weekly_time, '17:00');            // other settings untouched
});

test('a database from the first release is upgraded in place', () => {
  const f = require('node:path').join(require('node:os').tmpdir(), `old-${process.pid}.sqlite`);
  const old = new Database(f);
  old.exec("CREATE TABLE journal_settings (guild_id TEXT PRIMARY KEY, forums_json TEXT NOT NULL DEFAULT '[]', default_forum_id TEXT, report_channel_id TEXT, weekly_day INTEGER NOT NULL DEFAULT 5, weekly_time TEXT NOT NULL DEFAULT '17:00', weekly_enabled INTEGER NOT NULL DEFAULT 1, month_enabled INTEGER NOT NULL DEFAULT 1, month_time TEXT NOT NULL DEFAULT '17:00', timezone TEXT NOT NULL DEFAULT 'America/New_York', currency TEXT NOT NULL DEFAULT '$', show_r INTEGER NOT NULL DEFAULT 1, ping_role_id TEXT, allowed_users_json TEXT NOT NULL DEFAULT '[]'); INSERT INTO journal_settings (guild_id, default_forum_id) VALUES ('old', 'DEF');");
  old.close();
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "const d=require('./src/lib/db');console.log(JSON.stringify(d.getSettings('old')));d.saveSettings('old',{outcome_forums:{win:'W'}});console.log(JSON.stringify(d.getSettings('old').outcome_forums))"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, JOURNAL_DB_PATH: f } }).toString().trim().split('\n');
  assert.equal(JSON.parse(out[0]).default_forum_id, 'DEF'); assert.deepEqual(JSON.parse(out[1]), { win: 'W' });
});

test('settings has an Outcome forums page with a Choose button per outcome', () => {
  const s = db.getSettings('g1');
  const j = JSON.stringify(settingsPanel('outcomes', s, []).toJSON());
  for (const k of ['win', 'loss', 'be', 'missed']) assert.ok(j.includes(`js:outcomes:edit:${k}`), k);
  assert.ok(j.includes('js:nav:outcomes'));
});

const fakeG = { emojis: { cache: { find: () => undefined } } };
test('picking an outcome in /journal switches the target forum; a manual pick sticks', async () => {
  db.saveSettings('g2', { default_forum_id: 'DEF', outcome_forums: { win: 'W', loss: 'L' } });
  const d = db.createDraft({ userId: 'u1', guildId: 'g2', forumId: 'DEF' });
  const click = (action, arg, values) => { let out; const i = { user: { id: 'u1' }, guildId: 'g2', guild: fakeG, memberPermissions: { has: () => true }, values, update: async (p) => { out = p; } };
    return JournalComponents.prototype.run.call({ container: { logger: { error() {} } } }, i, { id: d.id, action, arg }).then(() => out); };
  await click('o', 'win'); assert.equal(db.getDraft(d.id).forumId, 'W');
  await click('o', 'loss'); assert.equal(db.getDraft(d.id).forumId, 'L');
  await click('o', 'be'); assert.equal(db.getDraft(d.id).forumId, 'DEF');
  await click('forum', undefined, ['MANUAL']); await click('o', 'win');
  assert.equal(db.getDraft(d.id).forumId, 'MANUAL');                     // manual override survives outcome changes
});

function fakePnl(sub, opts = {}) {
  const calls = [];
  return { calls, user: { id: 'u1' }, guildId: 'g3', guild: { id: 'g3', channels: { fetch: async () => null, fetchActiveThreads: async () => null } }, memberPermissions: { has: () => true },
    options: { getSubcommand: () => sub, getString: (k) => opts[k] ?? null },
    reply: async (p) => { calls.push(['reply', p]); }, editReply: async (p) => { calls.push(['editReply', p]); } };
}
for (const sub of ['day', 'week', 'month', 'rescan']) {
  test(`/pnl ${sub} answers immediately, then edits the reply without flags`, async () => {
    const i = fakePnl(sub);
    await PnlCommand.prototype.chatInputRun.call({ container: { logger: { error: console.error } } }, i);
    assert.equal(i.calls[0][0], 'reply');
    assert.equal(i.calls[0][1].flags & 32768, 32768);                    // initial reply is Components V2
    assert.equal(i.calls[0][1].flags & 64, 64);                          // and ephemeral
    const last = i.calls[i.calls.length - 1];
    assert.equal(last[0], 'editReply'); assert.equal(last[1].flags, undefined);
    assert.ok(last[1].components.length >= 1);
    if (sub !== 'rescan') assert.ok(last[1].files && last[1].files.length === 1);   // the PNG
  });
}
test('/pnl month with an invalid month reports the error instead of hanging', async () => {
  const i = fakePnl('month', { month: 'nope' });
  await PnlCommand.prototype.chatInputRun.call({ container: { logger: { error() {} } } }, i);
  assert.equal(i.calls.at(-1)[0], 'editReply');
});
test('/pnl day with an unreadable date reports the error instead of hanging', async () => {
  const i = fakePnl('day', { date: 'not a date' });
  await PnlCommand.prototype.chatInputRun.call({ container: { logger: { error() {} } } }, i);
  const last = i.calls.at(-1);
  assert.equal(last[0], 'editReply'); assert.equal(last[1].files, undefined);
});
