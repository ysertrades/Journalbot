'use strict';
/**
 * /edit-trade: find a trade you already posted and add a picture, notes or
 * fix a number later. Two views on one private panel:
 *  - the finder: period, outcome, symbol and a "show" lens (newest, biggest,
 *    missing a picture, missing notes) plus a free-text search, with a
 *    numbered list that matches the picker below it;
 *  - the editor: the trade's sections with the same forms /journal uses;
 *    nothing changes on the post until Save, which rewrites it in place.
 * The panel's state lives in a journal draft (fields._finder, fields._edit),
 * so the forms and ownership checks of /journal work unchanged.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, LabelBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  ModalBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { DateTime } = require('luxon');
const { editableTrades, updateEntry, upsertPnl, tradeAccountOf } = require('./db');
const { OUTCOMES, TRADE_COLOR, buildPostBody, threadTitle, emojiToken, clip } = require('./format');
const { formatCents, formatR } = require('./money');
const { summaryTrade, summaryResult, summaryNotes } = require('./panels');
const { downloadImage } = require('./poster');

const PER_PAGE = 10;
const PERIODS = {
  day:   { label: 'Today', emoji: '☀️' },
  week:  { label: 'This week', emoji: '\u{1F5D3}️' },
  month: { label: 'This month', emoji: '\u{1F4C6}' },
  d30:   { label: 'Last 30 days', emoji: '\u{1F501}' },
  all:   { label: 'All time', emoji: '♾️' },
};
const SHOWS = {
  new:     { label: 'Newest first', emoji: '\u{1F552}', desc: 'Latest trades on top' },
  big:     { label: 'Biggest PnL first', emoji: '\u{1F4B0}', desc: 'Largest wins and losses on top' },
  nopic:   { label: 'Missing a picture', emoji: '\u{1F4F7}', desc: 'Trades with no chart yet' },
  nonotes: { label: 'Missing notes', emoji: '✍️', desc: 'Trades with no reasons or lesson yet' },
};
const OUT_FILTER = { all: { label: 'All outcomes', emoji: '\u{1F3AF}' }, win: { label: 'Wins' }, loss: { label: 'Losses' }, be: { label: 'Breakeven' }, missed: { label: 'Missed' } };
const DEFAULT_STATE = { period: 'week', out: 'all', sym: 'all', show: 'new', q: '', page: 0 };
// what the editor can change, grouped the way the panel shows it
const GROUPS = {
  'trade details': ['instrument', 'direction', 'date', 'session', 'setup'],
  result: ['pnl_cents', 'potential_cents', 'r', 'entry', 'stop', 'target', 'exit'],
  notes: ['why', 'p1', 'p2', 'lesson', 'followed'],
};
const NOTE_KEYS = ['why', 'p1', 'p2', 'lesson'];

const td = (s) => new TextDisplayBuilder().setContent(s);
const sep = (big) => new SeparatorBuilder().setDivider(!big).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const pad2 = (n) => String(n).padStart(2, '0');
const parseJson = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

function finderState(draft) {
  const st = { ...DEFAULT_STATE, ...(draft.fields._finder || {}) };
  if (!PERIODS[st.period]) st.period = DEFAULT_STATE.period;
  if (!SHOWS[st.show]) st.show = DEFAULT_STATE.show;
  if (!OUT_FILTER[st.out]) st.out = 'all';
  draft.fields._finder = st;
  return st;
}

/** [startISO, endISO] of a finder period in the server's timezone */
function periodBounds(period, tz, now = DateTime.now().setZone(tz)) {
  const d = now.startOf('day');
  if (period === 'day') return [d.toISODate(), d.toISODate()];
  if (period === 'week') return [d.startOf('week').toISODate(), d.endOf('week').toISODate()];
  if (period === 'month') return [d.startOf('month').toISODate(), d.endOf('month').toISODate()];
  if (period === 'd30') return [d.minus({ days: 29 }).toISODate(), d.toISODate()];
  return ['0000-01-01', '9999-12-31'];
}

/** a journal row as the finder lists it */
function toRow(e, tz) {
  const f = parseJson(e.fields_json);
  const at = Number(f._at) || e.created_at;
  const when = DateTime.fromMillis(at, { zone: tz });
  const outcome = OUTCOMES[e.outcome] ? e.outcome : 'be';
  return {
    id: e.id, key: e.message_id, container: e.thread_id, forumId: e.forum_id, outcome,
    instrument: e.instrument || f.instrument || '?', direction: e.direction || f.direction || '', setup: e.setup || f.setup || '',
    pnl: outcome === 'missed' ? 0 : (f.pnl_cents ?? e.pnl_cents ?? 0), potential: f.potential_cents ?? e.potential_cents ?? null,
    r: f.r ?? e.r_multiple ?? null, date: e.live_date || e.date_local, time: when.isValid ? when.toFormat('HH:mm') : '', at,
    hasPic: !!e.image_name, hasNotes: NOTE_KEYS.some((k) => f[k]), fields: f,
  };
}

/** every word must appear: symbol, side, setup, notes, the date or the amount (1240 finds +$1,240) */
function matches(r, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const cents = Math.abs(r.outcome === 'missed' ? r.potential || 0 : r.pnl);
  const hay = [r.instrument, r.direction, r.setup, r.fields.session, ...NOTE_KEYS.map((k) => r.fields[k]), OUTCOMES[r.outcome].label, r.date,
    DateTime.fromISO(r.date).setLocale('en').toFormat('d LLL ccc LLLL cccc'), (cents / 100).toFixed(2), String(Math.round(cents / 100)), formatCents(cents)]
    .filter(Boolean).join(' ').toLowerCase().replace(/,/g, '');
  return words.every((w) => hay.includes(w.replace(/[,$]/g, '')));
}

/** the trades a finder state shows, plus what the period holds for the chips and symbol list */
function findTrades(guildId, tz, st) {
  const [start, end] = periodBounds(st.period, tz);
  const all = editableTrades(guildId, start, end).map((e) => toRow(e, tz));
  const symbols = [...all.reduce((m, r) => m.set(r.instrument, (m.get(r.instrument) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  let rows = all.filter((r) => (st.out === 'all' || r.outcome === st.out) && (st.sym === 'all' || r.instrument === st.sym) && matches(r, st.q));
  if (st.show === 'nopic') rows = rows.filter((r) => !r.hasPic);
  if (st.show === 'nonotes') rows = rows.filter((r) => !r.hasNotes);
  rows.sort(st.show === 'big' ? (a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || b.at - a.at : (a, b) => b.date.localeCompare(a.date) || b.at - a.at);
  return { rows, all, symbols };
}

const dayLabel = (iso) => DateTime.fromISO(iso).setLocale('en').toFormat('ccc d LLL');
const link = (guildId, r) => `https://discord.com/channels/${guildId}/${r.container}${r.key !== r.container ? `/${r.key}` : ''}`;
const amount = (r, sym) => (r.outcome === 'missed' ? (r.potential ? `missed · ${formatCents(r.potential, { symbol: sym })} potential` : 'missed') : formatCents(r.pnl, { symbol: sym }));

/* ======================= the finder ======================= */
function finderPanel(draft, guild, settings, { notice } = {}) {
  const st = finderState(draft), sym = settings.currency;
  const { rows, all, symbols } = findTrades(draft.guildId, settings.timezone, st);
  if (st.sym !== 'all' && !symbols.includes(st.sym)) symbols.unshift(st.sym);   // keep a picked symbol visible even when the period has none
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  st.page = Math.min(Math.max(0, st.page || 0), pages - 1);
  const page = rows.slice(st.page * PER_PAGE, (st.page + 1) * PER_PAGE);
  const id = draft.id;

  const c = new ContainerBuilder().setAccentColor(TRADE_COLOR);
  c.addTextDisplayComponents(td(`# ✏️ Edit a trade\n-# Find it, then add a chart, notes or fix a number. The post is rewritten in place; nothing changes until you save.${notice ? `\n${notice}` : ''}`));

  const select = (cid, placeholder, opts) => row(new StringSelectMenuBuilder().setCustomId(`te:${id}:${cid}`).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1).addOptions(opts));
  c.addActionRowComponents(
    select('period', 'Period', Object.entries(PERIODS).map(([v, p]) => ({ value: v, label: p.label, emoji: p.emoji, default: st.period === v }))),
    select('out', 'Outcome', Object.entries(OUT_FILTER).map(([v, o]) => ({ value: v, label: o.label, emoji: o.emoji || OUTCOMES[v].fallback, default: st.out === v }))),
    select('sym', 'Symbol', [{ value: 'all', label: 'All symbols', emoji: '\u{1F4CA}', default: st.sym === 'all' },
      ...symbols.slice(0, 24).map((s) => ({ value: s.slice(0, 100), label: s.slice(0, 100), default: st.sym === s }))]),
    select('show', 'Show', Object.entries(SHOWS).map(([v, s]) => ({ value: v, label: s.label, emoji: s.emoji, description: s.desc, default: st.show === v }))),
  );
  c.addSeparatorComponents(sep());

  // what the filters add up to, and what the period is still missing
  const lens = [PERIODS[st.period].label, st.out !== 'all' && OUT_FILTER[st.out].label, st.sym !== 'all' && st.sym, st.show !== 'new' && SHOWS[st.show].label.toLowerCase(), st.q && `“${clip(st.q, 30)}”`].filter(Boolean);
  const noPic = all.filter((r) => !r.hasPic).length, noNotes = all.filter((r) => !r.hasNotes).length;
  const chips = all.length ? [noPic ? `\u{1F4F7} ${noPic} without a chart` : '\u{1F4F7} every trade has a chart', noNotes ? `✍️ ${noNotes} without notes` : '✍️ every trade has notes'].join('  ·  ') : '';
  c.addTextDisplayComponents(td(`**${rows.length} trade${rows.length === 1 ? '' : 's'}** · ${lens.join(' · ')}${chips ? `\n-# ${chips}` : ''}`));

  if (!page.length) {
    c.addTextDisplayComponents(td(all.length
      ? '\u{1F50E} Nothing matches these filters. Loosen one, or clear them below.'
      : `\u{1F4ED} No trades posted by the bot ${st.period === 'all' ? 'yet' : `in ${PERIODS[st.period].label.toLowerCase()}`}. Try a longer period.\n-# Only trades logged with /journal or a CSV import can be edited; posts typed by hand belong to you, not the bot.`));
  } else {
    const lines = page.map((r, n) => {
      const no = pad2(st.page * PER_PAGE + n + 1), rs = formatR(r.r, r.outcome);
      const meta = [dayLabel(r.date), r.time, settings.show_r && rs, r.setup && clip(r.setup, 28), r.hasPic ? '\u{1F4F7} chart' : 'no chart', r.hasNotes ? '✍️ notes' : 'no notes'].filter(Boolean);
      return `\`${no}\` ${OUTCOMES[r.outcome].fallback} **${r.instrument} ${r.direction}** · **${amount(r, sym)}** · [open](${link(draft.guildId, r)})\n-#    ${meta.join(' · ')}`;
    });
    c.addTextDisplayComponents(td(lines.join('\n')));
    c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`te:${id}:pick`).setMinValues(1).setMaxValues(1)
      .setPlaceholder(`✏️ Pick a trade to edit (${pad2(st.page * PER_PAGE + 1)}–${pad2(st.page * PER_PAGE + page.length)})`)
      .addOptions(page.map((r, n) => ({
        value: String(r.id), emoji: OUTCOMES[r.outcome].fallback,
        label: clip(`${pad2(st.page * PER_PAGE + n + 1)} · ${r.instrument} ${r.direction} · ${amount(r, sym)}`, 100),
        description: clip([dayLabel(r.date), r.time, r.hasPic ? 'chart' : 'no chart', r.hasNotes ? 'notes' : 'no notes'].filter(Boolean).join(' · '), 100),
      })))));
  }
  const filtered = st.out !== 'all' || st.sym !== 'all' || st.show !== 'new' || st.q || st.period !== DEFAULT_STATE.period;
  c.addActionRowComponents(row(
    btn(`te:${id}:pg:${st.page - 1}`, '‹ Prev', ButtonStyle.Secondary, st.page === 0),
    btn(`te:${id}:noop`, `${st.page + 1} / ${pages}`, ButtonStyle.Secondary, true),
    btn(`te:${id}:pg:${st.page + 1}`, 'Next ›', ButtonStyle.Secondary, st.page >= pages - 1),
    btn(`te:${id}:find`, st.q ? 'Search · on' : 'Search', st.q ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('\u{1F50E}'),
    btn(`te:${id}:clear`, 'Clear filters', ButtonStyle.Secondary, !filtered),
  ));
  return c;
}

function searchModal(draft) {
  const t = new TextInputBuilder().setCustomId('q').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(false)
    .setPlaceholder('NQ short, orb, 1240, friday, oct 14');
  if (draft.fields._finder?.q) t.setValue(draft.fields._finder.q);
  return new ModalBuilder().setCustomId(`tem:${draft.id}:find`).setTitle('Search your trades').addLabelComponents(
    new LabelBuilder().setLabel('Words to look for').setDescription('Symbol, side, setup, notes, a day or an amount. Leave empty to clear.').setTextInputComponent(t));
}

/* ======================= the editor ======================= */
const editable = (fields) => Object.fromEntries(Object.values(GROUPS).flat().map((k) => [k, fields[k] ?? null]));

/** before opening a trade: is its message still there, written by the bot as a V2 post? and where is its picture */
async function inspectTrade(guild, entry) {
  const thread = await guild.channels.fetch(entry.thread_id).catch(() => null);
  if (!thread || !thread.isThread?.()) return { problem: 'That post was deleted, so there is nothing to edit.' };
  const msg = await thread.messages.fetch(entry.message_id).catch(() => null);
  if (!msg) return { problem: 'That trade’s message was deleted.' };
  if (msg.author?.id !== guild.client?.user?.id) return { problem: 'That trade was not posted by me, so I can’t rewrite it.' };
  if (!msg.flags?.has?.(MessageFlags.IsComponentsV2)) return { problem: 'That trade was posted as plain text, so it can’t be rewritten. Log it again with /journal.' };
  const att = (entry.image_name && msg.attachments.find((a) => a.name === entry.image_name)) || msg.attachments.first() || null;
  return { imageUrl: att?.url || null, imageName: att?.name || null };
}

/** puts a trade into the draft: its fields become the forms' values, the original is kept to spot changes */
function loadTrade(draft, entry, look) {
  const f = parseJson(entry.fields_json);
  delete f._thread; delete f._forum_manual; delete f._edit; delete f._finder;
  if (!f.date) f.date = entry.date_local;
  for (const [k, col] of [['instrument', 'instrument'], ['direction', 'direction'], ['pnl_cents', 'pnl_cents']]) if (f[k] === undefined || f[k] === null) f[k] = entry[col];
  draft.outcome = OUTCOMES[entry.outcome] ? entry.outcome : 'be';
  draft.image = null;
  draft.fields = { ...f, _finder: draft.fields._finder, _edit: {
    id: entry.id, key: entry.message_id, container: entry.thread_id, createdAt: entry.created_at,
    imageUrl: look?.imageUrl || null, imageName: look?.imageName || null, removePic: false, orig: f,
  } };
  return draft;
}
function unloadTrade(draft) {
  draft.fields = { _finder: draft.fields._finder };
  draft.outcome = null; draft.image = null;
  return draft;
}
/** puts the original values back, dropping every unsaved change */
function discardChanges(draft) {
  const ed = draft.fields._edit;
  draft.fields = { ...ed.orig, _finder: draft.fields._finder, _edit: { ...ed, removePic: false } };
  draft.image = null;
  return draft;
}

/** the names of the sections with unsaved changes */
function changesOf(draft) {
  const ed = draft.fields._edit; if (!ed) return [];
  const now = editable(draft.fields), was = editable(ed.orig);
  const out = Object.entries(GROUPS).filter(([, keys]) => keys.some((k) => String(now[k] ?? '') !== String(was[k] ?? ''))).map(([g]) => g);
  if (draft.image || (ed.removePic && ed.imageName)) out.push('chart');
  return out;
}

function editorPanel(draft, guild, settings, { notice, saved } = {}) {
  const ed = draft.fields._edit, f = draft.fields, o = OUTCOMES[draft.outcome], id = draft.id;
  const changes = changesOf(draft);
  const c = new ContainerBuilder().setAccentColor(changes.length ? o.color : TRADE_COLOR);
  const pic = draft.image ? { url: draft.image.url, name: draft.image.name, fresh: true } : !ed.removePic && ed.imageUrl ? { url: ed.imageUrl, name: ed.imageName } : null;
  if (pic) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(pic.url)));
  const postUrl = `https://discord.com/channels/${draft.guildId}/${ed.container}${ed.key !== ed.container ? `/${ed.key}` : ''}`;
  c.addTextDisplayComponents(td(`# ${emojiToken(guild, draft.outcome)} ${o.upper} · ${f.instrument || '?'} ${f.direction || ''}\n-# Editing · in <#${ed.container}>${ed.createdAt ? ` · logged <t:${Math.floor(ed.createdAt / 1000)}:R>` : ''}${notice ? `\n${notice}` : ''}`));
  c.addSeparatorComponents(sep());
  const mark = (name, text) => (changes.includes(name) ? text.replace(/^✅/, '✏️') : text);
  const sec = (title, summary, action, label) => new SectionBuilder().addTextDisplayComponents(td(`**${title}**\n-# ${summary}`)).setButtonAccessory(btn(`te:${id}:edit:${action}`, label));
  const notesLine = summaryNotes(draft) === '⬜ Optional' ? '⬜ None yet: why you took it, what went right or wrong, the lesson' : summaryNotes(draft);
  const picLine = draft.image ? `✏️ ${draft.image.name} · new, replaces ${ed.imageName ? 'the old one' : 'nothing'} on save`
    : ed.removePic && ed.imageName ? `✏️ Removed on save (was ${ed.imageName})` : ed.imageName ? `✅ ${ed.imageName}` : '⬜ None yet: add the chart now, it goes above the journal text';
  c.addSectionComponents(
    sec('Trade details', mark('trade details', summaryTrade(draft)), 'trade', 'Edit'),
    sec('Result', mark('result', summaryResult(draft, settings)), 'result', 'Edit'),
    sec('Notes', mark('notes', notesLine), 'notes', summaryNotes(draft) === '⬜ Optional' ? 'Add' : 'Edit'),
    sec('Chart', picLine, 'pic', pic ? 'Replace' : 'Add'),
  );
  // the account it counts toward: moving it is instant (the post itself does not change)
  const { accountPicker } = require('./panels');
  const acctRow = accountPicker(`te:${id}:acct`, draft.guildId, settings, tradeAccountOf(ed.key), { placeholder: 'Move to another account' });
  if (acctRow) c.addActionRowComponents(acctRow);
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(td(changes.length
    ? `✏️ **Unsaved:** ${changes.join(', ')}\n-# Save rewrites the post and updates /pnl and /trades.`
    : saved ? `✅ **Saved to the post**${typeof saved === 'string' ? ` · ${saved}` : ''}` : '-# No changes yet. Edit a section, then save.'));
  const buttons = [
    btn(`te:${id}:save`, changes.length ? `Save ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Save', ButtonStyle.Success, !changes.length),
    btn(`te:${id}:undo`, 'Discard', ButtonStyle.Secondary, !changes.length),
  ];
  if (pic && !pic.fresh) buttons.push(btn(`te:${id}:rmpic`, 'Remove chart', ButtonStyle.Danger));
  buttons.push(btn(`te:${id}:back`, 'Back to list'), new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open post').setURL(postUrl));
  c.addActionRowComponents(row(...buttons.slice(0, 5)));
  return c;
}

/**
 * Writes the edited trade back: the post's message (text and chart), the
 * thread title for one-trade-per-post entries, the journal row and the PnL row.
 * Throws an Error with a readable message. Returns { imageUrl, imageName, renamed }.
 */
async function saveTrade({ guild, draft, settings }) {
  const ed = draft.fields._edit, outcome = draft.outcome;
  const thread = await guild.channels.fetch(ed.container).catch(() => null);
  if (!thread || !thread.isThread?.()) throw new Error('That post was deleted.');
  if (thread.locked) throw new Error(`<#${thread.id}> is locked. Unlock it to edit this trade.`);
  if (thread.archived) await thread.setArchived(false).catch(() => { throw new Error(`<#${thread.id}> is archived and I can’t reopen it (needs Manage Threads).`); });
  const msg = await thread.messages.fetch(ed.key).catch(() => null);
  if (!msg) throw new Error('That trade’s message was deleted.');

  const f = { ...draft.fields }; delete f._edit; delete f._finder; delete f._thread; delete f._forum_manual;
  if (outcome === 'missed') f.pnl_cents = 0;
  const body = buildPostBody(outcome, f, { emoji: emojiToken(guild, outcome), symbol: settings.currency, showR: settings.show_r }).slice(0, 3900);
  // the chart: a new upload wins, else the current one is carried over (re-uploaded, so the post never points at a dead link)
  let file = null;
  if (draft.image) file = await downloadImage(draft.image);
  else if (!ed.removePic && ed.imageName) {
    const att = msg.attachments.find((a) => a.name === ed.imageName) || msg.attachments.first();
    if (att) file = await downloadImage({ url: att.url, name: att.name });
  }
  const container = new ContainerBuilder().setAccentColor(TRADE_COLOR);
  if (file) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`)));
  container.addTextDisplayComponents(td(body));
  let edited;
  try {
    edited = await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2, files: file ? [file] : [], attachments: [] });
  } catch (e) {
    if (/Missing Permissions|Missing Access/i.test(e.message)) throw new Error(`Missing permission to edit in <#${thread.id}>.`);
    throw new Error(`Discord refused the edit: ${e.message}`);
  }
  let renamed = false;
  if (ed.key === ed.container) {                            // one trade per post: the title carries symbol, PnL and date
    const title = threadTitle(outcome, f, settings.currency);
    if (thread.name !== title) renamed = !!(await thread.setName(title).catch(() => null));
  }
  updateEntry(ed.id, {
    instrument: f.instrument || null, direction: f.direction || null, session: f.session || null, setup: f.setup || null,
    entry: f.entry || null, stop: f.stop || null, target: f.target || null, exit: f.exit || null, r_multiple: f.r ?? null,
    pnl_cents: f.pnl_cents || 0, potential_cents: f.potential_cents ?? null, followed_plan: f.followed || null,
    fields_json: JSON.stringify(f), date_local: f.date, image_name: file ? file.name : null,
  });
  upsertPnl({ thread_id: ed.key, container_id: ed.container, guild_id: guild.id, forum_id: thread.parentId, outcome, pnl_cents: f.pnl_cents || 0,
    potential_cents: f.potential_cents ?? null, date_local: f.date, source: 'bot' });
  const att = file ? (edited?.attachments?.find?.((a) => a.name === file.name) || edited?.attachments?.first?.()) : null;
  // the draft now matches the post
  draft.image = null;
  draft.fields._edit = { ...ed, orig: f, removePic: false, imageName: file ? file.name : null, imageUrl: file ? att?.url || null : null };
  return { renamed };
}

module.exports = { PERIODS, SHOWS, DEFAULT_STATE, PER_PAGE, finderState, periodBounds, findTrades, matches, finderPanel, searchModal,
  inspectTrade, loadTrade, unloadTrade, discardChanges, changesOf, editorPanel, saveTrade };
