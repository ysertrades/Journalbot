'use strict';
process.env.JOURNAL_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `modals-${process.pid}.sqlite`);
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/lib/panels');

const OUTCOMES = ['win', 'loss', 'be', 'missed'];
const mk = (outcome) => ({ id: 'abcd1234', outcome, fields: { instrument: 'NQ', date: '2026-10-16', pnl_cents: 100, why: 'x' } });

function allModals() {
  const out = [];
  for (const o of OUTCOMES) for (const [k, fn] of [['trade', p.tradeModal], ['result', p.resultModal], ['notes', p.notesModal]]) out.push([`${o}/${k}`, fn(mk(o)).toJSON()]);
  out.push(['pic', p.pictureModal(mk('win')).toJSON()]);
  for (const [k, title] of [['wtime', 'Weekly time'], ['tz', 'Timezone'], ['cur', 'Currency symbol']]) out.push([`simple/${k}`, p.simpleModal(`jsm:x:${k}`, title, 'Value', '17:00', '17:00', 5).toJSON()]);
  return out;
}

test('every modal respects Discord limits (<=5 components, title/label/placeholder lengths, custom_id)', () => {
  for (const [name, m] of allModals()) {
    assert.ok(m.components.length >= 1 && m.components.length <= 5, `${name}: ${m.components.length} components`);
    assert.ok(m.title.length <= 45, `${name}: title too long`);
    assert.ok(m.custom_id.length <= 100);
    for (const l of m.components) {
      assert.equal(l.type, 18, `${name}: top level must be Labels`);
      assert.ok(l.label.length <= 45, `${name}: label "${l.label}" is ${l.label.length} chars`);
      if (l.description) assert.ok(l.description.length <= 100, `${name}: description too long`);
      const c = l.component;
      if (c.placeholder) assert.ok(c.placeholder.length <= 100, `${name}: placeholder too long`);
      if (c.type === 4) { assert.ok(!c.value || c.value.length <= c.max_length, `${name}: value exceeds max_length`); }
    }
  }
});

test('modal select menus that allow zero choices are explicitly optional (otherwise Discord rejects the modal)', () => {
  let selects = 0;
  for (const [name, m] of allModals()) for (const l of m.components) {
    const c = l.component;
    if (c.type === 3) { selects += 1; if (c.min_values === 0) assert.equal(c.required, false, `${name}: select "${c.custom_id}" needs required:false`); assert.ok(c.options.length <= 25); }
  }
  assert.ok(selects >= 3);
});

test('panels stay under the 40 component Discord limit', () => {
  const count = (n) => 1 + (n.components ? n.components.reduce((s, c) => s + count(c), 0) : 0) + (n.accessory ? 1 : 0);
  const g = { emojis: { cache: { find: () => undefined } } };
  const { DEFAULTS } = require('../src/lib/db');
  const s = { ...DEFAULTS, forums: ['1'], allowed_users: ['1'] };
  for (const o of [null, ...OUTCOMES]) assert.ok(count(p.journalPanel({ ...mk(o), forumId: '1', image: { name: 'a.png' } }, g, s).toJSON()) <= 40);
  for (const pg of ['general', 'schedule', 'advanced']) assert.ok(count(p.settingsPanel(pg, s, ['x']).toJSON()) <= 40, pg);
});
