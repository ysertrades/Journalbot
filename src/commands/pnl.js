'use strict';
const { Command } = require('@sapphire/framework');
const {
  ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { DateTime } = require('luxon');
const { getSettings, getPnlEntry } = require('../lib/db');
const { canConfigure, isAllowed } = require('../lib/permissions');
const { scanGuild, summaryText } = require('../lib/scanner');
const { weeklyImage, monthlyImage, sendReport } = require('../lib/reports');
const { parseDateInput, formatCents } = require('../lib/money');
const { card, ephemeral } = require('../lib/ui');
const { AttachmentBuilder } = require('discord.js');

const EDIT_NAME = 'Edit journal PnL';

class PnlCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'pnl', description: 'Show journal PnL images' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('pnl').setDescription('Journal PnL images')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .addSubcommand((s) => s.setName('week').setDescription('Weekly PnL image (only visible to you)')
        .addStringOption((o) => o.setName('date').setDescription('Any date inside the week, e.g. 2026-10-14 (default: this week)')))
      .addSubcommand((s) => s.setName('month').setDescription('Monthly PnL image (only visible to you)')
        .addStringOption((o) => o.setName('month').setDescription('YYYY-MM, e.g. 2026-09 (default: this month)')))
      .addSubcommand((s) => s.setName('rescan').setDescription('Rescan all journal forums and rebuild PnL')), { guildIds });
    registry.registerContextMenuCommand((b) => b.setName(EDIT_NAME).setType(ApplicationCommandType.Message)
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall), { guildIds });
  }

  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', 0xf87171)));
    const settings = getSettings(interaction.guildId), sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: 64 | 32768 });
    try {
      if (sub === 'rescan') {
        if (!settings.forums.length) return interaction.editReply(ephemeral(card('No journal forums selected. Use `/journal-settings` → General.', 0xfbbf24)));
        return interaction.editReply({ components: [card(summaryText(await scanGuild(interaction.guild, settings, { force: true })))] });
      }
      await scanGuild(interaction.guild, settings);
      let img;
      if (sub === 'week') {
        const d = interaction.options.getString('date');
        const iso = d ? parseDateInput(d, settings.timezone) : DateTime.now().setZone(settings.timezone).toISODate();
        if (!iso) return interaction.editReply({ components: [card('Could not read that date. Try `2026-10-14`.', 0xfbbf24)] });
        img = weeklyImage(interaction.guildId, iso, settings);
      } else {
        const m = interaction.options.getString('month');
        const now = DateTime.now().setZone(settings.timezone);
        const mm = m ? DateTime.fromFormat(m.trim(), 'yyyy-MM', { zone: settings.timezone }) : now;
        if (!mm.isValid) return interaction.editReply({ components: [card('Could not read that month. Use `YYYY-MM`.', 0xfbbf24)] });
        img = monthlyImage(interaction.guildId, mm.year, mm.month, settings);
      }
      const { reportMessage } = require('../lib/reports');
      const msg = reportMessage(img, { ...settings, ping_role_id: null });
      return interaction.editReply({ components: msg.components, files: msg.files });
    } catch (e) {
      return interaction.editReply({ components: [card(`⚠️ ${e.message}`, 0xf87171)] });
    }
  }

  async contextMenuRun(interaction) {
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', 0xf87171)));
    const ch = interaction.targetMessage.channel;
    if (!ch?.isThread?.() || !ch.parent || ![15, 16].includes(ch.parent.type)) {
      return interaction.reply(ephemeral(card('Use this on a post inside a journal forum.', 0xfbbf24)));
    }
    const cur = getPnlEntry(ch.id);
    const input = new TextInputBuilder().setCustomId('pnl').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(14)
      .setPlaceholder('1250  or  -480');
    if (cur) input.setValue(String(cur.pnl_cents / 100));
    return interaction.showModal(new ModalBuilder().setCustomId(`jre:${ch.id}`).setTitle('Edit journal PnL')
      .addLabelComponents(new LabelBuilder().setLabel('PnL (USD, signed)').setDescription('Overrides the number used in weekly/monthly images').setTextInputComponent(input)));
  }
}
module.exports = { PnlCommand, EDIT_NAME };
