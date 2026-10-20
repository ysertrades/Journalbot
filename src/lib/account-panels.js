'use strict';
/**
 * Components V2 panels for prop firm mode: the Accounts page of
 * /journal-settings, one account's panel (its dashboard card, rules,
 * balance, payouts and the phase actions), the forms behind them, and the
 * cards posted to the alerts channel. All of them dark, like the trade log.
 * Custom ids: ac:<action>[:<accountId>] for components, acm:<form>[:<accountId>] for forms.
 */
const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, LabelBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, ModalBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { DateTime } = require('luxon');
const { PHASES, STATUSES, DD_TYPES, accountView, label, badge } = require('./accounts');
const { listAccounts } = require('./db');
const { PALETTE } = require('./format');
const { formatDollars } = require('./money');
const { renderAccount } = require('./renderer');
const { resolveTheme } = require('./theme');

const INK = PALETTE.ink;
const td = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, text, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style).setDisabled(disabled);
const usd = (v, sym = '$', o = {}) => formatDollars(v, { symbol: sym, ...o });
const day = (iso) => DateTime.fromISO(iso).setLocale('en').toFormat('LLL d');
const meter = (used, n = 10) => { const k = Math.round(Math.max(0, Math.min(1, used)) * n); return `\`${'▰'.repeat(k)}${'▱'.repeat(n - k)}\``; };

/** the one line that says where an account stands */
function standing(view, sym = '$') {
  const { account: a, state: s } = view;
  if (a.status === 'breached' || s.breach) return `\u{1F534} breached ${day((s.breach || {}).date || a.ended_on || a.started_on)} · ${s.breach?.kind === 'daily' ? 'daily loss limit' : s.breach ? 'max drawdown' : a.ended_reason || 'ended'}`;
  if (a.status === 'passed') return `\u{1F3C6} passed ${a.ended_on ? day(a.ended_on) : ''} · ${usd(s.profit, sym)}`;
  if (a.status === 'archived') return `\u{1F5C4}️ archived · ${usd(s.profit, sym)}`;
  const bits = [`${usd(s.balance, sym, { sign: false })}`];
  if (s.target !== null) bits.push(s.passReady ? '✅ ready to fund' : `${Math.floor((s.progress || 0) * 100)}% to target`);
  else bits.push(usd(s.profit, sym));
  if (s.room !== null) bits.push(`${usd(Math.max(0, s.room), sym, { sign: false })} above the floor`);
  if (a.phase === 'funded' && s.paid) bits.push(`${usd(s.paid, sym, { sign: false })} paid`);
  return bits.join(' · ');
}
const rulesLine = (a, sym = '$') => {
  const $ = (c) => usd(c / 100, sym, { sign: false });
  const r = [a.target_cents ? `target ${$(a.target_cents)}` : null, a.daily_loss_cents ? `daily ${$(a.daily_loss_cents)}` : null,
    a.max_dd_cents ? `drawdown ${$(a.max_dd_cents)} ${DD_TYPES[a.dd_type]?.label.toLowerCase() || ''}` : null,
    a.min_days ? `${a.min_days} days min` : null, a.consistency_pct ? `best day ≤ ${a.consistency_pct}%` : null, a.split_pct ? `${a.split_pct}% split` : null].filter(Boolean);
  return r.length ? r.join(' · ') : 'no rules: a personal account, PnL only';
};

/* ======================= Settings → Accounts ======================= */
function accountsSection(c, settings) {
  const sym = settings.currency, accounts = listAccounts(settings.guild_id);
  c.addTextDisplayComponents(td('**\u{1F3E6} Prop firm mode**\n-# One account per eval, funded or personal account, each with its own rules. Trades are tagged with an account when you log, import or edit them, and `/trades`, `/pnl` and `/account` can show one account at a time.'));
  if (!accounts.length) {
    c.addTextDisplayComponents(td('-# No accounts yet. Create the first one: it becomes the default, and every trade already in the journal counts toward it.'));
  } else {
    const lines = accounts.slice(0, 10).map((a) => {
      const v = accountView(a, settings);
      return `${PHASES[a.phase]?.emoji || ''} **${label(a)}** · \`${badge(a)}\`${a.id === settings.default_account_id ? ' · ⭐ default' : ''}\n-# ${standing(v, sym)}`;
    });
    c.addTextDisplayComponents(td(lines.join('\n') + (accounts.length > 10 ? `\n-# … and ${accounts.length - 10} more in the picker` : '')));
    c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId('ac:open').setPlaceholder('Open an account').setMinValues(1).setMaxValues(1)
      .addOptions(accounts.slice(0, 25).map((a) => ({ value: String(a.id), label: label(a).slice(0, 100), description: `${badge(a)} · ${STATUSES[a.status]?.label || a.status}`.slice(0, 100), emoji: STATUSES[a.status]?.emoji })))));
  }
  c.addActionRowComponents(row(btn('ac:new', 'New account', ButtonStyle.Primary)));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(td(`**\u{1F6A8} Alerts channel**\n-# Warnings at 50% and 80% of a daily limit or the drawdown, breaches, a passed evaluation and payouts are posted here. ${settings.alert_channel_id ? `Now: <#${settings.alert_channel_id}>` : 'Not set: alerts are off.'}`));
  const ch = new ChannelSelectMenuBuilder().setCustomId('ac:alerts').setPlaceholder('Select the alerts channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1);
  if (settings.alert_channel_id) ch.setDefaultChannels(settings.alert_channel_id);
  c.addActionRowComponents(row(ch));
  return c;
}

/* ======================= one account ======================= */
const cardName = (a) => `account-${a.id}.png`;
/** the account's dashboard image, in the server's theme */
function accountImage(view) {
  const a = view.account;
  return new AttachmentBuilder(renderAccount({ ...view, badge: badge(a), title: label(a), symbol: view.settings.currency }, { theme: resolveTheme(view.settings) }), { name: cardName(a) });
}

/**
 * confirm: 'fund' | 'retry' | 'archive' puts a confirmation row in place of the actions.
 * @returns {{ components, files }}
 */
function accountPanel(view, { notice, confirm } = {}) {
  const { account: a, state: s, settings } = view, sym = settings.currency, id = a.id;
  const c = new ContainerBuilder().setAccentColor(INK);
  c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${cardName(a)}`)));
  c.addTextDisplayComponents(td(`# ${PHASES[a.phase]?.emoji || ''} ${label(a)}\n-# \`${badge(a)}\` · ${STATUSES[a.status]?.emoji} ${STATUSES[a.status]?.label} · since ${day(a.started_on)}${a.id === settings.default_account_id ? ' · ⭐ default' : ''}${notice ? `\n${notice}` : ''}`));
  c.addSeparatorComponents(sep());
  const sec = (title, body, action, text, style) => new SectionBuilder().addTextDisplayComponents(td(`**${title}**\n-# ${body}`)).setButtonAccessory(btn(`ac:${action}:${id}`, text, style));
  c.addSectionComponents(
    sec('Rules', rulesLine(a, sym), 'rules', 'Edit rules'),
    sec('Account', `${a.firm || 'No firm'} · ${usd(a.size_cents / 100, sym, { sign: false })} · starts at ${usd(a.start_balance_cents / 100, sym, { sign: false })}`, 'ident', 'Edit'),
    sec('Balance', `The journal puts it at **${usd(s.balance, sym, { sign: false })}**${s.adj ? ` (corrected by ${usd(s.adj, sym)})` : ''}. If your platform shows a different number, correct it here.`, 'bal', 'Correct'),
  );
  if (a.phase === 'funded') {
    c.addSectionComponents(sec('Payouts', view.payouts.length ? `${view.payouts.length} · ${usd(s.paid, sym, { sign: false })}${s.yourShare !== null ? ` · your ${a.split_pct}%: ${usd(s.yourShare, sym, { sign: false })}` : ''} · last ${day(view.payouts.at(-1).date)}` : 'None logged yet', 'pay', 'Log payout', ButtonStyle.Success));
  }
  c.addSeparatorComponents(sep());
  if (confirm === 'fund') {
    c.addTextDisplayComponents(td(`### \u{1F48E} Move to funded?\n-# ${label(a)} is marked **passed** and a funded account starts today at ${usd(a.size_cents / 100, sym, { sign: false })}, with the same daily and drawdown limits (edit them after). New trades go to the funded account.${s.passReady ? '' : '\n-# ⚠️ By the journal\'s numbers not every rule is met yet. Go ahead if your firm says you passed.'}`));
    c.addActionRowComponents(row(btn(`ac:fundyes:${id}`, 'Yes, I\'m funded', ButtonStyle.Success), btn(`ac:open:${id}`, 'Not yet')));
  } else if (confirm === 'retry') {
    c.addTextDisplayComponents(td(`### \u{1F501} Start attempt #${a.attempt + 1}?\n-# This run ends as breached and a fresh one starts today with the same rules. Its history stays in the journey.`));
    c.addActionRowComponents(row(btn(`ac:retryyes:${id}`, `Start attempt #${a.attempt + 1}`, ButtonStyle.Primary), btn(`ac:open:${id}`, 'Cancel')));
  } else if (confirm === 'archive') {
    c.addTextDisplayComponents(td('### \u{1F5C4}️ Archive this account?\n-# It leaves the pickers and stops sending alerts. Its trades stay in the journal and it can be restored.'));
    c.addActionRowComponents(row(btn(`ac:archyes:${id}`, 'Archive', ButtonStyle.Danger), btn(`ac:open:${id}`, 'Cancel')));
  } else {
    const acts = [];
    if (a.status === 'active' && a.phase === 'eval') acts.push(btn(`ac:fund:${id}`, s.passReady ? 'Move to funded ✨' : 'Move to funded', s.passReady ? ButtonStyle.Success : ButtonStyle.Secondary));
    if ((a.status === 'active' || a.status === 'breached') && a.phase === 'eval') acts.push(btn(`ac:retry:${id}`, `Attempt #${a.attempt + 1}`, a.status === 'breached' || s.breach ? ButtonStyle.Primary : ButtonStyle.Secondary));
    if (a.status === 'breached') acts.push(btn(`ac:unbreach:${id}`, 'Not a breach'));
    if (a.status === 'archived') acts.push(btn(`ac:unarch:${id}`, 'Restore'));
    else if (a.status === 'active') acts.push(btn(`ac:def:${id}`, a.id === settings.default_account_id ? 'Default ⭐' : 'Make default', ButtonStyle.Secondary, a.id === settings.default_account_id));
    if (a.status !== 'archived') acts.push(btn(`ac:arch:${id}`, 'Archive', ButtonStyle.Danger));
    c.addActionRowComponents(row(...acts.slice(0, 5)));
  }
  // switch to another account without leaving the panel
  const others = listAccounts(a.guild_id).filter((x) => x.status !== 'archived' || x.id === a.id).slice(0, 25);
  if (others.length > 1) {
    c.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId('ac:open').setPlaceholder('Switch account').setMinValues(1).setMaxValues(1)
      .addOptions(others.map((x) => ({ value: String(x.id), label: label(x).slice(0, 100), description: `${badge(x)} · ${STATUSES[x.status]?.label || x.status}`.slice(0, 100), emoji: STATUSES[x.status]?.emoji, default: x.id === a.id })))));
  }
  c.addActionRowComponents(row(btn('ac:back', 'All accounts'), btn(`ac:open:${id}`, 'Refresh'), btn(`ac:share:${id}`, 'Post to alerts', ButtonStyle.Secondary, !settings.alert_channel_id)));
  return { components: [c], files: [accountImage(view)] };
}

/* ======================= forms ======================= */
const txt = (id, { value, placeholder, max = 20, required = false, style = TextInputStyle.Short } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (value !== undefined && value !== null && value !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return t;
};
const lbl = (title, input, desc) => { const l = new LabelBuilder().setLabel(title).setTextInputComponent(input); if (desc) l.setDescription(desc); return l; };
const pick = (title, id, opts, current, desc) => {
  const l = new LabelBuilder().setLabel(title).setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId(id).setMinValues(1).setMaxValues(1).setRequired(true)
    .addOptions(opts.map(([v, text, d]) => ({ value: v, label: text, description: d, default: v === current }))));
  if (desc) l.setDescription(desc);
  return l;
};
const d$ = (c) => (c === null || c === undefined ? '' : String(c / 100));

function newAccountModal(today) {
  return new ModalBuilder().setCustomId('acm:new').setTitle('New account').addLabelComponents(
    lbl('Started on', txt('start', { value: today, max: 30, required: true }), 'Trades from this day count toward the account'),
    lbl('Name', txt('name', { placeholder: '100K Hyperprop', max: 40, required: true })),
    lbl('Account size (USD)', txt('size', { placeholder: '100000', max: 12, required: true }), 'The starting balance too; change it later if it differs'),
    pick('Phase', 'phase', Object.entries(PHASES).map(([k, p]) => [k, p.label, k === 'eval' ? 'Working toward a profit target' : k === 'funded' ? 'Live account with payouts' : 'Your own money, no firm rules']), 'eval'),
    lbl('Firm (optional)', txt('firm', { placeholder: 'Hyperprop, Topstep, Apex…', max: 30 })),
  );
}
function rulesModal(a) {
  return new ModalBuilder().setCustomId(`acm:rules:${a.id}`).setTitle('Rules').addLabelComponents(
    lbl('Profit target (USD)', txt('target', { value: d$(a.target_cents), placeholder: '6000  (empty: none)', max: 12 })),
    lbl('Daily loss limit (USD)', txt('daily', { value: d$(a.daily_loss_cents), placeholder: '2000  (empty: none)', max: 12 })),
    lbl('Max drawdown (USD)', txt('dd', { value: d$(a.max_dd_cents), placeholder: '3000  (empty: none)', max: 12 })),
    pick('Drawdown type', 'ddtype', Object.entries(DD_TYPES).map(([k, d]) => [k, d.label, d.desc.slice(0, 100)]), a.dd_type || 'trailing'),
    lbl('Min trading days', txt('days', { value: a.min_days ?? '', placeholder: '5  (empty: none)', max: 3 })),
  );
}
function identModal(a) {
  return new ModalBuilder().setCustomId(`acm:ident:${a.id}`).setTitle('Account').addLabelComponents(
    lbl('Name', txt('name', { value: a.name, max: 40, required: true })),
    lbl('Firm', txt('firm', { value: a.firm, max: 30 })),
    lbl('Account size (USD)', txt('size', { value: d$(a.size_cents), max: 12, required: true }), 'Changing it also moves the starting balance'),
    lbl('Consistency: best day at most (% of profit)', txt('cons', { value: a.consistency_pct ?? '', placeholder: '30  (empty: off)', max: 3 })),
    lbl('Profit split (% you keep)', txt('split', { value: a.split_pct ?? '', placeholder: '80  (empty: none)', max: 3 })),
  );
}
function balanceModal(a, balance) {
  return new ModalBuilder().setCustomId(`acm:bal:${a.id}`).setTitle('Correct balance').addLabelComponents(
    lbl('Balance on your platform right now (USD)', txt('bal', { value: String(Math.round(balance * 100) / 100), max: 14, required: true }), 'The difference is kept as a correction; your trades are not changed'),
  );
}
function payoutModal(a, today) {
  return new ModalBuilder().setCustomId(`acm:pay:${a.id}`).setTitle('Log payout').addLabelComponents(
    lbl('Amount withdrawn (USD)', txt('amount', { placeholder: '1000', max: 12, required: true }), 'The gross payout; your split is worked out from the account'),
    lbl('Date', txt('date', { value: today, max: 30, required: true })),
    lbl('Note (optional)', txt('note', { placeholder: 'First payout', max: 80 })),
  );
}

/* ======================= alerts ======================= */
const ALERT_COLOR = { warn: PALETTE.warn, breach: PALETTE.loss, pass: PALETTE.win, funded: PALETTE.be, payout: PALETTE.be, info: INK };
/**
 * A card for the alerts channel. kind: daily50 | daily80 | dd50 | dd80 | target90 | breach | passed | funded | payout | share
 * @returns a message payload (Components V2, with the dashboard image for milestones)
 */
function alertMessage(kind, view, extra = {}) {
  const { account: a, state: s, settings } = view, sym = settings.currency, name = `**${label(a)}** · \`${badge(a)}\``;
  const $ = (v) => usd(v, sym, { sign: false });
  let color = ALERT_COLOR.info, text, image = false, buttons = [];
  if (kind === 'daily50' || kind === 'daily80') {
    color = ALERT_COLOR.warn;
    text = `## ⚠️ ${kind === 'daily80' ? '80' : 'Half'}${kind === 'daily80' ? '%' : ''} of today's loss limit used\n${name}\n${meter(s.dailyUsed)} Today **${usd(s.todayPnl, sym)}** of the ${$(s.daily)} limit · **${$(Math.max(0, s.dailyRoom))} left**\n-# ${kind === 'daily80' ? 'One more like the last and the day is over. Step away; the setup will be there tomorrow.' : 'Halfway there. Trade the plan, size down if you need to.'}`;
  } else if (kind === 'dd50' || kind === 'dd80') {
    color = ALERT_COLOR.warn;
    text = `## ⚠️ ${kind === 'dd80' ? '80% of the drawdown used' : 'Half the drawdown used'}\n${name}\n${meter(s.ddUsed)} **${$(Math.max(0, s.room))}** above the floor at ${$(s.floor)} · balance ${$(s.balance)}\n-# ${kind === 'dd80' ? 'This is the last stretch of room on the account. Protect it.' : 'The floor is getting closer. Keep the losses small.'}`;
  } else if (kind === 'target90') {
    color = ALERT_COLOR.pass;
    text = `## \u{1F3AF} 90% of the way to the target\n${name}\n${meter(s.progress)} **${usd(s.profit, sym)}** of ${$(s.target)} · ${$(Math.max(0, s.target - s.profit))} to go\n-# Nearly there. Don't force the last bit.`;
  } else if (kind === 'breach') {
    color = ALERT_COLOR.breach; image = true;
    text = `# \u{1F534} Account breached\n${name}\n${s.breach?.kind === 'daily' ? `The daily loss limit of ${$(s.daily)} was hit on ${day(s.breach.date)}.` : `The balance touched the drawdown floor (${$(s.breach?.floor ?? s.floor)}) on ${day(s.breach?.date || view.today)}.`}\n-# Every run is a lesson. The history stays in the journey; start the next attempt when you're ready.`;
    if (a.phase === 'eval') buttons.push(btn(`ac:retry:${a.id}`, `Start attempt #${a.attempt + 1}`, ButtonStyle.Primary));
    buttons.push(btn(`ac:open:${a.id}`, 'Not a breach? Open account'));
  } else if (kind === 'passed') {
    color = ALERT_COLOR.pass; image = true;
    text = `# \u{1F3C6} Evaluation passed\n${name}\n**${usd(s.profit, sym)}** in ${s.days} trading day${s.days === 1 ? '' : 's'} · target ${$(s.target)}${s.consistencyShare !== null && s.consistencyPct ? ` · best day ${Math.round(s.consistencyShare)}% of profit` : ''}\n-# By the journal's numbers every rule is met. When the firm confirms, move it to funded.`;
    buttons.push(btn(`ac:fund:${a.id}`, 'Move to funded', ButtonStyle.Success));
  } else if (kind === 'funded') {
    color = ALERT_COLOR.funded; image = true;
    text = `# \u{1F48E} Funded\n${name}\nA new chapter starts at ${$(s.start)}. ${extra.from ? `From ${extra.from}.` : ''}\n-# Same discipline, real payouts. Log each one with **Log payout** on the account.`;
  } else if (kind === 'payout') {
    color = ALERT_COLOR.payout; image = true;
    text = `# \u{1F4B8} Payout #${view.payouts.length}\n${name}\n**${$(extra.amount)}** withdrawn${s.split ? ` · your ${s.split}%: **${$(extra.amount * s.split / 100)}**` : ''} · ${$(s.paid)} paid in total`;
  } else {
    image = true;
    text = `## ${PHASES[a.phase]?.emoji || ''} ${label(a)}\n-# \`${badge(a)}\` · ${standing(view, sym)}`;
  }
  const c = new ContainerBuilder().setAccentColor(color);
  if (image) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${cardName(a)}`)));
  c.addTextDisplayComponents(td(text));
  if (buttons.length) c.addActionRowComponents(row(...buttons));
  return { components: [c], files: image ? [accountImage(view)] : [], flags: 1 << 15, allowedMentions: { parse: [] } };
}

module.exports = { accountsSection, accountPanel, accountImage, alertMessage, newAccountModal, rulesModal, identModal, balanceModal, payoutModal, standing, rulesLine, cardName };
