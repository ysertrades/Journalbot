'use strict';
const { Listener } = require('@sapphire/framework');
const { maybeScan } = require('../lib/scan-helper');

class MessageUpdate extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'messageUpdate' }); }
  async run(oldM, newM) {
    try {
      const m = newM.partial ? await newM.fetch() : newM;
      const ch = m.channel;
      if (ch?.isThread?.() && m.id === ch.id) await maybeScan(ch); // only the starter message carries the journal
    } catch { /* message gone */ }
  }
}
module.exports = { MessageUpdate };
