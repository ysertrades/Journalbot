'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `edit-trade-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { DateTime } = require('luxon');
const db = require('../src/lib/db');
const ed = require('../src/lib/trade-editor');
const { EditTradeCommand } = require('../src/commands/edit-trade');
const { EditTradeComponents } = require('../src/interaction-handlers/edit-trade-components');
const { JournalModals } = require('../src/interaction-handlers/journal-modals');
const TZ = 'America/New_York';
const today = DateTime.now().setZone(TZ).toISODate();
const longAgo = DateTime.now().setZone(TZ).minus({ days: 90 }).toISODate();

// a fake forum post per trade: the bot's V2 message, editable
const threads = new Map(), edits = [];
const BOT = 'bot1';
function fakePost(id, { image, author = BOT, v2 = true, msgId = id } = {}) {
  const attachments = new Collection(image ? [['a1', { name: image, url: `https://cdn.example/${image}` }]] : []);
  const msg = { id: msgId, author: { id: author }, flags: { has: () => v2 }, attachments,
    edit: async (p) => { edits.push({ id: msgId, p }); return { attachments: new Collection((p.files || []).map((f, n) => [`n${n}`, { name: f.name, url: `https://cdn.example/new/${f.name}` }])) }; } };
  const t = { id, parentId: 'F', name: 'old title', locked: false, archived: false, isThread: () => true,
    setName: async (n) => { t.name = n; return t; }, messages: { fetch: async (m) => (m === msgId ? msg : null) } };
  threads.set(id, t);
  return t;
}
const guild = { id: 'ge', client: { user: { id: BOT } }, emojis: { cache: new Collection() }, channels: { fetch: async (id) => threads.get(id) || null } };

let n = 0;
function seed(outcome, cents, date, f = {}) {
  const key = `p${++n}`;
  const fields = { instrument: f.instrument || 'NQ', direction: f.direction || 'Long', date, pnl_cents: cents, ...(f.extra || {}) };
  db.insertEntry({ guild_id: 'ge', user_id: 'u', outcome, instrument: fields.instrument, direction: fields.direction, session: null, setup: f.setup || null,
    entry: null, stop: null, target: null, exit: null, r_multiple: f.r ?? null, pnl_cents: cents, potential_cents: null, followed_plan: null,
    fields_json: JSON.stringify({ ...fields, setup: f.setup }), date_local: date, forum_id: 'F', thread_id: key, message_id: key, image_name: f.image || null, created_at: Date.now() - n * 1000 });
  db.upsertPnl({ thread_id: key, container_id: key, guild_id: 'ge', forum_id: 'F', outcome, pnl_cents: cents, date_local: date, source: 'bot' });
  if (!f.noPost) fakePost(key, { image: f.image, author: f.author, v2: f.v2 });
  return key;
}
const kWin = seed('win', 124000, today, { setup: 'ORB retest', image: 'chart.png', extra: { why: 'clean sweep' }, r: 2.5 });
const kLoss = seed('loss', -31000, today, { instrument: 'ES', direction: 'Short' });
seed('be', 0, today, { instrument: 'YM' });
const kOld = seed('win', 50000, longAgo, { instrument: 'CL' });
const kText = seed('loss', -10000, today, { instrument: 'GC', v2: false });
// a hand-typed post: a PnL row but no journal entry, never listed
db.upsertPnl({ thread_id: 'hand', container_id: 'hand', guild_id: 'ge', forum_id: 'F', outcome: 'win', pnl_cents: 777, date_local: today, source: 'scan' });

const st = (o = {}) => ({ ...ed.DEFAULT_STATE, period: 'day', ...o });
const keysOf = (r) => r.rows.map((x) => x.key);

test('finder: period, outcome, symbol, lenses and search narrow the list; hand-typed posts never show', () => {
  assert.equal(ed.findTrades('ge', TZ, st()).rows.length, 4);
  assert.ok(!keysOf(ed.findTrades('ge', TZ, st())).includes('hand'));
  assert.ok(keysOf(ed.findTrades('ge', TZ, st({ period: 'all' }))).includes(kOld));
  assert.ok(!keysOf(ed.findTrades('ge', TZ, st({ period: 'd30' }))).includes(kOld));
  assert.deepEqual(keysOf(ed.findTrades('ge', TZ, st({ out: 'loss' }))).sort(), [kLoss, kText].sort());
  assert.deepEqual(keysOf(ed.findTrades('ge', TZ, st({ sym: 'ES' }))), [kLoss]);
  assert.ok(!keysOf(ed.findTrades('ge', TZ, st({ show: 'nopic' }))).includes(kWin));
  assert.ok(!keysOf(ed.findTrades('ge', TZ, st({ show: 'nonotes' }))).includes(kWin));
  assert.equal(keysOf(ed.findTrades('ge', TZ, st({ show: 'big' })))[0], kWin);
  assert.deepEqual(keysOf(ed.findTrades('ge', TZ, st({ q: '1240' }))), [kWin]);
  assert.deepEqual(keysOf(ed.findTrades('ge', TZ, st({ q: 'es short' }))), [kLoss]);
  assert.deepEqual(keysOf(ed.findTrades('ge', TZ, st({ q: 'orb' }))), [kWin]);
  assert.deepEqual(ed.findTrades('ge', TZ, st({ q: 'nothing-like-this' })).rows, []);
  assert.deepEqual(ed.findTrades('ge', TZ, st()).symbols.sort(), ['ES', 'GC', 'NQ', 'YM']);
});

test('/edit-trade replies privately with the finder; the panel stays inside Discord limits', async () => {
  let reply;
  await EditTradeCommand.prototype.chatInputRun.call({}, { guild, guildId: 'ge', user: { id: 'u' }, memberPermissions: { has: () => true }, reply: async (p) => { reply = p; } });
  assert.equal(reply.flags & 64, 64);
  const json = JSON.stringify(reply.components[0].toJSON());
  for (const s of [':period', ':out', ':sym', ':show', ':find', 'Edit a trade']) assert.ok(json.includes(s), s);
  const count = (o) => (o && typeof o === 'object' ? (o.type ? 1 : 0) + Object.values(o).reduce((s, v) => s + count(v), 0) : 0);
  assert.ok(count(reply.components[0].toJSON()) <= 40);
  for (const t of reply.components[0].toJSON().components.filter((c) => c.type === 10)) assert.ok(t.content.length <= 4000);
  // an empty result still draws, with no picker
  const d = db.createDraft({ userId: 'u', guildId: 'ge' }); d.fields._finder = st({ q: 'zzz' });
  const empty = JSON.stringify(ed.finderPanel(d, guild, db.getSettings('ge')).toJSON());
  assert.ok(empty.includes('Nothing matches')); assert.ok(!empty.includes(':pick'));
});

function harness(draft) {
  const self = Object.create(EditTradeComponents.prototype, { container: { value: { logger: { error() {}, warn() {} } } } });
  const calls = [];
  const click = async (customId, values, user = 'u') => {
    const i = { customId, values, guildId: 'ge', guild, user: { id: user }, memberPermissions: { has: () => true },
      update: async (p) => calls.push(['update', p]), deferUpdate: async () => calls.push(['defer']), editReply: async (p) => calls.push(['edit', p]),
      reply: async (p) => calls.push(['reply', p]), showModal: async (m) => calls.push(['modal', m]) };
    const parsed = EditTradeComponents.prototype.parse.call({ some: (x) => x, none: () => null }, i);
    await EditTradeComponents.prototype.run.call(self, i, parsed);
    return calls.at(-1);
  };
  return { click, calls, draft };
}
const json = (call) => JSON.stringify((call[1].components?.[0] || call[1]).toJSON());

test('filters and paging update the panel; someone else’s panel is refused', async () => {
  const d = db.createDraft({ userId: 'u', guildId: 'ge' });
  const h = harness(d);
  let c = await h.click(`te:${d.id}:out`, ['loss']);
  assert.equal(c[0], 'update'); assert.equal(db.getDraft(d.id).fields._finder.out, 'loss');
  c = await h.click(`te:${d.id}:clear`);
  assert.equal(db.getDraft(d.id).fields._finder.out, 'all');
  c = await h.click(`te:${d.id}:find`);
  assert.equal(c[0], 'modal'); assert.ok(JSON.stringify(c[1].toJSON()).includes(`tem:${d.id}:find`));
  c = await h.click(`te:${d.id}:out`, ['loss'], 'intruder');
  assert.ok(json(c).includes('belongs to someone else'));
  c = await h.click('te:gone:out', ['loss']);
  assert.ok(json(c).includes('expired'));
});

test('pick a trade, add notes and a new chart through the journal forms, save rewrites the post', async () => {
  const d = db.createDraft({ userId: 'u', guildId: 'ge' });
  const h = harness(d);
  const row = ed.findTrades('ge', TZ, st()).rows.find((r) => r.key === kLoss);
  let c = await h.click(`te:${d.id}:pick`, [String(row.id)]);
  assert.equal(h.calls[0][0], 'defer');
  assert.ok(json(c).includes('Editing')); assert.ok(json(c).includes('No changes yet'));
  // the Notes form is the /journal one; its submit lands back in the editor
  c = await h.click(`te:${d.id}:edit:notes`);
  assert.equal(c[0], 'modal'); assert.ok(JSON.stringify(c[1].toJSON()).includes(`jrm:${d.id}:notes`));
  let modalOut;
  const mi = (customId, vals, files) => ({ customId, guildId: 'ge', guild, user: { id: 'u' }, memberPermissions: { has: () => true },
    fields: { getTextInputValue: (k) => vals[k] || '', getStringSelectValues: () => [], getUploadedFiles: () => files },
    isFromMessage: () => true, update: async (p) => { modalOut = p; }, reply: async (p) => { modalOut = p; } });
  const submit = async (i) => { const p = JournalModals.prototype.parse.call({ some: (x) => x, none: () => null }, i); await JournalModals.prototype.run.call(Object.create(JournalModals.prototype), i, p); };
  await submit(mi(`jrm:${d.id}:notes`, { why: 'Faded the open', lesson: 'Wait for the retest' }));
  let out = JSON.stringify(modalOut.components[0].toJSON());
  assert.ok(out.includes(`te:${d.id}:save`)); assert.ok(out.includes('Unsaved:** notes'));
  await submit(mi(`jrm:${d.id}:pic`, {}, new Collection([['f', { name: 'es.png', url: 'https://cdn.example/es.png', contentType: 'image/png', size: 10 }]])));
  out = JSON.stringify(modalOut.components[0].toJSON());
  assert.ok(out.includes('notes, chart')); assert.ok(out.includes('https://cdn.example/es.png'));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });
  try { c = await h.click(`te:${d.id}:save`); } finally { globalThis.fetch = realFetch; }
  const e = edits.at(-1);
  assert.equal(e.id, kLoss);
  const body = JSON.stringify(e.p.components[0].toJSON());
  assert.ok(body.includes('Faded the open')); assert.ok(body.includes('attachment://es.png')); assert.deepEqual(e.p.attachments, []);
  assert.ok(json(c).includes('Saved to the post'));
  assert.equal(threads.get(kLoss).name.startsWith('LOSS'), true);         // one trade per post: the title is refreshed
  const saved = db.getEntry(row.id);
  assert.equal(JSON.parse(saved.fields_json).why, 'Faded the open'); assert.equal(saved.image_name, 'es.png');
  assert.ok(!JSON.parse(saved.fields_json)._edit && !JSON.parse(saved.fields_json)._finder);
  assert.ok(ed.findTrades('ge', TZ, st({ show: 'nonotes' })).rows.every((r) => r.key !== kLoss));
  assert.equal(ed.changesOf(db.getDraft(d.id)).length, 0);
});

test('fixing the PnL keeps the sign rule, updates the PnL row; an existing chart is carried over', async () => {
  const d = db.createDraft({ userId: 'u', guildId: 'ge' });
  const h = harness(d);
  const row = ed.findTrades('ge', TZ, st()).rows.find((r) => r.key === kWin);
  await h.click(`te:${d.id}:pick`, [String(row.id)]);
  const draft = db.getDraft(d.id);
  assert.equal(draft.fields._edit.imageName, 'chart.png');
  draft.fields.pnl_cents = 150000; db.saveDraft(draft);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
  try { await h.click(`te:${d.id}:save`); } finally { globalThis.fetch = realFetch; }
  assert.equal(db.getPnlEntry(kWin).pnl_cents, 150000);
  assert.ok(JSON.stringify(edits.at(-1).p.components[0].toJSON()).includes('attachment://chart.png'));
  // remove the chart, then discard: nothing changes
  await h.click(`te:${d.id}:rmpic`);
  assert.deepEqual(ed.changesOf(db.getDraft(d.id)), ['chart']);
  await h.click(`te:${d.id}:undo`);
  assert.deepEqual(ed.changesOf(db.getDraft(d.id)), []);
  const c = await h.click(`te:${d.id}:back`);
  assert.ok(json(c).includes('Edit a trade')); assert.ok(!db.getDraft(d.id).fields._edit);
});

test('trades that cannot be rewritten say why instead of opening', async () => {
  const d = db.createDraft({ userId: 'u', guildId: 'ge' });
  const h = harness(d);
  const plain = ed.findTrades('ge', TZ, st()).rows.find((r) => r.key === kText);
  let c = await h.click(`te:${d.id}:pick`, [String(plain.id)]);
  assert.ok(json(c).includes('plain text')); assert.ok(!db.getDraft(d.id).fields._edit);
  threads.delete(kOld);
  const gone = ed.findTrades('ge', TZ, st({ period: 'all' })).rows.find((r) => r.key === kOld);
  c = await h.click(`te:${d.id}:pick`, [String(gone.id)]);
  assert.ok(json(c).includes('deleted'));
  c = await h.click(`te:${d.id}:save`);
  assert.ok(json(c).includes('Pick a trade first'));
});
