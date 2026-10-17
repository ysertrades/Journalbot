'use strict';
const { InteractionHandler, InteractionHandlerTypes } = require('@sapphire/framework');
const { getSettings, saveSettings } = require('../lib/db');
const { settingsPanel, simpleModal } = require('../lib/panels');
const { canConfigure, healthCheck } = require('../lib/permissions');
const { scanGuild, summaryText } = require('../lib/scanner');
const { weeklyImage, monthlyImage, postNow, reportMessage } = require('../lib/reports');
const { card, ephemeral } = require('../lib/ui');
const { DateTime } = require('luxon');

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
  if (!canConfigure(i)) return i.reply(ephemeral(card('You need **Manage Server** to change journal settings.', 0xf87171)));
  const [ns, group, action] = i.customId.split(':'); // js:{group}:{action} | jsm:{page}:{field}
  const gid = i.guildId; let s = getSettings(gid);
  const answer = async (page) => { s = getSettings(gid); return i.editReply({ components: [await render(i, page, s)] }); };

  if (ns === 'jsm') { // modal submit: jsm:{page}:{field}
    const v = (i.fields.getTextInputValue('value') || '').trim(); let err = null;
    if (group === 'schedule' && action === 'wtime') { const t = normTime(v); if (t) saveSettings(gid, { weekly_time: t }); else err = 'Use 24h time like `17:00`.'; }
    if (group === 'schedule' && action === 'mtime') { const t = normTime(v); if (t) saveSettings(gid, { month_time: t }); else err = 'Use 24h time like `17:00`.'; }
    if (group === 'schedule' && action === 'tz') { if (validTz(v)) saveSettings(gid, { timezone: v }); else err = 'Unknown timezone. Use an IANA name like `America/New_York`.'; }
    if (group === 'advanced' && action === 'cur') saveSettings(gid, { currency: v.slice(0, 3) || '$' });
    if (err) return i.reply(ephemeral(card(`⚠️ ${err}`, 0xfbbf24)));
    await i.deferUpdate(); return answer(group);
  }

  if (group === 'nav') { await i.deferUpdate(); return answer(action); }
  const page = group;
  // modals open immediately (cannot defer first)
  const MODALS = {
    wtime: ['Weekly time', 'Post time (24h, your timezone)', s.weekly_time, '17:00', 5], mtime: ['Month-end time', 'Post time (24h, your timezone)', s.month_time, '17:00', 5],
    tz: ['Timezone', 'IANA timezone', s.timezone, 'America/New_York', 40], cur: ['Currency symbol', 'Symbol (1-3 characters)', s.currency, '$', 3],
  };
  if (action && action.startsWith('modal_')) {
    const k = action.slice(6), m = MODALS[k];
    return i.showModal(simpleModal(`jsm:${page}:${k}`, m[0], m[1], m[2], m[3], m[4]));
  }
  await i.deferUpdate();
  const ids = i.values || [];
  const patch = {
    general: { forums: { forums: ids }, defforum: { default_forum_id: ids[0] || null }, repchan: { report_channel_id: ids[0] || null } },
    schedule: { toggle_weekly: { weekly_enabled: !s.weekly_enabled }, toggle_month: { month_enabled: !s.month_enabled }, day: { weekly_day: Number(ids[0] || s.weekly_day) } },
    advanced: { toggle_r: { show_r: !s.show_r }, role: { ping_role_id: ids[0] || null }, users: { allowed_users: ids } },
  }[page]?.[action];
  if (patch) { saveSettings(gid, patch); return answer(page); }

  if (page === 'advanced' && ['prev_week', 'prev_month', 'post_week', 'post_month', 'rescan'].includes(action)) {
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
    } catch (e) { return i.followUp(ephemeral(card(`⚠️ ${e.message}`, 0xf87171))); }
  }
  return answer(page);
}

module.exports = { SettingsHandler, handleSettings };
