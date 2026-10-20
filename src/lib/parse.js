'use strict';
const { DateTime } = require('luxon');
const { OUTCOMES } = require('./format');

const norm = (t) => String(t || '').replace(/[\u2212\u2013\u2014]/g, '-');
const PNL_RE = /^[ \t]*([+-]?)[ \t]*PNL[ \t]*[:=][ \t]*([+-]?)[ \t]*[$\u20ac\u00a3]?[ \t]*([\d,]+(?:\.\d+)?)/im;
const POT_RE = /^[ \t]*POTENTIAL[ \t]*[:=][ \t]*([+-]?)[ \t]*[$\u20ac\u00a3]?[ \t]*([\d,]+(?:\.\d+)?)/im;
const HEAD_RE = /^#{1,3}[^\n]*?\b(WIN|LOSS|BREAKEVEN|MISSED)\b/im;
const DATE_RE = /^-#[ \t]*(\d{1,2}[ \t]+[A-Za-z]{3,9}[ \t]+\d{4})/m;
const toCents = (s) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);
const KEY = { WIN: 'win', LOSS: 'loss', BREAKEVEN: 'be', MISSED: 'missed' };

/** Parse any journal post text. Returns raw findings (no tag/date fallbacks applied). */
function parseText(text) {
  const t = norm(text);
  const out = { pnlCents: null, signed: false, potentialCents: null, outcome: null, dateISO: null };
  const m = t.match(PNL_RE);
  if (m) {
    const [, lead, sign, num] = m;
    let c = toCents(num);
    if (sign === '-') c = -c;
    else if (sign === '+') c = +c;
    else if (lead === '-') c = -c; // diff block "- PNL: 480"
    out.pnlCents = c; out.signed = !!sign || !!lead;
  }
  const p = t.match(POT_RE);
  if (p) { const c = toCents(p[2]); out.potentialCents = p[1] === '-' ? -c : c; }
  const h = t.match(HEAD_RE);
  if (h) out.outcome = KEY[h[1].toUpperCase()];
  const d = t.match(DATE_RE);
  if (d) {
    const dt = DateTime.fromFormat(d[1].replace(/\s+/g, ' '), 'd LLL yyyy', { locale: 'en' });
    if (dt.isValid) out.dateISO = dt.toISODate();
  }
  return out;
}

/**
 * Combine parsed text with forum tag outcome and thread timestamp into a PnL entry.
 * Returns null when the post has no PNL line AND is not a missed entry.
 */
function resolveEntry(parsed, { tagOutcome = null, hintOutcome = null, createdMs, tz, dayOf = null }) {
  const explicit = tagOutcome || parsed.outcome || null;                     // forum tag > heading in the text
  let outcome = explicit || hintOutcome || null;                             // > the outcome this post is the destination for
  if (parsed.pnlCents === null && explicit !== 'missed') return null;        // a message needs a PNL line or an explicit MISSED heading/tag
  let pnl = parsed.pnlCents ?? 0;
  if (!outcome) outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be';
  if (outcome === 'win') pnl = Math.abs(pnl);
  else if (outcome === 'loss') pnl = -Math.abs(pnl);
  else if (outcome === 'missed') pnl = 0;
  // a date written in the post wins; otherwise the trading day the post was made in (a 7 PM post is tomorrow's session)
  const date = parsed.dateISO || (dayOf ? dayOf(createdMs) : DateTime.fromMillis(createdMs, { zone: tz }).toISODate());
  return { outcome, pnl_cents: pnl, potential_cents: parsed.potentialCents, date_local: date };
}

/** Map a forum tag name to an outcome key */
function tagToOutcome(name) {
  const n = String(name || '').trim().toLowerCase();
  for (const o of Object.values(OUTCOMES)) if (o.tag.toLowerCase() === n || o.upper.toLowerCase() === n) return o.key;
  if (n === 'be' || n === 'break even' || n === 'break-even') return 'be';
  return null;
}

module.exports = { parseText, resolveEntry, tagToOutcome };
