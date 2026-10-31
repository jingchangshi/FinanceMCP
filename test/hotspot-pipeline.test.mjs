// goal-1028 pipeline regressions (acceptance E4–E10 的离线等价断言):
//
// 1. 内容哈希可复现 (E9): 同日同配置重跑哈希相同；且**首次**写入时，
//    自指覆盖 (hotspot_snapshot / hotspot_candidate) 描述本次写入的结果
//    而非写入前的空表状态 —— 否则首写与重跑的哈希在结构上永远不同。
// 2. MCP 只读工具读取真实快照，缺失日期返回 NOT_READY 与运行提示 (E10)。
// 3. THS 成员无时点 (NO_POINT_IN_TIME): collected_at > asOf 时不得为
//    THS 行业播种产业龙头；collected_at ≤ asOf 才允许（当日标注语义）。
// 4. SW 成员盖章: ETF 成分股按真实 SW L1 行业分桶，行业上限按真行业生效，
//    不得塌缩进 UNMAPPED 一个伪行业；industryCap 在 FOCUS 内逐桶成立。
// 5. confirmation_lag 随快照候选投影 (E7 的持久化面)。
//
// 全离线：合成 universe，无网络，不写生产库。fixture 只建一次，测试共享。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hotspot-pipeline-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { ensureHotspotSchema } = await import('../build/ashare/hotspotTables.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { buildHotspotPool } = await import('../build/ashare/hotspotPool.js');

const DATES = weekdays('20250901', 160);
const AS_OF = DATES.at(-1);
const L1_FAST = '801010.SI'; // 农林牧渔 —— 涨得快，应入选
const L1_SLOW = '801780.SI'; // 银行 —— 涨得慢，仅作截面对照
const THS_IDX = '885001.TI';

const db = openAshareDb();
ensureHotspotSchema(db);
seedReferenceUniverse(db, DATES);

// ---- 行业分类: 两个 SW L1 + 指数日线（快者超额为正）+ 成员 ----
upsertRows(db, 'sw_classify',
  ['index_code', 'level', 'name', 'industry_code', 'parent_code', 'src', 'is_pub', 'collected_at'],
  [
    { index_code: L1_FAST, level: 'L1', name: '农林牧渔', industry_code: 'A01', parent_code: null, src: 'SW2021', is_pub: 'Y', collected_at: '20261028' },
    { index_code: L1_SLOW, level: 'L1', name: '银行', industry_code: 'J66', parent_code: null, src: 'SW2021', is_pub: 'Y', collected_at: '20261028' },
  ]);
const memberRow = (ts, l1, l1Name) => ({
  ts_code: ts, l1_code: l1, l2_code: l1, l3_code: l1,
  l1_name: l1Name, l2_name: l1Name, l3_name: l1Name, name: ts,
  in_date: '20180101', out_date: null, is_new: 'Y', collected_at: '20261028',
});
upsertRows(db, 'sw_member',
  ['ts_code', 'l1_code', 'l2_code', 'l3_code', 'l1_name', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'collected_at'],
  [
    ...Array.from({ length: 20 }, (_, i) => memberRow(`${600000 + i}.SH`, L1_FAST, '农林牧渔')),
    ...Array.from({ length: 20 }, (_, i) => memberRow(`${600020 + i}.SH`, L1_SLOW, '银行')),
  ]);
upsertRows(db, 'sw_index_daily',
  ['ts_code', 'trade_date', 'open', 'low', 'high', 'close', 'change', 'pct_change', 'vol', 'amount', 'pe', 'pb', 'float_mv', 'total_mv', 'synced_at'],
  DATES.flatMap((d, k) => {
    const mk = (code, perDay, base) => {
      const close = base + k * perDay;
      const pre = base + (k - 1) * perDay;
      return { ts_code: code, trade_date: d, open: pre, low: close * 0.99, high: close * 1.01, close,
        change: close - pre, pct_change: ((close - pre) / pre) * 100, vol: 1e6, amount: 1e6,
        pe: 10, pb: 1.2, float_mv: 1e8, total_mv: 1e8, synced_at: '20261028T00:00:00Z' };
    };
    return [mk(L1_FAST, 2, 1000), mk(L1_SLOW, 0.5, 2000)];
  }));
// CSI300 基线: 持平 → 快指数的 20/60 日超额 > 0。
upsertRows(db, 'index_daily',
  ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
  DATES.map(d => ({ ts_code: '000300.SH', trade_date: d, open: 3000, high: 3000, low: 3000,
    close: 3000, pre_close: 3000, pct_chg: 0, vol: 1, amount: 1e8 })));

// ---- THS 成员 (无时点): collected_at 故意晚于 AS_OF，由各测试自行覆盖 ----
upsertRows(db, 'ths_member', ['ts_code', 'con_code', 'con_name', 'quality_status', 'collected_at'],
  Array.from({ length: 10 }, (_, i) => ({
    ts_code: THS_IDX, con_code: `${600000 + i}.SH`, con_name: `测试${i}`,
    quality_status: 'NO_POINT_IN_TIME', collected_at: '20261028',
  })));

const emptyEtf = () => [];
const basePoolOpts = { etfConstituents: emptyEtf, etfCodes: [] };

// ---------------------------------------------------------------- 1. E9 哈希

test('E9: first write and identical rerun hash the same (self-coverage reports the run, not the pre-write table)', () => {
  const first = runHotspotPipeline(db, AS_OF, { persist: true });
  // 回归锚点: 首写之前表是空的 —— 覆盖必须报告本次写入结果，而非写前的0行。
  const cov = first.snapshot.coverage.find(c => c.dataset === 'hotspot_snapshot');
  const covC = first.snapshot.coverage.find(c => c.dataset === 'hotspot_candidate');
  assert.deepEqual({ rows: cov.rows, quality: cov.quality }, { rows: 1, quality: 'OK' });
  assert.deepEqual({ rows: covC.rows, quality: covC.quality },
    { rows: first.snapshot.candidates.length, quality: 'OK' });
  // sectors 内层覆盖与顶层一致（两者都是哈希输入）。
  const inner = first.snapshot.sectors.coverage.find(c => c.dataset === 'hotspot_snapshot');
  assert.deepEqual({ rows: inner.rows, quality: inner.quality }, { rows: 1, quality: 'OK' });

  const rerun = runHotspotPipeline(db, AS_OF, { persist: true });
  assert.equal(rerun.snapshot.content_hash, first.snapshot.content_hash,
    '同日同配置重跑 content_hash 必须相同');
  assert.equal(rerun.saved.replaced, true, '同 (as_of, config_version) 重跑 = 整体替换');
  assert.equal(first.saved.replaced, false, '首写为插入');

  // 干跑报告与真实写入完全相同的报告（dry-run 不写，但哈希一致）。
  const dry = runHotspotPipeline(db, AS_OF, { persist: false });
  assert.equal(dry.saved, null, 'dry-run 不落盘');
  assert.equal(dry.snapshot.content_hash, first.snapshot.content_hash,
    'dry-run 报告的就是它将写入的报告');

  // 同日只有一份快照，绝不 fork。
  const rows = db.prepare('SELECT as_of, content_hash FROM hotspot_snapshot WHERE as_of = ?').all(AS_OF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_hash, first.snapshot.content_hash);
});

test('pipeline snapshot is internally consistent and marked research-only', () => {
  const { snapshot } = runHotspotPipeline(db, AS_OF, { persist: false });
  assert.equal(snapshot.research_only, true);
  assert.equal(snapshot.as_of, AS_OF);
  const stocks = snapshot.candidates.filter(c => c.instrument_type === 'STOCK');
  assert.equal(snapshot.counts.raw_pool,
    stocks.filter(c => c.pool !== 'EXCLUDED').length, 'raw_pool = 未排除个股');
  assert.equal(snapshot.counts.focus_pool, stocks.filter(c => c.pool === 'FOCUS').length);
  assert.ok(snapshot.counts.focus_pool <= 50, 'focus 不超过容量上限');
  // 选中行业必有反证（P2 反证永不为空）。
  const byKey = new Map(snapshot.sectors.sectors.map(s => [s.key, s]));
  for (const key of snapshot.sectors.selected) {
    const s = byKey.get(key);
    assert.ok(s && Array.isArray(s.counter_evidence) && s.counter_evidence.length > 0,
      `选中行业 ${key} 必须有反证`);
  }
  // 覆盖中的 ths_member 必须如实标注无时点。
  const ths = snapshot.coverage.find(c => c.dataset === 'ths_member');
  if (ths) assert.equal(ths.quality, 'NO_POINT_IN_TIME');

  // WP3: 入场视图必须与候选自洽 —— 榜上的每只都必须 eligibility=true，
  // 且被否决的高排名候选必须给出机器可读原因。
  const view = snapshot.entry_view;
  assert.ok(view, '快照必须携带 entry_view');
  assert.equal(view.as_of, AS_OF);
  const byCode = new Map(stocks.map(c => [c.ts_code, c]));
  for (const e of view.entry_top10) {
    const c = byCode.get(e.ts_code);
    assert.ok(c, `入场榜代码必须来自候选池: ${e.ts_code}`);
    assert.equal(c.entry_eligibility, true, `${e.ts_code} 未通过资格却进了入场榜`);
    assert.equal(e.entry_score, c.entry_score);
  }
  for (const e of view.rejected_high_rank) {
    assert.equal(byCode.get(e.ts_code)?.entry_eligibility, false, `${e.ts_code} 应在否决名单里`);
    assert.ok(e.rejection_reasons.length > 0, `${e.ts_code} 被否决必须写原因`);
  }
  const classTotal = Object.values(view.counts).reduce((s, n) => s + n, 0);
  assert.equal(classTotal, stocks.length, '每个股票候选恰好属于一个类别');
  assert.ok(!view.entry_top10.some(e => byCode.get(e.ts_code)?.instrument_type === 'ETF'));
});

test('representative ETFs are evidence-based: only ETFs whose weighted constituent stamped the sector', () => {
  // 注入一只真实成分权重指向快行业（801010.SI 成员 600000.SH）的 ETF。
  const constituents = [{
    etf_code: '510300.SH', stock_code: '600000.SH', weight: 5,
    source: 'index_weight', effective_date: '20260331', available_from: '20260331', quality: 'OK',
  }];
  const res = runHotspotPipeline(db, AS_OF, {
    persist: false,
    etfCodes: ['510300.SH'],
    etfNames: { '510300.SH': '测试ETF' },
    etfConstituents: () => constituents,
  });
  const fast = res.snapshot.sectors.sectors.find(s => s.key === `SW2021:${L1_FAST}`);
  const slow = res.snapshot.sectors.sectors.find(s => s.key === `SW2021:${L1_SLOW}`);
  assert.ok(fast?.representative_etfs.some(e => e.etf_code === '510300.SH'),
    '成分股盖章的行业必须列出该 ETF 为代表');
  assert.equal(fast?.representative_etfs.find(e => e.etf_code === '510300.SH')?.name, '测试ETF');
  assert.ok(!(slow?.representative_etfs ?? []).some(e => e.etf_code === '510300.SH'),
    '无成分证据的行业不得被猜测标注');
});

// ---------------------------------------------------------------- 2. E10 MCP

test('E10: MCP hotspot tools read the written snapshot; a date without one is NOT_READY', async () => {
  const { runAshareTool } = await import('../build/ashare/tools.js');
  const parse = r => JSON.parse(r.content[0].text);

  const sectors = parse(await runAshareTool('ashare_hotspot_sectors', { date: AS_OF }));
  assert.equal(sectors.as_of, AS_OF);
  assert.ok(sectors.content_hash.startsWith('sha256:'));
  assert.ok(Array.isArray(sectors.selected));
  // goal-1032: the reader must be able to see WHICH version this is and what
  // data produced it. Echoed verbatim from the snapshot, never recomputed here.
  assert.ok(Number.isInteger(sectors.version_no) && sectors.version_no >= 1,
    'the tool must name the ledger version it read');
  assert.equal(sectors.data_state.as_of, AS_OF);
  assert.ok(['READY', 'DEGRADED'].includes(sectors.data_state.readiness));
  assert.ok(sectors.data_state.fingerprint.bars.daily > 0, 'the fingerprint must count the bars it ranked from');
  assert.ok(sectors.data_state.fingerprint_hash.startsWith('sha256:'));

  const opps = parse(await runAshareTool('ashare_hotspot_opportunities', { date: AS_OF, pool: 'FOCUS' }));
  assert.equal(opps.pool_filter, 'FOCUS');
  assert.ok(opps.candidates.every(c => c.pool === 'FOCUS'));
  assert.equal(opps.candidates.length, opps.counts.focus_pool);
  assert.equal(opps.version_no, sectors.version_no);
  assert.equal(opps.data_state.fingerprint_hash, sectors.data_state.fingerprint_hash,
    'both tools read the same snapshot, so the fingerprint must be identical');

  const singleCode = opps.candidates[0]?.ts_code;
  if (singleCode) {
    const one = parse(await runAshareTool('ashare_hotspot_opportunities', { date: AS_OF, ts_code: singleCode }));
    assert.equal(one.candidates.length, 1);
    assert.equal(one.candidates[0].ts_code, singleCode);
  }

  const missing = (await runAshareTool('ashare_hotspot_sectors', { date: '20250101' })).content[0].text;
  assert.match(missing, /NOT_READY/, '无快照日期必须是 NOT_READY，不得用前一日数据替代');
  assert.match(missing, /hotspot-snapshot/, 'NOT_READY 必须给出生成命令提示');
});

// ------------------------------------------------- 3. THS 成员时点守卫

const thsSnapshot = (selected = true) => ({
  as_of: AS_OF,
  config_version: 'hotspot-config-test',
  sectors: [{ key: `THS:${THS_IDX}`, name: '测试主题', kind: 'THS_CONCEPT', source: 'THS',
    state: 'LEADING', rank: 1, rank_5d_ago: null, rank_20d_ago: null, strength: 1,
    factors: [], entry_reason: 'test', counter_evidence: ['x'], data_quality: 'OK',
    quality_notes: [], representative_etfs: [] }],
  selected: selected ? [`THS:${THS_IDX}`] : [],
  coverage: [],
});

test('THS leaders: membership learned after asOf must not seed a historical pool', () => {
  db.prepare('UPDATE ths_member SET collected_at = ? WHERE ts_code = ?').run('20261028', THS_IDX);
  const res = buildHotspotPool(db, AS_OF, thsSnapshot(), null, { ...basePoolOpts });
  const fromThs = res.candidates.filter(c =>
    (c.sectors || []).some(k => k === `THS:${THS_IDX}`) || c.leaderships.includes('INDUSTRY_LEADER') && (c.sectors || []).includes(`THS:${THS_IDX}`));
  assert.equal(fromThs.length, 0,
    'collected_at > asOf：无时点成员不得回填历史（禁止用当前成分回填）');
});

test('THS leaders: membership known by asOf seeds industry leaders same-day', () => {
  db.prepare('UPDATE ths_member SET collected_at = ? WHERE ts_code = ?').run('20200101', THS_IDX);
  try {
    const res = buildHotspotPool(db, AS_OF, thsSnapshot(), null, { ...basePoolOpts });
    const led = res.candidates.filter(c =>
      c.leaderships.includes('INDUSTRY_LEADER') && (c.sectors || []).includes(`THS:${THS_IDX}`));
    assert.ok(led.length > 0, 'collected_at ≤ asOf：THS 行业可产生产业龙头');
    assert.ok(led.length <= 3, '每行业龙头数不超过 leadersPerSector');
    for (const c of led) assert.ok(c.leader_evidence.some(e => e.kind === 'INDUSTRY_LEADER'));
  } finally {
    // 还原为晚于 asOf，不污染共享 fixture。
    db.prepare('UPDATE ths_member SET collected_at = ? WHERE ts_code = ?').run('20261028', THS_IDX);
  }
});

// ------------------------------------------------- 4. 盖章与行业上限

test('SW stamping: ETF constituents bucket by real SW industry, never a collapsed pseudo-industry', () => {
  const constituents = Array.from({ length: 30 }, (_, i) => ({
    etf_code: '510300.SH', stock_code: `${600000 + i}.SH`, weight: 10 - i * 0.1,
    source: 'index_weight', effective_date: '20260331', available_from: '20260331', quality: 'OK',
  }));
  const res = buildHotspotPool(db, AS_OF, { ...thsSnapshot(false), sectors: [] }, null, {
    ...basePoolOpts,
    etfCodes: ['510300.SH'],
    etfNames: { '510300.SH': '测试ETF' },
    etfConstituents: () => constituents,
    etfTopN: constituents.length, // 不截断：盖章断言需要全部 30 只
  });
  const stocks = res.candidates.filter(c => c.instrument_type === 'STOCK' && c.etf_sources.length > 0);
  assert.equal(stocks.length, 30, '30 只成分股全部入池（亏损等硬排除按 fixture 实情）');
  for (const c of stocks) {
    assert.ok(c.primary_sector, `成分股 ${c.ts_code} 必须有真实行业桶（SW 成员盖章）`);
    assert.match(c.primary_sector, /^SW2021:\d{6}\.SI$/, '桶键必须是真实 SW 指数键');
    assert.ok(c.sectors.includes(c.primary_sector));
  }
  // FOCUS 内逐桶不超上限，且 UNMAPPED 桶不出现（成员已盖章）。
  const buckets = new Map();
  for (const c of res.candidates.filter(c => c.pool === 'FOCUS')) {
    const b = c.primary_sector ?? 'UNMAPPED';
    assert.notEqual(b, 'UNMAPPED', '已盖章成员不得落入 UNMAPPED');
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  for (const [b, n] of buckets) assert.ok(n <= 4, `桶 ${b} 超过 industryCap=4: ${n}`);
  // ETF 本体仍作为可交易候选进入 RAW。
  assert.ok(res.candidates.some(c => c.instrument_type === 'ETF' && c.pool === 'RAW'));
});

// ------------------------------------------------- 5. confirmation_lag 投影

test('confirmation_lag and confirmed_on are projected into snapshot candidates (E7 persistence)', () => {
  const event = {
    ts_code: '', strategy_id: 'tc_pullback_resume', strategy_version: 'st-tc-1.0.0',
    family: 'TREND_CONTINUATION', direction: 'bullish',
    confirmed_on: '20260401', formed_on: '20260325', confirmation_lag: 3,
    evidence: { note: 'fixture' }, invalidation_conditions: 'close < MA60',
    invalidation: null, status: 'active', risk_flags: [],
  };
  const res = buildHotspotPool(db, AS_OF, { ...thsSnapshot(false), sectors: [] }, null, {
    ...basePoolOpts,
    signalScanProvider: codes => ({
      as_of: AS_OF,
      versions: { strategy_set: 't', patterns: 't', signals: 't', rps: 't' },
      results: codes.slice(0, 5).map(code => ({ ts_code: code, events: [{ ...event, ts_code: code }], risk_events: [], bars: DATES.length })),
      coverage: { requested: codes.length, scanned: codes.length, skipped_adj_missing: 0, skipped_insufficient: 0 },
    }),
  });
  const withEvent = res.candidates.filter(c => c.signals.some(s => s.strategy_id === 'tc_pullback_resume'));
  assert.ok(withEvent.length > 0, '注入的扫描结果必须投影进候选');
  for (const c of withEvent) {
    for (const s of c.signals) {
      if (s.strategy_id !== 'tc_pullback_resume') continue;
      assert.equal(s.confirmation_lag, 3, 'confirmation_lag 必须随快照保留');
      assert.ok(s.confirmed_on >= s.formed_on, '确认日不得早于成形日');
      assert.ok(s.confirmation_lag >= 0);
    }
  }
  assert.ok(res.counts.with_signals > 0);
});

// ------------------------------------------------- 6. researchBundle 摘要层

test('researchBundle hotspot_research: reads the snapshot, degrades honestly, stays research-only', async () => {
  const { buildHotspotState } = await import('../build/portfolio/researchBundle.js');

  // 快照缺失日 = NOT_READY + 明确原因，不实时计算、不伪造。
  const missing = buildHotspotState({ db, asOf: '20250101' });
  assert.equal(missing.status, 'NOT_READY');
  assert.equal(missing.reason, 'hotspot_snapshot_not_generated');
  assert.equal(missing.content_hash, null);
  assert.deepEqual(missing.focus_candidates, []);
  assert.ok(missing.gaps.some(g => g.module === 'hotspot_research'));

  // 库/asOf 缺失 = UNAVAILABLE。
  assert.equal(buildHotspotState({ db: null, asOf: AS_OF }).status, 'UNAVAILABLE');
  assert.equal(buildHotspotState({ db, asOf: null }).status, 'UNAVAILABLE');

  // 有快照 = OK：哈希、行业、计数与快照一致；FOCUS 摘要截前 15 条。
  const ok = buildHotspotState({ db, asOf: AS_OF });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.research_only, true);
  assert.match(ok.content_hash ?? '', /^sha256:/);
  // goal-1032: the private bundle discloses the ledger position and the data
  // state exactly as the public tools do — one snapshot, one story.
  assert.ok(Number.isInteger(ok.version_no) && ok.version_no >= 1, 'the bundle must name the ledger version');
  assert.equal(ok.data_state?.as_of, AS_OF);
  assert.ok(ok.data_state?.fingerprint_hash.startsWith('sha256:'));
  assert.deepEqual(ok.selected_sectors,
    JSON.parse(db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get(AS_OF).payload).sectors.selected);
  assert.ok(ok.focus_candidates.length > 0 && ok.focus_candidates.length <= 15);
  for (const c of ok.focus_candidates) {
    assert.ok(c.ts_code && c.name && c.trade_permission);
    assert.ok(typeof c.signals === 'number');
  }
});
