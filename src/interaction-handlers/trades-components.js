'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings, getAccount } = require('../lib/db');
const { isAllowed } = require('../lib/permissions');
const { scanGuild } = require('../lib/scanner');
const { allForums } = require('../lib/routing');
const { RANGES, tradesMessage } = require('../lib/trades-view');
const { card, ephemeral, ERROR_COLOR } = require('../lib/ui');

/** 'all' or an account id from a custom id; anything else is rejected */
const acctOf = (s) => (s === undefined || s === 'all' ? null : /^\d+$/.test(s) ? Number(s) : undefined);

/**
 * The /trades picker, account filter and page buttons. Everything needed to redraw rides in the custom id:
 *   tr:range[:<account|all>]                      period picked (value: day|week|month)
 *   tr:acct:<range|none>                          account picked (value: id|all)
 *   tr:pg:<range>:<page>:<date>[:<account|all>]   page buttons
 */
class TradesComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    const p = i.customId.split(':');
    if (p[0] !== 'tr') return this.none();
    if (p[1] === 'range') {
      const account = acctOf(p[2]);
      return RANGES[i.values?.[0]] && account !== undefined ? this.some({ range: i.values[0], page: 0, anchor: null, account }) : this.none();
    }
    if (p[1] === 'acct') {
      const account = acctOf(i.values?.[0]);
      const range = RANGES[p[2]] ? p[2] : 'day';
      return account !== undefined ? this.some({ range, page: 0, anchor: null, account }) : this.none();
    }
    if (p[1] === 'pg') {
      const [, , range, page, anchor, acct] = p;
      const account = acctOf(acct);
      if (!RANGES[range] || !/^\d+$/.test(page) || !/^\d{4}-\d{2}-\d{2}$/.test(anchor || '') || account === undefined) return this.none();
      return this.some({ range, page: Number(page), anchor, account });
    }
    return this.none();
  }
  async run(i, { range, page, anchor, account }) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    // drawing takes a moment (and a scan first); acknowledge now so Discord never shows "interaction failed"
    await i.deferUpdate();
    const settings = getSettings(i.guildId);
    if (account && getAccount(account)?.guild_id !== i.guildId) account = null;   // a stale or foreign id falls back to every account
    try {
      if (allForums(settings).length) await scanGuild(i.guild, settings).catch((e) => this.container.logger.warn('[trades] scan failed, showing what is stored', e));
      const msg = tradesMessage(i.guildId, settings, range, page, anchor, account);
      return await i.editReply({ components: msg.components, files: msg.files, attachments: [] });
    } catch (e) {
      this.container.logger.error('[trades] failed', e);
      return i.editReply({ components: [card(`⚠️ Could not draw your trades: ${e.message}`, ERROR_COLOR)], files: [], attachments: [] }).catch(() => {});
    }
  }
}
module.exports = { TradesComponents };
