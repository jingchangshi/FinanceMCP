import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stockLayers, etfLayers, buildLayeredScreen } from '../build/ashare/layeredScreen.js';
import { screenEtfCandidates } from '../build/ashare/etfUniverse.js';
import { openAshareDb } from '../build/ashare/db.js';
import { analyzeTechnicalDay } from '../build/ashare/technicalCandidatesV2.js';
import { forEachStockBars } from '../build/ashare/bars.js';
import { recentTradeDays } from '../build/ashare/ingest.js';
import { computeRps } from '../build/ashare/rps.js';
import { seedReferenceUniverse, weekdays } from './ashare-fixture.mjs';

test('stock tiers retain other research states and the actual detailed denominator', () => {
  const stocks = [{ ts_code: 'A', research_state: 'FOCUS' }, { ts_code: 'B', research_state: 'WATCH' }, { ts_code: 'C', research_state: 'BLOCKED' }];
  const result = stockLayers({ status: 'OK', research_universe: { stocks }, coverage: { universe: 10, preselected: 6, analyzed: 4, skipped_adj_missing: 1, skipped_insufficient: 1, capacity_limited: 0 } });
  assert.equal(result.core, null);
  assert.equal(result.signal_focus.rows[0].ts_code, 'A');
  assert.equal(result.watch.rows[0].ts_code, 'B');
  assert.equal(result.candidates.rows.length, 3);
  assert.equal(result.exclusions.detailed_skipped.denominator, 6);
  assert.equal(result.exclusions.prescreen_reason_counts, null);
  assert.equal(stockLayers({ status: 'UNAVAILABLE', reason: 'missing' }).evaluated, null);
});

test('ETF missing data remains unavailable and held rows are retained', () => {
  const screen = screenEtfCandidates(null, { asOf: '20261113', limit: 1 });
  const result = etfLayers(screen);
  assert.equal(result.investable_scope.count, null);
  assert.equal(result.core, null);
  assert.equal(result.watch, null);
  assert.equal(result.exclusions.denominator, screen.evaluated);
  assert.equal(result.quality.display_omitted, screen.included - screen.candidates.filter(row => row.included).length);
  assert.ok(result.quality.coverage.missing_tables.includes('fund_daily'));
  assert.ok(result.candidates.rows.some(row => row.held && row.score === null));
});

test('one screen failing does not mask the other screen', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = buildLayeredScreen(db, '20261113');
    assert.equal(result.stock.status, 'UNAVAILABLE');
    assert.equal(result.etf.status, 'NOT_READY');
    assert.equal(result.etf.investable_scope.count, null);
    assert.ok(result.etf.candidates.rows.every(row => !row.held));
  } finally { db.close(); }
});

test('empty eligible set never falls back to all stocks, but forced names remain eligible for review', () => {
  const db = openAshareDb(':memory:');
  try {
    const dates = weekdays('20250101', 160);
    seedReferenceUniverse(db, dates, { stocks: 3 });
    const asOf = dates.at(-1);
    db.prepare('UPDATE daily SET amount = 100').run();
    let visited = 0;
    assert.equal(forEachStockBars(db, dates[0], asOf, () => visited++, []), 0);
    assert.equal(visited, 0);
    const view = analyzeTechnicalDay(db, asOf);
    assert.equal(view.coverage.universe, 3);
    assert.equal(view.coverage.preselected, 0);
    assert.equal(view.coverage.analyzed, 0);
    assert.equal(view.research_universe.stocks.length, 0);
    db.prepare('INSERT INTO suspend_d (ts_code, trade_date, suspend_timing) VALUES (?, ?, ?)').run('600000.SH', asOf, 'S');
    const forced = analyzeTechnicalDay(db, asOf);
    assert.equal(forced.coverage.preselected, 1);
    assert.equal(forced.coverage.analyzed, 1);
    assert.deepEqual(forced.contexts.map(row => row.ts_code), ['600000.SH']);
  } finally { db.close(); }
});

test('layered stock RPS matches preview window and preserves quality denominators', () => {
  const db = openAshareDb(':memory:');
  try {
    const dates = weekdays('20250101', 160);
    seedReferenceUniverse(db, dates, { stocks: 5 });
    const asOf = dates.at(-1);
    const days = recentTradeDays(db, asOf, 260);
    const rps = computeRps(db, days[0], asOf);
    const preview = analyzeTechnicalDay(db, asOf, rps);
    const stock = buildLayeredScreen(db, asOf).stock;
    assert.equal(stock.status, 'OK');
    assert.ok(preview.research_universe.stocks.some(row => row.rps120 !== null));
    assert.deepEqual(stock.candidates.rows, preview.research_universe.stocks);
    assert.deepEqual(stock.rps_quality.denominators, rps.denominators);
    assert.deepEqual(stock.rps_quality.input, rps.quality);
    assert.equal(stock.rps_quality.start, days[0]);
  } finally { db.close(); }
});
