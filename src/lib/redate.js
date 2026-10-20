'use strict';
/**
 * Fixing trades logged before the trading-day rule (or under another session):
 * finds the ones on the wrong day and moves them, rewriting their posts so the
 * date in the text (which a rescan reads back) agrees with the journal.
 *
 * Only what the bot can prove moves:
 *  - CSV imports, from the trade's own time;
 *  - trades logged with /journal on the calendar day they were dated (that is
 *    "today"), from the moment they were logged.
 * A date typed on purpose (logging yesterday's trade today) is left alone, and
 * a trade only ever moves forward. Hand-typed posts are re-read by the next scan.
 */
const { ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DateTime } = require('luxon');
const { editableTrades, updateEntry, upsertPnl } = require('./db');
const { tradingDay, describe, presetOf, PRESETS } = require('./session');
const { formatCents } = require('./money');
const { OUTCOMES, NEUTRAL_COLOR } = require('./format');

const MAX_PER_RUN = 300;
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

/** the trades that belong to a later trading day than the one they are on: [{ entry, from, to, when, why }] */
function planRedate(guildId, settings) {
  const moves = [];
  for (const e of editableTrades(guildId)) {
    const f = parse(e.fields_json), from = e.live_date || e.date_local;
    const imported = /^Imported\b/.test(f.why || '') || f.setup === 'Imported from CSV';
    let when = null, why = null;
    if (imported && Number(f._at)) { when = Number(f._at); why = 'import'; }
    else if (!imported && e.created_at && DateTime.fromMillis(e.created_at, { zone: settings.timezone }).toISODate() === from) { when = e.created_at; why = 'journal'; }
    if (!when) continue;
    const to = tradingDay(when, settings);
    if (to && to > from) moves.push({ entry: e, from, to, when, why, fields: f });
  }
  return moves.sort((a, b) => a.when - b.when);
}

const td = (s) => new TextDisplayBuilder().setContent(s);
const day = (iso) => DateTime.fromISO(iso).setLocale('en').toFormat('ccc LLL d');

/** the preview: how many move, a few examples, and the go button */
function redatePanel(guildId, settings, moves) {
  const preset = PRESETS[presetOf(settings)];
  const c = new ContainerBuilder().setAccentColor(NEUTRAL_COLOR);
  c.addTextDisplayComponents(td(`# \u{1F319} Fix past trades\n-# Trading day: **${preset ? preset.label : 'Custom'}** · ${describe(settings)}`));
  if (!moves.length) {
    c.addTextDisplayComponents(td('✅ **Every trade is already on its trading day.** Nothing to move.\n-# Posts you typed yourself are re-read by the next scan.'));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('js:nav:schedule').setLabel('Back').setStyle(ButtonStyle.Secondary)));
    return c;
  }
  const imports = moves.filter((m) => m.why === 'import').length, logged = moves.length - imports;
  const ex = moves.slice(-6).map((m) => {
    const o = OUTCOMES[m.entry.outcome] || OUTCOMES.be;
    const t = DateTime.fromMillis(m.when, { zone: settings.session_zone || settings.timezone }).setLocale('en').toFormat('h:mm a');
    return `${o.fallback} **${m.entry.instrument || '?'}** ${formatCents(m.fields.pnl_cents ?? m.entry.pnl_cents ?? 0, { symbol: settings.currency })} · ${day(m.from)}, ${t} → **${day(m.to)}**`;
  });
  c.addTextDisplayComponents(td([
    `### ${moves.length} trade${moves.length === 1 ? '' : 's'} move to the next session`,
    [imports && `\u{1F4E5} ${imports} imported`, logged && `✍️ ${logged} logged as "today" after the roll`].filter(Boolean).join('  ·  '),
    '', ...ex, moves.length > 6 ? `-# … and ${moves.length - 6} earlier` : null,
  ].filter((x) => x !== null).join('\n')));
  c.addTextDisplayComponents(td(`-# Each post is rewritten with its new date (and the title of a one-trade post); charts and notes stay. Dates you typed on purpose don't move, and nothing ever moves backward.${moves.length > MAX_PER_RUN ? ` Up to ${MAX_PER_RUN} per run; run it again for the rest.` : ''}`));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('js:schedule:redate_go').setLabel(`Move ${Math.min(moves.length, MAX_PER_RUN)} trade${moves.length === 1 ? '' : 's'}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('js:nav:schedule').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  ));
  return c;
}

/**
 * Moves the planned trades: bot posts are rewritten through the trade editor (so text, title, journal
 * and PnL rows agree); a post that can't be rewritten moves in the journal only, held as a manual date
 * so a scan doesn't read the old one back. onProgress(done, total) is called as it goes.
 */
async function applyRedate(guild, settings, moves, onProgress = async () => {}) {
  const ed = require('./trade-editor');
  const batch = moves.slice(0, MAX_PER_RUN), res = { moved: 0, journalOnly: 0, failed: [] };
  let last = 0;
  for (let n = 0; n < batch.length; n++) {
    const m = batch[n], e = m.entry;
    try {
      const look = await ed.inspectTrade(guild, e);
      if (look.problem) {
        const f = { ...m.fields, date: m.to };
        updateEntry(e.id, { instrument: e.instrument, direction: e.direction, session: e.session, setup: e.setup, entry: e.entry, stop: e.stop, target: e.target, exit: e.exit,
          r_multiple: e.r_multiple, pnl_cents: e.pnl_cents, potential_cents: e.potential_cents, followed_plan: e.followed_plan, fields_json: JSON.stringify(f), date_local: m.to, image_name: e.image_name });
        upsertPnl({ thread_id: e.message_id, container_id: e.thread_id, guild_id: guild.id, forum_id: e.forum_id, outcome: e.outcome, pnl_cents: m.fields.pnl_cents ?? e.pnl_cents,
          potential_cents: e.potential_cents, date_local: m.to, source: 'manual' });
        res.journalOnly += 1;
      } else {
        const draft = ed.loadTrade({ guildId: guild.id, fields: {} }, e, look);
        draft.fields.date = m.to;
        await ed.saveTrade({ guild, draft, settings });
        res.moved += 1;
      }
    } catch (err) { res.failed.push(`${e.instrument || '?'} ${m.from}: ${err.message}`.slice(0, 120)); }
    if (Date.now() - last > 1500 || n === batch.length - 1) { last = Date.now(); await onProgress(n + 1, batch.length).catch(() => {}); }
  }
  res.left = moves.length - batch.length;
  return res;
}

module.exports = { planRedate, redatePanel, applyRedate, MAX_PER_RUN };
