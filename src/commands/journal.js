'use strict';
const { Command } = require('@sapphire/framework');
const { ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const { getSettings, createDraft, purgeDrafts } = require('../lib/db');
const { journalPanel } = require('../lib/panels');
const { isAllowed } = require('../lib/permissions');
const { validateImage, imageRecord } = require('../lib/poster');
const { card, ephemeral } = require('../lib/ui');

class JournalCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'journal', description: 'Log a trade to your journal forum' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('journal').setDescription('Log a trade to your journal forum')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .addAttachmentOption((o) => o.setName('picture').setDescription('Optional chart screenshot shown above the journal text')), { guildIds });
  }
  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', 0xf87171)));
    purgeDrafts();
    const settings = getSettings(interaction.guildId);
    const pic = interaction.options.getAttachment('picture');
    const problem = validateImage(pic);
    const draft = createDraft({ userId: interaction.user.id, guildId: interaction.guildId, forumId: settings.default_forum_id, image: pic && !problem ? imageRecord(pic) : null });
    return interaction.reply(ephemeral(journalPanel(draft, interaction.guild, settings, { notice: problem ? `⚠️ ${problem}` : undefined })));
  }
}
module.exports = { JournalCommand };
