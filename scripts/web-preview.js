'use strict';
/**
 * Runs the web journal locally against sample data, without Discord:
 *   node scripts/web-preview.js     then open http://localhost:4321  (and /dev-login to sign in)
 * A stand-in server with forums and a few weeks of trades; nothing is posted anywhere.
 */
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `web-preview-${Date.now()}.sqlite`);
process.env.SESSION_SECRET ||= 'preview-secret-preview-secret';
process.env.PUBLIC_BASE_URL ||= 'http://localhost:4321';
process.env.DISCORD_CLIENT_ID ||= '000000000000000000';
process.env.DISCORD_CLIENT_SECRET ||= 'preview';
const http = require('node:http');
const { DateTime } = require('luxon');
const db = require('../src/lib/db');
const auth = require('../src/web/auth');
const { createServer } = require('../src/web/server');
const { tradingDay } = require('../src/lib/session');

const GID = '111111111111111111';
const ch = (id, name, type) => [id, { id, name, type, rawPosition: Number(id.slice(-2)), isTextBased: () => true }];
const guild = {
  id: GID, name: 'YSER Trading', iconURL: () => null,
  channels: { cache: new Map([ch('900000000000000001', 'wins', 15), ch('900000000000000002', 'losses', 15), ch('900000000000000003', 'breakeven', 15), ch('900000000000000004', 'pnl', 0)]), fetch: async () => null },
  roles: { cache: new Map([['800000000000000001', { id: '800000000000000001', name: 'Traders', managed: false, position: 2, hexColor: '#5865f2' }]]) },
  members: {
    me: null,
    fetch: async (id) => ({ id, displayName: id === '222222222222222222' ? 'Yasser' : 'Trader', user: { id, username: 'trader', globalName: 'Trader', bot: false }, displayAvatarURL: () => null }),
    search: async ({ query }) => new Map([['333333333333333333', { displayName: `${query} Lab`, user: { id: '333333333333333333', username: query.toLowerCase(), bot: false }, displayAvatarURL: () => null }]]),
  },
  _active: async () => ({ threads: new Map([['700000000000000001', { id: '700000000000000001', name: 'Wins ledger', parentId: '900000000000000001', createdTimestamp: 2 }], ['700000000000000002', { id: '700000000000000002', name: 'October wins', parentId: '900000000000000001', createdTimestamp: 1 }]]) }),
};
guild.channels.cache.get('900000000000000001').availableTags = [{ id: 't1', name: 'Win' }];
for (const id of ['900000000000000001', '900000000000000002', '900000000000000003']) {
  const ch = guild.channels.cache.get(id);
  ch.availableTags ||= [];
  ch.threads = { fetchArchived: async () => ({ threads: new Map(), hasMore: false }) };
  ch.setAvailableTags = async (tags) => { ch.availableTags = tags.map((t, i) => ({ id: t.id || `n${i}`, name: t.name })); };
}
guild.channels.fetch = async (id) => {   // forums from the cache, posts from the active threads, like Discord
  if (guild.channels.cache.has(id)) return guild.channels.cache.get(id);
  const t = (await guild._active()).threads.get(id);
  return t ? { ...t, parent: guild.channels.cache.get(t.parentId), isThread: () => true } : null;
};
guild.channels.fetchActiveThreads = guild._active;
const client = { guilds: { cache: new Map([[GID, guild]]) }, isReady: () => true, logger: console, user: { id: 'bot' } };
db.saveSettings(GID, { outcome_forums: { win: '900000000000000001', loss: '900000000000000002', be: '900000000000000003' }, report_channel_id: '900000000000000004', theme: 'dark' });

// a few weeks of believable trades
const SYMS = ['NQ', 'NQ', 'NQ', 'ES', 'ES', 'MNQ', 'YM', 'CL'], SETUPS = ['London sweep', 'NY AM continuation', 'ORB retest', 'Failed breakdown', 'HTF sweep → CISD', null];
let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
let k = 0;
for (let d = 34; d >= 0; d--) {
  const base = DateTime.now().setZone('America/New_York').minus({ days: d }).startOf('day');
  if (base.weekday > 5) continue;
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const at = base.set({ hour: 9 + Math.floor(rnd() * 6), minute: Math.floor(rnd() * 60) });
    const win = rnd() < 0.6, cents = Math.round((win ? 200 + rnd() * 1400 : -(120 + rnd() * 700)) * 100), sym = SYMS[Math.floor(rnd() * SYMS.length)];
    const outcome = Math.abs(cents) < 3000 ? 'be' : cents > 0 ? 'win' : 'loss', key = `9${String(++k).padStart(17, '0')}`, date = tradingDay(at, db.getSettings(GID));
    const f = { instrument: sym, direction: rnd() < 0.6 ? 'Long' : 'Short', date, pnl_cents: cents, r: Math.round((cents / 50000) * 10) / 10, setup: SETUPS[Math.floor(rnd() * SETUPS.length)] || undefined,
      session: rnd() < 0.7 ? 'NY AM' : 'London', _at: at.toMillis(), _qty: 1 + Math.floor(rnd() * 3), _held: `${2 + Math.floor(rnd() * 40)}m ${Math.floor(rnd() * 60)}s`, why: rnd() < 0.5 ? 'Clean sweep of the Asia high, then displacement.' : undefined,
      followed: rnd() < 0.7 ? 'YES' : 'NO', entry: String(21000 + Math.floor(rnd() * 400)), exit: String(21000 + Math.floor(rnd() * 400)) };
    db.insertEntry({ guild_id: GID, user_id: '222222222222222222', outcome, instrument: sym, direction: f.direction, session: f.session, setup: f.setup || null, entry: f.entry, stop: null, target: null, exit: f.exit,
      r_multiple: f.r, pnl_cents: cents, potential_cents: null, followed_plan: f.followed, fields_json: JSON.stringify(f), date_local: date, forum_id: '900000000000000001', thread_id: key, message_id: key, image_name: rnd() < 0.5 ? 'chart.png' : null, created_at: at.toMillis() });
    db.upsertPnl({ thread_id: key, container_id: key, guild_id: GID, forum_id: '900000000000000001', outcome, pnl_cents: cents, date_local: date, source: 'bot' });
  }
}

const server = createServer(client), handle = server.listeners('request')[0];
const token = auth.sign({ uid: '222222222222222222', name: 'Yasser', avatar: null, g: [{ id: GID, m: 1 }], exp: Date.now() + 86400000 });
http.createServer((req, res) => {
  if (req.url === '/dev-login') { res.writeHead(302, { location: '/app', 'set-cookie': auth.cookie(auth.SESSION_COOKIE, token, 86400000) }); return res.end(); }
  return handle(req, res);
}).listen(4321, () => console.log('web preview on http://localhost:4321  (sign in: /dev-login)'));
