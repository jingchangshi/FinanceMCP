import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-phase3-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { CORE_INDICES } = await import('../build/ashare/ingest.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { evaluateMarketRegime } = await import('../build/ashare/marketRegime.js');
const { screenStockSwingCandidates } = await import('../build/ashare/stockSwingScreener.js');
const { StrategyAdmissionStore } = await import('../build/ashare/strategyAdmission.js');
const {
  V3_OFFENSIVE_POLICY_RELEASE_V3_1_0,
  V3_OFFENSIVE_POLICY_RELEASE_V3_2_0,
  V3_POLICY_V3_1_0_HASH,
  V3_POLICY_EXPECTED_HASH,
  loadApprovedV3Policy,
} = await import('../build/portfolio/v3Policy.js');
const {
  runActionEngine,
  isRiskEquityHolding,
} = await import('../build/portfolio/actionEngine.js');
const {
  ensureDeconcentrationPlan,
  calibrateDeconcentrationPlan,
  evaluateDeconcentrationPlan,
  persistDeconcentrationUpdates,
} = await import('../build/portfolio/deconcentrationPlan.js');
const { persistRiskAnchor, evaluateStrategyRouter } = await import('../build/portfolio/strategyRouter.js');
const { initBaseline, confirmRealAccount, setAccountCompleteness, recordEvent } = await import('../build/portfolio/ledger.js');
const { buildInvestorReportModel } = await import('../build/portfolio/reportModel.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport, forbiddenHits } = await import('../build/portfolio/reportRenderer.js');
const { loadHotspotSnapshot, saveHotspotSnapshot } = await import('../build/ashare/hotspotSnapshots.js');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { buildHotspotState } = await import('../build/portfolio/researchBundle.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');

function importantNumbers(text) {
  const out = [];
  for (const m of text.matchAll(/(-?)(\d[\d,]*(?:\.\d+)?)(万元|亿元|元|%|％)/g)) {
    const mag = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(mag)) continue;
    const scaled = m[3] === '万元' ? mag * 1e4 : m[3] === '亿元' ? mag * 1e8 : mag;
    out.push({ raw: m[0], value: m[1] ? -scaled : scaled });
  }
  return out;
}

function attachmentNumbers(value, out = []) {
  if (Array.isArray(value)) { value.forEach(v => attachmentNumbers(v, out)); return out; }
  if (value && typeof value === 'object') { Object.values(value).forEach(v => attachmentNumbers(v, out)); return out; }
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  return out;
}

function numberMatches(userValue, attachmentValue) {
  const tol = Math.max(0.01, Math.abs(userValue) * 0.005);
  return [1, 100, 1000, 1e4, 1e6, 0.01, 0.001, 1e-4, 1e-6].some(s => Math.abs(attachmentValue * s - userValue) <= tol);
}

/**
 * 构造满足 145 个交易日的主板强势回踩（BP1）与若干对照组标的市场库。
 */
function seedPhase3StockMarket(name, asOfOpt) {
  const days = weekdays('20260401', 145);
  const asOf = asOfOpt ?? days.at(-1);
  const nextTrade = weekdays(asOf, 2)[1];
  const db = openAshareDb(join(dir, `${name}-market.sqlite`));

  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    ...days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })),
    { cal_date: nextTrade, is_open: 1, pretrade_date: asOf },
  ]);

  const bgStocks = [
    ...Array.from({ length: 20 }, (_, i) => ({
      ts_code: `${601100 + i}.SH`, symbol: String(601100 + i), name: `强股${i}`, industry: '强行业', drift: 0.0025,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      ts_code: `${601200 + i}.SH`, symbol: String(601200 + i), name: `中股${i}`, industry: '中行业', drift: 0.0,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      ts_code: `${601300 + i}.SH`, symbol: String(601300 + i), name: `弱股${i}`, industry: '弱行业', drift: -0.002,
    })),
  ];

  const probeStocks = [
    { ts_code: '601001.SH', symbol: '601001', name: '优质主板回踩', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20260820' },
    { ts_code: '601002.SH', symbol: '601002', name: '纯突破无回踩', industry: '强行业', mode: 'BP2_FAIL', scale: 1, ocf: 85, annDate: '20260820' },
    { ts_code: '300101.SZ', symbol: '300101', name: '创业板回踩', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20260820' },
    { ts_code: '688101.SH', symbol: '688101', name: '科创板回踩', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20260820' },
    { ts_code: '601003.SH', symbol: '601003', name: '*ST风险测试', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20260820' },
    { ts_code: '601004.SH', symbol: '601004', name: '百元高价测试', industry: '强行业', mode: 'BP1_PASS', scale: 6, ocf: 85, annDate: '20260820' },
    { ts_code: '601005.SH', symbol: '601005', name: '低现金流测试', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 30, annDate: '20260820' },
    { ts_code: '601006.SH', symbol: '601006', name: '未来财报测试', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20991231' },
    { ts_code: '920001.BJ', symbol: '920001', name: '北交所回踩', industry: '强行业', mode: 'BP1_PASS', scale: 1, ocf: 85, annDate: '20260820' },
  ];

  const allBasic = [
    ...bgStocks.map(s => ({ ts_code: s.ts_code, symbol: s.symbol, name: s.name, industry: s.industry, list_date: '20180101', list_status: 'L' })),
    ...probeStocks.map(s => ({ ts_code: s.ts_code, symbol: s.symbol, name: s.name, industry: s.industry, list_date: '20180101', list_status: 'L' })),
  ];
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], allBasic);

  const dailyRows = [];
  const adjRows = [];
  const limitRows = [];
  const basicRows = [];
  const finaRows = [];

  for (const s of bgStocks) {
    let prev = 10;
    for (let i = 0; i < days.length; i += 1) {
      const close = Math.round(10 * Math.pow(1 + s.drift, i) * 100) / 100;
      const open = Math.round(close * 0.998 * 100) / 100;
      dailyRows.push({
        ts_code: s.ts_code, trade_date: days[i], open, close, pre_close: prev,
        high: Math.round(close * 1.01 * 100) / 100, low: Math.round(open * 0.99 * 100) / 100,
        pct_chg: (close / prev - 1) * 100, vol: 1e5, amount: 2e5,
      });
      adjRows.push({ ts_code: s.ts_code, trade_date: days[i], adj_factor: 1 });
      limitRows.push({ ts_code: s.ts_code, trade_date: days[i], up_limit: prev * 1.1, down_limit: prev * 0.9 });
      basicRows.push({ ts_code: s.ts_code, trade_date: days[i], turnover_rate: 1.5, pe_ttm: 20, pb: 2, circ_mv: 1e6, total_mv: 1.2e6 });
      prev = close;
    }
  }

  for (const s of probeStocks) {
    let prev = 10 * s.scale;
    for (let i = 0; i < days.length; i += 1) {
      let close = 10 + (10 * Math.min(i, 136)) / 136;
      let open = close * 0.996;
      let high = close * 1.01;
      let low = open * 0.99;
      let vol = 1e5;
      let amount = 2e5;

      if (s.mode === 'BP1_PASS') {
        if (i === 137) { close = 20.4; open = 20.1; high = 20.5; low = 20.0; vol = 1.2e5; amount = 2.4e5; }
        else if (i === 138) { close = 20.8; open = 20.4; high = 20.9; low = 20.3; vol = 1.3e5; amount = 2.6e5; }
        else if (i === 139) { close = 21.4; open = 20.85; high = 21.8; low = 20.8; vol = 1.4e5; amount = 3.0e5; }
        else if (i === 140) { close = 20.6; open = 21.0; high = 21.1; low = 20.3; vol = 0.5e5; amount = 1.5e5; }
        else if (i === 141) { close = 20.1; open = 20.4; high = 20.5; low = 19.95; vol = 0.45e5; amount = 1.5e5; }
        else if (i === 142) { close = 19.9; open = 20.0; high = 20.1; low = 19.8; vol = 0.4e5; amount = 1.5e5; }
        else if (i === 143) { close = 19.9; open = 19.95; high = 20.05; low = 19.82; vol = 0.4e5; amount = 1.5e5; }
        else if (i === 144) { close = 20.35; open = 19.92; high = 20.5; low = 19.88; vol = 1.2e5; amount = 2.4e5; }
      } else {
        // BP2 纯突破：无回踩直接高举高打创 20 日新高，且成交不萎缩。
        if (i >= 137) {
          close = 20 + (i - 136) * 0.45;
          open = close * 0.99;
          high = close * 1.015;
          low = close * 0.985;
          vol = 1.5e5;
          amount = 3.0e5;
        }
      }

      close = Math.round(close * s.scale * 100) / 100;
      open = Math.round(open * s.scale * 100) / 100;
      high = Math.round(high * s.scale * 100) / 100;
      low = Math.round(low * s.scale * 100) / 100;
      dailyRows.push({
        ts_code: s.ts_code, trade_date: days[i], open, close, pre_close: prev,
        high, low, pct_chg: (close / prev - 1) * 100, vol, amount,
      });
      adjRows.push({ ts_code: s.ts_code, trade_date: days[i], adj_factor: 1 });
      limitRows.push({ ts_code: s.ts_code, trade_date: days[i], up_limit: prev * 1.1, down_limit: prev * 0.9 });
      basicRows.push({ ts_code: s.ts_code, trade_date: days[i], turnover_rate: 2, pe_ttm: 22, pb: 2.5, circ_mv: 1.2e6, total_mv: 1.5e6 });
      prev = close;
    }

    finaRows.push({
      ts_code: s.ts_code, ann_date: s.annDate, end_date: '20260630',
      roe: 8.5, roe_dt: 8.2, eps: 0.95, ocfps: 1.1, debt_to_assets: 35, ocf_to_profit: s.ocf,
      or_yoy: 18, netprofit_yoy: 22, dt_netprofit_yoy: 20, grossprofit_margin: 34,
    });
  }

  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], dailyRows);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], adjRows);
  upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], limitRows);
  upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'], basicRows);
  upsertRows(db, 'fina_indicator', ['ts_code', 'ann_date', 'end_date', 'roe', 'roe_dt', 'eps', 'ocfps', 'debt_to_assets', 'ocf_to_profit', 'or_yoy', 'netprofit_yoy', 'dt_netprofit_yoy', 'grossprofit_margin'], finaRows);

  // 核心指数均线多头（OFFENSIVE）+ 成长风格占优
  const idxRows = [];
  for (const code of Object.keys(CORE_INDICES)) {
    for (let i = 0; i < days.length; i += 1) {
      const close = code === '399006.SZ' ? 2000 + i * 5 : 3500 + i * 3;
      const prev = i > 0 ? (code === '399006.SZ' ? 2000 + (i - 1) * 5 : 3500 + (i - 1) * 3) : close;
      idxRows.push({ ts_code: code, trade_date: days[i], open: close, high: close * 1.005, low: close * 0.995, close, pre_close: prev, pct_chg: 0.3, vol: 1e8, amount: 1e8 });
    }
  }
  upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], idxRows);

  // ETF 与基金净值基础表
  const funds = [
    { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备', base: 0.85 },
    { ts_code: '159205.SZ', name: '科创创业50ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '科创创业50', base: 1.05 },
    { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '国债', base: 100.0 },
  ];
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    funds.map(f => ({ ts_code: f.ts_code, name: f.name, fund_type: f.fund_type, invest_type: f.invest_type, benchmark: f.benchmark, status: 'L', market: 'E' })));
  for (const f of funds) {
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map(trade_date => ({ ts_code: f.ts_code, trade_date, open: f.base, high: f.base * 1.005, low: f.base * 0.995, close: f.base, pre_close: f.base, pct_chg: 0, vol: 1e6, amount: 1e6 })));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.map(trade_date => ({ ts_code: f.ts_code, trade_date, adj_factor: 1 })));
    upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'], days.map(trade_date => ({ ts_code: f.ts_code, trade_date, fd_share: 1e8, fund_type: f.fund_type, market: 'E' })));
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
      [{ ts_code: f.ts_code, ann_date: asOf, nav_date: asOf, unit_nav: f.base, accum_nav: f.base, adj_nav: f.base }]);
  }

  const reportId = `ASR-${asOf}-${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  const reportPayload = {
    report_id: reportId,
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: asOf,
    generated_at: '2026-10-20T21:40:00+08:00',
    status: 'READY',
    run_mode: 'manual',
    market: {
      regime: 'bull',
      regime_label: '偏强',
      tone: 'positive',
      judgement: ['全市场强势偏多'],
      indices: [{ ts_code: '000300.SH', name: '沪深300', close: 3932, pct_chg: 0.4, ret5: 1.5, ret20: 4.5, amount_yi: 15000, above_ma20: true, above_ma60: true }],
      breadth: { stocks: 5000, up: 3500, down: 1400, flat: 100, limit_up: 70, limit_down: 5, up_ratio: 0.7, median_pct_chg: 0.9, amount_yi: 15000, amount_ma20_yi: 12000, pct_above_ma20: 70, pct_above_ma60: 65 },
    },
    sectors: { method: 'synthetic', top: [{ industry: '强行业', rank: 1, strength: 0.9, ret5_median_pct: 2, ret20_median_pct: 9, pct_above_ma20: 85 }], bottom: [], all: [] },
    disclaimer: '合成测试日报，不是投资建议。',
  };
  const reportDir = join(dir, 'reports', asOf);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${reportId}.json`), JSON.stringify(reportPayload, null, 2));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(reportId, asOf, 'READY', '2026-10-20T21:40:00+08:00', `reports/${asOf}/${reportId}.json`, 'manual');

  return { db, days, asOf };
}

test('T1: 签名策略版本 v3.2.0 哈希校验与准入账本放行（含 v3.1.0 向后兼容）', () => {
  const policy = loadApprovedV3Policy();
  assert.equal(policy.approved, true);
  assert.equal(policy.version, 'v3.2.0');
  assert.equal(policy.content_hash, V3_POLICY_EXPECTED_HASH);
  assert.equal(policy.bp1_pullback_enabled, true);
  assert.equal(policy.bp2_breakout_enabled, false);
  assert.equal(policy.bp2_breakout_status, 'DROPPED_NEGATIVE_OOS');
  assert.equal(policy.deconcentration_mode, 'BOTTOM_GRIND_25');
  assert.equal(policy.deconcentration_keep_weight_bps, 2500);
  assert.equal(policy.grind_tactical_slot_bps, 1000);
  assert.equal(policy.grind_take_profit_bps, 750);
  assert.equal(policy.grind_drift_harvest_trigger_bps, 3400);
  assert.equal(V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.content_hash, V3_POLICY_V3_1_0_HASH);

  const admDir = join(dir, 'adm-private');
  mkdirSync(admDir, { recursive: true });
  chmodSync(admDir, 0o700);
  const store = new StrategyAdmissionStore(join(admDir, 'admission.sqlite'), { create: true });
  try {
    const scope = {
      account: 'real',
      market: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.market,
      environment: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.environment,
    };
    const validFrom = '2026-11-15T00:00:00.000Z';
    const validUntil = '2099-12-31T00:00:00.000Z';
    store.record('GRANT', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, scope, {
      reason: 'Phase 2 EXP-V3-01..04 validated',
      validFrom,
      validUntil,
    });
    assert.equal(
      store.check(V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, scope, V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.strategy.implementation_sha256),
      true,
    );
    store.record('GRANT', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0, scope, {
      reason: 'Legacy baseline compatibility',
      validFrom,
      validUntil,
    });
    assert.equal(
      store.check(V3_OFFENSIVE_POLICY_RELEASE_V3_1_0, scope, V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.strategy.implementation_sha256),
      true,
    );

    const unapproved = { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, production_admission: 'NOT_APPROVED' };
    assert.throws(
      () => store.record('GRANT', unapproved, scope, { reason: 'should fail', validFrom, validUntil }),
      /invalid_strategy_release|release_not_eligible/,
    );
  } finally {
    store.close();
  }
});

test('T2: 个股波段选股器仅启用 BP1_PULLBACK+QualityCore 并淘汰 BP2 与不合规标的', () => {
  const { db, asOf } = seedPhase3StockMarket('screener');
  try {
    const res = screenStockSwingCandidates(db, asOf);
    assert.equal(res.bp1_pullback_enabled, true);
    assert.equal(res.bp2_breakout_enabled, false);
    assert.equal(res.bp2_status, 'DROPPED_NEGATIVE_OOS');
    const codes = res.candidates.map(c => c.ts_code);
    assert.deepEqual(codes, ['601001.SH'], `仅优质主板回踩股应入围，实际=${JSON.stringify(codes)}`);
    assert.ok(!codes.includes('920001.BJ'), '北交所 920xxx.BJ 属于受限板块，不得进入可交易候选');
    const c = res.candidates[0];
    assert.equal(c.setup, 'BP1_PULLBACK');
    assert.ok(c.stop_loss_pct >= -8.01 && c.stop_loss_pct < 0, `硬止损比例应在 -8% 以内: ${c.stop_loss_pct}`);
    assert.ok(c.roe_annualized_pct > 5 && c.ocf_to_profit_pct > 50);
  } finally {
    db.close();
  }
});

test('T3: P3 个股波段先锋真实买入定仓 + 日报禁词/数字追溯 + 剔除 REVERSAL 接飞刀', () => {
  const { db: mDb, days, asOf } = seedPhase3StockMarket('e2e');
  const pDb = openPortfolioDb(join(dir, 'e2e-portfolio.sqlite'), { marketPath: join(dir, 'e2e-market.sqlite') });
  try {
    const accId = 'real';
    const positions = [
      { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 10000, ref_price_milli: 850, ref_cost_milli: 850, market_value_cents: 850_000 },
    ];
    const cashCents = 9_150_000;
    const totalAssets = 10_000_000;
    importSnapshot(pDb, {
      snapshot_id: 'snap-p3-e2e',
      as_of: asOf,
      source: 'test',
      note: 'phase3',
      warnings: [],
      is_current: false,
      positions,
      totals: { total_assets_cents: totalAssets, securities_mv_cents: 850_000, cash_cents: cashCents, wealth_cents: 0, unrealized_pnl_cents: 0 },
    });
    initBaseline(pDb, accId, { asOf, snapshotId: 'snap-p3-e2e' });
    markSnapshotCurrent(pDb, 'snap-p3-e2e', { confirmedBy: 'test' });
    confirmRealAccount(pDb, accId, { confirm: true, note: 'test' });
    setAccountCompleteness(pDb, accId, {
      as_of: days.at(-2), reported_events_through: days.at(-2), unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'test' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accId}`, '10000000');

    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      snapshotId: 'snap-p3-e2e',
      asOfTradeDate: asOf,
    });
    assert.equal(report.status, 'ACTIONABLE');
    assert.ok(report.v3_cockpit, '应挂载 v3_cockpit');
    assert.equal(report.v3_cockpit.policy_release.version, 'v3.2.0');
    assert.equal(report.v3_cockpit.policy_release.bp1_pullback_enabled, true);
    assert.equal(report.v3_cockpit.policy_release.bp2_breakout_enabled, false);
    assert.equal(report.v3_cockpit.router.sub_strategies.s_stock_swing, 'ACTIVE');
    assert.ok(report.v3_cockpit.stock_swing_candidates.some(c => c.ts_code === '601001.SH'));

    const stockBuy = report.first_section.actions.find(a => a.code === 'P3-STOCK-SWING-BUY-601001.SH');
    assert.ok(stockBuy, '应生成 P3 个股波段买单');
    assert.equal(stockBuy.legs[0].side, 'BUY');
    assert.equal(stockBuy.legs[0].quantity % 100, 0);
    assert.ok(stockBuy.legs[0].gross_cents >= 800_000 && stockBuy.legs[0].gross_cents <= 1_800_000, '单股金额在 8000~18% 之间');

    const rendered = renderDailyReport(report);
    assert.deepEqual(forbiddenHits(rendered.user), [], '用户版正文不得包含内部工程术语或禁词');
    const attNums = attachmentNumbers(rendered.attachment);
    const untraceable = importantNumbers(rendered.user).filter(n => !attNums.some(a => numberMatches(n.value, a)));
    assert.deepEqual(untraceable.map(u => u.raw), [], '正文数字必须全部在技术附件中可追溯');
    assert.ok(report.not_covered.some(line => line.includes('回踩20日线')));

    // 验证 buildHotspotState 过滤 REVERSAL / MEAN_REVERSION 接飞刀股票
    const hsDb = openAshareDb(join(dir, 'hs-filter.sqlite'));
    try {
      const hsDays = weekdays('20250101', 160);
      const hsAsOf = hsDays.at(-1);
      seedReferenceUniverse(hsDb, hsDays);
      const res = runHotspotPipeline(hsDb, hsAsOf, { persist: true, etfCodes: [] });
      assert.ok(res.saved);
      const snap = loadHotspotSnapshot(hsDb, hsAsOf);
      const u = snap.technical_view.research_universe;
      const top3 = u.stocks.slice(0, 3);
      top3[0].primary_family = 'REVERSAL';
      top3[1].primary_family = 'MEAN_REVERSION';
      top3[2].primary_family = 'PULLBACK';
      top3.forEach(s => { s.research_state = 'FOCUS'; });
      u.daily_highlights = top3.map(s => s.ts_code);
      saveHotspotSnapshot(hsDb, snap, { correctionOf: snap.version_no });
      const bundle = buildHotspotState({ db: hsDb, asOf: hsAsOf });
      const hlCodes = bundle.daily_highlights.map(s => s.ts_code);
      assert.ok(!hlCodes.includes(top3[0].ts_code), '必须剔除 REVERSAL 接飞刀标的');
      assert.ok(!hlCodes.includes(top3[1].ts_code), '必须剔除 MEAN_REVERSION 接飞刀标的');
      assert.ok(hlCodes.includes(top3[2].ts_code), '应保留正常趋势回踩/研究标的');
    } finally {
      hsDb.close();
    }
  } finally {
    mDb.close();
    pDb.close();
  }
});

test('T4: L2 熔断前置（重仓换马 -12%->0%，分散后 -15%->15%）与国债 ETF 豁免', () => {
  const { db: mDb, days, asOf } = seedPhase3StockMarket('l2breaker');
  const pDb = openPortfolioDb(join(dir, 'l2-portfolio.sqlite'), { marketPath: join(dir, 'l2breaker-market.sqlite') });
  try {
    const accId = 'real';
    const createdDay = days[days.length - 10];
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accId}`, '10000000');
    const anchorRouter = evaluateStrategyRouter({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf: createdDay,
      currentNavCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, createdDay, { pctAboveMa60ByDate: { [createdDay]: 0.6 } }),
    });
    persistRiskAnchor(pDb, { ...anchorRouter, should_persist_anchor: true });
    ensureDeconcentrationPlan(pDb, {
      account_id: accId,
      ts_code: '159558.SZ',
      initial_shares: 58900,
      nav_cents: 10_000_000,
      target_keep_bps: 1800,
      anchor_price_milli: 850,
      total_tranches: 4,
      created_at: createdDay,
    });

    assert.equal(isRiskEquityHolding('511010.SH'), false);
    assert.equal(isRiskEquityHolding('511990.SH'), false);
    assert.equal(isRiskEquityHolding('159558.SZ'), true);

    const regime = evaluateMarketRegime(mDb, asOf, { pctAboveMa60ByDate: { [asOf]: 0.55 } });
    // Case A: 存在活跃换马计划，回撤 -12.5%（87,500元）触发前置 12% L2 熔断且风险权益目标压至 0%，国债 511010.SH 豁免不被卖出
    const holdingsA = [
      { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 50000, sellable_quantity: 50000, weight: 0.48, market_value_cents: 4_250_000, price_milli: 850, latest_bar_date: asOf, bar_quality: 'READY', ref_cost_milli: 850 },
      { ts_code: '511010.SH', name: '国债ETF', quantity: 300, sellable_quantity: 300, weight: 0.34, market_value_cents: 3_000_000, price_milli: 100000, latest_bar_date: asOf, bar_quality: 'READY', ref_cost_milli: 100000 },
    ];
    const outA = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf,
      holdings: holdingsA,
      cashCents: 1_500_000,
      totalAssetsCents: 8_750_000,
      marketRegime: regime,
    });
    assert.equal(outA.router.deconcentration_preemptive_active, true);
    assert.equal(outA.router.l2_trigger_drawdown_bps, 1200);
    assert.equal(outA.router.circuit_breaker_status, 'L2_LOCKED');
    assert.equal(outA.router.targets.target_equity_bps, 0);
    assert.equal(outA.actions.some(a => a.code === 'P0-BREAKER-SELL-159558.SZ' && a.legs[0].quantity === 50000), true);
    assert.equal(outA.actions.some(a => a.legs.some(l => l.ts_code === '511010.SH' && l.side === 'SELL')), false, '国债 ETF 不得被熔断卖出');

    // Case B: 无重仓换马计划时，同样 -12.5% 回撤仅 L1_WARN，未到 -15% 不触发 L2
    const outB = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf,
      holdings: holdingsA,
      cashCents: 1_500_000,
      totalAssetsCents: 8_750_000,
      marketRegime: regime,
      deconcentrationActive: false,
    });
    assert.equal(outB.router.deconcentration_preemptive_active, false);
    assert.equal(outB.router.l2_trigger_drawdown_bps, 1500);
    assert.equal(outB.router.circuit_breaker_status, 'L1_WARN');

    // Case C: 无重仓换马计划且回撤 -15.5%（84,500元）触发 15% L2 熔断，仅压风险权益至 <=15%，国债继续保留
    const outC = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf,
      holdings: holdingsA,
      cashCents: 1_200_000,
      totalAssetsCents: 8_450_000,
      marketRegime: regime,
      deconcentrationActive: false,
    });
    assert.equal(outC.router.circuit_breaker_status, 'L2_LOCKED');
    assert.equal(outC.router.targets.target_equity_bps, 1500);
    const sell159 = outC.actions.find(a => a.code === 'P0-BREAKER-SELL-159558.SZ');
    assert.ok(sell159);
    assert.ok(sell159.legs[0].quantity < 50000, '分散态 15% 熔断可保留 15% 权益底仓');
    assert.equal(outC.actions.some(a => a.legs.some(l => l.ts_code === '511010.SH' && l.side === 'SELL')), false);
  } finally {
    mDb.close();
    pDb.close();
  }
});

test('T5: 当日卖出 T+1 待交收在增量确认真实账户下不阻断 gate.satisfied，且 V3 结论无旧版防御话术', () => {
  const { db: mDb, days, asOf } = seedPhase3StockMarket('t5settle');
  const pDb = openPortfolioDb(join(dir, 't5-portfolio.sqlite'), { marketPath: join(dir, 't5settle-market.sqlite') });
  try {
    const accId = 'real-main';
    const baseDay = days.at(-5);
    importSnapshot(pDb, {
      snapshot_id: 'snap-t5-base',
      as_of: baseDay,
      source: 'test',
      note: 'phase3-t5',
      warnings: [],
      is_current: false,
      positions: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20000, ref_price_milli: 800, ref_cost_milli: 800, market_value_cents: 1_600_000 },
      ],
      totals: { total_assets_cents: 10_000_000, securities_mv_cents: 1_600_000, cash_cents: 8_400_000, wealth_cents: 0, unrealized_pnl_cents: 0 },
    });
    initBaseline(pDb, accId, { asOf: baseDay, snapshotId: 'snap-t5-base' });
    markSnapshotCurrent(pDb, 'snap-t5-base', { confirmedBy: 'user' });
    confirmRealAccount(pDb, accId, { confirm: true, note: 'user' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accId}`, '10000000');

    const sellRes = recordEvent(pDb, {
      event_id: 't5-sell-159558',
      account_id: accId,
      event_type: 'TRADE_SELL',
      occurred_on: asOf,
      ts_code: '159558.SZ',
      quantity: 10000,
      price_milli: 820,
      fee_cents: 41,
      tax_cents: 0,
      source: 'broker_statement',
    });
    assert.equal(sellRes.status, 'RECORDED');
    assert.ok(sellRes.settled_on && sellRes.settled_on > asOf, '卖出应生成下一交易日待交收日');

    setAccountCompleteness(pDb, accId, {
      as_of: asOf,
      reported_events_through: asOf,
      last_user_reconciled_at: '2026-11-18T14:00:00Z',
      unreported_trade_risk: false,
      note: '增量申报已确认',
    }, { confirm: true, recordedBy: 'user' });

    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      snapshotId: 'snap-t5-base',
      asOfTradeDate: asOf,
    });
    assert.equal(report.gate.satisfied, true, `T+1 待交收不应阻断已增量确认账户的 gate.satisfied: ${JSON.stringify(report.gate)}`);
    assert.ok(report.gate.warnings.some(w => w.code === 'account_settlement_pending'));

    const model = buildInvestorReportModel({
      asOf,
      generatedAt: '2026-11-18T21:00:00+08:00',
      verification: {
        account_id: accId,
        snapshot_id: 'snap-t5-base',
        summary_status: 'DEGRADED',
        reported_events_through: asOf,
        last_user_reconciled_at: '2026-11-18T14:00:00Z',
      },
      portfolio: {
        ...report,
        decision_comparison: {
          decision_plans: [
            { role: 'PREFERRED', action: 'HOLD', label: '继续持有', research_lean: '没有经复核的相对优势证据。', strongest_counter: '集中度偏高。' },
          ],
        },
      },
      benchmarks: null,
      researchCases: [],
      gaps: [],
      marketAsOf: asOf,
    });
    assert.doesNotMatch(model.conclusion, /没有经复核的相对优势证据|账户尚未完成券商对账/);
    assert.match(model.conclusion, /15% 高水位熔断生命线/);
  } finally {
    mDb.close();
    pDb.close();
  }
});

test('T6: 159558 BOTTOM_GRIND_25 校准拆分、2日防守确认、四门槛磨底回补/+7.5%止盈/超配34%兑现及日报自洽', () => {
  const days = weekdays('20260401', 170);
  const novFirstIdx = days.findIndex(d => d.startsWith('202611'));
  const calAsOf = days.at(-1);
  const mDb = openAshareDb(join(dir, 't6-market.sqlite'));
  const pDb = openPortfolioDb(join(dir, 't6-portfolio.sqlite'), { marketPath: join(dir, 't6-market.sqlite') });

  try {
    upsertRows(mDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
      ...days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })),
      { cal_date: weekdays(calAsOf, 2)[1], is_open: 1, pretrade_date: calAsOf },
    ]);

    const bgStocks = [
      ...Array.from({ length: 20 }, (_, i) => ({
        ts_code: `${602100 + i}.SH`, symbol: String(602100 + i), name: `磨底背景${i}`, industry: '背景', drift: 0.001,
      })),
    ];
    upsertRows(mDb, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'],
      bgStocks.map(s => ({ ts_code: s.ts_code, symbol: s.symbol, name: s.name, industry: s.industry, list_date: '20180101', list_status: 'L' })));
    const stDaily = [];
    for (const s of bgStocks) {
      for (let i = 0; i < days.length; i += 1) {
        const close = 10 + i * 0.02;
        stDaily.push({ ts_code: s.ts_code, trade_date: days[i], open: close, high: close * 1.01, low: close * 0.99, close, pre_close: close, pct_chg: 0.2, vol: 1e5, amount: 1e5 });
      }
    }
    upsertRows(mDb, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], stDaily);

    const idxRows = [];
    for (const code of Object.keys(CORE_INDICES)) {
      for (let i = 0; i < days.length; i += 1) {
        const close = 3600 + i * 2;
        idxRows.push({ ts_code: code, trade_date: days[i], open: close, high: close * 1.005, low: close * 0.995, close, pre_close: close, pct_chg: 0.2, vol: 1e8, amount: 1e8 });
      }
    }
    upsertRows(mDb, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], idxRows);

    // 构造 159558.SZ 先平稳磨底 (0.90 -> 0.85)，最后阶段允许控制不同情境
    const setEtfSeries = (fnClose) => {
      mDb.prepare("DELETE FROM fund_daily WHERE ts_code = '159558.SZ'").run();
      upsertRows(mDb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
        days.map((trade_date, i) => {
          const close = fnClose(i);
          const prev = i > 0 ? fnClose(i - 1) : close;
          return { ts_code: '159558.SZ', trade_date, open: close, high: close * 1.01, low: close * 0.99, close, pre_close: prev, pct_chg: ((close / prev) - 1) * 100, vol: 1e6, amount: 1e6 };
        }));
    };

    upsertRows(mDb, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
      [
        { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备', status: 'L', market: 'E' },
        { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '国债', status: 'L', market: 'E' },
      ]);
    upsertRows(mDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      days.flatMap(trade_date => [
        { ts_code: '159558.SZ', trade_date, adj_factor: 1 },
        { ts_code: '511010.SH', trade_date, adj_factor: 1 },
      ]));
    upsertRows(mDb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map(trade_date => ({ ts_code: '511010.SH', trade_date, open: 100, high: 100.1, low: 99.9, close: 100, pre_close: 100, pct_chg: 0, vol: 1e6, amount: 1e6 })));
    upsertRows(mDb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      days.flatMap(trade_date => [
        { ts_code: '159558.SZ', trade_date, fd_share: 1e8, fund_type: '股票型', market: 'E' },
        { ts_code: '511010.SH', trade_date, fd_share: 1e8, fund_type: '债券型', market: 'E' },
      ]));
    upsertRows(mDb, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
      [
        { ts_code: '159558.SZ', ann_date: calAsOf, nav_date: calAsOf, unit_nav: 0.823, accum_nav: 0.823, adj_nav: 0.823 },
        { ts_code: '511010.SH', ann_date: calAsOf, nav_date: calAsOf, unit_nav: 100, accum_nav: 100, adj_nav: 100 },
      ]);

    // Case 1: 模拟 real-main 从 18% 升级校准至 BOTTOM_GRIND_25 (36,900 份 -> 保留 20,600 份，余 8,200 + 8,100)
    const accCal = 'real-cal';
    const createdDay = days[novFirstIdx - 18];
    const setBaseFloorCurve = (overrideTailFn) => setEtfSeries((i) => {
      if (i < novFirstIdx - 10) return 1.05;
      return overrideTailFn ? overrideTailFn(i) : 0.823;
    });
    setBaseFloorCurve();
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accCal}`, '10000000');
    ensureDeconcentrationPlan(pDb, {
      account_id: accCal,
      ts_code: '159558.SZ',
      initial_shares: 58900,
      nav_cents: 6_860_690,
      target_keep_bps: 1800,
      anchor_price_milli: 819,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: createdDay,
    });
    // 执行前两批（58900 -> 47900 -> 36900）
    const evExec12 = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accCal,
      asOf: days[novFirstIdx - 5],
      currentShares: 36900,
      sellableShares: 36900,
      currentCloseMilli: 828,
      navCents: 6_792_503,
      marketRegime: 'STRUCTURAL',
    });
    persistDeconcentrationUpdates(pDb, evExec12);
    const calRes = calibrateDeconcentrationPlan(pDb, {
      account_id: accCal,
      ts_code: '159558.SZ',
      plan_mode: 'BOTTOM_GRIND_25',
      target_keep_bps: 2500,
      tactical_slot_bps: 1000,
      current_shares: 36900,
      current_price_milli: 823,
      nav_cents: 6_792_503,
      support_floor_milli: 780,
      reset_triggered: true,
    });
    assert.equal(calRes.plan_mode, 'BOTTOM_GRIND_25');
    assert.equal(calRes.target_keep_shares, 20600);
    assert.equal(calRes.remaining_excess_shares, 16300);
    assert.deepEqual(calRes.tranches.map(t => [t.planned_shares, t.status]), [
      [11000, 'EXECUTED'],
      [11000, 'EXECUTED'],
      [8200, 'PENDING'],
      [8100, 'PENDING'],
    ]);

    // 取消低位 MONTHLY_SCHEDULE：即便来到月初且间隔 >=12 交易日，不触发强卖
    const evMonthlyBlocked = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accCal,
      asOf: days[novFirstIdx],
      currentShares: 36900,
      sellableShares: 36900,
      currentCloseMilli: 823,
      navCents: 6_792_503,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(evMonthlyBlocked.recommended_sell_shares, 0);
    assert.equal(evMonthlyBlocked.next_monthly_trigger_date, null);

    // 2日箱体防守位确认：仅1日收盘 0.770 (<0.780) 不触发；连续两日 0.770 触发
    setBaseFloorCurve(i => (i === novFirstIdx + 2 ? 0.770 : 0.823));
    const ev1dFloor = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accCal,
      asOf: days[novFirstIdx + 2],
      currentShares: 36900,
      sellableShares: 36900,
      currentCloseMilli: 770,
      navCents: 6_600_000,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(ev1dFloor.recommended_sell_shares, 0, '单日跌破 0.780 不得立即触发保护割肉');

    setBaseFloorCurve(i => (i === novFirstIdx + 1 || i === novFirstIdx + 2 ? 0.770 : 0.823));
    const ev2dFloor = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accCal,
      asOf: days[novFirstIdx + 2],
      currentShares: 36900,
      sellableShares: 36900,
      currentCloseMilli: 770,
      navCents: 6_600_000,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(ev2dFloor.active_trigger_reason, 'BREAKDOWN_SUPPORT_FLOOR');
    assert.equal(ev2dFloor.recommended_sell_shares, 8200);

    // Case 2: 独立账户已完成超额减仓至 25% 底仓（20,600 份，25% 占比）：验证四门槛磨底回补、MA60斜率拦截、+7.5%止盈、>=34%漂移获利、L2 回切 -15%
    const accGrind = 'real-grind';
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accGrind}`, '10000000');
    const anchorDay = days[days.length - 12];
    const anchorRouter = evaluateStrategyRouter({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accGrind,
      asOf: anchorDay,
      currentNavCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, anchorDay, { pctAboveMa60ByDate: { [anchorDay]: 0.55 } }),
    });
    persistRiskAnchor(pDb, { ...anchorRouter, should_persist_anchor: true });
    ensureDeconcentrationPlan(pDb, {
      account_id: accGrind,
      ts_code: '159558.SZ',
      initial_shares: 30000,
      nav_cents: 10_000_000,
      target_keep_bps: 2500,
      plan_mode: 'BOTTOM_GRIND_25',
      tactical_slot_bps: 1000,
      anchor_price_milli: 833,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: anchorDay,
    });
    // 验证超额清零且当前持仓 25% <= 30% 时，前置 -12% 关闭，回切至 -15%->15% 正常生命线
    const regimePos = evaluateMarketRegime(mDb, calAsOf, { pctAboveMa60ByDate: { [calAsOf]: 0.55 } });
    // 先把初始持仓压成已完成超额（25000 股 -> targetKeep=30000, so remainingExcess=0 already）
    // Re-create clean zero-excess plan at 25,000 shares @ 1.000 CNY = 25% weight
    const accGrindZero = 'real-grind-zero';
    importSnapshot(pDb, {
      snapshot_id: 'snap-t6-zero',
      as_of: anchorDay,
      source: 'test',
      note: 't6-zero',
      warnings: [],
      is_current: false,
      positions: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 25000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 2_500_000 },
      ],
      totals: { total_assets_cents: 10_000_000, securities_mv_cents: 2_500_000, cash_cents: 7_500_000, wealth_cents: 0, unrealized_pnl_cents: 0 },
    });
    initBaseline(pDb, accGrindZero, { asOf: anchorDay, snapshotId: 'snap-t6-zero' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accGrindZero}`, '10000000');
    persistRiskAnchor(pDb, { ...evaluateStrategyRouter({
      portfolioDb: pDb, marketDb: mDb, accountId: accGrindZero, asOf: anchorDay, currentNavCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, anchorDay, { pctAboveMa60ByDate: { [anchorDay]: 0.55 } }),
    }), should_persist_anchor: true });
    ensureDeconcentrationPlan(pDb, {
      account_id: accGrindZero,
      ts_code: '159558.SZ',
      initial_shares: 25000,
      nav_cents: 10_000_000,
      target_keep_bps: 2500,
      plan_mode: 'BOTTOM_GRIND_25',
      tactical_slot_bps: 1000,
      anchor_price_milli: 1000,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: anchorDay,
    });

    // 构造前期高位 1.15 后深跌反弹：如果前段在下跌中（MA60斜率<0），即使大折价+超卖+阳线也不得接飞刀
    setEtfSeries(i => {
      if (i < days.length - 40) return 1.15;
      if (i < days.length - 3) return 1.15 - (i - (days.length - 40)) * 0.01; // 急跌拉低 MA60 斜率
      if (i === days.length - 3) return 0.720;
      if (i === days.length - 2) return 0.700;
      return 0.735;
    });
    const outNegSlope = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accGrindZero,
      asOf: calAsOf,
      holdings: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 25000, sellable_quantity: 25000, weight: 0.21, market_value_cents: 1_837_500, price_milli: 735, latest_bar_date: calAsOf, bar_quality: 'READY', ref_cost_milli: 1000 },
      ],
      cashCents: 6_912_500,
      totalAssetsCents: 8_750_000, // -12.5% 回撤
      marketRegime: regimePos,
    });
    assert.equal(outNegSlope.router.deconcentration_preemptive_active, false, '25%底仓且无剩余超额批次时不得再启用前置12%清零');
    assert.equal(outNegSlope.router.l2_trigger_drawdown_bps, 1500);
    assert.equal(outNegSlope.router.circuit_breaker_status, 'L1_WARN');
    assert.equal(outNegSlope.deconcentration.grind_guards?.ma60_flat_ready, false);
    assert.equal(outNegSlope.deconcentration.recommended_buy_shares, 0, 'MA60 10日斜率为负时严禁左侧接飞刀');

    // 现在构造满足全部四门槛的行情：前段稳步走平/抬升令 MA60_slope10 >= 0，近20日内有阶段高点 >= 0.90（折价>=15%），近3日急洗超卖并今日收阳站稳 MA5
    const endIdx = days.length - 1;
    setEtfSeries(i => {
      if (i < endIdx - 50) return 0.65;
      if (i < endIdx - 12) return 0.92; // 推高 MA60（流出段为0.65，故斜率>0）且形成 High60 = 0.92 (85% = 0.782)
      if (i < endIdx - 3) return 0.80;
      if (i === endIdx - 3) return 0.740;
      if (i === endIdx - 2) return 0.710;
      if (i === endIdx - 1) return 0.705;
      return 0.745; // 当日收阳 >0.705, >= MA5, <= 0.782, MA60 10日斜率 > 0, RSI14/Bias20 极值超卖
    });
    const navReload = 9_600_000;
    const outReload = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accGrindZero,
      asOf: calAsOf,
      holdings: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 30000, sellable_quantity: 30000, weight: 0.2328, market_value_cents: 2_235_000, price_milli: 745, latest_bar_date: calAsOf, bar_quality: 'READY', ref_cost_milli: 900 },
      ],
      cashCents: 7_365_000,
      totalAssetsCents: navReload,
      marketRegime: regimePos,
    });
    assert.equal(outReload.deconcentration.grind_guards?.ma60_flat_ready, true);
    assert.equal(outReload.deconcentration.grind_guards?.discount_ready, true);
    assert.equal(outReload.deconcentration.grind_guards?.oversold_3d_ready, true);
    assert.equal(outReload.deconcentration.grind_guards?.right_side_turn_ready, true);
    assert.equal(outReload.deconcentration.active_trigger_reason, 'GRIND_OVERSOLD_RELOAD');
    assert.ok(outReload.deconcentration.recommended_buy_shares >= 10000);
    const reloadAct = outReload.actions.find(a => a.code === 'P2-GRIND-RELOAD-159558');
    assert.ok(reloadAct, '四门槛齐备时应生成 P2-GRIND-RELOAD-159558 买单');
    assert.equal(reloadAct.legs[0].side, 'BUY');

    // 验证全链日报构建与渲染（含禁词 & 数字回溯断言）
    const accRep = 'real-report-grind';
    importSnapshot(pDb, {
      snapshot_id: 'snap-t6-rep',
      as_of: days[endIdx - 5],
      source: 'test',
      note: 't6',
      warnings: [],
      is_current: false,
      positions: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 30000, ref_price_milli: 800, ref_cost_milli: 850, market_value_cents: 2_400_000 },
      ],
      totals: { total_assets_cents: 9_600_000, securities_mv_cents: 2_400_000, cash_cents: 7_200_000, wealth_cents: 0, unrealized_pnl_cents: 0 },
    });
    initBaseline(pDb, accRep, { asOf: days[endIdx - 5], snapshotId: 'snap-t6-rep' });
    markSnapshotCurrent(pDb, 'snap-t6-rep', { confirmedBy: 'user' });
    confirmRealAccount(pDb, accRep, { confirm: true, note: 'user' });
    setAccountCompleteness(pDb, accRep, {
      as_of: calAsOf, reported_events_through: calAsOf, last_user_reconciled_at: '2026-11-18T14:00:00Z', unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'user' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accRep}`, '10000000');
    ensureDeconcentrationPlan(pDb, {
      account_id: accRep,
      ts_code: '159558.SZ',
      initial_shares: 30000,
      nav_cents: 9_600_000,
      target_keep_bps: 2500,
      plan_mode: 'BOTTOM_GRIND_25',
      tactical_slot_bps: 1000,
      anchor_price_milli: 900,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: days[endIdx - 10],
    });
    const repReport = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accRep,
      snapshotId: 'snap-t6-rep',
      asOfTradeDate: calAsOf,
    });
    assert.equal(repReport.v3_cockpit.deconcentration.plan_mode, 'BOTTOM_GRIND_25');
    const repRendered = renderDailyReport(repReport);
    assert.deepEqual(forbiddenHits(repRendered.user), []);
    const repAttNums = attachmentNumbers(repRendered.attachment);
    const repUntrace = importantNumbers(repRendered.user).filter(n => !repAttNums.some(a => numberMatches(n.value, a)));
    assert.deepEqual(repUntrace.map(u => u.raw), []);

    // 验证战术买入记录后 +7.5% 止盈，以及无战术仓但被动超配 >=34% 且滞涨时获利了结
    recordEvent(pDb, {
      event_id: 't6-tac-buy',
      account_id: accGrindZero,
      event_type: 'TRADE_BUY',
      occurred_on: days[endIdx - 2],
      ts_code: '159558.SZ',
      quantity: 12000,
      price_milli: 745,
      fee_cents: 45,
      tax_cents: 0,
      source: 'broker_statement',
    });
    // 下跌到 MA60 (约 0.85) 以下，价格 0.805 (+8.05% >= +7.5%)
    const outTp = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accGrindZero,
      asOf: calAsOf,
      holdings: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 37000, sellable_quantity: 37000, weight: 0.305, market_value_cents: 2_978_500, price_milli: 805, latest_bar_date: calAsOf, bar_quality: 'READY', ref_cost_milli: 850 },
      ],
      cashCents: 6_780_000,
      totalAssetsCents: 9_758_500,
      marketRegime: regimePos,
    });
    assert.equal(outTp.deconcentration.tactical_shares, 12000);
    assert.equal(outTp.deconcentration.active_trigger_reason, 'GRIND_TACTICAL_TAKE_PROFIT');
    assert.equal(outTp.deconcentration.recommended_sell_shares, 12000);
    assert.ok(outTp.actions.some(a => a.code === 'P2-GRIND-TAKE-PROFIT-159558' && a.legs[0].quantity === 12000));

    // 超配被动漂移 >=34% 且滞涨兑现（无战术仓位，权重 35% 且较 MA20 偏离 >= +10% 收阴）
    const accDrift = 'real-drift';
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accDrift}`, '10000000');
    ensureDeconcentrationPlan(pDb, {
      account_id: accDrift,
      ts_code: '159558.SZ',
      initial_shares: 25000,
      nav_cents: 10_000_000,
      target_keep_bps: 2500,
      plan_mode: 'BOTTOM_GRIND_25',
      tactical_slot_bps: 1000,
      anchor_price_milli: 1000,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: anchorDay,
    });
    setEtfSeries(i => {
      if (i < endIdx - 2) return 0.90;
      if (i === endIdx - 1) return 1.05;
      return 1.03; // >= MA20 * 1.10 (0.908*1.10 = 0.9988) and < prevClose (1.05) -> stall!
    });
    const outDrift = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accDrift,
      asOf: calAsOf,
      holdings: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 35000, sellable_quantity: 35000, weight: 0.35, market_value_cents: 3_605_000, price_milli: 1030, latest_bar_date: calAsOf, bar_quality: 'READY', ref_cost_milli: 850 },
      ],
      cashCents: 6_695_000,
      totalAssetsCents: 10_300_000,
      marketRegime: regimePos,
    });
    assert.equal(outDrift.deconcentration.active_trigger_reason, 'GRIND_OVERWEIGHT_DRIFT_HARVEST');
    assert.equal(outDrift.deconcentration.recommended_sell_shares, 10000, '权重35%超配滞涨应减回25%(25000份)');
    assert.ok(outDrift.actions.some(a => a.code === 'P2-GRIND-DRIFT-HARVEST-159558' && a.legs[0].quantity === 10000));
  } finally {
    mDb.close();
    pDb.close();
  }
});
