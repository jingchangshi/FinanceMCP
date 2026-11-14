import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stockLayers, etfLayers, buildLayeredScreen } from '../build/ashare/layeredScreen.js';
import { screenEtfCandidates } from '../build/ashare/etfUniverse.js';
import { openAshareDb, upsertRows } from '../build/ashare/db.js';
import { qualityCore } from '../build/ashare/qualityCore.js';
import { analyzeTechnicalDay } from '../build/ashare/technicalCandidatesV2.js';
import { forEachStockBars } from '../build/ashare/bars.js';
import { recentTradeDays } from '../build/ashare/ingest.js';
import { computeRps } from '../build/ashare/rps.js';
import { ensureHotspotSchema } from '../build/ashare/hotspotTables.js';
import { evaluateHotspotSectors, DEFAULT_HOTSPOT_CONFIG } from '../build/ashare/hotspot.js';
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
    assert.equal(result.quality_core.status, 'UNAVAILABLE');
    assert.equal(result.quality_core.research_status, 'unvalidated');
    assert.equal(result.industry.status, 'UNAVAILABLE');
    assert.equal(result.industry.research_status, 'unvalidated');
    assert.equal(result.etf.status, 'NOT_READY');
    assert.equal(result.etf.investable_scope.count, null);
    assert.ok(result.etf.candidates.rows.every(row => !row.held));
  } finally { db.close(); }
});

test('industry facts reuse sector factors and work with a read-only database', () => {
  const db = openAshareDb(':memory:');
  try {
    ensureHotspotSchema(db);
    const dates = weekdays('20250101', 65);
    seedReferenceUniverse(db, dates, { stocks: 3 });
    const sector = db.prepare("INSERT INTO sw_classify (index_code, level, name, collected_at) VALUES (?, 'L1', ?, 'test')");
    const bar = db.prepare("INSERT INTO sw_index_daily (ts_code, trade_date, close, synced_at) VALUES (?, ?, ?, 'test')");
    for (const [code, multiplier] of [['A', 1], ['B', 2], ['C', 3]]) {
      sector.run(code, code);
      dates.forEach((date, i) => bar.run(code, date, 100 + i * multiplier));
    }
    const asOf = dates.at(-1);
    const expected = evaluateHotspotSectors(db, asOf, DEFAULT_HOTSPOT_CONFIG);
    db.exec('PRAGMA query_only = ON');
    const industry = buildLayeredScreen(db, asOf).industry;
    assert.equal(industry.as_of, asOf);
    assert.equal(industry.source, 'evaluateHotspotSectors');
    assert.equal(industry.research_status, 'unvalidated');
    assert.match(industry.disclaimer, /不构成.*策略适用性/);
    assert.equal(industry.coverage.sectors, 3);
    assert.equal(industry.coverage.factor_available.ret_20, 3);
    assert.equal(industry.coverage.factor_available.breadth, 0);
    const row = industry.sectors[0];
    const source = expected.sectors.find(s => s.key === row.key);
    assert.equal(row.factors.find(f => f.id === 'ret_20').raw, source.factors.find(f => f.id === 'ret_20').raw);
    assert.equal(row.factors.find(f => f.id === 'breadth').raw, null);
    assert.equal(row.factors.find(f => f.id === 'breadth').quality, 'UNAVAILABLE');
    assert.deepEqual(row.quality_notes, source.quality_notes);
    assert.equal(industry.status, 'DEGRADED');
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

test('quality core checks the full scope, retains missing evidence, and is read-only', () => {
  const db = openAshareDb(':memory:');
  try {
    const dates = weekdays('20250101', 160);
    seedReferenceUniverse(db, dates, { stocks: 6 });
    const asOf = dates.at(-1);
    const columns = ['ts_code', 'end_date', 'ann_date', 'roe', 'eps', 'ocf_to_profit'];
    upsertRows(db, 'fina_indicator', columns, [
      { ts_code: '600000.SH', end_date: '20250331', ann_date: '20250430', roe: 10, eps: 1, ocf_to_profit: 100 },
      { ts_code: '600001.SH', end_date: '20250331', ann_date: '20250430', roe: 0, eps: 1, ocf_to_profit: 100 },
      { ts_code: '600002.SH', end_date: '20250331', ann_date: '20250430', roe: 10, eps: 1, ocf_to_profit: 100 },
      { ts_code: '600003.SH', end_date: '20250331', ann_date: '20250430', roe: 10, eps: 1, ocf_to_profit: null },
      { ts_code: '600004.SH', end_date: '20250331', ann_date: '20250430', roe: 10, eps: 1, ocf_to_profit: 100 },
      { ts_code: '600005.SH', end_date: '20250331', ann_date: '20250430', roe: 10, eps: 1, ocf_to_profit: 100 },
      { ts_code: '600001.SH', end_date: '20250630', ann_date: '20261231', roe: 20, eps: 1, ocf_to_profit: 100 },
    ]);
    db.prepare('UPDATE daily SET amount = 100000 WHERE ts_code = ?').run('600000.SH');
    db.prepare('UPDATE daily_basic SET circ_mv = 500000 WHERE ts_code = ? AND trade_date = ?').run('600000.SH', asOf);
    db.prepare('UPDATE daily SET amount = NULL WHERE ts_code = ? AND trade_date = ?').run('600002.SH', asOf);
    db.prepare('DELETE FROM daily WHERE ts_code = ? AND trade_date = ?').run('600004.SH', asOf);
    db.prepare('UPDATE stock_basic SET name = ? WHERE ts_code = ?').run('*ST测试', '600005.SH');
    db.exec('PRAGMA query_only = ON');
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    const result = qualityCore(db, asOf);
    assert.deepEqual(qualityCore(db, asOf), result);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.equal(result.research_status, 'unvalidated');
    assert.equal(result.investable_scope.denominator, 6);
    assert.equal(result.investable_scope.count, 5);
    assert.equal(result.evaluated.count, 5);
    assert.equal(result.evaluated.complete, 2);
    assert.deepEqual(result.core.rows.map(row => row.ts_code), ['600000.SH']);
    assert.equal(result.core.denominator, 5);
    const find = (code, id) => result.exclusions.rows.find(row => row.ts_code === code).checks.find(check => check.id === id);
    assert.equal(find('600001.SH', 'roe').passed, false);
    assert.equal(find('600002.SH', 'amount20_yi').value, null);
    assert.equal(find('600003.SH', 'ocf_to_profit').passed, null);
    assert.equal(find('600004.SH', 'roe').passed, null);
    assert.deepEqual(buildLayeredScreen(db, asOf).quality_core, result);
  } finally { db.close(); }
});
