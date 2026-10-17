'use strict';
const {
  AttachmentBuilder, ChannelType, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} = require('discord.js');
const { OUTCOMES, buildPostBody, threadTitle, emojiToken } = require('./format');
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

/** Creates the forum post. Returns { thread, messageId, usedV2 }. Throws Error with a user-readable message. */
async function postJournal({ guild, draft, settings }) {
  const forum = await guild.channels.fetch(draft.forumId).catch(() => null);
  if (!forum || ![ChannelType.GuildForum, ChannelType.GuildMedia].includes(forum.type)) throw new Error('The selected forum channel no longer exists.');
  const outcome = draft.outcome, f = { ...draft.fields };
  if (outcome === 'missed') f.pnl_cents = 0;
  const body = buildPostBody(outcome, f, { emoji: emojiToken(guild, outcome), symbol: settings.currency, showR: settings.show_r }).slice(0, 3900);
  const title = threadTitle(outcome, f, settings.currency);
  const tag = (forum.availableTags || []).find((t) => tagToOutcome(t.name) === outcome);
  const file = draft.image ? await downloadImage(draft.image) : null;

  const container = new ContainerBuilder().setAccentColor(OUTCOMES[outcome].color);
  if (file) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`)));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

  let thread, usedV2 = true;
  try {
    thread = await forum.threads.create({
      name: title, appliedTags: tag ? [tag.id] : [],
      message: { components: [container], flags: MessageFlags.IsComponentsV2, files: file ? [file] : [] },
    });
  } catch (err) {
    usedV2 = false;
    if (/Missing Permissions|Missing Access/i.test(err.message)) throw new Error(`Missing permission to create posts in <#${forum.id}>.`);
    const chunks = chunkText(body, 1900);
    const f2 = file ? new AttachmentBuilder(file.attachment, { name: file.name }) : null;
    thread = await forum.threads.create({
      name: title, appliedTags: tag ? [tag.id] : [],
      message: file ? { files: [f2] } : { content: chunks.shift() },
    });
    if (file) { /* picture is the starter message; text follows in the thread */ }
    for (const c of chunks.length || !file ? chunks : chunkText(body, 1900)) await thread.send({ content: c });
  }
  const entry = {
    guild_id: guild.id, user_id: draft.userId, outcome, instrument: f.instrument || null, direction: f.direction || null, session: f.session || null,
    setup: f.setup || null, entry: f.entry || null, stop: f.stop || null, target: f.target || null, exit: f.exit || null, r_multiple: f.r ?? null,
    pnl_cents: f.pnl_cents || 0, potential_cents: f.potential_cents ?? null, followed_plan: f.followed || null, fields_json: JSON.stringify(f),
    date_local: f.date, forum_id: forum.id, thread_id: thread.id, message_id: thread.id, image_name: file ? file.name : null, created_at: Date.now(),
  };
  insertEntry(entry);
  upsertPnl({ thread_id: thread.id, guild_id: guild.id, forum_id: forum.id, outcome, pnl_cents: entry.pnl_cents, potential_cents: entry.potential_cents, date_local: f.date, source: 'bot' });
  return { thread, messageId: thread.id, usedV2, tagApplied: !!tag };
}

module.exports = { postJournal, validateImage, imageRecord };
