'use strict';
/** Forum a given outcome posts to: its own forum if set, else the default forum, else null */
function routeForum(settings, outcome) {
  return (outcome && settings.outcome_forums?.[outcome]) || settings.default_forum_id || null;
}
/** Every forum the bot should scan for PnL: extra forums + each outcome forum + the default forum */
function allForums(settings) {
  return [...new Set([...(settings.forums || []), ...Object.values(settings.outcome_forums || {}), settings.default_forum_id].filter(Boolean))];
}
module.exports = { routeForum, allForums };
