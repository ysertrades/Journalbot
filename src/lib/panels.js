'use strict';
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, LabelBuilder, ModalBuilder,
  RoleSelectMenuBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, FileUploadBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
} = require('discord.js');
const { OUTCOMES, NEUTRAL_COLOR, TRADE_COLOR, findEmoji, emojiToken, buildPostBody } = require('./format');
const { formatCents, formatR, formatDateDisplay } = require('./money');
const { routeTarget } = require('./routing');

const td = (c) => new TextDisplayBuilder().setContent(c);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const btn = (id, label, style = ButtonStyle.Secondary, o = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (o.disabled) b.setDisabled(true);
  return b;
};
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const SESSIONS = ['Asia', 'London', 'NY AM', 'NY PM', 'Other'];

/* ======================= JOURNAL PANEL ======================= */
function missingParts(d) {
  const f = d.fields, m = [];
  if (!d.outcome) return ['Outcome'];
  if (!f.instrument || !f.direction || !f.date) m.push('Trade details');
  if (d.outcome !== 'missed' && (f.pnl_cents === undefined || f.pnl_cents === null)) m.push('PnL (Result)');
  if (!d.forumId) m.push('Forum');
  return m;
}
const isReady = (d) => missingParts(d).length === 0;

function summaryTrade(d) {
  const f = d.fields;
  if (!f.instrument) return '⬜ Not set';
  return `✅ ${[`${f.instrument} ${f.direction || ''}`.trim(), f.date ? formatDateDisplay(f.date) : null, f.session].filter(Boolean).join(' · ')}`;
}
function summaryResult(d, s) {
  const f = d.fields, sym = s.currency;
  if (d.outcome === 'missed') return f.potential_cents !== undefined && f.potential_cents !== null ? `✅ Potential ${formatCents(f.potential_cents, { symbol: sym })} (not counted)` : '⬜ Optional: potential PnL and plan levels';
  if (f.pnl_cents === undefined || f.pnl_cents === null) return '⬜ PnL required';
  const r = formatR(f.r, d.outcome);
  return `✅ PNL ${formatCents(f.pnl_cents, { symbol: sym })}${r && s.show_r ? ` · ${r}` : ''}`;
}
function summaryNotes(d) {
  const f = d.fields, n = ['why', 'p1', 'p2', 'lesson'].filter((k) => f[k]).length;
  return n || f.followed ? `✅ ${n} note${n === 1 ? '' : 's'}${f.followed ? ` · followed plan: ${f.followed}` : ''}` : '⬜ Optional';
}

function journalPanel(draft, guild, settings, { notice } = {}) {
  const meta = draft.outcome ? OUTCOMES[draft.outcome] : null, id = draft.id, miss = missingParts(draft);
  const status = meta ? `${emojiToken(guild, draft.outcome)} **${meta.label}** · ${miss.length ? `still needed: ${miss.join(', ')}` : 'ready to post'}` : 'Pick an outcome to start';
  const c = new ContainerBuilder().setAccentColor(NEUTRAL_COLOR);   // dark; the outcome shows in its emoji and the selected button
  c.addTextDisplayComponents(td(`# Journal Entry\n-# ${status}${notice ? `\n${notice}` : ''}`));
  c.addActionRowComponents(row(...Object.values(OUTCOMES).map((o) => {
    const b = btn(`jr:${id}:o:${o.key}`, o.label, draft.outcome === o.key ? o.style : ButtonStyle.Secondary);
    const e = findEmoji(guild, o.key);
    b.setEmoji(e ? { id: e.id, name: e.name, animated: e.animated } : o.fallback);
    return b;
  })));
  c.addSeparatorComponents(sep());
  const sec = (title, summary, action, label, disabled) => new SectionBuilder()
    .addTextDisplayComponents(td(`**${title}**\n-# ${summary}`))
    .setButtonAccessory(btn(`jr:${id}:${action}`, label, ButtonStyle.Secondary, { disabled }));
  c.addSectionComponents(
    sec('Trade details', summaryTrade(draft), 'edit:trade', 'Edit', !draft.outcome),
    sec('Result', draft.outcome ? summaryResult(draft, settings) : '⬜ Pick an outcome first', 'edit:result', 'Edit', !draft.outcome),
    sec('Notes', draft.outcome ? summaryNotes(draft) : '⬜ Pick an outcome first', 'edit:notes', 'Edit', !draft.outcome),
    sec('Picture', draft.image ? `✅ ${draft.image.name}` : '⬜ None (shown above the journal text)', 'edit:pic', draft.image ? 'Replace' : 'Add', false),
  );
  c.addSeparatorComponents(sep());
  const auto = routeTarget(settings, draft.outcome);
  const note = draft.outcome && auto && !draft.fields._forum_manual
    ? `\n-# ${auto.threadId ? `Trades go into the existing ${meta.label} post <#${auto.threadId}>` : `New post in <#${auto.forumId}>`}. Pick a forum below to create a new post instead.` : '';
  c.addTextDisplayComponents(td(`**Post to forum**${note}`));
  const sel = new ChannelSelectMenuBuilder().setCustomId(`jr:${id}:forum`).setPlaceholder('Select a forum channel')
    .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(1).setMaxValues(1);
  if (draft.forumId) sel.setDefaultChannels(draft.forumId);
  c.addActionRowComponents(row(sel));
  c.addActionRowComponents(row(
    btn(`jr:${id}:preview`, 'Preview', ButtonStyle.Secondary, { disabled: !draft.outcome }),
    btn(`jr:${id}:post`, 'Post', ButtonStyle.Success, { disabled: !isReady(draft) }),
    btn(`jr:${id}:cancel`, 'Cancel', ButtonStyle.Danger),
  ));
  // bulk import, below everything: drop a broker / prop-firm CSV and every trade lands in its outcome's post
  c.addSeparatorComponents(sep());
  c.addSectionComponents(new SectionBuilder()
    .addTextDisplayComponents(td('**\u{1F4E5} Import trades from a CSV**\n-# Drop an export from Hyperprop, Tradovate, TopstepX or any sheet. Wins, losses and breakevens are sorted into their posts; nothing posts until you confirm.'))
    .setButtonAccessory(btn(`jr:${id}:csv`, 'Upload CSV', ButtonStyle.Primary)));
  return c;
}

/* ======================= CSV IMPORT ======================= */
function csvModal(draft) {
  return new ModalBuilder().setCustomId(`jrm:${draft.id}:csv`).setTitle('Import trades from CSV').addLabelComponents(
    new LabelBuilder().setLabel('Trade history (.csv)').setDescription('Closed trades with a symbol and PnL; side, prices, times and fees are read when present')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setMinValues(1).setMaxValues(1).setRequired(true)),
    lbl('Label these trades (optional)', txt('tag', { value: draft.fields._import_tag, placeholder: 'Hyperprop · eval 50K', max: 60 }), 'Shown as the setup line on each imported post'),
  );
}

const OUT_EMOJI = { win: '\u{1F7E2}', loss: '\u{1F534}', be: '\u{1F7E1}' };
const OUT_NAME = { win: 'Wins', loss: 'Losses', be: 'Breakeven' };
function destLine(settings, outcome) {
  const t = routeTarget(settings, outcome);
  if (!t) return '⚠️ no destination set, these will be skipped';
  return t.threadId ? `→ <#${t.threadId}>` : `→ new post in <#${t.forumId}>`;
}
/**
 * imp: { file, format, trades[], dupes, skipped[], truncated }
 * The preview: what's in the file, where each group will go, the running PnL as a sparkline.
 */
function csvPreviewPanel(draft, guild, settings, imp, { sparkline }) {
  const sym = settings.currency, money = (c) => formatCents(c, { symbol: sym });
  const tr = imp.trades, total = tr.reduce((s, t) => s + t.pnl_cents, 0);
  const c = new ContainerBuilder().setAccentColor(NEUTRAL_COLOR);
  c.addTextDisplayComponents(td(`# \u{1F4E5} Import preview\n-# ${imp.file} · ${imp.format}${imp.truncated ? ' · first 1000 rows' : ''}`));
  // the dedupe ledger: what's new against what the journal already holds
  const manual = imp.manual || [], seenAll = (imp.dupes || 0) + manual.length;
  const ledger = [`✨ **${tr.length} new**`];
  if (imp.dupes) ledger.push(`♻️ ${imp.dupes} already imported`);
  if (manual.length) ledger.push(`✋ ${manual.length} already journaled by hand`);
  if (imp.backfilled) ledger.push(`\u{1F527} ${imp.backfilled} older import${imp.backfilled === 1 ? '' : 's'} given time, size and hold`);
  const run = imp.lastRun;
  const since = run ? `\n-# \u{1F9ED} Last import <t:${Math.floor(run.at / 1000)}:R> · ${run.count} trade${run.count === 1 ? '' : 's'}${run.last_trade_at ? ` up to <t:${Math.floor(run.last_trade_at / 1000)}:f>` : ''}${seenAll ? '. Matching trades are skipped, only what\'s new is added.' : ''}` : '\n-# First import into this journal.';
  c.addTextDisplayComponents(td(`${ledger.join('  ·  ')}${since}${imp.withId ? '\n-# Matched by your broker\'s trade IDs' : seenAll ? '\n-# Matched by symbol, side, size and entry/exit time, so a re-export with rounding or fee changes still matches' : ''}`));
  if (!tr.length) {
    c.addTextDisplayComponents(td(seenAll ? `You're up to date. Every trade in this file is already in your journal.` : 'No trades could be read from this file.'));
  } else {
    let run = 0; const curve = tr.map((t) => (run += t.pnl_cents));
    const first = tr[0].date, last = tr[tr.length - 1].date;
    const best = tr.reduce((a, b) => (b.pnl_cents > a.pnl_cents ? b : a)), worst = tr.reduce((a, b) => (b.pnl_cents < a.pnl_cents ? b : a));
    const fees = tr.reduce((s, t) => s + t.fee_cents, 0);
    c.addTextDisplayComponents(td(`## ${money(total)}\n\`${sparkline(curve.map((v) => v / 100), 28)}\`\n-# ${tr.length} trade${tr.length === 1 ? '' : 's'} · ${formatDateDisplay(first)}${last !== first ? ` → ${formatDateDisplay(last)}` : ''}${fees ? ` · ${money(fees)} fees taken off` : ''}`));
    c.addSeparatorComponents(sep());
    const lines = ['win', 'loss', 'be'].map((o) => {
      const g = tr.filter((t) => t.outcome === o); if (!g.length) return null;
      return `${OUT_EMOJI[o]} **${OUT_NAME[o]}** · ${g.length} · ${money(g.reduce((s, t) => s + t.pnl_cents, 0))}  ${destLine(settings, o)}`;
    }).filter(Boolean);
    c.addTextDisplayComponents(td(lines.join('\n')));
    c.addTextDisplayComponents(td(`-# Best ${best.instrument} ${money(best.pnl_cents)} · worst ${worst.instrument} ${money(worst.pnl_cents)}${tr.some((t) => t.sideGuessed) ? ' · side not in the file for some rows, shown as Long' : ''}`));
  }
  const notes = [];
  if (manual.length) notes.push(`✋ Held back, they match trades you posted yourself: ${manual.slice(0, 3).map((t) => `${t.instrument} ${formatDateDisplay(t.date).replace(/ \d{4}$/, '')} ${money(t.pnl_cents)}`).join(', ')}${manual.length > 3 ? '…' : ''}`);
  if (imp.skipped.length) {
    const why = {}; for (const s of imp.skipped) (why[s.why] ||= []).push(s.row);
    notes.push(`⏭️ ${imp.skipped.length} row${imp.skipped.length === 1 ? '' : 's'} skipped: ${Object.entries(why).map(([w, r]) => `${w} (row${r.length === 1 ? '' : 's'} ${r.slice(0, 4).join(', ')}${r.length > 4 ? '…' : ''})`).join('; ')}`);
  }
  if (notes.length) c.addTextDisplayComponents(td(`-# ${notes.join('\n-# ')}`));
  const postable = tr.filter((t) => routeTarget(settings, t.outcome)).length;
  c.addActionRowComponents(row(
    btn(`jr:${draft.id}:csvgo`, postable ? `Import ${postable} trade${postable === 1 ? '' : 's'}` : 'Nothing to import', ButtonStyle.Success, { disabled: !postable }),
    ...(manual.length ? [btn(`jr:${draft.id}:csvinc`, `Include ${manual.length} hand-logged`)] : []),
    btn(`jr:${draft.id}:csv`, 'Choose another file'),
    btn(`jr:${draft.id}:csvback`, 'Back to journal'),
  ));
  return c;
}

/** live progress while trades are posted */
function csvProgressCard(done, total, last) {
  const w = 16, filled = Math.round((done / Math.max(1, total)) * w);
  return new ContainerBuilder().setAccentColor(NEUTRAL_COLOR).addTextDisplayComponents(td(
    `# Importing…\n\`${'█'.repeat(filled)}${'░'.repeat(w - filled)}\` **${done}/${total}**${last ? `\n-# last: ${last}` : ''}\n-# Keep this open; posts are paced so Discord doesn't throttle them.`));
}

function previewPanel(draft, guild, settings) {
  const body = buildPostBody(draft.outcome, draft.fields, { emoji: emojiToken(guild, draft.outcome), symbol: settings.currency, showR: settings.show_r });
  const c = new ContainerBuilder().setAccentColor(TRADE_COLOR); // looks exactly like the posted trade
  if (draft.image) c.addTextDisplayComponents(td(`-# \u{1F5BC}️ Picture **${draft.image.name}** will appear above this text`));
  c.addTextDisplayComponents(td(body));
  return c;
}

/* ======================= MODALS ======================= */
const lbl = (title, input, desc) => { const l = new LabelBuilder().setLabel(title).setTextInputComponent(input); if (desc) l.setDescription(desc); return l; };
const txt = (id, { style = TextInputStyle.Short, value, placeholder, max = 100, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (value !== undefined && value !== null && value !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
};
// Modal selects are required by default in Discord; min_values 0 is rejected (400) unless required is explicitly false
const sel = (id, options, current, placeholder) => new StringSelectMenuBuilder().setCustomId(id).setMinValues(0).setMaxValues(1).setRequired(false)
  .setPlaceholder(placeholder || 'Choose').addOptions(options.map((o) => ({ label: o, value: o, default: o === current })));
const selLbl = (title, s) => new LabelBuilder().setLabel(title).setStringSelectMenuComponent(s);
const money = (v) => (v === undefined || v === null ? '' : String(v / 100));

function tradeModal(draft) {
  const f = draft.fields;
  return new ModalBuilder().setCustomId(`jrm:${draft.id}:trade`).setTitle('Trade details').addLabelComponents(
    lbl('Instrument', txt('instrument', { value: f.instrument, placeholder: 'NQ, ES, YM, MNQ…', max: 20, required: true })),
    selLbl('Direction', sel('direction', ['Long', 'Short'], f.direction, 'Long or Short')),
    lbl('Date', txt('date', { value: f.date ? formatDateDisplay(f.date) : 'today', placeholder: 'today, yesterday, 2026-10-16, 16 Oct 2026', max: 30, required: true })),
    selLbl('Session / killzone', sel('session', SESSIONS, f.session, 'Optional')),
    lbl('Setup', txt('setup', { value: f.setup, placeholder: 'HTF sweep → CISD', max: 100 })),
  );
}
function resultModal(draft) {
  const f = draft.fields, o = draft.outcome, m = new ModalBuilder().setCustomId(`jrm:${draft.id}:result`);
  if (o === 'win' || o === 'loss') {
    return m.setTitle(`${OUTCOMES[o].label}: result`).addLabelComponents(
      lbl('PnL (USD)', txt('pnl', { value: money(f.pnl_cents), placeholder: o === 'win' ? '1250' : '480  (made negative automatically)', max: 14, required: true })),
      lbl('R multiple (optional)', txt('r', { value: f.r ?? '', placeholder: '2.5', max: 8 })),
      lbl('Entry', txt('entry', { value: f.entry, max: 24 })),
      lbl('Stop', txt('stop', { value: f.stop, max: 24 })),
      ...(o === 'win' ? [lbl('Target', txt('target', { value: f.target, max: 24 }))] : []),
    );
  }
  if (o === 'be') {
    return m.setTitle('Breakeven: result').addLabelComponents(
      lbl('PnL (USD)', txt('pnl', { value: money(f.pnl_cents) || '0', placeholder: '0', max: 14, required: true })),
      lbl('Entry', txt('entry', { value: f.entry, max: 24 })),
      lbl('Stop', txt('stop', { value: f.stop, max: 24 })),
      lbl('Exit', txt('exit', { value: f.exit, max: 24 })),
    );
  }
  return m.setTitle('Missed: plan').addLabelComponents(
    lbl('Potential PnL (optional, not counted)', txt('potential', { value: money(f.potential_cents), placeholder: '900', max: 14 })),
    lbl('Planned entry', txt('entry', { value: f.entry, max: 24 })),
    lbl('Planned stop', txt('stop', { value: f.stop, max: 24 })),
    lbl('Planned target', txt('target', { value: f.target, max: 24 })),
  );
}
const NOTE_LABELS = {
  win:    { why: 'Why I took it', p1: 'What I did right (1)', p2: 'What I did right (2)', lesson: 'Lesson (hidden as spoiler)' },
  loss:   { why: 'Why I took it', p1: 'What went wrong (1)', p2: 'What went wrong (2)', lesson: 'Rule for next time' },
  be:     { why: 'Why I took it', p1: 'Why it ended flat', p2: null, lesson: 'Lesson (hidden as spoiler)' },
  missed: { why: 'Why I missed it', p1: 'What stopped me', p2: null, lesson: 'Rule for next time' },
};
function notesModal(draft) {
  const f = draft.fields, L = NOTE_LABELS[draft.outcome];
  const para = (id, v, max) => txt(id, { style: TextInputStyle.Paragraph, value: v, max });
  const comps = [lbl(L.why, para('why', f.why, 400)), lbl(L.p1, txt('p1', { value: f.p1, max: 200 }))];
  if (L.p2) comps.push(lbl(L.p2, txt('p2', { value: f.p2, max: 200 })));
  comps.push(lbl(L.lesson, para('lesson', f.lesson, 300)));
  comps.push(selLbl('Followed plan?', sel('followed', ['YES', 'NO'], f.followed, 'Optional')));
  return new ModalBuilder().setCustomId(`jrm:${draft.id}:notes`).setTitle('Notes').addLabelComponents(...comps);
}
function pictureModal(draft) {
  return new ModalBuilder().setCustomId(`jrm:${draft.id}:pic`).setTitle('Picture').addLabelComponents(
    new LabelBuilder().setLabel('Chart screenshot / image').setDescription('Shown above your journal text in the forum post')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setMinValues(0).setMaxValues(1).setRequired(false)),
  );
}
function simpleModal(id, title, labelText, value, placeholder, max = 40) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(lbl(labelText, txt('value', { value, placeholder, max, required: true })));
}

/* ======================= SETTINGS PANEL ======================= */
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const mention = (ids) => (ids && ids.length ? ids.map((i) => `<#${i}>`).join(' ') : '*none*');
function describeTarget(s, key) {
  const t = s.outcome_threads?.[key];
  if (t?.thread) return `Existing post <#${t.thread}>${t.forum ? ` in <#${t.forum}>` : ''}`;
  if (s.outcome_forums?.[key]) return `New post each time in <#${s.outcome_forums[key]}>`;
  return s.default_forum_id ? `*not set, uses default* <#${s.default_forum_id}>` : '*not set*';
}

const PAGES = [['general', 'General'], ['outcomes', 'Outcome forums'], ['schedule', 'Schedule'], ['look', 'Appearance'], ['advanced', 'Advanced']];
const SWATCH = 'theme-preview.png';

function settingsPanel(page, s, healthLines) {
  const c = new ContainerBuilder().setAccentColor(NEUTRAL_COLOR);
  c.addTextDisplayComponents(td(`# Journal Settings\n-# ${PAGES.find(([k]) => k === page)[1]} · changes save instantly`));
  c.addActionRowComponents(row(...PAGES.map(([k, l]) => btn(`js:nav:${k}`, l, k === page ? ButtonStyle.Primary : ButtonStyle.Secondary))));
  c.addSeparatorComponents(sep());
  if (page === 'general') {
    c.addTextDisplayComponents(td(`**Extra forums to scan for PnL**\n-# Outcome forums and the default forum are scanned automatically\n${mention(s.forums)}`));
    const f = new ChannelSelectMenuBuilder().setCustomId('js:general:forums').setPlaceholder('Select extra forums to scan')
      .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(0).setMaxValues(25);
    if (s.forums.length) f.setDefaultChannels(s.forums.slice(0, 25));
    c.addActionRowComponents(row(f));
    c.addTextDisplayComponents(td(`**Default forum** for /journal\n${s.default_forum_id ? `<#${s.default_forum_id}>` : '*none*'}`));
    const d = new ChannelSelectMenuBuilder().setCustomId('js:general:defforum').setPlaceholder('Select default forum')
      .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(0).setMaxValues(1);
    if (s.default_forum_id) d.setDefaultChannels(s.default_forum_id);
    c.addActionRowComponents(row(d));
    c.addTextDisplayComponents(td(`**Report channel** (weekly and month-end images)\n${s.report_channel_id ? `<#${s.report_channel_id}>` : '*none*'}`));
    const r = new ChannelSelectMenuBuilder().setCustomId('js:general:repchan').setPlaceholder('Select report channel')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1);
    if (s.report_channel_id) r.setDefaultChannels(s.report_channel_id);
    c.addActionRowComponents(row(r));
  } else if (page === 'outcomes') {
    c.addTextDisplayComponents(td('**Where each outcome is posted**\n-# Choose an existing post for each category (trades are added inside it), or a forum to create a new post each time. Anything not set uses the default forum.'));
    for (const o of Object.values(OUTCOMES)) {
      c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(`${o.fallback} **${o.label}**\n${describeTarget(s, o.key)}`))
        .setButtonAccessory(btn(`js:outcomes:edit:${o.key}`, 'Choose')));
    }
  } else if (page === 'look') {
    // the same day in both themes, the one in use ringed, then the three choices
    const { THEME_CHOICES, resolveTheme, NIGHT_FROM, NIGHT_TO } = require('./theme');
    c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${SWATCH}`)));
    c.addTextDisplayComponents(td('**Card theme**\n-# Every image the bot draws: `/pnl day`, `week` and `month`, `/trades`, and the weekly and month-end reports.'));
    for (const [k, t] of Object.entries(THEME_CHOICES)) {
      const on = (s.theme || 'light') === k;
      c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(`${t.emoji} **${t.label}**${on ? '  ·  in use' : ''}\n-# ${t.desc}`))
        .setButtonAccessory(btn(`js:look:theme_${k}`, on ? 'Selected' : 'Use', on ? ButtonStyle.Success : ButtonStyle.Secondary, { disabled: on })));
    }
    const now = resolveTheme(s);
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(td(`-# Cards drawn right now come out in **${now === 'dark' ? 'Night' : 'Studio'}**${s.theme === 'auto' ? `: Night runs ${NIGHT_FROM}:00 to ${String(NIGHT_TO).padStart(2, '0')}:00 in \`${s.timezone}\`` : ''}. The preview uses today's trades.`));
    c.addActionRowComponents(row(btn('js:look:prev_day', 'Preview today'), btn('js:look:prev_week', 'Preview this week'), btn('js:look:prev_month', 'Preview this month')));
  } else if (page === 'schedule') {
    c.addTextDisplayComponents(td(`**Timezone:** \`${s.timezone}\``));
    c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(`**Weekly report**\n-# ${DAYS[s.weekly_day - 1]} at ${s.weekly_time}`))
      .setButtonAccessory(btn('js:schedule:toggle_weekly', s.weekly_enabled ? 'Enabled' : 'Disabled', s.weekly_enabled ? ButtonStyle.Success : ButtonStyle.Secondary)));
    c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId('js:schedule:day').setPlaceholder('Weekly post day').setMinValues(1).setMaxValues(1)
      .addOptions(DAYS.map((d, i) => ({ label: d, value: String(i + 1), default: i + 1 === s.weekly_day })))));
    c.addActionRowComponents(row(btn('js:schedule:modal_wtime', `Weekly time: ${s.weekly_time}`), btn('js:schedule:modal_tz', 'Set timezone')));
    c.addSeparatorComponents(sep());
    c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(`**Month-end report**\n-# Last day of each month at ${s.month_time}`))
      .setButtonAccessory(btn('js:schedule:toggle_month', s.month_enabled ? 'Enabled' : 'Disabled', s.month_enabled ? ButtonStyle.Success : ButtonStyle.Secondary)));
    c.addActionRowComponents(row(btn('js:schedule:modal_mtime', `Month-end time: ${s.month_time}`)));
    // the trading day: when "today" rolls over, with a worked example so the rule is never a guess
    const { PRESETS, presetOf, describe, tradingDay, sessionOf } = require('./session');
    const ses = sessionOf(s), cur = presetOf(s);
    const { DateTime } = require('luxon');
    const sample = DateTime.fromObject({ year: 2026, month: 10, day: 19, hour: 19, minute: 15 }, { zone: ses.zone });   // a Monday evening
    const lands = DateTime.fromISO(tradingDay(sample, s)).setLocale('en').toFormat('cccc');
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(td(`**\u{1F319} Trading day**\n-# ${describe(s)}. ${ses.minutes ? `A trade at 7:15 PM on Monday counts for **${lands}**.` : 'A trade counts for the calendar day it was taken.'}`));
    c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId('js:schedule:session').setPlaceholder('When the trading day starts').setMinValues(1).setMaxValues(1)
      .addOptions([...Object.entries(PRESETS).map(([k, p]) => ({ value: k, label: p.label, emoji: p.emoji, description: p.desc.slice(0, 100), default: cur === k })),
        ...(cur === 'custom' ? [{ value: 'custom', label: `Custom: starts ${ses.start}`, emoji: '\u{1F552}', description: `${ses.zone}${ses.fold ? ' · weekend evenings count as Monday' : ''}`.slice(0, 100), default: true }] : [])])));
    c.addActionRowComponents(row(btn('js:schedule:modal_sess', `Custom start: ${ses.start}`), btn('js:schedule:redate', 'Fix past trades', ButtonStyle.Primary)));
  } else {
    c.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(td(`**Currency symbol**\n-# Currently \`${s.currency}\``)).setButtonAccessory(btn('js:advanced:modal_cur', 'Edit')),
      new SectionBuilder().addTextDisplayComponents(td('**Show R multiples**\n-# In posts when an R value is entered'))
        .setButtonAccessory(btn('js:advanced:toggle_r', s.show_r ? 'On' : 'Off', s.show_r ? ButtonStyle.Success : ButtonStyle.Secondary)),
    );
    c.addTextDisplayComponents(td(`**Ping role** on reports\n${s.ping_role_id ? `<@&${s.ping_role_id}>` : '*none*'}`));
    const pr = new RoleSelectMenuBuilder().setCustomId('js:advanced:role').setPlaceholder('Select role to ping (optional)').setMinValues(0).setMaxValues(1);
    if (s.ping_role_id) pr.setDefaultRoles(s.ping_role_id);
    c.addActionRowComponents(row(pr));
    c.addTextDisplayComponents(td(`**Allowed users** for /journal (owner always allowed)\n${s.allowed_users.length ? s.allowed_users.map((u) => `<@${u}>`).join(' ') : '*anyone with Manage Server*'}`));
    const us = new UserSelectMenuBuilder().setCustomId('js:advanced:users').setPlaceholder('Select allowed users').setMinValues(0).setMaxValues(10);
    if (s.allowed_users.length) us.setDefaultUsers(s.allowed_users.slice(0, 10));
    c.addActionRowComponents(row(us));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(btn('js:advanced:prev_week', 'Preview weekly'), btn('js:advanced:prev_month', 'Preview monthly'),
      btn('js:advanced:post_week', 'Post weekly now', ButtonStyle.Primary), btn('js:advanced:post_month', 'Post monthly now', ButtonStyle.Primary),
      btn('js:advanced:rescan', 'Rescan forums')));
    c.addTextDisplayComponents(td(`**Health check**\n${(healthLines && healthLines.length ? healthLines : ['*loading…*']).join('\n').slice(0, 1800)}`));
  }
  return c;
}

const POST_PAGE = 25;
/** Step-by-step destination picker for one outcome: 1) forum, 2) a post inside that forum (grouped by forum). */
function pickPanel({ key, forumId, posts, page, settings }) {
  const o = OUTCOMES[key], cur = settings.outcome_threads?.[key];
  const pages = Math.max(1, Math.ceil(posts.length / POST_PAGE)), pg = Math.min(Math.max(page, 0), pages - 1);
  const c = new ContainerBuilder().setAccentColor(NEUTRAL_COLOR);
  c.addTextDisplayComponents(td(`# ${o.label} destination\n-# Currently: ${describeTarget(settings, key)}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(td('**1. Forum**'));
  const f = new ChannelSelectMenuBuilder().setCustomId(`js:pick:${key}:forum`).setPlaceholder('Select the forum')
    .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(1).setMaxValues(1);
  if (forumId) f.setDefaultChannels(forumId);
  c.addActionRowComponents(row(f));
  if (forumId) {
    c.addTextDisplayComponents(td(`**2. Post in <#${forumId}>**\n-# ${posts.length ? `${posts.length} post${posts.length === 1 ? '' : 's'}, newest first${pages > 1 ? ` \u00b7 page ${pg + 1} of ${pages}` : ''}` : 'This forum has no posts yet. Use the button below to create a new post each time.'}`));
    if (posts.length) {
      const m = new StringSelectMenuBuilder().setCustomId(`js:pick:${key}:thread:${forumId}:${pg}`).setPlaceholder('Select the post to add trades to').setMinValues(1).setMaxValues(1)
        .addOptions(posts.slice(pg * POST_PAGE, (pg + 1) * POST_PAGE).map((p) => ({
          label: String(p.name).slice(0, 100) || 'Untitled', value: p.id, description: p.locked ? 'Locked' : p.archived ? 'Archived (will be reopened)' : undefined, default: cur?.thread === p.id,
        })));
      c.addActionRowComponents(row(m));
      if (pages > 1) c.addActionRowComponents(row(
        btn(`js:pick:${key}:page:${forumId}:${pg - 1}`, 'Previous', ButtonStyle.Secondary, { disabled: pg === 0 }),
        btn(`js:pick:${key}:page:${forumId}:${pg + 1}`, 'Next', ButtonStyle.Secondary, { disabled: pg >= pages - 1 }),
      ));
    }
  }
  c.addSeparatorComponents(sep());
  c.addActionRowComponents(row(
    btn(`js:pick:${key}:new:${forumId || 'none'}`, 'New post each time', ButtonStyle.Primary, { disabled: !forumId }),
    btn(`js:pick:${key}:clear`, 'Clear'),
    btn('js:nav:outcomes', 'Back'),
  ));
  return c;
}

module.exports = { pickPanel, describeTarget, journalPanel, summaryTrade, summaryResult, summaryNotes, csvModal, csvPreviewPanel, csvProgressCard, previewPanel, tradeModal, resultModal, notesModal, pictureModal, simpleModal, settingsPanel, missingParts, isReady, td, sep, btn, row, DAYS, SWATCH };
