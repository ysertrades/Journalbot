'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { ChannelType, ContainerBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { getSettings, getDraft, saveDraft, deleteDraft, markImported, importedHashes } = require('../lib/db');
const { journalPanel, previewPanel, tradeModal, resultModal, notesModal, pictureModal, csvModal, csvProgressCard, isReady, missingParts } = require('../lib/panels');
const { toFields } = require('../lib/csv-import');
const { formatCents } = require('../lib/money');

const IMPORT_PER_RUN = 400;   // stays well inside the 15-minute interaction window
const { isAllowed } = require('../lib/permissions');
const { postJournal } = require('../lib/poster');
const { OUTCOMES } = require('../lib/format');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');
const { routeTarget } = require('../lib/routing');

class JournalComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    if (!i.customId.startsWith('jr:')) return this.none();
    const [, id, action, arg] = i.customId.split(':');
    return this.some({ id, action, arg });
  }
  async run(i, { id, action, arg }) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const draft = getDraft(id);
    if (!draft) return i.reply(ephemeral(card('This journal panel expired. Run `/journal` again.', WARN_COLOR)));
    if (draft.userId !== i.user.id) return i.reply(ephemeral(card('This panel belongs to someone else.', ERROR_COLOR)));
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
        return i.reply(ephemeral(card(`\u26A0\uFE0F Could not open that form: ${e.message}`, ERROR_COLOR))).catch(() => {});
      }
    }
    if (action === 'csv') {
      try { return await i.showModal(csvModal(draft)); }
      catch (e) { this.container.logger.error('[journal] could not open csv modal', e); return i.reply(ephemeral(card(`⚠️ Could not open the upload form: ${e.message}`, ERROR_COLOR))).catch(() => {}); }
    }
    if (action === 'csvback') {
      delete draft.fields._import; delete draft.fields._importing; saveDraft(draft); return refresh();
    }
    if (action === 'csvgo') return this.runImport(i, draft, settings);
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
  /** posts every previewed trade into its outcome's destination, with a live progress bar */
  async runImport(i, draft, settings) {
    const imp = draft.fields._import;
    if (!imp || !imp.trades?.length) return i.update({ components: [journalPanel(draft, i.guild, settings, { notice: 'That import expired. Upload the CSV again.' })] });
    if (draft.fields._importing && draft.fields._importing > Date.now() - 15 * 60 * 1000) return i.reply(ephemeral(card('This import is already running.', WARN_COLOR)));
    draft.fields._importing = Date.now(); saveDraft(draft);
    // a second upload of the same file may have finished in the meantime
    const already = importedHashes(i.guildId, imp.trades.map((t) => t.hash));
    const queue = imp.trades.filter((t) => !already.has(t.hash) && routeTarget(settings, t.outcome));
    const batch = queue.slice(0, IMPORT_PER_RUN), left = queue.length - batch.length;
    const noDest = imp.trades.filter((t) => !routeTarget(settings, t.outcome)).length;
    await i.update({ components: [csvProgressCard(0, batch.length)] });
    const done = { win: 0, loss: 0, be: 0 }, failed = [], dest = new Map();
    let net = 0, lastEdit = 0;
    for (let n = 0; n < batch.length; n++) {
      const t = batch[n], target = routeTarget(settings, t.outcome);
      const one = { id: draft.id, userId: draft.userId, outcome: t.outcome, forumId: target.forumId, image: null,
        fields: { ...toFields(t, { tag: draft.fields._import_tag }), ...(target.threadId ? { _thread: target.threadId } : {}) } };
      try {
        const { thread, messageId } = await postJournal({ guild: i.guild, draft: one, settings });
        markImported(i.guildId, t.hash, messageId);
        done[t.outcome] += 1; net += t.pnl_cents;
        if (!dest.has(t.outcome)) dest.set(t.outcome, `https://discord.com/channels/${i.guildId}/${thread.id}${target.threadId ? `/${messageId}` : ''}`);
      } catch (e) {
        failed.push(`${t.instrument} ${t.date}: ${e.message}`.slice(0, 120));
        if (/no longer exists|Missing permission|locked|archived/i.test(e.message) && failed.length >= 3) break;   // a broken destination: stop rather than fail every row
      }
      if (Date.now() - lastEdit > 1500 || n === batch.length - 1) {
        lastEdit = Date.now();
        await i.editReply({ components: [csvProgressCard(n + 1, batch.length, `${t.instrument} ${formatCents(t.pnl_cents, { symbol: settings.currency })}`)] }).catch(() => {});
      }
    }
    delete draft.fields._import; delete draft.fields._importing; saveDraft(draft);
    const posted = done.win + done.loss + done.be;
    const lines = [`# ${posted ? `Imported ${posted} trade${posted === 1 ? '' : 's'}` : 'Nothing was imported'}`];
    if (posted) lines.push(`## ${formatCents(net, { symbol: settings.currency })}`, [done.win && `\u{1F7E2} ${done.win} win${done.win === 1 ? '' : 's'}`, done.loss && `\u{1F534} ${done.loss} loss${done.loss === 1 ? '' : 'es'}`, done.be && `\u{1F7E1} ${done.be} breakeven`].filter(Boolean).join(' · '));
    const notes = [];
    if (left) notes.push(`${left} more to go: upload the same file again and it picks up where this stopped`);
    if (noDest) notes.push(`${noDest} skipped with no destination set (/journal-settings → Outcome forums)`);
    if (failed.length) notes.push(`${failed.length} failed: ${failed.slice(0, 3).join(' | ')}`);
    if (posted) notes.push('They count in /pnl day, week and month right away');
    if (notes.length) lines.push(`-# ${notes.join('\n-# ')}`);
    const c = new ContainerBuilder().setAccentColor(net > 0 ? OUTCOMES.win.color : net < 0 ? OUTCOMES.loss.color : OUTCOMES.be.color).addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    const links = [...dest.entries()].slice(0, 3).map(([o, url]) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`Open ${OUTCOMES[o].label}`).setURL(url));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(...links, new ButtonBuilder().setCustomId(`jr:${draft.id}:csvback`).setStyle(ButtonStyle.Secondary).setLabel('Back to journal')));
    return i.editReply({ components: [c] }).catch(() => {});
  }
}
module.exports = { JournalComponents };
