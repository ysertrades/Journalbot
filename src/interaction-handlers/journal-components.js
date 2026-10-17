'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { ChannelType, ContainerBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getSettings, getDraft, saveDraft, deleteDraft } = require('../lib/db');
const { journalPanel, previewPanel, tradeModal, resultModal, notesModal, pictureModal, isReady, missingParts } = require('../lib/panels');
const { isAllowed } = require('../lib/permissions');
const { postJournal } = require('../lib/poster');
const { OUTCOMES } = require('../lib/format');
const { card, ephemeral } = require('../lib/ui');
const { routeTarget } = require('../lib/routing');

class JournalComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    if (!i.customId.startsWith('jr:')) return this.none();
    const [, id, action, arg] = i.customId.split(':');
    return this.some({ id, action, arg });
  }
  async run(i, { id, action, arg }) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', 0xf87171)));
    const draft = getDraft(id);
    if (!draft) return i.reply(ephemeral(card('This journal panel expired. Run `/journal` again.', 0xfbbf24)));
    if (draft.userId !== i.user.id) return i.reply(ephemeral(card('This panel belongs to someone else.', 0xf87171)));
    const settings = getSettings(i.guildId);
    const refresh = (notice) => i.update({ components: [journalPanel(draft, i.guild, settings, { notice })] });

    if (action === 'o') {
      draft.outcome = arg;
      if (!draft.fields._forum_manual) {                                              // each outcome has its own destination unless the user overrode it
        const t = routeTarget(settings, arg);
        draft.forumId = t?.forumId || null;
        if (t?.threadId) draft.fields._thread = t.threadId; else delete draft.fields._thread;
      }
      if (arg === 'missed') draft.fields.pnl_cents = 0;
      else if (draft.fields.pnl_cents !== undefined && draft.fields.pnl_cents !== null) {
        const c = draft.fields.pnl_cents; draft.fields.pnl_cents = arg === 'win' ? Math.abs(c) : arg === 'loss' ? -Math.abs(c) : c;
      }
      saveDraft(draft); return refresh();
    }
    if (action === 'edit') {
      if (arg !== 'pic' && !draft.outcome) return refresh('Pick an outcome first.');
      try {
        return await i.showModal({ pic: pictureModal, trade: tradeModal, result: resultModal, notes: notesModal }[arg](draft));
      } catch (e) {
        this.container.logger.error(`[journal] could not open ${arg} modal`, e);
        return i.reply(ephemeral(card(`\u26A0\uFE0F Could not open that form: ${e.message}`, 0xf87171))).catch(() => {});
      }
    }
    if (action === 'forum') {
      draft.forumId = i.values[0]; draft.fields._forum_manual = true; delete draft.fields._thread; saveDraft(draft); return refresh();
    }
    if (action === 'preview') {
      if (!draft.outcome) return refresh('Pick an outcome first.');
      return i.reply(ephemeral(previewPanel(draft, i.guild, settings)));
    }
    if (action === 'cancel') {
      deleteDraft(id);
      return i.update({ components: [card('Journal entry cancelled.')] });
    }
    if (action === 'post') {
      if (!isReady(draft)) return refresh(`Still needed: ${missingParts(draft).join(', ')}`);
      await i.update({ components: [card(`${OUTCOMES[draft.outcome].label}: posting…`, OUTCOMES[draft.outcome].color)] });
      try {
        const { thread, messageId, existing, tagApplied } = await postJournal({ guild: i.guild, draft, settings });
        deleteDraft(id);
        const c = new ContainerBuilder().setAccentColor(OUTCOMES[draft.outcome].color)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Posted\n${existing ? `Added to <#${thread.id}>` : `<#${thread.id}>`}${existing || tagApplied ? '' : `\n-# No \`${OUTCOMES[draft.outcome].tag}\` tag exists on that forum, so the post has no tag. Add one to enable tag-based outcome detection.`}`))
          .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(existing ? 'Open trade' : 'Open post').setURL(`https://discord.com/channels/${i.guildId}/${thread.id}${existing ? `/${messageId}` : ''}`)));
        return await i.editReply({ components: [c] });
      } catch (e) {
        this.container.logger.error('[journal] post failed', e);
        return i.editReply({ components: [journalPanel(draft, i.guild, settings, { notice: `⚠️ Could not post: ${e.message}` })] }).catch(() => {});
      }
    }
    return undefined;
  }
}
module.exports = { JournalComponents };
