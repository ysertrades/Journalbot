'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings, getDraft, saveDraft, getPnlEntry, upsertPnl, importedHashes } = require('../lib/db');
const { journalPanel, csvPreviewPanel } = require('../lib/panels');
const { readTrades, sparkline } = require('../lib/csv-import');

const CSV_MAX_BYTES = 2 * 1024 * 1024;
const { isAllowed, canConfigure } = require('../lib/permissions');
const { validateImage, imageRecord } = require('../lib/poster');
const { parseMoney, parseR, applyOutcomeSign, parseDateInput, formatCents } = require('../lib/money');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');

const val = (f, id) => { try { return (f.getTextInputValue(id) || '').trim(); } catch { return ''; } };
const sel = (f, id) => { try { return f.getStringSelectValues(id)[0] || null; } catch { return null; } };
const setOrDrop = (obj, k, v) => { if (v) obj[k] = v; else delete obj[k]; };

class JournalModals extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.ModalSubmit }); }
  parse(i) {
    if (i.customId.startsWith('jrm:')) { const [, id, kind] = i.customId.split(':'); return this.some({ type: 'draft', id, kind }); }
    if (i.customId.startsWith('jsm:')) return this.some({ type: 'settings' });
    if (i.customId.startsWith('jre:')) { const [, key, container] = i.customId.split(':'); return this.some({ type: 'edit', id: key, container: container || key }); }
    return this.none();
  }

  async run(i, p) {
    if (p.type === 'settings') return require('./settings-components').handleSettings(i);
    if (p.type === 'edit') return this.editPnl(i, p.id, p.container);
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const draft = getDraft(p.id);
    if (!draft) return i.reply(ephemeral(card('This journal panel expired. Run `/journal` again.', WARN_COLOR)));
    if (draft.userId !== i.user.id) return i.reply(ephemeral(card('This panel belongs to someone else.', ERROR_COLOR)));
    const settings = getSettings(i.guildId), f = i.fields, d = draft.fields;
    let notice;

    if (p.kind === 'csv') return this.csvUpload(i, draft, settings);
    if (p.kind === 'trade') {
      const date = parseDateInput(val(f, 'date'), settings.timezone);
      if (!date) notice = '⚠️ Could not read that date. Try `today`, `yesterday` or `2026-10-16`. Other changes were saved.';
      else d.date = date;
      d.instrument = val(f, 'instrument').toUpperCase().replace(/[`\n]/g, '').slice(0, 20);
      const dir = sel(f, 'direction'); if (dir) d.direction = dir;
      setOrDrop(d, 'session', sel(f, 'session'));
      setOrDrop(d, 'setup', val(f, 'setup').replace(/`/g, "'"));
    } else if (p.kind === 'result') {
      const o = draft.outcome;
      const lvl = (k) => setOrDrop(d, k, val(f, k).replace(/`/g, "'"));
      if (o === 'missed') {
        const raw = val(f, 'potential');
        if (raw) { const c = parseMoney(raw); if (c === null) notice = '⚠️ Potential PnL is not a valid amount.'; else d.potential_cents = Math.abs(c); } else delete d.potential_cents;
        d.pnl_cents = 0; ['entry', 'stop', 'target'].forEach(lvl);
      } else {
        const c = parseMoney(val(f, 'pnl'));
        if (c === null) notice = '⚠️ PnL is not a valid amount. Use e.g. `1250` or `480.50`.';
        else d.pnl_cents = applyOutcomeSign(o, c);
        if (o !== 'be') {
          const raw = val(f, 'r');
          if (raw) { const r = parseR(raw); if (Number.isNaN(r)) notice = '⚠️ R multiple is not a number.'; else d.r = r; } else delete d.r;
        }
        ['entry', 'stop'].forEach(lvl);
        if (o === 'win') lvl('target');
        if (o === 'be') lvl('exit');
      }
    } else if (p.kind === 'notes') {
      for (const k of ['why', 'p1', 'p2', 'lesson']) { try { setOrDrop(d, k, val(f, k)); } catch { /* field absent for this outcome */ } }
      setOrDrop(d, 'followed', sel(f, 'followed'));
    } else if (p.kind === 'pic') {
      let files; try { files = f.getUploadedFiles('file'); } catch { files = null; }
      const att = files && files.first ? files.first() : null;
      if (att) { const bad = validateImage(att); if (bad) notice = `⚠️ ${bad}`; else draft.image = imageRecord(att); }
    }
    saveDraft(draft);
    const payload = { components: [journalPanel(draft, i.guild, settings, { notice })] };
    return i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...ephemeral(payload.components[0]) });
  }

  /** a CSV dropped into the journal panel: read it, drop what's already imported, show the preview */
  async csvUpload(i, draft, settings) {
    const back = (notice) => {
      const payload = { components: [journalPanel(draft, i.guild, settings, { notice })] };
      return i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...ephemeral(payload.components[0]) });
    };
    let files; try { files = i.fields.getUploadedFiles('file'); } catch { files = null; }
    const att = files && files.first ? files.first() : null;
    if (!att) return back('⚠️ No file came through. Try the upload again.');
    const name = String(att.name || 'file');
    if (!/\.(csv|txt|tsv)$/i.test(name) && !/csv|text\/plain|tab-separated/i.test(att.contentType || '')) return back(`⚠️ **${name}** isn't a CSV. Export your trade history as .csv and upload that.`);
    if (att.size > CSV_MAX_BYTES) return back('⚠️ That file is over 2 MB. Export a shorter date range.');
    let text;
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) { return back(`⚠️ Could not download the file (${e.message}). Try again.`); }
    const r = readTrades(text, settings.timezone);
    if (r.error) return back(`⚠️ ${r.error}`);
    const seen = importedHashes(i.guildId, r.trades.map((t) => t.hash));
    const fresh = r.trades.filter((t) => !seen.has(t.hash));
    let tag = ''; try { tag = (i.fields.getTextInputValue('tag') || '').replace(/[`\n]/g, '').trim().slice(0, 60); } catch { /* optional */ }
    draft.fields._import = { file: name.slice(0, 60), format: r.format, trades: fresh, dupes: r.trades.length - fresh.length, skipped: r.skipped.slice(0, 200), truncated: !!r.truncated };
    draft.fields._import_tag = tag || undefined;
    saveDraft(draft);
    const payload = { components: [csvPreviewPanel(draft, i.guild, settings, draft.fields._import, { sparkline })] };
    return i.isFromMessage() ? i.update(payload) : i.reply({ ...payload, ...ephemeral(payload.components[0]) });
  }

  async editPnl(i, key, containerId) {
    if (!isAllowed(i)) return i.reply(ephemeral(card('You are not allowed to use the journal.', ERROR_COLOR)));
    const settings = getSettings(i.guildId), c = parseMoney(i.fields.getTextInputValue('pnl'));
    if (c === null) return i.reply(ephemeral(card('That is not a valid amount.', WARN_COLOR)));
    const cur = getPnlEntry(key);
    const ch = await i.guild.channels.fetch(containerId).catch(() => null);
    let created = ch?.createdTimestamp;
    if (!cur && ch && key !== containerId) created = (await ch.messages.fetch(key).catch(() => null))?.createdTimestamp;   // a trade inside a destination post
    const date = cur?.date_local || (created ? require('luxon').DateTime.fromMillis(created, { zone: settings.timezone }).toISODate() : null);
    if (!ch || !date) return i.reply(ephemeral(card('Could not find that post.', ERROR_COLOR)));
    const outcome = cur?.outcome === 'missed' ? 'missed' : c > 0 ? 'win' : c < 0 ? 'loss' : 'be';
    upsertPnl({ thread_id: key, container_id: containerId, guild_id: i.guildId, forum_id: ch.parentId, outcome, pnl_cents: c, potential_cents: cur?.potential_cents ?? null, date_local: date, source: 'manual' });
    return i.reply(ephemeral(card(`Saved ${formatCents(c, { symbol: settings.currency })} for <#${containerId}>.\n-# Used in weekly and monthly images. The message text itself is unchanged.`)));
  }
}
module.exports = { JournalModals };
