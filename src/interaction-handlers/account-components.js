'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { MessageFlags } = require('discord.js');
const { DateTime } = require('luxon');
const { getSettings, saveSettings, getAccount, updateAccount, setDefaultAccount, claimAccountEvent } = require('../lib/db');
const { canConfigure, isAllowed } = require('../lib/permissions');
const { accountView } = require('../lib/accounts');
const ap = require('../lib/account-panels');
const { moveToFunded, newAttempt, post } = require('../lib/account-watch');
const { card, ephemeral, ERROR_COLOR, WARN_COLOR } = require('../lib/ui');

/**
 * Prop firm mode: every ac:<action>[:<id>] button and menu. Works both inside
 * the private settings panel (edited in place) and from an alert in the
 * channel (answered with a private panel).
 */
class AccountComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    if (!i.customId.startsWith('ac:')) return this.none();
    const [, action, id] = i.customId.split(':');
    return this.some({ action, id: id ? Number(id) : null });
  }
  async run(i, { action, id }) {
    // looking (open, switch, back, share) is for anyone allowed to use the journal; changing an account needs Manage Server
    const viewOnly = ['open', 'back', 'share'].includes(action);
    if (viewOnly ? !(canConfigure(i) || isAllowed(i)) : !canConfigure(i)) return i.reply(ephemeral(card('You need **Manage Server** to manage accounts.', ERROR_COLOR)));
    const gid = i.guildId, settings = () => getSettings(gid);
    const inPanel = !!i.message?.flags?.has?.(MessageFlags.Ephemeral);
    // inside a private panel the panel is edited; from a channel alert a private panel is opened
    const show = async (payload) => {
      const p = { ...payload, attachments: [] };
      if (inPanel) return i.deferred || i.replied ? i.editReply(p) : i.update(p);
      return i.deferred || i.replied ? i.editReply(p) : i.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    };
    const settingsPage = () => require('../lib/panels').settingsPanel('accounts', settings());
    const open = async (acctId, o) => {
      const a = getAccount(acctId);
      if (!a || a.guild_id !== gid) return show({ components: [settingsPage()], files: [] });
      // drawing the card takes a moment: acknowledge first (a deferred reply cannot become V2, so a channel click gets a placeholder card)
      if (!i.deferred && !i.replied) await (inPanel ? i.deferUpdate() : i.reply(ephemeral(card('Opening the account…'))));
      return i.editReply({ ...ap.accountPanel(accountView(a, settings()), o), attachments: [] });
    };

    if (action === 'new') return i.showModal(ap.newAccountModal(DateTime.now().setZone(settings().timezone).toISODate()));
    if (action === 'back') return show({ components: [settingsPage()], files: [] });
    if (action === 'alerts') { saveSettings(gid, { alert_channel_id: i.values?.[0] || null }); return show({ components: [settingsPage()], files: [] }); }
    if (action === 'open') return open(id ?? Number(i.values?.[0]));

    const a = id ? getAccount(id) : null;
    if (!a || a.guild_id !== gid) return i.reply(ephemeral(card('That account no longer exists.', WARN_COLOR)));
    const view = () => accountView(getAccount(a.id), settings());
    try {
      if (action === 'rules') return await i.showModal(ap.rulesModal(a));
      if (action === 'ident') return await i.showModal(ap.identModal(a));
      if (action === 'bal') return await i.showModal(ap.balanceModal(a, view().state.balance));
      if (action === 'pay') return await i.showModal(ap.payoutModal(a, DateTime.now().setZone(settings().timezone).toISODate()));
    } catch (e) {
      this.container.logger.error('[accounts] form failed', e);
      return i.reply(ephemeral(card(`⚠️ Could not open that form: ${e.message}`, ERROR_COLOR))).catch(() => {});
    }
    if (action === 'fund' || action === 'retry' || action === 'arch') return open(a.id, { confirm: action === 'arch' ? 'archive' : action });
    if (action === 'fundyes') {
      if (a.status !== 'active' || a.phase !== 'eval') return open(a.id, { notice: '-# This run is not an active evaluation any more.' });
      const funded = moveToFunded(a, settings());
      await post(i.guild, settings(), ap.alertMessage('funded', accountView(funded, settings()), { from: `${a.name} #${a.attempt}` }));
      return open(funded.id, { notice: '\u{1F48E} **Funded.** The evaluation is marked passed and this account starts today. Check its rules; payouts are logged below.' });
    }
    if (action === 'retryyes') {
      if (a.status !== 'active' && a.status !== 'breached') return open(a.id);
      const next = newAttempt(a, settings());
      return open(next.id, { notice: `\u{1F501} **Attempt #${next.attempt}** starts today with the same rules. Good luck.` });
    }
    if (action === 'unbreach') {
      const s = view().state;
      if (s.breach) claimAccountEvent(a.id, 'notbreach', s.breach.key);   // the engine passes over this one from now on
      updateAccount(a.id, { status: 'active', ended_on: null, ended_reason: null });
      return open(a.id, { notice: '-# Marked as not a breach. The run is active again.' });
    }
    if (action === 'def') { setDefaultAccount(gid, a.id); return open(a.id, { notice: '⭐ New trades without an account now land here.' }); }
    if (action === 'archyes') {
      updateAccount(a.id, { status: 'archived', ended_on: a.ended_on || DateTime.now().setZone(settings().timezone).toISODate() });
      if (Number(settings().default_account_id) === a.id) setDefaultAccount(gid, null);
      return show({ components: [settingsPage()], files: [] });
    }
    if (action === 'unarch') { updateAccount(a.id, { status: 'active', ended_on: null }); return open(a.id, { notice: '-# Restored.' }); }
    if (action === 'share') {
      await post(i.guild, settings(), ap.alertMessage('share', view()));
      return open(a.id, { notice: settings().alert_channel_id ? `-# Posted to <#${settings().alert_channel_id}>.` : '-# Set an alerts channel first.' });
    }
    return undefined;
  }
}
module.exports = { AccountComponents };
