'use strict';
// Renders sample prop account dashboards (eval in progress, eval passed, breached, funded) to tmp-samples/account-*.png, light and dark.
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'account-samples.sqlite');
const fs = require('node:fs'), path = require('node:path');
const { renderAccount } = require('../src/lib/renderer');
const { computeAccount, rulesFromTemplate, badge, label } = require('../src/lib/accounts');
const out = path.join(__dirname, '..', 'tmp-samples'); fs.mkdirSync(out, { recursive: true });

const acct = (o) => ({ id: 1, chain_id: 1, guild_id: 'g', name: '100K Hyperprop', firm: 'Hyperprop', phase: 'eval', status: 'active', attempt: 2, size_cents: 10000000,
  start_balance_cents: 10000000, balance_adj_cents: 0, started_on: '2026-10-05', ...rulesFromTemplate(o.phase || 'eval', 10000000), consistency_pct: 30, ...o });
let n = 0;
const rows = (list) => list.map(([date, pnl]) => ({ thread_id: `k${++n}`, date_local: date, outcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be', pnl_cents: pnl * 100, updated_at: n }));
const chainEval = [{ id: 0, phase: 'eval', attempt: 1, status: 'breached' }];
function draw(name, a, list, extra = {}) {
  const payouts = extra.payouts || [];
  const state = computeAccount(a, rows(list), { payouts, today: extra.today || list.at(-1)?.[0] });
  const view = { account: a, state, payouts, chain: extra.chain || [...chainEval, a], badge: badge(a), title: label(a), symbol: '$' };
  for (const theme of ['light', 'dark']) fs.writeFileSync(path.join(out, `account-${name}${theme === 'dark' ? '-dark' : ''}.png`), renderAccount(view, { theme }));
  return state;
}
const s1 = draw('eval', acct({}), [['2026-10-05', 820], ['2026-10-05', -310], ['2026-10-06', 1450], ['2026-10-07', -690], ['2026-10-08', 1240], ['2026-10-09', 610], ['2026-10-12', -420]]);
const s2 = draw('passed', acct({}), [['2026-10-05', 1820], ['2026-10-06', 1450], ['2026-10-07', -690], ['2026-10-08', 1240], ['2026-10-09', 1610], ['2026-10-12', 1100]]);
const s3 = draw('breached', acct({}), [['2026-10-05', 620], ['2026-10-06', -900], ['2026-10-06', -1200], ['2026-10-07', 300]]);
const f = acct({ id: 2, phase: 'funded', attempt: 1, started_on: '2026-10-13', split_pct: 80, target_cents: null, min_days: null, consistency_pct: null });
const s4 = draw('funded', f, [['2026-10-13', 940], ['2026-10-14', -380], ['2026-10-15', 1210], ['2026-10-16', 520]],
  { payouts: [{ amount_cents: 100000 }], chain: [{ id: 0, phase: 'eval', attempt: 1, status: 'breached' }, { id: 9, phase: 'eval', attempt: 2, status: 'passed' }, f] });
console.log({ eval: [s1.balance, s1.floor, s1.passReady], passed: [s2.passReady, s2.consistencyShare], breached: s3.breach, funded: [s4.balance, s4.yourShare] });
