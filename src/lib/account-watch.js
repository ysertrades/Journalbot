'use strict';
/**
 * Watches every active account once a minute and speaks up in the alerts
 * channel: half and 80% of a daily limit or the drawdown, 90% of the target,
 * a breach (the run is marked breached), and a passed evaluation. Each alert
 * is claimed once per account and day (milestones once per run), so a
 * restart or a rescan never repeats one.
 * Also the phase actions every panel shares: move to funded, a new attempt.
 */
const { DateTime } = require('luxon');
const { getSettings, setDefaultAccount, listAccounts, listConfiguredGuilds, updateAccount, createAccount, claimAccountEvent, getAccount } = require('./db');
const { accountView } = require('./accounts');
const { alertMessage } = require('./account-panels');

async function alertChannel(guild, settings) {
  if (!settings.alert_channel_id) return null;
  const ch = await guild.channels.fetch(settings.alert_channel_id).catch(() => null);
  return ch && ch.isTextBased?.() ? ch : null;
}
async function post(guild, settings, payload) {
  const ch = await alertChannel(guild, settings);
  if (ch) await ch.send(payload).catch(() => {});
}

/** checks one server's accounts; returns the alerts it sent, for tests and logs */
async function checkAccounts(guild, settings = getSettings(guild.id)) {
  const sent = [];
  for (const a of listAccounts(guild.id, { includeEnded: false })) {
    const v = accountView(a, settings), s = v.state;
    const say = async (kind, period, extra) => {
      if (!claimAccountEvent(a.id, kind, period)) return false;
      sent.push(kind); await post(guild, settings, alertMessage(kind, v, extra)); return true;
    };
    if (s.breach) {   // the firm would close the run here: so does the journal
      updateAccount(a.id, { status: 'breached', ended_on: s.breach.date, ended_reason: s.breach.kind === 'daily' ? 'daily loss limit' : 'max drawdown' });
      await say('breach', s.breach.key, null);
      continue;
    }
    if (s.passReady) await say('passed', 'run');
    else if (s.progress !== null && s.progress >= 0.9) await say('target90', 'run');
    if (s.dailyUsed !== null && s.dailyUsed >= 0.8) { claimAccountEvent(a.id, 'daily50', v.today); await say('daily80', v.today); }
    else if (s.dailyUsed !== null && s.dailyUsed >= 0.5) await say('daily50', v.today);
    if (s.ddUsed !== null && s.ddUsed >= 0.8) { claimAccountEvent(a.id, 'dd50', v.today); await say('dd80', v.today); }
    else if (s.ddUsed !== null && s.ddUsed >= 0.5) await say('dd50', v.today);
  }
  return sent;
}

let watching = false;
async function watchTick(client) {
  if (watching) return; watching = true;
  try {
    for (const gid of listConfiguredGuilds()) {
      const guild = client.guilds.cache.get(gid); if (!guild) continue;
      if (!listAccounts(gid, { includeEnded: false }).length) continue;
      await checkAccounts(guild, getSettings(gid));
    }
  } finally { watching = false; }
}

const todayIn = (settings) => DateTime.now().setZone(settings.timezone).toISODate();
/** the passed evaluation ends, a funded run starts today with the same limits; new trades go to it */
function moveToFunded(account, settings) {
  const today = todayIn(settings);
  updateAccount(account.id, { status: 'passed', ended_on: today, ended_reason: 'passed' });
  const funded = createAccount(account.guild_id, {
    chain_id: account.chain_id || account.id, name: account.name, firm: account.firm, phase: 'funded', status: 'active', attempt: 1,
    size_cents: account.size_cents, start_balance_cents: account.size_cents, daily_loss_cents: account.daily_loss_cents, max_dd_cents: account.max_dd_cents,
    dd_type: account.dd_type, target_cents: null, min_days: null, consistency_pct: account.consistency_pct, split_pct: account.split_pct || 80, started_on: today,
  });
  if (!settings.default_account_id || Number(settings.default_account_id) === account.id) setDefaultAccount(account.guild_id, funded.id);
  return funded;
}
/** the run ends as breached (if it was not already) and attempt N+1 starts today with the same rules */
function newAttempt(account, settings) {
  const today = todayIn(settings);
  if (account.status === 'active') updateAccount(account.id, { status: 'breached', ended_on: today, ended_reason: account.ended_reason || 'reset' });
  const next = createAccount(account.guild_id, {
    chain_id: account.chain_id || account.id, name: account.name, firm: account.firm, phase: account.phase, status: 'active', attempt: account.attempt + 1,
    size_cents: account.size_cents, start_balance_cents: account.size_cents, target_cents: account.target_cents, daily_loss_cents: account.daily_loss_cents,
    max_dd_cents: account.max_dd_cents, dd_type: account.dd_type, min_days: account.min_days, consistency_pct: account.consistency_pct, split_pct: account.split_pct, started_on: today,
  });
  if (!settings.default_account_id || Number(settings.default_account_id) === account.id) setDefaultAccount(account.guild_id, next.id);
  return next;
}

module.exports = { checkAccounts, watchTick, moveToFunded, newAttempt, post, getAccount };
