'use strict';
const { Listener } = require('@sapphire/framework');
const { maybeScan } = require('../lib/scan-helper');
const { getSettings } = require('../lib/db');
const { ledgerThreads } = require('../lib/routing');
const { scanLedgerMessage } = require('../lib/scanner');

class MessageUpdate extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'messageUpdate' }); }
  async run(oldM, newM) {
    try {
      const m = newM.partial ? await newM.fetch() : newM;
      const ch = m.channel;
      if (!ch?.isThread?.() || !m.guildId) return;
      const s = getSettings(m.guildId);
      if (ledgerThreads(s)[ch.id]) scanLedgerMessage(ch, m, s, { force: true });   // edit of a trade inside a destination post
      else if (m.id === ch.id) await maybeScan(ch);                                 // otherwise only the starter message carries the journal
    } catch { /* message gone */ }
  }
}
module.exports = { MessageUpdate };
