// goal-1028 industry-classification data layer: point-in-time SW membership,
// THS theme classification, sector-key dedup, and the additive hotspot schema.
// Fully offline — no Tushare calls; every test runs against openAshareDb(':memory:').
//
// The rules guarded here are hard constraints from architecture.md §2.2:
// a member whose in_date is after as_of must NEVER enter a historical pool
// ("current SW members must not backfill history"), and out_date == as_of
// means already out. Getting either wrong silently rewrites replay results.
import test from 'node:test';
import assert from 'node:assert/strict';

import { openAshareDb, upsertRows } from '../build/ashare/db.js';
import {
  HOTSPOT_TABLES, ensureHotspotSchema, hotspotTableExists, hotspotCoverage,
} from '../build/ashare/hotspotTables.js';
import {
  activeSwMembers, swMemberIndex, classifyThsTheme, dedupeSectors,
  THS_SAMPLE_NAME_PATTERNS,
} from '../build/ashare/industryClassification.js';
import * as industrySync from '../build/ashare/industrySync.js';
import { THS_THEME_RULE_VERSION } from '../build/ashare/hotspotTypes.js';

const AS_OF = '20250630';

function member(over = {}) {
  return {
    ts_code: '600001.SH',
    l1_code: '801010.SI', l2_code: '801011.SI', l3_code: '8010111.SI',
    l1_name: '农林牧渔', l2_name: '种植业', l3_name: '其他种植业',
    name: '样本股A', in_date: '20200101', out_date: null, is_new: 'Y',
    ...over,
  };
}

// ---------------------------------------------------------------- 1. PIT filter

test('activeSwMembers: point-in-time boundaries', () => {
  const rows = [
    member({ ts_code: '600001.SH', in_date: '20200101' }),               // entered before asOf → in
    member({ ts_code: '600002.SH', in_date: '20260101' }),               // entered after asOf → out (backfill guard)
    member({ ts_code: '600003.SH', in_date: null }),                     // missing in_date → out
    member({ ts_code: '600004.SH', in_date: '20200101', out_date: AS_OF }),   // out ON asOf → out (membership ends that day)
    member({ ts_code: '600005.SH', in_date: '20200101', out_date: '20250701' }), // exits after asOf → in
    member({ ts_code: '600006.SH', in_date: AS_OF }),                    // enters ON asOf → in (in_date <= asOf)
    member({ ts_code: '600007.SH', in_date: 'not-a-date' }),             // malformed in_date → out, never assumed active
    member({ ts_code: '600008.SH', in_date: '' }),                       // empty in_date → out
  ];
  const active = activeSwMembers(rows, AS_OF);
  assert.deepEqual(active.map(r => r.ts_code),
    ['600001.SH', '600005.SH', '600006.SH'],
    'out_date == asOf is excluded; a future or unprovable in_date never enters');
});

test('swMemberIndex: L1/L2/L3 keys resolve to active members only', () => {
  const rows = [
    member({ ts_code: '600001.SH' }),
    member({ ts_code: '600002.SH', in_date: '20260101' }), // current member, not yet active at AS_OF
    member({ ts_code: '600003.SH', l2_code: '801080.SI', l3_code: '801081.SI' }),
  ];
  assert.deepEqual([...swMemberIndex(rows, '801010.SI', AS_OF).keys()], ['600001.SH', '600003.SH']);
  assert.deepEqual([...swMemberIndex(rows, '801011.SI', AS_OF).keys()], ['600001.SH']);
  assert.deepEqual([...swMemberIndex(rows, '801080.SI', AS_OF).keys()], ['600003.SH']);
  assert.deepEqual([...swMemberIndex(rows, '801081.SI', AS_OF).keys()], ['600003.SH']);
});

// ------------------------------------------------- 6. no backfill from "current"

test('acceptance: current members (all out_date NULL) cannot backfill a historical pool', () => {
  // Mirrors the observed index_member_all response: out_date always NULL.
  const currentTable = [
    member({ ts_code: '600001.SH', in_date: '19931008' }),
    member({ ts_code: '600002.SH', in_date: '19931008' }),
    member({ ts_code: '688001.SH', in_date: '20260101' }), // joined the index after the historical as_of
  ];
  assert.ok(currentTable.every(r => r.out_date === null), 'fixture is a current-member snapshot');
  const historicalAsOf = '20250630';
  const pool = activeSwMembers(currentTable, historicalAsOf);
  assert.deepEqual(pool.map(r => r.ts_code), ['600001.SH', '600002.SH']);
  assert.ok(!pool.some(r => r.ts_code === '688001.SH'),
    'in_date > as_of must not enter the historical pool even with no out_date');
  assert.ok(!swMemberIndex(currentTable, '801010.SI', historicalAsOf).has('688001.SH'));
});

// ---------------------------------------------------------------- 2. THS themes

test('classifyThsTheme: source-local kind mapping with sample-name patterns', () => {
  assert.equal(classifyThsTheme({ ts_code: '700301.TI', name: '能源(A股)', type: 'I' }), 'THS_INDUSTRY');
  assert.equal(classifyThsTheme({ ts_code: '700030.TI', name: '同花顺小盘', type: 'ST' }), 'THS_STYLE');
  assert.equal(classifyThsTheme({ ts_code: '885866.TI', name: '锂电池', type: 'N' }), 'THS_CONCEPT');
  assert.equal(classifyThsTheme({ ts_code: '883300.TI', name: '沪深300样本股', type: 'N' }), 'THS_SAMPLE',
    'sample-set names under type N are not concepts');
  assert.equal(classifyThsTheme({ ts_code: '883302.TI', name: '上证180成份股', type: 'N' }), 'THS_SAMPLE');
  assert.equal(classifyThsTheme({ ts_code: '864001.TI', name: '昨日涨幅超过10%', type: 'S' }),
    'THS_SAMPLE', 'event/selection indices (type S) carry no theme semantics');
  assert.equal(classifyThsTheme({ ts_code: 'x', name: 'whatever', type: 'X' }), 'UNKNOWN');
  assert.equal(classifyThsTheme({ ts_code: 'x', name: 'whatever', type: null }), 'UNKNOWN');
  assert.ok(THS_SAMPLE_NAME_PATTERNS.length > 0, 'pattern list exported for rule-version audits');
  assert.equal(THS_THEME_RULE_VERSION, 'ths-theme-kind-1.0.0');
});

// ---------------------------------------------------------------- 3. dedup

test('dedupeSectors: stable exact-key dedup, cross-source keys never merge', () => {
  const keys = ['SW2021:801080.SI', 'THS:885866.TI', 'SW2021:801080.SI', 'THS:885866.TI', 'SW2021:801780.SI'];
  assert.deepEqual(dedupeSectors(keys),
    ['SW2021:801080.SI', 'THS:885866.TI', 'SW2021:801780.SI'],
    'first-seen order preserved, exact duplicates dropped');
  // Same local code / same upstream name across sources stays two keys:
  // only explicit versioned mappings may relate namespaces, never names.
  assert.deepEqual(dedupeSectors(['SW2021:801080.SI', 'THS:801080.SI']),
    ['SW2021:801080.SI', 'THS:801080.SI']);
  assert.deepEqual(dedupeSectors([]), []);
});

// ---------------------------------------------------------------- 4. schema + snapshot

test('ensureHotspotSchema is idempotent and creates only the hotspot tables', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  ensureHotspotSchema(db); // second run must be a no-op, not an error
  for (const name of HOTSPOT_TABLES) {
    assert.equal(hotspotTableExists(db, name), true, name);
  }
  assert.equal(hotspotTableExists(db, 'etf_weight_snapshot'), false,
    'etf_weight_snapshot belongs to another module and must not be created here');
});

test('hotspot_snapshot: composite PK (as_of, config_version) round-trip', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const cols = ['as_of', 'config_version', 'strategy_set_version', 'payload', 'content_hash', 'generated_at', 'coverage'];
  const snapshot = (config_version, hash) => ({
    as_of: '20261027',
    config_version,
    strategy_set_version: 'strategies-hs-1.0.0',
    payload: JSON.stringify({ as_of: '20261027', config_version, selected: ['SW2021:801010.SI'] }),
    content_hash: hash,
    generated_at: '2026-10-27T13:00:00.000Z',
    coverage: JSON.stringify([{ dataset: 'sw_member', rows: 5922, quality: 'OK' }]),
  });
  upsertRows(db, 'hotspot_snapshot', cols, [
    snapshot('hotspot-config-1.0.0', 'hash-a'),
    snapshot('hotspot-config-2.0.0', 'hash-b'),
  ]);
  const rows = db.prepare('SELECT * FROM hotspot_snapshot WHERE as_of = ? ORDER BY config_version').all('20261027');
  assert.equal(rows.length, 2, 'both config_versions persist under one as_of');
  assert.deepEqual(rows.map(r => r.config_version), ['hotspot-config-1.0.0', 'hotspot-config-2.0.0']);
  assert.deepEqual(rows.map(r => r.content_hash), ['hash-a', 'hash-b']);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.config_version, 'hotspot-config-1.0.0');
  assert.deepEqual(JSON.parse(rows[0].coverage), [{ dataset: 'sw_member', rows: 5922, quality: 'OK' }]);
  assert.equal(rows[0].generated_at, '2026-10-27T13:00:00.000Z');
});

// ---------------------------------------------------------------- 5. candidate round-trip

test('hotspot_candidate: JSON columns and NULL priority round-trip', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const cols = ['as_of', 'ts_code', 'name', 'instrument_type', 'primary_sector', 'sectors', 'etf_sources',
    'multi_etf', 'leaderships', 'signals', 'trade_permission', 'trade_permission_reason',
    'pool', 'inclusion_reason', 'exclusion_reason', 'priority', 'priority_reason',
    'data_quality', 'config_version'];
  upsertRows(db, 'hotspot_candidate', cols, [{
    as_of: '20261027',
    ts_code: '600519.SH',
    name: '贵州茅台',
    instrument_type: 'STOCK',
    primary_sector: 'SW2021:801780.SI',
    sectors: JSON.stringify(['SW2021:801780.SI', 'THS:885573.TI']),
    etf_sources: JSON.stringify([{ etf_code: '512760.SH', index_code: '931743.CSI', weight: 8.5, source: 'index_weight', effective_date: '20260930', available_from: '20260930', quality: 'OK' }]),
    multi_etf: 1,
    leaderships: JSON.stringify(['INDUSTRY_LEADER', 'MARKET_LEADER']),
    signals: JSON.stringify([{ strategy_id: 'rv_macd_w_bottom', family: 'REVERSAL', direction: 'bullish', confirmed_on: '20261027', invalidation: 'close < neck', status: 'active' }]),
    trade_permission: 'EXECUTABLE',
    trade_permission_reason: 'MAINBOARD_OK',
    pool: 'FOCUS',
    inclusion_reason: 'industry leader + ETF core constituent',
    exclusion_reason: null,
    priority: null,
    priority_reason: 'deferred to next ranking pass',
    data_quality: 'OK',
    config_version: 'hotspot-config-1.0.0',
  }]);
  const row = db.prepare('SELECT * FROM hotspot_candidate WHERE as_of = ? AND ts_code = ?')
    .get('20261027', '600519.SH');
  assert.ok(row, 'row readable by composite PK');
  assert.equal(row.priority, null, 'NULL priority survives the round-trip');
  assert.equal(row.exclusion_reason, null);
  assert.equal(row.multi_etf, 1);
  assert.deepEqual(JSON.parse(row.sectors), ['SW2021:801780.SI', 'THS:885573.TI']);
  assert.deepEqual(JSON.parse(row.leaderships), ['INDUSTRY_LEADER', 'MARKET_LEADER']);
  assert.equal(JSON.parse(row.etf_sources)[0].etf_code, '512760.SH');
  assert.equal(JSON.parse(row.signals)[0].strategy_id, 'rv_macd_w_bottom');
  // Upsert with a filled priority replaces the same PK, never duplicates.
  upsertRows(db, 'hotspot_candidate', cols, [{
    as_of: '20261027', ts_code: '600519.SH', name: '贵州茅台', instrument_type: 'STOCK',
    primary_sector: 'SW2021:801780.SI', sectors: '[]', etf_sources: '[]', multi_etf: 0,
    leaderships: '[]', signals: '[]', trade_permission: 'RESEARCH_ONLY',
    trade_permission_reason: 'MAINBOARD_OK', pool: 'RAW', inclusion_reason: 'r',
    exclusion_reason: null, priority: 3, priority_reason: 'ranked', data_quality: 'OK',
    config_version: 'hotspot-config-1.0.0',
  }]);
  const count = db.prepare('SELECT COUNT(*) n FROM hotspot_candidate WHERE as_of = ? AND ts_code = ?')
    .get('20261027', '600519.SH');
  assert.equal(count.n, 1, 'PK (as_of, ts_code) replaces, never duplicates');
  assert.equal(db.prepare('SELECT priority FROM hotspot_candidate').get().priority, 3);
});

// ---------------------------------------------------------------- coverage

test('hotspotCoverage: table_missing before schema, honest quality after', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  const before = hotspotCoverage(db);
  assert.equal(before.length, HOTSPOT_TABLES.length);
  assert.ok(before.every(c => c.quality === 'UNAVAILABLE' && c.reason === 'table_missing'),
    'absent tables are UNAVAILABLE, never a silent 0');
  ensureHotspotSchema(db);
  const after = hotspotCoverage(db);
  assert.ok(after.every(c => c.quality === 'DEGRADED' && c.reason === 'no_rows'),
    'present but empty is DEGRADED/no_rows');
  upsertRows(db, 'ths_member', ['ts_code', 'con_code', 'con_name', 'quality_status', 'collected_at'],
    [{ ts_code: '885431.TI', con_code: '603381.SH', con_name: '永臻股份', quality_status: 'NO_POINT_IN_TIME', collected_at: '2026-10-28T00:00:00.000Z' }]);
  const memberCov = hotspotCoverage(db).find(c => c.dataset === 'ths_member');
  assert.equal(memberCov.rows, 1);
  assert.equal(memberCov.quality, 'NO_POINT_IN_TIME', 'THS membership is never point-in-time');
});

// ---------------------------------------------------------------- sync module smoke

test('industrySync exposes the six sync entry points (import smoke, no network)', () => {
  for (const name of ['syncSwClassify', 'syncSwMembers', 'syncSwIndexDaily',
    'syncThsIndex', 'syncThsMembers', 'syncThsIndexDaily']) {
    assert.equal(typeof industrySync[name], 'function', name);
  }
});
