'use strict';
const { getSettings } = require('./db');
const { scanThread } = require('./scanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function maybeScan(thread, delay = 0) {
  if (!thread?.guildId || !thread.parentId) return;
  const s = getSettings(thread.guildId);
  if (!s.forums.includes(thread.parentId)) return;
  if (delay) await sleep(delay);
  await scanThread(thread, s, { force: true }).catch(() => {});
}
module.exports = { maybeScan };
