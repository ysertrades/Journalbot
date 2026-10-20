'use strict';
const { Command } = require('@sapphire/framework');
const { ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const { isAllowed } = require('../lib/permissions');
const { getSettings } = require('../lib/db');
const { pickerPanel } = require('../lib/trades-view');
const { card, ephemeral, ERROR_COLOR } = require('../lib/ui');

/** /trades: a private picker; choosing a period draws the trade ledger (trades-components handles that). */
class TradesCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'trades', description: 'Your trades as a ledger: today, this week or this month' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('trades').setDescription('Your trades as a ledger: today, this week or this month (only visible to you)')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall), { guildIds });
  }
  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    return interaction.reply(ephemeral(pickerPanel(interaction.guildId, getSettings(interaction.guildId))));
  }
}
module.exports = { TradesCommand };
