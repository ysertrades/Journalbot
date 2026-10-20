'use strict';
/**
 * Prop firm mode: the rules engine behind every account.
 *
 * An account run (an evaluation attempt, or a funded phase) is replayed trade
 * by trade from its starting balance: the balance, the drawdown floor (static,
 * trailing on every trade, or trailing on end-of-day balances, and in both
 * trailing kinds it stops once it reaches the starting balance), each day's
 * loss against the daily limit, the target, the trading days and the
 * consistency rule. The first trade that crosses a limit is the breach.
 *
 * The bot only knows what is journaled, so this is an estimate of the
 * firm's numbers; "Correct balance" lines it back up with the real account.
 */
const { DateTime } = require('luxon');
const { accountRows, entryDetailsFor, payoutsOf, chainOf, listAccounts, getSettings, accountEventPeriods } = require('./db');

const PHASES = {
  eval:     { label: 'Evaluation', short: 'EVAL', emoji: '\u{1F9EA}' },
  funded:   { label: 'Funded', short: 'FUNDED', emoji: '\u{1F48E}' },
  personal: { label: 'Personal', short: 'PERSONAL', emoji: '\u{1F464}' },
};
const STATUSES = {
  active:   { label: 'Active', emoji: '\u{1F7E2}' },
  passed:   { label: 'Passed', emoji: '\u{1F3C6}' },
  breached: { label: 'Breached', emoji: '\u{1F534}' },
  archived: { label: 'Archived', emoji: '\u{1F5C4}️' },
};
const DD_TYPES = {
  trailing: { label: 'Trailing', desc: 'Follows your highest balance after every trade, stops at your starting balance' },
  eod:      { label: 'End-of-day trailing', desc: 'Follows your highest closing balance, stops at your starting balance' },
  static:   { label: 'Static', desc: 'A fixed floor below your starting balance' },
};
/**
 * Starting points as a share of the account size, for a new account to be edited to the firm's real
 * numbers. Firms change their rules, so none of these claim to be any firm's official values.
 */
const TEMPLATES = {
  eval:     { target: 0.06, daily: 0.02, dd: 0.03, dd_type: 'trailing', min_days: 5, consistency: null, split: null },
  funded:   { target: null, daily: 0.02, dd: 0.03, dd_type: 'trailing', min_days: null, consistency: null, split: 80 },
  personal: { target: null, daily: null, dd: null, dd_type: 'static', min_days: null, consistency: null, split: null },
};
function rulesFromTemplate(phase, sizeCents) {
  const t = TEMPLATES[phase] || TEMPLATES.eval, pct = (p) => (p ? Math.round(sizeCents * p / 100) * 100 : null);
  return { target_cents: pct(t.target), daily_loss_cents: pct(t.daily), max_dd_cents: pct(t.dd), dd_type: t.dd_type, min_days: t.min_days, consistency_pct: t.consistency, split_pct: t.split };
}

const label = (a) => `${a.name}${a.phase === 'eval' && a.attempt > 1 ? ` #${a.attempt}` : ''}`;
const badge = (a) => [PHASES[a.phase]?.short || 'ACCOUNT', a.size_cents ? `${Math.round(a.size_cents / 100000)}K` : null, a.firm ? String(a.firm).toUpperCase() : null].filter(Boolean).join(' · ');

/**
 * Replays an account run. rows: its PnL rows; at: { key: ms } trade times for ordering within a day.
 * @returns the account's state, every number in dollars
 */
function computeAccount(account, rows, { at = {}, payouts = [], today, ignore = new Set() } = {}) {
  const $ = (c) => (c === null || c === undefined ? null : c / 100);
  const start = $(account.start_balance_cents) || 0, adj = $(account.balance_adj_cents) || 0;
  const target = $(account.target_cents), daily = $(account.daily_loss_cents), dd = $(account.max_dd_cents), type = account.dd_type || 'trailing';
  const trades = rows.filter((r) => r.outcome !== 'missed')
    .map((r) => ({ key: r.thread_id, date: r.date_local, pnl: r.pnl_cents / 100, at: at[r.thread_id] || r.updated_at || 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at - b.at));
  const floorAt = (peak) => (dd === null ? null : type === 'static' ? start - dd : Math.min(peak - dd, start));
  let balance = start + adj, peak = balance, eodPeak = balance, breach = null;
  const series = [{ balance, floor: floorAt(balance), date: account.started_on, key: null }];
  const dayPnl = {};
  let curDay = null;
  for (const t of trades) {
    if (t.date !== curDay) { if (curDay !== null) eodPeak = Math.max(eodPeak, balance); curDay = t.date; }
    const c2 = (v) => Math.round(v * 100) / 100;   // money stays on whole cents however many trades add up
    balance = c2(balance + t.pnl); dayPnl[t.date] = c2((dayPnl[t.date] || 0) + t.pnl);
    if (type === 'trailing') peak = Math.max(peak, balance);
    const floor = floorAt(type === 'eod' ? eodPeak : peak);
    series.push({ balance, floor, date: t.date, key: t.key });
    // a breach the trader marked "not a breach" (data that was wrong, or a firm that ruled otherwise) is passed over
    if (!breach && !ignore.has(t.key) && floor !== null && balance <= floor + 1e-9) breach = { kind: 'drawdown', key: t.key, date: t.date, balance, floor };
    if (!breach && !ignore.has(t.key) && daily !== null && dayPnl[t.date] <= -daily + 1e-9) breach = { kind: 'daily', key: t.key, date: t.date, balance, dayPnl: dayPnl[t.date] };
  }
  if (curDay !== null) eodPeak = Math.max(eodPeak, balance);
  const floor = floorAt(type === 'eod' ? eodPeak : peak);
  const profit = Math.round((balance - start) * 100) / 100;
  const days = Object.keys(dayPnl).sort();
  const bestDay = days.length ? days.reduce((a, b) => (dayPnl[b] > dayPnl[a] ? b : a)) : null;
  const todayPnl = today && dayPnl[today] !== undefined ? dayPnl[today] : 0;
  const share = profit > 0 && bestDay && dayPnl[bestDay] > 0 ? (100 * dayPnl[bestDay]) / profit : null;
  const consistencyOk = !account.consistency_pct || share === null || share <= account.consistency_pct;
  const targetHit = target !== null && profit >= target;
  const daysOk = !account.min_days || days.length >= account.min_days;
  const paid = payouts.reduce((s, p) => s + p.amount_cents / 100, 0);
  return {
    start, balance, profit, adj, peak: type === 'eod' ? eodPeak : peak, floor, room: floor === null ? null : Math.round((balance - floor) * 100) / 100,
    ddUsed: dd ? Math.min(1, Math.max(0, 1 - (balance - floor) / dd)) : null,
    target, daily, dd, ddType: type, todayPnl, dailyRoom: daily === null ? null : daily + Math.min(0, todayPnl),
    dailyUsed: daily ? Math.min(1, Math.max(0, -todayPnl / daily)) : null,
    progress: target ? Math.max(0, Math.min(1, profit / target)) : null,
    trades: trades.length, days: days.length, minDays: account.min_days || null, daysOk,
    bestDay: bestDay ? { date: bestDay, pnl: dayPnl[bestDay] } : null, consistencyShare: share, consistencyPct: account.consistency_pct || null, consistencyOk,
    targetHit, passReady: account.phase === 'eval' && targetHit && daysOk && consistencyOk && !breach,
    breach, series, dayPnl, paid, split: account.split_pct || null, yourShare: account.split_pct ? (paid * account.split_pct) / 100 : null,
  };
}

/** everything the dashboard and alerts need for one account run */
function accountView(account, settings = getSettings(account.guild_id)) {
  const rows = accountRows(account, settings.default_account_id);
  const det = entryDetailsFor(rows.map((r) => r.thread_id)), at = {};
  for (const [k, d] of Object.entries(det)) { let f = {}; try { f = JSON.parse(d.fields_json || '{}'); } catch { /* ignore */ } at[k] = Number(f._at) || d.created_at; }
  const today = DateTime.now().setZone(settings.timezone).toISODate();
  const payouts = payoutsOf(account.id);
  const ignore = new Set(accountEventPeriods(account.id, 'notbreach'));
  return { account, settings, today, payouts, chain: chainOf(account), state: computeAccount(account, rows, { at, payouts, today, ignore }) };
}

/** the account a new trade lands on when none is picked: the default, else the only active one */
function defaultAccountId(guildId, settings = getSettings(guildId)) {
  if (settings.default_account_id) return settings.default_account_id;
  const active = listAccounts(guildId, { includeEnded: false });
  return active.length === 1 ? active[0].id : null;
}

module.exports = { PHASES, STATUSES, DD_TYPES, TEMPLATES, rulesFromTemplate, computeAccount, accountView, defaultAccountId, label, badge };
