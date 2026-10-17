'use strict';
const { Listener } = require('@sapphire/framework');
const { deletePnl, getPnlEntry } = require('../lib/db');

class MessageDelete extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'messageDelete' }); }
  run(message) {
    if (!message?.id) return;
    const row = getPnlEntry(message.id);
    // entries inside destination posts are keyed by message id; one-trade-per-post entries go away with threadDelete
    if (row && row.container_id !== row.thread_id) deletePnl(message.id);
  }
}
module.exports = { MessageDelete };
