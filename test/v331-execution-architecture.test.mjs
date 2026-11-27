import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v331-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { CORE_INDICES } = await import('../build/ashare/ingest.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { loadApprovedV3Policy, V3_OFFENSIVE_POLICY_RELEASE_V3_2_0 } = await import('../build/portfolio/v3Policy.js');
const { classifyHoldingSleeve, isRiskEquitySleeve } = await import('../build/portfolio/sleeveClassifier.js');
const { buildTargetPortfolio } = await import('../build/portfolio/targetPortfolio.js');
const { evaluateStrategyRouter, persistRiskAnchor } = await import('../build/portfolio/strategyRouter.js');
const {
  ensureDeconcentrationPlan,
  evaluateDeconcentrationPlan,
} = await import('../build/portfolio/deconcentrationPlan.js');
const { runActionEngine, syncAccountV3State } = await import('../build/portfolio/actionEngine.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport, assertUserReportClean } = await import('../build/portfolio/reportRenderer.js');
const { weekdays } = await import('./ashare-fixture.mjs');

let dbSeq = 0;
function freshPortfolioDb() {
  dbSeq += 1;
  const p = join(dir, `v331-${dbSeq}-portfolio.sqlite`);
  const m = join(dir, `v331-${dbSeq}-market.sqlite`);
  return { path: p, db: openPortfolioDb(p, { marketPath: m }) };
}

function candidateRow({
  code,
  name,
  asOf = '20261126',
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

function makeStandardCandidates(asOf = '20261126', overrides = {}) {
  return [
    candidateRow({ code: '159330.SZ', name: '沪深300ETF东财', asOf, closeMilli: 4000, score: 0.10 }),
    candidateRow({ code: '530050.SH', name: 'A500ETF东财', asOf, closeMilli: 1000, score: 0.99 }),
    candidateRow({ code: '159205.SZ', name: '创业板ETF东财', asOf, closeMilli: 1000, score: 0.20 }),
    candidateRow({ code: '159337.SZ', name: '中证500ETF东财', asOf, closeMilli: 2000, score: 0.95 }),
    candidateRow({ code: '589850.SH', name: '科创50ETF东财', asOf, closeMilli: 1000, score: 0.85 }),
    candidateRow({ code: '159549.SZ', name: '红利低波100ETF', asOf, closeMilli: 1000, category: 'industry_theme', score: 0.30 }),
    candidateRow({ code: '159207.SZ', name: '智选高股息ETF', asOf, closeMilli: 1000, category: 'industry_theme', score: 0.25 }),
    candidateRow({ code: '159649.SZ', name: '国开债ETF', asOf, closeMilli: 10_000, category: 'bond', score: 0.1 }),
    candidateRow({ code: '511260.SH', name: '十年国债ETF', asOf, closeMilli: 12_000, category: 'bond', score: 0.1 }),
  ].map(row => (overrides[row.ts_code] ? { ...row, ...overrides[row.ts_code], data: { ...row.data, ...(overrides[row.ts_code]?.data ?? {}) } } : row));
}

function makeRegime(asOf, regime = 'DEFENSIVE', style = 'BALANCED', extra = {}) {
  const map = {
    OFFENSIVE: { bps: 8500, label: '全面进攻档' },
    STRUCTURAL: { bps: 6000, label: '震荡结构档' },
    RECOVERY: { bps: 4000, label: '冰点复苏试探档' },
    DEFENSIVE: { bps: 1500, label: '空头防守档' },
  };
  return {
    schema: 'ashare-market-regime/1.0',
    as_of_trade_date: asOf,
    available: true,
    regime,
    raw_regime: regime,
    target_equity_bps: map[regime].bps,
    target_equity_pct: map[regime].bps / 100,
    hysteresis_held: false,
    crash_override: false,
    style,
    style_spread_20d_pct: style === 'GROWTH_LEADING' ? 4.0 : style === 'VALUE_LEADING' ? -4.0 : 0.0,
    value_anchor: {},
    growth_anchor: {},
    breadth: {},
    history: [],
    regime_label_zh: map[regime].label,
    style_label_zh: style === 'GROWTH_LEADING' ? '成长风格占优' : style === 'VALUE_LEADING' ? '价值风格占优' : '风格均衡',
    summary_zh: '',
    notes: [],
    ...extra,
  };
}

function makeV331Policy(overrides = {}) {
  const base = loadApprovedV3Policy();
  return {
    ...base,
    version: 'v3.3.1',
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
    deconcentration_plan_enabled: false,
    regime_target_enforced_on_existing_holdings: true,
    align_glide_carryover_bps: 3500,
    equity_align_drift_band_bps: 500,
    chassis_single_etf_per_style_bucket: true,
    p1_etf_trailing_sleeves: ['SECTOR_PIONEER'],
    ...overrides,
  };
}

function canonicalJson(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashSignedRelease(releaseWithoutHash) {
  return createHash('sha256').update(canonicalJson(releaseWithoutHash), 'utf8').digest('hex');
}

function makeSignedV331ReleaseJson(paramOverrides = {}, deleteKeys = []) {
  const parameters = {
    ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.parameters,
    deconcentration_plan_enabled: 'false',
    regime_target_enforced_on_existing_holdings: 'true',
    align_glide_carryover_bps: '3500',
    equity_align_drift_band_bps: '500',
    chassis_single_etf_per_style_bucket: 'true',
    p1_etf_trailing_sleeves: 'SECTOR_PIONEER',
    stock_bp1_min_investable_nav_cny: '100000',
    stock_bp1_block_during_deconcentration: 'true',
    l1_warn_drawdown_bps: '800',
    l2_normal_trigger_drawdown_bps: '1350',
    l2_hard_lifeline_drawdown_bps: '1350',
    l2_normal_post_breaker_equity_bps: '1000',
    l2_preemptive_trigger_drawdown_bps: '1200',
    l2_deconcentration_post_breaker_equity_bps: '0',
    l2_lock_trade_days: '10',
    defensive_bond_reservoir_etf: '159649.SZ',
    defensive_bond_reservoir_fallback_etf: '511260.SH',
    defensive_bond_reservoir_tertiary_etf: '511010.SH',
    defensive_bond_reservoir_drift_band_bps: '1000',
    recovery_overlay_enabled: 'true',
    recovery_equity_bps: '4000',
    recovery_icepoint_pct_ma60_max_bps: '1500',
    recovery_icepoint_pct_ma20_max_bps: '1500',
    recovery_icepoint_lookback_days: '10',
    recovery_thrust_pct_ma20_min_bps: '4500',
    recovery_thrust_5d_jump_min_bps: '3000',
    recovery_thrust_floor_pct_ma20_bps: '4000',
    recovery_min_amount_vs_ma20_bps: '11500',
    recovery_false_breakout_cooldown_days: '10',
    lowvol_core_permanent_share_bps: '3000',
    drawdown_control_mode: 'TWO_STAGE_GRADUAL',
    drawdown_stage1_bps: '800',
    drawdown_stage1_cap_bps: '5000',
    drawdown_stage2_bps: '1100',
    drawdown_stage2_cap_bps: '2500',
    drawdown_lock_trigger_bps: '1350',
    drawdown_normal_post_lock_cap_bps: '1000',
    drawdown_conc_post_lock_cap_bps: '0',
    drawdown_unlock_reanchor_enabled: 'true',
    drawdown_unlock_ramp_trade_days: '10',
    sector_pioneer_enabled: 'true',
    sector_pioneer_top_k: '1',
    sector_pioneer_max_weight_bps: '2000',
    ...paramOverrides,
  };
  for (const k of deleteKeys) delete parameters[k];
  const base = {
    schema_version: 'strategy-release-1',
    research_status: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.research_status,
    production_admission: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.production_admission,
    strategy: {
      ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.strategy,
      version: '3.3.1',
    },
    applicability: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability,
    execution_assumptions: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.execution_assumptions,
    inputs: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.inputs,
    rules: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.rules,
    parameters,
    evidence: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.evidence,
  };
  const hash = hashSignedRelease(base);
  return { payload: { ...base, content_hash: hash }, hash };
}

function holding({
  code,
  name,
  qty,
  sellable = qty,
  priceMilli,
  costMilli = priceMilli,
  asOf = '20261126',
}) {
  return {
    ts_code: code,
    name,
    quantity: qty,
    sellable_quantity: sellable,
    price_milli: priceMilli,
    market_value_cents: Math.round(qty * (priceMilli / 10)),
    ref_cost_milli: costMilli,
    diluted_cost_milli: costMilli,
    latest_bar_date: asOf,
    bar_quality: 'READY',
  };
}

test('v3.3.1 strict schema validation accepts clean v3.3.1 JSON and safely blocks buys on errors', t => {
  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });

  // 1) Valid v3.3.1 override JSON
  const good = makeSignedV331ReleaseJson();
  const goodPath = join(dir, 'v331-good.json');
  writeFileSync(goodPath, JSON.stringify(good.payload));
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = goodPath;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = good.hash;
  const pGood = loadApprovedV3Policy({ asOf: '20261127' });
  assert.equal(pGood.version, 'v3.3.1');
  assert.equal(pGood.runtime_can_open, true);
  assert.deepEqual(pGood.override_diagnostics, []);
  assert.equal(pGood.deconcentration_plan_enabled, false);
  assert.equal(pGood.regime_target_enforced_on_existing_holdings, true);
  assert.equal(pGood.align_glide_carryover_bps, 3500);
  assert.equal(pGood.equity_align_drift_band_bps, 500);
  assert.equal(pGood.chassis_single_etf_per_style_bucket, true);
  assert.deepEqual(pGood.p1_etf_trailing_sleeves, ['SECTOR_PIONEER']);

  // 2) Missing key, unknown enum, conflicting alias, unsupported m2_early_release -> failsafe fallback with runtime_can_open=false (never crashes)
  const cases = [
    ['missing key', makeSignedV331ReleaseJson({}, ['align_glide_carryover_bps'])],
    ['unknown enum', makeSignedV331ReleaseJson({ deconcentration_mode: 'UNKNOWN_MODE' })],
    ['alias conflict', makeSignedV331ReleaseJson({ drawdown_lock_trigger_bps: '1500', l2_normal_trigger_drawdown_bps: '1350' })],
    ['hard lifeline alias conflict', makeSignedV331ReleaseJson({ l2_hard_lifeline_drawdown_bps: '1500' })],
    ['l1 conflict', makeSignedV331ReleaseJson({ l1_warn_drawdown_bps: '700', drawdown_stage1_bps: '800' })],
    ['unsupported m2_early_release', makeSignedV331ReleaseJson({ l2_lock_allow_m2_early_release: 'true' })],
  ];
  for (const [label, bad] of cases) {
    const pBadFile = join(dir, `v331-bad-${label.replace(/\s+/g, '-')}.json`);
    writeFileSync(pBadFile, JSON.stringify(bad.payload));
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = pBadFile;
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = bad.hash;
    const pBad = loadApprovedV3Policy({ asOf: '20261127' });
    assert.equal(pBad.runtime_can_open, false, `${label}: must block new buys`);
    assert.ok(pBad.override_diagnostics.length > 0, `${label}: must emit diagnostics`);
    // Verify engine does not crash when running with fallback policy (and blocks buys while P0 still runs)
    const { db } = freshPortfolioDb();
    const out = runActionEngine({
      portfolioDb: db,
      accountId: 'real-main',
      asOf: '20261127',
      policy: pBad,
      holdings: [holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 20_000, priceMilli: 1000 })],
      cashCents: 5_000_000,
      totalAssetsCents: 7_000_000,
      marketRegime: makeRegime('20261127', 'DEFENSIVE'),
      stockSwingScreen: { candidates: [] },
      candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
    });
    assert.ok(!out.actions.some(a => a.legs.some(l => l.side === 'BUY')), `${label}: zero BUY legs when runtime_can_open=false`);
    db.close();
  }
});

test('sleeveClassifier & targetPortfolio: 1+1+2 declaration order (never score) and hold-sticky', () => {
  assert.equal(classifyHoldingSleeve('159549.SZ'), 'CHASSIS_LOWVOL');
  assert.equal(classifyHoldingSleeve('159330.SZ'), 'CHASSIS_VALUE');
  assert.equal(classifyHoldingSleeve('159205.SZ'), 'CHASSIS_GROWTH');
  assert.equal(classifyHoldingSleeve('159649.SZ'), 'BOND_RESERVOIR');
  assert.equal(classifyHoldingSleeve('511880.SH'), 'CASH_MMF');
  assert.equal(classifyHoldingSleeve('159558.SZ'), 'UNMANAGED_LEGACY');
  assert.equal(classifyHoldingSleeve('600519.SH'), 'STOCK_BP1');
  assert.equal(classifyHoldingSleeve('159819.SZ', { activeSectorPioneerCodes: new Set(['159819.SZ']) }), 'SECTOR_PIONEER');
  assert.equal(isRiskEquitySleeve('UNMANAGED_LEGACY'), true);
  assert.equal(isRiskEquitySleeve('BOND_RESERVOIR'), false);
  assert.equal(isRiskEquitySleeve('CASH_MMF'), false);
  assert.equal(isRiskEquitySleeve('CHASSIS_LOWVOL'), true);

  const policy = makeV331Policy({ sector_pioneer_enabled: false });
  const regime = makeRegime('20261126', 'OFFENSIVE', 'GROWTH_LEADING');
  const router = evaluateStrategyRouter({
    portfolioDb: null, accountId: 'real-main', asOf: '20261126', policy, marketRegime: regime,
    currentNavCents: 6_900_000, displayNavCents: 6_900_000,
  });

  // 1) Pure cash -> strictly declaration order: 159330 (not higher-score 530050), 159205 (not 159337), 159549 & 159207
  const tpPure = buildTargetPortfolio({
    policy, router, marketRegime: regime, investableAssetsCents: 6_900_000, asOf: '20261126',
    holdings: [],
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261126') },
  });
  assert.equal(tpPure.chassisTargetCodes.size, 4);
  assert.ok(tpPure.chassisTargetCodes.has('159330.SZ'));
  assert.ok(!tpPure.chassisTargetCodes.has('530050.SH'), 'must NOT select 530050 by higher score');
  assert.ok(tpPure.chassisTargetCodes.has('159205.SZ'));
  assert.ok(!tpPure.chassisTargetCodes.has('159337.SZ'), 'must NOT select 159337 by higher score');
  assert.ok(tpPure.chassisTargetCodes.has('159549.SZ'));
  assert.ok(tpPure.chassisTargetCodes.has('159207.SZ'));

  // 2) Hold-sticky with buy_blocked on 159330.SZ + existing 159558.SZ UNMANAGED_LEGACY
  const tpSticky = buildTargetPortfolio({
    policy, router, marketRegime: regime, investableAssetsCents: 10_000_000, asOf: '20261126',
    holdings: [
      { ts_code: '159330.SZ', quantity: 2000, market_value_cents: 800_000, price_milli: 4000, bar_quality: 'READY' },
      { ts_code: '159558.SZ', quantity: 10000, market_value_cents: 1_000_000, price_milli: 1000, bar_quality: 'READY' },
    ],
    candidates: {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: makeStandardCandidates('20261126', { '159330.SZ': { data: { buy_blocked: true } } }),
    },
  });
  const slot330 = tpSticky.slots.get('159330.SZ');
  assert.ok(slot330 && slot330.buy_blocked === true);
  assert.equal(slot330.target_cents, 800_000, 'buy_blocked hold-sticky keeps held without rotation or top-up');
  assert.equal(tpSticky.slots.has('530050.SH'), false, 'must NOT rotate out of held 159330.SZ into 530050.SH');
  assert.equal(tpSticky.slots.get('159558.SZ')?.target_bps, 0);
  assert.equal(tpSticky.slots.get('159558.SZ')?.sleeve, 'UNMANAGED_LEGACY');

  // 3) Upward-only sticky ("只向高优先级粘"): holding lower-priority 530050.SH upgrades ONCE when primary 159330.SZ lists
  const tpBeforeList = buildTargetPortfolio({
    policy, router, marketRegime: regime, investableAssetsCents: 10_000_000, asOf: '20261126',
    holdings: [
      { ts_code: '530050.SH', quantity: 10_000, market_value_cents: 1_000_000, price_milli: 1000, bar_quality: 'READY' },
    ],
    candidates: {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: makeStandardCandidates('20261126', { '159330.SZ': { included: false } }),
    },
  });
  assert.ok(tpBeforeList.chassisTargetCodes.has('530050.SH'), 'while 159330.SZ unavailable, keep held backup 530050.SH');
  assert.ok(!tpBeforeList.chassisTargetCodes.has('159330.SZ'));

  const tpPrimaryListed = buildTargetPortfolio({
    policy, router, marketRegime: regime, investableAssetsCents: 10_000_000, asOf: '20261126',
    holdings: [
      { ts_code: '530050.SH', quantity: 10_000, market_value_cents: 1_000_000, price_milli: 1000, bar_quality: 'READY' },
    ],
    candidates: {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: makeStandardCandidates('20261126'),
    },
  });
  assert.ok(tpPrimaryListed.chassisTargetCodes.has('159330.SZ'), 'once primary 159330.SZ lists/eligible, upgrade target to 159330.SZ');
  assert.ok(!tpPrimaryListed.chassisTargetCodes.has('530050.SH'), 'backup 530050.SH dropped from chassis targets');
  assert.equal(tpPrimaryListed.slots.get('530050.SH')?.target_bps, 0, 'backup 530050.SH marked target_bps=0 for exit');

  // After upgrading to 159330.SZ, even if 159330.SZ later becomes buy_blocked, it stays sticky and never switches back to 530050.SH
  const tpAfterUpgradeBlocked = buildTargetPortfolio({
    policy, router, marketRegime: regime, investableAssetsCents: 10_000_000, asOf: '20261126',
    holdings: [
      { ts_code: '159330.SZ', quantity: 2_000, market_value_cents: 800_000, price_milli: 4000, bar_quality: 'READY' },
    ],
    candidates: {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: makeStandardCandidates('20261126', { '159330.SZ': { data: { buy_blocked: true } } }),
    },
  });
  assert.ok(tpAfterUpgradeBlocked.chassisTargetCodes.has('159330.SZ'), 'upgraded primary 159330.SZ stays sticky when buy_blocked');
  assert.ok(!tpAfterUpgradeBlocked.chassisTargetCodes.has('530050.SH'), 'never oscillates back to backup 530050.SH');
});

test('Day-1 71.8% legacy (DEFENSIVE) + Day-2 convergence: 2-day glide, 0 LOW_VOL Day-1 buy, normal fee 159649, no bucket mix', () => {
  const { db } = freshPortfolioDb();
  const policy = makeV331Policy();
  const cands = makeStandardCandidates('20261126');
  const defensive = makeRegime('20261126', 'DEFENSIVE');

  // Investable ¥100,000: 159558.SZ ¥55,000 + 159241.SZ ¥1,500 (dust <2%) + 159278.SZ ¥15,300 = ¥71,800 (71.8%) + cash ¥28,200
  const day1Holdings = [
    holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 55_000, priceMilli: 1000 }),
    holding({ code: '159241.SZ', name: '航空航天ETF', qty: 1_500, priceMilli: 1000 }),
    holding({ code: '159278.SZ', name: '畜牧养殖ETF', qty: 15_300, priceMilli: 1000 }),
  ];

  const out1 = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261126',
    policy,
    holdings: day1Holdings,
    cashCents: 2_820_000,
    totalAssetsCents: 10_000_000,
    marketRegime: defensive,
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });

  assert.equal(out1.deconcentration.plan_status, 'CANCELLED');
  assert.equal(out1.router.deconcentration_preemptive_active, false);
  assert.equal(out1.router.l2_trigger_drawdown_bps, 1350);
  assert.ok(out1.align_summary?.enabled);
  assert.equal(out1.align_summary.target_glide_sell_cents, 3_680_000);

  // Check SELL legs: 159241 dust cleared completely, total sold ~ 36,800 CNY, and zero BUY on risk equity (0 LOW_VOL)
  const sellLegs1 = out1.actions.flatMap(a => a.legs.filter(l => l.side === 'SELL'));
  const buyLegs1 = out1.actions.flatMap(a => a.legs.filter(l => l.side === 'BUY'));
  assert.equal(sellLegs1.find(l => l.ts_code === '159241.SZ')?.quantity, 1500, 'dust < 2% must clear completely');
  assert.ok(sellLegs1.some(l => l.ts_code === '159558.SZ'));
  assert.ok(sellLegs1.some(l => l.ts_code === '159278.SZ'));
  const totalSold1 = sellLegs1.reduce((s, l) => s + l.gross_cents, 0);
  assert.ok(Math.abs(totalSold1 - 3_680_000) <= 100_000, `Day-1 sold ${totalSold1} should be ~3,680,000`);
  assert.ok(!buyLegs1.some(l => l.ts_code !== '159649.SZ'), 'Day-1 must emit 0 LOW_VOL / risk-equity buys while legacy > 15%');
  const bondBuy1 = buyLegs1.find(l => l.ts_code === '159649.SZ');
  assert.ok(bondBuy1, 'Day-1 idle cash buys 159649.SZ bond reservoir');
  assert.ok(bondBuy1.fees_cents >= 500, '159649.SZ must use normal ETF fee (>= ¥5 min), never 免五');

  // Day-2: apply Day-1 trades to snapshot and advance to 20261127
  const qtyAfter1 = new Map(day1Holdings.map(h => [h.ts_code, h.quantity]));
  let cashAfter1 = 2_820_000;
  for (const act of out1.actions) {
    for (const l of act.legs) {
      if (l.side === 'SELL') {
        qtyAfter1.set(l.ts_code, (qtyAfter1.get(l.ts_code) ?? 0) - l.quantity);
        cashAfter1 += l.net_cents;
      } else {
        qtyAfter1.set(l.ts_code, (qtyAfter1.get(l.ts_code) ?? 0) + l.quantity);
        cashAfter1 -= l.net_cents;
      }
    }
  }
  const day2Holdings = [];
  let totalMv2 = 0;
  for (const [code, qty] of qtyAfter1.entries()) {
    if (qty <= 0) continue;
    const pm = code === '159649.SZ' ? 10_000 : 1000;
    const h = holding({ code, name: code, qty, priceMilli: pm, asOf: '20261127' });
    day2Holdings.push(h);
    totalMv2 += h.market_value_cents;
  }

  const out2 = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261127',
    policy,
    holdings: day2Holdings,
    cashCents: cashAfter1,
    totalAssetsCents: totalMv2 + cashAfter1,
    marketRegime: makeRegime('20261127', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
  });

  assert.equal(out2.align_summary?.unmanaged_legacy_after_cents, 0, 'Day-2 must clear all remaining UNMANAGED_LEGACY');
  const buyLegs2 = out2.actions.flatMap(a => a.legs.filter(l => l.side === 'BUY'));
  assert.ok(buyLegs2.some(l => l.ts_code === '159549.SZ'), 'Day-2 builds 159549.SZ LOW_VOL');
  assert.ok(buyLegs2.some(l => l.ts_code === '159207.SZ'), 'Day-2 builds 159207.SZ LOW_VOL');
  assert.ok((out2.align_summary?.post_action_risk_equity_bps ?? 9999) <= 1500, 'Day-2 post-action risk equity <= 15%');
  db.close();
});

test('DAY1_LEGACY_PLUS_STAGE1 (-8.05% drawdown): max(P0, glide) not summed + single merged SELL leg per symbol', () => {
  const { db } = freshPortfolioDb();
  const policy = makeV331Policy();
  // Seed HWM anchor = ¥108,800 via evaluateStrategyRouter so ¥100,000 is -8.088% drawdown -> Stage 1 cap 50%
  const rPeak = evaluateStrategyRouter({
    portfolioDb: db, accountId: 'real-main', asOf: '20261125', policy,
    marketRegime: makeRegime('20261125', 'DEFENSIVE'),
    currentNavCents: 10_880_000, displayNavCents: 10_880_000, fallbackBaselineNavCents: 10_000_000,
  });
  assert.equal(persistRiskAnchor(db, rPeak), true);

  // 71.8% legacy, DEFENSIVE (15%), Stage 1 cap = 50% -> P0 sells 21.8%, glide target sells 36.8%.
  // Combined total sell must be 36.8% = max(21.8%, 36.8%), NOT 21.8% + 36.8% = 58.6%!
  const out = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261126',
    policy,
    holdings: [
      holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 55_000, priceMilli: 1000 }),
      holding({ code: '159241.SZ', name: '航空航天ETF', qty: 1_500, priceMilli: 1000 }),
      holding({ code: '159278.SZ', name: '畜牧养殖ETF', qty: 15_300, priceMilli: 1000 }),
    ],
    cashCents: 2_820_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261126', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261126') },
  });

  assert.equal(out.router.drawdown_control_stage, 'STAGE1_CAP_50');
  const sellLegs = out.actions.flatMap(a => a.legs.filter(l => l.side === 'SELL'));
  const byCode = new Map();
  for (const l of sellLegs) {
    byCode.set(l.ts_code, (byCode.get(l.ts_code) ?? 0) + 1);
  }
  for (const [code, cnt] of byCode.entries()) {
    assert.equal(cnt, 1, `${code} must have exactly 1 merged SELL leg per day`);
  }
  const totalSold = sellLegs.reduce((s, l) => s + l.gross_cents, 0);
  assert.ok(totalSold <= 3_800_000 && totalSold >= 3_500_000, `totalSold=${totalSold} must equal glide ~3.68M, NOT P0+glide 5.86M`);
  db.close();
});

test('L2_LOCKED_WITH_LEGACY: cuts >35% down to 10%, 0 risk buys, bond reservoir buy still allowed', () => {
  const { db } = freshPortfolioDb();
  const policy = makeV331Policy();
  // HWM ¥120,000 -> ¥100,000 is -16.67% drawdown >= 13.5% -> L2_LOCKED (10% equity cap)
  const rPeak = evaluateStrategyRouter({
    portfolioDb: db, accountId: 'real-main', asOf: '20261125', policy,
    marketRegime: makeRegime('20261125', 'OFFENSIVE', 'BALANCED'),
    currentNavCents: 12_000_000, displayNavCents: 12_000_000, fallbackBaselineNavCents: 10_000_000,
  });
  assert.equal(persistRiskAnchor(db, rPeak), true);

  const out = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261126',
    policy,
    holdings: [
      holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 70_000, priceMilli: 1000 }),
    ],
    cashCents: 3_000_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261126', 'OFFENSIVE', 'BALANCED'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261126') },
  });

  assert.equal(out.router.circuit_breaker_status, 'L2_LOCKED');
  assert.ok((out.align_summary?.post_action_risk_equity_bps ?? 9999) <= 1050, 'P0 must cut 70% down to ~10% in 1 day without glide truncation');
  const buys = out.actions.flatMap(a => a.legs.filter(l => l.side === 'BUY'));
  assert.ok(!buys.some(l => l.ts_code !== '159649.SZ'), 'L2_LOCKED forbids risk-equity buys');
  assert.ok(buys.some(l => l.ts_code === '159649.SZ'), 'L2_LOCKED allows BOND_RESERVOIR 159649.SZ buy');
  db.close();
});

test('L2_LOCKED does not allow M2 early release (always honors full l2_lock_trade_days)', () => {
  const days = weekdays('20261102', 20);
  const { db } = freshPortfolioDb();
  const marketDb = openAshareDb(join(dir, 'no-early-rel-market.sqlite'));
  upsertRows(marketDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));

  const basePolicy = makeV331Policy({ l2_lock_trade_days: 10 });
  const rPeak = evaluateStrategyRouter({
    portfolioDb: db, marketDb, accountId: 'real-main', asOf: days[0], policy: basePolicy,
    marketRegime: makeRegime(days[0], 'DEFENSIVE'),
    currentNavCents: 10_000_000, displayNavCents: 10_000_000, fallbackBaselineNavCents: 10_000_000,
  });
  persistRiskAnchor(db, rPeak);
  const rLockStart = evaluateStrategyRouter({
    portfolioDb: db, marketDb, accountId: 'real-main', asOf: days[2], policy: basePolicy,
    marketRegime: makeRegime(days[2], 'DEFENSIVE'),
    currentNavCents: 8_500_000, displayNavCents: 8_500_000,
  });
  assert.equal(rLockStart.circuit_breaker_status, 'L2_LOCKED');
  persistRiskAnchor(db, rLockStart);

  const m2Regime = makeRegime(days[7], 'RECOVERY', 'BALANCED', {
    recovery_state: { enabled: true, active: true, triggered_today: true, stopped_today: false, in_cooldown: false },
  });

  const rStillLocked = evaluateStrategyRouter({
    portfolioDb: db, marketDb, accountId: 'real-main', asOf: days[7],
    policy: basePolicy,
    marketRegime: m2Regime,
    currentNavCents: 8_800_000, displayNavCents: 8_800_000,
  });
  assert.equal(rStillLocked.circuit_breaker_status, 'L2_LOCKED', 'L2_LOCKED must stay locked until locked_until_trade_date even if M2 triggers');
  assert.equal(rStillLocked.targets.target_equity_bps, 1000);
  marketDb.close();
  db.close();
});

test('P1 ETF bugfix: ETF never triggers -8% hardStopHit, CHASSIS_* never enters P1/tracker, SECTOR_PIONEER auto-inits tracker', () => {
  const days = weekdays('20260901', 30);
  const asOf = days[days.length - 1];
  const { db } = freshPortfolioDb();
  const mdb = openAshareDb(join(dir, 'p1-sleeve-market.sqlite'));
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));
  upsertRows(mdb, 'fund_basic', ['ts_code', 'name'], [
    { ts_code: '159549.SZ', name: '红利低波100ETF' },
    { ts_code: '159599.SZ', name: '芯片产业ETF' },
  ]);
  const fd = [];
  const adj = [];
  for (let i = 0; i < days.length; i += 1) {
    // 159549.SZ: dropped from 1.20 -> 0.90 (-25%, below MA20) - in CHASSIS_LOWVOL
    const pChassis = i === days.length - 1 ? 0.90 : 1.20;
    fd.push({ ts_code: '159549.SZ', trade_date: days[i], open: pChassis, high: pChassis, low: pChassis, close: pChassis, pre_close: pChassis, pct_chg: 0, vol: 1e6, amount: 1e6 });
    // 159599.SZ: rallied +20% (arming +15% trail) then dipped below MA20 on last bar -> SECTOR_PIONEER
    const pSector = i < days.length - 1 ? 1.20 : 1.12;
    fd.push({ ts_code: '159599.SZ', trade_date: days[i], open: pSector, high: pSector, low: pSector, close: pSector, pre_close: pSector, pct_chg: 0, vol: 1e6, amount: 1e6 });
    adj.push({ ts_code: '159549.SZ', trade_date: days[i], adj_factor: 1 });
    adj.push({ ts_code: '159599.SZ', trade_date: days[i], adj_factor: 1 });
  }
  upsertRows(mdb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], fd);
  upsertRows(mdb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], adj);

  const policy = makeV331Policy({ sector_pioneer_enabled: true });
  const out = runActionEngine({
    portfolioDb: db,
    marketDb: mdb,
    accountId: 'real-main',
    asOf,
    policy,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 10_000, priceMilli: 900, costMilli: 1200, asOf }),
      holding({ code: '159599.SZ', name: '芯片产业ETF', qty: 5_000, priceMilli: 1120, costMilli: 950, asOf }),
    ],
    cashCents: 8_000_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime(asOf, 'OFFENSIVE', 'BALANCED'),
    stockSwingScreen: { candidates: [] },
    sectorPioneerScreen: {
      candidates: [{ ts_code: '159599.SZ', name: '芯片产业ETF', as_of_trade_date: asOf, close_milli: 1120, close_cny: 1.12, ma60_cny: 1.0, ret20_pct: 5, ret60_pct: 10, blend_score_pct: 7.5 }],
    },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates(asOf) },
  });

  // 159549.SZ (CHASSIS_LOWVOL) must NEVER trigger P1 -8% hard stop or MA20 trail, nor create a stop_tracker update
  assert.ok(!out.actions.some(a => a.priority === 'P1' && a.legs.some(l => l.ts_code === '159549.SZ')), 'CHASSIS_LOWVOL must never trigger P1');
  assert.ok(!out.stop_tracker_updates.some(u => u.ts_code === '159549.SZ'), 'CHASSIS_LOWVOL must never create tracker row');
  // 159599.SZ (SECTOR_PIONEER) with entry cost 0.950 -> armed at 1.12 (> +15%) and below MA20 -> auto-inits tracker & triggers P1 MA20 exit (not hard stop)
  const p1Sector = out.actions.find(a => a.priority === 'P1' && a.legs.some(l => l.ts_code === '159599.SZ'));
  assert.ok(p1Sector, 'SECTOR_PIONEER below MA20 after +15% arming must trigger P1');
  assert.equal(p1Sector.legs[0].reason, 'P1_TRAILING_MA20_STOP', 'ETF P1 must be MA20 trail, never -8% HARD-STOP');
  mdb.close();
  db.close();
});

test('T1_SELLABLE_LT_QTY + PARTIAL_FILL_DAY2 + idempotency + QUOTE_NOT_READY early exit + CLI --cancel', () => {
  const { path: pdbPath, db } = freshPortfolioDb();
  const policy = makeV331Policy();
  const reg = makeRegime('20261126', 'DEFENSIVE');
  const cands = makeStandardCandidates('20261126');

  // 1) T1_SELLABLE_LT_QTY: 20,000 held, only 1,200 sellable -> SELL <= 1,200 & never BUY same code
  const outT1 = runActionEngine({
    portfolioDb: db, accountId: 'real-main', asOf: '20261126', policy,
    holdings: [holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 20_000, sellable: 1_200, priceMilli: 1000 })],
    cashCents: 8_000_000, totalAssetsCents: 10_000_000, marketRegime: reg,
    stockSwingScreen: { candidates: [] }, candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  const sell159558 = outT1.actions.flatMap(a => a.legs).filter(l => l.side === 'SELL' && l.ts_code === '159558.SZ');
  assert.equal(sell159558.length, 1);
  assert.ok(sell159558[0].quantity <= 1200);
  assert.ok(!outT1.actions.flatMap(a => a.legs).some(l => l.side === 'BUY' && l.ts_code === '159558.SZ'));

  // 2) QUOTE_NOT_READY -> fail-closed 0 actions
  const outStale = runActionEngine({
    portfolioDb: db, accountId: 'real-main', asOf: '20261126', policy,
    holdings: [{ ...holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 20_000, priceMilli: 1000 }), bar_quality: 'NOT_READY' }],
    cashCents: 8_000_000, totalAssetsCents: 10_000_000, marketRegime: reg,
    stockSwingScreen: { candidates: [] }, candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.equal(outStale.actions.length, 0);
  assert.ok(outStale.blockers.some(b => b.includes('159558.SZ')));

  // 3) Idempotency: calling runActionEngine twice with same inputs gives byte-identical actions
  const outIdem1 = runActionEngine({
    portfolioDb: db, accountId: 'real-main', asOf: '20261126', policy,
    holdings: [holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 40_000, priceMilli: 1000 })],
    cashCents: 6_000_000, totalAssetsCents: 10_000_000, marketRegime: reg,
    stockSwingScreen: { candidates: [] }, candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  const outIdem2 = runActionEngine({
    portfolioDb: db, accountId: 'real-main', asOf: '20261126', policy,
    holdings: [holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 40_000, priceMilli: 1000 })],
    cashCents: 6_000_000, totalAssetsCents: 10_000_000, marketRegime: reg,
    stockSwingScreen: { candidates: [] }, candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: cands },
  });
  assert.deepEqual(outIdem1.actions, outIdem2.actions);
  assert.deepEqual(outIdem1.align_summary, outIdem2.align_summary);

  // 4) cancelDeconcentrationPlan & CLI --cancel preserve rows and transition ACTIVE -> CANCELLED
  importSnapshot(db, {
    snapshot_id: 'snap-cli-cancel',
    as_of: '20261120',
    source: 'test',
    note: 'cli cancel fixture',
    warnings: [],
    is_current: false,
    positions: [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 60_000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 6_000_000 }],
    totals: { total_assets_cents: 10_000_000, securities_mv_cents: 6_000_000, cash_cents: 4_000_000, wealth_cents: 0, unrealized_pnl_cents: 0 },
  });
  markSnapshotCurrent(db, 'snap-cli-cancel', { confirmedBy: 'test' });
  initBaseline(db, 'real-main', { asOf: '20261120', snapshotId: 'snap-cli-cancel' });
  const ensured = ensureDeconcentrationPlan(db, {
    account_id: 'real-main', ts_code: '159558.SZ', created_at: '20261120', initial_shares: 60_000,
    nav_cents: 10_000_000, target_keep_bps: 2500, anchor_price_milli: 1000,
  });
  assert.equal(ensured.plan.status, 'ACTIVE');
  db.close();

  const cliOut = JSON.parse(execFileSync('node', [
    'build/ashare/cli.js',
    'portfolio-deconcentration-calibrate',
    '--db', pdbPath,
    '--account', 'real-main',
    '--ts-code', '159558.SZ',
    '--cancel',
    '--confirm',
    '--reason', 'V3_3_1_UNCONDITIONAL_ALIGN',
  ], { cwd: '/home/jcshi/workspace/FinanceMCP', encoding: 'utf8' }));
  assert.equal(cliOut.cancelled, true);
  assert.equal(cliOut.updated_count, 1);

  const dbCheck = openPortfolioDb(pdbPath);
  const rows = dbCheck.prepare('SELECT status FROM deconcentration_plan WHERE account_id = ?').all('real-main');
  assert.equal(rows.length, 1, 'history row must NEVER be deleted');
  assert.equal(rows[0].status, 'CANCELLED');
  const cancelAuditRow = dbCheck.prepare('SELECT value FROM account_meta WHERE key = ?')
    .get('v3_deconc_cancelled:real-main:159558.SZ');
  assert.ok(cancelAuditRow?.value, 'I-3: cancelDeconcentrationPlan must persist audit metadata to account_meta');
  const cancelAudit = JSON.parse(cancelAuditRow.value);
  assert.equal(cancelAudit.reason, 'V3_3_1_UNCONDITIONAL_ALIGN');
  assert.deepEqual(cancelAudit.plan_ids, cliOut.plan_ids);
  const decEval = evaluateDeconcentrationPlan({
    portfolioDb: dbCheck,
    accountId: 'real-main',
    tsCode: '159558.SZ',
    asOf: '20261126',
    currentShares: 60_000,
    sellableShares: 60_000,
    currentCloseMilli: 1000,
    marketRegime: 'DEFENSIVE',
    planEnabled: true,
  });
  assert.equal(decEval.plan_status, 'CANCELLED');
  assert.equal(decEval.recommended_sell_shares, 0);
  const decDisabled = evaluateDeconcentrationPlan({
    portfolioDb: dbCheck,
    accountId: 'real-main',
    tsCode: '159558.SZ',
    asOf: '20261126',
    currentShares: 60_000,
    sellableShares: 60_000,
    currentCloseMilli: 1000,
    marketRegime: 'DEFENSIVE',
    planEnabled: false,
  });
  assert.equal(decDisabled.plan_status, 'CANCELLED');
  assert.equal(decDisabled.recommended_sell_shares, 0);
  dbCheck.close();
});

test('v3.3.1 end-to-end dailyReport & reportRenderer produce clean report without 159558 leakage', t => {
  const savedPath = process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  const savedAllowed = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  t.after(() => {
    if (savedPath === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    else process.env.ASHARE_V3_POLICY_RELEASE_PATH = savedPath;
    if (savedAllowed === undefined) delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
    else process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = savedAllowed;
  });

  const days = weekdays('20260701', 70);
  const asOf = days[days.length - 1];
  const mdb = openAshareDb(join(dir, 'report-v331-market.sqlite'));
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));
  const repDir = join(dir, 'reports', asOf);
  mkdirSync(repDir, { recursive: true });
  writeFileSync(join(repDir, `ASR-${asOf}-V331.json`), JSON.stringify({
    report_id: `ASR-${asOf}-V331`,
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: asOf,
    generated_at: `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T20:00:00+08:00`,
    status: 'READY',
    market: {
      regime: 'bear', regime_label: '偏弱', tone: 'bearish', judgement: ['上涨占比 20.0%'],
      breadth: { stocks: 5000, up: 1000, down: 3900, limit_up: 10, limit_down: 40, amount_yi: 7500, amount_ma20_yi: 9500, pct_above_ma60: 20, pct_above_ma20: 18 },
    },
    sectors: { top: [], bottom: [], all: [] },
  }));
  upsertRows(mdb, 'report', ['report_id', 'trade_date', 'status', 'generated_at', 'path', 'run_mode'], [
    { report_id: `ASR-${asOf}-V331`, trade_date: asOf, status: 'READY', generated_at: '2026-10-07T20:00:00+08:00', path: `reports/${asOf}/ASR-${asOf}-V331.json`, run_mode: 'manual' },
  ]);
  upsertRows(mdb, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    Object.keys(CORE_INDICES).flatMap(code => days.map((d, i) => ({
      ts_code: code, trade_date: d, open: 3500 - i * 3, high: 3510 - i * 3, low: 3490 - i * 3,
      close: 3500 - i * 3, pre_close: 3503 - i * 3, pct_chg: -0.2, vol: 1e7, amount: 1e7,
    }))));
  upsertRows(mdb, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [
    { ts_code: '600000.SH', symbol: '600000', name: '样本银行', industry: '银行', list_date: '20100101', list_status: 'L' },
  ]);
  upsertRows(mdb, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    days.map(d => ({ ts_code: '600000.SH', trade_date: d, open: 10, high: 10.1, low: 9.9, close: 10, pre_close: 10, pct_chg: 0, vol: 1e6, amount: 1e6 })));
  upsertRows(mdb, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'type', 'market', 'status'], [
    { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '中证全指半导体产品与设备指数', type: 'E', market: 'E', status: 'L' },
    { ts_code: '159649.SZ', name: '国开债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '中债国开行债券总指数', type: 'E', market: 'E', status: 'L' },
  ]);
  upsertRows(mdb, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    ['159558.SZ', '159649.SZ'].flatMap(code => days.map(d => ({
      ts_code: code, trade_date: d, open: code === '159649.SZ' ? 10 : 1, high: code === '159649.SZ' ? 10 : 1,
      low: code === '159649.SZ' ? 10 : 1, close: code === '159649.SZ' ? 10 : 1, pre_close: code === '159649.SZ' ? 10 : 1,
      pct_chg: 0, vol: 1e6, amount: 1e6,
    }))));
  upsertRows(mdb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
    ['159558.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, trade_date: d, adj_factor: 1 }))));
  upsertRows(mdb, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
    ['159558.SZ', '159649.SZ'].flatMap(code => days.map(d => ({ ts_code: code, trade_date: d, fd_share: 1e8, fund_type: '股票型', market: 'E' }))));
  upsertRows(mdb, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
    ['159558.SZ', '159649.SZ'].flatMap(code => days.map(d => ({
      ts_code: code, ann_date: d, nav_date: d, unit_nav: code === '159649.SZ' ? 10 : 1, accum_nav: code === '159649.SZ' ? 10 : 1, adj_nav: code === '159649.SZ' ? 10 : 1,
    }))));

  const signed = makeSignedV331ReleaseJson();
  const relPath = join(dir, 'v331-report-release.json');
  writeFileSync(relPath, JSON.stringify(signed.payload));
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = relPath;
  process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = signed.hash;

  const { db: rdb } = freshPortfolioDb();
  importSnapshot(rdb, {
    snapshot_id: 'snap-v331',
    as_of: asOf,
    source: 'test',
    note: 'v3.3.1 daily report',
    warnings: [],
    is_current: false,
    positions: [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 50_000, ref_price_milli: 1000, ref_cost_milli: 1100, market_value_cents: 5_000_000 }],
    totals: {
      total_assets_cents: 10_000_000,
      securities_mv_cents: 5_000_000,
      cash_cents: 5_000_000,
      wealth_cents: 0,
      unrealized_pnl_cents: 0,
    },
  });
  initBaseline(rdb, 'real-main', { asOf, snapshotId: 'snap-v331' });
  markSnapshotCurrent(rdb, 'snap-v331', { confirmedBy: 'test' });
  confirmRealAccount(rdb, 'real-main', { confirm: true, note: 'test' });
  setAccountCompleteness(rdb, 'real-main', { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });

  const report = buildDailyReport({ portfolioDb: rdb, marketDb: mdb, accountId: 'real-main', snapshotId: 'snap-v331', asOfTradeDate: asOf });
  assert.equal(report.v3_cockpit?.policy_release.version, 'v3.3.1');
  assert.equal(report.v3_cockpit?.deconcentration.plan_status, 'CANCELLED');
  assert.equal(
    report.v3_cockpit?.align_summary?.enabled,
    true,
    `align_summary missing; status=${report.status} blockers=${JSON.stringify(report.first_section.blockers)} dq=${JSON.stringify(report.data_quality?.tiers)}`,
  );
  const rendered = renderDailyReport(report, { now: '2026-10-07T20:30:00+08:00' });
  assertUserReportClean(rendered.user);
  assert.ok(!rendered.user.includes('四批换马状态机'));
  assert.ok(rendered.user.includes('组合仓位与双向对齐进度'));
  rdb.close();
  mdb.close();
});

test('HOLD_STICKY_BUY_BLOCKED in actionEngine + PARTIAL_FILL_DAY2 + OFFENSIVE zero-churn drift band', () => {
  const { db } = freshPortfolioDb();
  const policy = makeV331Policy({ sector_pioneer_enabled: false });

  // 1) HOLD_STICKY_BUY_BLOCKED: holding 159330.SZ below target with buy_blocked=true must keep held, 0 buy on 159330, 0 rotation into 530050
  const outBlocked = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261126',
    policy,
    holdings: [holding({ code: '159330.SZ', name: '沪深300ETF东财', qty: 3_000, priceMilli: 4000 })],
    cashCents: 8_800_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261126', 'OFFENSIVE', 'VALUE_LEADING'),
    stockSwingScreen: { candidates: [] },
    candidates: {
      schema: 'ashare-etf-candidate-screen/1.0',
      candidates: makeStandardCandidates('20261126', { '159330.SZ': { data: { buy_blocked: true } } }),
    },
  });
  const legsBlocked = outBlocked.actions.flatMap(a => a.legs);
  assert.ok(!legsBlocked.some(l => l.ts_code === '159330.SZ'), 'buy_blocked held 159330 must neither buy more nor sell/rotate');
  assert.ok(!legsBlocked.some(l => l.ts_code === '530050.SH'), 'must NOT add fallback 530050 while 159330 is hold-sticky');

  // 2) PARTIAL_FILL_DAY2: suppose Day-1 only half-filled (~18.4% sold, leaving 53.4% legacy + 46.6% cash under DEFENSIVE 15%)
  const outPartialDay2 = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261127',
    policy,
    holdings: [holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 53_400, priceMilli: 1000, asOf: '20261127' })],
    cashCents: 4_660_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261127', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
  });
  // Excess = 53.4% > 35% + 2% -> targetGlideSell = max(35%, 53.4% - 35%) = 35%, leaving <= 18.4% (< 35% carryover)!
  assert.equal(outPartialDay2.align_summary?.target_glide_sell_cents, 3_500_000);
  const soldDay2 = outPartialDay2.actions.flatMap(a => a.legs).filter(l => l.side === 'SELL').reduce((s, l) => s + l.gross_cents, 0);
  assert.ok(soldDay2 >= 3_400_000 && soldDay2 <= 3_550_000, `Day-2 partial fill must sell ~35% (got ${soldDay2})`);

  // 3) DEFENSIVE aligned within 5% drift band -> 0 equity churn
  const outAligned = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261127',
    policy,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 8_000, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 7_000, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159649.SZ', name: '国开债ETF', qty: 8_300, priceMilli: 10_000, asOf: '20261127' }),
    ],
    cashCents: 200_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261127', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
  });
  assert.equal(outAligned.align_summary?.align_due, false);
  assert.equal(outAligned.actions.length, 0, 'aligned portfolio within 500bps band & 10% bond band emits 0 churn');

  // 4) P-1 + P-2 + P-4 conformance:
  // - P-4: 159241.SZ non-target at ¥4,000 (4%) when proportional glide cuts 55%, remaining ~1.8% (<2%) must wipe to 0 (sell full 4,000)
  // - P-1: 159549.SZ in-target overweight at 9.5% vs 7.5% (+2% < 5%) must be counted in pre_sell_excess_cents
  // - P-2: 159207.SZ already held at 5.5% vs 7.5% (-2% < 5%) skips top-up when !regimeOrStyleChanged, but buys when regimeOrStyleChanged=true
  const outNoChange = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261127',
    policy,
    regimeOrStyleChanged: false,
    holdings: [
      holding({ code: '159558.SZ', name: '半导体设备ETF', qty: 36_000, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159241.SZ', name: '航空航天ETF', qty: 4_000, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 9_500, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 5_500, priceMilli: 1000, asOf: '20261127' }),
    ],
    cashCents: 4_500_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261127', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
  });
  // P-1: pre_sell_excess = 3.6M (159558) + 0.4M (159241) + 0.2M (159549) = 4.2M
  assert.equal(outNoChange.align_summary?.pre_sell_excess_cents, 4_200_000, 'P-1 must count sub-5% in-target overweight');
  const sell241 = outNoChange.actions.flatMap(a => a.legs).find(l => l.side === 'SELL' && l.ts_code === '159241.SZ');
  assert.equal(sell241?.quantity, 4_000, 'P-4 must wipe non-target post-proportional <2% tail to 0');
  const buy207NoChg = outNoChange.actions.flatMap(a => a.legs).find(l => l.side === 'BUY' && l.ts_code === '159207.SZ');
  assert.equal(buy207NoChg, undefined, 'P-2 skips <5% top-up on already-held code when regime/style unchanged & no P0/unlock');

  // Verify P-2 allows <5% top-up when regimeOrStyleChanged=true (and legacy is small so risk headroom exists)
  const outRegChg = runActionEngine({
    portfolioDb: db,
    accountId: 'real-main',
    asOf: '20261127',
    policy,
    regimeOrStyleChanged: true,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 7_500, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 5_500, priceMilli: 1000, asOf: '20261127' }),
      holding({ code: '159649.SZ', name: '国开债ETF', qty: 8_300, priceMilli: 10_000, asOf: '20261127' }),
    ],
    cashCents: 400_000,
    totalAssetsCents: 10_000_000,
    marketRegime: makeRegime('20261127', 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates('20261127') },
  });
  assert.ok(outRegChg.actions.flatMap(a => a.legs).some(l => l.side === 'BUY' && l.ts_code === '159207.SZ'), 'P-2 allows <5% top-up on regimeOrStyleChanged');

  // 5) I-1 & I-2 same-day writable rerun idempotency (style switch day & L2 unlock day):
  // First run syncs state; second run on the same trade date must emit identical actions (style change & just_unlocked stay true)
  const { db: idemDb } = freshPortfolioDb();
  const days = weekdays('20261102', 20);
  const mdb = openAshareDb(join(dir, 'idem-reruns-market.sqlite'));
  upsertRows(mdb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((d, i) => ({
    cal_date: d, is_open: 1, pretrade_date: days[i - 1] ?? null,
  })));
  const candsD0 = makeStandardCandidates(days[0]);
  // Day 0: GROWTH_LEADING under DEFENSIVE/OFFENSIVE -> record T-1 state
  const outD0 = runActionEngine({
    portfolioDb: idemDb, marketDb: mdb, accountId: 'real-main', asOf: days[0], policy,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 7_500, priceMilli: 1000, asOf: days[0] }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 5_500, priceMilli: 1000, asOf: days[0] }),
      holding({ code: '159649.SZ', name: '国开债ETF', qty: 8_300, priceMilli: 10_000, asOf: days[0] }),
    ],
    cashCents: 400_000, totalAssetsCents: 10_000_000,
    marketRegime: makeRegime(days[0], 'DEFENSIVE', 'GROWTH_LEADING'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: candsD0 },
  });
  syncAccountV3State(idemDb, outD0);

  // Day 1: style shifts GROWTH_LEADING -> VALUE_LEADING (<5% top-up on 159207 allowed because style changed vs Day 0)
  const runStyleDay1 = () => runActionEngine({
    portfolioDb: idemDb, marketDb: mdb, accountId: 'real-main', asOf: days[1], policy,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 7_500, priceMilli: 1000, asOf: days[1] }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 5_500, priceMilli: 1000, asOf: days[1] }),
      holding({ code: '159649.SZ', name: '国开债ETF', qty: 8_300, priceMilli: 10_000, asOf: days[1] }),
    ],
    cashCents: 400_000, totalAssetsCents: 10_000_000,
    marketRegime: makeRegime(days[1], 'DEFENSIVE', 'VALUE_LEADING'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates(days[1]) },
  });
  const styleFirst = runStyleDay1();
  syncAccountV3State(idemDb, styleFirst);
  const styleSecond = runStyleDay1();
  assert.ok(styleFirst.actions.flatMap(a => a.legs).some(l => l.ts_code === '159207.SZ'), 'style shift allows <5% top-up on 1st run');
  assert.deepEqual(styleSecond.actions, styleFirst.actions, 'I-1: same-day writable rerun must produce identical actions');

  // I-2: L2 lock on days[2] -> expires after 2d -> unlock day days[5] -> rerun on days[5] keeps just_unlocked=true & identical actions
  const { db: lockDb } = freshPortfolioDb();
  const shortLockPolicy = makeV331Policy({ l2_lock_trade_days: 2, sector_pioneer_enabled: false });
  const rLockPeak = evaluateStrategyRouter({
    portfolioDb: lockDb, marketDb: mdb, accountId: 'real-main', asOf: days[0], policy: shortLockPolicy,
    marketRegime: makeRegime(days[0], 'DEFENSIVE'),
    currentNavCents: 10_000_000, displayNavCents: 10_000_000, fallbackBaselineNavCents: 10_000_000,
  });
  persistRiskAnchor(lockDb, rLockPeak);
  const rLockTrig = evaluateStrategyRouter({
    portfolioDb: lockDb, marketDb: mdb, accountId: 'real-main', asOf: days[2], policy: shortLockPolicy,
    marketRegime: makeRegime(days[2], 'DEFENSIVE'),
    currentNavCents: 8_500_000, displayNavCents: 8_500_000,
  });
  assert.equal(rLockTrig.circuit_breaker_status, 'L2_LOCKED');
  persistRiskAnchor(lockDb, rLockTrig);

  // Lock expires at days[4], so days[5] is first day with locked_until < asOf -> unlock day!
  const runUnlockDay = () => runActionEngine({
    portfolioDb: lockDb, marketDb: mdb, accountId: 'real-main', asOf: days[5], policy: shortLockPolicy,
    holdings: [
      holding({ code: '159549.SZ', name: '红利低波100ETF', qty: 7_500, priceMilli: 1000, asOf: days[5] }),
      holding({ code: '159207.SZ', name: '智选高股息ETF', qty: 5_500, priceMilli: 1000, asOf: days[5] }),
      holding({ code: '159649.SZ', name: '国开债ETF', qty: 7_200, priceMilli: 10_000, asOf: days[5] }),
    ],
    cashCents: 200_000, totalAssetsCents: 8_700_000,
    marketRegime: makeRegime(days[5], 'DEFENSIVE'),
    stockSwingScreen: { candidates: [] },
    candidates: { schema: 'ashare-etf-candidate-screen/1.0', candidates: makeStandardCandidates(days[5]) },
  });
  const unlockFirst = runUnlockDay();
  assert.equal(unlockFirst.router.just_unlocked, true);
  syncAccountV3State(lockDb, unlockFirst);
  const unlockSecond = runUnlockDay();
  assert.equal(unlockSecond.router.just_unlocked, true, 'I-2: same-day rerun on unlock day preserves just_unlocked=true');
  assert.deepEqual(unlockSecond.actions, unlockFirst.actions, 'I-2: same-day writable rerun on unlock day produces identical actions');

  mdb.close();
  idemDb.close();
  lockDb.close();
  db.close();
});

