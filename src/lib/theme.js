'use strict';
const { DateTime } = require('luxon');

/**
 * The card theme a server picked in /journal-settings → Appearance:
 *  light: Studio, the landing page look
 *  dark:  Night, graphite floor and glowing cards
 *  auto:  Studio by day, Night from 19:00 to 07:00 in the server's timezone
 */
const THEME_CHOICES = {
  light: { label: 'Studio', emoji: '☀️', desc: 'Bright floor, soft grid, dark glass cards. The landing page look.' },
  dark:  { label: 'Night', emoji: '\u{1F319}', desc: 'Graphite floor, an aurora in the day’s colour, cards that glow.' },
  auto:  { label: 'Auto', emoji: '\u{1F317}', desc: 'Studio by day, Night after 7 pm, in your timezone.' },
};
const NIGHT_FROM = 19, NIGHT_TO = 7;

/** 'light' | 'dark' for a card drawn now (or at `now`) */
function resolveTheme(settings, now = DateTime.now()) {
  const t = settings?.theme;
  if (t === 'dark' || t === 'light') return t;
  if (t !== 'auto') return 'light';
  const h = now.setZone(settings.timezone || 'America/New_York').hour;
  return h >= NIGHT_FROM || h < NIGHT_TO ? 'dark' : 'light';
}

module.exports = { THEME_CHOICES, resolveTheme, NIGHT_FROM, NIGHT_TO };
