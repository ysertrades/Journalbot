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
  outcome_forums_json TEXT NOT NULL DEFAULT '{}'
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
CREATE TABLE IF NOT EXISTS pnl_entries (
  thread_id TEXT PRIMARY KEY,
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
if (!db.prepare("PRAGMA table_info(journal_settings)").all().some((c) => c.name === 'outcome_forums_json')) {
  db.exec("ALTER TABLE journal_settings ADD COLUMN outcome_forums_json TEXT NOT NULL DEFAULT '{}'");
}

const DEFAULTS = {
  forums: [], default_forum_id: null, report_channel_id: null,
  weekly_day: 5, weekly_time: '17:00', weekly_enabled: true,
  month_enabled: true, month_time: '17:00',
  timezone: 'America/New_York', currency: '$', show_r: true,
  ping_role_id: null, allowed_users: [], outcome_forums: {},
};

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
     month_enabled, month_time, timezone, currency, show_r, ping_role_id, allowed_users_json, outcome_forums_json)
    VALUES (@guild_id,@forums_json,@default_forum_id,@report_channel_id,@weekly_day,@weekly_time,@weekly_enabled,
     @month_enabled,@month_time,@timezone,@currency,@show_r,@ping_role_id,@allowed_users_json,@outcome_forums_json)
    ON CONFLICT(guild_id) DO UPDATE SET forums_json=excluded.forums_json, default_forum_id=excluded.default_forum_id,
     report_channel_id=excluded.report_channel_id, weekly_day=excluded.weekly_day, weekly_time=excluded.weekly_time,
     weekly_enabled=excluded.weekly_enabled, month_enabled=excluded.month_enabled, month_time=excluded.month_time,
     timezone=excluded.timezone, currency=excluded.currency, show_r=excluded.show_r, ping_role_id=excluded.ping_role_id,
     allowed_users_json=excluded.allowed_users_json, outcome_forums_json=excluded.outcome_forums_json`).run({
    guild_id: guildId, forums_json: JSON.stringify(n.forums || []), default_forum_id: n.default_forum_id ?? null,
    report_channel_id: n.report_channel_id ?? null, weekly_day: n.weekly_day, weekly_time: n.weekly_time,
    weekly_enabled: n.weekly_enabled ? 1 : 0, month_enabled: n.month_enabled ? 1 : 0, month_time: n.month_time,
    timezone: n.timezone, currency: n.currency, show_r: n.show_r ? 1 : 0, ping_role_id: n.ping_role_id ?? null,
    allowed_users_json: JSON.stringify(n.allowed_users || []),
    outcome_forums_json: JSON.stringify(Object.fromEntries(Object.entries(n.outcome_forums || {}).filter(([, v]) => v))),
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
  db.prepare(`INSERT INTO pnl_entries (thread_id,guild_id,forum_id,outcome,pnl_cents,potential_cents,date_local,source,content_hash,updated_at)
    VALUES (@thread_id,@guild_id,@forum_id,@outcome,@pnl_cents,@potential_cents,@date_local,@source,@content_hash,@updated_at)
    ON CONFLICT(thread_id) DO UPDATE SET guild_id=excluded.guild_id, forum_id=excluded.forum_id, outcome=excluded.outcome,
     pnl_cents=excluded.pnl_cents, potential_cents=excluded.potential_cents, date_local=excluded.date_local,
     source=excluded.source, content_hash=excluded.content_hash, updated_at=excluded.updated_at`)
    .run({ potential_cents: null, content_hash: null, source: 'scan', ...e, updated_at: Date.now() });
}
function getPnlEntry(threadId) { return db.prepare('SELECT * FROM pnl_entries WHERE thread_id = ?').get(threadId); }
function deletePnl(threadId) { return db.prepare('DELETE FROM pnl_entries WHERE thread_id = ?').run(threadId).changes; }
function pnlBetween(guildId, startISO, endISO) {
  return db.prepare('SELECT * FROM pnl_entries WHERE guild_id=? AND date_local>=? AND date_local<=? ORDER BY date_local').all(guildId, startISO, endISO);
}
function pnlThreadIdsForForum(guildId, forumId) {
  return db.prepare('SELECT thread_id FROM pnl_entries WHERE guild_id=? AND forum_id=?').all(guildId, forumId).map((r) => r.thread_id);
}

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
  insertEntry, upsertPnl, getPnlEntry, deletePnl, pnlBetween, pnlThreadIdsForForum, claimReport, finishReport, getReport };
