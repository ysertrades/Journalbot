'use strict';
const { DateTime } = require('luxon');
const { pnlBetween } = require('./db');
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

module.exports = { weekData, monthData };
