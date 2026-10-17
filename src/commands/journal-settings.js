'use strict';
const { Command } = require('@sapphire/framework');
const { ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const { getSettings } = require('../lib/db');
const { settingsPanel } = require('../lib/panels');
const { canConfigure } = require('../lib/permissions');
const { card, ephemeral } = require('../lib/ui');

class JournalSettingsCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'journal-settings', description: 'Configure the journal bot' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('journal-settings').setDescription('Configure forums, report channel and schedule')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall), { guildIds });
  }
  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!canConfigure(interaction)) return interaction.reply(ephemeral(card('You need **Manage Server** to change journal settings.', 0xf87171)));
    return interaction.reply(ephemeral(settingsPanel('general', getSettings(interaction.guildId))));
  }
}
module.exports = { JournalSettingsCommand };
