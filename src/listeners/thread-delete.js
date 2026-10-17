'use strict';
const { Listener } = require('@sapphire/framework');
const { deletePnl } = require('../lib/db');

class ThreadDelete extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'threadDelete' }); }
  run(thread) { if (thread?.id) deletePnl(thread.id); }
}
module.exports = { ThreadDelete };
