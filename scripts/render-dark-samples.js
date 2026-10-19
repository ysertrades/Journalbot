'use strict';
// Renders every sample card in the Night theme as tmp-samples/dark-*.png, plus the Appearance swatch.
// Reuses the light sample scripts: their render calls are pointed at the dark theme and their files renamed.
const fs = require('node:fs');
const path = require('node:path');
const r = require('../src/lib/renderer');
const base = { ...r };
r.renderWeekly = (d) => base.renderWeekly(d, { theme: 'dark' });
r.renderMonthly = (d) => base.renderMonthly(d, { theme: 'dark' });
r.renderDaily = (d) => base.renderDaily(d, { theme: 'dark' });
r.renderTrades = (d, p) => base.renderTrades(d, p, { theme: 'dark' });
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => write(path.join(path.dirname(file), `dark-${path.basename(file)}`), ...rest);
require('./render-samples');
require('./render-trades-samples');
fs.writeFileSync = write;

// the Appearance page preview, for a green day, in each mode
const T = (instrument, direction, outcome, pnl) => ({ instrument, direction, outcome, pnl, r: null, at: 0 });
const trades = [T('NQ', 'Long', 'win', 1240), T('ES', 'Short', 'loss', -310), T('NQ', 'Long', 'win', 980), T('YM', 'Short', 'win', 240)];
const day = { kind: 'daily', symbol: '$', weekday: 'Thursday', dateLabel: 'OCT 15, 2026', trades, total: 2150, count: 4, w: 3, l: 1, be: 0, missed: 0, winRate: 75, rSum: null,
  best: trades[0], week: [], weekTotal: 2910 };
const out = path.join(__dirname, '..', 'tmp-samples');
for (const m of ['light', 'dark', 'auto']) write(path.join(out, `swatch-${m}.png`), r.renderThemeSwatch(day, m));
console.log('dark samples and swatches rendered');
