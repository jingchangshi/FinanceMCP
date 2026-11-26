import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v330-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { CORE_INDICES } = await import('../build/ashare/ingest.js');
const { evaluateMarketRegime } = await import('../build/ashare/marketRegime.js');
const { screenSectorPioneerCandidates } = await import('../build/ashare/sectorPioneer.js');
const { validateStrategyRelease } = await import('../build/ashare/strategyRelease.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { loadApprovedV3Policy } = await import('../build/portfolio/v3Policy.js');
const { evaluateStrategyRouter, persistRiskAnchor, readRiskAnchor } = await import('../build/portfolio/strategyRouter.js');
const { runActionEngine } = await import('../build/portfolio/actionEngine.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport, assertUserReportClean } = await import('../build/portfolio/reportRenderer.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const V330_HASH = 'e192ffc764f2bcf5ccd020e62254d1e1b518a6ab7a9074acd1d91c74a5462051';
const TACTICORE_RELEASE = (process.env.TACTICORE_ROOT?.trim() || '/home/jcshi/workspace/TactiCore')
  + '/research/ashare/releases/v3_offensive_policy_release_v3.3.0.json';
const INVESTOR_RELEASE = (process.env.ASHARE_INVESTOR_ROOT?.trim() || '/home/jcshi/workspace/AShareInvestor')
  + '/docs/v3-offensive-system/fee-profiles/v3_offensive_policy_release_v3.3.0.json';

function candidateRow({
  code,
  name,
  asOf = '20261120',
  closeMilli,
  category = 'broad_based',
  buyBlocked = false,
  included = true,
  score = 0.5,
}) {
  return {
    rank: 1,
    ts_code: code,
    category,
    category_label: category,
    name,
    name_source: 'fund_basic',
    held: false,
    included,
    eligibility: included ? 'eligible' : 'excluded',
    status: 'OK',
    status_reasons: [],
    as_of_trade_date: asOf,
    filters: {
      premium_discount: {
        state: buyBlocked ? 'block' : 'pass',
        detail: '',
        value_pct: 0.1,
        premium_bps: 10,
        unit_nav: closeMilli / 1000,
        nav_date: asOf,
        lag_trade_days: 0,
        nav_stale: false,
        buy_blocked: buyBlocked,
      },
    },
    data: {
      bars_used: 60,
      latest_bar_date: asOf,
      latest_close_milli: closeMilli,
      price_basis: 'qfq_adjusted',
      adj_base: null,
      adj_missing_bars: 0,
      share: { fd_share_wan: 100_000, trade_date: asOf },
      size_wan_cny: 10_000_000,
      unit_nav: closeMilli / 1000,
      nav_date: asOf,
      premium_bps: 10,
      nav_stale: false,
      buy_blocked: buyBlocked,
      coverage: {
        fund_basic: true, fund_daily: true, fund_adj: true, fund_share: true, fund_nav: true, latest_trade_date: asOf,
      },
    },
    exclusions: [],
    score,
    score_components: {},
    source: 'server_cache',
    research: {},
  };
}

let dbSeq = 0;
function freshPortfolioDb() {
  dbSeq += 1;
  return openPortfolioDb(join(dir, `v330-${dbSeq}-portfolio.sqlite`), {
    marketPath: join(dir, `v330-${dbSeq}-market.sqlite`),
  });
}

function makeV330Policy(overrides = {}) {
  const base = loadApprovedV3Policy();
  return {
    ...base,
    version: 'v3.3.0',
    l1_warn_drawdown_bps: 800,
    l2_normal_trigger_drawdown_bps: 1350,
    l2_normal_post_breaker_equity_bps: 1000,
    l2_preemptive_deconcentration_trigger_drawdown_bps: 1200,
    l2_deconcentration_post_breaker_equity_bps: 0,
    l2_lock_trade_days: 10,
    defensive_bond_reservoir_etf: '159649.SZ',
    defensive_bond_reservoir_fallback_etf: '511260.SH',
    defensive_bond_reservoir_tertiary_etf: '511010.SH',
    defensive_bond_reservoir_drift_band_bps: 1000,
    recovery_overlay_enabled: true,
    recovery_equity_bps: 4000,
    lowvol_core_permanent_share_bps: 3000,
    drawdown_control_mode: 'TWO_STAGE_GRADUAL',
    drawdown_stage1_bps: 800,
    drawdown_stage1_cap_bps: 5000,
    drawdown_stage2_bps: 1100,
    drawdown_stage2_cap_bps: 2500,
    drawdown_lock_trigger_bps: 1350,
    drawdown_unlock_reanchor_enabled: true,
    drawdown_unlock_ramp_trade_days: 10,
    sector_pioneer_enabled: true,
    sector_pioneer_top_k: 1,
    sector_pioneer_max_weight_bps: 2000,
    stock_bp1_min_investable_nav_cny: 100_000,
    stock_bp1_block_during_deconcentration: true,
    ...overrides,
  };
}

test('v3.3.0 release JSON cross-repo parity and runtime override verification', t => {
  if (!existsSync(TACTICORE_RELEASE)) {
    t.skip(`TactiCore release not present at ${TACTICORE_RELEASE}`);
    return;
  }
  const raw = readFileSync(TACTICORE_RELEASE);
  const parsed = JSON.parse(raw.toString('utf8'));
  assert.equal(validateStrategyRelease(parsed), V330_HASH);
  if (existsSync(INVESTOR_RELEASE)) {
    assert.ok(readFileSync(INVESTOR_RELEASE).equals(raw), 'TactiCore and AShareInvestor v3.3.0 JSONs must be byte-identical');
  }

  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });

  process.env.ASHARE_V3_POLICY_RELEASE_PATH = TACTICORE_RELEASE;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = V330_HASH;
  const policy = loadApprovedV3Policy({ asOf: '20261126' });
  assert.equal(policy.approved, true);
  assert.equal(policy.version, 'v3.3.0');
  assert.equal(policy.content_hash, V330_HASH);
  assert.deepEqual(policy.override_diagnostics, []);
  assert.equal(policy.runtime_can_open, true);
  assert.equal(policy.defensive_bond_reservoir_etf, '159649.SZ');
  assert.equal(policy.defensive_bond_reservoir_fallback_etf, '511260.SH');
  assert.equal(policy.defensive_bond_reservoir_tertiary_etf, '511010.SH');
  assert.equal(policy.defensive_bond_reservoir_drift_band_bps, 1000);
  assert.equal(policy.lowvol_core_permanent_share_bps, 3000);
  assert.equal(policy.recovery_overlay_enabled, true);
  assert.equal(policy.recovery_equity_bps, 4000);
  assert.equal(policy.drawdown_control_mode, 'TWO_STAGE_GRADUAL');
  assert.equal(policy.drawdown_stage1_bps, 800);
  assert.equal(policy.drawdown_stage1_cap_bps, 5000);
  assert.equal(policy.drawdown_stage2_bps, 1100);
  assert.equal(policy.drawdown_stage2_cap_bps, 2500);
  assert.equal(policy.drawdown_lock_trigger_bps, 1350);
  assert.equal(policy.l2_normal_post_breaker_equity_bps, 1000);
  assert.equal(policy.l2_lock_trade_days, 10);
  assert.equal(policy.sector_pioneer_enabled, true);
  assert.equal(policy.sector_pioneer_top_k, 1);
  assert.equal(policy.sector_pioneer_max_weight_bps, 2000);
  assert.equal(policy.stock_bp1_min_investable_nav_cny, 100_000);
  assert.equal(policy.stock_bp1_block_during_deconcentration, true);
});

test('M2 recovery overlay: deadcat rejected, icepoint thrust enters 40%, 5d-low break exits to cooldown', () => {
  const days = weekdays('20260701', 80);
  const mdb = openAshareDb(join(dir, 'm2-market.sqlite'));
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));

  // 持久下跌形成 BEAR 双锚：前 69 日稳步下行，day 72 仍高于前 5 日最低点，day 73 跌穿前 5 日最低点。
  const idxRows = [];
  const dailyRows = [];
  const limitRows = [];
  const pct60 = {};
  const pct20 = {};
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    const isThrustVol = i === 71 || i === 74;
    const isDeadcatVol = i === 70;
    const isLowBreak = i === 72 || i === 73 || i === 74;
    const hsBase = 4000 - i * 8;
    const csiBase = 5500 - i * 10;
    const hsClose = isLowBreak ? hsBase - 120 : hsBase;
    const csiClose = isLowBreak ? csiBase - 180 : csiBase;
    for (const [code, cl] of [['000300.SH', hsClose], ['000905.SH', csiClose], ['399006.SZ', 2200 - i * 4]]) {
      idxRows.push({ ts_code: code, trade_date: d, open: cl, high: cl + 5, low: cl - 5, close: cl, pre_close: cl + 5, pct_chg: -0.3, vol: 1e7, amount: 1e7 });
    }
    const amt = isThrustVol ? 15_000_000 : isDeadcatVol ? 9_000_000 : 10_000_000;
    dailyRows.push({ ts_code: '600000.SH', trade_date: d, open: 10, high: 10.2, low: 9.8, close: 10, pre_close: 10, pct_chg: 0, vol: 1e6, amount: amt });
    limitRows.push({ ts_code: '600000.SH', trade_date: d, up_limit: 11, down_limit: 9 });

    if (i < 64) {
      pct60[d] = 0.25;
      pct20[d] = 0.25;
    } else if (i <= 69) {
      pct60[d] = 0.12;
      pct20[d] = 0.10;
    } else if (i === 70) {
      // Deadcat bounce: high breadth jump but weak volume (<1.15x MA20)
      pct60[d] = 0.16;
      pct20[d] = 0.48;
    } else if (i === 71) {
      // True M2 breadth thrust after icepoint
      pct60[d] = 0.19;
      pct20[d] = 0.50;
    } else if (i === 72 || i === 73) {
      // Breaks 5d pre-trigger lows -> stops out into 10d cooldown
      pct60[d] = 0.12;
      pct20[d] = 0.10;
    } else {
      // Attempted re-trigger inside cooldown
      pct60[d] = 0.20;
      pct20[d] = 0.55;
    }
  }
  upsertRows(mdb, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [
    { ts_code: '600000.SH', symbol: '600000', name: '样本银行', industry: '银行', list_date: '20100101', list_status: 'L' },
  ]);
  upsertRows(mdb, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], idxRows);
  upsertRows(mdb, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], dailyRows);
  upsertRows(mdb, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], limitRows);

  const opts = {
    hysteresisLookbackDays: 20,
    pctAboveMa60ByDate: pct60,
    pctAboveMa20ByDate: pct20,
    recoveryOverlay: { enabled: true },
  };
  const rDeadcat = evaluateMarketRegime(mdb, days[70], opts);
  assert.equal(rDeadcat.regime, 'DEFENSIVE', 'dead-cat bounce without 1.15x volume stays DEFENSIVE');

  const rThrust = evaluateMarketRegime(mdb, days[71], opts);
  assert.equal(rThrust.regime, 'RECOVERY');
  assert.equal(rThrust.target_equity_bps, 4000);
  assert.equal(rThrust.recovery_state?.active, true);
  assert.equal(rThrust.recovery_state?.triggered_today, true);

  const rStopped = evaluateMarketRegime(mdb, days[72], opts);
  assert.equal(rStopped.regime, 'DEFENSIVE');
  assert.equal(rStopped.recovery_state?.stopped_today, true);
  assert.equal(rStopped.recovery_state?.in_cooldown, true);

  const rCooldownBlocked = evaluateMarketRegime(mdb, days[74], opts);
  assert.equal(rCooldownBlocked.regime, 'DEFENSIVE', 'second thrust inside 10d cooldown must remain blocked');
  mdb.close();
});

test('30% permanent low-vol core + 159649->511260 bond reservoir + 10% drift band', () => {
  const db = freshPortfolioDb();
  const policy = makeV330Policy({ sector_pioneer_enabled: false });
  const cands = [
    candidateRow({ code: '159330.SZ', name: '东财沪深300ETF', closeMilli: 4000 }),
    candidateRow({ code: '159205.SZ', name: '东财创业板ETF', closeMilli: 1000 }),
    candidateRow({ code: '159337.SZ', name: '东财中证500ETF', closeMilli: 2000 }),
    candidateRow({ code: '589850.SH', name: '东财科创50ETF', closeMilli: 1000 }),
    candidateRow({ code: '159549.SZ', name: '红利低波100ETF', closeMilli: 1000, category: 'industry_theme' }),
    candidateRow({ code: '159207.SZ', name: '智选高股息ETF', closeMilli: 1000, category: 'industry_theme' }),
    candidateRow({ code: '159649.SZ', name: '国开债ETF', closeMilli: 10_000, category: 'bond' }),
    candidateRow({ code: '511260.SH', name: '十年国债ETF', closeMilli: 12_000, category: 'bond' }),
    candidateRow({ code: '511010.SH', name: '国债ETF', closeMilli: 100_000, category: 'bond' }),
  ];
  const offensiveRegime = {
    schema: 'ashare-market-regime/1.0', as_of_trade_date: '20261120', available: true,
    regime: 'OFFENSIVE', raw_regime: 'OFFENSIVE', target_equity_bps: 8500, target_equity_pct: 85,
    hysteresis_held: false, crash_override: false, style: 'GROWTH_LEADING', style_spread_20d_pct: 4.5,
    value_anchor: {}, growth_anchor: {}, breadth: {}, history: [],
    regime_label_zh: '全面进攻档', style_label_zh: '成长风格占优', summary_zh: '', notes: [],
  };

  // 1) Pure cash ¥200k under OFFENSIVE -> buys permanent low-vol core + primary bond 159649.SZ
  const out1 = runActionEngine({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261120', policy,
    holdings: [], cashCents: 20_000_000, totalAssetsCents: 20_000_000,
    marketRegime: offensiveRegime, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  const reb1 = out1.actions.find(a => a.code === 'P3-SUPER-ETF-REBALANCE');
  assert.ok(reb1);
  assert.ok(reb1.legs.some(l => l.side === 'BUY' && (l.ts_code === '159549.SZ' || l.ts_code === '159207.SZ')), 'must buy permanent low-vol core');
  assert.ok(reb1.legs.some(l => l.side === 'BUY' && l.ts_code === '159649.SZ'), 'must prefer 159649.SZ bond reservoir');
  assert.equal(reb1.legs.some(l => l.side === 'BUY' && l.ts_code === '511010.SH'), false);

  // 2) Fallback: if 159649.SZ missing, uses 511260.SH
  const outFallback = runActionEngine({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261120', policy,
    holdings: [], cashCents: 20_000_000, totalAssetsCents: 20_000_000,
    marketRegime: offensiveRegime, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands.filter(c => c.ts_code !== '159649.SZ') },
  });
  const reb2 = outFallback.actions.find(a => a.code === 'P3-SUPER-ETF-REBALANCE');
  assert.ok(reb2.legs.some(l => l.side === 'BUY' && l.ts_code === '511260.SH'), 'must fallback to 511260.SH');

  // 3) Drift band (10%): DEFENSIVE 85% target vs 80% held in 511010.SH + cash -> 5% gap < 10% drift band -> skip bond buy cleanly
  const defensiveRegime = {
    ...offensiveRegime, regime: 'DEFENSIVE', raw_regime: 'DEFENSIVE', target_equity_bps: 1500, target_equity_pct: 15,
    regime_label_zh: '空头防守档',
  };
  const outBand = runActionEngine({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261120', policy,
    holdings: [
      { ts_code: '511010.SH', name: '国债ETF', quantity: 790, sellable_quantity: 790, weight: 0.79, market_value_cents: 7_900_000, price_milli: 100_000, latest_bar_date: '20261120', bar_quality: 'READY' },
      { ts_code: '159549.SZ', name: '红利低波100ETF', quantity: 15_000, sellable_quantity: 15_000, weight: 0.15, market_value_cents: 1_500_000, price_milli: 1000, latest_bar_date: '20261120', bar_quality: 'READY' },
    ],
    cashCents: 600_000, totalAssetsCents: 10_000_000,
    marketRegime: defensiveRegime, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.equal(outBand.actions.length, 0, 'within 10% bond drift band and equity target met -> zero churn');
  db.close();
});

test('TWO_STAGE_GRADUAL drawdown (-8%->50%, -11%->25%, -13.5%->10d lock) + unlock work-peak reanchor preserving true HWM', () => {
  const db = freshPortfolioDb();
  const policy = makeV330Policy();
  const structuralRegime = {
    schema: 'ashare-market-regime/1.0', as_of_trade_date: '20261110', available: true,
    regime: 'STRUCTURAL', raw_regime: 'STRUCTURAL', target_equity_bps: 6000, target_equity_pct: 60,
    hysteresis_held: false, crash_override: false, style: 'BALANCED', style_spread_20d_pct: 0,
    value_anchor: {}, growth_anchor: {}, breadth: {}, history: [],
    regime_label_zh: '震荡结构档', style_label_zh: '大小盘均衡', summary_zh: '', notes: [],
  };

  // Seed initial HWM = 100k on 20261110
  const r0 = evaluateStrategyRouter({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261110',
    currentNavCents: 10_000_000, marketRegime: structuralRegime, policy,
  });
  assert.equal(persistRiskAnchor(db, r0), true);

  // Stage 1 (-8.5% -> 50% cap & P0 trim if holding 80% equity)
  const rStage1 = evaluateStrategyRouter({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261111',
    currentNavCents: 9_150_000, marketRegime: { ...structuralRegime, as_of_trade_date: '20261111' }, policy,
  });
  assert.equal(rStage1.circuit_breaker_status, 'L1_WARN');
  assert.equal(rStage1.drawdown_control_stage, 'STAGE1_CAP_50');
  assert.equal(rStage1.drawdown_equity_cap_bps, 5000);
  assert.equal(rStage1.targets.target_equity_bps, 5000);
  assert.equal(rStage1.sub_strategies.s_stock_swing, 'STOP_ONLY');

  const engStage1 = runActionEngine({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261111', policy,
    holdings: [
      { ts_code: '159330.SZ', name: '沪深300ETF', quantity: 20_000, sellable_quantity: 20_000, weight: 0.874, market_value_cents: 8_000_000, price_milli: 4000, latest_bar_date: '20261111', bar_quality: 'READY' },
    ],
    cashCents: 1_150_000, totalAssetsCents: 9_150_000,
    marketRegime: { ...structuralRegime, as_of_trade_date: '20261111' }, stockSwingScreen: { candidates: [] },
  });
  assert.ok(engStage1.actions.some(a => a.code === 'P0-DRAWDOWN-CAP-SELL-159330.SZ'), 'Stage 1 breach must emit P0 cap trim');

  // Stage 2 (-11.5% -> 25% cap)
  const rStage2 = evaluateStrategyRouter({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261112',
    currentNavCents: 8_850_000, marketRegime: { ...structuralRegime, as_of_trade_date: '20261112' }, policy,
  });
  assert.equal(rStage2.circuit_breaker_status, 'L1_WARN');
  assert.equal(rStage2.drawdown_control_stage, 'STAGE2_CAP_25');
  assert.equal(rStage2.drawdown_equity_cap_bps, 2500);
  assert.equal(rStage2.targets.target_equity_bps, 2500);

  // L2 Trigger (-14.0% >= 13.5%)
  const rL2 = evaluateStrategyRouter({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: '20261113',
    currentNavCents: 8_600_000, marketRegime: { ...structuralRegime, as_of_trade_date: '20261113' }, policy,
  });
  assert.equal(rL2.circuit_breaker_status, 'L2_LOCKED');
  assert.equal(rL2.targets.target_equity_bps, 1000);
  assert.ok(rL2.locked_until_trade_date);
  assert.equal(persistRiskAnchor(db, rL2), true);

  // Day after locked_until -> unlocks, reanchors work HWM while preserving un-reanchored true HWM!
  const unlockDay = '20261215';
  const rUnlock = evaluateStrategyRouter({
    portfolioDb: db, marketDb: null, accountId: 'real-main', asOf: unlockDay,
    currentNavCents: 8_800_000, marketRegime: { ...structuralRegime, regime: 'OFFENSIVE', raw_regime: 'OFFENSIVE', as_of_trade_date: unlockDay }, policy,
  });
  assert.equal(rUnlock.circuit_breaker_status, 'NORMAL');
  assert.equal(rUnlock.anchor_snapshot.work_hwm_nav_cents, 8_800_000, 'work HWM reanchors on unlock');
  assert.equal(rUnlock.anchor_snapshot.work_hwm_date, unlockDay);
  assert.equal(rUnlock.anchor_snapshot.work_hwm_drawdown_bps, 0);
  assert.equal(rUnlock.anchor_snapshot.hwm_nav_cents, 10_000_000, 'all-time true HWM must stay strictly un-reanchored');
  assert.equal(rUnlock.anchor_snapshot.hwm_date, '20261110');
  assert.equal(rUnlock.ramp_factor_bps, 5000, 'day 0 of 10-day ramp halves target equity to 50%');
  assert.equal(rUnlock.targets.target_equity_bps, 4250, '8500 * 0.50 = 4250 bps');
  assert.equal(persistRiskAnchor(db, rUnlock), true);

  const persisted = readRiskAnchor(db, 'real-main');
  assert.equal(persisted.hwm_nav_cents, 10_000_000);
  assert.equal(persisted.work_hwm_nav_cents, 8_800_000);
  db.close();
});

test('10A_TOP1_BLEND_MA60 sector pioneer + BP1 >=100k / deconcentration gate + clean report rendering', () => {
  const days = weekdays('20260601', 80);
  const asOf = days.at(-1);
  const mdb = openAshareDb(join(dir, 'sector-market.sqlite'));
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    ...days.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null })),
    { cal_date: weekdays(asOf, 2)[1], is_open: 1, pretrade_date: asOf },
  ]);
  upsertRows(mdb, 'fund_basic', ['ts_code', 'name'], [
    { ts_code: '159599.SZ', name: '芯片产业ETF' },
    { ts_code: '159692.SZ', name: '证券公司30ETF' },
    { ts_code: '588750.SH', name: '科创芯片ETF' },
  ]);
  const fdRows = [];
  const adjRows = [];
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    // 159599.SZ: smooth uptrend above MA60
    const pChip = 1 + i * 0.006;
    fdRows.push({ ts_code: '159599.SZ', trade_date: d, open: pChip, high: pChip + 0.01, low: pChip - 0.01, close: pChip, pre_close: pChip, pct_chg: 0.4, vol: 1e6, amount: 1e6 });
    // 159692.SZ: slower uptrend above MA60
    const pSec = 1 + i * 0.002;
    fdRows.push({ ts_code: '159692.SZ', trade_date: d, open: pSec, high: pSec + 0.01, low: pSec - 0.01, close: pSec, pre_close: pSec, pct_chg: 0.1, vol: 1e6, amount: 1e6 });
    // 588750.SH: below MA60 on last bar -> must be excluded despite huge earlier rally
    const pBelow = i === days.length - 1 ? 1.0 : 1.0 + i * 0.01;
    fdRows.push({ ts_code: '588750.SH', trade_date: d, open: pBelow, high: pBelow + 0.01, low: pBelow - 0.01, close: pBelow, pre_close: pBelow, pct_chg: 0, vol: 1e6, amount: 1e6 });
    for (const c of ['159599.SZ', '159692.SZ', '588750.SH']) {
      adjRows.push({ ts_code: c, trade_date: d, adj_factor: 1 });
    }
  }
  upsertRows(mdb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], fdRows);
  upsertRows(mdb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], adjRows);

  const screen = screenSectorPioneerCandidates(mdb, asOf, { maxCandidates: 3 });
  assert.equal(screen.candidates[0]?.ts_code, '159599.SZ', 'top blend above MA60 should rank #1');
  assert.equal(screen.candidates.some(c => c.ts_code === '588750.SH'), false, 'below MA60 must be excluded');

  const pdb = freshPortfolioDb();
  const policy = makeV330Policy();
  const offensive = {
    schema: 'ashare-market-regime/1.0', as_of_trade_date: asOf, available: true,
    regime: 'OFFENSIVE', raw_regime: 'OFFENSIVE', target_equity_bps: 8500, target_equity_pct: 85,
    hysteresis_held: false, crash_override: false, style: 'GROWTH_LEADING', style_spread_20d_pct: 4.5,
    value_anchor: {}, growth_anchor: {}, breadth: {}, history: [],
    regime_label_zh: '全面进攻档', style_label_zh: '成长风格占优', summary_zh: '', notes: [],
  };
  const cands = [
    candidateRow({ code: '159599.SZ', name: '芯片产业ETF', asOf, closeMilli: 1474, category: 'industry_theme' }),
    candidateRow({ code: '159330.SZ', name: '东财沪深300ETF', asOf, closeMilli: 4000 }),
    candidateRow({ code: '159205.SZ', name: '东财创业板ETF', asOf, closeMilli: 1000 }),
    candidateRow({ code: '159337.SZ', name: '东财中证500ETF', asOf, closeMilli: 2000 }),
    candidateRow({ code: '589850.SH', name: '东财科创50ETF', asOf, closeMilli: 1000 }),
    candidateRow({ code: '159549.SZ', name: '红利低波100ETF', asOf, closeMilli: 1000, category: 'industry_theme' }),
    candidateRow({ code: '159207.SZ', name: '智选高股息ETF', asOf, closeMilli: 1000, category: 'industry_theme' }),
    candidateRow({ code: '159649.SZ', name: '国开债ETF', asOf, closeMilli: 10_000, category: 'bond' }),
  ];

  // At 69k NAV -> BP1 stock swing gated OFF; sector pioneer buys 159599.SZ (<=20%)
  const out69k = runActionEngine({
    portfolioDb: pdb, marketDb: mdb, accountId: 'real-main', asOf, policy,
    holdings: [], cashCents: 6_900_000, totalAssetsCents: 6_900_000,
    marketRegime: offensive, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.equal(out69k.router.sub_strategies.s_stock_swing, 'STOP_ONLY', '<100k NAV must gate BP1 to STOP_ONLY');
  assert.equal(out69k.router.targets.pioneer_bps, 0);
  const secBuy = out69k.actions.find(a => a.code === 'P3-SECTOR-PIONEER-BUY-159599.SZ');
  assert.ok(secBuy, 'must emit P3-SECTOR-PIONEER-BUY-159599.SZ');
  assert.ok(secBuy.legs[0].gross_cents <= Math.floor(0.20 * 6_900_000), 'sector pioneer capped <= 20%');

  // At 120k NAV + deconcentrationActive -> BP1 gated OFF
  const outDeconc = runActionEngine({
    portfolioDb: pdb, marketDb: mdb, accountId: 'real-main', asOf, policy,
    deconcentrationActive: true, holdings: [], cashCents: 12_000_000, totalAssetsCents: 12_000_000,
    marketRegime: offensive, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.equal(outDeconc.router.sub_strategies.s_stock_swing, 'STOP_ONLY', 'deconcentrationActive must gate BP1');

  // At 120k NAV without deconcentration -> BP1 ACTIVE
  const out120k = runActionEngine({
    portfolioDb: pdb, marketDb: mdb, accountId: 'real-main', asOf, policy,
    deconcentrationActive: false, holdings: [], cashCents: 12_000_000, totalAssetsCents: 12_000_000,
    marketRegime: offensive, stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.equal(out120k.router.sub_strategies.s_stock_swing, 'ACTIVE', '>=100k unencumbered must unlock BP1');
  assert.equal(out120k.router.targets.pioneer_bps, 3500);

  // Render daily report cleanly under v3.3.0
  if (existsSync(TACTICORE_RELEASE)) {
    const repDir = join(dir, 'reports', asOf);
    mkdirSync(repDir, { recursive: true });
    writeFileSync(join(repDir, `ASR-${asOf}-V330.json`), JSON.stringify({
      report_id: `ASR-${asOf}-V330`,
      schema: 'ashare-report-1.0.0',
      as_of_trade_date: asOf,
      generated_at: `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T20:00:00+08:00`,
      status: 'READY',
      market: {
        regime: 'bull', regime_label: '偏强', tone: 'bullish', judgement: ['上涨占比 60.0%'],
        breadth: { stocks: 5000, up: 3000, down: 1900, limit_up: 50, limit_down: 5, amount_yi: 12000, amount_ma20_yi: 10000, pct_above_ma60: 55, pct_above_ma20: 60 },
      },
      sectors: { top: [], bottom: [], all: [] },
    }));
    upsertRows(mdb, 'report', ['report_id', 'trade_date', 'status', 'generated_at', 'path', 'run_mode'], [
      { report_id: `ASR-${asOf}-V330`, trade_date: asOf, status: 'READY', generated_at: '2026-09-18T20:00:00+08:00', path: `reports/${asOf}/ASR-${asOf}-V330.json`, run_mode: 'manual' },
    ]);
    upsertRows(mdb, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      Object.keys(CORE_INDICES).flatMap(code => days.map((d, i) => ({
        ts_code: code, trade_date: d, open: 3500 + i * 2, high: 3510 + i * 2, low: 3490 + i * 2,
        close: 3500 + i * 2, pre_close: 3498 + i * 2, pct_chg: 0.2, vol: 1e7, amount: 1e7,
      }))));
    upsertRows(mdb, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map(d => ({ ts_code: '159599.SZ', trade_date: d, open: 1, high: 1, low: 1, close: 1, pre_close: 1, pct_chg: 0, vol: 1e6, amount: 1e6 })));
    upsertRows(mdb, 'fund_basic', ['ts_code', 'name'], [{ ts_code: '159558.SZ', name: '半导体设备ETF' }]);
    upsertRows(mdb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map((d, i) => ({ ts_code: '159558.SZ', trade_date: d, open: 1 + i * 0.001, high: 1.01 + i * 0.001, low: 0.99 + i * 0.001, close: 1 + i * 0.001, pre_close: 1, pct_chg: 0.1, vol: 1e6, amount: 1e6 })));
    upsertRows(mdb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.map(d => ({ ts_code: '159558.SZ', trade_date: d, adj_factor: 1 })));
    upsertRows(mdb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      days.map(d => ({ ts_code: '159558.SZ', trade_date: d, fd_share: 1e8, fund_type: '股票型', market: 'E' })));
    upsertRows(mdb, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
      days.map((d, i) => ({ ts_code: '159558.SZ', ann_date: d, nav_date: d, unit_nav: 1 + i * 0.001, accum_nav: 1 + i * 0.001, adj_nav: 1 + i * 0.001 })));

    const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = TACTICORE_RELEASE;
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = V330_HASH;
    try {
      const rdb = freshPortfolioDb();
      const positions = [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20_000, ref_price_milli: 1079, ref_cost_milli: 1200, market_value_cents: 2_158_000 }];
      importSnapshot(rdb, {
        snapshot_id: 'snap-v330',
        as_of: asOf,
        source: 'test',
        note: 'v3.3.0 render test',
        warnings: [],
        is_current: false,
        positions,
        totals: {
          total_assets_cents: 2_158_000 + 4_742_000 + 3_100_000,
          securities_mv_cents: 2_158_000,
          cash_cents: 4_742_000,
          wealth_cents: 3_100_000,
          unrealized_pnl_cents: 0,
        },
      });
      initBaseline(rdb, 'real-main', { asOf, snapshotId: 'snap-v330' });
      markSnapshotCurrent(rdb, 'snap-v330', { confirmedBy: 'test' });
      confirmRealAccount(rdb, 'real-main', { confirm: true, note: 'test' });
      setAccountCompleteness(rdb, 'real-main', { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });
      const report = buildDailyReport({ portfolioDb: rdb, marketDb: mdb, accountId: 'real-main', snapshotId: 'snap-v330', asOfTradeDate: asOf });
      assert.equal(report.v3_cockpit?.policy_release.version, 'v3.3.0');
      const rendered = renderDailyReport(report, { now: '2026-09-18T20:30:00+08:00' });
      assertUserReportClean(rendered.user);
      assert.ok(rendered.attachment['15. 用户版内嵌数字'].v3_cockpit_numbers);
      rdb.close();
    } finally {
      if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
      else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
      if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
      else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
    }
  }

  pdb.close();
  mdb.close();
});
