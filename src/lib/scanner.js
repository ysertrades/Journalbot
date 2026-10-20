'use strict';
const crypto = require('node:crypto');
const { ChannelType } = require('discord.js');
const { parseText, resolveEntry, tagToOutcome } = require('./parse');
const { tradingDay } = require('./session');
const { extractText } = require('./text');
const { allForums, ledgerThreads } = require('./routing');
const { upsertPnl, getPnlEntry, deletePnl, pnlRowsForForum, pnlKeysForContainer } = require('./db');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const isForum = (ch) => ch && [ChannelType.GuildForum, ChannelType.GuildMedia].includes(ch.type);
const MAX_LEDGER_PAGES = 100;   // 10,000 messages per post

/** Scan one message that may hold a journal entry. Used for both starter messages and messages inside destination posts. */
function scanText({ key, container, forumId, guildId, text, tagOutcome, createdMs, hintOutcome, settings, force }) {
  const h = hash(`${text}|${tagOutcome || hintOutcome}|${settings.timezone}|${settings.session_start}${settings.session_fold ? 'f' : ''}`);
  const existing = getPnlEntry(key);
  if (existing && existing.source === 'manual' && !force) return 'unchanged';        // manual edits via the context menu are kept
  if (!force && existing && existing.content_hash === h) return 'unchanged';
  if (!text && existing && existing.source === 'bot') return 'unchanged';           // cannot read content (missing intent): keep bot-made data
  const entry = resolveEntry(parseText(text), { tagOutcome, hintOutcome, createdMs, tz: settings.timezone, dayOf: (ms) => tradingDay(ms, settings) });
  if (!entry) { if (existing) deletePnl(key); return 'unparsed'; }
  upsertPnl({ thread_id: key, container_id: container, guild_id: guildId, forum_id: forumId, ...entry, source: existing?.source === 'manual' ? 'manual' : (existing?.source || 'scan'), content_hash: h });
  return 'updated';
}

/** Scan one forum post by its starter message. Returns 'updated' | 'unchanged' | 'unparsed' | 'skipped' */
async function scanThread(thread, settings, { force = false } = {}) {
  const forum = thread.parent;
  if (!isForum(forum)) return 'skipped';
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const tagNames = (thread.appliedTags || []).map((id) => (forum.availableTags || []).find((t) => t.id === id)?.name).filter(Boolean);
  return scanText({
    key: thread.id, container: thread.id, forumId: forum.id, guildId: thread.guildId, text: extractText(starter),
    tagOutcome: tagNames.map(tagToOutcome).find(Boolean) || null, createdMs: thread.createdTimestamp || Date.now(), settings, force,
  });
}

/** Scan a single message inside a destination post (new messages, edits). */
function scanLedgerMessage(thread, message, settings, { force = false } = {}) {
  const hint = ledgerThreads(settings)[thread.id] || [];
  return scanText({
    key: message.id, container: thread.id, forumId: thread.parentId, guildId: thread.guildId, text: extractText(message),
    tagOutcome: null, hintOutcome: hint.length === 1 ? hint[0] : null, createdMs: message.createdTimestamp || Date.now(), settings, force,
  });
}

/** Scan every message of a destination post. Returns { messages, updated, removed } */
async function scanLedger(thread, settings, { force = false } = {}) {
  const res = { messages: 0, updated: 0, removed: 0 };
  const seen = new Set();
  let before;
  for (let page = 0; page < MAX_LEDGER_PAGES; page += 1) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const m of batch.values()) {
      res.messages += 1;
      const r = scanLedgerMessage(thread, m, settings, { force });
      if (r === 'updated') res.updated += 1;
      if (r !== 'unparsed') seen.add(m.id);
    }
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  for (const key of pnlKeysForContainer(thread.id)) {   // entries whose message was deleted while the bot was offline
    if (!seen.has(key) && getPnlEntry(key)?.source !== 'manual') { deletePnl(key); res.removed += 1; }
  }
  return res;
}

async function allThreads(forum, guild) {
  const out = new Map();
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  if (active) for (const [id, t] of active.threads) if (t.parentId === forum.id) out.set(id, t);
  let before;
  for (let page = 0; page < 200; page += 1) {
    const res = await forum.threads.fetchArchived({ type: 'public', fetchAll: false, limit: 100, before }).catch(() => null);
    if (!res || !res.threads.size) break;
    for (const [id, t] of res.threads) out.set(id, t);
    if (!res.hasMore) break;
    before = res.threads.last();
    if (!before) break;
  }
  return out;
}

/**
 * Scan every journal forum (outcome forums, destination posts, extra forums, default forum).
 * Returns summary { threads, updated, unchanged, unparsed: [{id,name}], removed, errors }
 */
async function scanGuild(guild, settings, { force = false, onProgress } = {}) {
  const summary = { threads: 0, updated: 0, unchanged: 0, unparsed: [], removed: 0, errors: [] };
  const ledgers = ledgerThreads(settings);
  for (const forumId of allForums(settings)) {
    const forum = await guild.channels.fetch(forumId).catch(() => null);
    if (!isForum(forum)) { summary.errors.push(`<#${forumId}> not found or not a forum`); continue; }
    let threads;
    try { threads = await allThreads(forum, guild); } catch (e) { summary.errors.push(`<#${forumId}>: ${e.message}`); continue; }
    for (const id of Object.keys(ledgers)) {      // destination posts that the listing missed (old archived posts)
      if (!threads.has(id)) { const t = await guild.channels.fetch(id).catch(() => null); if (t?.parentId === forumId) threads.set(id, t); }
    }
    onProgress?.(`Scanning <#${forumId}> · ${threads.size} posts`);
    for (const t of threads.values()) {
      summary.threads += 1;
      try {
        if (ledgers[t.id]) {
          const r = await scanLedger(t, settings, { force });
          summary.updated += r.updated; summary.removed += r.removed;
          continue;
        }
        const r = await scanThread(t, settings, { force });
        if (r === 'updated') summary.updated += 1; else if (r === 'unchanged') summary.unchanged += 1;
        else if (r === 'unparsed') summary.unparsed.push({ id: t.id, name: t.name });
      } catch (e) { summary.errors.push(`${t.name}: ${e.message}`); }
    }
    // drop cache rows whose post no longer exists (only after a clean, complete listing)
    for (const row of pnlRowsForForum(guild.id, forumId)) if (!threads.has(row.container_id || row.thread_id)) { deletePnl(row.thread_id); summary.removed += 1; }
  }
  return summary;
}

function summaryText(s) {
  const lines = [`**Scan complete** · ${s.threads} posts · ${s.updated} updated · ${s.unchanged} unchanged · ${s.removed} removed`];
  if (s.unparsed.length) {
    lines.push(`**${s.unparsed.length} without a \`PNL:\` line** (ignored in totals):`);
    lines.push(...s.unparsed.slice(0, 8).map((u) => `- <#${u.id}>`));
    if (s.unparsed.length > 8) lines.push(`- …and ${s.unparsed.length - 8} more`);
  }
  if (s.errors.length) lines.push(`⚠️ ${s.errors.slice(0, 5).join('\n⚠️ ')}`);
  return lines.join('\n');
}
module.exports = { scanThread, scanLedger, scanLedgerMessage, scanGuild, summaryText, isForum };
