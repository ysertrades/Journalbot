'use strict';
const { DateTime } = require('luxon');
const { pnlBetween, entryDetailsFor } = require('./db');
const { formatDollars } = require('./money');

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

function emptyBucket() { return { pnl: 0, trades: 0, w: 0, l: 0, be: 0, missed: 0 }; }
function addTo(b, e) {
  if (e.outcome === 'missed') { b.missed += 1; return; }
  b.pnl += e.pnl_cents / 100; b.trades += 1;
  if (e.outcome === 'win') b.w += 1; else if (e.outcome === 'loss') b.l += 1; else b.be += 1;
}

/** anchorISO: any date inside the wanted week (YYYY-MM-DD in tz) */
function weekData(guildId, anchorISO, tz, symbol = '$') {
  const start = DateTime.fromISO(anchorISO, { zone: tz }).startOf('week'); // ISO week: Monday
  const end = start.plus({ days: 6 });
  const rows = pnlBetween(guildId, start.toISODate(), end.toISODate());
  const days = DAY_NAMES.map((d, i) => {
    const dt = start.plus({ days: i });
    return { day: d, date: dt.setLocale('en').toFormat('LLL d'), iso: dt.toISODate(), ...emptyBucket() };
  });
  const weekend = emptyBucket();
  const wkIso = [start.plus({ days: 5 }).toISODate(), start.plus({ days: 6 }).toISODate()];
  for (const r of rows) {
    if (wkIso.includes(r.date_local)) addTo(weekend, r);
    else addTo(days.find((d) => d.iso === r.date_local), r);
  }
  const all = [...days, weekend];
  const total = all.reduce((s, d) => s + d.pnl, 0);
  const trades = all.reduce((s, d) => s + d.trades, 0);
  const wins = all.reduce((s, d) => s + d.w, 0), losses = all.reduce((s, d) => s + d.l, 0), be = all.reduce((s, d) => s + d.be, 0);
  const missed = all.reduce((s, d) => s + d.missed, 0);
  const traded = days.filter((d) => d.trades > 0);
  const best = traded.length ? traded.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const startLbl = start.setLocale('en').toFormat('LLL d').toUpperCase();
  const endFri = start.plus({ days: 4 });
  const rangeLabel = start.month === endFri.month
    ? `${startLbl} \u2013 ${endFri.day}, ${endFri.year}`
    : `${startLbl} \u2013 ${endFri.setLocale('en').toFormat('LLL d').toUpperCase()}, ${endFri.year}`;
  const weekNo = start.weekNumber;
  return {
    kind: 'weekly', start: start.toISODate(), weekNo, weekYear: start.weekYear, rangeLabel, days,
    weekend: weekend.trades || weekend.pnl ? weekend : null, total, trades, wins, losses, be, missed, best,
    winRate: trades ? Math.round((100 * wins) / trades) : 0, symbol,
    stats: [
      { k: 'WIN RATE', v: trades ? `${Math.round((100 * wins) / trades)}%` : '\u2014' },
      { k: 'TRADES', v: String(trades) },
      { k: 'W \u00b7 L \u00b7 BE', v: `${wins} \u00b7 ${losses} \u00b7 ${be}` },
      { k: 'MISSED', v: String(missed) },
      { k: 'BEST DAY', v: best ? formatDollars(best.pnl, { symbol }) : '\u2014', tone: best && best.pnl > 0 ? 'good' : best && best.pnl < 0 ? 'bad' : null },
    ],
  };
}

function monthData(guildId, year, month, tz, symbol = '$') {
  const start = DateTime.fromObject({ year, month, day: 1 }, { zone: tz });
  const end = start.endOf('month');
  const rows = pnlBetween(guildId, start.toISODate(), end.toISODate());
  const data = {};
  for (const r of rows) {
    const day = Number(r.date_local.slice(8, 10));
    addTo((data[day] ||= emptyBucket()), r);
  }
  const days = Object.keys(data).map(Number).sort((a, b) => a - b);
  const traded = days.filter((d) => data[d].trades > 0);
  const total = Object.values(data).reduce((s, d) => s + d.pnl, 0);
  const green = traded.filter((d) => data[d].pnl > 0).length;
  const red = traded.filter((d) => data[d].pnl < 0).length;
  const be = traded.filter((d) => data[d].pnl === 0).length;
  const missed = Object.values(data).reduce((s, d) => s + d.missed, 0);
  const best = traded.length ? traded.reduce((a, b) => (data[b].pnl > data[a].pnl ? b : a)) : null;
  const worst = traded.length ? traded.reduce((a, b) => (data[b].pnl < data[a].pnl ? b : a)) : null;
  const avg = traded.length ? total / traded.length : 0;
  const lbl = (d) => (d === null ? '\u2014' : formatDollars(data[d].pnl, { symbol }));
  return {
    kind: 'monthly', year, month, monthLabel: `${start.setLocale('en').toFormat('LLLL').toUpperCase()} ${year}`,
    monthShort: start.setLocale('en').toFormat('LLL').toUpperCase(), data, total, tradedDays: traded.length, green, red, be, missed,
    stats: [
      { k: 'WIN RATE', v: traded.length ? `${Math.round((100 * green) / traded.length)}%` : '\u2014' },
      { k: 'G \u00b7 R \u00b7 BE', v: `${green} \u00b7 ${red} \u00b7 ${be}` },
      { k: 'BEST DAY', v: lbl(best), tone: best !== null && data[best].pnl > 0 ? 'good' : null },
      { k: 'WORST DAY', v: lbl(worst), tone: worst !== null && data[worst].pnl < 0 ? 'bad' : null },
      { k: 'AVG / DAY', v: traded.length ? formatDollars(Math.round(avg + 1e-9), { symbol }) : '\u2014' },
      { k: 'MISSED', v: String(missed) },
    ],
  };
}

/**
 * One day: every trade in order (with its journal details when the bot
 * logged it), the day's totals, and the week around it for context.
 * isoDate: YYYY-MM-DD in tz.
 */
function dayData(guildId, isoDate, tz, symbol = '$') {
  const dt = DateTime.fromISO(isoDate, { zone: tz });
  const rows = pnlBetween(guildId, isoDate, isoDate);
  const details = entryDetailsFor(rows.map((r) => r.thread_id));
  const trades = rows.map((r) => {
    const d = details[r.thread_id] || {};
    return {
      key: r.thread_id, outcome: r.outcome, pnl: r.outcome === 'missed' ? 0 : r.pnl_cents / 100,
      potential: r.potential_cents != null ? r.potential_cents / 100 : null,
      instrument: d.instrument || null, direction: d.direction || null, r: d.r_multiple ?? null,
      setup: d.setup || null, at: d.created_at || r.updated_at || 0,
    };
  }).sort((a, b) => a.at - b.at);
  const b = emptyBucket();
  for (const r of rows) addTo(b, r);
  const counted = trades.filter((t) => t.outcome !== 'missed');
  const rSum = counted.reduce((s, t) => s + (typeof t.r === 'number' && !Number.isNaN(t.r) ? t.r : 0), 0);
  const hasR = counted.some((t) => typeof t.r === 'number' && !Number.isNaN(t.r));
  const best = counted.length ? counted.reduce((a, c) => (c.pnl > a.pnl ? c : a)) : null;
  // the week around it (Mon-Fri), for the strip at the bottom
  const wk = weekData(guildId, isoDate, tz, symbol);
  return {
    kind: 'daily', date: isoDate, symbol,
    weekday: dt.setLocale('en').toFormat('cccc'),
    dateLabel: dt.setLocale('en').toFormat('LLL d, yyyy').toUpperCase(),
    trades, total: b.pnl, count: b.trades, w: b.w, l: b.l, be: b.be, missed: b.missed,
    winRate: b.trades ? Math.round((100 * b.w) / b.trades) : null,
    rSum: hasR ? rSum : null, best,
    week: wk.days.map((d) => ({ day: d.day, pnl: d.pnl, trades: d.trades, today: d.iso === isoDate })),
    weekTotal: wk.total,
  };
}

/**
 * Every trade in a period, as a list, for /trades.
 * range: 'day' | 'week' (Mon-Sun) | 'month'; anchorISO: a date inside it (YYYY-MM-DD in tz).
 */
function tradesData(guildId, range, tz, symbol = '$', anchorISO = DateTime.now().setZone(tz).toISODate()) {
  const a = DateTime.fromISO(anchorISO, { zone: tz });
  const start = range === 'month' ? a.startOf('month') : range === 'week' ? a.startOf('week') : a.startOf('day');
  const end = range === 'month' ? a.endOf('month') : range === 'week' ? start.plus({ days: 6 }) : start;
  const rows = pnlBetween(guildId, start.toISODate(), end.toISODate());
  const details = entryDetailsFor(rows.map((r) => r.thread_id));
  const trades = rows.map((r) => {
    const d = details[r.thread_id] || {};
    let f = {}; try { f = d.fields_json ? JSON.parse(d.fields_json) : {}; } catch { f = {}; }
    const at = Number(f._at) || null;           // the real trade time, known for imported trades
    return {
      key: r.thread_id, date: r.date_local, outcome: r.outcome, pnl: r.outcome === 'missed' ? 0 : r.pnl_cents / 100,
      potential: r.potential_cents != null ? r.potential_cents / 100 : null,
      instrument: d.instrument || null, direction: d.direction || null, r: typeof d.r_multiple === 'number' ? d.r_multiple : null,
      setup: d.setup || null, entry: d.entry || null, exit: d.exit || null, qty: f._qty || null, held: f._held || null,
      time: at ? DateTime.fromMillis(at, { zone: tz }).toFormat('HH:mm') : null,
      sort: `${r.date_local} ${at ? String(at).padStart(15, '0') : String(d.created_at || r.updated_at || 0).padStart(15, '0')}`,
    };
  }).sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));

  const counted = trades.filter((t) => t.outcome !== 'missed');
  const wins = counted.filter((t) => t.pnl > 0), losses = counted.filter((t) => t.pnl < 0);
  const sum = (xs) => xs.reduce((s, t) => s + t.pnl, 0);
  const grossWin = sum(wins), grossLoss = sum(losses), net = sum(counted);
  let streak = 0, run = 0;
  for (const t of counted) { run = t.pnl > 0 ? run + 1 : 0; streak = Math.max(streak, run); }
  const rs = counted.filter((t) => typeof t.r === 'number' && !Number.isNaN(t.r));
  const bySym = {};
  for (const t of counted) { const k = t.instrument || '—'; (bySym[k] ||= { symbol: k, n: 0, pnl: 0 }); bySym[k].n += 1; bySym[k].pnl += t.pnl; }
  const longs = counted.filter((t) => /^l/i.test(t.direction || '')), shorts = counted.filter((t) => /^s/i.test(t.direction || ''));
  const label = range === 'day'
    ? start.setLocale('en').toFormat('cccc, LLL d').toUpperCase()
    : range === 'week' ? `${start.setLocale('en').toFormat('LLL d').toUpperCase()} – ${end.setLocale('en').toFormat(start.month === end.month ? 'd' : 'LLL d').toUpperCase()}, ${end.year}`
      : start.setLocale('en').toFormat('LLLL yyyy').toUpperCase();
  const today = DateTime.now().setZone(tz).toISODate();
  const lead = range === 'day' ? (start.toISODate() === today ? 'Today' : start.setLocale('en').toFormat('cccc'))
    : range === 'week' ? (start.toISODate() === DateTime.now().setZone(tz).startOf('week').toISODate() ? 'This week' : `Week ${start.weekNumber}`)
      : start.setLocale('en').toFormat('LLLL');
  return {
    kind: 'trades', range, start: start.toISODate(), end: end.toISODate(), label, lead, symbol,
    trades, count: counted.length, w: wins.length, l: losses.length, be: counted.length - wins.length - losses.length,
    missed: trades.length - counted.length, net, grossWin, grossLoss,
    winRate: counted.length ? Math.round((100 * wins.length) / counted.length) : null,
    profitFactor: grossLoss ? grossWin / Math.abs(grossLoss) : (grossWin ? Infinity : null),
    avgWin: wins.length ? grossWin / wins.length : null, avgLoss: losses.length ? grossLoss / losses.length : null,
    best: counted.length ? counted.reduce((x, y) => (y.pnl > x.pnl ? y : x)) : null,
    worst: counted.length ? counted.reduce((x, y) => (y.pnl < x.pnl ? y : x)) : null,
    streak, rSum: rs.length ? rs.reduce((s, t) => s + t.r, 0) : null,
    symbols: Object.values(bySym).sort((x, y) => y.n - x.n || y.pnl - x.pnl).slice(0, 4),
    longs: { n: longs.length, pnl: sum(longs) }, shorts: { n: shorts.length, pnl: sum(shorts) },
  };
}

module.exports = { weekData, monthData, dayData, tradesData };
