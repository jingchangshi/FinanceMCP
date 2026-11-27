import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v340-data-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { importV34PitSeedIntoDb } = await import('../build/ashare/pitSeedImporter.js');
const { evaluateB1EnvelopeStep, evaluateFundamentalRegime } = await import('../build/ashare/fundamentalRegime.js');
const { syncMacroYieldCurve, computeAndStoreMarketFundamentalDaily } = await import('../build/ashare/marketFundamentalDaily.js');
const { evaluateQualityCoreV2 } = await import('../build/ashare/qualityCore.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const {
  setForwardViewOverlay,
  revokeForwardViewOverlay,
  listForwardViewOverlays,
  evaluateForwardViewOverlay,
} = await import('../build/portfolio/forwardViewOverlay.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport, assertUserReportClean } = await import('../build/portfolio/reportRenderer.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { weekdays } = await import('./ashare-fixture.mjs');

test('legacy ashare.sqlite migrates bps column safely and imports v3.4.0 PIT seed idempotently', t => {
  const legacyPath = join(dir, 'legacy-ashare.sqlite');
  const legacyRaw = new DatabaseSync(legacyPath);
  legacyRaw.exec(`
    CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER, pretrade_date TEXT);
    CREATE TABLE fina_indicator (
      ts_code TEXT NOT NULL, ann_date TEXT NOT NULL, end_date TEXT NOT NULL,
      eps REAL, roe REAL, roe_dt REAL, debt_to_assets REAL, netprofit_yoy REAL, or_yoy REAL, ocf_to_profit REAL,
      PRIMARY KEY (ts_code, ann_date, end_date)
    );
    INSERT INTO fina_indicator (ts_code, ann_date, end_date, eps, roe, roe_dt, ocf_to_profit)
    VALUES ('600036.SH', '20260425', '20260331', 1.2, 4.0, 3.8, 92.0);
  `);
  legacyRaw.close();

  const db = openAshareDb(legacyPath);
  t.after(() => db.close());

  const cols = db.prepare('PRAGMA table_info(fina_indicator)').all().map(c => c.name);
  assert.ok(cols.includes('bps'), 'bps column must be migrated onto legacy fina_indicator');

  const cacheDir = join(dir, 'pit_cache');
  mkdirSync(cacheDir, { recursive: true });
  const seedSql = new DatabaseSync(join(cacheDir, 'fina_40q_pit.sqlite'));
  seedSql.exec(`
    CREATE TABLE fina_pit (
      ts_code TEXT NOT NULL, ann_date TEXT NOT NULL, end_date TEXT NOT NULL,
      basic_eps REAL, diluted_eps REAL, bps REAL, roe REAL, roe_dt REAL,
      debt_to_assets REAL, netprofit_yoy REAL, or_yoy REAL, ocf_to_profit REAL,
      PRIMARY KEY (ts_code, end_date, ann_date)
    );
    INSERT INTO fina_pit VALUES ('600519.SH','20261029','20260930',18.5,18.5,192.0,22.0,21.5,19.0,12.0,11.0,98.0);
  `);
  seedSql.close();
  writeFileSync(
    join(cacheDir, 'macro_yield_curve_2018_2026.csv'),
    'trade_date,cgb_1y_pct,cgb_10y_pct,source,cgb_1y_bps,cgb_10y_bps,term_spread_10y_1y_bps\n20261126,1.45,2.10,chinabond,145,210,65\n',
  );
  writeFileSync(
    join(cacheDir, 'market_fundamental_daily_2018_2026.csv'),
    'trade_date,ep_median_bps,bp_median_bps,erp_bps,edi_bps,dv_ttm_lowvol_bps,erp_pct_756,bp_pct_756\n20261126,710,6800,500,1250,480,0.84,0.73\n',
  );

  const first = importV34PitSeedIntoDb(db, { cacheDir });
  assert.equal(first.fina_rows_imported, 1);
  assert.equal(first.macro_yield_rows_imported, 1);
  assert.equal(first.market_fundamental_rows_imported, 1);

  const second = importV34PitSeedIntoDb(db, { cacheDir });
  assert.equal(second.fina_rows_imported, 1);
  const finaCount = db.prepare('SELECT COUNT(*) AS n FROM fina_indicator').get().n;
  assert.equal(finaCount, 2, 'idempotent upsert preserves existing row + adds seed row without duplication');
  const syncRow = db.prepare("SELECT status FROM sync_log WHERE dataset='fina_indicator' AND key='20260930'").get();
  assert.equal(syncRow?.status, 'ok', 'imported quarters logged in sync_log so daily ingest skips 40Q refetch');
});

test('ChinaBond and daily fundamental Fail-Safe reuses <=5 trade-day cached row on timeout', async t => {
  const db = openAshareDb(join(dir, 'failsafe-market.sqlite'));
  t.after(() => db.close());
  const days = weekdays('20261116', 10);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));
  db.prepare(`
    INSERT INTO macro_yield_curve (trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source)
    VALUES (?, 140, 215, 75, 'chinabond_seed')
  `).run(days[4]);
  db.prepare(`
    INSERT INTO market_fundamental_daily (trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps)
    VALUES (?, 750, 6900, 490, 535, 0.85, 0.75, 1100)
  `).run(days[4]);

  const macroSync = await syncMacroYieldCurve(db, days[6], {
    fetcher: async () => { throw new Error('ETIMEDOUT chinabond'); },
  });
  assert.equal(macroSync.status, 'fallback');
  assert.equal(macroSync.fallback_from_date, days[4]);
  assert.ok(macroSync.warning?.includes('沿用'));

  // No bars for days[6] -> fundamental calculation falls back to <=5 trade days cached row (days[4])
  const fundSync = computeAndStoreMarketFundamentalDaily(db, days[6]);
  assert.equal(fundSync.status, 'fallback');
  assert.equal(fundSync.fallback_from_date, days[4]);
  assert.ok(fundSync.warning?.includes(days[4]));

  const b1Eval = evaluateFundamentalRegime(db, days[6]);
  assert.equal(b1Eval.available, true);
  assert.equal(b1Eval.b1_state, 'EXTREME_UNDERVAL');
});

test('B1 5% hysteresis prevents boundary whipsaw', () => {
  assert.equal(evaluateB1EnvelopeStep(0.80, 0.70, 'NEUTRAL'), 'EXTREME_UNDERVAL');
  // Inside hysteresis buffer [0.75, 0.80) / [0.65, 0.70) -> remains EXTREME_UNDERVAL
  assert.equal(evaluateB1EnvelopeStep(0.76, 0.66, 'EXTREME_UNDERVAL'), 'EXTREME_UNDERVAL');
  // Drops below exit threshold < 0.75 or < 0.65 -> exits to NEUTRAL
  assert.equal(evaluateB1EnvelopeStep(0.74, 0.68, 'EXTREME_UNDERVAL'), 'NEUTRAL');

  assert.equal(evaluateB1EnvelopeStep(0.15, 0.15, 'NEUTRAL'), 'EXTREME_BUBBLE');
  assert.equal(evaluateB1EnvelopeStep(0.19, 0.19, 'EXTREME_BUBBLE'), 'EXTREME_BUBBLE');
  assert.equal(evaluateB1EnvelopeStep(0.21, 0.18, 'EXTREME_BUBBLE'), 'NEUTRAL');
});

test('FVO DB CRUD, TTL <= 20 trade-day guard, 60d attribution halving, L1 positive zeroing, and CLI roundtrip', t => {
  const mdb = openAshareDb(join(dir, 'fvo-market.sqlite'));
  const pdb = openPortfolioDb(join(dir, 'fvo-portfolio.sqlite'), { marketPath: join(dir, 'fvo-market.sqlite') });
  t.after(() => { mdb.close(); pdb.close(); });

  const days = weekdays('20261102', 35);
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));

  // Reject > 20 trade days TTL
  assert.throws(() => setForwardViewOverlay(pdb, {
    accountId: 'acc-1', createdDate: days[0], expiresTradeDate: days[25],
    equityDeltaBps: 800, invalidationRuleJson: '{"trigger":"break"}', thesisSummary: 'test',
  }, mdb), /fvo_ttl_exceeds_20_trade_days/);

  // Reject out-of-range delta
  assert.throws(() => setForwardViewOverlay(pdb, {
    accountId: 'acc-1', createdDate: days[0], expiresTradeDate: days[10],
    equityDeltaBps: 1200, invalidationRuleJson: '{"trigger":"break"}', thesisSummary: 'test',
  }, mdb), /fvo_equity_delta_bps_out_of_range/);

  const row = setForwardViewOverlay(pdb, {
    accountId: 'acc-1', createdDate: days[0], expiresTradeDate: days[10],
    equityDeltaBps: 800, invalidationRuleJson: '{"trigger":"ma20"}', thesisSummary: '降准预期',
  }, mdb);
  assert.equal(listForwardViewOverlays(pdb, 'acc-1', { activeOnly: true }).length, 1);

  // Normal active
  const normal = evaluateForwardViewOverlay({
    portfolioDb: pdb, accountId: 'acc-1', asOf: days[5],
    circuitBreakerStatus: 'NORMAL', hwmDrawdownBps: 200, workHwmDrawdownBps: 200, b1State: 'NEUTRAL',
  });
  assert.equal(normal.effective_delta_bps, 800);

  // 60d attribution <= -150bps halves ±1000bps cap -> ±500bps
  const halved = evaluateForwardViewOverlay({
    portfolioDb: pdb, accountId: 'acc-1', asOf: days[5],
    circuitBreakerStatus: 'NORMAL', hwmDrawdownBps: 200, workHwmDrawdownBps: 200,
    b1State: 'NEUTRAL', attribution60dBps: -180,
  });
  assert.equal(halved.band_halved, true);
  assert.equal(halved.max_abs_delta_bps, 500);
  assert.equal(halved.effective_delta_bps, 500);

  // Negative FVO stays permitted under L1 / bubble while positive FVO is zeroed
  setForwardViewOverlay(pdb, {
    accountId: 'acc-2', createdDate: days[0], expiresTradeDate: days[10],
    equityDeltaBps: -700, invalidationRuleJson: '{"trigger":"stop"}', thesisSummary: '防风险',
  }, mdb);
  const negUnderL1 = evaluateForwardViewOverlay({
    portfolioDb: pdb, accountId: 'acc-2', asOf: days[5],
    circuitBreakerStatus: 'L1_WARN', hwmDrawdownBps: 850, workHwmDrawdownBps: 850, b1State: 'EXTREME_BUBBLE',
  });
  assert.equal(negUnderL1.effective_delta_bps, -700);

  revokeForwardViewOverlay(pdb, { accountId: 'acc-1', overlayId: row.overlay_id });
  const afterRevoke = evaluateForwardViewOverlay({
    portfolioDb: pdb, accountId: 'acc-1', asOf: days[5],
    circuitBreakerStatus: 'NORMAL', hwmDrawdownBps: 0, workHwmDrawdownBps: 0, b1State: 'NEUTRAL',
  });
  assert.equal(afterRevoke.effective_delta_bps, 0);

  // CLI roundtrip check via compiled build/ashare/cli.js
  importSnapshot(pdb, {
    snapshot_id: 'snap-acc1',
    as_of: days[0],
    source: 'test',
    note: 'fvo cli test',
    warnings: [],
    is_current: false,
    positions: [],
    totals: { total_assets_cents: 10_000_000, securities_mv_cents: 0, cash_cents: 10_000_000, wealth_cents: 0, unrealized_pnl_cents: 0 },
  });
  initBaseline(pdb, 'acc-1', { asOf: days[0], snapshotId: 'snap-acc1' });
  confirmRealAccount(pdb, 'acc-1', { confirm: true, note: 'test' });
  const cliOut = execFileSync(process.execPath, [
    'build/ashare/cli.js', 'portfolio-fvo', 'list', '--account', 'acc-1',
  ], {
    cwd: '/home/jcshi/workspace/FinanceMCP',
    env: { ...process.env, ASHARE_PORTFOLIO_DB_PATH: join(dir, 'fvo-portfolio.sqlite'), ASHARE_DB_PATH: join(dir, 'fvo-market.sqlite') },
    encoding: 'utf8',
  });
  assert.ok(JSON.parse(cliOut).overlays.some(r => r.overlay_id === row.overlay_id && r.status === 'REVOKED'));
});

test('QualityCore v2 seasonal annualization and Feishu 3-column pure-Chinese report cleanliness', async t => {
  assert.equal(evaluateQualityCoreV2({ end_date: '20260331', ann_date: '20260425', roe_dt: 1.6, eps: 0.2, ocf_to_profit: 55, bps: 3 }, '20260501').passed, true);
  assert.equal(evaluateQualityCoreV2({ end_date: '20260630', ann_date: '20260825', roe_dt: 3.0, eps: 0.4, ocf_to_profit: 60, bps: 4 }, '20260901').passed, false);
  assert.equal(evaluateQualityCoreV2({ end_date: '20261231', ann_date: '20270330', roe_dt: 6.1, eps: 0.5, ocf_to_profit: 50, bps: 5 }, '20270401').passed, true);

  const mdbPath = join(dir, 'report-market.sqlite');
  const pdbPath = join(dir, 'report-portfolio.sqlite');
  const mdb = openAshareDb(mdbPath);
  const pdb = openPortfolioDb(pdbPath, { marketPath: mdbPath });
  t.after(() => { mdb.close(); pdb.close(); });

  const days = weekdays('20260901', 45);
  const asOf = days[days.length - 1];
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));
  for (const idxCode of ['000300.SH', '000905.SH', '399006.SZ']) {
    upsertRows(mdb, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map(d => ({ ts_code: idxCode, trade_date: d, open: 100, high: 101, low: 99, close: 100, pre_close: 100, pct_chg: 0, vol: 1e6, amount: 1e7 })),
    );
  }
  upsertRows(mdb, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'type', 'market', 'status'], [
    { ts_code: '159549.SZ', name: '红利低波100ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '红利低波', type: 'E', market: 'E', status: 'L' },
    { ts_code: '159649.SZ', name: '国开债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '国开债', type: 'E', market: 'E', status: 'L' },
  ]);
  upsertRows(mdb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    ['159549.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, trade_date: d, open: 10, high: 10, low: 10, close: 10, pre_close: 10, pct_chg: 0, vol: 1e5, amount: 1e6 }))),
  );
  upsertRows(mdb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
    ['159549.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, trade_date: d, adj_factor: 1 }))),
  );
  upsertRows(mdb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
    ['159549.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, trade_date: d, fd_share: 1e7, fund_type: 'ETF', market: 'E' }))),
  );
  upsertRows(mdb, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
    ['159549.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, ann_date: d, nav_date: d, unit_nav: 10, accum_nav: 10, adj_nav: 10 }))),
  );
  mdb.prepare(`
    INSERT INTO market_fundamental_daily (trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps)
    VALUES (?, 700, 6500, 455, 500, 0.55, 0.55, 920)
  `).run(asOf);
  mdb.prepare(`
    INSERT INTO macro_yield_curve (trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source)
    VALUES (?, 140, 210, 70, 'chinabond')
  `).run(asOf);

  importSnapshot(pdb, {
    snapshot_id: 'snap-v340',
    as_of: asOf,
    source: 'test',
    note: 'v3.4.0 report',
    warnings: [],
    is_current: false,
    positions: [{ ts_code: '159549.SZ', name: '红利低波100ETF', quantity: 1000, ref_price_milli: 10_000, ref_cost_milli: 10_000, market_value_cents: 1_000_000 }],
    totals: {
      total_assets_cents: 10_000_000,
      securities_mv_cents: 1_000_000,
      cash_cents: 9_000_000,
      wealth_cents: 0,
      unrealized_pnl_cents: 0,
    },
  });
  initBaseline(pdb, 'main', { asOf, snapshotId: 'snap-v340' });
  markSnapshotCurrent(pdb, 'snap-v340', { confirmedBy: 'test' });
  confirmRealAccount(pdb, 'main', { confirm: true, note: 'test' });
  setAccountCompleteness(pdb, 'main', { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });

  const report = buildDailyReport({
    portfolioDb: pdb,
    marketDb: mdb,
    accountId: 'main',
    snapshotId: 'snap-v340',
    asOfTradeDate: asOf,
  });
  assert.ok(report.v3_cockpit?.three_pillar_cockpit);
  const rendered = renderDailyReport(report, { now: '2026-10-07T20:30:00+08:00' });
  assertUserReportClean(rendered.user);
  assert.ok(rendered.user.includes('【技术面】'));
  assert.ok(rendered.user.includes('【基本面】'));
  assert.ok(rendered.user.includes('【未来预期】'));
  assert.ok(rendered.user.includes('0 主观偏移，纯系统运行'));
});
