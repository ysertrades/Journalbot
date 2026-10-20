'use strict';
/**
 * The JSON API behind /app. Every route under /api/g/<guildId>/ checks the
 * session, the bot's membership and the journal permission; writes also need
 * the CSRF header, and settings need Manage Server. Edits go through the same
 * code as /edit-trade and /journal, so the forum post is rewritten or posted
 * exactly as the slash commands would.
 */
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const auth = require('./auth');
const data = require('./data');
const db = require('../lib/db');
const { OUTCOMES } = require('../lib/format');
const { parseMoney, parseR, applyOutcomeSign, parseDateInput } = require('../lib/money');
const { todayFor, previousDay, tradingDay, PRESETS } = require('../lib/session');

const DATE = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, SNOW = /^\d{5,25}$/;
const clean = (s, n) => String(s ?? '').replace(/[`\r]/g, "'").trim().slice(0, n);
const IMG = /^image\/(png|jpe?g|webp|gif)$/i;
// what the journal needs: view, send, embed, attach, read history, external emoji, create and manage threads, send in threads
const INVITE_PERMS = (1n << 10n | 1n << 11n | 1n << 14n | 1n << 15n | 1n << 16n | 1n << 18n | 1n << 34n | 1n << 35n | 1n << 38n).toString();

module.exports = function routes(client, { json, fail, readBody, limited }) {
  const jobs = new Map();   // CSV imports and re-date runs, polled by the page

  function picture(body) {
    if (!body.image) return { image: null };
    const { name, type, data: b64 } = body.image;
    if (!IMG.test(type || '') || typeof b64 !== 'string') return { error: 'Pictures must be png, jpg, webp or gif.' };
    if (b64.length > 11 * 1024 * 1024) return { error: 'That picture is over 8 MB.' };
    return { image: { name: clean(name || 'chart.png', 64), data: b64, contentType: type } };
  }

  /** fields from a form, validated the same way the Discord forms are */
  function fieldsFrom(body, outcome, settings, base = {}) {
    const f = { ...base }, errors = [];
    const set = (k, v) => { if (v) f[k] = v; else delete f[k]; };
    if ('instrument' in body) { const v = clean(body.instrument, 20).toUpperCase().replace(/\s+/g, ''); if (!v) errors.push('Instrument is required.'); else f.instrument = v; }
    if ('direction' in body) { if (!['Long', 'Short'].includes(body.direction)) errors.push('Direction must be Long or Short.'); else f.direction = body.direction; }
    if ('date' in body) {
      const today = todayFor(settings);
      const d = parseDateInput(String(body.date || 'today'), settings.timezone, { today, yesterday: previousDay(today, settings) });
      if (!d) errors.push('Could not read that date.'); else f.date = d;
    }
    for (const k of ['session', 'setup']) if (k in body) set(k, clean(body[k], 100));
    for (const k of ['entry', 'stop', 'target', 'exit']) if (k in body) set(k, clean(body[k], 24));
    for (const k of ['why', 'lesson']) if (k in body) set(k, clean(body[k], k === 'why' ? 400 : 300));
    for (const k of ['p1', 'p2']) if (k in body) set(k, clean(body[k], 200));
    if ('followed' in body) set('followed', ['YES', 'NO'].includes(body.followed) ? body.followed : null);
    if (outcome === 'missed') {
      f.pnl_cents = 0;
      if ('potential' in body) { const raw = String(body.potential ?? '').trim(); if (!raw) delete f.potential_cents; else { const c = parseMoney(raw); if (c === null) errors.push('Potential is not an amount.'); else f.potential_cents = Math.abs(c); } }
    } else {
      if ('pnl' in body) { const c = parseMoney(String(body.pnl ?? '')); if (c === null) errors.push('PnL is not an amount, e.g. 1250 or 480.50.'); else f.pnl_cents = applyOutcomeSign(outcome, c); }
      else if (f.pnl_cents !== undefined) f.pnl_cents = applyOutcomeSign(outcome, f.pnl_cents);
      if ('r' in body) { const raw = String(body.r ?? '').trim(); if (!raw) delete f.r; else { const r = parseR(raw); if (Number.isNaN(r)) errors.push('R is not a number.'); else f.r = r; } }
    }
    return { fields: f, errors };
  }

  async function guildCtx(req, res, gid, { write = false, manage = false } = {}) {
    const session = auth.sessionFor(req);
    if (!session) { fail(res, 401, 'signed_out'); return null; }
    if (!SNOW.test(gid)) { fail(res, 404, 'no_server'); return null; }
    const guild = client.guilds.cache.get(gid);
    const settings = db.getSettings(gid);
    const access = auth.accessTo(session, gid, client, settings);
    if (!guild || !access) { fail(res, 403, 'no_access', 'You can’t open this server’s journal.'); return null; }
    if (manage && !access.manage) { fail(res, 403, 'manage_only', 'Changing settings needs Manage Server.'); return null; }
    if (!manage && !access.journal) { fail(res, 403, 'no_access', 'This server only lets selected people use the journal.'); return null; }
    if (write || manage) {
      if (req.method === 'GET') { fail(res, 405, 'method'); return null; }
      if (!auth.csrfValid(session, req.headers['x-csrf'])) { fail(res, 403, 'csrf', 'Reload the page and try again.'); return null; }
      if (limited(req, `w:${session.uid}`, 90)) { fail(res, 429, 'slow_down', 'Too many changes at once. Wait a moment.'); return null; }
    }
    return { session, guild, settings, access };
  }

  return async function api(req, res, url) {
    const p = url.pathname, q = url.searchParams;

    if (p === '/api/public') {   // the landing page's live line
      const c = db.publicCounts();
      return json(res, 200, { ...c, servers: client.guilds.cache.size, online: !!client.isReady?.(), login: auth.missingConfig().length === 0,
        invite: process.env.DISCORD_CLIENT_ID ? `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=${INVITE_PERMS}` : null });
    }
    if (p === '/api/me') {
      const s = auth.sessionFor(req);
      if (!s) return json(res, 200, { signedIn: false, login: auth.missingConfig().length === 0, embed: auth.embeddable() });
      const guilds = (s.g || []).map((g) => {
        const guild = client.guilds.cache.get(g.id); if (!guild) return null;
        const a = auth.accessTo(s, g.id, client, db.getSettings(g.id)); if (!a) return null;
        return { id: g.id, name: guild.name, icon: guild.iconURL?.({ size: 64 }) || null, journal: a.journal, manage: a.manage };
      }).filter(Boolean);
      if (auth.isOwner(s.uid)) for (const guild of client.guilds.cache.values()) if (!guilds.some((x) => x.id === guild.id)) guilds.push({ id: guild.id, name: guild.name, icon: guild.iconURL?.({ size: 64 }) || null, journal: true, manage: true });
      return json(res, 200, { signedIn: true, user: { id: s.uid, name: s.name, avatar: s.avatar ? `https://cdn.discordapp.com/avatars/${s.uid}/${s.avatar}.png?size=64` : null }, guilds, csrf: auth.csrfFor(s), embed: auth.embeddable() });
    }

    const m = p.match(/^\/api\/g\/(\d+)\/([a-z-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?$/);
    if (!m) return fail(res, 404, 'not_found');
    const [, gid, area, a1, a2] = m;

    /* ---------- reading ---------- */
    if (area === 'overview' && req.method === 'GET') {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const range = q.get('range') || 'week';
      const [start, end] = data.rangeBounds(range, ctx.settings, { from: q.get('from'), to: q.get('to') });
      const trades = data.tradesBetween(gid, start, end, ctx.settings);
      const today = todayFor(ctx.settings);
      const todayTrades = range === 'day' ? trades : data.tradesBetween(gid, today, today, ctx.settings);
      const t = DateTime.fromISO(today);
      return json(res, 200, { range, start: start === '0000-01-01' ? (trades[0]?.date || today) : start, end: end === '9999-12-31' ? today : end, today, stats: data.stats(trades),
        todayStats: data.stats(todayTrades), recent: trades.slice(-8).reverse(), insights: data.insights(trades), calendar: data.calendar(gid, t.year, t.month, ctx.settings),
        currency: ctx.settings.currency, theme: ctx.settings.theme, session: ctx.settings.session_start, manage: ctx.access.manage });
    }
    if (area === 'trades' && req.method === 'GET' && !a1) {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const [start, end] = data.rangeBounds(q.get('range') || 'month', ctx.settings, { from: q.get('from'), to: q.get('to') });
      let list = data.tradesBetween(gid, start, end, ctx.settings).reverse();
      const out = q.get('outcome'), sym = (q.get('symbol') || '').toUpperCase(), lens = q.get('lens'), words = String(q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (OUTCOMES[out]) list = list.filter((x) => x.outcome === out);
      if (sym) list = list.filter((x) => (x.instrument || '').toUpperCase() === sym);
      if (lens === 'nochart') list = list.filter((x) => x.editable && !x.hasChart);
      if (lens === 'nonotes') list = list.filter((x) => x.editable && !x.hasNotes);
      if (lens === 'big') list.sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl));
      if (words.length) list = list.filter((x) => { const hay = [x.instrument, x.direction, x.setup, x.session, x.date, ...Object.values(x.notes), String(Math.abs(x.pnl)), x.outcome].filter(Boolean).join(' ').toLowerCase(); return words.every((w) => hay.includes(w.replace(/[$,]/g, ''))); });
      const symbols = [...new Set(data.tradesBetween(gid, start, end, ctx.settings).map((x) => (x.instrument || '').toUpperCase()).filter(Boolean))].sort();
      const page = Math.max(0, Number(q.get('page')) || 0), per = 50;
      return json(res, 200, { total: list.length, page, pages: Math.max(1, Math.ceil(list.length / per)), trades: list.slice(page * per, (page + 1) * per), symbols, stats: data.stats(list), currency: ctx.settings.currency });
    }
    if (area === 'calendar' && req.method === 'GET') {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const mm = MONTH.test(q.get('month') || '') ? q.get('month') : todayFor(ctx.settings).slice(0, 7);
      const [y, mo] = mm.split('-').map(Number);
      const start = DateTime.fromObject({ year: y, month: mo, day: 1 }), end = start.endOf('month');
      const trades = data.tradesBetween(gid, start.toISODate(), end.toISODate(), ctx.settings);
      return json(res, 200, { ...data.calendar(gid, y, mo, ctx.settings), month: mm, today: todayFor(ctx.settings), stats: data.stats(trades), trades, currency: ctx.settings.currency });
    }
    if (area === 'insights' && req.method === 'GET') {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const [start, end] = data.rangeBounds(q.get('range') || 'd90', ctx.settings, { from: q.get('from'), to: q.get('to') });
      const trades = data.tradesBetween(gid, start, end, ctx.settings);
      return json(res, 200, { insights: data.insights(trades), stats: data.stats(trades), currency: ctx.settings.currency });
    }
    if (area === 'card' && req.method === 'GET') {   // any card as a PNG, in either theme
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const r = require('../lib/reports'), s = { ...ctx.settings, theme: ['light', 'dark'].includes(q.get('theme')) ? q.get('theme') : ctx.settings.theme };
      const today = todayFor(ctx.settings), d = DATE.test(q.get('date') || '') ? q.get('date') : today;
      let buf, name;
      if (a1 === 'day') ({ buffer: buf, name } = r.dailyImage(gid, d, s));
      else if (a1 === 'week') ({ buffer: buf, name } = r.weeklyImage(gid, d, s));
      else if (a1 === 'month') { const mm = MONTH.test(q.get('month') || '') ? q.get('month') : d.slice(0, 7); const [y, mo] = mm.split('-').map(Number); ({ buffer: buf, name } = r.monthlyImage(gid, y, mo, s)); }
      else if (a1 === 'trades') {
        const { tradesData } = require('../lib/pnl'), { renderTrades } = require('../lib/renderer'), { resolveTheme } = require('../lib/theme');
        const range = ['day', 'week', 'month'].includes(q.get('range')) ? q.get('range') : 'week';
        const img = renderTrades(tradesData(gid, range, s.timezone, s.currency, d, today), Number(q.get('page')) || 0, { theme: resolveTheme(s) });
        buf = img.buffer; name = `trades-${range}-${d}.png`;
      } else return fail(res, 404, 'no_card');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store', 'content-disposition': `inline; filename="${name}"`, 'x-content-type-options': 'nosniff' });
      return res.end(buf);
    }

    /* ---------- the journal: edit, log, import ---------- */
    if (area === 'trades' && a1 && req.method === 'PATCH') {
      const ctx = await guildCtx(req, res, gid, { write: true }); if (!ctx) return;
      const entry = db.getEntry(Number(a1));
      if (!entry || entry.guild_id !== gid) return fail(res, 404, 'no_trade');
      const body = await readBody(req);
      const ed = require('../lib/trade-editor');
      const look = await ed.inspectTrade(ctx.guild, entry);
      if (look.problem) return fail(res, 409, 'not_editable', look.problem);
      const draft = ed.loadTrade({ guildId: gid, fields: {} }, entry, look);
      const { fields, errors } = fieldsFrom(body, draft.outcome, ctx.settings, draft.fields);
      if (errors.length) return fail(res, 400, 'invalid', errors.join(' '));
      draft.fields = fields;
      const pic = picture(body); if (pic.error) return fail(res, 400, 'invalid', pic.error);
      if (pic.image) draft.image = pic.image;
      if (body.removeChart) draft.fields._edit.removePic = true;
      const changes = ed.changesOf(draft);
      if (!changes.length) return json(res, 200, { ok: true, unchanged: true });
      await ed.saveTrade({ guild: ctx.guild, draft, settings: ctx.settings });
      return json(res, 200, { ok: true, changed: changes });
    }
    if (area === 'journal' && req.method === 'POST') {
      const ctx = await guildCtx(req, res, gid, { write: true }); if (!ctx) return;
      const body = await readBody(req);
      const outcome = OUTCOMES[body.outcome] ? body.outcome : null;
      if (!outcome) return fail(res, 400, 'invalid', 'Pick an outcome.');
      const { fields, errors } = fieldsFrom({ date: 'today', ...body }, outcome, ctx.settings);
      if (!fields.instrument) errors.push('Instrument is required.');
      if (!fields.direction) errors.push('Pick Long or Short.');
      if (outcome !== 'missed' && fields.pnl_cents === undefined) errors.push('PnL is required.');
      if (errors.length) return fail(res, 400, 'invalid', [...new Set(errors)].join(' '));
      const pic = picture(body); if (pic.error) return fail(res, 400, 'invalid', pic.error);
      const { routeTarget } = require('../lib/routing');
      const t = routeTarget(ctx.settings, outcome);
      if (!t) return fail(res, 400, 'no_destination', `No forum is set for ${OUTCOMES[outcome].label} yet (Settings → Forums).`);
      const { postJournal } = require('../lib/poster');
      const out = await postJournal({ guild: ctx.guild, settings: ctx.settings, draft: { userId: ctx.session.uid, outcome, forumId: t.forumId, image: pic.image, fields: { ...fields, ...(t.threadId ? { _thread: t.threadId } : {}) } } });
      return json(res, 200, { ok: true, link: `https://discord.com/channels/${gid}/${out.thread.id}${out.existing ? `/${out.messageId}` : ''}`, date: fields.date });
    }
    if (area === 'import' && a1 === 'preview' && req.method === 'POST') {
      const ctx = await guildCtx(req, res, gid, { write: true }); if (!ctx) return;
      const body = await readBody(req);
      if (typeof body.csv !== 'string' || !body.csv.trim()) return fail(res, 400, 'invalid', 'Drop a CSV first.');
      if (body.csv.length > 2 * 1024 * 1024) return fail(res, 413, 'too_large', 'That file is over 2 MB. Export a shorter range.');
      const { readTrades, sparkline } = require('../lib/csv-import');
      const { classifyTrades } = require('../interaction-handlers/journal-modals');
      const r = readTrades(body.csv, ctx.settings.timezone, (dt) => tradingDay(dt, ctx.settings));
      if (r.error) return fail(res, 400, 'unreadable', r.error);
      const { fresh, manual, dupes, imported } = classifyTrades(gid, r.trades);
      const backfilled = imported.length ? db.backfillImported(gid, imported) : 0;
      const id = crypto.randomBytes(9).toString('base64url');
      jobs.set(id, { kind: 'import', gid, uid: ctx.session.uid, at: Date.now(), fresh, manual, file: clean(body.name || 'trades.csv', 60), tag: clean(body.tag, 60) || null, state: 'preview' });
      for (const [k, v] of jobs) if (Date.now() - v.at > 3600000) jobs.delete(k);
      const { routeTarget } = require('../lib/routing');
      return json(res, 200, { id, format: r.format, fresh: fresh.map(slim), manual: manual.map(slim), dupes, backfilled, skipped: r.skipped.slice(0, 50), truncated: !!r.truncated,
        noDestination: ['win', 'loss', 'be'].filter((o) => !routeTarget(ctx.settings, o)), lastRun: db.lastImportRun(gid), spark: sparkline(cum(fresh), 40) });
    }
    if (area === 'import' && a1 && a2 === 'run' && req.method === 'POST') {
      const ctx = await guildCtx(req, res, gid, { write: true }); if (!ctx) return;
      const job = jobs.get(a1); if (!job || job.gid !== gid || job.uid !== ctx.session.uid) return fail(res, 404, 'expired', 'That preview expired. Drop the file again.');
      if (job.state !== 'preview') return json(res, 200, { id: a1, state: job.state });
      const body = await readBody(req);
      job.queue = [...job.fresh, ...(body.includeManual ? job.manual : [])].sort((x, y) => x.at - y.at).slice(0, 400);
      job.state = 'running'; job.done = 0; job.total = job.queue.length; job.result = { win: 0, loss: 0, be: 0, net: 0, failed: [] };
      runImport(ctx, job).catch((e) => { job.state = 'failed'; job.error = e.message; });
      return json(res, 200, { id: a1, state: 'running', total: job.total });
    }
    if (area === 'jobs' && a1 && req.method === 'GET') {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      const job = jobs.get(a1); if (!job || job.gid !== gid) return fail(res, 404, 'expired');
      return json(res, 200, { state: job.state, done: job.done || 0, total: job.total || 0, last: job.last || null, result: job.result || null, error: job.error || null });
    }

    /* ---------- the control panel (Manage Server) ---------- */
    if (area === 'settings' && req.method === 'GET') {
      const ctx = await guildCtx(req, res, gid); if (!ctx) return;
      return json(res, 200, { ...data.settingsView(ctx.guild, ctx.settings), manage: ctx.access.manage });
    }
    if (area === 'settings' && req.method === 'PATCH') {
      const ctx = await guildCtx(req, res, gid, { manage: true }); if (!ctx) return;
      const b = await readBody(req), s = ctx.settings, patch = {}, bad = [];
      const chanOk = (id, kinds) => id === null || (SNOW.test(id) && kinds.includes(ctx.guild.channels.cache.get(id)?.type));
      const { ChannelType } = require('discord.js');
      const FORUM = [ChannelType.GuildForum, ChannelType.GuildMedia], TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
      if ('timezone' in b) { if (DateTime.now().setZone(String(b.timezone)).isValid) patch.timezone = String(b.timezone); else bad.push('Unknown timezone.'); }
      if ('currency' in b) patch.currency = clean(b.currency, 3) || '$';
      for (const k of ['show_r', 'weekly_enabled', 'month_enabled']) if (k in b) patch[k] = !!b[k];
      if ('weekly_day' in b) { const n = Number(b.weekly_day); if (n >= 1 && n <= 7) patch.weekly_day = n; else bad.push('Weekly day must be 1 to 7.'); }
      for (const k of ['weekly_time', 'month_time']) if (k in b) { if (TIME.test(b[k])) patch[k] = b[k]; else bad.push('Times are 24h, like 17:00.'); }
      if ('theme' in b) { if (['light', 'dark', 'auto'].includes(b.theme)) patch.theme = b.theme; else bad.push('Unknown theme.'); }
      if ('session' in b) {
        if (PRESETS[b.session]) Object.assign(patch, { session_start: PRESETS[b.session].start, session_zone: PRESETS[b.session].zone || s.session_zone, session_fold: PRESETS[b.session].fold });
        else if (TIME.test(b.session_start || '')) Object.assign(patch, { session_start: b.session_start, session_fold: !!b.session_fold });
        else bad.push('Pick a session or a start time like 18:00.');
      }
      if ('report_channel_id' in b) { const v = b.report_channel_id || null; if (chanOk(v, TEXT)) patch.report_channel_id = v; else bad.push('Pick a text channel for reports.'); }
      if ('default_forum_id' in b) { const v = b.default_forum_id || null; if (chanOk(v, FORUM)) patch.default_forum_id = v; else bad.push('Pick a forum.'); }
      if ('ping_role_id' in b) { const v = b.ping_role_id || null; if (v === null || ctx.guild.roles.cache.has(v)) patch.ping_role_id = v; else bad.push('Unknown role.'); }
      if ('forums' in b) { const v = (Array.isArray(b.forums) ? b.forums : []).filter((id) => chanOk(id, FORUM)).slice(0, 25); patch.forums = v; }
      if ('outcome_forums' in b) {
        const next = { ...s.outcome_forums }, threads = { ...s.outcome_threads };
        for (const o of Object.keys(OUTCOMES)) if (o in (b.outcome_forums || {})) {
          const v = b.outcome_forums[o] || null;
          if (!chanOk(v, FORUM)) { bad.push(`Pick a forum for ${OUTCOMES[o].label}.`); continue; }
          next[o] = v; threads[o] = null;   // a forum means a new post each time; an existing post is picked in Discord
        }
        patch.outcome_forums = next; patch.outcome_threads = threads;
      }
      if (bad.length) return fail(res, 400, 'invalid', bad.join(' '));
      db.saveSettings(gid, patch);
      return json(res, 200, { ok: true, ...data.settingsView(ctx.guild, db.getSettings(gid)) });
    }
    if (area === 'action' && req.method === 'POST') {
      const ctx = await guildCtx(req, res, gid, { manage: true }); if (!ctx) return;
      const { scanGuild, summaryText } = require('../lib/scanner');
      if (a1 === 'rescan') return json(res, 200, { ok: true, summary: summaryText(await scanGuild(ctx.guild, ctx.settings, { force: true })) });
      if (a1 === 'health') { const { healthCheck } = require('../lib/permissions'); return json(res, 200, { ok: true, lines: await healthCheck(ctx.guild, ctx.settings) }); }
      if (a1 === 'post') {
        const body = await readBody(req), r = require('../lib/reports');
        if (!ctx.settings.report_channel_id) return fail(res, 400, 'no_channel', 'Pick a report channel first.');
        const channel = await ctx.guild.channels.fetch(ctx.settings.report_channel_id).catch(() => null);
        if (!channel) return fail(res, 400, 'no_channel', 'The report channel no longer exists.');
        const d = DATE.test(body.date || '') ? body.date : todayFor(ctx.settings);
        const img = body.kind === 'day' ? r.dailyImage(gid, d, ctx.settings) : body.kind === 'month' ? r.monthlyImage(gid, Number(d.slice(0, 4)), Number(d.slice(5, 7)), ctx.settings) : r.weeklyImage(gid, d, ctx.settings);
        await r.sendReport(channel, img, ctx.settings);
        return json(res, 200, { ok: true, channel: channel.name });
      }
      if (a1 === 'redate-plan') {
        const { planRedate } = require('../lib/redate');
        const plan = planRedate(gid, ctx.settings);
        return json(res, 200, { ok: true, count: plan.length, moves: plan.slice(-12).map((x) => ({ instrument: x.entry.instrument, pnl: (x.fields.pnl_cents ?? x.entry.pnl_cents ?? 0) / 100, from: x.from, to: x.to, why: x.why })) });
      }
      if (a1 === 'redate') {
        const { planRedate, applyRedate } = require('../lib/redate');
        const plan = planRedate(gid, ctx.settings);
        const id = crypto.randomBytes(9).toString('base64url'), job = { kind: 'redate', gid, uid: ctx.session.uid, at: Date.now(), state: 'running', done: 0, total: Math.min(plan.length, 300) };
        jobs.set(id, job);
        applyRedate(ctx.guild, ctx.settings, plan, async (d) => { job.done = d; })
          .then(async (r) => { job.result = r; job.state = 'done'; const { scanGuild } = require('../lib/scanner'); await scanGuild(ctx.guild, db.getSettings(gid)).catch(() => {}); })
          .catch((e) => { job.state = 'failed'; job.error = e.message; });
        return json(res, 200, { id, state: 'running', total: job.total });
      }
      return fail(res, 404, 'no_action');
    }
    return fail(res, 404, 'not_found');
  };

  function slim(t) { return { instrument: t.instrument, direction: t.direction, outcome: t.outcome, pnl: t.pnl_cents / 100, date: t.date, qty: t.qty, held: t.held, entry: t.entry, exit: t.exit }; }
  function cum(list) { let r = 0; return list.map((t) => (r += t.pnl_cents / 100)); }

  async function runImport(ctx, job) {
    const { toFields } = require('../lib/csv-import');
    const { postJournal } = require('../lib/poster');
    const { routeTarget } = require('../lib/routing');
    const keysOf = (t) => t.keys || [t.hash];
    const already = db.importedHashes(ctx.guild.id, job.queue.flatMap(keysOf));
    for (const t of job.queue) {
      const target = routeTarget(ctx.settings, t.outcome);
      if (!target || keysOf(t).some((k) => already.has(k))) { job.done += 1; continue; }
      try {
        const { messageId } = await postJournal({ guild: ctx.guild, settings: ctx.settings, draft: { userId: job.uid, outcome: t.outcome, forumId: target.forumId, image: null,
          fields: { ...toFields(t, { tag: job.tag }), ...(target.threadId ? { _thread: target.threadId } : {}) } } });
        db.markImported(ctx.guild.id, keysOf(t), messageId);
        job.result[t.outcome] += 1; job.result.net += t.pnl_cents / 100;
      } catch (e) { job.result.failed.push(`${t.instrument} ${t.date}: ${e.message}`.slice(0, 120)); }
      job.done += 1; job.last = `${t.instrument} ${t.date}`;
    }
    const posted = job.result.win + job.result.loss + job.result.be;
    if (posted) db.recordImportRun(ctx.guild.id, { count: posted, lastTradeAt: Math.max(...job.queue.map((t) => t.at)), file: job.file });
    job.state = 'done';
  }
};
