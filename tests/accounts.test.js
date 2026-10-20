'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `accounts-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection } = require('discord.js');
const { DateTime } = require('luxon');
const db = require('../src/lib/db');
const { computeAccount, rulesFromTemplate, accountView } = require('../src/lib/accounts');
const { checkAccounts, moveToFunded, newAttempt } = require('../src/lib/account-watch');
const ap = require('../src/lib/account-panels');
const { settingsPanel } = require('../src/lib/panels');
const { postJournal } = require('../src/lib/poster');
const { weekData } = require('../src/lib/pnl');
const { AccountModals } = require('../src/interaction-handlers/account-modals');
const { AccountComponents } = require('../src/interaction-handlers/account-components');

const TZ = 'America/New_York';
const today = DateTime.now().setZone(TZ).toISODate();
const ago = (n) => DateTime.now().setZone(TZ).minus({ days: n }).toISODate();
let k = 0;
const rows = (list) => list.map(([date, pnl]) => ({ thread_id: `r${++k}`, date_local: date, outcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be', pnl_cents: pnl * 100, updated_at: k }));
const base = (o = {}) => ({ id: 1, start_balance_cents: 10000000, balance_adj_cents: 0, phase: 'eval', started_on: '2026-10-01', target_cents: 600000, daily_loss_cents: 200000,
  max_dd_cents: 300000, dd_type: 'trailing', min_days: 3, consistency_pct: null, ...o });

test('the engine: a trailing floor rises with the balance and stops at the starting balance', () => {
  const s = computeAccount(base(), rows([['2026-10-01', 1000], ['2026-10-02', 1500], ['2026-10-02', -700], ['2026-10-03', 1200]]));
  assert.equal(s.balance, 103000); assert.equal(s.profit, 3000);
  assert.equal(s.floor, 100000);                         // peak 103,000 - 3,000, capped at the start
  assert.equal(s.series[1].floor, 98000);                // after +1,000: 101,000 - 3,000
  assert.equal(s.room, 3000); assert.equal(s.days, 3); assert.ok(!s.breach);
  assert.equal(Math.round(s.progress * 100), 50);
  // end-of-day trailing only moves on closing balances: an intraday high does not lift it
  const e = computeAccount(base({ dd_type: 'eod' }), rows([['2026-10-01', 1500], ['2026-10-01', -1000]]));
  assert.equal(e.floor, 97500);   // only the day's close (100,500) counts, not its 101,500 high: 100,500 - 3,000
  const st = computeAccount(base({ dd_type: 'static' }), rows([['2026-10-01', 2500]]));
  assert.equal(st.floor, 97000);
});

test('the engine: the first trade over a limit is the breach; marked trades are passed over', () => {
  const daily = computeAccount(base(), rows([['2026-10-01', -1200], ['2026-10-01', -900], ['2026-10-02', 400]]));
  assert.equal(daily.breach.kind, 'daily'); assert.equal(daily.breach.date, '2026-10-01');
  const dd = computeAccount(base({ daily_loss_cents: null }), rows([['2026-10-01', 2000], ['2026-10-02', -2500], ['2026-10-03', -2600]]));
  assert.equal(dd.breach.kind, 'drawdown'); assert.equal(dd.breach.date, '2026-10-03');   // floor 99,000; balance 96,900
  const ignored = computeAccount(base({ daily_loss_cents: null }), rows([['2026-10-01', -3100]]), { ignore: new Set([`r${k}`]) });
  assert.equal(ignored.breach, null);
});

test('the engine: passing needs the target, the minimum days and the consistency rule', () => {
  const two = computeAccount(base(), rows([['2026-10-01', 3000], ['2026-10-02', 3100]]));
  assert.ok(two.targetHit); assert.ok(!two.daysOk); assert.ok(!two.passReady);
  const three = computeAccount(base(), rows([['2026-10-01', 2000], ['2026-10-02', 2100], ['2026-10-03', 2000]]));
  assert.ok(three.passReady);
  const lopsided = computeAccount(base({ consistency_pct: 30 }), rows([['2026-10-01', 4000], ['2026-10-02', 1000], ['2026-10-03', 1100]]));
  assert.ok(!lopsided.consistencyOk); assert.ok(!lopsided.passReady); assert.equal(Math.round(lopsided.consistencyShare), 66);
  assert.deepEqual(rulesFromTemplate('eval', 10000000), { target_cents: 600000, daily_loss_cents: 200000, max_dd_cents: 300000, dd_type: 'trailing', min_days: 5, consistency_pct: null, split_pct: null });
});

const put = (key, date, cents, account = null) => {
  db.upsertPnl({ thread_id: key, container_id: key, guild_id: 'ga', forum_id: 'F', outcome: cents > 0 ? 'win' : cents < 0 ? 'loss' : 'be', pnl_cents: cents, date_local: date, source: 'bot' });
  if (account) db.setTradeAccount(key, account);
};

test('accounts: untagged trades count for the default; filters keep one account; switching the default never moves history', () => {
  const evalA = db.createAccount('ga', { name: '100K Hyperprop', phase: 'eval', size_cents: 10000000, started_on: ago(10), ...rulesFromTemplate('eval', 10000000) });
  const personal = db.createAccount('ga', { name: 'Cash', phase: 'personal', size_cents: 2500000, started_on: ago(10) });
  db.setDefaultAccount('ga', evalA.id);
  assert.equal(evalA.chain_id, evalA.id);
  put('u1', ago(3), 50000); put('u2', ago(2), -20000); put('p1', ago(2), 9900, personal.id);
  const wk = (acct) => db.pnlBetween('ga', ago(30), today, acct).map((r) => r.thread_id).sort();
  assert.deepEqual(wk(evalA.id), ['u1', 'u2']); assert.deepEqual(wk(personal.id), ['p1']); assert.equal(wk(null).length, 3);
  assert.equal(accountView(evalA).state.profit, 300);
  db.setDefaultAccount('ga', personal.id);                  // the eval keeps its untagged trades
  assert.deepEqual(wk(evalA.id), ['u1', 'u2']); assert.deepEqual(wk(personal.id), ['p1']);
  assert.equal(weekData('ga', ago(2), TZ, '$', personal.id).total >= 0, true);
  db.setDefaultAccount('ga', evalA.id);
});

test('the journey: funded starts today from a passed eval; a new attempt keeps the history; the default follows', () => {
  const a = db.createAccount('ga', { name: '50K Topstep', phase: 'eval', size_cents: 5000000, started_on: ago(5), ...rulesFromTemplate('eval', 5000000) });
  db.setDefaultAccount('ga', a.id);
  const second = newAttempt(a, db.getSettings('ga'));
  assert.equal(second.attempt, 2); assert.equal(db.getAccount(a.id).status, 'breached'); assert.equal(db.getSettings('ga').default_account_id, second.id);
  const funded = moveToFunded(second, db.getSettings('ga'));
  assert.equal(funded.phase, 'funded'); assert.equal(funded.target_cents, null); assert.equal(funded.daily_loss_cents, second.daily_loss_cents); assert.equal(funded.split_pct, 80);
  assert.equal(db.getAccount(second.id).status, 'passed'); assert.equal(db.getSettings('ga').default_account_id, funded.id);
  assert.deepEqual(db.chainOf(funded).map((x) => `${x.phase}${x.attempt}:${x.status}`), ['eval1:breached', 'eval2:passed', 'funded1:active']);
  db.addPayout(funded, 150000, today, 'first');
  const v = accountView(db.getAccount(funded.id));
  assert.equal(v.state.paid, 1500); assert.equal(v.state.yourShare, 1200);
});

function fakeGuild(sent) {
  const channel = { id: 'ALERTS', isTextBased: () => true, send: async (p) => { sent.push(p); return { id: 'm' }; } };
  return { id: 'gw', channels: { fetch: async (id) => (id === 'ALERTS' ? channel : null) }, emojis: { cache: new Collection() } };
}

test('alerts: warnings at 50% and 80% once a day, a breach closes the run, a passed eval is announced once', async () => {
  db.saveSettings('gw', { alert_channel_id: 'ALERTS', timezone: TZ });
  const a = db.createAccount('gw', { name: 'Watch', phase: 'eval', size_cents: 10000000, started_on: ago(5), target_cents: 600000, daily_loss_cents: 200000, max_dd_cents: 300000, min_days: 1 });
  db.setDefaultAccount('gw', a.id);
  const sent = [], guild = fakeGuild(sent);
  const putw = (key, date, cents) => db.upsertPnl({ thread_id: key, container_id: key, guild_id: 'gw', forum_id: 'F', outcome: cents > 0 ? 'win' : 'loss', pnl_cents: cents, date_local: date, source: 'bot' });
  putw('w1', today, -110000);
  assert.deepEqual(await checkAccounts(guild), ['daily50']);
  assert.deepEqual(await checkAccounts(guild), []);                       // never twice the same day
  putw('w2', today, -60000);
  assert.deepEqual(await checkAccounts(guild), ['daily80', 'dd50']);    // -1,700 is also more than half the 3,000 drawdown
  const warn = JSON.stringify(sent.at(-2).components[0].toJSON());
  assert.ok(warn.includes('80%')); assert.ok(warn.includes('left')); assert.equal(sent.at(-2).flags, 1 << 15);
  assert.ok(JSON.stringify(sent.at(-1).components[0].toJSON()).includes('Half the drawdown used'));
  putw('w3', today, -40000);                                              // -2,100 today: over the daily limit
  assert.deepEqual(await checkAccounts(guild), ['breach']);
  assert.equal(db.getAccount(a.id).status, 'breached');
  assert.ok(sent.at(-1).files.length === 1 && JSON.stringify(sent.at(-1).components[0].toJSON()).includes(`ac:retry:${a.id}`));
  assert.deepEqual(await checkAccounts(guild), []);                       // ended runs are no longer watched

  const b = newAttempt(db.getAccount(a.id), db.getSettings('gw'));
  db.updateAccount(b.id, { started_on: today });
  for (const [kk, c] of [['p1', 300000], ['p2', 310000]]) { db.upsertPnl({ thread_id: kk, container_id: kk, guild_id: 'gw', forum_id: 'F', outcome: 'win', pnl_cents: c, date_local: today, source: 'bot' }); db.setTradeAccount(kk, b.id); }
  assert.ok((await checkAccounts(guild)).includes('passed'));
  assert.ok(!(await checkAccounts(guild)).includes('passed'));
  assert.ok(JSON.stringify(sent.at(-1).components[0].toJSON()).includes(`ac:fund:${b.id}`) || sent.some((m) => JSON.stringify(m.components[0].toJSON()).includes(`ac:fund:${b.id}`)));
});

test('panels: the Accounts page, one account and every alert stay inside Discord limits, dark and V2', () => {
  const s = db.getSettings('ga');
  const page = settingsPanel('accounts', s).toJSON(), pj = JSON.stringify(page);
  for (const x of ['ac:new', 'ac:alerts', 'ac:open', 'Prop firm mode', 'js:nav:accounts']) assert.ok(pj.includes(x), x);
  assert.equal(page.accent_color, 0x111214);
  const count = (o) => (o && typeof o === 'object' ? (o.type ? 1 : 0) + Object.values(o).reduce((n, v) => n + count(v), 0) : 0);
  assert.ok(count(page) <= 40);
  for (const [n, a] of db.listAccounts('ga').entries()) {
    const p = ap.accountPanel(accountView(a, s));
    const j = p.components[0].toJSON();
    assert.ok(count(j) <= 40, `${a.name} has ${count(j)} components`);
    assert.equal(p.files.length, 1); assert.ok(JSON.stringify(j).includes(`attachment://account-${a.id}.png`));
    if (n) continue;   // the confirm rows and alerts once: each draws a card
    for (const confirm of ['fund', 'retry', 'archive']) assert.ok(count(ap.accountPanel(accountView(a, s), { confirm }).components[0].toJSON()) <= 40);
    for (const kind of ['daily50', 'dd80', 'target90', 'breach', 'passed', 'funded', 'payout', 'share']) {
      const m = ap.alertMessage(kind, accountView(a, s), { amount: 1000 });
      assert.equal(m.flags, 1 << 15); assert.ok(m.components[0].toJSON().components.length);
    }
  }
});

function modalI(customId, values, picks = {}) {
  let out;
  const i = { customId, guildId: 'gm', guild: fakeGuild([]), user: { id: 'o' }, memberPermissions: { has: () => true },
    fields: { getTextInputValue: (id) => values[id] ?? '', getStringSelectValues: (id) => (picks[id] ? [picks[id]] : []) },
    deferUpdate: async () => {}, editReply: async (p) => { out = p; }, reply: async (p) => { out = p; } };
  return { i, out: () => out };
}
const runModal = async (i) => AccountModals.prototype.run.call(Object.create(AccountModals.prototype), i, AccountModals.prototype.parse.call({ some: (x) => x, none: () => null }, i));

test('forms: a new account gets template rules and becomes the default; bad rules are refused; balance and payouts', async () => {
  db.saveSettings('gm', { timezone: TZ });
  let m = modalI('acm:new', { name: '150K Apex', size: '150000', start: 'today', firm: 'Apex' }, { phase: 'eval' });
  await runModal(m.i);
  const a = db.listAccounts('gm')[0];
  assert.equal(a.name, '150K Apex'); assert.equal(a.target_cents, 900000); assert.equal(db.getSettings('gm').default_account_id, a.id);
  assert.ok(JSON.stringify(m.out().components[0].toJSON()).includes('Account created'));
  m = modalI(`acm:rules:${a.id}`, { target: '9000', daily: 'lots', dd: '4500', days: '' }, { ddtype: 'eod' });
  await runModal(m.i);
  assert.ok(JSON.stringify(m.out().components[0].toJSON()).includes('positive numbers')); assert.equal(db.getAccount(a.id).daily_loss_cents, a.daily_loss_cents);
  m = modalI(`acm:rules:${a.id}`, { target: '9000', daily: '', dd: '4500', days: '' }, { ddtype: 'eod' });
  await runModal(m.i);
  const r = db.getAccount(a.id);
  assert.equal(r.daily_loss_cents, null); assert.equal(r.max_dd_cents, 450000); assert.equal(r.dd_type, 'eod'); assert.equal(r.min_days, null);
  m = modalI(`acm:bal:${a.id}`, { bal: '150250' }); await runModal(m.i);
  assert.equal(accountView(db.getAccount(a.id)).state.balance, 150250);
  // the buttons: move to funded asks first, then does it
  const clicks = [];
  const click = async (customId) => {
    const i = { customId, guildId: 'gm', guild: fakeGuild([]), user: { id: 'o' }, memberPermissions: { has: () => true }, message: { flags: { has: () => true } }, values: [],
      update: async (p) => clicks.push(p), deferUpdate: async () => {}, editReply: async (p) => clicks.push(p), reply: async (p) => clicks.push(p), showModal: async (p) => clicks.push(p) };
    const self = Object.create(AccountComponents.prototype, { container: { value: { logger: { error() {} } } } });
    await AccountComponents.prototype.run.call(self, i, AccountComponents.prototype.parse.call({ some: (x) => x, none: () => null }, i));
    return clicks.at(-1);
  };
  let c = await click(`ac:fund:${a.id}`);
  assert.ok(JSON.stringify(c.components[0].toJSON()).includes(`ac:fundyes:${a.id}`));
  c = await click(`ac:fundyes:${a.id}`);
  const funded = db.listAccounts('gm').find((x) => x.phase === 'funded');
  assert.ok(funded); assert.ok(JSON.stringify(c.components[0].toJSON()).includes('Funded'));
  c = await click(`ac:pay:${funded.id}`);
  assert.ok(JSON.stringify(c.toJSON()).includes(`acm:pay:${funded.id}`));
  m = modalI(`acm:pay:${funded.id}`, { amount: '2000', date: 'today' }); await runModal(m.i);
  assert.equal(db.payoutsOf(funded.id).length, 1);
});

test('tagging: a trade posted with an account counts toward it', async () => {
  const acct = db.createAccount('gp', { name: 'Tagged', phase: 'personal', size_cents: 100000, started_on: ago(1) });
  const forum = { id: 'FP', type: ChannelType.GuildForum, availableTags: [], threads: { create: async () => ({ id: 'post-tagged', send: async () => ({}) }) } };
  const guild = { id: 'gp', channels: { fetch: async (id) => (id === 'FP' ? forum : null) }, emojis: { cache: new Collection() } };
  const draft = { userId: 'u', outcome: 'win', forumId: 'FP', image: null, fields: { instrument: 'NQ', direction: 'Long', date: today, pnl_cents: 12345, _account: acct.id } };
  await postJournal({ guild, draft, settings: db.getSettings('gp') });
  assert.equal(db.tradeAccountOf('post-tagged'), acct.id);
  assert.ok(!JSON.parse(db.editableTrades('gp')[0].fields_json)._account);
  assert.equal(accountView(acct).state.profit, 123.45);
});
