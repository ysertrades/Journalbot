'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { DateTime } = require('luxon');
const { getSettings, createAccount, getAccount, updateAccount, addPayout, setDefaultAccount } = require('../lib/db');
const { canConfigure } = require('../lib/permissions');
const { accountView, rulesFromTemplate, PHASES, DD_TYPES } = require('../lib/accounts');
const ap = require('../lib/account-panels');
const { post } = require('../lib/account-watch');
const { parseMoney, parseDateInput } = require('../lib/money');
const { card, ephemeral, ERROR_COLOR, WARN_COLOR } = require('../lib/ui');

const val = (f, id) => { try { return (f.getTextInputValue(id) || '').trim(); } catch { return ''; } };
const sel = (f, id) => { try { return f.getStringSelectValues(id)[0] || null; } catch { return null; } };
/** "" -> null (rule off); a positive amount -> cents; anything else -> undefined (invalid) */
const optMoney = (s) => { if (!s) return null; const c = parseMoney(s); return c === null || c <= 0 ? undefined : Math.abs(c); };
const optInt = (s, max) => { if (!s) return null; const n = Number(String(s).replace(/[%\s]/g, '')); return Number.isInteger(n) && n > 0 && n <= max ? n : undefined; };

/** Prop firm forms: acm:new, acm:rules:<id>, acm:ident:<id>, acm:bal:<id>, acm:pay:<id> */
class AccountModals extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.ModalSubmit }); }
  parse(i) {
    if (!i.customId.startsWith('acm:')) return this.none();
    const [, form, id] = i.customId.split(':');
    return this.some({ form, id: id ? Number(id) : null });
  }
  async run(i, { form, id }) {
    if (!canConfigure(i)) return i.reply(ephemeral(card('You need **Manage Server** to manage accounts.', ERROR_COLOR)));
    const gid = i.guildId, f = i.fields, settings = getSettings(gid);
    const bad = (m) => i.reply(ephemeral(card(`⚠️ ${m}`, WARN_COLOR)));
    // the form was opened from a panel message: redraw it in place
    const show = async (acctId, notice) => {
      await i.deferUpdate();
      return i.editReply({ ...ap.accountPanel(accountView(getAccount(acctId), getSettings(gid)), { notice }), attachments: [] });
    };

    if (form === 'new') {
      const name = val(f, 'name').replace(/[`\n]/g, '').slice(0, 40);
      const size = parseMoney(val(f, 'size'));
      const phase = PHASES[sel(f, 'phase')] ? sel(f, 'phase') : 'eval';
      const start = parseDateInput(val(f, 'start') || 'today', settings.timezone);
      if (!name) return bad('Give the account a name.');
      if (size === null || size <= 0) return bad('The account size should be an amount like `100000`.');
      if (!start) return bad('Could not read the start date. Try `today` or `2026-10-05`.');
      const a = createAccount(gid, { name, firm: val(f, 'firm').replace(/[`\n]/g, '').slice(0, 30) || null, phase, size_cents: Math.abs(size), start_balance_cents: Math.abs(size),
        started_on: start, ...rulesFromTemplate(phase, Math.abs(size)) });
      if (!settings.default_account_id) setDefaultAccount(gid, a.id);
      const r = phase === 'personal' ? 'No firm rules on a personal account; add any you like.' : 'Rules start from a typical template. **Edit them to your firm\'s exact numbers.**';
      return show(a.id, `✨ **Account created.** ${r}`);
    }
    const a = getAccount(id);
    if (!a || a.guild_id !== gid) return bad('That account no longer exists.');
    if (form === 'rules') {
      const target = optMoney(val(f, 'target')), daily = optMoney(val(f, 'daily')), dd = optMoney(val(f, 'dd')), days = optInt(val(f, 'days'), 365);
      const ddType = DD_TYPES[sel(f, 'ddtype')] ? sel(f, 'ddtype') : a.dd_type;
      if ([target, daily, dd].includes(undefined)) return bad('Amounts should be positive numbers like `2000`, or empty to turn the rule off.');
      if (days === undefined) return bad('Trading days should be a whole number, or empty.');
      updateAccount(a.id, { target_cents: target, daily_loss_cents: daily, max_dd_cents: dd, dd_type: ddType, min_days: days });
      return show(a.id, '-# Rules saved. The dashboard is recalculated from the first trade.');
    }
    if (form === 'ident') {
      const name = val(f, 'name').replace(/[`\n]/g, '').slice(0, 40), size = parseMoney(val(f, 'size'));
      const cons = optInt(val(f, 'cons'), 100), split = optInt(val(f, 'split'), 100);
      if (!name) return bad('Give the account a name.');
      if (size === null || size <= 0) return bad('The account size should be an amount like `100000`.');
      if (cons === undefined || split === undefined) return bad('Percentages should be whole numbers from 1 to 100, or empty.');
      const moved = Math.abs(size) !== a.size_cents;
      updateAccount(a.id, { name, firm: val(f, 'firm').replace(/[`\n]/g, '').slice(0, 30) || null, size_cents: Math.abs(size), consistency_pct: cons, split_pct: split,
        ...(moved ? { start_balance_cents: Math.abs(size) } : {}) });
      return show(a.id, '-# Saved.');
    }
    if (form === 'bal') {
      const real = parseMoney(val(f, 'bal'));
      if (real === null) return bad('That is not an amount.');
      const v = accountView(a, settings), now = Math.round((v.state.balance - v.state.adj) * 100);
      updateAccount(a.id, { balance_adj_cents: real - now });
      return show(a.id, `-# Balance set to the platform's number. The ${real - now >= 0 ? 'extra' : 'missing'} ${Math.abs(real - now) / 100} is kept as a correction.`);
    }
    if (form === 'pay') {
      const amount = parseMoney(val(f, 'amount')), date = parseDateInput(val(f, 'date') || 'today', settings.timezone);
      if (amount === null || amount <= 0) return bad('The payout should be a positive amount.');
      if (!date) return bad('Could not read that date.');
      addPayout(a, Math.abs(amount), date, val(f, 'note').slice(0, 80));
      await post(i.guild, settings, ap.alertMessage('payout', accountView(getAccount(a.id), settings), { amount: Math.abs(amount) / 100 }));
      return show(a.id, `\u{1F4B8} **Payout logged.**${settings.alert_channel_id ? ` Announced in <#${settings.alert_channel_id}>.` : ''}`);
    }
    return undefined;
  }
}
module.exports = { AccountModals };
