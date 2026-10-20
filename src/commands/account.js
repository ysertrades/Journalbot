'use strict';
const { Command } = require('@sapphire/framework');
const { ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const { getSettings, getAccount, listAccounts } = require('../lib/db');
const { isAllowed } = require('../lib/permissions');
const { accountView, label, badge } = require('../lib/accounts');
const { accountPanel } = require('../lib/account-panels');
const { scanGuild } = require('../lib/scanner');
const { allForums } = require('../lib/routing');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');

/** /account [account]: a prop account's dashboard, privately, with its rules and phase actions */
class AccountCommand extends Command {
  constructor(ctx, opts) { super(ctx, { ...opts, name: 'account', description: 'Your prop account dashboard' }); }
  registerApplicationCommands(registry) {
    const guildIds = process.env.GUILD_ID ? [process.env.GUILD_ID] : undefined;
    registry.registerChatInputCommand((b) => b.setName('account').setDescription('Prop account dashboard: target, drawdown, today, payouts (only visible to you)')
      .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .addStringOption((o) => o.setName('account').setDescription('Which account (default: your default account)').setAutocomplete(true)), { guildIds });
  }
  async autocompleteRun(interaction) {
    const q = String(interaction.options.getFocused() || '').toLowerCase();
    const opts = listAccounts(interaction.guildId).filter((a) => a.status !== 'archived')
      .map((a) => ({ name: `${label(a)} · ${badge(a)}${a.status !== 'active' ? ` · ${a.status}` : ''}`.slice(0, 100), value: String(a.id) }))
      .filter((o) => !q || o.name.toLowerCase().includes(q));
    return interaction.respond(opts.slice(0, 25)).catch(() => {});
  }
  async chatInputRun(interaction) {
    if (!interaction.guild) return interaction.reply(ephemeral(card('Use this inside a server.')));
    if (!isAllowed(interaction)) return interaction.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const settings = getSettings(interaction.guildId), raw = interaction.options.getString('account');
    const list = listAccounts(interaction.guildId);
    const a = raw ? (list.find((x) => String(x.id) === raw) || list.find((x) => label(x).toLowerCase() === raw.toLowerCase()))
      : getAccount(settings.default_account_id) || list.find((x) => x.status === 'active') || list[0];
    if (!list.length) return interaction.reply(ephemeral(card('# \u{1F3E6} No accounts yet\nCreate one for each eval, funded or personal account in `/journal-settings` → **Accounts**. Each gets its own target, daily limit and drawdown, and this dashboard.', WARN_COLOR)));
    if (!a) return interaction.reply(ephemeral(card(`No account called **${String(raw).slice(0, 40)}**.`, WARN_COLOR)));
    await interaction.reply(ephemeral(card('Building the dashboard…')));
    try {
      if (allForums(settings).length) await scanGuild(interaction.guild, settings).catch(() => {});
      return await interaction.editReply({ ...accountPanel(accountView(a, getSettings(interaction.guildId))), attachments: [] });
    } catch (e) {
      this.container.logger.error('[account] failed', e);
      return interaction.editReply({ components: [card(`⚠️ ${e.message}`, ERROR_COLOR)] }).catch(() => {});
    }
  }
}
module.exports = { AccountCommand };
