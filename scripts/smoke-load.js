'use strict';
// Loads every command, interaction handler and listener through Sapphire without logging in.
const path = require('node:path');
const { SapphireClient, container } = require('@sapphire/framework');
const { GatewayIntentBits } = require('discord.js');
new SapphireClient({ intents: [GatewayIntentBits.Guilds], baseUserDirectory: path.join(__dirname, '..', 'src') });
(async () => {
  container.stores.registerPath(path.join(__dirname, '..', 'src'));
  for (const s of container.stores.values()) await s.loadAll();
  for (const [n, s] of container.stores) console.log(n.padEnd(22), [...s.keys()].join(', '));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
