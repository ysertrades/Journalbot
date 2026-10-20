'use strict';
/**
 * The trading day. Futures don't follow the calendar: the CME Globex session
 * opens at 6:00 PM New York time, so a trade at 7:15 PM on Monday belongs to
 * Tuesday's session, and Sunday evening opens Monday. Every date the bot
 * gives a trade (imports, /journal's "today", hand-typed posts, the "today"
 * of /pnl and /trades) goes through tradingDay(), so they all agree.
 *
 * Settings: session_start 'HH:mm' (00:00 = the plain calendar day),
 * session_zone (the clock the start is read on), session_fold (weekend
 * evenings belong to Monday).
 */
const { DateTime } = require('luxon');

const PRESETS = {
  futures:  { label: 'Futures session', emoji: '\u{1F4C8}', start: '18:00', zone: 'America/New_York', fold: true, desc: 'CME Globex: the day starts 6:00 PM New York time; Sunday evening is Monday' },
  forex:    { label: 'Forex session', emoji: '\u{1F4B1}', start: '17:00', zone: 'America/New_York', fold: true, desc: 'The day rolls at 5:00 PM New York time; weekend evenings are Monday' },
  calendar: { label: 'Calendar day', emoji: '\u{1F4C5}', start: '00:00', zone: null, fold: false, desc: 'Midnight to midnight in your timezone' },
};
const DEFAULT = { session_start: '18:00', session_zone: 'America/New_York', session_fold: true };

function sessionOf(settings = {}) {
  const start = /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.session_start || '') ? settings.session_start : DEFAULT.session_start;
  const zone = start === '00:00' ? (settings.timezone || 'America/New_York') : (settings.session_zone || DEFAULT.session_zone);
  const [h, m] = start.split(':').map(Number);
  return { start, zone, minutes: h * 60 + m, fold: settings.session_fold === undefined ? DEFAULT.session_fold : !!settings.session_fold };
}
/** which preset the settings match, or 'custom' */
function presetOf(settings) {
  const s = sessionOf(settings);
  for (const [k, p] of Object.entries(PRESETS)) if (p.start === s.start && (p.zone === null || p.zone === s.zone) && p.fold === s.fold) return k;
  return 'custom';
}

/** the trading day (YYYY-MM-DD) a moment belongs to. at: ms, ISO string or DateTime */
function tradingDay(at, settings) {
  const s = sessionOf(settings);
  let dt = DateTime.isDateTime(at) ? at : typeof at === 'number' ? DateTime.fromMillis(at) : DateTime.fromISO(String(at));
  if (!dt.isValid) return null;
  dt = dt.setZone(s.zone);
  if (s.minutes && dt.hour * 60 + dt.minute >= s.minutes) dt = dt.plus({ days: 1 });
  if (s.fold && dt.weekday >= 6) dt = dt.plus({ days: 8 - dt.weekday });   // Saturday or Sunday -> Monday
  return dt.toISODate();
}
const todayFor = (settings, now = DateTime.now()) => tradingDay(now, settings);
/** the trading day before `iso`: Monday's is Friday when weekends fold */
function previousDay(iso, settings) {
  const s = sessionOf(settings);
  let d = DateTime.fromISO(iso).minus({ days: 1 });
  if (s.fold) while (d.weekday >= 6) d = d.minus({ days: 1 });
  return d.toISODate();
}
/** "Mon 6:00 PM → Tue 6:00 PM ET" style line for panels */
function describe(settings) {
  const s = sessionOf(settings);
  if (!s.minutes) return `Midnight to midnight (${s.zone})`;
  const t = DateTime.fromObject({ hour: Math.floor(s.minutes / 60), minute: s.minutes % 60 }).toFormat('h:mm a');
  return `Starts ${t} ${s.zone === 'America/New_York' ? 'New York time' : s.zone}${s.fold ? ', weekend evenings count as Monday' : ''}`;
}

module.exports = { PRESETS, DEFAULT, sessionOf, presetOf, tradingDay, todayFor, previousDay, describe };
