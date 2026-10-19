'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `jt-${Date.now()}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, parseR, applyOutcomeSign, formatCents, formatDollars, formatShort, formatR, parseDateInput } = require('../src/lib/money');
const { buildPostBody, threadTitle } = require('../src/lib/format');
const { parseText, resolveEntry, tagToOutcome } = require('../src/lib/parse');
const db = require('../src/lib/db');
const { weekData, monthData, dayData } = require('../src/lib/pnl');

test('money parsing', () => {
  assert.equal(parseMoney('1,250.50'), 125050);
  assert.equal(parseMoney('$1250'), 125000);
  assert.equal(parseMoney('-$480'), -48000);
  assert.equal(parseMoney('\u2212480'), -48000);
  assert.equal(parseMoney('+1250'), 125000);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('12.345'), null);
  assert.equal(parseR('+2.5R'), 2.5);
  assert.equal(parseR('-1r'), -1);
  assert.equal(parseR(''), null);
  assert.ok(Number.isNaN(parseR('x')));
});
test('sign rules', () => {
  assert.equal(applyOutcomeSign('loss', 48000), -48000);
  assert.equal(applyOutcomeSign('win', -100), 100);
  assert.equal(applyOutcomeSign('missed', 999), 0);
  assert.equal(applyOutcomeSign('be', 1200), 1200);
});
test('formatting', () => {
  assert.equal(formatCents(125000), '+$1,250');
  assert.equal(formatCents(-48050), '-$480.50');
  assert.equal(formatCents(0), '$0');
  assert.equal(formatDollars(-480), '\u2212$480');
  assert.equal(formatShort(124000), '+$124.0k');
  assert.equal(formatR(2.5, 'win'), '+2.5R');
  assert.equal(formatR(1, 'loss'), '-1R');
});
test('dates', () => {
  assert.equal(parseDateInput('2026-10-16', 'America/New_York'), '2026-10-16');
  assert.equal(parseDateInput('16 Oct 2026', 'America/New_York'), '2026-10-16');
  assert.equal(parseDateInput('Oct 16, 2026', 'America/New_York'), '2026-10-16');
  assert.equal(parseDateInput('nonsense', 'America/New_York'), null);
});

const base = { instrument: 'NQ', direction: 'Long', date: '2026-10-16', session: 'NY AM', setup: 'HTF sweep \u2192 CISD', entry: '24100', stop: '24060', target: '24200', exit: '24100', why: 'Clean sweep', p1: 'Waited', p2: 'Sized right', lesson: 'Stay patient', followed: 'YES', r: 2.5 };
test('post body round-trips through the parser (all four outcomes)', () => {
  const cases = [['win', 125000], ['loss', -48000], ['be', 0], ['missed', 0]];
  for (const [o, cents] of cases) {
    const body = buildPostBody(o, { ...base, pnl_cents: cents, potential_cents: o === 'missed' ? 90000 : null, r: o === 'loss' ? -1 : 2.5 }, { emoji: '<:x:1>' });
    const p = parseText(body);
    assert.equal(p.outcome, o, `outcome ${o}`);
    assert.equal(p.pnlCents, cents, `pnl ${o}\n${body}`);
    assert.equal(p.dateISO, '2026-10-16');
    if (o === 'missed') assert.equal(p.potentialCents, 90000);
    const r = resolveEntry(p, { createdMs: Date.now(), tz: 'America/New_York' });
    assert.equal(r.pnl_cents, cents);
  }
});
test('win body matches the agreed format', () => {
  const b = buildPostBody('win', { ...base, pnl_cents: 125000 }, { emoji: ':ywin:' });
  assert.match(b, /^# :ywin: WIN \u00b7 NQ Long\n-# 16 Oct 2026 \u00b7 NY AM\n\n> \*\*Setup\*\* \u00b7 HTF sweep/);
  assert.match(b, /```diff\n\+ RESULT: \+2.5R\n\+ PNL: \+\$1,250\n\+ Followed plan: YES\n```/);
  assert.match(b, /### \u{1F9E0} Lesson\n\|\|Stay patient\|\|$/u);
  assert.ok(b.length < 3000);
});
test('parser handles manual / messy posts', () => {
  assert.equal(parseText('PNL: -$480.25').pnlCents, -48025);
  assert.equal(parseText('+ PNL: +1,250').pnlCents, 125000);
  assert.equal(parseText('- PNL: 480').pnlCents, -48000);
  assert.equal(parseText('PNL = \u2212$90').pnlCents, -9000);
  assert.equal(parseText('nothing here').pnlCents, null);
  assert.equal(resolveEntry(parseText('nothing here'), { createdMs: 0, tz: 'UTC' }), null);
  assert.equal(resolveEntry(parseText('PNL: 480'), { tagOutcome: 'loss', createdMs: 0, tz: 'UTC' }).pnl_cents, -48000);
  assert.equal(tagToOutcome('Breakeven'), 'be');
  assert.equal(tagToOutcome('WIN'), 'win');
  assert.equal(tagToOutcome('random'), null);
});
test('thread title', () => {
  assert.equal(threadTitle('win', { ...base, pnl_cents: 125000 }), 'WIN \u00b7 NQ Long \u00b7 +$1,250 \u00b7 16 Oct');
  assert.equal(threadTitle('missed', { ...base, pnl_cents: 0 }), 'MISSED \u00b7 NQ Long \u00b7 16 Oct');
});

function put(i, date, outcome, cents, forum = 'f1') {
  db.upsertPnl({ thread_id: `t${i}`, guild_id: 'g', forum_id: forum, outcome, pnl_cents: cents, date_local: date });
}
test('week aggregation (Mon-Fri cards, weekend folded into total)', () => {
  put(1, '2026-10-12', 'win', 100000); put(2, '2026-10-12', 'loss', -20000); put(3, '2026-10-13', 'loss', -48000);
  put(4, '2026-10-14', 'be', 0); put(5, '2026-10-15', 'win', 215000); put(6, '2026-10-15', 'missed', 0);
  put(7, '2026-10-17', 'win', 30000); // Saturday
  const w = weekData('g', '2026-10-16', 'America/New_York');
  assert.equal(w.rangeLabel, 'OCT 12 \u2013 16, 2026');
  assert.equal(w.days[0].pnl, 800); assert.equal(w.days[0].trades, 2); assert.equal(w.days[0].w, 1); assert.equal(w.days[0].l, 1);
  assert.equal(w.days[1].pnl, -480); assert.equal(w.days[2].be, 1); assert.equal(w.days[3].missed, 1);
  assert.equal(w.weekend.pnl, 300);
  assert.equal(w.total, 800 - 480 + 0 + 2150 + 300);
  assert.equal(w.trades, 6); assert.equal(w.missed, 1);
  assert.equal(w.best.day, 'THU');
  assert.equal(weekData('g', '2026-10-12', 'America/New_York').start, '2026-10-12');
  assert.equal(weekData('g', '2026-10-18', 'America/New_York').start, '2026-10-12'); // Sunday -> same week
  const e = weekData('g', '2026-11-02', 'America/New_York');
  assert.equal(e.total, 0); assert.equal(e.trades, 0);
});
test('month aggregation and week spanning two months', () => {
  put(20, '2026-09-30', 'win', 50000); put(21, '2026-10-01', 'loss', -10000); put(22, '2026-10-30', 'win', 70000);
  const m = monthData('g', 2026, 10, 'America/New_York');
  assert.equal(m.data[1].pnl, -100); assert.equal(m.data[30].pnl, 700); assert.equal(m.data[30].trades, 1);
  assert.equal(m.data[30].w, 1);
  assert.equal(m.monthLabel, 'OCTOBER 2026');
  const sep = monthData('g', 2026, 9, 'America/New_York');
  assert.equal(sep.total, 500);
  const w = weekData('g', '2026-10-01', 'America/New_York'); // week Sep 28 - Oct 2 spans months
  assert.equal(w.rangeLabel, 'SEP 28 \u2013 OCT 2, 2026');
  assert.equal(w.total, 400);
});
test('report claims are idempotent with retry cap', () => {
  assert.equal(db.claimReport('g', 'weekly', '2026-W42'), true);
  assert.equal(db.claimReport('g', 'weekly', '2026-W42'), false); // pending
  db.finishReport('g', 'weekly', '2026-W42', { error: 'x' });
  assert.equal(db.claimReport('g', 'weekly', '2026-W42'), true);  // retry 2
  db.finishReport('g', 'weekly', '2026-W42', { error: 'x' });
  assert.equal(db.claimReport('g', 'weekly', '2026-W42'), true);  // retry 3
  db.finishReport('g', 'weekly', '2026-W42', { error: 'x' });
  assert.equal(db.claimReport('g', 'weekly', '2026-W42'), false); // capped
  assert.equal(db.claimReport('g', 'weekly', '2026-W43'), true);
  db.finishReport('g', 'weekly', '2026-W43', { messageId: '1' });
  assert.equal(db.claimReport('g', 'weekly', '2026-W43'), false); // posted
});
test('settings persist', () => {
  assert.equal(db.getSettings('x').weekly_day, 5);
  const s = db.saveSettings('x', { forums: ['1', '2'], weekly_day: 4, weekly_time: '16:30', weekly_enabled: false });
  assert.deepEqual(s.forums, ['1', '2']); assert.equal(s.weekly_enabled, false);
  assert.equal(db.getSettings('x').weekly_time, '16:30');
  assert.equal(db.getSettings('x').month_enabled, true);
});
test('drafts expire and persist', () => {
  const d = db.createDraft({ userId: 'u', guildId: 'g', forumId: 'f' });
  d.outcome = 'win'; d.fields.instrument = 'NQ'; db.saveDraft(d);
  assert.equal(db.getDraft(d.id).fields.instrument, 'NQ');
  db.db.prepare('UPDATE journal_drafts SET expires_at = 1 WHERE draft_id = ?').run(d.id);
  assert.equal(db.getDraft(d.id), null);
});

test('dayData: one day, its trades in order, totals and the week around it', () => {
  db.upsertPnl({ thread_id: 'd1', container_id: 'd1', guild_id: 'gd', forum_id: 'F', outcome: 'win', pnl_cents: 125000, date_local: '2026-10-15', updated_at: 1 });
  db.upsertPnl({ thread_id: 'd2', container_id: 'd2', guild_id: 'gd', forum_id: 'F', outcome: 'loss', pnl_cents: -31000, date_local: '2026-10-15', updated_at: 2 });
  db.upsertPnl({ thread_id: 'd3', container_id: 'd3', guild_id: 'gd', forum_id: 'F', outcome: 'missed', pnl_cents: 0, potential_cents: 90000, date_local: '2026-10-15', updated_at: 3 });
  db.upsertPnl({ thread_id: 'd4', container_id: 'd4', guild_id: 'gd', forum_id: 'F', outcome: 'win', pnl_cents: 5000, date_local: '2026-10-13', updated_at: 4 });
  const d = dayData('gd', '2026-10-15', 'America/New_York');
  assert.equal(d.weekday, 'Thursday'); assert.equal(d.dateLabel, 'OCT 15, 2026');
  assert.equal(d.total, 940); assert.equal(d.count, 2); assert.equal(d.w, 1); assert.equal(d.l, 1); assert.equal(d.missed, 1);
  assert.deepEqual(d.trades.map((t) => t.key), ['d1', 'd2', 'd3']);
  assert.equal(d.trades[2].potential, 900); assert.equal(d.best.key, 'd1');
  assert.equal(d.week.length, 5); assert.equal(d.week.find((x) => x.today).day, 'THU'); assert.equal(d.weekTotal, 990);
  const empty = dayData('gd', '2026-10-17', 'America/New_York');
  assert.equal(empty.count, 0); assert.equal(empty.trades.length, 0); assert.equal(empty.winRate, null);
});
