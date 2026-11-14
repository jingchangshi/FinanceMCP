import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { computeRps, rpsFromCloses } from '../build/ashare/rps.js';

test('RPS excludes stale and unadjusted stocks and reports each window denominator', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE stock_basic (ts_code TEXT);
    CREATE TABLE daily (ts_code TEXT, trade_date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL);
    CREATE TABLE adj_factor (ts_code TEXT, trade_date TEXT, adj_factor REAL);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);`);
  const daily = db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
  const adj = db.prepare('INSERT INTO adj_factor VALUES (?, ?, 1)');
  const basic = db.prepare('INSERT INTO stock_basic VALUES (?)');
  for (const code of ['strong', 'weak', 'stale', 'short', 'unadjusted', 'empty']) basic.run(code);
  const dates = Array.from({ length: 122 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1 + i));
    return d.toISOString().slice(0, 10).replaceAll('-', '');
  });
  for (const [i, date] of dates.entries()) {
    for (const code of ['strong', 'weak', 'stale', 'short', 'unadjusted']) {
      if ((code === 'stale' && i === 121) || (code === 'short' && i < 61)) continue;
      const price = code === 'strong' ? 10 + i : code === 'stale' ? 100 + i * 10 : 10;
      daily.run(code, date, price, price, price, price);
      if (!(code === 'unadjusted' && i === 1)) adj.run(code, date);
    }
  }
  const result = computeRps(db, dates[0], dates.at(-1));
  assert.deepEqual(result.quality, { requested: 6, no_bars: 1, stale: 1, adj_missing: 1 });
  assert.deepEqual(result.denominators, { 60: 3, 120: 2, 250: 0 });
  assert.equal(result.rows.get('strong').rps[120], 100);
  assert.equal(result.rows.get('weak').rps[120], 0);
  assert.equal(result.rows.get('short').rps[120], null);
  assert.equal(result.rows.has('stale'), false);
  assert.equal(result.rows.has('unadjusted'), false);
  db.close();
});

test('RPS keeps unavailable and nonfinite returns out of denominators', () => {
  const result = rpsFromCloses(new Map([
    ['unknown', Array(61).fill(0)],
    ['overflow', [Number.MIN_VALUE, ...Array(59).fill(1), Number.MAX_VALUE]],
  ]));
  assert.deepEqual(result.denominators, { 60: 0, 120: 0, 250: 0 });
  assert.equal(result.rows.get('unknown').ret[60], null);
  assert.equal(result.rows.get('overflow').rps[60], null);
  assert.equal(result.quality, null);
});
