import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const build = process.env.ASHARE_TEST_BUILD ? pathToFileURL(resolve(process.env.ASHARE_TEST_BUILD) + '/').href : new URL('../build/', import.meta.url).href;
const { forEachStockBars } = await import(new URL('ashare/bars.js', build));
const { computeIndicators } = await import(new URL('ashare/indicators.js', build));
const { analyzeTechnicalV2 } = await import(new URL('ashare/technicalCandidatesV2.js', build));

function createDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily (ts_code TEXT, trade_date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL);
    CREATE TABLE adj_factor (ts_code TEXT, trade_date TEXT, adj_factor REAL);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);`);
  const daily = db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const factor = db.prepare('INSERT INTO adj_factor VALUES (?, ?, ?)');
  rows.forEach((r, i) => {
    const date = r.date ?? String(20200101 + i);
    daily.run('X', date, r.open ?? null, r.high ?? null, r.low ?? null, r.close ?? null, 100, 1000);
    if (r.factor !== undefined) factor.run('X', date, r.factor);
  });
  return db;
}

function read(db, options) {
  let result;
  forEachStockBars(db, '19000101', '99999999', (_, bars) => { result = bars; }, ['X'], options);
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
  assert.equal(forEachStockBars(db, '20200101', '20200101', () => assert.fail('empty selection scanned a stock'), [], { strictMissing: true }), 0);
  db.close();
});

test('legacy mode preserves the frozen V1 series: NULL becomes 0 and a factor is carried forward', () => {
  const bars = read(createDb([row(10, 2), row(11, 3), { ...row(12), factor: undefined }, row(13, 4)]));
  assert.equal(bars.adjMissing, 1, 'the gap is still reported');
  assert.deepEqual(bars.close, [5, 8.25, 9, 13]);
  assert.deepEqual(bars.rawClose, [10, 11, 12, 13]);
  const withNull = read(createDb([{ ...row(), close: null }]));
  assert.equal(withNull.close[0], 0, 'legacy NULL * ratio is 0; score-1.0.0 is frozen against it');
  assert.equal(withNull.rawClose[0], null, 'legacy raw fields keep the SQL NULL unchanged');
});

test('strict mode: NULL OHLC stays unknown in raw and adjusted bars', () => {
  const keys = ['open', 'high', 'low', 'close'];
  for (const key of keys) {
    const bars = read(createDb([{ ...row(), [key]: null }]), { strictMissing: true });
    const raw = `raw${key[0].toUpperCase()}${key.slice(1)}`;
    assert.ok(Number.isNaN(bars[key][0]), key);
    assert.ok(Number.isNaN(bars[raw][0]), raw);
    for (const other of keys.filter(k => k !== key)) assert.ok(Number.isFinite(bars[other][0]));
  }
});

test('strict mode: missing and invalid factors never fabricate prices or bridge gaps', () => {
  const bars = read(createDb([row(10, 2), { ...row(11), factor: undefined }, row(12, 0), row(13, -1), row(14, 4)]), { strictMissing: true });
  assert.equal(bars.adjMissing, 3, 'absent, zero and negative factors are all unknown');
  assert.deepEqual(bars.close, [5, NaN, NaN, NaN, 14]);
  assert.deepEqual(bars.rawClose, [10, 11, 12, 13, 14]);
  const noFactor = read(createDb([{ ...row(), factor: undefined }]), { strictMissing: true });
  assert.equal(noFactor.adjMissing, 1);
  assert.ok(Number.isNaN(noFactor.close[0]));
});

test('strict bad close does not become a zero or get bridged by indicators', () => {
  const rows = Array.from({ length: 40 }, () => row());
  rows[10].close = null;
  const bars = read(createDb(rows), { strictMissing: true });
  const indicators = computeIndicators(bars);
  assert.equal(indicators.ma5[9], 10);
  assert.ok(Number.isNaN(bars.close[10]));
  assert.ok(Number.isNaN(indicators.ma5[10]));
  assert.ok(Number.isNaN(indicators.ma5[39]));
});

test('strict mode preserves qfq values when the history has no gaps', () => {
  const bars = read(createDb([row(10, 2), row(12, 3), row(14, 4)]), { strictMissing: true });
  assert.equal(bars.adjMissing, 0);
  assert.deepEqual(bars.close, [5, 9, 14]);
  assert.deepEqual(bars.high, [5.5, 9.75, 15]);
  assert.deepEqual(bars.rawClose, [10, 12, 14]);
});

// ------------------------------------------------- detailed V2 history window

const FAMILIES = ['TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION'];

function marketDb(bars, missingFactorAt = -1, badCloseAt = -1) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE trade_cal (cal_date TEXT, is_open INTEGER);
    CREATE TABLE stock_basic (ts_code TEXT, name TEXT, industry TEXT);
    CREATE TABLE daily (ts_code TEXT, trade_date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL);
    CREATE TABLE adj_factor (ts_code TEXT, trade_date TEXT, adj_factor REAL);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);`);
  db.prepare('INSERT INTO stock_basic VALUES (?, ?, ?)').run('X', '测试', '行业');
  const day = db.prepare('INSERT INTO trade_cal VALUES (?, 1)');
  const daily = db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const factor = db.prepare('INSERT INTO adj_factor VALUES (?, ?, ?)');
  bars.forEach((r, i) => {
    day.run(r.date);
    daily.run('X', r.date, r.open, r.high, r.low, i === badCloseAt ? null : r.close, 100, 1000);
    if (i !== missingFactorAt) factor.run('X', r.date, 1);
  });
  return db;
}

const history = (n, start = 20200101) => Array.from({ length: n }, (_, i) => ({
  date: String(start + i), open: 10, high: 11, low: 9, close: 10, factor: 1,
}));

function analyze(db) {
  return analyzeTechnicalV2(db, {
    asOf: String(20200101 + db.prepare('SELECT COUNT(*) n FROM daily').get().n - 1),
    prescreen: {
      universe: 1,
      perFamily: Object.fromEntries(FAMILIES.map(f => [f, []])),
      eligible: [{ ts_code: 'X', name: '测试', rank: 0 }],
      capacity_limited: 0,
    },
    regime: 'UNKNOWN',
  });
}

test('V2 analyses a stock whose old gap predates a complete recent window', () => {
  const bars = history(250);
  const view = analyze(marketDb(bars, 20)); // gap 230 bars before the as-of bar
  assert.equal(view.coverage.analyzed, 1, 'a 229-bar valid suffix must be analysed');
  assert.equal(view.coverage.skipped_adj_missing, 0);
  assert.equal(view.coverage.skipped_insufficient, 0);
});

test('V2 does not bridge: a gap inside the technical window still skips the stock', () => {
  const bars = history(250);
  const view = analyze(marketDb(bars, 240)); // only 9 valid bars after the gap
  assert.equal(view.coverage.analyzed, 0);
  assert.equal(view.coverage.skipped_adj_missing, 1);
});

test('V2 leaves an invalid as-of close unknown instead of reading an earlier bar', () => {
  const bars = history(250);
  const view = analyze(marketDb(bars, -1, 249));
  assert.equal(view.coverage.analyzed, 0);
  assert.equal(view.coverage.skipped_insufficient, 1);
  assert.equal(view.contexts.length, 0);
});

test('V2 history-window result is unchanged when the whole series is valid', () => {
  const view = analyze(marketDb(history(250)));
  assert.equal(view.coverage.analyzed, 1);
  assert.equal(view.coverage.skipped_adj_missing, 0);
  assert.equal(view.coverage.skipped_insufficient, 0);
});
