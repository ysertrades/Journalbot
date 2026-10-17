'use strict';
const { Listener } = require('@sapphire/framework');
const cron = require('node-cron');
const { purgeDrafts, listConfiguredGuilds, getSettings } = require('../lib/db');
const { tick } = require('../lib/reports');
const { scanGuild } = require('../lib/scanner');

class ReadyListener extends Listener {
  constructor(ctx, opts) { super(ctx, { ...opts, event: 'clientReady', once: true }); }
  async run(client) {
    const log = this.container.logger;
    log.info(`[journal] ready as ${client.user.tag} in ${client.guilds.cache.size} guild(s)`);
    purgeDrafts();
    const safe = (name, fn) => async () => { try { await fn(); } catch (e) { log.error(`[journal] ${name} failed`, e); } };
    cron.schedule('* * * * *', safe('report tick', () => tick(client)));        // weekly / month-end scheduler (idempotent, with 6h catch-up)
    cron.schedule('*/10 * * * *', safe('draft purge', async () => purgeDrafts()));
    cron.schedule('30 3 * * *', safe('nightly rescan', async () => {            // safety net for edits made while the bot was offline
      for (const gid of listConfiguredGuilds()) {
        const guild = client.guilds.cache.get(gid), s = getSettings(gid);
        if (guild && s.forums.length) await scanGuild(guild, s);
      }
    }));
    setTimeout(safe('startup tick', () => tick(client)), 15_000);                  // catch up on anything missed while offline
  }
}
module.exports = { ReadyListener };
