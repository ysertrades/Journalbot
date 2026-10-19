'use strict';
const { Command } = require('@sapphire/framework');
const {
  ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { DateTime } = require('luxon');
const { getSettings, getPnlEntry } = require('../lib/db');
const { canConfigure, isAllowed } = require('../lib/permissions');
const { scanGuild, summaryText } = require('../lib/scanner');
const { weeklyImage, monthlyImage, reportMessage } = require('../lib/reports');
const { allForums, ledgerThreads } = require('../lib/routing');
const { parseDateInput, formatCents } = require('../lib/money');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');

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
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const settings = getSettings(interaction.guildId), sub = interaction.options.getSubcommand();
    // Reply at once with a Components V2 message (a deferred reply cannot become V2), then edit it when the work is done.
    // Never pass `flags` to editReply: the message already carries them.
    await interaction.reply(ephemeral(card(sub === 'rescan' ? 'Scanning your journal forums\u2026' : 'Building your PnL image\u2026')));
    const show = (payload) => interaction.editReply(payload);
    try {
      if (sub === 'rescan') {
        if (!allForums(settings).length) return await show({ components: [card('No journal forums set yet. Use `/journal-settings` \u2192 Outcome forums.', WARN_COLOR)] });
        return await show({ components: [card(summaryText(await scanGuild(interaction.guild, settings, { force: true })))] });
      }
      await scanGuild(interaction.guild, settings);
      let img;
      if (sub === 'week') {
        const d = interaction.options.getString('date');
        const iso = d ? parseDateInput(d, settings.timezone) : DateTime.now().setZone(settings.timezone).toISODate();
        if (!iso) return await show({ components: [card('Could not read that date. Try `2026-10-14`.', WARN_COLOR)] });
        img = weeklyImage(interaction.guildId, iso, settings);
      } else {
        const m = interaction.options.getString('month');
        const now = DateTime.now().setZone(settings.timezone);
        const mm = m ? DateTime.fromFormat(m.trim(), 'yyyy-MM', { zone: settings.timezone }) : now;
        if (!mm.isValid) return await show({ components: [card('Could not read that month. Use `YYYY-MM`.', WARN_COLOR)] });
        img = monthlyImage(interaction.guildId, mm.year, mm.month, settings);
      }
      const msg = reportMessage(img, { ...settings, ping_role_id: null });
      return await show({ components: msg.components, files: msg.files });
    } catch (e) {
      this.container.logger.error(`[pnl ${sub}] failed`, e);
      return interaction.editReply({ components: [card(`\u26A0\uFE0F ${e.message}`, ERROR_COLOR)] }).catch(() => {});
    }
  }

  async contextMenuRun(interaction) {
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const msg = interaction.targetMessage, ch = msg.channel;
    if (!ch?.isThread?.() || !ch.parent || ![15, 16].includes(ch.parent.type)) {
      return interaction.reply(ephemeral(card('Use this on a post inside a journal forum.', WARN_COLOR)));
    }
    // a trade inside a destination post is keyed by its message; a one-trade post by the post itself
    const key = ledgerThreads(getSettings(interaction.guildId))[ch.id] ? msg.id : ch.id;
    const cur = getPnlEntry(key);
    const input = new TextInputBuilder().setCustomId('pnl').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(14)
      .setPlaceholder('1250  or  -480');
    if (cur) input.setValue(String(cur.pnl_cents / 100));
    return interaction.showModal(new ModalBuilder().setCustomId(`jre:${key}:${ch.id}`).setTitle('Edit journal PnL')
      .addLabelComponents(new LabelBuilder().setLabel('PnL (USD, signed)').setDescription('Overrides the number used in weekly/monthly images').setTextInputComponent(input)));
  }
}
module.exports = { PnlCommand, EDIT_NAME };
