'use strict';
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, LabelBuilder, ModalBuilder,
  RoleSelectMenuBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, FileUploadBuilder,
} = require('discord.js');
const { OUTCOMES, NEUTRAL_COLOR, findEmoji, emojiToken, buildPostBody } = require('./format');
const { formatCents, formatR, formatDateDisplay } = require('./money');
const { routeForum } = require('./routing');

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
  const c = new ContainerBuilder().setAccentColor(meta ? meta.color : NEUTRAL_COLOR);
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
  const auto = routeForum(settings, draft.outcome);
  c.addTextDisplayComponents(td(`**Post to forum**${draft.outcome && auto && !draft.fields._forum_manual ? `\n-# Auto-selected for ${meta.label}: <#${auto}>. Pick another to override.` : ''}`));
  const sel = new ChannelSelectMenuBuilder().setCustomId(`jr:${id}:forum`).setPlaceholder('Select a forum channel')
    .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(1).setMaxValues(1);
  if (draft.forumId) sel.setDefaultChannels(draft.forumId);
  c.addActionRowComponents(row(sel));
  c.addActionRowComponents(row(
    btn(`jr:${id}:preview`, 'Preview', ButtonStyle.Secondary, { disabled: !draft.outcome }),
    btn(`jr:${id}:post`, 'Post', ButtonStyle.Success, { disabled: !isReady(draft) }),
    btn(`jr:${id}:cancel`, 'Cancel', ButtonStyle.Danger),
  ));
  return c;
}

function previewPanel(draft, guild, settings) {
  const body = buildPostBody(draft.outcome, draft.fields, { emoji: emojiToken(guild, draft.outcome), symbol: settings.currency, showR: settings.show_r });
  const c = new ContainerBuilder().setAccentColor(OUTCOMES[draft.outcome].color);
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
const PAGES = [['general', 'General'], ['outcomes', 'Outcome forums'], ['schedule', 'Schedule'], ['advanced', 'Advanced']];

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
    c.addTextDisplayComponents(td('**Where each outcome is posted**\n-# /journal posts a Win to the Win forum, a Loss to the Loss forum, and so on. Outcomes without a forum use the default forum (General page).'));
    for (const o of Object.values(OUTCOMES)) {
      const cur = s.outcome_forums?.[o.key];
      c.addTextDisplayComponents(td(`${o.fallback} **${o.label} forum**\n${cur ? `<#${cur}>` : s.default_forum_id ? `*not set, uses default* <#${s.default_forum_id}>` : '*not set*'}`));
      const m = new ChannelSelectMenuBuilder().setCustomId(`js:outcomes:${o.key}`).setPlaceholder(`Select the ${o.label} forum`)
        .setChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia).setMinValues(0).setMaxValues(1);
      if (cur) m.setDefaultChannels(cur);
      c.addActionRowComponents(row(m));
    }
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

module.exports = { journalPanel, previewPanel, tradeModal, resultModal, notesModal, pictureModal, simpleModal, settingsPanel, missingParts, isReady, td, sep, btn, row, DAYS };
