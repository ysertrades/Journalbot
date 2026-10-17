'use strict';
const { Listener } = require('@sapphire/framework');
const { maybeScan } = require('../lib/scan-helper');

class ThreadUpdate extends Listener {
  constructor(ctx, o) { super(ctx, { ...o, event: 'threadUpdate' }); }
  async run(oldT, newT) {
    const a = (oldT.appliedTags || []).join(','), b = (newT.appliedTags || []).join(',');
    if (a !== b || oldT.name !== newT.name) await maybeScan(newT, 500);
  }
}
module.exports = { ThreadUpdate };
