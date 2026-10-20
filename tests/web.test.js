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
