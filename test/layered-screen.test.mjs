import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stockLayers, etfLayers, buildLayeredScreen } from '../build/ashare/layeredScreen.js';
import { screenEtfCandidates } from '../build/ashare/etfUniverse.js';

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
