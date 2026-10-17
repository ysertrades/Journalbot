'use strict';
require('dotenv').config();
const { SapphireClient, LogLevel } = require('@sapphire/framework');
const { GatewayIntentBits, Partials } = require('discord.js');

if (!process.env.DISCORD_TOKEN) { console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.'); process.exit(1); }

const client = new SapphireClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,                       // privileged: enable in the Developer Portal (needed to read journal text for PnL)
    GatewayIntentBits.GuildExpressions ?? GatewayIntentBits.GuildEmojisAndStickers,
  ],
  partials: [Partials.Message, Partials.Channel],
  logger: { level: process.env.LOG_LEVEL ? Number(process.env.LOG_LEVEL) : LogLevel.Info },
});

process.on('unhandledRejection', (e) => client.logger.error('[unhandledRejection]', e));
client.login(process.env.DISCORD_TOKEN);
