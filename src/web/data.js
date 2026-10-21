'use strict';
/**
 * What the web journal reads and writes, built on the same code the bot uses,
 * so a trade edited on the site is the same trade (and the same forum post)
 * as one edited with /edit-trade.
 */
const { DateTime } = require('luxon');
const db = require('../lib/db');
const { monthData } = require('../lib/pnl');
const { tradingDay, todayFor, PRESETS, presetOf, describe, sessionOf } = require('../lib/session');
const { OUTCOMES } = require('../lib/format');

const NOTE_KEYS = ['why', 'p1', 'p2', 'lesson'];
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

/** the period a range name covers, on trading days: [startISO, endISO] */
function rangeBounds(range, settings, { from, to } = {}) {
  const today = DateTime.fromISO(todayFor(settings), { zone: settings.timezone });
  if (range === 'day') return [today.toISODate(), today.toISODate()];
  if (range === 'week') return [today.startOf('week').toISODate(), today.endOf('week').toISODate()];
  if (range === 'month') return [today.startOf('month').toISODate(), today.endOf('month').toISODate()];
  if (range === 'd30') return [today.minus({ days: 29 }).toISODate(), today.toISODate()];
  if (range === 'd90') return [today.minus({ days: 89 }).toISODate(), today.toISODate()];
  if (range === 'year') return [today.startOf('year').toISODate(), today.toISODate()];
  if (range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '')) return from <= to ? [from, to] : [to, from];
  return ['0000-01-01', '9999-12-31'];
}

/** every trade in a period, oldest first, with its journal details; hand-typed posts come back read-only */
function tradesBetween(guildId, start, end, settings) {
  const rows = db.pnlBetween(guildId, start, end);
  const entries = db.entriesForKeys(rows.map((r) => r.thread_id));
  return rows.map((r) => {
    const e = entries[r.thread_id], f = e ? parse(e.fields_json) : {};
    const at = Number(f._at) || e?.created_at || null;
    return {
      key: r.thread_id, post: r.container_id, id: e?.id || null, editable: !!e, date: r.date_local, outcome: r.outcome,
      pnl: r.outcome === 'missed' ? 0 : r.pnl_cents / 100, potential: r.potential_cents != null ? r.potential_cents / 100 : null,
      instrument: e?.instrument || f.instrument || null, direction: e?.direction || f.direction || null, session: f.session || e?.session || null,
      setup: (f.setup && f.setup !== 'Imported from CSV') ? f.setup : null, tag: f.setup === 'Imported from CSV' ? null : f.setup || null,
      r: typeof e?.r_multiple === 'number' ? e.r_multiple : (typeof f.r === 'number' ? f.r : null),
      entry: f.entry || e?.entry || null, stop: f.stop || e?.stop || null, target: f.target || e?.target || null, exit: f.exit || e?.exit || null,
      qty: f._qty || null, held: f._held || null, at, time: at ? DateTime.fromMillis(at, { zone: settings.timezone }).toFormat('HH:mm') : null,
      notes: Object.fromEntries(NOTE_KEYS.map((k) => [k, f[k] || null])), followed: f.followed || null,
      hasChart: !!e?.image_name, hasNotes: NOTE_KEYS.some((k) => f[k] && !/^Imported\b/.test(f[k])), imported: /^Imported\b/.test(f.why || ''),
      link: `https://discord.com/channels/${guildId}/${r.container_id}${r.thread_id !== r.container_id ? `/${r.thread_id}` : ''}`,
    };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)));
}

/**
 * The ledger's filters (range, outcome, symbol, lens, search), in one place: the trades tab, its CSV export and
 * clearing all act on exactly the same trades. Newest first; `all` is the period before the other filters.
 */
function filterTrades(guildId, q, settings) {
  const [start, end] = rangeBounds(q.get('range') || 'month', settings, { from: q.get('from'), to: q.get('to') });
  const all = tradesBetween(guildId, start, end, settings);
  let list = all.slice().reverse();
  const out = q.get('outcome'), sym = (q.get('symbol') || '').toUpperCase(), lens = q.get('lens'), words = String(q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (OUTCOMES[out]) list = list.filter((x) => x.outcome === out);
  if (sym) list = list.filter((x) => (x.instrument || '').toUpperCase() === sym);
  if (lens === 'nochart') list = list.filter((x) => x.editable && !x.hasChart);
  if (lens === 'nonotes') list = list.filter((x) => x.editable && !x.hasNotes);
  if (lens === 'big') list.sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl));
  if (words.length) list = list.filter((x) => { const hay = [x.instrument, x.direction, x.setup, x.session, x.date, ...Object.values(x.notes), String(Math.abs(x.pnl)), x.outcome].filter(Boolean).join(' ').toLowerCase(); return words.every((w) => hay.includes(w.replace(/[$,]/g, ''))); });
  return { list, all, start, end };
}

/**
 * Trades as a CSV a spreadsheet opens and this bot's own importer reads back: the column names are ones the
 * importer knows (Trade ID keeps a re-import from doubling up), times carry their offset, and a cell that a
 * spreadsheet would run as a formula is quoted harmless.
 */
function tradesCsv(list, settings) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v).replace(/\r?\n/g, ' ');
    if (/^[=+\-@\t]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Trade ID', 'Date', 'Exit Time', 'Symbol', 'Side', 'Qty', 'Entry Price', 'Exit Price', 'Stop', 'Target', 'Held', 'Outcome', 'PnL', 'Potential', 'R', 'Session', 'Setup', 'Followed Plan', 'Why', 'Lesson', 'Link'];
  const rows = list.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0))).map((t) => [
    t.key, t.date, t.at ? DateTime.fromMillis(t.at, { zone: settings.timezone }).toISO({ suppressMilliseconds: true }) : '', t.instrument, t.direction, t.qty, t.entry, t.exit, t.stop, t.target, t.held,
    OUTCOMES[t.outcome]?.label || t.outcome, t.outcome === 'missed' ? 0 : t.pnl.toFixed(2), t.potential != null ? t.potential.toFixed(2) : '', t.r, t.session, t.setup, t.followed, t.notes.why, t.notes.lesson, t.link,
  ].map(cell).join(','));
  return `﻿${[head.join(','), ...rows].join('\r\n')}\r\n`;   // the BOM tells Excel it is UTF-8
}

/** the numbers a trader looks at, for any list of trades */
function stats(trades) {
  const c = trades.filter((t) => t.outcome !== 'missed');
  const wins = c.filter((t) => t.pnl > 0), losses = c.filter((t) => t.pnl < 0);
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
  const gw = sum(wins), gl = sum(losses), net = sum(c);
  let run = 0, peak = 0, maxDd = 0, streak = 0, best = 0, cur = 0, curKind = null;
  const equity = c.map((t) => { run += t.pnl; peak = Math.max(peak, run); maxDd = Math.min(maxDd, run - peak); return { date: t.date, v: Math.round(run * 100) / 100, key: t.key }; });
  for (const t of c) { if (t.pnl > 0) { streak += 1; best = Math.max(best, streak); } else streak = 0; }
  for (let i = c.length - 1; i >= 0; i--) { const k = c[i].pnl > 0 ? 'w' : c[i].pnl < 0 ? 'l' : 'b'; if (curKind === null) curKind = k; if (k !== curKind) break; cur += 1; }
  const days = {};
  for (const t of c) (days[t.date] ||= { date: t.date, pnl: 0, n: 0 }), days[t.date].pnl += t.pnl, days[t.date].n += 1;
  const dayList = Object.values(days);
  const rs = c.filter((t) => typeof t.r === 'number');
  const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
  return {
    count: c.length, missed: trades.length - c.length, w: wins.length, l: losses.length, be: c.length - wins.length - losses.length,
    net: r2(net), grossWin: r2(gw), grossLoss: r2(gl), winRate: c.length ? Math.round((100 * wins.length) / c.length) : null,
    profitFactor: gl ? r2(gw / Math.abs(gl)) : (gw ? 'inf' : null), avgWin: wins.length ? r2(gw / wins.length) : null, avgLoss: losses.length ? r2(gl / losses.length) : null,
    expectancy: c.length ? r2(net / c.length) : null, best: c.length ? c.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null, worst: c.length ? c.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
    bestDay: dayList.length ? dayList.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null, worstDay: dayList.length ? dayList.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
    greenDays: dayList.filter((d) => d.pnl > 0).length, redDays: dayList.filter((d) => d.pnl < 0).length, tradingDays: dayList.length,
    streak: best, current: { kind: curKind, n: cur }, maxDrawdown: r2(maxDd), rSum: rs.length ? r2(rs.reduce((s, t) => s + t.r, 0)) : null, avgR: rs.length ? r2(rs.reduce((s, t) => s + t.r, 0) / rs.length) : null,
    equity, days: dayList.map((d) => ({ ...d, pnl: r2(d.pnl) })),
    longs: { n: c.filter((t) => /^l/i.test(t.direction || '')).length, pnl: r2(sum(c.filter((t) => /^l/i.test(t.direction || '')))) },
    shorts: { n: c.filter((t) => /^s/i.test(t.direction || '')).length, pnl: r2(sum(c.filter((t) => /^s/i.test(t.direction || '')))) },
  };
}

/** where the edge is: by symbol, setup, weekday, hour, session, side, hold time and R */
function insights(trades) {
  const c = trades.filter((t) => t.outcome !== 'missed');
  const group = (fn) => {
    const m = new Map();
    for (const t of c) { const k = fn(t); if (k === null || k === undefined || k === '') continue; const g = m.get(k) || { key: k, n: 0, w: 0, pnl: 0 }; g.n += 1; g.w += t.pnl > 0 ? 1 : 0; g.pnl += t.pnl; m.set(k, g); }
    return [...m.values()].map((g) => ({ ...g, pnl: Math.round(g.pnl * 100) / 100, winRate: Math.round((100 * g.w) / g.n), avg: Math.round((g.pnl / g.n) * 100) / 100 }));
  };
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const heldMin = (h) => { if (!h) return null; let m = 0; for (const [, n, u] of String(h).matchAll(/(\d+)\s*([hms])/g)) m += u === 'h' ? n * 60 : u === 'm' ? +n : n / 60; return m || null; };
  const holds = c.map((t) => ({ m: heldMin(t.held), win: t.pnl > 0 })).filter((x) => x.m !== null);
  const avgOf = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x.m, 0) / a.length) * 10) / 10 : null);
  const rBins = [[-Infinity, -2, '< -2R'], [-2, -1, '-2 to -1R'], [-1, 0, '-1 to 0R'], [0, 1, '0 to 1R'], [1, 2, '1 to 2R'], [2, 3, '2 to 3R'], [3, Infinity, '3R +']];
  return {
    bySymbol: group((t) => (t.instrument || '').toUpperCase() || null).sort((a, b) => b.n - a.n),
    bySetup: group((t) => t.setup).sort((a, b) => b.pnl - a.pnl).slice(0, 12),
    bySession: group((t) => t.session).sort((a, b) => b.pnl - a.pnl),
    byWeekday: WD.map((d, i) => group((t) => (DateTime.fromISO(t.date).weekday === i + 1 ? d : null))[0] || { key: d, n: 0, w: 0, pnl: 0, winRate: null, avg: 0 }).slice(0, 5),
    byHour: Array.from({ length: 24 }, (_, h) => group((t) => (t.time && Number(t.time.slice(0, 2)) === h ? h : null))[0] || { key: h, n: 0, pnl: 0 }),
    bySide: group((t) => (/^l/i.test(t.direction || '') ? 'Long' : /^s/i.test(t.direction || '') ? 'Short' : null)),
    hold: { win: avgOf(holds.filter((x) => x.win)), loss: avgOf(holds.filter((x) => !x.win)), n: holds.length },
    rDist: rBins.map(([lo, hi, label]) => ({ label, n: c.filter((t) => typeof t.r === 'number' && t.r >= lo && t.r < hi).length })),
    discipline: (() => { const f = trades.filter((t) => t.followed); const yes = f.filter((t) => t.followed === 'YES'); return { tracked: f.length, followed: yes.length, pnlFollowed: Math.round(yes.reduce((s, t) => s + t.pnl, 0) * 100) / 100, pnlBroke: Math.round(f.filter((t) => t.followed === 'NO').reduce((s, t) => s + t.pnl, 0) * 100) / 100 }; })(),
    completeness: { charts: trades.filter((t) => t.editable && !t.hasChart).length, notes: trades.filter((t) => t.editable && !t.hasNotes).length },
  };
}

/** one month as a calendar: each day's PnL and count, week totals, on trading days */
function calendar(guildId, year, month, settings) {
  const m = monthData(guildId, year, month, settings.timezone, settings.currency);
  return { year, month, label: m.monthLabel, total: m.total, days: m.data, green: m.green, red: m.red, tradedDays: m.tradedDays };
}

/** the settings a panel may show (no secrets), plus what it needs to draw its pickers */
function settingsView(guild, s) {
  const { ChannelType } = require('discord.js');
  const ch = [...guild.channels.cache.values()];
  const pick = (types) => ch.filter((c) => types.includes(c.type)).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).map((c) => ({ id: c.id, name: c.name }));
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  return {
    settings: {
      timezone: s.timezone, currency: s.currency, show_r: s.show_r, theme: s.theme,
      weekly_enabled: s.weekly_enabled, weekly_day: s.weekly_day, weekly_time: s.weekly_time, month_enabled: s.month_enabled, month_time: s.month_time,
      report_channel_id: s.report_channel_id, ping_role_id: s.ping_role_id, default_forum_id: s.default_forum_id, forums: s.forums,
      outcome_forums: s.outcome_forums, outcome_threads: s.outcome_threads, allowed_users: s.allowed_users,
      session_start: s.session_start, session_zone: s.session_zone, session_fold: s.session_fold,
    },
    session: { preset: presetOf(s), describe: describe(s), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { label: p.label, desc: p.desc, start: p.start }])), today: todayFor(s), start: sessionOf(s).start },
    outcomes: Object.values(OUTCOMES).map((o) => ({ key: o.key, label: o.label })),
    forums: pick([ChannelType.GuildForum, ChannelType.GuildMedia]), text: pick([ChannelType.GuildText, ChannelType.GuildAnnouncement]), roles,
  };
}

module.exports = { rangeBounds, tradesBetween, filterTrades, tradesCsv, stats, insights, calendar, settingsView, tradingDay };
