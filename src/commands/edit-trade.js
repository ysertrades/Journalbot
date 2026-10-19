'use strict';
const { Command } = require('@sapphire/framework');
const { ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const { getSettings, createDraft, purgeDrafts } = require('../lib/db');
const { finderPanel } = require('../lib/trade-editor');
const { isAllowed } = require('../lib/permissions');
const { card, ephemeral, ERROR_COLOR } = require('../lib/ui');

/** /edit-trade: a private finder over the trades you logged; edit-trade-components handles the rest. */
class EditTradeCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'edit-trade', description: 'Add a chart or notes to a trade you logged, or fix its numbers' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('edit-trade').setDescription('Add a chart or notes to a trade you logged, or fix its numbers (only visible to you)')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall), { guildIds });
  }
  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    purgeDrafts();
    const settings = getSettings(interaction.guildId);
    const draft = createDraft({ userId: interaction.user.id, guildId: interaction.guildId });
    return interaction.reply(ephemeral(finderPanel(draft, interaction.guild, settings)));
  }
}
module.exports = { EditTradeCommand };
