'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { getSettings } = require('./db');

const owners = () => (process.env.OWNER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Owner (OWNER_ID env, comma separated), users listed in settings, or ManageGuild members until an allowlist is set */
function isAllowed(interaction) {
  if (owners().includes(interaction.user.id)) return true;
  if (interaction.guildId) {
    const s = getSettings(interaction.guildId);
    if (s.allowed_users.includes(interaction.user.id)) return true;
    if (!s.allowed_users.length && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  }
  return false;
}
function canConfigure(interaction) {
  return owners().includes(interaction.user.id) || !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

const NEEDED = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel], ['SendMessages', PermissionFlagsBits.SendMessages],
  ['SendMessagesInThreads', PermissionFlagsBits.SendMessagesInThreads], ['CreatePublicThreads', PermissionFlagsBits.CreatePublicThreads],
  ['AttachFiles', PermissionFlagsBits.AttachFiles], ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
  ['ManageThreads', PermissionFlagsBits.ManageThreads],
];

async function healthCheck(guild, settings) {
  const lines = [];
  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  const check = async (id, kind) => {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) { lines.push(`⚠️ <#${id}>: channel not found`); return; }
    const perms = ch.permissionsFor(me);
    const need = kind === 'report' ? NEEDED.filter(([n]) => ['ViewChannel', 'SendMessages', 'AttachFiles'].includes(n)) : NEEDED;
    const missing = need.filter(([, f]) => !perms?.has(f)).map(([n]) => n);
    let extra = '';
    if (kind === 'forum') {
      const have = new Set((ch.availableTags || []).map((t) => t.name.toLowerCase()));
      const noTag = ['Win', 'Loss', 'Breakeven', 'Missed'].filter((n) => !have.has(n.toLowerCase()));
      if (noTag.length) extra = ` · missing tags: ${noTag.join(', ')}`;
    }
    lines.push(missing.length || extra ? `⚠️ <#${id}>${missing.length ? ` missing ${missing.join(', ')}` : ''}${extra}` : `✅ <#${id}> permissions OK`);
  };
  for (const id of settings.forums) await check(id, 'forum');
  if (settings.default_forum_id && !settings.forums.includes(settings.default_forum_id)) await check(settings.default_forum_id, 'forum');
  if (settings.report_channel_id) await check(settings.report_channel_id, 'report');
  const names = ['ywin', 'yloss', 'ybe', 'ymissed'];
  const found = names.filter((n) => guild.emojis.cache.some((e) => e.name === n));
  lines.push(found.length === 4 ? '✅ Custom emojis found (ywin, yloss, ybe, ymissed)'
    : `⚠️ Emojis missing: ${names.filter((n) => !found.includes(n)).join(', ')} (unicode fallbacks used)`);
  const intents = guild.client.options.intents;
  lines.push(intents.has('MessageContent') ? '✅ Message Content intent requested (also enable it in the Developer Portal)' : '⚠️ Message Content intent not requested');
  if (!settings.forums.length) lines.push('⚠️ No journal forums selected yet (General page)');
  if (!settings.report_channel_id) lines.push('⚠️ No report channel selected yet (General page)');
  return lines;
}
module.exports = { isAllowed, canConfigure, healthCheck };
