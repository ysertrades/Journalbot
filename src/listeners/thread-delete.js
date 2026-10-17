'use strict';
const { Listener } = require('@sapphire/framework');
const { deletePnlByContainer } = require('../lib/db');

class ThreadDelete extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'threadDelete' }); }
  run(thread) { if (thread?.id) deletePnlByContainer(thread.id); }
}
module.exports = { ThreadDelete };
