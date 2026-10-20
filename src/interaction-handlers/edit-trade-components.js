'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings, getDraft, saveDraft, getEntry, setTradeAccount, getAccount } = require('../lib/db');
const { isAllowed } = require('../lib/permissions');
const { tradeModal, resultModal, notesModal, pictureModal } = require('../lib/panels');
const ed = require('../lib/trade-editor');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');

const FILTERS = { period: ed.PERIODS, out: null, sym: null, show: ed.SHOWS };
const MODALS = { trade: tradeModal, result: resultModal, notes: notesModal, pic: pictureModal };

/** The /edit-trade panel: filters, paging, picking a trade, and the editor's buttons (custom ids te:<draft>:<action>[:arg]). */
class EditTradeComponents extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) {
    if (!i.customId.startsWith('te:')) return this.none();
    const [, id, action, arg] = i.customId.split(':');
    return id && action ? this.some({ id, action, arg }) : this.none();
  }
  async run(i, { id, action, arg }) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const draft = getDraft(id);
    if (!draft) return i.reply(ephemeral(card('This editor expired. Run `/edit-trade` again.', WARN_COLOR)));
    if (draft.userId !== i.user.id) return i.reply(ephemeral(card('This panel belongs to someone else.', ERROR_COLOR)));
    const settings = getSettings(i.guildId);
    const st = ed.finderState(draft);
    const list = (notice) => { saveDraft(draft); return i.update({ components: [ed.finderPanel(draft, i.guild, settings, { notice })] }); };
    const editor = (o) => { saveDraft(draft); return i.update({ components: [ed.editorPanel(draft, i.guild, settings, o)] }); };
    const editing = !!draft.fields._edit;

    if (action in FILTERS) {
      const v = i.values?.[0];
      if (!v || (FILTERS[action] && !FILTERS[action][v])) return list();
      st[action] = v; st.page = 0; return list();
    }
    if (action === 'pg') { st.page = Math.max(0, Number(arg) || 0); return list(); }
    if (action === 'clear') { draft.fields._finder = { ...ed.DEFAULT_STATE }; return list(); }
    if (action === 'find') return this.modal(i, ed.searchModal(draft));
    if (action === 'pick') {
      const entry = getEntry(Number(i.values?.[0]));
      if (!entry || entry.guild_id !== i.guildId) return list('⚠️ That trade is gone. Pick another one.');
      await i.deferUpdate();                                   // the post is fetched first; never let Discord time out
      try {
        const look = await ed.inspectTrade(i.guild, entry);
        if (look.problem) return await i.editReply({ components: [ed.finderPanel(draft, i.guild, settings, { notice: `⚠️ ${look.problem}` })] });
        ed.loadTrade(draft, entry, look); saveDraft(draft);
        return await i.editReply({ components: [ed.editorPanel(draft, i.guild, settings)] });
      } catch (e) {
        this.container.logger.error('[edit-trade] open failed', e);
        return i.editReply({ components: [ed.finderPanel(draft, i.guild, settings, { notice: `⚠️ Could not open that trade: ${e.message}` })] }).catch(() => {});
      }
    }
    // everything below works on an open trade
    if (!editing) return list('Pick a trade first.');
    if (action === 'edit' && MODALS[arg]) return this.modal(i, MODALS[arg](draft));
    if (action === 'acct') {
      const v = Number(i.values?.[0]);
      if (v) setTradeAccount(draft.fields._edit.key, v);
      const a = v ? getAccount(v) : null;
      return editor({ notice: a ? `\u{1F3E6} Moved to **${a.name}${a.phase === 'eval' && a.attempt > 1 ? ` #${a.attempt}` : ''}**. Its dashboard counts this trade now.` : undefined });
    }
    if (action === 'rmpic') { draft.image = null; draft.fields._edit.removePic = true; return editor({ notice: '-# The chart comes off when you save.' }); }
    if (action === 'undo') { ed.discardChanges(draft); return editor({ notice: '-# Changes discarded. The post was not touched.' }); }
    if (action === 'back') { ed.unloadTrade(draft); return list(); }
    if (action === 'save') {
      const changes = ed.changesOf(draft);
      if (!changes.length) return editor({ notice: '-# Nothing to save yet.' });
      await i.update({ components: [card(`✏️ Saving ${changes.join(', ')} to the post…`)] });
      try {
        const { renamed } = await ed.saveTrade({ guild: i.guild, draft, settings });
        saveDraft(draft);
        return await i.editReply({ components: [ed.editorPanel(draft, i.guild, settings, { saved: `${changes.join(', ')}${renamed ? ' · title updated' : ''}` })] });
      } catch (e) {
        this.container.logger.error('[edit-trade] save failed', e);
        return i.editReply({ components: [ed.editorPanel(draft, i.guild, settings, { notice: `⚠️ Could not save: ${e.message}` })] }).catch(() => {});
      }
    }
    return undefined;
  }
  async modal(i, m) {
    try { return await i.showModal(m); } catch (e) {
      this.container.logger.error('[edit-trade] could not open a form', e);
      return i.reply(ephemeral(card(`⚠️ Could not open that form: ${e.message}`, ERROR_COLOR))).catch(() => {});
    }
  }
}
module.exports = { EditTradeComponents };
