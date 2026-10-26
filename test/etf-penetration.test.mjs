// ETF 穿透摘要纯函数测试（goal-1026 §4.1/§4.2）：fixture 数据，不访问网络。
// 覆盖：权重过期标注（CURRENT/STALE/FUTURE_DATED/UNAVAILABLE）、覆盖率计算与缺口、
// 归因分解残差恒等式（分量之和=总回报）、预期修订证据不足分支、
// 覆盖不足时禁止代表性企业替代（结论块落 insufficient_evidence 且无伪精确数字）、
// etf-weights 数据文件缓存回读（命中→组装输入；缺失/损坏→UNAVAILABLE 不 throw）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const {
  buildEtfPenetrationSummary,
  buildPriceAttribution,
  weightFreshness,
  collectEtfPenetrationInputs,
  readEtfWeightCache,
  etfWeightCachePath,
  DEFAULT_MAX_WEIGHT_AGE_DAYS,
  ETF_PENETRATION_SCHEMA,
} = await import('../build/ashare/etfPenetration.js');

const AS_OF = '20261023';

function baseInput(overrides = {}) {
  const rows = [
    { con_code: '688012.SH', weight: 15, name: '中微公司', industry: '半导体' },
    { con_code: '002371.SZ', weight: 14, name: '北方华创', industry: '半导体' },
    { con_code: '688072.SH', weight: 8, name: '拓荆科技', industry: '半导体' },
  ];
  const fundamentals = Object.fromEntries(rows.map(r => [r.con_code, {
    end_date: '20260630', ann_date: '20260826', netprofit_yoy: 100, or_yoy: 30,
    grossprofit_margin: 40, ocf_to_profit: 90, roe: 10,
  }]));
  const valuations = Object.fromEntries(rows.map(r => [r.con_code, {
    pe_ttm: 60, pb: 8, ps_ttm: 15, dv_ttm: 0.1, total_mv: 100000,
  }]));
  return {
    as_of: AS_OF,
    etf: { ts_code: '159558.SZ', name: '易方达中证半导体材料设备主题ETF', benchmark: '中证半导体材料设备主题指数收益率×100%' },
    benchmark_index_code: '931743.CSI',
    weight: { source: 'index_weight', index_code: '931743.CSI', weight_date: '20260930', publication_date: null, rows },
    fundamentals,
    valuations,
    etfPerformance: { start_date: '20260922', end_date: AS_OF, window_sessions: 20, return_pct: 5.5, dividend_adjusted: true, note: null },
    benchmarkPerformance: { return_pct: 3.1, window_sessions: 20, note: null },
    comparables: [{ ts_code: '512480.SH', name: '半导体ETF', kind: 'industry_etf', return_pct: 4.2, etf_excess_pct: 1.3, correlation: 0.91 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------- 权重过期标注

test('weightFreshness: 阈值内为 CURRENT', () => {
  const f = weightFreshness('20260930', AS_OF);
  assert.equal(f.status, 'CURRENT');
  assert.equal(f.age_days, 23);
  assert.ok(f.note.includes('20260930'));
});

test('weightFreshness: 超过阈值为 STALE 且写明过期天数', () => {
  const f = weightFreshness('20260131', AS_OF);
  assert.equal(f.status, 'STALE');
  assert.ok(f.age_days > DEFAULT_MAX_WEIGHT_AGE_DAYS);
  assert.ok(f.note.includes('过期权重'));
});

test('weightFreshness: 未来日期为 FUTURE_DATED，缺失为 UNAVAILABLE', () => {
  assert.equal(weightFreshness('20261101', AS_OF).status, 'FUTURE_DATED');
  assert.equal(weightFreshness(null, AS_OF).status, 'UNAVAILABLE');
  assert.equal(weightFreshness('bad', AS_OF).status, 'UNAVAILABLE');
});

test('摘要：过期权重必须显式标注并产生缺口，不得被称为最新持仓', () => {
  const summary = buildEtfPenetrationSummary(baseInput({
    weight: { source: 'index_weight', index_code: '931743.CSI', weight_date: '20260131', publication_date: null, rows: baseInput().weight.rows },
  }));
  assert.equal(summary.constituents.freshness.status, 'STALE');
  assert.ok(summary.gaps.some(g => g.code === 'weight_stale'));
  assert.equal(summary.constituents.weight_date, '20260131');
});

// ---------------------------------------------------------------- 覆盖率计算

test('摘要：全覆盖时各分量 COMPLETE，覆盖率 n/n 与权重和披露', () => {
  const s = buildEtfPenetrationSummary(baseInput());
  const by = Object.fromEntries(s.coverage.components.map(c => [c.component, c]));
  assert.equal(by.constituents.covered, 3);
  assert.equal(by.constituents.total, 3);
  assert.equal(by.constituents.weight_covered_pct, 37); // 15+14+8
  assert.equal(by.fundamentals.status, 'COMPLETE');
  assert.equal(by.fundamentals.weight_covered_pct, 37);
  assert.equal(by.valuation.status, 'COMPLETE');
  assert.equal(by.forecasts.status, 'MISSING');
  assert.equal(s.earnings.evidence_class, 'verified_fact');
  assert.equal(s.earnings.weighted.or_yoy_pct, 30);
  assert.equal(s.earnings.weighted.netprofit_yoy_pct, 100);
});

test('摘要：财报覆盖不足 → 缺口 + 结论块证据不足，禁止代表性企业替代', () => {
  const input = baseInput();
  delete input.fundamentals['688072.SH'];
  const s = buildEtfPenetrationSummary(input);
  const fin = s.coverage.components.find(c => c.component === 'fundamentals');
  assert.equal(fin.status, 'PARTIAL');
  assert.equal(fin.covered, 2);
  assert.equal(fin.total, 3);
  assert.equal(fin.weight_covered_pct, 29);
  assert.equal(s.earnings.evidence_class, 'insufficient_evidence');
  assert.equal(s.earnings.weighted, null); // 覆盖不足不输出伪精确加权数
  assert.ok(s.gaps.some(g => g.code === 'fundamentals_coverage'));
  assert.ok(s.gaps.some(g => g.code.includes('2/3') || g.description.includes('2/3')));
});

test('摘要：估值覆盖不足 → 估值结论块证据不足且有缺口', () => {
  const input = baseInput();
  delete input.valuations['002371.SZ'];
  const s = buildEtfPenetrationSummary(input);
  assert.equal(s.valuation.evidence_class, 'insufficient_evidence');
  assert.equal(s.valuation.weighted, null);
  assert.ok(s.gaps.some(g => g.code === 'valuation_coverage'));
});

test('摘要：盈利预测缺失 → forecasts 证据不足 + 预期修订缺口（不得当作预期修订）', () => {
  const s = buildEtfPenetrationSummary(baseInput());
  assert.equal(s.forecasts.evidence_class, 'insufficient_evidence');
  assert.deepEqual(s.forecasts.coverage, { covered: 0, total: 3 });
  assert.ok(s.forecasts.gaps.some(g => g.code === 'forecast_revision_unavailable'));
  assert.ok(s.forecasts.note.includes('不是市场一致预期'));
});

test('摘要：自含 as_of、来源与缺口（可直接进 Bundle）', () => {
  const s = buildEtfPenetrationSummary(baseInput());
  assert.equal(s.schema, ETF_PENETRATION_SCHEMA);
  assert.equal(s.as_of, AS_OF);
  assert.ok(s.sources.some(src => src.includes('index_weight')));
  assert.ok(Array.isArray(s.gaps));
  assert.ok(s.etf.ts_code && s.etf.name && s.etf.benchmark);
  const evClasses = [s.earnings.evidence_class, s.valuation.evidence_class, s.forecasts.evidence_class, s.drivers.evidence_class];
  for (const c of evClasses) assert.ok(['verified_fact', 'model_derived', 'interpretation', 'insufficient_evidence'].includes(c));
});

test('摘要：跟踪指数代码缺失 → 指数对比缺口，不臆造指数行情', () => {
  const s = buildEtfPenetrationSummary(baseInput({ benchmark_index_code: null, benchmarkPerformance: null }));
  assert.ok(s.gaps.some(g => g.code === 'benchmark_index_code'));
  assert.ok(s.gaps.some(g => g.code === 'benchmark_performance'));
  assert.equal(s.performance.benchmark.return_pct, null);
  assert.equal(s.performance.benchmark.excess_pct, null);
});

test('摘要：集中度按权重计算（top1/top5/HHI）', () => {
  const s = buildEtfPenetrationSummary(baseInput());
  assert.equal(s.constituents.concentration.top1_weight_pct, 15);
  assert.equal(s.constituents.concentration.top5_weight_pct, 37);
  // HHI = Σw²/100，w 为百分数
  const hhi = (15 ** 2 + 14 ** 2 + 8 ** 2) / 100;
  assert.ok(Math.abs(s.constituents.concentration.hhi - hhi) < 0.011);
});

// ---------------------------------------------------------------- 归因分解

test('归因：各分量之和 = 总回报（残差恒等式，容差内）', () => {
  const a = buildPriceAttribution({
    start_date: '20260922', end_date: AS_OF,
    etf_price_return_pct: 10,
    dividend_return_pct: 0.5,
    start_pe_median: 55, end_pe_median: 60,
    start_weighted_or_yoy_pct: 20, end_weighted_or_yoy_pct: 22,
    start_weighted_forecast_pct: 15, end_weighted_forecast_pct: 16,
  });
  const c = a.components;
  const sum = (c.earnings_growth_pp ?? 0) + (c.forecast_revision_pp ?? 0)
    + (c.valuation_multiple_pp ?? 0) + (c.dividend_pp ?? 0) + c.residual_pp;
  assert.ok(Math.abs(sum - a.total_return_pct) <= 0.011, `sum=${sum} total=${a.total_return_pct}`);
  assert.equal(c.earnings_growth_pp, 2);
  assert.equal(c.forecast_revision_pp, 1);
  assert.equal(c.dividend_pp, 0.5);
  const expectVal = (Math.log(60) - Math.log(55)) * 100;
  assert.ok(Math.abs(c.valuation_multiple_pp - Math.round(expectVal * 100) / 100) < 0.011);
  assert.equal(a.status, 'DECOMPOSED');
  assert.equal(a.evidence_class, 'model_derived');
});

test('归因：无可靠预期数据 → 预期修订单量为 null + 缺口，恒等式仍成立', () => {
  const a = buildPriceAttribution({
    start_date: '20260922', end_date: AS_OF,
    etf_price_return_pct: 8,
    dividend_return_pct: null,
    start_pe_median: 55, end_pe_median: 55,
    start_weighted_or_yoy_pct: 20, end_weighted_or_yoy_pct: 20,
    start_weighted_forecast_pct: null, end_weighted_forecast_pct: null,
  });
  assert.equal(a.components.forecast_revision_pp, null);
  assert.equal(a.components.dividend_pp, null);
  assert.ok(a.gaps.some(g => g.code === 'attribution_forecast_unavailable'));
  assert.ok(a.gaps.some(g => g.code === 'attribution_dividend_unavailable'));
  const c = a.components;
  const sum = (c.earnings_growth_pp ?? 0) + (c.forecast_revision_pp ?? 0)
    + (c.valuation_multiple_pp ?? 0) + (c.dividend_pp ?? 0) + c.residual_pp;
  assert.ok(Math.abs(sum - a.total_return_pct) <= 0.011);
});

test('归因：全部分量不可得 → INSUFFICIENT_EVIDENCE，残差吸收全部，仍不宣称错误定价', () => {
  const a = buildPriceAttribution({
    start_date: '20260922', end_date: AS_OF,
    etf_price_return_pct: -6.25,
    dividend_return_pct: null,
    start_pe_median: null, end_pe_median: 60,
    start_weighted_or_yoy_pct: null, end_weighted_or_yoy_pct: 20,
    start_weighted_forecast_pct: null, end_weighted_forecast_pct: null,
  });
  assert.equal(a.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(a.components.residual_pp, -6.25);
  const c = a.components;
  const sum = (c.earnings_growth_pp ?? 0) + (c.forecast_revision_pp ?? 0)
    + (c.valuation_multiple_pp ?? 0) + (c.dividend_pp ?? 0) + c.residual_pp;
  assert.ok(Math.abs(sum - a.total_return_pct) <= 0.011);
  assert.ok(a.gaps.some(g => g.code === 'attribution_valuation_unavailable'));
  assert.ok(a.method.includes('不构成因果识别'));
});

test('归因：PE 为 0 或负数 → 估值分量按不可得处理（不产生荒谬对数）', () => {
  const a = buildPriceAttribution({
    start_date: '20260922', end_date: AS_OF,
    etf_price_return_pct: 3,
    dividend_return_pct: 0,
    start_pe_median: -5, end_pe_median: 60,
    start_weighted_or_yoy_pct: 10, end_weighted_or_yoy_pct: 11,
    start_weighted_forecast_pct: null, end_weighted_forecast_pct: null,
  });
  assert.equal(a.components.valuation_multiple_pp, null);
  assert.ok(a.gaps.some(g => g.code === 'attribution_valuation_unavailable'));
  const c = a.components;
  const sum = (c.earnings_growth_pp ?? 0) + (c.forecast_revision_pp ?? 0)
    + (c.valuation_multiple_pp ?? 0) + (c.dividend_pp ?? 0) + c.residual_pp;
  assert.ok(Math.abs(sum - a.total_return_pct) <= 0.011);
});

test('摘要：归因输入缺失时归因块为 null 且有缺口', () => {
  const s = buildEtfPenetrationSummary(baseInput({ attribution: null }));
  assert.equal(s.attribution, null);
  assert.ok(s.gaps.some(g => g.code === 'attribution_input_missing'));
});

test('摘要：携带归因输入时透传并复核恒等式', () => {
  const s = buildEtfPenetrationSummary(baseInput({
    attribution: {
      start_date: '20260922', end_date: AS_OF,
      etf_price_return_pct: 5.5,
      dividend_return_pct: null,
      start_pe_median: 50, end_pe_median: 52,
      start_weighted_or_yoy_pct: 25, end_weighted_or_yoy_pct: 26,
      start_weighted_forecast_pct: null, end_weighted_forecast_pct: null,
    },
  }));
  assert.ok(s.attribution);
  const c = s.attribution.components;
  const sum = (c.earnings_growth_pp ?? 0) + (c.forecast_revision_pp ?? 0)
    + (c.valuation_multiple_pp ?? 0) + (c.dividend_pp ?? 0) + c.residual_pp;
  assert.ok(Math.abs(sum - s.attribution.total_return_pct) <= 0.011);
});

// ---------------------------------------------------------------- 驱动与反证

test('驱动：贡献=权重×同比/100 的算术分解，反证标注 interpretation', () => {
  const s = buildEtfPenetrationSummary(baseInput({
    driverEvidence: { counters: [{ claim: '北方华创利润增速放缓至 5%', basis: '2026 半年报（2026-08-26 公告）' }] },
  }));
  const top = s.drivers.earnings_contributors.positive[0];
  assert.equal(top.contribution_pp, 15); // 15% × 100% / 100
  assert.equal(s.drivers.evidence_class, 'model_derived');
  assert.equal(s.drivers.counters[0].evidence_class, 'interpretation');
  assert.ok(s.drivers.method_note.includes('不是因果归因'));
});

// ------------------------------------------------------- etf-weights 缓存回读

function writeWeightCache(dataDir, code, doc) {
  const path = etfWeightCachePath(code, dataDir);
  mkdirSync(join(dataDir, 'etf-weights'), { recursive: true });
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return path;
}

test('缓存回读：文件命中 → collector 组装输入，weight_date/source 来自文件，freshness 正常判定', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'etf-wcache-hit-'));
  writeWeightCache(dataDir, '159558.SZ', {
    schema: 'etf-weight-cache-20261026-v1',
    as_of: '20261023',
    weight_date: '20260930',
    weight_source: 'index_weight',
    publication_date: null,
    index_code: '931743.CSI',
    weightRows: [
      { ts_code: '688012.SH', weight: 15.455 },
      { ts_code: '002371.SZ', weight: 14.031 },
      { ts_code: '688072.SH', weight: 8.197 },
    ],
    captured_at: '2026-10-26T01:00:00.000Z',
    source_note: 'fixture',
  });
  const db = new DatabaseSync(':memory:');
  try {
    // facts 生产路径的调用形态：weightDate 传空串，无显式 weightRows。
    const input = collectEtfPenetrationInputs(db, { as_of: '20261023', etfCode: '159558.SZ', weightDate: '' , dataDir });
    assert.equal(input.weight.weight_date, '20260930');
    assert.equal(input.weight.source, 'index_weight');
    assert.equal(input.weight.index_code, '931743.CSI');
    assert.equal(input.weight.rows.length, 3);
    assert.equal(input.weight.rows[0].con_code, '688012.SH');
    const summary = buildEtfPenetrationSummary(input);
    assert.equal(summary.constituents.weight_date, '20260930');
    assert.equal(summary.constituents.freshness.status, 'CURRENT');
    assert.equal(summary.constituents.count, 3);
    assert.ok(summary.sources.some(s => s.includes('index_weight(931743.CSI@20260930)')));
  } finally { db.close(); }
});

test('缓存回读：文件缺失或损坏 → 不 throw，权重 UNAVAILABLE（rows 空，freshness UNAVAILABLE）', () => {
  const missingDir = mkdtempSync(join(tmpdir(), 'etf-wcache-miss-'));
  const corruptDir = mkdtempSync(join(tmpdir(), 'etf-wcache-bad-'));
  writeWeightCache(corruptDir, '560390.SH', '{not-json');
  const badDateDir = mkdtempSync(join(tmpdir(), 'etf-wcache-baddate-'));
  writeWeightCache(badDateDir, '560390.SH', { weight_date: 'not-a-date', weightRows: [{ ts_code: '601222.SH', weight: 0.63 }] });
  assert.equal(readEtfWeightCache('560390.SH', missingDir), null);
  assert.equal(readEtfWeightCache('560390.SH', corruptDir), null);
  assert.equal(readEtfWeightCache('560390.SH', badDateDir), null);
  const db = new DatabaseSync(':memory:');
  try {
    for (const dir of [missingDir, corruptDir, badDateDir]) {
      const input = collectEtfPenetrationInputs(db, { as_of: '20261023', etfCode: '560390.SH', weightDate: '', dataDir: dir });
      assert.equal(input.weight.rows.length, 0);       // bundle 层据此降级 UNAVAILABLE
      const summary = buildEtfPenetrationSummary(input); // 不 throw
      assert.equal(summary.constituents.freshness.status, 'UNAVAILABLE');
      assert.ok(summary.gaps.some(g => g.code === 'weight_unavailable'));
    }
  } finally { db.close(); }
});
