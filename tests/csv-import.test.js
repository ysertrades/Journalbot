'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readTrades, num, rootSymbol, sideOf, toFields, sparkline } = require('../src/lib/csv-import');
const TZ = 'America/New_York';

test('money: currency, commas, parentheses, unicode minus, european decimals', () => {
  assert.equal(num('$1,250.00'), 1250);
  assert.equal(num('(480.00)'), -480);
  assert.equal(num('−480'), -480);
  assert.equal(num('-$12.50'), -12.5);
  assert.equal(num('1.250,50'), 1250.5);
  assert.equal(num('12,5'), 12.5);
  assert.equal(num(''), null); assert.equal(num('-'), null); assert.equal(num('abc'), null);
});
test('symbols and sides', () => {
  assert.equal(rootSymbol('NQZ5'), 'NQ'); assert.equal(rootSymbol('MNQH26'), 'MNQ'); assert.equal(rootSymbol('ES'), 'ES'); assert.equal(rootSymbol('/ESU6 CME'), 'ES');
  assert.equal(sideOf('long'), 'Long'); assert.equal(sideOf('Sell'), 'Short'); assert.equal(sideOf('BUY'), 'Long'); assert.equal(sideOf('??'), null);
});

test('Hyperprop-style round trips: gross pnl minus fee and commission', () => {
  const csv = [
    'id,account_id,contract,product,symbol,side,quantity,entry_price,entry_time,exit_price,exit_time,pnl,gross_pnl,fee,commission',
    't1,a,NQU6,CME,NQ,long,2,21480.25,2026-10-15T13:31:05Z,21510.25,2026-10-15T13:45:00Z,1200,1200,2.10,3.00',
    't2,a,ESU6,CME,ES,short,1,5912,2026-10-15T14:02:00Z,5920,2026-10-15T14:10:00Z,-400,-400,1.05,1.50',
    't3,a,NQU6,CME,NQ,long,1,21500,2026-10-15T15:00:00Z,21500,2026-10-15T15:01:00Z,0,0,0,0',
  ].join('\n');
  const r = readTrades(csv, TZ);
  assert.equal(r.error, undefined);
  assert.equal(r.trades.length, 3);
  const [a, b, c] = r.trades;
  assert.equal(a.instrument, 'NQ'); assert.equal(a.direction, 'Long'); assert.equal(a.qty, 2); assert.equal(a.outcome, 'win');
  assert.equal(a.pnl_cents, 119490); assert.equal(a.fee_cents, 510); assert.equal(a.date, '2026-10-15'); assert.equal(a.held, '13m 55s');
  assert.equal(b.outcome, 'loss'); assert.equal(b.direction, 'Short'); assert.equal(b.pnl_cents, -40255);
  assert.equal(c.outcome, 'be');
});
test('Tradovate-style performance export: buy/sell prices and timestamps', () => {
  const csv = [
    'symbol,_priceFormat,_priceFormatType,_tickSize,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp,duration',
    'MNQZ5,-2,0,0.25,1,2,3,21000.00,21010.50,"$63.00",10/14/2026 09:31:02,10/14/2026 09:40:10,9min',
    'MNQZ5,-2,0,0.25,3,4,1,21020.00,21012.00,$(16.00),10/14/2026 10:05:00,10/14/2026 10:01:00,4min',
  ].join('\r\n');
  const r = readTrades(csv, TZ);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].direction, 'Long'); assert.equal(r.trades[0].entry, '21000'); assert.equal(r.trades[0].pnl_cents, 6300);
  assert.equal(r.trades[1].direction, 'Short'); assert.equal(r.trades[1].entry, '21012'); assert.equal(r.trades[1].pnl_cents, -1600);   // sold first
  assert.equal(r.trades[0].instrument, 'MNQ');
});
test('semicolons, a BOM, a preamble line, a totals row, duplicates and bad rows', () => {
  const csv = '﻿Account report generated 2026-10-16\nDate;Instrument;Direction;Net P&L\n'
    + '2026-10-13;ES;Long;250\n2026-10-13;ES;Long;250\n;NQ;Short;100\n2026-10-14;YM;Short;abc\nTotal;;;600\n';
  const r = readTrades(csv, TZ);
  assert.equal(r.trades.length, 1);
  assert.deepEqual(r.skipped.map((s) => s.why).sort(), ['duplicate row in the file', 'no PnL value', 'no date'].sort());
});
test('a file without the needed columns says what is missing', () => {
  const r = readTrades('foo,bar\n1,2\n', TZ);
  assert.equal(r.trades.length, 0); assert.match(r.error, /symbol|PnL/);
  assert.match(readTrades('', TZ).error, /no trade rows/);
});
test('toFields fills what the journal post needs, and the sparkline draws', () => {
  const r = readTrades('symbol,side,qty,entry,exit,exit_time,pnl\nNQ,long,1,100,110,2026-10-15 10:00,200\n', TZ);
  const f = toFields(r.trades[0], { tag: 'Hyperprop' });
  assert.equal(f.instrument, 'NQ'); assert.equal(f.direction, 'Long'); assert.equal(f.date, '2026-10-15'); assert.equal(f.pnl_cents, 20000);
  assert.equal(f.setup, 'Hyperprop'); assert.match(f.why, /1 contract · exit 110/);
  assert.equal(sparkline([0, 1, 2, 3]).length, 4); assert.equal(sparkline([]), '');
});
