'use strict';
const { ButtonStyle } = require('discord.js');
const { formatCents, formatR, formatDateDisplay } = require('./money');

/**
 * The palette behind every container's accent stripe: the YSER look.
 * Deeper, quieter tones than neon, so the stripe reads as a finish rather
 * than a highlighter; ink for the trade log itself.
 */
const PALETTE = {
  ink:    0x111214, // posted trades and their preview: dark, the post carries its own outcome
  brand:  0x5865f2, // panels, settings, info
  win:    0x22a565, // deep emerald
  loss:   0xd94b4b, // muted crimson
  be:     0xd9a03a, // warm amber
  missed: 0x5f6672, // slate
  warn:   0xd9a03a,
  error:  0xd94b4b,
};

const OUTCOMES = {
  win:    { key: 'win',    label: 'Win',       upper: 'WIN',       color: PALETTE.win,    emojiName: 'ywin',    fallback: '\u{1F7E2}', style: ButtonStyle.Success,   tag: 'Win' },
  loss:   { key: 'loss',   label: 'Loss',      upper: 'LOSS',      color: PALETTE.loss,   emojiName: 'yloss',   fallback: '\u{1F534}', style: ButtonStyle.Danger,    tag: 'Loss' },
  be:     { key: 'be',     label: 'Breakeven', upper: 'BREAKEVEN', color: PALETTE.be,     emojiName: 'ybe',     fallback: '\u{1F7E1}', style: ButtonStyle.Secondary, tag: 'Breakeven' },
  missed: { key: 'missed', label: 'Missed',    upper: 'MISSED',    color: PALETTE.missed, emojiName: 'ymissed', fallback: '\u{1F535}', style: ButtonStyle.Secondary, tag: 'Missed' },
};
const NEUTRAL_COLOR = PALETTE.brand;
const TRADE_COLOR = PALETTE.ink;
const WARN_COLOR = PALETTE.warn;
const ERROR_COLOR = PALETTE.error;
/** accent for a PnL total: green up, red down, amber flat */
const totalColor = (total) => (total > 0 ? PALETTE.win : total < 0 ? PALETTE.loss : PALETTE.be);

/** { id, name, animated } for a custom emoji in the guild, or null */
function findEmoji(guild, outcome) {
  const name = OUTCOMES[outcome].emojiName;
  return guild?.emojis?.cache?.find((e) => e.name === name) || null;
}
function emojiToken(guild, outcome) {
  const e = findEmoji(guild, outcome);
  return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : OUTCOMES[outcome].fallback;
}

const q = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '\u2026' : String(s));

/**
 * Builds the journal post body (Discord markdown).
 * f: { instrument, direction, date (ISO), session, setup, entry, stop, target, exit, pnl_cents, potential_cents,
 *      r (number|null), followed ('YES'|'NO'|''), why, p1, p2, lesson }
 */
function buildPostBody(outcome, f, { emoji, symbol = '$', showR = true } = {}) {
  const meta = OUTCOMES[outcome];
  const lines = [];
  lines.push(`# ${emoji || meta.fallback} ${meta.upper} \u00b7 ${f.instrument} ${f.direction}`);
  const sub = [f.date ? formatDateDisplay(f.date) : null, f.session].filter(Boolean).join(' \u00b7 ');
  if (sub) lines.push(`-# ${sub}`);
  lines.push('');

  const quote = [];
  if (f.setup) quote.push(`> **Setup** \u00b7 ${f.setup}`);
  const lv = [];
  if (outcome === 'missed') {
    if (f.entry) lv.push(`Entry ${q(f.entry)}`);
    if (f.stop) lv.push(`Stop ${q(f.stop)}`);
    if (f.target) lv.push(`Target ${q(f.target)}`);
    if (lv.length) quote.push(`> **Plan** \u00b7 ${lv.join(' \u00b7 ')}`);
  } else {
    if (f.entry) lv.push(`**Entry** ${q(f.entry)}`);
    if (f.stop) lv.push(`**Stop** ${q(f.stop)}`);
    if (outcome === 'win' && f.target) lv.push(`**Target** ${q(f.target)}`);
    if (outcome === 'be' && f.exit) lv.push(`**Exit** ${q(f.exit)}`);
    if (lv.length) quote.push(`> ${lv.join(' \u00b7 ')}`);
  }
  if (f.why) quote.push(`> *${outcome === 'missed' ? 'Why I missed it' : 'Why I took it'}:* ${f.why}`);
  if (quote.length) { lines.push(...quote, ''); }

  const rStr = showR ? formatR(f.r, outcome) : null;
  const money = formatCents(f.pnl_cents || 0, { symbol });
  const plan = f.followed ? `Followed plan: ${f.followed}` : null;
  if (outcome === 'win') {
    lines.push('```diff');
    if (rStr) lines.push(`+ RESULT: ${rStr}`);
    lines.push(`+ PNL: ${money}`);
    if (plan) lines.push(`+ ${plan}`);
    lines.push('```', '');
  } else if (outcome === 'loss') {
    lines.push('```diff');
    if (rStr) lines.push(`- RESULT: ${rStr}`);
    lines.push(`- PNL: ${money}`);
    if (plan) lines.push(`- ${plan}`);
    lines.push('```', '');
  } else if (outcome === 'be') {
    lines.push('```fix', 'RESULT: BREAKEVEN', `PNL: ${money}`);
    if (plan) lines.push(plan);
    lines.push('```', '');
  } else {
    lines.push('```ini', '[ MISSED ]', `PNL = ${symbol}0`);
    if (f.potential_cents !== null && f.potential_cents !== undefined) lines.push(`POTENTIAL = ${formatCents(f.potential_cents, { symbol })}   ; not counted in totals`);
    if (plan) lines.push(plan);
    lines.push('```', '');
  }

  const bullets = (arr) => arr.filter(Boolean).map((b) => `- ${b}`);
  if (outcome === 'win') {
    const b = bullets([f.p1, f.p2]);
    if (b.length) lines.push('### \u2705 What I did right', ...b, '');
    if (f.lesson) lines.push('### \u{1F9E0} Lesson', `||${f.lesson}||`);
  } else if (outcome === 'loss') {
    const b = bullets([f.p1, f.p2]);
    if (b.length) lines.push('### \u274C What went wrong', ...b, '');
    if (f.lesson) lines.push('### \u{1F6E0}\uFE0F Fix for next time', `>>> __Rule:__ **${f.lesson}**`);
  } else if (outcome === 'be') {
    const b = bullets([f.p1]);
    if (b.length) lines.push('### \u{1F91D} Why it ended flat', ...b, '');
    if (f.lesson) lines.push('### \u{1F9E0} Lesson', `||${f.lesson}||`);
  } else {
    const b = bullets([f.p1]);
    if (b.length) lines.push('### \u{1F50D} What stopped me', ...b, '');
    if (f.lesson) lines.push('### \u{1F6E0}\uFE0F Fix for next time', `>>> __Rule:__ **${f.lesson}**`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function threadTitle(outcome, f, symbol = '$') {
  const d = f.date ? formatDateDisplay(f.date).replace(/ \d{4}$/, '') : '';
  const parts = [OUTCOMES[outcome].upper, `${f.instrument} ${f.direction}`];
  if (outcome !== 'missed') parts.push(formatCents(f.pnl_cents || 0, { symbol }));
  if (d) parts.push(d);
  return clip(parts.join(' \u00b7 '), 100);
}

module.exports = { OUTCOMES, PALETTE, NEUTRAL_COLOR, TRADE_COLOR, WARN_COLOR, ERROR_COLOR, totalColor, findEmoji, emojiToken, buildPostBody, threadTitle, clip };
