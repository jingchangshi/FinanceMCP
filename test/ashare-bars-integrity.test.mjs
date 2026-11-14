import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const build = process.env.ASHARE_TEST_BUILD ? pathToFileURL(resolve(process.env.ASHARE_TEST_BUILD) + '/').href : new URL('../build/', import.meta.url).href;
const { forEachStockBars } = await import(new URL('ashare/bars.js', build));
const { computeIndicators } = await import(new URL('ashare/indicators.js', build));

function load(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily (ts_code TEXT, trade_date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL);
    CREATE TABLE adj_factor (ts_code TEXT, trade_date TEXT, adj_factor REAL);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);`);
  const daily = db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const factor = db.prepare('INSERT INTO adj_factor VALUES (?, ?, ?)');
  rows.forEach((r, i) => {
    const date = String(20200101 + i);
    daily.run('X', date, r.open ?? null, r.high ?? null, r.low ?? null, r.close ?? null, 100, 1000);
    if (r.factor !== undefined) factor.run('X', date, r.factor);
  });
  let result;
  forEachStockBars(db, '19000101', '99999999', (_, bars) => { result = bars; }, ['X']);
  db.close();
  return result;
}

const row = (close = 10, factor = 1) => ({ open: close, high: close + 1, low: close - 1, close, factor });

test('an omitted selection scans the universe while an empty selection scans nothing', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE stock_basic (ts_code TEXT);
    INSERT INTO stock_basic VALUES ('X');
    CREATE TABLE daily (ts_code TEXT, trade_date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL);
    INSERT INTO daily VALUES ('X', '20200101', 10, 11, 9, 10, 100, 1000);
    CREATE TABLE adj_factor (ts_code TEXT, trade_date TEXT, adj_factor REAL);
    INSERT INTO adj_factor VALUES ('X', '20200101', 1);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);`);
  const found = [];
  assert.equal(forEachStockBars(db, '20200101', '20200101', code => found.push(code)), 1);
  assert.deepEqual(found, ['X']);
  assert.equal(forEachStockBars(db, '20200101', '20200101', () => assert.fail('empty selection scanned a stock'), []), 0);
  db.close();
});

test('SQL NULL OHLC stays unknown in raw and adjusted bars', () => {
  const keys = ['open', 'high', 'low', 'close'];
  for (const key of keys) {
    const bars = load([{ ...row(), [key]: null }]);
    const raw = `raw${key[0].toUpperCase()}${key.slice(1)}`;
    assert.ok(Number.isNaN(bars[key][0]), key);
    assert.ok(Number.isNaN(bars[raw][0]), raw);
    for (const other of keys.filter(k => k !== key)) assert.ok(Number.isFinite(bars[other][0]));
  }
});

test('missing and invalid factors never fabricate adjusted prices or bridge gaps', () => {
  const bars = load([row(10, 2), { ...row(11), factor: undefined }, row(12, 0), row(13, -1), row(14, 4)]);
  assert.equal(bars.adjMissing, 3);
  assert.deepEqual(bars.close, [5, NaN, NaN, NaN, 14]);
  assert.deepEqual(bars.rawClose, [10, 11, 12, 13, 14]);
  const allMissing = load([{ ...row(), factor: undefined }]);
  assert.equal(allMissing.adjMissing, 1);
  assert.ok(Number.isNaN(allMissing.close[0]));
});

test('bad close does not become a zero or get bridged by indicators', () => {
  const rows = Array.from({ length: 40 }, () => row());
  rows[10].close = null;
  const bars = load(rows);
  const indicators = computeIndicators(bars);
  assert.equal(indicators.ma5[9], 10);
  assert.ok(Number.isNaN(bars.close[10]));
  assert.ok(Number.isNaN(indicators.ma5[10]));
  assert.ok(Number.isNaN(indicators.ma5[39]));
});

test('complete history preserves qfq numerical values', () => {
  const bars = load([row(10, 2), row(12, 3), row(14, 4)]);
  assert.equal(bars.adjMissing, 0);
  assert.deepEqual(bars.close, [5, 9, 14]);
  assert.deepEqual(bars.high, [5.5, 9.75, 15]);
  assert.deepEqual(bars.rawClose, [10, 12, 14]);
});
