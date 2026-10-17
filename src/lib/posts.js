'use strict';
const { ChannelType } = require('discord.js');

const isForum = (ch) => ch && [ChannelType.GuildForum, ChannelType.GuildMedia].includes(ch.type);

/** Posts (threads) inside one forum, newest first: [{ id, name, archived, locked, createdTimestamp }] */
async function listPosts(guild, forumId, { maxArchivedPages = 5 } = {}) {
  const forum = await guild.channels.fetch(forumId).catch(() => null);
  if (!isForum(forum)) return { forum: null, posts: [] };
  const map = new Map();
  const add = (t) => map.set(t.id, { id: t.id, name: t.name, archived: !!t.archived, locked: !!t.locked, createdTimestamp: t.createdTimestamp || 0 });
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  if (active) for (const t of active.threads.values()) if (t.parentId === forumId) add(t);
  let before;
  for (let i = 0; i < maxArchivedPages; i += 1) {
    const res = await forum.threads.fetchArchived({ type: 'public', fetchAll: false, limit: 100, before }).catch(() => null);
    if (!res || !res.threads.size) break;
    for (const t of res.threads.values()) add(t);
    if (!res.hasMore) break;
    before = res.threads.last();
  }
  return { forum, posts: [...map.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp) };
}
module.exports = { listPosts, isForum };
