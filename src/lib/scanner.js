'use strict';
const crypto = require('node:crypto');
const { ChannelType } = require('discord.js');
const { parseText, resolveEntry, tagToOutcome } = require('./parse');
const { extractText } = require('./text');
const { allForums } = require('./routing');
const { upsertPnl, getPnlEntry, deletePnl, pnlThreadIdsForForum } = require('./db');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const isForum = (ch) => ch && [ChannelType.GuildForum, ChannelType.GuildMedia].includes(ch.type);

/** Scan one thread. Returns 'updated' | 'unchanged' | 'unparsed' | 'skipped' */
async function scanThread(thread, settings, { force = false } = {}) {
  const forum = thread.parent;
  if (!isForum(forum)) return 'skipped';
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const text = extractText(starter);
  const tagNames = (thread.appliedTags || []).map((id) => (forum.availableTags || []).find((t) => t.id === id)?.name).filter(Boolean);
  const tagOutcome = tagNames.map(tagToOutcome).find(Boolean) || null;
  const h = hash(`${text}|${tagOutcome}|${settings.timezone}`);
  const existing = getPnlEntry(thread.id);
  if (existing && existing.source === 'manual' && !force) return 'unchanged'; // manual edits via the context menu are kept
  if (!force && existing && existing.content_hash === h) return 'unchanged';
  if (!text && existing && existing.source === 'bot') return 'unchanged'; // cannot read content (missing intent): keep bot-made data
  const entry = resolveEntry(parseText(text), { tagOutcome, createdMs: thread.createdTimestamp || Date.now(), tz: settings.timezone });
  if (!entry) { if (existing) deletePnl(thread.id); return 'unparsed'; }
  upsertPnl({ thread_id: thread.id, guild_id: thread.guildId, forum_id: forum.id, ...entry, source: existing?.source === 'manual' ? 'manual' : (existing?.source || 'scan'), content_hash: h });
  return 'updated';
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
 * Scan every configured journal forum.
 * onProgress(msg) is optional. Returns summary { threads, updated, unchanged, unparsed: [{id,name}], removed, errors }
 */
async function scanGuild(guild, settings, { force = false, onProgress } = {}) {
  const summary = { threads: 0, updated: 0, unchanged: 0, unparsed: [], removed: 0, errors: [] };
  for (const forumId of allForums(settings)) {
    const forum = await guild.channels.fetch(forumId).catch(() => null);
    if (!isForum(forum)) { summary.errors.push(`<#${forumId}> not found or not a forum`); continue; }
    let threads;
    try { threads = await allThreads(forum, guild); } catch (e) { summary.errors.push(`<#${forumId}>: ${e.message}`); continue; }
    onProgress?.(`Scanning <#${forumId}> · ${threads.size} posts`);
    for (const t of threads.values()) {
      summary.threads += 1;
      try {
        const r = await scanThread(t, settings, { force });
        if (r === 'updated') summary.updated += 1; else if (r === 'unchanged') summary.unchanged += 1;
        else if (r === 'unparsed') summary.unparsed.push({ id: t.id, name: t.name });
      } catch (e) { summary.errors.push(`${t.name}: ${e.message}`); }
    }
    // drop cache rows for posts that no longer exist (only after a clean, complete listing)
    for (const id of pnlThreadIdsForForum(guild.id, forumId)) if (!threads.has(id)) { deletePnl(id); summary.removed += 1; }
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
module.exports = { scanThread, scanGuild, summaryText, isForum };
