'use strict';
/**
 * CSV trade import: reads a broker / prop-firm export and turns each closed
 * trade into a journal entry.
 *
 * It does not assume one format. Columns are found by name, with the names
 * Hyperprop, Tradovate, NinjaTrader, TopstepX, Rithmic-style and most
 * spreadsheets use (symbol / contract / instrument, side / direction / buy-sell,
 * qty, entry & exit price, entry & exit time, pnl / net pnl / profit, fees,
 * commission). Delimiter (, ; tab), quotes, a BOM, "$1,250.00", "(480.00)" and
 * "−480" are all handled. Rows it can't read are counted and explained, never
 * guessed at.
 */
const crypto = require('node:crypto');
const { DateTime } = require('luxon');

const MAX_ROWS = 1000;

/* ---------------------------------- csv ---------------------------------- */
function detectDelimiter(firstLine) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, (firstLine.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ',';
}
/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  // judged on the first few lines: a one-cell title line above the header is common
  const d = detectDelimiter(s.split(/\r?\n/).slice(0, 6).join('\n'));
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

/* -------------------------------- columns -------------------------------- */
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const COLS = {
  tradeId:   ['tradeid', 'id', 'roundtripid', 'positionid', 'positiongroup', 'ticket', 'dealid', 'tradenumber', 'tradeno', 'pairid'],
  symbol:    ['symbol', 'instrument', 'contract', 'ticker', 'market', 'product', 'contractname', 'root'],
  side:      ['side', 'direction', 'type', 'buysell', 'action', 'position', 'longshort', 'tradetype', 'entryside'],
  qty:       ['qty', 'quantity', 'size', 'contracts', 'lots', 'volume', 'paireqty', 'filledqty'],
  entry:     ['entryprice', 'entry', 'openprice', 'avgentry', 'avgentryprice', 'priceopen', 'entryavg', 'avgopenprice'],
  exit:      ['exitprice', 'exit', 'closeprice', 'avgexit', 'avgexitprice', 'priceclose', 'exitavg', 'avgcloseprice'],
  buyPrice:  ['buyprice', 'avgbuyprice', 'boughtprice'],
  sellPrice: ['sellprice', 'avgsellprice', 'soldprice'],
  entryTime: ['entrytime', 'opentime', 'opened', 'openedat', 'entrydate', 'entrydatetime', 'timeopen', 'opendate', 'entrytimestamp', 'starttime'],
  exitTime:  ['exittime', 'closetime', 'closed', 'closedat', 'exitdate', 'exitdatetime', 'timeclose', 'closedate', 'exittimestamp', 'endtime'],
  boughtTime:['boughttimestamp', 'boughttime', 'buytime', 'buydate'],
  soldTime:  ['soldtimestamp', 'soldtime', 'selltime', 'selldate'],
  date:      ['date', 'tradedate', 'day', 'time', 'timestamp', 'datetime'],
  netPnl:    ['netpnl', 'netpl', 'netprofit', 'netprofitloss', 'realizednetpnl', 'netrealizedpnl', 'pnlnet', 'net'],
  pnl:       ['pnl', 'pl', 'profit', 'profitloss', 'realizedpnl', 'realizedpl', 'grosspnl', 'grosspl', 'result', 'amount', 'gain', 'pnlusd', 'pnl$'],
  fee:       ['fee', 'fees', 'exchangefee', 'exchangefees', 'liquidationfee', 'clearingfee', 'nfafee'],
  commission:['commission', 'commissions', 'comm', 'brokerage'],
};
function mapColumns(header) {
  const h = header.map(norm), used = new Set(), map = {}, feeCols = [];
  for (const [key, names] of Object.entries(COLS)) {
    if (key === 'fee' || key === 'commission') {
      h.forEach((x, i) => { if (!used.has(i) && names.includes(x)) { feeCols.push(i); used.add(i); } });
      continue;
    }
    const i = h.findIndex((x, j) => !used.has(j) && names.includes(x));
    if (i >= 0) { map[key] = i; used.add(i); }
  }
  map.fees = feeCols;
  return map;
}

/* --------------------------------- values -------------------------------- */
/** "$1,250.00" "(480)" "−480" "-$12.5" "1.250,00 €" -> number or null */
function num(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s || /^[-–—]$/.test(s)) return null;
  let neg = false;
  s = s.replace(/[\s$€£¥]|USD|EUR|GBP/gi, '');                                           // $(16.00) and (16.00) USD
  if (/^-?\(.*\)$/.test(s)) { neg = true; s = s.replace(/[()]/g, ''); }
  s = s.replace(/[−–—]/g, '-').replace(/[^\d.,\-+eE]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 1.250,00
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');                             // 12,50
  else s = s.replace(/,/g, '');
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const TIME_FORMATS = ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd', 'M/d/yyyy H:mm:ss', 'M/d/yyyy H:mm', 'M/d/yyyy h:mm:ss a', 'M/d/yyyy h:mm a',
  'M/d/yyyy', 'MM/dd/yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd.MM.yyyy', 'd MMM yyyy HH:mm', 'd MMM yyyy', 'MMM d, yyyy h:mm a', 'MMM d, yyyy', 'yyyyMMdd HHmmss', 'yyyyMMdd'];
/** -> DateTime in tz, or null */
function when(v, tz) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); return DateTime.fromMillis(s.length === 13 ? n : n * 1000, { zone: tz }); }
  let d = DateTime.fromISO(s, { zone: tz, setZone: false });
  if (d.isValid) return d.setZone(tz);
  const t = s.replace(/\s+(UTC|GMT|[A-Z]{2,4}T)$/, '');
  for (const f of TIME_FORMATS) { d = DateTime.fromFormat(t, f, { zone: tz, locale: 'en' }); if (d.isValid) return d; }
  return null;
}
/** NQZ5 / MNQH26 / NQU6 -> NQ / MNQ; leaves plain symbols alone */
function rootSymbol(s) {
  const u = String(s || '').toUpperCase().replace(/^[@/]/, '').replace(/\s.*$/, '').replace(/[^A-Z0-9.!]/g, '');
  const m = /^([A-Z]{1,4})[FGHJKMNQUVXZ]\d{1,2}$/.exec(u);
  return (m ? m[1] : u).slice(0, 12);
}
function sideOf(v) {
  const s = String(v || '').toLowerCase();
  if (/^(l|long|buy|b|bot|bought|buy to open)$/.test(s) || /\blong\b|\bbuy\b/.test(s)) return 'Long';
  if (/^(s|short|sell|sld|sold|sell short|sell to open)$/.test(s) || /\bshort\b|\bsell\b/.test(s)) return 'Short';
  return null;
}
const fmtPrice = (n) => (n === null || n === undefined ? null : String(Number(n.toFixed(6))));
function duration(ms) {
  if (!(ms > 0)) return null;
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

/* -------------------------------- trades --------------------------------- */
/**
 * @returns {{ trades, skipped: [{row, why}], format, columns, total }}
 *   trades: [{ hash, outcome, instrument, direction, qty, entry, exit, date, at, pnl_cents, fee_cents, held }]
 */
function readTrades(text, tz) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { trades: [], skipped: [], columns: [], error: 'That file has no trade rows.' };
  // the header is the first row with at least two recognised column names
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const m = mapColumns(rows[i]);
    if (Object.keys(m).filter((k) => k !== 'fees').length >= 2) { hi = i; break; }
  }
  const header = rows[hi], m = mapColumns(header);
  const hasPnl = m.netPnl !== undefined || m.pnl !== undefined;
  const hasPrices = (m.entry !== undefined && m.exit !== undefined) || (m.buyPrice !== undefined && m.sellPrice !== undefined);
  if (m.symbol === undefined || !hasPnl) {
    const miss = [m.symbol === undefined && 'a symbol / instrument column', !hasPnl && 'a PnL / profit column'].filter(Boolean).join(' and ');
    return { trades: [], skipped: [], columns: header, error: `Could not find ${miss}. Found columns: ${header.slice(0, 12).join(', ')}` };
  }
  const trades = [], skipped = [], seen = new Set();
  const body = rows.slice(hi + 1, hi + 1 + MAX_ROWS);
  body.forEach((r, k) => {
    const rowNo = hi + 2 + k, get = (key) => (m[key] === undefined ? '' : r[m[key]]);
    if (/^(total|totals|summary|sum)\b/i.test(r[0] || '')) return;   // a totals line at the bottom
    const instrument = rootSymbol(get('symbol'));
    if (!instrument) return skipped.push({ row: rowNo, why: 'no symbol' });
    // money: a net column wins; otherwise PnL minus any fee / commission columns
    let pnl = num(get('netPnl')), feesTotal = 0;
    if (pnl === null) {
      pnl = num(get('pnl'));
      if (pnl === null) return skipped.push({ row: rowNo, why: 'no PnL value' });
      for (const fi of m.fees) { const f = num(r[fi]); if (f) feesTotal += Math.abs(f); }
      pnl -= feesTotal;
    }
    // prices, side and times; Tradovate-style files give buy/sell instead of entry/exit
    let entry = num(get('entry')), exit = num(get('exit'));
    let side = sideOf(get('side'));
    let tIn = when(get('entryTime'), tz), tOut = when(get('exitTime'), tz);
    if (m.buyPrice !== undefined && m.sellPrice !== undefined) {
      const bp = num(get('buyPrice')), sp = num(get('sellPrice')), bt = when(get('boughtTime'), tz), st = when(get('soldTime'), tz);
      const longFirst = bt && st ? bt <= st : side !== 'Short';
      side = side || (longFirst ? 'Long' : 'Short');
      if (entry === null) entry = longFirst ? bp : sp;
      if (exit === null) exit = longFirst ? sp : bp;
      if (!tIn && bt && st) tIn = longFirst ? bt : st;
      if (!tOut && bt && st) tOut = longFirst ? st : bt;
    }
    if (!side && entry !== null && exit !== null && pnl) side = (exit > entry) === (pnl > 0) ? 'Long' : 'Short';
    const tDay = tOut || tIn || when(get('date'), tz);
    if (!tDay) return skipped.push({ row: rowNo, why: 'no date' });
    const qty = num(get('qty'));
    const cents = Math.round(pnl * 100);
    const outcome = Math.abs(cents) < 1 ? 'be' : cents > 0 ? 'win' : 'loss';
    const hash = crypto.createHash('sha1').update([instrument, side, qty, entry, exit, tIn?.toMillis(), tOut?.toMillis() || tDay.toISODate(), cents].join('|')).digest('hex').slice(0, 20);
    // Identity keys for spotting the same trade in a later export, which is rarely byte-identical:
    //  id:  the broker's own trade id, when the file has one (strongest)
    //  fp:  symbol + side + size + entry/exit times to the minute (survives rounding, fee changes, seconds dropped)
    //  day: symbol + side + day + PnL to the dollar (for PnL-only files without times)
    const H = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
    const ext = String(get('tradeId') || '').trim();
    const minute = (d) => (d ? d.toUTC().toFormat("yyyy-MM-dd'T'HH:mm") : '');
    const keys = [hash];
    if (ext) keys.push(`id:${H(`${ext}|${instrument}`)}`);
    if (tIn || tOut) keys.push(`fp:${H([instrument, side || '', qty !== null ? Math.abs(qty) : '', minute(tIn), minute(tOut)].join('|'))}`);
    else keys.push(`day:${H([instrument, side || '', tDay.toISODate(), Math.round(cents / 100)].join('|'))}`);
    if (seen.has(hash)) return skipped.push({ row: rowNo, why: 'duplicate row in the file' });
    seen.add(hash);
    trades.push({
      hash, keys, extId: ext || null, outcome, instrument, direction: side || 'Long', qty: qty !== null ? Math.abs(qty) : null,
      entry: fmtPrice(entry), exit: fmtPrice(exit), date: tDay.toISODate(), at: tDay.toMillis(), opened: tIn ? tIn.toMillis() : null,
      pnl_cents: cents, fee_cents: Math.round(feesTotal * 100), held: tIn && tOut ? duration(tOut.toMillis() - tIn.toMillis()) : null,
      sideGuessed: !side,
    });
  });
  trades.sort((a, b) => a.at - b.at);
  const format = m.buyPrice !== undefined ? 'buy / sell columns' : hasPrices ? 'entry / exit columns' : 'PnL only';
  return { trades, skipped, columns: header, format, truncated: rows.length - hi - 1 > MAX_ROWS };
}

/** journal fields for one imported trade, in the shape postJournal expects */
function toFields(t, { tag } = {}) {
  const bits = [t.qty ? `${t.qty} contract${t.qty === 1 ? '' : 's'}` : null, t.exit ? `exit ${t.exit}` : null, t.held ? `held ${t.held}` : null, t.fee_cents ? `fees $${(t.fee_cents / 100).toFixed(2)}` : null];
  return {
    instrument: t.instrument, direction: t.direction, date: t.date, entry: t.entry || undefined, exit: t.exit || undefined,
    pnl_cents: t.pnl_cents, _at: t.opened || t.at, _qty: t.qty || undefined, _held: t.held || undefined, setup: tag || 'Imported from CSV', why: `Imported · ${bits.filter(Boolean).join(' · ') || 'from your CSV'}`,
  };
}

/** a one-line chart of the running PnL, ▁▂▃▄▅▆▇█ */
function sparkline(values, width = 24) {
  if (!values.length) return '';
  const pts = values.length > width ? Array.from({ length: width }, (_, i) => values[Math.round((i * (values.length - 1)) / (width - 1))]) : values;
  const lo = Math.min(...pts), hi = Math.max(...pts), bars = '▁▂▃▄▅▆▇█';
  return pts.map((v) => bars[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

module.exports = { parseCsv, readTrades, toFields, sparkline, num, when, rootSymbol, sideOf, MAX_ROWS };
