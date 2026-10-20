'use strict';
const {
  AttachmentBuilder, ChannelType, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} = require('discord.js');
const { OUTCOMES, TRADE_COLOR, buildPostBody, threadTitle, emojiToken } = require('./format');
const { tagToOutcome } = require('./parse');
const { insertEntry, upsertPnl } = require('./db');
const { chunkText } = require('./text');

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;
const MAX_IMAGE = 10 * 1024 * 1024;

function validateImage(att) {
  if (!att) return null;
  const type = att.contentType || '';
  if (!IMAGE_TYPES.test(type) && !/\.(png|jpe?g|webp|gif)$/i.test(att.name || '')) return 'Only png, jpg, webp or gif images are supported.';
  if (att.size > MAX_IMAGE) return 'Image is larger than 10 MB.';
  return null;
}
const imageRecord = (att) => ({ name: att.name, url: att.url, contentType: att.contentType || null, size: att.size });
const safeName = (n) => String(n || 'chart.png').replace(/[^\w.\-]+/g, '_').slice(-64) || 'chart.png';

async function downloadImage(rec) {
  const res = await fetch(rec.url);
  if (!res.ok) throw new Error(`Could not download the picture (${res.status}). Add it again.`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new AttachmentBuilder(buf, { name: safeName(rec.name) });
}

const PNL_LINE = /^[ \t]*[+-]?[ \t]*PNL[ \t]*[:=]/im;
const FORUM_TYPES = [ChannelType.GuildForum, ChannelType.GuildMedia];

/**
 * Posts the journal entry.
 *  - draft.fields._thread set: adds it as a message inside that EXISTING post (no new post is created)
 *  - otherwise: creates a new post in draft.forumId
 * Returns { thread, messageId, existing, usedV2, tagApplied }. Throws Error with a user-readable message.
 */
async function postJournal({ guild, draft, settings }) {
  const outcome = draft.outcome, f = { ...draft.fields };
  const threadId = f._thread; delete f._forum_manual; delete f._thread;
  if (outcome === 'missed') f.pnl_cents = 0;
  const body = buildPostBody(outcome, f, { emoji: emojiToken(guild, outcome), symbol: settings.currency, showR: settings.show_r }).slice(0, 3900);
  const file = draft.image ? await downloadImage(draft.image) : null;
  // The trade log is dark: the post's own emoji and heading carry the outcome.
  const container = new ContainerBuilder().setAccentColor(TRADE_COLOR);
  if (file) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`)));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  const copy = () => (file ? new AttachmentBuilder(file.attachment, { name: file.name }) : null);

  let thread, messageId, usedV2 = true, tagApplied = false, forumId;
  if (threadId) {
    thread = await guild.channels.fetch(threadId).catch(() => null);
    if (!thread || !thread.isThread?.() || !FORUM_TYPES.includes(thread.parent?.type)) throw new Error('The post chosen for this outcome no longer exists. Pick it again in /journal-settings \u2192 Outcome forums.');
    forumId = thread.parentId;
    if (thread.locked) throw new Error(`<#${thread.id}> is locked. Unlock it or choose another post.`);
    if (thread.archived) await thread.setArchived(false).catch(() => { throw new Error(`<#${thread.id}> is archived and I cannot reopen it (needs Manage Threads).`); });
    try {
      const msg = await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2, files: file ? [file] : [] });
      messageId = msg.id;
    } catch (err) {
      if (/Missing Permissions|Missing Access/i.test(err.message)) throw new Error(`Missing permission to send in <#${thread.id}>.`);
      usedV2 = false;
      const chunks = chunkText(body, 1900), sent = [];
      if (file) sent.push(await thread.send({ files: [copy()] }));
      for (const c of chunks) sent.push(await thread.send({ content: c }));
      messageId = (sent.find((m) => PNL_LINE.test(m.content || '')) || sent[0]).id;   // the message holding the PNL line is the entry
    }
  } else {
    const forum = await guild.channels.fetch(draft.forumId).catch(() => null);
    if (!forum || !FORUM_TYPES.includes(forum.type)) throw new Error('The selected forum channel no longer exists.');
    forumId = forum.id;
    const title = threadTitle(outcome, f, settings.currency);
    const tag = (forum.availableTags || []).find((t) => tagToOutcome(t.name) === outcome);
    tagApplied = !!tag;
    try {
      thread = await forum.threads.create({
        name: title, appliedTags: tag ? [tag.id] : [],
        message: { components: [container], flags: MessageFlags.IsComponentsV2, files: file ? [file] : [] },
      });
    } catch (err) {
      usedV2 = false;
      if (/Missing Permissions|Missing Access/i.test(err.message)) throw new Error(`Missing permission to create posts in <#${forum.id}>.`);
      const chunks = chunkText(body, 1900);
      // with a picture the picture is the starter message and all text follows in the thread; otherwise the first chunk is the starter
      thread = await forum.threads.create({
        name: title, appliedTags: tag ? [tag.id] : [],
        message: file ? { files: [copy()] } : { content: chunks.shift() },
      });
      for (const c of chunks) await thread.send({ content: c });
    }
    messageId = thread.id;
  }
  const entry = {
    guild_id: guild.id, user_id: draft.userId, outcome, instrument: f.instrument || null, direction: f.direction || null, session: f.session || null,
    setup: f.setup || null, entry: f.entry || null, stop: f.stop || null, target: f.target || null, exit: f.exit || null, r_multiple: f.r ?? null,
    pnl_cents: f.pnl_cents || 0, potential_cents: f.potential_cents ?? null, followed_plan: f.followed || null, fields_json: JSON.stringify(f),
    date_local: f.date, forum_id: forumId, thread_id: thread.id, message_id: messageId, image_name: file ? file.name : null, created_at: Date.now(),
  };
  insertEntry(entry);
  upsertPnl({ thread_id: messageId, container_id: thread.id, guild_id: guild.id, forum_id: forumId, outcome, pnl_cents: entry.pnl_cents, potential_cents: entry.potential_cents, date_local: f.date, source: 'bot' });
  return { thread, messageId, existing: !!threadId, usedV2, tagApplied };
}

module.exports = { postJournal, validateImage, imageRecord, downloadImage, FORUM_TYPES };
