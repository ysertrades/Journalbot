'use strict';
const { Listener } = require('@sapphire/framework');
const { getSettings } = require('../lib/db');
const { ledgerThreads } = require('../lib/routing');
const { scanLedgerMessage } = require('../lib/scanner');

class MessageCreate extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'messageCreate' }); }
  run(message) {
    const ch = message.channel;
    if (!message.guildId || !ch?.isThread?.()) return;
    const s = getSettings(message.guildId);
    if (ledgerThreads(s)[ch.id]) scanLedgerMessage(ch, message, s);   // a trade logged by hand (or by the bot) inside a destination post
  }
}
module.exports = { MessageCreate };
