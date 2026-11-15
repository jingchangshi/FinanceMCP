import { existsSync, readFileSync } from 'node:fs';
import { validateStrategyRelease, type StrategyRelease } from '../ashare/strategyRelease.js';

export const V3_POLICY_EXPECTED_HASH = 'eeacd72de68d463a045a1be1159bede7b3dbae13da92f9b05e68983995e4e008';

/**
 * Signed V3 Offensive Policy Release v3.1.0 (Phase 2 TactiCore validated & approved for account).
 * Byte-identical contract to AShareInvestor/docs/v3-offensive-system/fee-profiles/v3_offensive_policy_release_v3.1.0.json.
 */
export const V3_OFFENSIVE_POLICY_RELEASE_V3_1_0: StrategyRelease = {
  schema_version: 'strategy-release-1',
  research_status: 'RESEARCH_PUBLISHED',
  production_admission: 'APPROVED_FOR_ACCOUNT',
  strategy: {
    id: 'V3_OFFENSIVE_LOW_FREQ_SYSTEM',
    version: '3.1.0',
    implementation_sha256: '4ceab1b42815c7863d1f7cdbfa3948b95d61ad772a7ab90da5fc51060db79629',
  },
  applicability: {
    market: 'CN_ASHARE_MAINBOARD_AND_EXCHANGE_ETF',
    environment: 'EASTMONEY_100K_LOW_FREQ_ACCOUNT',
  },
  execution_assumptions: {
    signal_timing: 'End-of-day PIT close indicators after market close (T)',
    earliest_execution: 'Next trading session T+1 (open_auction for stocks; T+1 ETF rebalance)',
    exit: 'Dual-anchor regime shift, stock -8% hard stop / +15% breakeven / MA20 trailing, and 4-tranche + preemptive -12%->0% L2 breaker for sector ETFs',
    fees: 'Super ETF 0.5bp commission (min 0 CNY); normal ETF 2.5bp (min 5 CNY); stocks 2.5bp (min 5 CNY) + 5bp sell stamp tax + 0.1bp transfer; 5bp slip',
    lot_size: '100 shares integer board lots; minimum >=8,000 CNY per stock pioneer trade',
  },
  inputs: {
    source: 'FinanceMCP research-export PIT snapshot v3_snapshot_20261113 + RQAlpha bundle_202609',
    snapshot: 'ca43f6393393056d6b318bba792c3f6c70c7c5d786f72a7ec6beab366d5b5a78',
    start_date: '2018-01-02',
    end_date: '2026-11-13',
    assets: [
      '158049.SZ',
      '159045.SZ',
      '159052.SZ',
      '159107.SZ',
      '159153.SZ',
      '159160.SZ',
      '159161.SZ',
      '159205.SZ',
      '159207.SZ',
      '159241.SZ',
      '159278.SZ',
      '159290.SZ',
      '159321.SZ',
      '159330.SZ',
      '159337.SZ',
      '159380.SZ',
      '159549.SZ',
      '159550.SZ',
      '159558.SZ',
      '159599.SZ',
      '159622.SZ',
      '159637.SZ',
      '159692.SZ',
      '159994.SZ',
      '510140.SH',
      '510170.SH',
      '511010.SH',
      '515040.SH',
      '516150.SH',
      '530050.SH',
      '560480.SH',
      '588750.SH',
      '589060.SH',
      '589330.SH',
      '589850.SH',
      'CN_MAINBOARD_QUALITY_SWING_TOP2',
    ],
  },
  rules: [
    'Dual-anchor market regime (CSI300 + CSI500/ChiNext + breadth >=45% + vol >=0.85x) routes OFFENSIVE 85% / STRUCTURAL 60% / DEFENSIVE 15%.',
    'Idle defensive weight deploys into 511010.SH treasury bond ETF reservoir rather than 0% cash (EXP-V3-01 Full MaxDD -13.79% vs -17.32% cash-only).',
    'Super ETF universe uses Eastmoney 33-ETF 0.5bp no-min-5 whitelist and blocks cross-border ETFs above +2.5% IOPV premium or >3-day stale NAV.',
    'Mainboard quality momentum swing enables BP1_PULLBACK ONLY (+2.329% OOS 100k / +0.592% OOS 70k) and DROPS BP2_BREAKOUT (-0.187% OOS 100k / -0.001% OOS 70k).',
    'Every stock pioneer trade requires QualityCore (ROE>5%, EPS>0, OCF/Profit>50% with PIT ann_date<=T), -8% hard stop, +15% breakeven arming, and MA20 trailing exit.',
    'Concentrated sector ETF deconcentration uses 4 tranches (Rule A >=12d monthly / Rule B +8% rebound / Rule C DEFENSIVE 2d<MA60*0.985) paired with preemptive -12%->0% 15-day L2 breaker under T+1 execution.',
  ],
  parameters: {
    offensive_equity_bps: '8500',
    structural_equity_bps: '6000',
    defensive_equity_bps: '1500',
    defensive_bond_reservoir_etf: '511010.SH',
    super_etf_commission_rate: '0.00005',
    super_etf_min_commission_cents: '0',
    cross_border_max_premium_bps: '250',
    bp1_pullback_status: 'ENABLED',
    bp1_oos_100k_net_expectancy_pct: '+2.329',
    bp1_oos_70k_net_expectancy_pct: '+0.592',
    bp2_breakout_status: 'DROPPED_NEGATIVE_OOS',
    bp2_oos_100k_net_expectancy_pct: '-0.187',
    bp2_oos_70k_net_expectancy_pct: '-0.001',
    stock_hard_stop_max_loss_bps: '800',
    stock_breakeven_arm_gain_bps: '1500',
    stock_max_positions: '2',
    stock_max_single_weight_bps: '1800',
    stock_risk_budget_per_trade_bps: '130',
    deconcentration_tranches: '4',
    deconcentration_keep_weight_bps: '1800',
    deconcentration_rebound_trigger_bps: '800',
    deconcentration_monthly_min_gap_days: '12',
    l1_warn_drawdown_bps: '1000',
    l2_hard_lifeline_drawdown_bps: '1500',
    l2_preemptive_trigger_drawdown_bps: '1200',
    l2_deconcentration_post_breaker_equity_bps: '0',
    l2_lock_trade_days: '15',
  },
  evidence: [
    {
      reference: '/home/jcshi/.local/share/finance-mcp-ashare/exports/v3_snapshot_20261113/manifest.json',
      sha256: '6de3f8556d21d5f92e9ff74e100024a3b6fd4f0459f74735a6bc08fe8704d88d',
    },
    {
      reference: '/home/jcshi/workspace/AShareInvestor/docs/v3-offensive-system/fee-profiles/super_etf_whitelist_20261115.json',
      sha256: 'd0c30ecc2c4f18de21827b02bff1db78cc29b853fe40481a17ad8d9facbb07c0',
    },
    {
      reference: 'research/results/EXP_V3_01_REGIME_SUPER_ETF.json',
      sha256: 'edd66100d80783becebcae27c70361852141608ca4c85b40839413c79dbbdb7e',
    },
    {
      reference: 'research/results/EXP_V3_01_REGIME_SUPER_ETF.md',
      sha256: 'cb8257d154678e4c558db1a0ca6e48cb9df20cdddbb1f2f58b57d5db7e73c14c',
    },
    {
      reference: 'research/results/EXP_V3_02_MAINBOARD_STOCK_SWING.json',
      sha256: '41e435226e92e2f399fd5b0e4dddea5a6632a9dd21577461faa229a62f2243e3',
    },
    {
      reference: 'research/results/EXP_V3_02_MAINBOARD_STOCK_SWING.md',
      sha256: 'e0f12a4ab9df7f5ee423a48470435e90db91be44c31eb81f714e2709290271f1',
    },
    {
      reference: 'research/results/EXP_V3_03_DECONCENTRATION_PATHS.json',
      sha256: 'adf652843c2d4a0699193ab748ef5fd92199345f81619c1d61bd18304e3c9fbc',
    },
    {
      reference: 'research/results/EXP_V3_03_DECONCENTRATION_PATHS.md',
      sha256: '53c274a2c6bef219ad44b67de758f41d2b3a04962622129bfaba7c532ad3138b',
    },
  ],
  content_hash: V3_POLICY_EXPECTED_HASH,
};

export interface ApprovedV3Policy {
  release: StrategyRelease;
  approved: boolean;
  strategy_id: string;
  version: string;
  content_hash: string;
  bp1_pullback_enabled: boolean;
  bp2_breakout_enabled: boolean;
  bp2_breakout_status: string;
  stock_max_positions: number;
  stock_max_single_weight_bps: number;
  stock_risk_budget_bps: number;
  stock_min_order_cny: number;
  stock_price_cap_cny: number;
  l1_warn_drawdown_bps: number;
  l2_normal_trigger_drawdown_bps: number;
  l2_normal_post_breaker_equity_bps: number;
  l2_preemptive_deconcentration_trigger_drawdown_bps: number;
  l2_deconcentration_post_breaker_equity_bps: number;
  l2_lock_trade_days: number;
  defensive_bond_reservoir_etf: string;
}

function intParam(params: Record<string, string>, key: string, fallback: number): number {
  const n = Number(params[key]);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * Load and verify the approved V3 offensive policy release (v3.1.0).
 * Supports optional ASHARE_V3_POLICY_RELEASE_PATH runtime override while verifying canonical StrategyRelease hash.
 */
export function loadApprovedV3Policy(): ApprovedV3Policy {
  let release: StrategyRelease = V3_OFFENSIVE_POLICY_RELEASE_V3_1_0;
  const overridePath = process.env.ASHARE_V3_POLICY_RELEASE_PATH?.trim();
  const isCustomOverride = Boolean(overridePath && existsSync(overridePath));
  if (isCustomOverride && overridePath) {
    release = JSON.parse(readFileSync(overridePath, 'utf8')) as StrategyRelease;
  }

  const verifiedHash = validateStrategyRelease(release);
  if (!isCustomOverride && verifiedHash !== V3_POLICY_EXPECTED_HASH) {
    throw new Error(`v3_policy_hash_mismatch:${verifiedHash}`);
  }

  const p = release.parameters;
  const approved = release.production_admission === 'APPROVED_FOR_ACCOUNT';
  return {
    release,
    approved,
    strategy_id: release.strategy.id,
    version: release.strategy.version.startsWith('v') ? release.strategy.version : `v${release.strategy.version}`,
    content_hash: verifiedHash,
    bp1_pullback_enabled: p.bp1_pullback_status === 'ENABLED',
    bp2_breakout_enabled: p.bp2_breakout_status === 'ENABLED',
    bp2_breakout_status: p.bp2_breakout_status ?? 'DROPPED_NEGATIVE_OOS',
    stock_max_positions: intParam(p, 'stock_max_positions', 2),
    stock_max_single_weight_bps: intParam(p, 'stock_max_single_weight_bps', 1800),
    stock_risk_budget_bps: intParam(p, 'stock_risk_budget_per_trade_bps', 130),
    stock_min_order_cny: 8000,
    stock_price_cap_cny: 90,
    l1_warn_drawdown_bps: intParam(p, 'l1_warn_drawdown_bps', 1000),
    l2_normal_trigger_drawdown_bps: intParam(p, 'l2_hard_lifeline_drawdown_bps', 1500),
    l2_normal_post_breaker_equity_bps: 1500,
    l2_preemptive_deconcentration_trigger_drawdown_bps: intParam(p, 'l2_preemptive_trigger_drawdown_bps', 1200),
    l2_deconcentration_post_breaker_equity_bps: intParam(p, 'l2_deconcentration_post_breaker_equity_bps', 0),
    l2_lock_trade_days: intParam(p, 'l2_lock_trade_days', 15),
    defensive_bond_reservoir_etf: p.defensive_bond_reservoir_etf || '511010.SH',
  };
}
