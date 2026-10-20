'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.JOURNAL_DB_PATH || path.join(process.cwd(), 'data', 'journal.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Additive, idempotent migrations (all tables prefixed so they never collide with existing bot tables).
db.exec(`
CREATE TABLE IF NOT EXISTS journal_settings (
  guild_id TEXT PRIMARY KEY,
  forums_json TEXT NOT NULL DEFAULT '[]',
  default_forum_id TEXT,
  report_channel_id TEXT,
  weekly_day INTEGER NOT NULL DEFAULT 5,
  weekly_time TEXT NOT NULL DEFAULT '17:00',
  weekly_enabled INTEGER NOT NULL DEFAULT 1,
  month_enabled INTEGER NOT NULL DEFAULT 1,
  month_time TEXT NOT NULL DEFAULT '17:00',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  currency TEXT NOT NULL DEFAULT '$',
  show_r INTEGER NOT NULL DEFAULT 1,
  ping_role_id TEXT,
  allowed_users_json TEXT NOT NULL DEFAULT '[]',
  outcome_forums_json TEXT NOT NULL DEFAULT '{}',
  outcome_threads_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS journal_drafts (
  draft_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  outcome TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  forum_id TEXT,
  image_json TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  instrument TEXT, direction TEXT, session TEXT, setup TEXT,
  entry TEXT, stop TEXT, target TEXT, exit TEXT,
  r_multiple REAL,
  pnl_cents INTEGER NOT NULL DEFAULT 0,
  potential_cents INTEGER,
  followed_plan TEXT,
  fields_json TEXT,
  date_local TEXT NOT NULL,
  forum_id TEXT, thread_id TEXT, message_id TEXT, image_name TEXT,
  created_at INTEGER NOT NULL
);
-- thread_id is the entry key: the post id for a one-trade-per-post entry, or the message id for a trade logged inside an existing post.
-- container_id is the post (thread) the entry lives in.
CREATE TABLE IF NOT EXISTS pnl_entries (
  thread_id TEXT PRIMARY KEY,
  container_id TEXT,
  guild_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  pnl_cents INTEGER NOT NULL DEFAULT 0,
  potential_cents INTEGER,
  date_local TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scan',
  content_hash TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pnl_guild_date ON pnl_entries (guild_id, date_local);
CREATE TABLE IF NOT EXISTS report_log (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  period_key TEXT NOT NULL,
  message_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  posted_at INTEGER,
  error TEXT,
  UNIQUE (guild_id, kind, period_key)
);
`);

// Additive migration: databases created before per-outcome forums existed
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
if (!hasCol('journal_settings', 'outcome_forums_json')) db.exec("ALTER TABLE journal_settings ADD COLUMN outcome_forums_json TEXT NOT NULL DEFAULT '{}'");
if (!hasCol('journal_settings', 'outcome_threads_json')) db.exec("ALTER TABLE journal_settings ADD COLUMN outcome_threads_json TEXT NOT NULL DEFAULT '{}'");
if (!hasCol('journal_settings', 'theme')) db.exec("ALTER TABLE journal_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
if (!hasCol('pnl_entries', 'container_id')) db.exec('ALTER TABLE pnl_entries ADD COLUMN container_id TEXT');
db.exec('UPDATE pnl_entries SET container_id = thread_id WHERE container_id IS NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_pnl_container ON pnl_entries (container_id)');
// CSV imports: one row per trade already imported, so a file can be dropped twice safely
db.exec('CREATE TABLE IF NOT EXISTS journal_imports (guild_id TEXT NOT NULL, hash TEXT NOT NULL, message_id TEXT, imported_at INTEGER NOT NULL, PRIMARY KEY (guild_id, hash))');
db.exec('CREATE TABLE IF NOT EXISTS journal_import_runs (guild_id TEXT NOT NULL, at INTEGER NOT NULL, count INTEGER NOT NULL, last_trade_at INTEGER, file TEXT)');
/*
 * Trading accounts. Each row is one run of one account: an evaluation attempt, or the funded phase
 * that followed it. Rows of the same journey share chain_id, so "Eval #1 breached, Eval #2 passed,
 * Funded" reads as one story. Money is in cents; rules left NULL are off.
 */
db.exec(`CREATE TABLE IF NOT EXISTS journal_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, chain_id INTEGER, name TEXT NOT NULL, firm TEXT,
  phase TEXT NOT NULL DEFAULT 'eval', status TEXT NOT NULL DEFAULT 'active', attempt INTEGER NOT NULL DEFAULT 1,
  size_cents INTEGER NOT NULL DEFAULT 0, start_balance_cents INTEGER NOT NULL DEFAULT 0, balance_adj_cents INTEGER NOT NULL DEFAULT 0,
  target_cents INTEGER, daily_loss_cents INTEGER, max_dd_cents INTEGER, dd_type TEXT NOT NULL DEFAULT 'trailing',
  min_days INTEGER, consistency_pct INTEGER, split_pct INTEGER,
  started_on TEXT NOT NULL, ended_on TEXT, ended_reason TEXT, created_at INTEGER NOT NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_guild ON journal_accounts (guild_id)');
db.exec('CREATE TABLE IF NOT EXISTS journal_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, account_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, date TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL)');
// one row per alert or milestone already announced, so a channel never hears the same warning twice
db.exec('CREATE TABLE IF NOT EXISTS journal_account_events (account_id INTEGER NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (account_id, kind, period))');
if (!hasCol('pnl_entries', 'account_id')) db.exec('ALTER TABLE pnl_entries ADD COLUMN account_id INTEGER');
if (!hasCol('journal_settings', 'default_account_id')) db.exec('ALTER TABLE journal_settings ADD COLUMN default_account_id INTEGER');
if (!hasCol('journal_settings', 'alert_channel_id')) db.exec('ALTER TABLE journal_settings ADD COLUMN alert_channel_id TEXT');

const DEFAULTS = {
  forums: [], default_forum_id: null, report_channel_id: null,
  weekly_day: 5, weekly_time: '17:00', weekly_enabled: true,
  month_enabled: true, month_time: '17:00',
  timezone: 'America/New_York', currency: '$', show_r: true,
  ping_role_id: null, allowed_users: [], outcome_forums: {}, outcome_threads: {}, theme: 'light',
  default_account_id: null, alert_channel_id: null,
};
const THEMES = ['light', 'dark', 'auto'];

function rowToSettings(guildId, r) {
  if (!r) return { guild_id: guildId, ...DEFAULTS };
  return {
    guild_id: guildId,
    forums: JSON.parse(r.forums_json || '[]'),
    default_forum_id: r.default_forum_id, report_channel_id: r.report_channel_id,
    weekly_day: r.weekly_day, weekly_time: r.weekly_time, weekly_enabled: !!r.weekly_enabled,
    month_enabled: !!r.month_enabled, month_time: r.month_time,
    timezone: r.timezone, currency: r.currency, show_r: !!r.show_r,
    ping_role_id: r.ping_role_id, allowed_users: JSON.parse(r.allowed_users_json || '[]'),
    outcome_forums: JSON.parse(r.outcome_forums_json || '{}'),
    outcome_threads: JSON.parse(r.outcome_threads_json || '{}'),
    theme: THEMES.includes(r.theme) ? r.theme : 'light',
    default_account_id: r.default_account_id ?? null, alert_channel_id: r.alert_channel_id ?? null,
  };
}

function getSettings(guildId) {
  return rowToSettings(guildId, db.prepare('SELECT * FROM journal_settings WHERE guild_id = ?').get(guildId));
}

function saveSettings(guildId, patch) {
  const cur = getSettings(guildId);
  const n = { ...cur, ...patch };
  db.prepare(`INSERT INTO journal_settings
    (guild_id, forums_json, default_forum_id, report_channel_id, weekly_day, weekly_time, weekly_enabled,
     month_enabled, month_time, timezone, currency, show_r, ping_role_id, allowed_users_json, outcome_forums_json, outcome_threads_json, theme, default_account_id, alert_channel_id)
    VALUES (@guild_id,@forums_json,@default_forum_id,@report_channel_id,@weekly_day,@weekly_time,@weekly_enabled,
     @month_enabled,@month_time,@timezone,@currency,@show_r,@ping_role_id,@allowed_users_json,@outcome_forums_json,@outcome_threads_json,@theme,@default_account_id,@alert_channel_id)
    ON CONFLICT(guild_id) DO UPDATE SET forums_json=excluded.forums_json, default_forum_id=excluded.default_forum_id,
     report_channel_id=excluded.report_channel_id, weekly_day=excluded.weekly_day, weekly_time=excluded.weekly_time,
     weekly_enabled=excluded.weekly_enabled, month_enabled=excluded.month_enabled, month_time=excluded.month_time,
     timezone=excluded.timezone, currency=excluded.currency, show_r=excluded.show_r, ping_role_id=excluded.ping_role_id,
     allowed_users_json=excluded.allowed_users_json, outcome_forums_json=excluded.outcome_forums_json, outcome_threads_json=excluded.outcome_threads_json, theme=excluded.theme,
     default_account_id=excluded.default_account_id, alert_channel_id=excluded.alert_channel_id`).run({
    guild_id: guildId, forums_json: JSON.stringify(n.forums || []), default_forum_id: n.default_forum_id ?? null,
    report_channel_id: n.report_channel_id ?? null, weekly_day: n.weekly_day, weekly_time: n.weekly_time,
    weekly_enabled: n.weekly_enabled ? 1 : 0, month_enabled: n.month_enabled ? 1 : 0, month_time: n.month_time,
    timezone: n.timezone, currency: n.currency, show_r: n.show_r ? 1 : 0, ping_role_id: n.ping_role_id ?? null,
    allowed_users_json: JSON.stringify(n.allowed_users || []),
    outcome_forums_json: JSON.stringify(Object.fromEntries(Object.entries(n.outcome_forums || {}).filter(([, v]) => v))),
    outcome_threads_json: JSON.stringify(Object.fromEntries(Object.entries(n.outcome_threads || {}).filter(([, v]) => v && v.thread))),
    theme: THEMES.includes(n.theme) ? n.theme : 'light',
    default_account_id: n.default_account_id ?? null, alert_channel_id: n.alert_channel_id ?? null,
  });
  return getSettings(guildId);
}

function listConfiguredGuilds() {
  return db.prepare('SELECT guild_id FROM journal_settings').all().map((r) => r.guild_id);
}

/* ---------------- drafts ---------------- */
const DRAFT_TTL_MS = 15 * 60 * 1000;
function newDraftId() { return Math.random().toString(36).slice(2, 10); }

function createDraft({ userId, guildId, forumId, image }) {
  const id = newDraftId();
  db.prepare(`INSERT INTO journal_drafts (draft_id,user_id,guild_id,outcome,fields_json,forum_id,image_json,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, userId, guildId, null, '{}', forumId || null, image ? JSON.stringify(image) : null, Date.now() + DRAFT_TTL_MS);
  return getDraft(id);
}
function getDraft(id) {
  const r = db.prepare('SELECT * FROM journal_drafts WHERE draft_id = ?').get(id);
  if (!r) return null;
  if (r.expires_at < Date.now()) { deleteDraft(id); return null; }
  return { id: r.draft_id, userId: r.user_id, guildId: r.guild_id, outcome: r.outcome,
    fields: JSON.parse(r.fields_json), forumId: r.forum_id, image: r.image_json ? JSON.parse(r.image_json) : null };
}
function saveDraft(d) {
  db.prepare('UPDATE journal_drafts SET outcome=?, fields_json=?, forum_id=?, image_json=?, expires_at=? WHERE draft_id=?')
    .run(d.outcome, JSON.stringify(d.fields), d.forumId, d.image ? JSON.stringify(d.image) : null, Date.now() + DRAFT_TTL_MS, d.id);
}
function deleteDraft(id) { db.prepare('DELETE FROM journal_drafts WHERE draft_id = ?').run(id); }
function purgeDrafts() { db.prepare('DELETE FROM journal_drafts WHERE expires_at < ?').run(Date.now()); }

/* ---------------- entries / pnl cache ---------------- */
function insertEntry(e) {
  return db.prepare(`INSERT INTO journal_entries
    (guild_id,user_id,outcome,instrument,direction,session,setup,entry,stop,target,exit,r_multiple,pnl_cents,potential_cents,
     followed_plan,fields_json,date_local,forum_id,thread_id,message_id,image_name,created_at)
    VALUES (@guild_id,@user_id,@outcome,@instrument,@direction,@session,@setup,@entry,@stop,@target,@exit,@r_multiple,@pnl_cents,
     @potential_cents,@followed_plan,@fields_json,@date_local,@forum_id,@thread_id,@message_id,@image_name,@created_at)`).run(e);
}
function upsertPnl(e) {
  db.prepare(`INSERT INTO pnl_entries (thread_id,container_id,guild_id,forum_id,outcome,pnl_cents,potential_cents,date_local,source,content_hash,updated_at)
    VALUES (@thread_id,@container_id,@guild_id,@forum_id,@outcome,@pnl_cents,@potential_cents,@date_local,@source,@content_hash,@updated_at)
    ON CONFLICT(thread_id) DO UPDATE SET container_id=excluded.container_id, guild_id=excluded.guild_id, forum_id=excluded.forum_id, outcome=excluded.outcome,
     pnl_cents=excluded.pnl_cents, potential_cents=excluded.potential_cents, date_local=excluded.date_local,
     source=excluded.source, content_hash=excluded.content_hash, updated_at=excluded.updated_at`)
    .run({ potential_cents: null, content_hash: null, source: 'scan', container_id: e.thread_id, ...e, updated_at: Date.now() });
}
function getPnlEntry(threadId) { return db.prepare('SELECT * FROM pnl_entries WHERE thread_id = ?').get(threadId); }
function deletePnl(threadId) { return db.prepare('DELETE FROM pnl_entries WHERE thread_id = ?').run(threadId).changes; }
/**
 * PnL rows in a date range. accountId (optional) keeps one account's trades: a trade belongs to the
 * account it was tagged with, and untagged trades (typed by hand, or logged before accounts existed)
 * belong to the server's default account.
 */
function pnlBetween(guildId, startISO, endISO, accountId = null) {
  if (accountId === null || accountId === undefined || accountId === 'all') {
    return db.prepare('SELECT * FROM pnl_entries WHERE guild_id=? AND date_local>=? AND date_local<=? ORDER BY date_local').all(guildId, startISO, endISO);
  }
  return db.prepare(`SELECT * FROM pnl_entries WHERE guild_id=? AND date_local>=? AND date_local<=?
    AND COALESCE(account_id, (SELECT default_account_id FROM journal_settings WHERE guild_id=?)) = ? ORDER BY date_local`).all(guildId, startISO, endISO, guildId, Number(accountId));
}
/** tags one trade (by its PnL key) with an account; null puts it back on the default account */
function setTradeAccount(key, accountId) { db.prepare('UPDATE pnl_entries SET account_id = ? WHERE thread_id = ?').run(accountId ?? null, key); }
function tradeAccountOf(key) { return db.prepare('SELECT account_id FROM pnl_entries WHERE thread_id = ?').get(key)?.account_id ?? null; }

/* ---------------- accounts ---------------- */
const ACCOUNT_COLS = ['chain_id', 'name', 'firm', 'phase', 'status', 'attempt', 'size_cents', 'start_balance_cents', 'balance_adj_cents', 'target_cents',
  'daily_loss_cents', 'max_dd_cents', 'dd_type', 'min_days', 'consistency_pct', 'split_pct', 'started_on', 'ended_on', 'ended_reason'];
function createAccount(guildId, a) {
  const row = { chain_id: null, firm: null, phase: 'eval', status: 'active', attempt: 1, size_cents: 0, start_balance_cents: a.size_cents || 0, balance_adj_cents: 0,
    target_cents: null, daily_loss_cents: null, max_dd_cents: null, dd_type: 'trailing', min_days: null, consistency_pct: null, split_pct: null,
    ended_on: null, ended_reason: null, ...a };
  const info = db.prepare(`INSERT INTO journal_accounts (guild_id, ${ACCOUNT_COLS.join(', ')}, created_at)
    VALUES (@guild_id, ${ACCOUNT_COLS.map((c) => `@${c}`).join(', ')}, @created_at)`).run({ ...row, guild_id: guildId, created_at: Date.now() });
  const id = Number(info.lastInsertRowid);
  if (!row.chain_id) db.prepare('UPDATE journal_accounts SET chain_id = ? WHERE id = ?').run(id, id);
  return getAccount(id);
}
function getAccount(id) { return db.prepare('SELECT * FROM journal_accounts WHERE id = ?').get(Number(id)) || null; }
function updateAccount(id, patch) {
  const keys = Object.keys(patch).filter((k) => ACCOUNT_COLS.includes(k));
  if (keys.length) db.prepare(`UPDATE journal_accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: Number(id) });
  return getAccount(id);
}
/** the server's accounts: active ones first, then the finished runs, newest first */
function listAccounts(guildId, { includeEnded = true } = {}) {
  return db.prepare(`SELECT * FROM journal_accounts WHERE guild_id = ? ${includeEnded ? '' : "AND status = 'active'"}
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'passed' THEN 1 WHEN 'breached' THEN 2 ELSE 3 END, created_at DESC`).all(guildId);
}
function chainOf(account) { return db.prepare('SELECT * FROM journal_accounts WHERE chain_id = ? ORDER BY created_at, id').all(account.chain_id || account.id); }
/** every PnL row that counts for one account run, from the day it started (to the day it ended) */
function accountRows(account, settingsDefaultId) {
  const isDefault = Number(settingsDefaultId) === Number(account.id);
  return db.prepare(`SELECT * FROM pnl_entries WHERE guild_id = ? AND date_local >= ? AND date_local <= ?
    AND (account_id = ? ${isDefault ? 'OR account_id IS NULL' : ''}) ORDER BY date_local`).all(account.guild_id, account.started_on, account.ended_on || '9999-12-31', account.id);
}
function addPayout(account, amountCents, date, note) {
  db.prepare('INSERT INTO journal_payouts (guild_id, account_id, amount_cents, date, note, created_at) VALUES (?,?,?,?,?,?)').run(account.guild_id, account.id, amountCents, date, note || null, Date.now());
}
function payoutsOf(accountId) { return db.prepare('SELECT * FROM journal_payouts WHERE account_id = ? ORDER BY date, id').all(Number(accountId)); }
/**
 * Makes another account the default. Untagged trades belong to whichever account is the default, so
 * the old default's untagged trades are pinned to it first: switching never moves history between accounts.
 */
function setDefaultAccount(guildId, accountId) {
  const old = getSettings(guildId).default_account_id;
  if (old && Number(old) !== Number(accountId)) {
    const a = getAccount(old);
    if (a) db.prepare('UPDATE pnl_entries SET account_id = ? WHERE guild_id = ? AND account_id IS NULL AND date_local >= ? AND date_local <= ?')
      .run(a.id, guildId, a.started_on, a.ended_on || '9999-12-31');
  }
  return saveSettings(guildId, { default_account_id: accountId ?? null });
}
/** the periods recorded for one kind of account event, e.g. the breaches marked "not a breach" */
function accountEventPeriods(accountId, kind) { return db.prepare('SELECT period FROM journal_account_events WHERE account_id = ? AND kind = ?').all(Number(accountId), kind).map((r) => r.period); }
/** true the first time an alert / milestone is claimed for this account and period */
function claimAccountEvent(accountId, kind, period) {
  return db.prepare('INSERT OR IGNORE INTO journal_account_events (account_id, kind, period, at) VALUES (?,?,?,?)').run(Number(accountId), kind, period, Date.now()).changes > 0;
}
/**
 * The journal details (instrument, direction, R, when it was logged) behind
 * each PnL key, for the daily card. A key is a message id (a trade inside an
 * existing post) or a post id (one trade per post). Trades typed by hand have
 * no journal_entries row and simply come back without details.
 */
function entryDetailsFor(keys) {
  const byMsg = db.prepare('SELECT instrument, direction, r_multiple, session, setup, entry, exit, fields_json, created_at FROM journal_entries WHERE message_id = ? ORDER BY created_at DESC LIMIT 1');
  const byThread = db.prepare('SELECT instrument, direction, r_multiple, session, setup, entry, exit, fields_json, created_at FROM journal_entries WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1');
  const out = {};
  for (const k of keys) { const r = byMsg.get(k) || byThread.get(k); if (r) out[k] = r; }
  return out;
}
/** which of these trade keys this server already imported (a trade is a match if any of its keys is) */
function importedHashes(guildId, hashes) {
  const q = db.prepare('SELECT 1 FROM journal_imports WHERE guild_id = ? AND hash = ?');
  return new Set(hashes.filter((h) => q.get(guildId, h)));
}
/** remembers a trade under every identity key, so a reworded re-export still matches */
function markImported(guildId, keys, messageId) {
  const ins = db.prepare('INSERT OR REPLACE INTO journal_imports (guild_id, hash, message_id, imported_at) VALUES (?,?,?,?)');
  for (const k of [].concat(keys)) ins.run(guildId, k, messageId || null, Date.now());
}
/**
 * Trades imported before the journal kept their time, size and hold time get
 * them now from a re-uploaded file: for each already-imported trade, fills
 * only the details its journal row is missing (never overwrites). Returns how
 * many trades gained something.
 */
function backfillImported(guildId, trades) {
  const msgOf = db.prepare('SELECT message_id FROM journal_imports WHERE guild_id = ? AND hash = ? AND message_id IS NOT NULL');
  const row = db.prepare('SELECT id, fields_json FROM journal_entries WHERE guild_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1');
  const upd = db.prepare('UPDATE journal_entries SET fields_json = ? WHERE id = ?');
  let n = 0;
  for (const t of trades) {
    const msg = (t.keys || [t.hash]).map((k) => msgOf.get(guildId, k)?.message_id).find(Boolean);
    const e = msg && row.get(guildId, msg);
    if (!e) continue;
    let f; try { f = JSON.parse(e.fields_json || '{}') || {}; } catch { continue; }
    const add = { _at: t.opened || (t.timed ? t.at : undefined), _qty: t.qty || undefined, _held: t.held || undefined };
    let changed = false;
    for (const [k, v] of Object.entries(add)) if (v && (f[k] === undefined || f[k] === null || f[k] === '')) { f[k] = v; changed = true; }
    if (changed) { upd.run(JSON.stringify(f), e.id); n += 1; }
  }
  return n;
}
/** the last import into this server: when, how many, and the latest trade it held */
function lastImportRun(guildId) { return db.prepare('SELECT * FROM journal_import_runs WHERE guild_id = ? ORDER BY at DESC LIMIT 1').get(guildId) || null; }
function recordImportRun(guildId, { count, lastTradeAt, file }) {
  db.prepare('INSERT INTO journal_import_runs (guild_id, at, count, last_trade_at, file) VALUES (?,?,?,?,?)').run(guildId, Date.now(), count, lastTradeAt || null, file || null);
}
/**
 * Trades already in the journal on these days that did NOT come from an import
 * (typed by hand, or posted with /journal), to spot the same trade arriving
 * again from a CSV: { date: [{ instrument, pnl_cents }] }
 */
function journaledOn(guildId, dates) {
  const q = db.prepare(`SELECT p.thread_id, p.pnl_cents, (SELECT e.instrument FROM journal_entries e WHERE e.message_id = p.thread_id OR e.thread_id = p.thread_id LIMIT 1) AS instrument
    FROM pnl_entries p WHERE p.guild_id = ? AND p.date_local = ? AND p.outcome != 'missed'
      AND p.thread_id NOT IN (SELECT message_id FROM journal_imports WHERE guild_id = ? AND message_id IS NOT NULL)`);
  const out = {};
  for (const d of new Set(dates)) out[d] = q.all(guildId, d, guildId).map((r) => ({ instrument: r.instrument || null, pnl_cents: r.pnl_cents }));
  return out;
}
/**
 * Trades the bot posted that are still in the journal (their PnL row is
 * alive), newest first, for /edit-trade. Only the latest journal row per
 * message counts, and hand-typed posts have none, so they never show up.
 */
function editableTrades(guildId, startISO = '0000-01-01', endISO = '9999-12-31') {
  return db.prepare(`SELECT e.*, p.date_local AS live_date FROM journal_entries e JOIN pnl_entries p ON p.thread_id = e.message_id
    WHERE e.guild_id = ? AND p.date_local >= ? AND p.date_local <= ?
      AND e.id = (SELECT MAX(x.id) FROM journal_entries x WHERE x.message_id = e.message_id)
    ORDER BY p.date_local DESC, e.created_at DESC LIMIT 5000`).all(guildId, startISO, endISO);
}
function getEntry(id) { return db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) || null; }
/** rewrites one journal row after /edit-trade saved it to the post */
function updateEntry(id, e) {
  db.prepare(`UPDATE journal_entries SET instrument=@instrument, direction=@direction, session=@session, setup=@setup, entry=@entry, stop=@stop,
    target=@target, exit=@exit, r_multiple=@r_multiple, pnl_cents=@pnl_cents, potential_cents=@potential_cents, followed_plan=@followed_plan,
    fields_json=@fields_json, date_local=@date_local, image_name=@image_name WHERE id=@id`).run({ ...e, id });
}
function pnlRowsForForum(guildId, forumId) {
  return db.prepare('SELECT thread_id, container_id FROM pnl_entries WHERE guild_id=? AND forum_id=?').all(guildId, forumId);
}
function pnlKeysForContainer(containerId) {
  return db.prepare('SELECT thread_id FROM pnl_entries WHERE container_id=?').all(containerId).map((r) => r.thread_id);
}
function deletePnlByContainer(containerId) { return db.prepare('DELETE FROM pnl_entries WHERE container_id = ?').run(containerId).changes; }

/* ---------------- report log ---------------- */
function claimReport(guildId, kind, periodKey) {
  const ins = db.prepare("INSERT OR IGNORE INTO report_log (guild_id,kind,period_key,status,attempts) VALUES (?,?,?, 'pending', 1)").run(guildId, kind, periodKey);
  if (ins.changes) return true;
  const r = db.prepare('SELECT * FROM report_log WHERE guild_id=? AND kind=? AND period_key=?').get(guildId, kind, periodKey);
  // allow up to 3 attempts for failed reports, spaced by the scheduler tick
  if (r.status === 'error' && r.attempts < 3) {
    db.prepare("UPDATE report_log SET status='pending', attempts=attempts+1 WHERE guild_id=? AND kind=? AND period_key=?").run(guildId, kind, periodKey);
    return true;
  }
  return false;
}
function finishReport(guildId, kind, periodKey, { messageId, error }) {
  db.prepare('UPDATE report_log SET status=?, message_id=?, posted_at=?, error=? WHERE guild_id=? AND kind=? AND period_key=?')
    .run(error ? 'error' : 'posted', messageId || null, error ? null : Date.now(), error || null, guildId, kind, periodKey);
}
function getReport(guildId, kind, periodKey) {
  return db.prepare('SELECT * FROM report_log WHERE guild_id=? AND kind=? AND period_key=?').get(guildId, kind, periodKey);
}

module.exports = { db, DEFAULTS, getSettings, saveSettings, listConfiguredGuilds, createDraft, getDraft, saveDraft, deleteDraft, purgeDrafts,
  insertEntry, upsertPnl, getPnlEntry, deletePnl, pnlBetween, setTradeAccount, tradeAccountOf,
  createAccount, getAccount, updateAccount, listAccounts, chainOf, accountRows, addPayout, payoutsOf, claimAccountEvent, accountEventPeriods, setDefaultAccount, entryDetailsFor, importedHashes, markImported, backfillImported, lastImportRun, recordImportRun, journaledOn, editableTrades, getEntry, updateEntry, pnlRowsForForum, pnlKeysForContainer, deletePnlByContainer, claimReport, finishReport, getReport };
