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

// ---------------------------------------------------------------- 5. archive table

test('the V1 hotspot_candidate mirror is not created and not reported as a source', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  assert.equal(hotspotTableExists(db, 'hotspot_candidate'), false,
    'V2 never creates the per-candidate mirror');
  assert.equal(HOTSPOT_TABLES.includes('hotspot_candidate'), false);
  assert.equal(hotspotCoverage(db).some(c => c.dataset === 'hotspot_candidate'), false,
    'an archive table is not a coverage dataset');
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

test('industrySync catalog syncs fail closed cleanly with CATALOG_UNAVAILABLE when upstream fails', async t => {
  for (const name of ['syncSwClassify', 'syncSwMembers', 'syncSwIndexDaily',
    'syncThsIndex', 'syncThsMembers', 'syncThsIndexDaily']) {
    assert.equal(typeof industrySync[name], 'function', name);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const frozenAt = '2026-10-01T00:00:00.000Z';
  upsertRows(db, 'sw_classify', ['index_code', 'level', 'name', 'collected_at'], [
    { index_code: '801010.SI', level: 'L1', name: '农林牧渔', collected_at: frozenAt },
    { index_code: '850111.SI', level: 'L3', name: '种子', collected_at: frozenAt },
  ]);
  upsertRows(db, 'ths_index', ['ts_code', 'name', 'idx_type', 'count', 'exchange', 'list_date', 'collected_at'], [
    { ts_code: '885431.TI', name: 'CPO概念', idx_type: 'N', count: 120, exchange: '', list_date: '20200101', collected_at: frozenAt },
  ]);
  const r1 = await industrySync.syncSwClassify(db);
  const r2 = await industrySync.syncSwMembers(db, { delayMs: 0 });
  const r3 = await industrySync.syncThsIndex(db);
  const r4 = await industrySync.syncThsMembers(db, { codes: ['885431.TI'] });
  for (const r of [r1, r2, r3, r4]) {
    assert.equal(r.status, 'CATALOG_UNAVAILABLE', r.dataset);
    assert.equal(r.rows, 0);
  }
  assert.equal(r1.cached_rows, 2);
  assert.equal(db.prepare("SELECT collected_at FROM sw_classify WHERE index_code = '801010.SI'").get().collected_at, frozenAt);
  assert.equal(db.prepare("SELECT collected_at FROM ths_index WHERE ts_code = '885431.TI'").get().collected_at, frozenAt);

  // Empty catalog never throws in hotspot-sync / syncSwIndexDaily.
  const emptyDb = openAshareDb(':memory:');
  t.after(() => emptyDb.close());
  const swDailyEmpty = await industrySync.syncSwIndexDaily(emptyDb, { start: '20261101', end: '20261110' });
  assert.equal(swDailyEmpty.status, 'CATALOG_UNAVAILABLE');
  const { runCommand } = await import('../build/ashare/commands.js');
  const printed = [];
  await runCommand(emptyDb, 'hotspot-sync', {
    arg: () => undefined,
    flag: () => false,
    ymd: v => v,
    print: v => printed.push(v),
  });
  assert.equal(printed[0].command, 'hotspot-sync');
  assert.equal(printed[0].catalog_status, 'CATALOG_UNAVAILABLE');
});

test('industrySync populates SW2021 classify/members and THS industry index via free mock sources while preserving archives', async t => {
  const originalFetch = globalThis.fetch;
  const overviewHtml = `
    <div id="level1Items">
      <div class="lg-industries-item-chinese-title">801010.SI</div>
      <div class="lg-industries-item-number">农林牧渔(104)</div>
    </div>
    <div id="level2Items">
      <div class="lg-industries-item-chinese-title">801016.SI</div>
      <div class="lg-industries-item-number">种植业(20) <span>[农林牧渔]</span></div>
    </div>
    <div id="level3Items">
      <div class="lg-industries-item-chinese-title">850111.SI</div>
      <div class="lg-industries-item-number">种子(2) <span>[种植业]</span></div>
    </div>
  `;
  const compHtml = `
    <table>
      <tr><th>序号</th><th>股票代码</th><th>股票简称</th><th>纳入时间</th></tr>
      <tr><td>1</td><td>600313.SH</td><td>农发种业</td><td>2011-01-10</td></tr>
      <tr><td>2</td><td>000998.SZ</td><td>隆平高科</td><td>2000-12-11</td></tr>
    </table>
  `;
  const thsHtml = `<html><body>
    <a href="https://q.10jqka.com.cn/thshy/detail/code/881121/" target="_blank">半导体</a>
    <a href="https://q.10jqka.com.cn/thshy/detail/code/881155/" target="_blank">银行</a>
  </body></html>`;
  const { default: iconv } = await import('iconv-lite').catch(() => ({ default: null }));
  const thsBytes = iconv
    ? iconv.encode(thsHtml, 'gbk')
    : Buffer.from(thsHtml, 'latin1'); // ASCII fallback if iconv-lite absent; use Buffer for pure test bytes

  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('sw-industry-overview')) return new Response(overviewHtml, { status: 200 });
    if (s.includes('index-composition?industryCode=850111.SI')) return new Response(compHtml, { status: 200 });
    if (s.includes('q.10jqka.com.cn/thshy/')) return new Response(thsBytes, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  // Pre-seed a historical exited sw_member row + an existing THS concept row + existing I row with count
  upsertRows(db, 'sw_member', ['ts_code', 'l1_code', 'l2_code', 'l3_code', 'l1_name', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'collected_at'], [
    { ts_code: '600001.SH', l1_code: '801010.SI', l2_code: '801016.SI', l3_code: '850111.SI', l1_name: '农林牧渔', l2_name: '种植业', l3_name: '种子', name: '旧成分股', in_date: '20100101', out_date: '20200101', is_new: 'N', collected_at: '2026-10-01T00:00:00.000Z' },
  ]);
  upsertRows(db, 'ths_index', ['ts_code', 'name', 'idx_type', 'count', 'exchange', 'list_date', 'collected_at'], [
    { ts_code: '885431.TI', name: 'CPO概念', idx_type: 'N', count: 120, exchange: 'A', list_date: '20200101', collected_at: '2026-10-01T00:00:00.000Z' },
    { ts_code: '881121.TI', name: '半导体旧', idx_type: 'I', count: 165, exchange: 'A', list_date: '20120101', collected_at: '2026-10-01T00:00:00.000Z' },
  ]);

  const cRes = await industrySync.syncSwClassify(db, { minL1: 1, minL2: 1, minL3: 1 });
  assert.equal(cRes.status, 'OK');
  assert.equal(cRes.rows, 3);
  const l3 = db.prepare("SELECT parent_code, src FROM sw_classify WHERE index_code='850111.SI'").get();
  assert.equal(l3.parent_code, '801016.SI');
  assert.equal(l3.src, 'SW2021');

  const mRes = await industrySync.syncSwMembers(db, { minUniqueStocks: 2, delayMs: 0 });
  assert.equal(mRes.status, 'OK');
  assert.equal(mRes.rows, 2);
  assert.equal(db.prepare("SELECT out_date FROM sw_member WHERE ts_code='600001.SH'").get().out_date, '20200101', 'historical exited row preserved');
  assert.equal(db.prepare("SELECT in_date, l1_code, l2_code FROM sw_member WHERE ts_code='600313.SH'").get().in_date, '20110110');

  const tRes = await industrySync.syncThsIndex(db, { minCount: 2 });
  assert.equal(tRes.status, 'OK');
  assert.equal(tRes.rows, 2);
  assert.equal(db.prepare("SELECT idx_type, count FROM ths_index WHERE ts_code='885431.TI'").get().count, 120, 'concept row preserved');
  const semi = db.prepare("SELECT name, count, list_date FROM ths_index WHERE ts_code='881121.TI'").get();
  assert.equal(semi.count, 165, 'existing count preserved on industry merge');
  assert.equal(semi.list_date, '20120101', 'existing list_date preserved');
  if (iconv) assert.equal(semi.name, '半导体');

  const tmRes = await industrySync.syncThsMembers(db, { codes: ['881121.TI'] });
  assert.equal(tmRes.status, 'CATALOG_UNAVAILABLE');
  assert.equal(tmRes.reason, 'ths_member_pagination_gated_401_preserved_cache');
});

test('hotspot-snapshot --dry-run remains read-only', async t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  const { runCommand } = await import('../build/ashare/commands.js');
  const printed = [];
  await runCommand(db, 'hotspot-snapshot', {
    arg: name => (name === 'date' ? '20261030' : undefined),
    flag: name => name === 'dry-run',
    ymd: v => v,
    print: v => printed.push(v),
  });
  assert.equal(printed[0].snapshot.as_of, '20261030');
  assert.equal(printed[0].saved, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM hotspot_snapshot_version').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM hotspot_snapshot').get().n, 0);
});

test('hotspot-sync 首跑安全：discoverThsCodes 空库建表返回 []，不抛 no such table', t => {
  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  // 生产首次运行曾在此崩溃：命令处理器在 ensureHotspotSchema 之前查询
  // ths_index（"no such table: ths_index"）。发现函数必须自建 schema，
  // 且只在 THS 目录同步之后调用（首跑才有目录可排序）。
  assert.deepEqual(industrySync.discoverThsCodes(db), [], '空库返回空列表而非抛错');
  assert.ok(hotspotTableExists(db, 'ths_index'), '发现函数自身完成建表');
  upsertRows(db, 'ths_index',
    ['ts_code', 'name', 'idx_type', 'count', 'exchange', 'list_date', 'collected_at'], [
      { ts_code: '885431.TI', name: 'CPO概念', idx_type: 'N', count: 120, exchange: '', list_date: '20200101', collected_at: '2026-10-29T00:00:00.000Z' },
      { ts_code: '881105.TI', name: '半导体', idx_type: 'I', count: 200, exchange: '', list_date: '20200101', collected_at: '2026-10-29T00:00:00.000Z' },
      { ts_code: '883300.TI', name: '事件型', idx_type: 'S', count: 999, exchange: '', list_date: '20200101', collected_at: '2026-10-29T00:00:00.000Z' },
    ]);
  assert.deepEqual(industrySync.discoverThsCodes(db), ['881105.TI', '885431.TI'],
    '只取概念/行业类型并按成分数降序，事件型排除');
});

test('syncSwMembers circuit breaker stops immediately on consecutive HTTP 504 without retries', async t => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response('gateway timeout', { status: 504 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const frozenAt = '2026-10-01T00:00:00.000Z';
  const classifyRows = [
    { index_code: '801010.SI', level: 'L1', name: '农林牧渔', parent_code: '0', collected_at: frozenAt },
    { index_code: '801016.SI', level: 'L2', name: '种植业', parent_code: '801010.SI', collected_at: frozenAt },
    ...Array.from({ length: 10 }, (_, i) => ({
      index_code: `85011${i}.SI`,
      level: 'L3',
      name: `细分${i}`,
      parent_code: '801016.SI',
      collected_at: frozenAt,
    })),
  ];
  upsertRows(db, 'sw_classify', ['index_code', 'level', 'name', 'parent_code', 'collected_at'], classifyRows);

  const res = await industrySync.syncSwMembers(db, { delayMs: 0, maxConsecutiveFailures: 3 });
  assert.equal(res.status, 'CATALOG_UNAVAILABLE');
  assert.match(res.reason ?? '', /circuit breaker/i);
  assert.equal(fetchCount, 3, '504 triggers zero retries and trips breaker after 3 requests instead of sending all 10');
});

test('syncSwMembers fresh-cache TTL guard skips remote crawl unless force=true', async t => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response('unavailable', { status: 503 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const db = openAshareDb(':memory:');
  t.after(() => db.close());
  ensureHotspotSchema(db);
  const nowIso = new Date().toISOString();
  upsertRows(db, 'sw_classify', ['index_code', 'level', 'name', 'parent_code', 'collected_at'], [
    { index_code: '801010.SI', level: 'L1', name: '农林牧渔', parent_code: '0', collected_at: nowIso },
    { index_code: '801016.SI', level: 'L2', name: '种植业', parent_code: '801010.SI', collected_at: nowIso },
    { index_code: '850111.SI', level: 'L3', name: '种子', parent_code: '801016.SI', collected_at: nowIso },
  ]);
  upsertRows(db, 'sw_member', ['ts_code', 'l1_code', 'l2_code', 'l3_code', 'l1_name', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'collected_at'], [
    { ts_code: '600313.SH', l1_code: '801010.SI', l2_code: '801016.SI', l3_code: '850111.SI', l1_name: '农林牧渔', l2_name: '种植业', l3_name: '种子', name: '农发种业', in_date: '20110110', out_date: '', is_new: 'Y', collected_at: nowIso },
    { ts_code: '000998.SZ', l1_code: '801010.SI', l2_code: '801016.SI', l3_code: '850111.SI', l1_name: '农林牧渔', l2_name: '种植业', l3_name: '种子', name: '隆平高科', in_date: '20001211', out_date: '', is_new: 'Y', collected_at: nowIso },
  ]);

  const skipped = await industrySync.syncSwMembers(db, { minUniqueStocks: 2, maxAgeDays: 30, delayMs: 0 });
  assert.equal(skipped.status, 'OK');
  assert.equal(skipped.rows, 0);
  assert.equal(skipped.cached_rows, 2);
  assert.equal(skipped.reason, 'fresh_cache_within_ttl');
  assert.equal(fetchCount, 0);

  const forced = await industrySync.syncSwMembers(db, {
    minUniqueStocks: 2,
    maxAgeDays: 30,
    delayMs: 0,
    force: true,
    maxConsecutiveFailures: 1,
  });
  assert.equal(forced.status, 'CATALOG_UNAVAILABLE');
  assert.equal(forced.cached_rows, 2);
  assert.ok(fetchCount > 0, 'force=true bypasses TTL cache guard');
});
