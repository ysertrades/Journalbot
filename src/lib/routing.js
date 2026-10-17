'use strict';
/**
 * Where an outcome is posted.
 *  - { forumId, threadId }  threadId set: add the trade as a message inside that existing post
 *  - { forumId, threadId: null }  create a new post in that forum
 *  - null  nothing configured
 */
function routeTarget(settings, outcome) {
  const t = outcome && settings.outcome_threads?.[outcome];
  if (t?.thread) return { forumId: t.forum || null, threadId: t.thread };
  const f = (outcome && settings.outcome_forums?.[outcome]) || settings.default_forum_id || null;
  return f ? { forumId: f, threadId: null } : null;
}
const routeForum = (settings, outcome) => routeTarget(settings, outcome)?.forumId || null;

/** Existing posts used as per-outcome destinations: { threadId: [outcomes...] } */
function ledgerThreads(settings) {
  const out = {};
  for (const [o, t] of Object.entries(settings.outcome_threads || {})) if (t?.thread) (out[t.thread] ||= []).push(o);
  return out;
}

/** Every forum the bot scans for PnL: extra forums + each outcome forum/post's forum + the default forum */
function allForums(settings) {
  return [...new Set([
    ...(settings.forums || []), ...Object.values(settings.outcome_forums || {}),
    ...Object.values(settings.outcome_threads || {}).map((t) => t?.forum), settings.default_forum_id,
  ].filter(Boolean))];
}
module.exports = { routeTarget, routeForum, ledgerThreads, allForums };
