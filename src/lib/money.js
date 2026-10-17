'use strict';
const { DateTime } = require('luxon');

const clean = (s) => String(s).replace(/[\u2212\u2013\u2014]/g, '-').replace(/[,\s$€£]/g, '');

/** "1,250.50" "$1250" "-$480" "+1250" -> integer cents, or null if invalid */
function parseMoney(input) {
  if (input === null || input === undefined) return null;
  const s = clean(input);
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

/** "+2.5R" "2.5" "-1r" -> number or null */
function parseR(input) {
  if (input === null || input === undefined || String(input).trim() === '') return null;
  const s = clean(input).replace(/r$/i, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}

/** Win => positive, Loss => negative, Missed => 0, Breakeven => as typed */
function applyOutcomeSign(outcome, cents) {
  if (outcome === 'win') return Math.abs(cents);
  if (outcome === 'loss') return -Math.abs(cents);
  if (outcome === 'missed') return 0;
  return cents;
}

/** cents -> "+$1,250" / "-$480" / "$0" (decimals only when needed) */
function formatCents(cents, { symbol = '$', sign = true } = {}) {
  const abs = Math.abs(cents) / 100;
  const hasFrac = Math.abs(cents) % 100 !== 0;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: hasFrac ? 2 : 0, maximumFractionDigits: 2 });
  if (cents > 0) return `${sign ? '+' : ''}${symbol}${body}`;
  if (cents < 0) return `-${symbol}${body}`;
  return `${symbol}0`;
}

/** whole-dollar display for images, typographic minus */
function formatDollars(dollars, { symbol = '$', sign = true } = {}) {
  const v = Math.round(dollars);
  const body = Math.abs(v).toLocaleString('en-US');
  if (v > 0) return `${sign ? '+' : ''}${symbol}${body}`;
  if (v < 0) return `\u2212${symbol}${body}`;
  return `${symbol}0`;
}

function formatShort(dollars, { symbol = '$' } = {}) {
  const v = Math.round(dollars); const a = Math.abs(v);
  const sgn = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  if (a >= 1e6) return `${sgn}${symbol}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e5) return `${sgn}${symbol}${(a / 1e3).toFixed(1)}k`;
  return formatDollars(v, { symbol });
}

function formatR(r, outcome) {
  if (r === null || r === undefined || Number.isNaN(r)) return null;
  let v = r;
  if (outcome === 'win') v = Math.abs(r);
  if (outcome === 'loss') v = -Math.abs(r);
  const s = Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(2)));
  return `${v > 0 ? '+' : ''}${s}R`;
}

const DATE_FORMATS = ['yyyy-MM-dd', 'd MMM yyyy', 'd MMMM yyyy', 'MMM d yyyy', 'MMM d, yyyy', 'MMMM d yyyy', 'M/d/yyyy', 'd MMM', 'MMM d', 'M/d'];
/** Returns 'YYYY-MM-DD' (in tz) or null */
function parseDateInput(input, tz) {
  const s = String(input || '').trim();
  if (!s) return null;
  const now = DateTime.now().setZone(tz);
  if (/^today$/i.test(s)) return now.toISODate();
  if (/^yesterday$/i.test(s)) return now.minus({ days: 1 }).toISODate();
  for (const f of DATE_FORMATS) {
    let d = DateTime.fromFormat(s, f, { zone: tz, locale: 'en' });
    if (d.isValid) {
      if (!/y/.test(f)) { d = d.set({ year: now.year }); if (d > now.plus({ days: 2 })) d = d.minus({ years: 1 }); }
      return d.toISODate();
    }
  }
  return null;
}
function formatDateDisplay(iso) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setLocale('en').toFormat('d LLL yyyy');
}

module.exports = { parseMoney, parseR, applyOutcomeSign, formatCents, formatDollars, formatShort, formatR, parseDateInput, formatDateDisplay };
