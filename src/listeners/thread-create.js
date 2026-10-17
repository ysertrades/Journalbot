'use strict';
const { Listener } = require('@sapphire/framework');
const { maybeScan } = require('../lib/scan-helper');

class ThreadCreate extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'threadCreate' }); }
  async run(thread, newlyCreated) { if (newlyCreated) await maybeScan(thread, 4000); }
}
module.exports = { ThreadCreate };
