'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `web-${process.pid}.sqlite`);
process.env.SESSION_SECRET = 'test-secret-test-secret';
process.env.PUBLIC_BASE_URL = 'https://journal.example.com';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.DISCORD_CLIENT_SECRET = 'shh';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/lib/db');
const auth = require('../src/web/auth');
const data = require('../src/web/data');
const { createServer } = require('../src/web/server');

const GID = '111111111111111111', OTHER = '333333333333333333';
const guild = { id: GID, name: 'Desk', iconURL: () => null,
  channels: { cache: new Map([['900000000000000001', { id: '900000000000000001', name: 'wins', type: 15, rawPosition: 1 }], ['900000000000000004', { id: '900000000000000004', name: 'pnl', type: 0, rawPosition: 4 }]]), fetch: async () => null },
  roles: { cache: new Map() } };
const client = { guilds: { cache: new Map([[GID, guild]]) }, isReady: () => true, logger: { error() {}, info() {} } };
const server = createServer(client), handle = server.listeners('request')[0];

/** drives the request handler without a socket */
function call(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const { Readable } = require('node:stream');
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
    const res = { statusCode: 0, headers: {}, chunks: [], headersSent: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h || {}; this.headersSent = true; },
      end(b) { if (b) this.chunks.push(Buffer.from(b)); const raw = Buffer.concat(this.chunks); let json = null; try { json = JSON.parse(raw.toString()); } catch { /* not json */ } resolve({ status: this.statusCode, headers: this.headers, raw, json }); } };
    handle(req, res);
  });
}
const tokenFor = (o = {}) => auth.sign({ uid: '222222222222222222', name: 'Trader', avatar: null, g: [{ id: GID, m: 1 }], exp: Date.now() + 3600000, ...o });
const bearer = (t) => ({ authorization: `Bearer ${t}` });

for (let i = 0; i < 6; i++) {
  const key = `9${String(i).padStart(17, '0')}`, cents = i % 3 ? 50000 : -20000;
  db.insertEntry({ guild_id: GID, user_id: 'u', outcome: cents > 0 ? 'win' : 'loss', instrument: i % 2 ? 'NQ' : 'ES', direction: 'Long', session: 'NY AM', setup: 'ORB', entry: '1', stop: null, target: null, exit: '2',
    r_multiple: cents / 25000, pnl_cents: cents, potential_cents: null, followed_plan: 'YES', fields_json: JSON.stringify({ instrument: i % 2 ? 'NQ' : 'ES', pnl_cents: cents, followed: 'YES', _at: Date.parse(`2026-10-1${i}T14:00:00Z`) }),
    date_local: `2026-10-1${i}`, forum_id: 'F', thread_id: key, message_id: key, image_name: null, created_at: 1 });
  db.upsertPnl({ thread_id: key, container_id: key, guild_id: GID, forum_id: 'F', outcome: cents > 0 ? 'win' : 'loss', pnl_cents: cents, date_local: `2026-10-1${i}`, source: 'bot' });
}

test('sessions: signed, tamper-proof, expiring; CSRF tied to the session', () => {
  const t = tokenFor();
  assert.equal(auth.verify(t).uid, '222222222222222222');
  assert.equal(auth.verify(`${t.slice(0, -2)}xx`), null);
  assert.equal(auth.verify(tokenFor({ exp: Date.now() - 1 })), null);
  const s = auth.verify(t);
  assert.ok(auth.csrfValid(s, auth.csrfFor(s))); assert.ok(!auth.csrfValid(s, 'nope'));
  assert.match(auth.authorizeUrl(), /redirect_uri=https%3A%2F%2Fjournal\.example\.com%2Fauth%2Fcallback/);
});

test('access follows the journal rules: manage, allowed users, owners; the bot must be in the server', () => {
  const s = auth.verify(tokenFor());
  assert.deepEqual(auth.accessTo(s, GID, client, { allowed_users: [] }), { journal: true, manage: true });
  assert.deepEqual(auth.accessTo(s, GID, client, { allowed_users: ['999'] }), { journal: false, manage: true });   // a list that leaves them out: settings only
  const member = auth.verify(tokenFor({ g: [{ id: GID, m: 0 }] }));
  assert.equal(auth.accessTo(member, GID, client, { allowed_users: [] }), null);
  assert.deepEqual(auth.accessTo(member, GID, client, { allowed_users: ['222222222222222222'] }), { journal: true, manage: false });
  assert.equal(auth.accessTo(s, OTHER, client, { allowed_users: [] }), null);
});

test('pages, headers, static files: the site is framed only where allowed, nothing climbs out of public/', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200); assert.match(home.raw.toString(), /Every trade,/); assert.ok(!home.raw.toString().includes('__V__'));
  assert.match(home.raw.toString(), /<meta property="og:image" content="https:\/\/journal\.example\.com\/img\/og\.png">/); assert.ok(!home.raw.toString().includes('__ORIGIN__'));   // link previews need the full address
  assert.equal((await call('GET', '/img/og.png')).headers['content-type'], 'image/png');
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(home.headers['x-frame-options'], 'DENY');
  process.env.PANEL_FRAME_ANCESTORS = 'https://whop.com https://*.whop.com';
  const app = await call('GET', '/experiences/exp_123');
  assert.equal(app.status, 200); assert.match(app.headers['content-security-policy'], /frame-ancestors https:\/\/whop\.com https:\/\/\*\.whop\.com/); assert.equal(app.headers['x-frame-options'], undefined);
  assert.match(auth.cookie('a', 'b', 1000), /SameSite=None; Partitioned/);
  delete process.env.PANEL_FRAME_ANCESTORS;
  assert.equal((await call('GET', '/css/../../web/auth.js')).status, 404);
  assert.equal((await call('GET', '/fonts/..%2F..%2Fpackage.json')).status, 404);
  assert.equal((await call('GET', '/fonts/Inter-Medium.ttf')).status, 200);
  const pub = await call('GET', '/api/public');
  assert.equal(pub.json.servers, 1); assert.ok(pub.json.trades >= 6); assert.match(pub.json.invite, /permissions=\d+/);
});

test('the API: signed out, signed in, every read; writes need CSRF and Manage Server', async () => {
  assert.equal((await call('GET', '/api/me')).json.signedIn, false);
  assert.equal((await call('GET', `/api/g/${GID}/overview`)).status, 401);
  const t = tokenFor(), me = (await call('GET', '/api/me', { headers: bearer(t) })).json;
  assert.equal(me.signedIn, true); assert.equal(me.guilds[0].id, GID); assert.ok(me.csrf);
  const ov = (await call('GET', `/api/g/${GID}/overview?range=all`, { headers: bearer(t) })).json;
  assert.equal(ov.stats.count, 6); assert.equal(ov.stats.net, 2000 - 400); assert.ok(ov.insights.bySymbol.length === 2);
  const tr = (await call('GET', `/api/g/${GID}/trades?range=all&symbol=NQ`, { headers: bearer(t) })).json;
  assert.ok(tr.trades.every((x) => x.instrument === 'NQ')); assert.deepEqual(tr.symbols, ['ES', 'NQ']);
  assert.equal((await call('GET', `/api/g/${GID}/trades?range=all&q=es`, { headers: bearer(t) })).json.trades.every((x) => x.instrument === 'ES'), true);
  const cal = (await call('GET', `/api/g/${GID}/calendar?month=2026-10`, { headers: bearer(t) })).json;
  assert.equal(cal.tradedDays, 6);
  assert.equal((await call('GET', `/api/g/${OTHER}/overview`, { headers: bearer(t) })).status, 403);
  // writes
  assert.equal((await call('PATCH', `/api/g/${GID}/settings`, { headers: bearer(t), body: { currency: '€' } })).status, 403);   // no CSRF
  const ok = await call('PATCH', `/api/g/${GID}/settings`, { headers: { ...bearer(t), 'x-csrf': me.csrf }, body: { currency: '€', session: 'forex', weekly_day: 4, report_channel_id: '900000000000000004' } });
  assert.equal(ok.status, 200); const s = db.getSettings(GID);
  assert.equal(s.currency, '€'); assert.equal(s.session_start, '17:00'); assert.equal(s.weekly_day, 4); assert.equal(s.report_channel_id, '900000000000000004');
  const bad = await call('PATCH', `/api/g/${GID}/settings`, { headers: { ...bearer(t), 'x-csrf': me.csrf }, body: { report_channel_id: '900000000000000001', weekly_time: '7pm' } });
  assert.equal(bad.status, 400); assert.match(bad.json.detail, /text channel/);
  const member = tokenFor({ g: [{ id: GID, m: 0 }] }); db.saveSettings(GID, { allowed_users: ['222222222222222222'] });
  const mm = (await call('GET', '/api/me', { headers: bearer(member) })).json;
  assert.equal((await call('PATCH', `/api/g/${GID}/settings`, { headers: { ...bearer(member), 'x-csrf': mm.csrf }, body: { currency: '$' } })).status, 403);   // journal yes, settings no
  assert.equal((await call('GET', `/api/g/${GID}/overview`, { headers: bearer(member) })).status, 200);
  const card = await call('GET', `/api/g/${GID}/card/day?date=2026-10-12&theme=dark`, { headers: bearer(t) });
  assert.equal(card.status, 200); assert.equal(card.headers['content-type'], 'image/png'); assert.ok(card.raw.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  const prev = await call('POST', `/api/g/${GID}/import/preview`, { headers: { ...bearer(t), 'x-csrf': me.csrf }, body: { csv: 'symbol,exit_time,pnl\nCL,2026-10-19T15:00:00Z,120', name: 'x.csv' } });
  assert.equal(prev.status, 200); assert.equal(prev.json.fresh.length, 1); assert.ok(prev.json.id);
  const logged = await call('POST', `/api/g/${GID}/journal`, { headers: { ...bearer(t), 'x-csrf': me.csrf }, body: { outcome: 'win', instrument: '', direction: 'Long', pnl: 'abc' } });
  assert.equal(logged.status, 400); assert.match(logged.json.detail, /Instrument is required/); assert.match(logged.json.detail, /not an amount/);
});

test('full control: forums with tags, a forum’s posts, adding tags, existing-post destinations, people', async () => {
  const forum = guild.channels.cache.get('900000000000000001');
  forum.availableTags = [{ id: 't1', name: 'Win' }];
  forum.setAvailableTags = async (tags) => { forum.availableTags = tags.map((t, i) => ({ id: t.id || `n${i}`, name: t.name })); };
  forum.threads = { fetchArchived: async () => ({ threads: new Map(), hasMore: false }) };
  const thread = { id: '700000000000000001', name: 'Wins ledger', parentId: forum.id, parent: { type: 15 }, isThread: () => true, createdTimestamp: 1 };
  guild.channels.fetchActiveThreads = async () => ({ threads: new Map([[thread.id, thread]]) });
  guild.channels.fetch = async (id) => (id === thread.id ? thread : guild.channels.cache.get(id) || null);
  guild.members = { me: null, fetch: async (id) => ({ displayName: 'Trader', user: { id, username: 'trader', bot: false }, displayAvatarURL: () => null }),
    search: async ({ query }) => new Map([['444444444444444444', { displayName: `${query}!`, user: { id: '444444444444444444', username: 'sam', bot: false }, displayAvatarURL: () => null }]]) };
  db.saveSettings(GID, { allowed_users: [] });
  const t = tokenFor(), me = (await call('GET', '/api/me', { headers: bearer(t) })).json, w = { ...bearer(t), 'x-csrf': me.csrf };
  const fl = (await call('GET', `/api/g/${GID}/forums`, { headers: bearer(t) })).json.forums;
  assert.equal(fl[0].name, 'wins'); assert.deepEqual(fl[0].has, { win: true, loss: false, be: false, missed: false });
  const posts = (await call('GET', `/api/g/${GID}/posts?forum=${forum.id}`, { headers: bearer(t) })).json.posts;
  assert.deepEqual(posts.map((x) => x.name), ['Wins ledger']);
  const tags = (await call('POST', `/api/g/${GID}/action/tags`, { headers: w, body: { forum: forum.id } })).json;
  assert.deepEqual(tags.added, ['Loss', 'Breakeven', 'Missed']); assert.equal(forum.availableTags.length, 4);
  assert.equal((await call('PATCH', `/api/g/${GID}/settings`, { headers: w, body: { outcome_threads: { win: { thread: thread.id } } } })).status, 200);
  assert.deepEqual(db.getSettings(GID).outcome_threads.win, { thread: thread.id, forum: forum.id });
  const gone = await call('PATCH', `/api/g/${GID}/settings`, { headers: w, body: { outcome_threads: { loss: { thread: '700000000000000099' } } } });
  assert.equal(gone.status, 400);
  const found = (await call('GET', `/api/g/${GID}/members?q=sa`, { headers: bearer(t) })).json.members;
  assert.equal(found[0].id, '444444444444444444');
  assert.equal((await call('PATCH', `/api/g/${GID}/settings`, { headers: w, body: { allowed_users: ['444444444444444444', 'nope'] } })).status, 200);
  assert.deepEqual(db.getSettings(GID).allowed_users, ['444444444444444444']);
  assert.equal((await call('GET', `/api/g/${GID}/members?ids=444444444444444444`, { headers: bearer(t) })).json.members[0].name, 'Trader');
  db.saveSettings(GID, { allowed_users: [] });
  // a drawn card is kept until the journal changes
  const c1 = await call('GET', `/api/g/${GID}/card/week?date=2026-10-12`, { headers: bearer(t) });
  const c2 = await call('GET', `/api/g/${GID}/card/week?date=2026-10-12`, { headers: bearer(t) });
  assert.ok(c1.raw.equals(c2.raw)); assert.match(c2.headers['cache-control'], /max-age/);
});

test('stats and insights: the numbers a trader reads', () => {
  const list = [{ outcome: 'win', pnl: 300, date: '2026-10-12', r: 2, direction: 'Long', time: '09:30', held: '10m' }, { outcome: 'loss', pnl: -100, date: '2026-10-12', r: -1, direction: 'Short', time: '10:00', held: '4m' },
    { outcome: 'win', pnl: 200, date: '2026-10-13', r: 1, direction: 'Long', time: '09:45', held: '12m' }, { outcome: 'missed', pnl: 0, date: '2026-10-13' }];
  const s = data.stats(list);
  assert.equal(s.count, 3); assert.equal(s.missed, 1); assert.equal(s.net, 400); assert.equal(s.winRate, 67); assert.equal(s.profitFactor, 5); assert.equal(s.maxDrawdown, -100);
  assert.equal(s.streak, 1); assert.deepEqual(s.current, { kind: 'w', n: 1 }); assert.equal(s.greenDays, 2);
  const i = data.insights(list);
  assert.equal(i.byHour[9].n, 2); assert.equal(i.hold.win, 11); assert.equal(i.hold.loss, 4); assert.equal(i.bySide.find((x) => x.key === 'Long').pnl, 500);
  assert.equal(data.stats([]).profitFactor, null);
});

test('live: the stamp streams at once, a change in Discord pushes a new one, a rescan with nothing new pushes nothing', async () => {
  const t = tokenFor(), { Readable } = require('node:stream');
  const req = Readable.from([]); Object.assign(req, { method: 'GET', url: `/api/g/${GID}/live`, headers: bearer(t), socket: { remoteAddress: '127.0.0.1' } });
  const events = [], onClose = [];
  const res = { statusCode: 0, headers: {}, headersSent: false, writeHead(s, h) { this.statusCode = s; this.headers = h; this.headersSent = true; },
    write(c) { for (const m of String(c).split('\n\n')) { const d = m.split('\n').find((l) => l.startsWith('data:')); if (d) events.push(JSON.parse(d.slice(5)).stamp); } return true; },
    end() { onClose.forEach((f) => f()); }, on(e, f) { if (e === 'close') onClose.push(f); } };
  await handle(req, res);
  assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(events.length, 1); assert.equal(events[0], db.journalStamp(GID));
  const wait = () => new Promise((r) => setTimeout(r, 320));
  // the same rows written again (a rescan): no news
  const k = `9${'0'.repeat(17)}`, row = db.getPnlEntry(k);
  db.upsertPnl({ thread_id: k, container_id: row.container_id, guild_id: GID, forum_id: row.forum_id, outcome: row.outcome, pnl_cents: row.pnl_cents, date_local: row.date_local, source: 'scan' });
  await wait(); assert.equal(events.length, 1);
  // a new trade, then several at once (an import): each burst arrives as one update
  db.upsertPnl({ thread_id: '980000000000000001', container_id: '980000000000000001', guild_id: GID, forum_id: 'F', outcome: 'win', pnl_cents: 12300, date_local: '2026-10-19', source: 'bot' });
  await wait(); assert.equal(events.length, 2); assert.notEqual(events[1], events[0]);
  for (let i = 2; i < 6; i++) db.upsertPnl({ thread_id: `98000000000000000${i}`, container_id: `98000000000000000${i}`, guild_id: GID, forum_id: 'F', outcome: 'win', pnl_cents: 100 * i, date_local: '2026-10-19', source: 'import' });
  await wait(); assert.equal(events.length, 3);
  db.deletePnl('980000000000000001'); await wait(); assert.equal(events.length, 4);
  db.upsertPnl({ thread_id: '990000000000000001', container_id: '990000000000000001', guild_id: OTHER, forum_id: 'F', outcome: 'win', pnl_cents: 1, date_local: '2026-10-19', source: 'bot' });
  await wait(); assert.equal(events.length, 4);   // another server's trade is not news here
  res.end(); assert.equal(db.changes.listenerCount('change'), 0);   // a closed stream lets go
  const st = await call('GET', `/api/g/${GID}/stamp`, { headers: bearer(t) });
  assert.equal(st.json.stamp, db.journalStamp(GID));
  assert.equal((await call('GET', `/api/g/${GID}/stamp`)).status, 401);
  for (let i = 1; i < 6; i++) db.deletePnl(`98000000000000000${i}`);
  db.deletePnl('990000000000000001');
});

test('the ledger out: a CSV the importer reads back, a clear that a rescan respects and Undo brings back, the bot’s own posts deleted on request', async () => {
  const t = tokenFor(), me = (await call('GET', '/api/me', { headers: bearer(t) })).json, w = { ...bearer(t), 'x-csrf': me.csrf };
  db.saveSettings(GID, { allowed_users: [], currency: '$' });
  const count = () => db.pnlBetween(GID, '0000-01-01', '9999-12-31').length, n0 = count();
  // export: the filters apply, the file is UTF-8 for Excel, and the importer reads it back trade for trade
  const ex = await call('GET', `/api/g/${GID}/export?range=all`, { headers: bearer(t) });
  assert.equal(ex.status, 200); assert.match(ex.headers['content-type'], /text\/csv/); assert.match(ex.headers['content-disposition'], /attachment; filename="journal-desk-all-/);
  assert.equal(Number(ex.headers['x-trades']), n0); assert.ok(ex.raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  const { readTrades } = require('../src/lib/csv-import');
  const back = readTrades(ex.raw.subarray(3).toString('utf8'), 'America/New_York');
  assert.equal(back.error, undefined); assert.equal(back.trades.length, n0);
  const total = db.pnlBetween(GID, '0000-01-01', '9999-12-31').reduce((s, r) => s + r.pnl_cents, 0);
  assert.equal(back.trades.reduce((s, x) => s + x.pnl_cents, 0), total);
  assert.equal(Number((await call('GET', `/api/g/${GID}/export?range=all&symbol=NQ`, { headers: bearer(t) })).headers['x-trades']), 3);
  // a note a spreadsheet would run as a formula is written harmless
  const csv = data.tradesCsv([{ key: '1', date: '2026-10-12', at: null, instrument: 'NQ', direction: 'Long', qty: null, entry: null, exit: null, stop: null, target: null, held: null, outcome: 'win', pnl: 10, potential: null, r: null, session: null, setup: null, followed: null, notes: { why: '=HYPERLINK("x")', lesson: 'a, b' }, link: 'l' }], db.getSettings(GID));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/); assert.match(csv, /"a, b"/);
  // clearing needs Manage Server, the word, and the count it was shown
  const member = tokenFor({ g: [{ id: GID, m: 0 }] }); db.saveSettings(GID, { allowed_users: ['222222222222222222'] });
  assert.equal((await call('GET', `/api/g/${GID}/clear?range=all`, { headers: bearer(member) })).status, 403);
  db.saveSettings(GID, { allowed_users: [] });
  const pv = (await call('GET', `/api/g/${GID}/clear?range=all&symbol=ES`, { headers: bearer(t) })).json;
  assert.equal(pv.count, 3); assert.equal(pv.spark.length, 3);
  assert.equal((await call('POST', `/api/g/${GID}/action/clear`, { headers: w, body: { query: 'range=all&symbol=ES', confirm: 'yes' } })).status, 400);
  assert.equal((await call('POST', `/api/g/${GID}/action/clear`, { headers: w, body: { query: 'range=all&symbol=ES', confirm: 'delete', expect: 2 } })).status, 409);
  const cl = (await call('POST', `/api/g/${GID}/action/clear`, { headers: w, body: { query: 'range=all&symbol=ES', confirm: 'DELETE', expect: 3 } })).json;
  assert.equal(cl.cleared, 3); assert.equal(count(), n0 - 3);
  assert.equal((await call('GET', `/api/g/${GID}/trades?range=all&symbol=ES`, { headers: bearer(t) })).json.total, 0);
  // a rescan of a cleared trade's message leaves it out of the journal
  const { scanLedgerMessage } = require('../src/lib/scanner');
  const k = `9${'0'.repeat(17)}`;
  assert.equal(scanLedgerMessage({ id: k, parentId: 'F', guildId: GID }, { id: k, content: 'RESULT: WIN\nPNL: +$500', createdTimestamp: Date.now() }, db.getSettings(GID)), 'unchanged');
  assert.equal(db.getPnlEntry(k), undefined); assert.ok(db.isArchived(k));
  assert.equal((await call('GET', `/api/g/${GID}/clear?range=all`, { headers: bearer(t) })).json.batches[0].n, 3);
  // Undo puts every one back
  assert.equal((await call('POST', `/api/g/${GID}/action/restore`, { headers: w, body: { batch: cl.batch } })).json.restored, 3);
  assert.equal(count(), n0); assert.ok(!db.isArchived(k));
  // and with Discord: only posts the bot made are deleted; a member's post stays, cleared but restorable
  const realFetch = guild.channels.fetch, deleted = [];
  client.user = { id: '444444444444444444' };
  guild.channels.fetch = async (id) => ({ id, ownerId: Number(id.slice(-1)) % 2 ? 'member' : client.user.id, delete: async () => { deleted.push(id); } });
  const cd = (await call('POST', `/api/g/${GID}/action/clear`, { headers: w, body: { query: 'range=all&symbol=ES', confirm: 'delete', expect: 3, discord: true } })).json;
  assert.ok(cd.job); assert.equal(cd.total, 3);
  let job; for (let i = 0; i < 50; i++) { job = (await call('GET', `/api/g/${GID}/jobs/${cd.job}`, { headers: bearer(t) })).json; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(job.state, 'done'); assert.equal(job.result.deleted, deleted.length); assert.equal(job.result.deleted + job.result.kept, 3); assert.ok(job.result.deleted >= 1);
  for (const id of deleted) assert.ok(!db.isArchived(id));   // gone from Discord: nothing left to restore
  assert.equal(db.restoreArchive(GID, cd.batch), job.result.kept);
  guild.channels.fetch = realFetch; delete client.user;
});
