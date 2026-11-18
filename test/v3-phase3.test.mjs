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
  V3_POLICY_EXPECTED_HASH,
  loadApprovedV3Policy,
} = await import('../build/portfolio/v3Policy.js');
const {
  runActionEngine,
  isRiskEquityHolding,
} = await import('../build/portfolio/actionEngine.js');
const { ensureDeconcentrationPlan } = await import('../build/portfolio/deconcentrationPlan.js');
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

test('T1: 签名策略版本 v3.1.0 哈希校验与准入账本放行', () => {
  const policy = loadApprovedV3Policy();
  assert.equal(policy.approved, true);
  assert.equal(policy.version, 'v3.1.0');
  assert.equal(policy.content_hash, V3_POLICY_EXPECTED_HASH);
  assert.equal(policy.bp1_pullback_enabled, true);
  assert.equal(policy.bp2_breakout_enabled, false);
  assert.equal(policy.bp2_breakout_status, 'DROPPED_NEGATIVE_OOS');

  const admDir = join(dir, 'adm-private');
  mkdirSync(admDir, { recursive: true });
  chmodSync(admDir, 0o700);
  const store = new StrategyAdmissionStore(join(admDir, 'admission.sqlite'), { create: true });
  try {
    const scope = {
      account: 'real',
      market: V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.applicability.market,
      environment: V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.applicability.environment,
    };
    const validFrom = '2026-11-15T00:00:00.000Z';
    const validUntil = '2099-12-31T00:00:00.000Z';
    store.record('GRANT', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0, scope, {
      reason: 'Phase 2 EXP-V3-01/02/03 validated',
      validFrom,
      validUntil,
    });
    assert.equal(
      store.check(V3_OFFENSIVE_POLICY_RELEASE_V3_1_0, scope, V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.strategy.implementation_sha256),
      true,
    );

    const unapproved = { ...V3_OFFENSIVE_POLICY_RELEASE_V3_1_0, production_admission: 'NOT_APPROVED' };
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
    assert.equal(report.v3_cockpit.policy_release.version, 'v3.1.0');
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
