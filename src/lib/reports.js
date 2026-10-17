'use strict';
const {
  AttachmentBuilder, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
} = require('discord.js');
const { DateTime } = require('luxon');
const { getSettings, listConfiguredGuilds, claimReport, finishReport, getReport } = require('./db');
const { weekData, monthData } = require('./pnl');
const { renderWeekly, renderMonthly } = require('./renderer');
const { scanGuild } = require('./scanner');
const { formatDollars } = require('./money');

const GRACE_HOURS = 6;

function weeklyImage(guildId, anchorISO, settings) {
  const data = weekData(guildId, anchorISO, settings.timezone, settings.currency);
  const summary = `**Week ${data.weekNo}** · ${formatDollars(data.total, { symbol: settings.currency })} · ${data.trades ? `${data.winRate}% win rate · ${data.trades} trades` : 'no trades logged'}`;
  return { buffer: renderWeekly(data), name: `weekly-pnl-${data.start}.png`, summary, data };
}
function monthlyImage(guildId, year, month, settings) {
  const data = monthData(guildId, year, month, settings.timezone, settings.currency);
  const wr = data.tradedDays ? `${Math.round((100 * data.green) / data.tradedDays)}% green days` : 'no trades logged';
  const summary = `**${data.monthLabel.charAt(0)}${data.monthLabel.slice(1).toLowerCase()}** · ${formatDollars(data.total, { symbol: settings.currency })} · ${data.tradedDays} trading days · ${wr}`;
  return { buffer: renderMonthly(data), name: `monthly-pnl-${year}-${String(month).padStart(2, '0')}.png`, summary, data };
}

function reportMessage(img, settings, { late } = {}) {
  const c = new ContainerBuilder().setAccentColor(img.data.total > 0 ? 0x34d399 : img.data.total < 0 ? 0xf87171 : 0xfbbf24);
  if (settings.ping_role_id) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@&${settings.ping_role_id}>`));
  c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${img.name}`)));
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${img.summary}${late ? '\n-# posted late (bot was offline at the scheduled time)' : ''}`));
  return {
    components: [c], flags: MessageFlags.IsComponentsV2, files: [new AttachmentBuilder(img.buffer, { name: img.name })],
    allowedMentions: { parse: [], roles: settings.ping_role_id ? [settings.ping_role_id] : [] },
  };
}

async function sendReport(channel, img, settings, opts) {
  try { return await channel.send(reportMessage(img, settings, opts)); }
  catch (e) {
    if (/Missing (Permissions|Access)/i.test(e.message)) throw e;
    return channel.send({ content: `${settings.ping_role_id ? `<@&${settings.ping_role_id}> ` : ''}${img.summary}`, files: [new AttachmentBuilder(img.buffer, { name: img.name })],
      allowedMentions: { parse: [], roles: settings.ping_role_id ? [settings.ping_role_id] : [] } });
  }
}

/** Manual post (settings panel / /pnl). Not logged against schedule keys. */
async function postNow(guild, settings, kind, { anchorISO, year, month } = {}) {
  if (!settings.report_channel_id) throw new Error('No report channel is set (Settings → General).');
  const channel = await guild.channels.fetch(settings.report_channel_id).catch(() => null);
  if (!channel) throw new Error('The report channel no longer exists.');
  await scanGuild(guild, settings);
  const now = DateTime.now().setZone(settings.timezone);
  const img = kind === 'weekly' ? weeklyImage(guild.id, anchorISO || now.toISODate(), settings) : monthlyImage(guild.id, year || now.year, month || now.month, settings);
  return sendReport(channel, img, settings);
}

function isDue(now, hhmm, graceHours = GRACE_HOURS) {
  const [h, m] = hhmm.split(':').map(Number);
  const at = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const mins = now.diff(at, 'minutes').minutes;
  return { due: mins >= 0 && mins < graceHours * 60, late: mins > 10 };
}

/** Which jobs are due for these settings at `now` (pure; unit tested) */
function dueJobs(settings, now) {
  const jobs = [];
  if (settings.weekly_enabled && now.weekday === settings.weekly_day) {
    const d = isDue(now, settings.weekly_time);
    if (d.due) jobs.push({ kind: 'weekly', key: `weekly:${now.weekYear}-W${String(now.weekNumber).padStart(2, '0')}`, late: d.late });
  }
  if (settings.month_enabled && now.day === now.daysInMonth) {
    const d = isDue(now, settings.month_time);
    if (d.due) jobs.push({ kind: 'monthly', key: `monthly:${now.year}-${String(now.month).padStart(2, '0')}`, late: d.late });
  }
  return jobs;
}

async function runJob(client, guild, settings, job, now) {
  if (!settings.report_channel_id) return;
  if (!claimReport(guild.id, job.kind, job.key)) return;
  try {
    const channel = await guild.channels.fetch(settings.report_channel_id);
    await scanGuild(guild, settings);
    const img = job.kind === 'weekly' ? weeklyImage(guild.id, now.toISODate(), settings) : monthlyImage(guild.id, now.year, now.month, settings);
    const msg = await sendReport(channel, img, settings, { late: job.late });
    finishReport(guild.id, job.kind, job.key, { messageId: msg.id });
  } catch (e) {
    finishReport(guild.id, job.kind, job.key, { error: String(e.message).slice(0, 300) });
    const r = getReport(guild.id, job.kind, job.key);
    if (r && r.attempts >= 3) {
      const owner = (process.env.OWNER_ID || '').split(',')[0]?.trim();
      if (owner) client.users.send(owner, `⚠️ Journal ${job.kind} report for **${guild.name}** failed 3 times: ${e.message}`).catch(() => {});
    }
  }
}

let ticking = false;
async function tick(client) {
  if (ticking) return; ticking = true;
  try {
    for (const gid of listConfiguredGuilds()) {
      const guild = client.guilds.cache.get(gid); if (!guild) continue;
      const settings = getSettings(gid);
      const now = DateTime.now().setZone(settings.timezone);
      for (const job of dueJobs(settings, now)) await runJob(client, guild, settings, job, now); // weekly first, then monthly
    }
  } finally { ticking = false; }
}

module.exports = { weeklyImage, monthlyImage, postNow, sendReport, dueJobs, isDue, tick, reportMessage };
