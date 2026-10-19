'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings } = require('../lib/db');
const { isAllowed } = require('../lib/permissions');
const { scanGuild } = require('../lib/scanner');
const { allForums } = require('../lib/routing');
const { RANGES, tradesMessage } = require('../lib/trades-view');
const { card, ephemeral, ERROR_COLOR } = require('../lib/ui');

/** The /trades period picker and page buttons (custom ids tr:range and tr:pg:<range>:<page>:<date>). */
class TradesComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    if (i.customId === 'tr:range') return RANGES[i.values?.[0]] ? this.some({ range: i.values[0], page: 0, anchor: null }) : this.none();
    if (i.customId.startsWith('tr:pg:')) {
      const [, , range, page, anchor] = i.customId.split(':');
      if (!RANGES[range] || !/^\d+$/.test(page) || !/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) return this.none();
      return this.some({ range, page: Number(page), anchor });
    }
    return this.none();
  }
  async run(i, { range, page, anchor }) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    // drawing takes a moment (and a scan first); acknowledge now so Discord never shows "interaction failed"
    await i.deferUpdate();
    const settings = getSettings(i.guildId);
    try {
      if (allForums(settings).length) await scanGuild(i.guild, settings).catch((e) => this.container.logger.warn('[trades] scan failed, showing what is stored', e));
      const msg = tradesMessage(i.guildId, settings, range, page, anchor);
      return await i.editReply({ components: msg.components, files: msg.files, attachments: [] });
    } catch (e) {
      this.container.logger.error('[trades] failed', e);
      return i.editReply({ components: [card(`⚠️ Could not draw your trades: ${e.message}`, ERROR_COLOR)], files: [], attachments: [] }).catch(() => {});
    }
  }
}
module.exports = { TradesComponents };
