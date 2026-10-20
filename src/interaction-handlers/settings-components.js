'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings, saveSettings } = require('../lib/db');
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PRESETS } = require('../lib/session');
const { planRedate, redatePanel, applyRedate, MAX_PER_RUN } = require('../lib/redate');
const { settingsPanel, simpleModal, pickPanel, SWATCH } = require('../lib/panels');
const { listPosts } = require('../lib/posts');
const { OUTCOMES } = require('../lib/format');
const { canConfigure, healthCheck } = require('../lib/permissions');
const { scanGuild, summaryText } = require('../lib/scanner');
const { weeklyImage, monthlyImage, dailyImage, themeSwatch, postNow, reportMessage } = require('../lib/reports');
const { card, ephemeral, WARN_COLOR, ERROR_COLOR } = require('../lib/ui');
const { DateTime } = require('luxon');
const { todayFor } = require('../lib/session');

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const normTime = (s) => { const m = String(s).trim().match(TIME_RE); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const validTz = (z) => DateTime.now().setZone(z).isValid;

class SettingsHandler extends InteractionHandler {
  constructor(ctx, opts) { super(ctx, { ...opts, interactionHandlerType: InteractionHandlerTypes.MessageComponent }); }
  parse(i) { return i.customId.startsWith('js:') ? this.some() : this.none(); }
  async run(i) {
    try { await handleSettings(i); } catch (e) { this.container.logger.error('[journal-settings]', e); }
  }
}


async function render(i, page, settings) {
  const lines = page === 'advanced' ? await healthCheck(i.guild, settings).catch((e) => [`⚠️ ${e.message}`]) : null;
  return settingsPanel(page, settings, lines);
}
/** Called for every `js:` component interaction and `jsm:` modal. */
async function handleSettings(i) {
  if (!canConfigure(i)) return i.reply(ephemeral(card('You need **Manage Server** to change journal settings.', ERROR_COLOR)));
  const [ns, group, action] = i.customId.split(':'); // js:{group}:{action} | jsm:{page}:{field}
  const gid = i.guildId; let s = getSettings(gid);
  const answer = async (page) => {
    s = getSettings(gid);
    // the Appearance page carries its preview image; every other page drops it
    let files = [];
    if (page === 'look') { try { files = [new AttachmentBuilder(themeSwatch(gid, s), { name: SWATCH })]; } catch { files = []; } }
    const panel = await render(i, page, s);
    if (page === 'look' && !files.length) return i.editReply({ components: [settingsPanel('general', s)], files: [], attachments: [] });
    return i.editReply({ components: [panel], files, attachments: [] });
  };

  if (ns === 'jsm') { // modal submit: jsm:{page}:{field}
    const v = (i.fields.getTextInputValue('value') || '').trim(); let err = null;
    if (group === 'schedule' && action === 'wtime') { const t = normTime(v); if (t) saveSettings(gid, { weekly_time: t }); else err = 'Use 24h time like `17:00`.'; }
    if (group === 'schedule' && action === 'mtime') { const t = normTime(v); if (t) saveSettings(gid, { month_time: t }); else err = 'Use 24h time like `17:00`.'; }
    if (group === 'schedule' && action === 'tz') { if (validTz(v)) saveSettings(gid, { timezone: v }); else err = 'Unknown timezone. Use an IANA name like `America/New_York`.'; }
    if (group === 'advanced' && action === 'cur') saveSettings(gid, { currency: v.slice(0, 3) || '$' });
    if (group === 'schedule' && action === 'sess') { const t = normTime(v); if (t) saveSettings(gid, { session_start: t, session_zone: t === '00:00' ? s.session_zone : (s.session_start === '00:00' ? 'America/New_York' : s.session_zone) }); else err = 'Use 24h time like `18:00` (New York time).'; }
    if (err) return i.reply(ephemeral(card(`⚠️ ${err}`, WARN_COLOR)));
    await i.deferUpdate(); return answer(group);
  }

  if (group === 'nav') { await i.deferUpdate(); return answer(action); }

  // ---- destination picker: choose a forum, then an existing post inside it (or "new post each time") ----
  const parts = i.customId.split(':');
  const showPick = async (key, forumId, pg = 0) => {
    const { forum, posts } = forumId ? await listPosts(i.guild, forumId) : { forum: null, posts: [] };
    return i.editReply({ components: [pickPanel({ key, forumId: forum ? forumId : null, posts, page: pg, settings: getSettings(gid) })] });
  };
  if (group === 'outcomes' && action === 'edit') {
    const key = parts[3]; if (!OUTCOMES[key]) return undefined;
    await i.deferUpdate();
    return showPick(key, s.outcome_threads?.[key]?.forum || s.outcome_forums?.[key] || s.default_forum_id || null, 0);
  }
  if (group === 'pick') {
    const key = action, op = parts[3], forumId = parts[4], arg = parts[5]; if (!OUTCOMES[key]) return undefined;
    await i.deferUpdate();
    if (op === 'forum') return showPick(key, i.values[0], 0);
    if (op === 'page') return showPick(key, forumId, Number(arg) || 0);
    if (op === 'thread') {
      saveSettings(gid, { outcome_threads: { ...s.outcome_threads, [key]: { thread: i.values[0], forum: forumId } }, outcome_forums: { ...s.outcome_forums, [key]: null } });
      return showPick(key, forumId, Number(arg) || 0);
    }
    if (op === 'new') {
      saveSettings(gid, { outcome_forums: { ...s.outcome_forums, [key]: forumId }, outcome_threads: { ...s.outcome_threads, [key]: null } });
      return showPick(key, forumId, 0);
    }
    if (op === 'clear') {
      saveSettings(gid, { outcome_forums: { ...s.outcome_forums, [key]: null }, outcome_threads: { ...s.outcome_threads, [key]: null } });
      return answer('outcomes');
    }
    return undefined;
  }
  const page = group;
  // modals open immediately (cannot defer first)
  const MODALS = {
    wtime: ['Weekly time', 'Post time (24h, your timezone)', s.weekly_time, '17:00', 5], mtime: ['Month-end time', 'Post time (24h, your timezone)', s.month_time, '17:00', 5],
    tz: ['Timezone', 'IANA timezone', s.timezone, 'America/New_York', 40], cur: ['Currency symbol', 'Symbol (1-3 characters)', s.currency, '$', 3],
    sess: ['Trading day start', 'Session start (24h, New York time; 00:00 = midnight)', s.session_start, '18:00', 5],
  };
  if (action && action.startsWith('modal_')) {
    const k = action.slice(6), m = MODALS[k];
    return i.showModal(simpleModal(`jsm:${page}:${k}`, m[0], m[1], m[2], m[3], m[4]));
  }
  await i.deferUpdate();
  const ids = i.values || [];
  const patch = {
    general: { forums: { forums: ids }, defforum: { default_forum_id: ids[0] || null }, repchan: { report_channel_id: ids[0] || null } },
    schedule: { toggle_weekly: { weekly_enabled: !s.weekly_enabled }, toggle_month: { month_enabled: !s.month_enabled }, day: { weekly_day: Number(ids[0] || s.weekly_day) },
      session: PRESETS[ids[0]] ? { session_start: PRESETS[ids[0]].start, session_zone: PRESETS[ids[0]].zone || s.session_zone, session_fold: PRESETS[ids[0]].fold } : null },
    advanced: { toggle_r: { show_r: !s.show_r }, role: { ping_role_id: ids[0] || null }, users: { allowed_users: ids } },
    look: { theme_light: { theme: 'light' }, theme_dark: { theme: 'dark' }, theme_auto: { theme: 'auto' } },
  }[page]?.[action];
  if (patch) { saveSettings(gid, patch); return answer(page); }

  // the trading-day fix: a preview of what moves, then the run with live progress
  if (page === 'schedule' && action === 'redate') return i.editReply({ components: [redatePanel(gid, s, planRedate(gid, s))], files: [], attachments: [] });
  if (page === 'schedule' && action === 'redate_go') {
    const moves = planRedate(gid, s);
    const bar = (d, t) => card(`# \u{1F319} Moving trades…\n\`${'█'.repeat(Math.round((d / Math.max(1, t)) * 16))}${'░'.repeat(16 - Math.round((d / Math.max(1, t)) * 16))}\` **${d}/${t}**\n-# Each post is rewritten with its new date. Keep this open.`);
    await i.editReply({ components: [bar(0, Math.min(moves.length, MAX_PER_RUN))] });
    const res = await applyRedate(i.guild, s, moves, (d, t) => i.editReply({ components: [bar(d, t)] }));
    await scanGuild(i.guild, getSettings(gid)).catch(() => {});   // hand-typed posts are re-read under the new rule
    const lines = [`# ✅ ${res.moved + res.journalOnly} trade${res.moved + res.journalOnly === 1 ? '' : 's'} moved`];
    if (res.journalOnly) lines.push(`-# ${res.journalOnly} could not be rewritten (plain-text or deleted posts) and moved in the journal only`);
    if (res.failed.length) lines.push(`-# ${res.failed.length} failed: ${res.failed.slice(0, 3).join(' | ')}`);
    if (res.left) lines.push(`-# ${res.left} more: run Fix past trades again`);
    lines.push('-# /pnl, /trades and the reports use the new days right away.');
    const done = card(lines.join('\n'));
    done.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('js:nav:schedule').setLabel('Back to schedule').setStyle(ButtonStyle.Secondary)));
    return i.editReply({ components: [done] });
  }
  if (page === 'look' && action === 'prev_day') {
    try {
      const img = dailyImage(gid, todayFor(s), s);
      const msg = reportMessage(img, { ...s, ping_role_id: null });
      return i.followUp({ components: msg.components, files: msg.files, flags: 64 | 32768 });
    } catch (e) { return i.followUp(ephemeral(card(`⚠️ ${e.message}`, ERROR_COLOR))); }
  }
  if ((page === 'advanced' || page === 'look') && ['prev_week', 'prev_month', 'post_week', 'post_month', 'rescan'].includes(action)) {
    try {
      if (action === 'rescan') {
        const res = await scanGuild(i.guild, s, { force: false });
        return i.followUp(ephemeral(card(summaryText(res))));
      }
      if (action === 'post_week' || action === 'post_month') {
        await postNow(i.guild, s, action === 'post_week' ? 'weekly' : 'monthly');
        return i.followUp(ephemeral(card(`Posted to <#${s.report_channel_id}>.`)));
      }
      await scanGuild(i.guild, s);
      const now = DateTime.now().setZone(s.timezone);
      const img = action === 'prev_week' ? weeklyImage(gid, now.toISODate(), s) : monthlyImage(gid, now.year, now.month, s);
      const msg = reportMessage(img, { ...s, ping_role_id: null });
      return i.followUp({ components: msg.components, files: msg.files, flags: 64 | 32768 });
    } catch (e) { return i.followUp(ephemeral(card(`⚠️ ${e.message}`, ERROR_COLOR))); }
  }
  return answer(page);
}

module.exports = { SettingsHandler, handleSettings };
