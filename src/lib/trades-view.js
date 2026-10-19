'use strict';
/**
 * The /trades view: a period picker (today / this week / this month), and once
 * one is picked the trade ledger image for it, with page buttons for long
 * periods. Everything needed to redraw a page rides in the custom id, so the
 * view keeps working after a restart and never mixes up two users' clicks.
 */
const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  StringSelectMenuBuilder, TextDisplayBuilder,
} = require('discord.js');
const { DateTime } = require('luxon');
const { tradesData } = require('./pnl');
const { renderTrades } = require('./renderer');
const { formatDollars } = require('./money');
const { NEUTRAL_COLOR, totalColor } = require('./format');

const RANGES = {
  day:   { label: 'Today', emoji: '☀️', desc: 'Every trade you took today' },
  week:  { label: 'This week', emoji: '\u{1F5D3}️', desc: 'Monday to Sunday, grouped by day' },
  month: { label: 'This month', emoji: '\u{1F4C8}', desc: 'The whole month, page by page' },
};
const td = (s) => new TextDisplayBuilder().setContent(s);

function picker(current) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('tr:range')
    .setPlaceholder('Choose a period').setMinValues(1).setMaxValues(1)
    .addOptions(Object.entries(RANGES).map(([value, r]) => ({ value, label: r.label, description: r.desc, emoji: r.emoji, default: value === current }))));
}

/** the first message: the picker and a line on what it does */
function pickerPanel() {
  return new ContainerBuilder().setAccentColor(NEUTRAL_COLOR)
    .addTextDisplayComponents(td('# \u{1F9FE} Your trades\nPick a period and I\'ll lay out every trade in it: time, symbol, side, size, entry and exit, hold time, R and PnL, with your win rate, profit factor and the symbols you traded.\n-# Only you can see this.'))
    .addActionRowComponents(picker(null));
}

/**
 * Renders one page of a period. anchor: the ISO date the period was picked on,
 * so paging a week that started yesterday stays on that week.
 * @returns {{ components, files }}
 */
function tradesMessage(guildId, settings, range, page = 0, anchor = null) {
  const tz = settings.timezone;
  const day = anchor || DateTime.now().setZone(tz).toISODate();
  const data = tradesData(guildId, range, tz, settings.currency, day);
  const img = renderTrades(data, page);
  const name = `trades-${range}-${data.start}-p${img.page + 1}.png`;
  const c = new ContainerBuilder().setAccentColor(data.count ? totalColor(data.net) : NEUTRAL_COLOR);
  c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${name}`)));
  const sym = settings.currency;
  const line = data.count
    ? `**${data.lead}** · ${formatDollars(data.net, { symbol: sym })} · ${data.count} trade${data.count === 1 ? '' : 's'} · ${data.winRate}% win rate${data.missed ? ` · ${data.missed} missed` : ''}`
    : `**${data.lead}** · no trades logged${data.missed ? ` (${data.missed} missed)` : ''}`;
  c.addTextDisplayComponents(td(`${line}${img.pages > 1 ? `\n-# Page ${img.page + 1} of ${img.pages}` : ''}`));
  if (img.pages > 1) {
    const b = (label, p, disabled) => new ButtonBuilder().setCustomId(`tr:pg:${range}:${p}:${day}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      b('« First', 0, img.page === 0), b('‹ Prev', Math.max(0, img.page - 1), img.page === 0),
      new ButtonBuilder().setCustomId(`tr:noop:${range}`).setLabel(`${img.page + 1} / ${img.pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      b('Next ›', Math.min(img.pages - 1, img.page + 1), img.page === img.pages - 1), b('Last »', img.pages - 1, img.page === img.pages - 1),
    ));
  }
  c.addActionRowComponents(picker(range));
  return { components: [c], files: [new AttachmentBuilder(img.buffer, { name })], data, page: img.page, pages: img.pages };
}

module.exports = { RANGES, pickerPanel, tradesMessage };
