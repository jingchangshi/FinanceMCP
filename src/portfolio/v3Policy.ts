import { existsSync, readFileSync } from 'node:fs';
import { StrategyAdmissionStore, type AdmissionAction } from '../ashare/strategyAdmission.js';
import { validateStrategyRelease, type StrategyRelease } from '../ashare/strategyRelease.js';

export const V3_POLICY_V3_1_0_HASH = 'eeacd72de68d463a045a1be1159bede7b3dbae13da92f9b05e68983995e4e008';
export const V3_POLICY_EXPECTED_HASH = '05346a961e01f746055143e0bb5790caa9d6460aa579bb26c085cca20d77b55f';

/** 已批准的 V3 进攻型低频系统策略 ID（运行时覆盖文件必须与之一致）。 */
export const V3_OFFENSIVE_STRATEGY_ID = 'V3_OFFENSIVE_LOW_FREQ_SYSTEM';

/**
 * Signed V3 Offensive Policy Release v3.1.0 (archived baseline contract, retained for audit compatibility).
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
  content_hash: V3_POLICY_V3_1_0_HASH,
};

/**
 * Signed V3 Offensive Policy Release v3.2.0 (Phase 2 EXP-V3-01..04 validated & approved for account).
 * Byte-identical contract to AShareInvestor/docs/v3-offensive-system/fee-profiles/v3_offensive_policy_release_v3.2.0.json.
 */
export const V3_OFFENSIVE_POLICY_RELEASE_V3_2_0: StrategyRelease = {
  schema_version: 'strategy-release-1',
  research_status: 'RESEARCH_PUBLISHED',
  production_admission: 'APPROVED_FOR_ACCOUNT',
  strategy: {
    id: 'V3_OFFENSIVE_LOW_FREQ_SYSTEM',
    version: '3.2.0',
    implementation_sha256: '4ceab1b42815c7863d1f7cdbfa3948b95d61ad772a7ab90da5fc51060db79629',
  },
  applicability: {
    market: 'CN_ASHARE_MAINBOARD_AND_EXCHANGE_ETF',
    environment: 'EASTMONEY_100K_LOW_FREQ_ACCOUNT',
  },
  execution_assumptions: {
    signal_timing: 'End-of-day PIT close indicators after market close (T)',
    earliest_execution: 'Next trading session T+1 (open_auction for stocks; T+1 ETF rebalance)',
    exit: 'Dual-anchor regime shift, stock -8% hard stop / +15% breakeven / MA20 trailing, and 25% core bottom-grind mode (+10% guarded tactical slot, 2d floor confirm, >=34% drift harvest, preemptive -12%->0% L2 above 30% weight)',
    fees: 'Super ETF 0.5bp commission (min 0 CNY); normal ETF 2.5bp (min 5 CNY); stocks 2.5bp (min 5 CNY) + 5bp sell stamp tax + 0.1bp transfer; 5bp slip',
    lot_size: '100 shares integer board lots; minimum >=8,000 CNY per stock pioneer trade',
  },
  inputs: {
    ...V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.inputs,
    assets: [...V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.inputs.assets],
  },
  rules: [
    'Dual-anchor market regime (CSI300 + CSI500/ChiNext + breadth >=45% + vol >=0.85x) routes OFFENSIVE 85% / STRUCTURAL 60% / DEFENSIVE 15%.',
    'Idle defensive weight deploys into 511010.SH treasury bond ETF reservoir rather than 0% cash (EXP-V3-01 Full MaxDD -13.79% vs -17.32% cash-only).',
    'Super ETF universe uses Eastmoney 33-ETF 0.5bp no-min-5 whitelist and blocks cross-border ETFs above +2.5% IOPV premium or >3-day stale NAV.',
    'Mainboard quality momentum swing enables BP1_PULLBACK ONLY (+2.329% OOS 100k / +0.592% OOS 70k) and DROPS BP2_BREAKOUT (-0.187% OOS 100k / -0.001% OOS 70k).',
    'Every stock pioneer trade requires QualityCore (ROE>5%, EPS>0, OCF/Profit>50% with PIT ann_date<=T), -8% hard stop, +15% breakeven arming, and MA20 trailing exit.',
    'Concentrated sector ETF uses BOTTOM_GRIND_25 (keep 25% strategic core, drop low-level monthly forced selling, 2-day support floor breakdown confirm, plus +10% guarded reload only when MA60_slope10>=0, >=7% discount, oversold washout, and right-side close>MA5; >=34% drift stall harvest; EXP-V3-04 15/0 RT win rate).',
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
    deconcentration_mode: 'BOTTOM_GRIND_25',
    deconcentration_tranches: '4',
    deconcentration_keep_weight_bps: '2500',
    deconcentration_rebound_trigger_bps: '800',
    deconcentration_monthly_min_gap_days: '12',
    deconcentration_monthly_rule_enabled: 'false',
    deconcentration_support_breakdown_confirm_days: '2',
    grind_tactical_slot_bps: '1000',
    grind_reload_min_discount_bps: '700',
    grind_reload_ma60_slope10_min_bps: '0',
    grind_reload_rsi14_max: '36',
    grind_reload_bias20_max_bps: '-650',
    grind_take_profit_bps: '750',
    grind_drift_harvest_trigger_bps: '3400',
    l1_warn_drawdown_bps: '1000',
    l2_hard_lifeline_drawdown_bps: '1500',
    l2_preemptive_trigger_drawdown_bps: '1200',
    l2_deconcentration_post_breaker_equity_bps: '0',
    l2_lock_trade_days: '15',
  },
  evidence: [
    ...V3_OFFENSIVE_POLICY_RELEASE_V3_1_0.evidence,
    {
      reference: 'research/results/EXP_V3_04_BOTTOM_GRIND_COST_REDUCTION.json',
      sha256: 'd8551f1321b4f8c21a624714a00539a7810ccaef9f694053b0e740e2926a0234',
    },
    {
      reference: 'research/results/EXP_V3_04_BOTTOM_GRIND_COST_REDUCTION.md',
      sha256: '673a7f3cd31c51fbd638b1df2b97533b2ec500ee8f59e121ebb6ae42ffa617ee',
    },
  ],
  content_hash: V3_POLICY_EXPECTED_HASH,
};

export interface RuntimeAdmissionState {
  /** 是否配置了 ASHARE_V3_ADMISSION_DB（未配置时准入开关不生效）。 */
  configured: boolean;
  /** 准入库是否可打开；不存在/不可读/权限不符均为 false，此时不阻断。 */
  store_available: boolean;
  /** 对应策略/版本/账户/市场/环境的最新准入动作；无事件或不可读时为 null。 */
  latest_action: AdmissionAction | null;
  /** 最新动作在评估时点是否仍在有效期内。 */
  latest_in_validity: boolean;
  /** 评估时点（目标交易日收盘，ISO）；未提供实际账户/日期时为 null。 */
  evaluated_as_of: string | null;
}

export interface ApprovedV3Policy {
  release: StrategyRelease;
  approved: boolean;
  strategy_id: string;
  version: string;
  content_hash: string;
  /** 覆盖文件加载诊断；空数组表示无覆盖或覆盖文件有效。 */
  override_diagnostics: string[];
  /** 准入账本允许新开仓时为 true；未配置/不可读/无事件时保持 true（不得成为隐性封锁）。 */
  runtime_can_open: boolean;
  runtime_admission: RuntimeAdmissionState;
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
  defensive_bond_reservoir_fallback_etf: string | null;
  defensive_bond_reservoir_tertiary_etf: string | null;
  defensive_bond_reservoir_drift_band_bps: number;
  deconcentration_mode: 'STANDARD' | 'BOTTOM_GRIND_25';
  deconcentration_keep_weight_bps: number;
  deconcentration_support_breakdown_confirm_days: number;
  grind_tactical_slot_bps: number;
  grind_reload_min_discount_bps: number;
  grind_reload_rsi14_max: number;
  grind_reload_bias20_max_bps: number;
  grind_take_profit_bps: number;
  grind_drift_harvest_trigger_bps: number;
  // ---- v3.3.0 五机制集成字段（未配置时保持 v3.2.0/v3.2.1 等价默认行为）
  recovery_overlay_enabled: boolean;
  recovery_equity_bps: number;
  recovery_icepoint_pct_ma60_max_bps: number;
  recovery_icepoint_pct_ma20_max_bps: number;
  recovery_icepoint_lookback_days: number;
  recovery_thrust_pct_ma20_min_bps: number;
  recovery_thrust_5d_jump_min_bps: number;
  recovery_thrust_floor_pct_ma20_bps: number;
  recovery_min_amount_vs_ma20_bps: number;
  recovery_false_breakout_cooldown_days: number;
  lowvol_core_permanent_share_bps: number;
  drawdown_control_mode: 'HARD_STEP_LOCK' | 'TWO_STAGE_GRADUAL' | 'CPPI_F15_M5';
  drawdown_stage1_bps: number;
  drawdown_stage1_cap_bps: number;
  drawdown_stage2_bps: number;
  drawdown_stage2_cap_bps: number;
  drawdown_lock_trigger_bps: number;
  drawdown_unlock_reanchor_enabled: boolean;
  drawdown_unlock_ramp_trade_days: number;
  sector_pioneer_enabled: boolean;
  sector_pioneer_top_k: number;
  sector_pioneer_max_weight_bps: number;
  stock_bp1_min_investable_nav_cny: number;
  stock_bp1_block_during_deconcentration: boolean;
  // ---- v3.3.1 执行架构 2.0 字段（未配置时保持 v3.1.0–v3.3.0 100% 回归不变）
  deconcentration_plan_enabled: boolean;
  regime_target_enforced_on_existing_holdings: boolean;
  align_glide_carryover_bps: number;
  equity_align_drift_band_bps: number;
  chassis_single_etf_per_style_bucket: boolean;
  p1_etf_trailing_sleeves: string[];
  // ---- v3.4.0 三支柱（CORE_40 + ICE_10 + B1 + REGIME_ONLY + QualityCore v2 + 标量 FVO）
  lowvol_core_mode: 'LEGACY' | 'CORE_40';
  gold_core_etf: string;
  gold_core_share_bps: number;
  gold_core_drift_band_bps: number;
  gold_core_min_trade_cny: number;
  strategic_bond_core_share_bps: number;
  defensive_bond_reservoir_min_trade_cny: number;
  satellite_max_share_bps: number;
  ice10_floor_enabled: boolean;
  ice10_pct_ma60_max_bps: number;
  ice10_window_trade_days: number;
  ice10_equity_bps: number;
  ice10_disable_on_p0_lock: boolean;
  fundamental_envelope_enabled: boolean;
  fundamental_envelope_mode: string;
  fundamental_envelope_lookback_days: number;
  fundamental_hysteresis_bps: number;
  fundamental_underval_erp_enter_bps: number;
  fundamental_underval_erp_exit_bps: number;
  fundamental_underval_bp_enter_bps: number;
  fundamental_underval_bp_exit_bps: number;
  fundamental_bubble_erp_enter_bps: number;
  fundamental_bubble_erp_exit_bps: number;
  fundamental_bubble_bp_enter_bps: number;
  fundamental_bubble_bp_exit_bps: number;
  fundamental_underval_offensive_bps: number;
  fundamental_underval_structural_bps: number;
  fundamental_underval_recovery_bps: number;
  fundamental_underval_ice10_bps: number;
  fundamental_underval_defensive_bps: number;
  fundamental_bubble_offensive_bps: number;
  fundamental_bubble_structural_bps: number;
  fundamental_bubble_recovery_bps: number;
  fundamental_bubble_ice10_bps: number;
  fundamental_bubble_defensive_bps: number;
  align_trigger_mode: 'STANDARD' | 'REGIME_ONLY';
  satellite_align_drift_band_bps: number;
  quality_core_version: 'v1' | 'v2';
  quality_core_roe_dt_ann_min_bps: number;
  quality_core_eps_min: number;
  quality_core_ocf_to_profit_min_bps: number;
  quality_core_bps_min: number;
  quality_core_strict_ann_date: boolean;
  stock_bp1_reverify_nav_cny: number;
  fvo_enabled: boolean;
  fvo_scalar_only: boolean;
  fvo_equity_delta_default_bps: number;
  fvo_max_abs_delta_bps: number;
  fvo_max_ttl_trade_days: number;
  fvo_zero_positive_on_l1_or_bubble: boolean;
  fvo_l1_drawdown_bps: number;
  fvo_60d_attribution_halve_trigger_bps: number;
  fvo_60d_attribution_halved_cap_bps: number;
  policy_freeze_start_date: string | null;
  policy_freeze_end_date: string | null;
}

const VALID_BP_STATUSES = new Set(['ENABLED', 'DISABLED', 'DROPPED_NEGATIVE_OOS']);
const VALID_DECONC_MODES = new Set(['STANDARD', 'BOTTOM_GRIND_25']);
const VALID_DD_MODES = new Set(['HARD_STEP_LOCK', 'TWO_STAGE_GRADUAL', 'CPPI_F15_M5']);
const VALID_P1_ETF_SLEEVES = new Set([
  'ALL',
  'NONE',
  'SECTOR_PIONEER',
  'CHASSIS_LOWVOL',
  'CHASSIS_GOLD',
  'CHASSIS_VALUE',
  'CHASSIS_GROWTH',
  'BOND_RESERVOIR',
  'UNMANAGED_LEGACY',
]);

export function isVersionAtLeast331(version: string): boolean {
  const clean = version.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(clean);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major !== 3) return major > 3;
  if (minor !== 3) return minor > 3;
  return patch >= 1;
}

export function isVersionAtLeast340(version: string): boolean {
  const clean = version.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(clean);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 3) return major > 3;
  return minor >= 4;
}

function parseStrictInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function parseStrictBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function parseSleeveList(raw: string | undefined, fallback: string[]): { sleeves: string[]; valid: boolean } {
  if (raw === undefined) return { sleeves: fallback, valid: false };
  const parts = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (parts.length === 0) return { sleeves: fallback, valid: false };
  for (const tok of parts) {
    if (!VALID_P1_ETF_SLEEVES.has(tok)) return { sleeves: fallback, valid: false };
  }
  if (parts.includes('NONE')) {
    if (parts.length > 1) return { sleeves: fallback, valid: false };
    return { sleeves: [], valid: true };
  }
  if (parts.includes('ALL') && parts.length > 1) {
    return { sleeves: fallback, valid: false };
  }
  return { sleeves: [...new Set(parts)], valid: true };
}

/**
 * v3.3.1+ 严格 Schema 校验：
 * - 全部被读取的关键参数键必须显式存在且类型合法；
 * - 枚举遇未知值直接报错（严禁静默回退）；
 * - 冗余别名键若同时存在必须相等。
 */
export function validateV331Parameters(p: Record<string, string>): string[] {
  const errors: string[] = [];

  const reqInt = (key: string, min?: number, max?: number): number | null => {
    const val = parseStrictInt(p[key]);
    if (val === null) {
      errors.push(`missing_or_invalid_int:${key}`);
      return null;
    }
    if (min !== undefined && val < min) errors.push(`int_below_min:${key}:${val}<${min}`);
    if (max !== undefined && val > max) errors.push(`int_above_max:${key}:${val}>${max}`);
    return val;
  };
  const reqBool = (key: string): boolean | null => {
    const val = parseStrictBool(p[key]);
    if (val === null) {
      errors.push(`missing_or_invalid_bool:${key}`);
      return null;
    }
    return val;
  };
  const reqStr = (key: string): string | null => {
    const val = p[key]?.trim();
    if (!val) {
      errors.push(`missing_or_empty_string:${key}`);
      return null;
    }
    return val;
  };
  const reqEnum = (key: string, allowed: ReadonlySet<string>): string | null => {
    const val = p[key]?.trim();
    if (!val || !allowed.has(val)) {
      errors.push(`invalid_enum:${key}:${val ?? 'MISSING'}`);
      return null;
    }
    return val;
  };
  const checkAliasPair = (keyA: string, keyB: string, requireAtLeastOne: boolean): void => {
    const hasA = p[keyA] !== undefined;
    const hasB = p[keyB] !== undefined;
    if (requireAtLeastOne && !hasA && !hasB) {
      errors.push(`missing_alias_pair:${keyA}_or_${keyB}`);
      return;
    }
    const valA = hasA ? parseStrictInt(p[keyA]) : null;
    const valB = hasB ? parseStrictInt(p[keyB]) : null;
    if (hasA && valA === null) errors.push(`missing_or_invalid_int:${keyA}`);
    if (hasB && valB === null) errors.push(`missing_or_invalid_int:${keyB}`);
    if (hasA && hasB && valA !== null && valB !== null && valA !== valB) {
      errors.push(`alias_mismatch:${keyA}=${valA}!=${keyB}=${valB}`);
    }
  };

  reqEnum('bp1_pullback_status', VALID_BP_STATUSES);
  reqEnum('bp2_breakout_status', VALID_BP_STATUSES);
  const deconcEnabled = reqBool('deconcentration_plan_enabled');
  reqEnum('deconcentration_mode', VALID_DECONC_MODES);
  const ddMode = reqEnum('drawdown_control_mode', VALID_DD_MODES);

  reqInt('stock_max_positions', 1);
  reqInt('stock_max_single_weight_bps', 0, 10000);
  reqInt('stock_risk_budget_per_trade_bps', 1, 10000);

  const l1Warn = reqInt('l1_warn_drawdown_bps', 0, 10000);
  reqInt('l2_preemptive_trigger_drawdown_bps', 0, 10000);
  reqInt('l2_lock_trade_days', 1);

  checkAliasPair('drawdown_lock_trigger_bps', 'l2_normal_trigger_drawdown_bps', true);
  checkAliasPair('drawdown_lock_trigger_bps', 'l2_hard_lifeline_drawdown_bps', false);
  checkAliasPair('l2_normal_post_breaker_equity_bps', 'drawdown_normal_post_lock_cap_bps', true);
  checkAliasPair('l2_deconcentration_post_breaker_equity_bps', 'drawdown_conc_post_lock_cap_bps', deconcEnabled === true);

  reqStr('defensive_bond_reservoir_etf');
  reqInt('defensive_bond_reservoir_drift_band_bps', 0, 10000);

  if (deconcEnabled === true) {
    reqInt('deconcentration_keep_weight_bps', 0, 10000);
    reqInt('deconcentration_support_breakdown_confirm_days', 1);
    reqInt('grind_tactical_slot_bps', 0, 10000);
    reqInt('grind_reload_min_discount_bps', 0, 10000);
    reqInt('grind_reload_rsi14_max', 0, 100);
    reqInt('grind_reload_bias20_max_bps', -10000, 10000);
    reqInt('grind_take_profit_bps', 0, 10000);
    reqInt('grind_drift_harvest_trigger_bps', 0, 10000);
  }

  reqBool('recovery_overlay_enabled');
  reqInt('recovery_equity_bps', 0, 10000);
  reqInt('recovery_icepoint_pct_ma60_max_bps', 0, 10000);
  reqInt('recovery_icepoint_pct_ma20_max_bps', 0, 10000);
  reqInt('recovery_icepoint_lookback_days', 1);
  reqInt('recovery_thrust_pct_ma20_min_bps', 0, 10000);
  reqInt('recovery_thrust_5d_jump_min_bps', 0, 10000);
  reqInt('recovery_thrust_floor_pct_ma20_bps', 0, 10000);
  reqInt('recovery_min_amount_vs_ma20_bps', 0);
  reqInt('recovery_false_breakout_cooldown_days', 0);

  reqInt('lowvol_core_permanent_share_bps', 0, 10000);

  const stage1Bps = reqInt('drawdown_stage1_bps', 0, 10000);
  reqInt('drawdown_stage1_cap_bps', 0, 10000);
  reqInt('drawdown_stage2_bps', 0, 10000);
  reqInt('drawdown_stage2_cap_bps', 0, 10000);
  if (ddMode === 'TWO_STAGE_GRADUAL') {
    reqInt('drawdown_lock_trigger_bps', 0, 10000);
    if (l1Warn !== null && stage1Bps !== null && l1Warn !== stage1Bps) {
      errors.push(`alias_mismatch:l1_warn_drawdown_bps=${l1Warn}!=drawdown_stage1_bps=${stage1Bps}`);
    }
  } else if (p.l1_warn_drawdown_bps !== undefined && p.drawdown_stage1_bps !== undefined && l1Warn !== null && stage1Bps !== null && l1Warn !== stage1Bps) {
    errors.push(`alias_mismatch:l1_warn_drawdown_bps=${l1Warn}!=drawdown_stage1_bps=${stage1Bps}`);
  }
  reqBool('drawdown_unlock_reanchor_enabled');
  reqInt('drawdown_unlock_ramp_trade_days', 0);

  reqBool('sector_pioneer_enabled');
  reqInt('sector_pioneer_top_k', 1);
  reqInt('sector_pioneer_max_weight_bps', 0, 10000);
  reqInt('stock_bp1_min_investable_nav_cny', 0);
  reqBool('stock_bp1_block_during_deconcentration');

  // v3.3.1 执行架构 2.0 显式键
  reqBool('regime_target_enforced_on_existing_holdings');
  reqInt('align_glide_carryover_bps', 0, 10000);
  reqInt('equity_align_drift_band_bps', 0, 10000);
  reqBool('chassis_single_etf_per_style_bucket');
  const parsedSleeves = parseSleeveList(p.p1_etf_trailing_sleeves, ['SECTOR_PIONEER']);
  if (!parsedSleeves.valid) {
    errors.push(`invalid_enum_list:p1_etf_trailing_sleeves:${p.p1_etf_trailing_sleeves ?? 'MISSING'}`);
  }
  if (p.l2_lock_allow_m2_early_release !== undefined) {
    errors.push('unsupported_param:l2_lock_allow_m2_early_release');
  }

  return errors;
}

const B2_FORBIDDEN_KEY_SET = new Set([
  'implied_expectation_tilt',
  'style_tilt',
  'fvo_style_tilt',
  'macro_implied_expectation_enabled',
  'expectation_style_tilt',
  'b2_enabled',
]);

export function findForbiddenB2Keys(params: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const key of Object.keys(params)) {
    const lower = key.trim().toLowerCase();
    if (lower.startsWith('b2_') || lower.includes('implied_expectation_tilt') || lower.includes('style_tilt') || B2_FORBIDDEN_KEY_SET.has(lower)) {
      hits.push(key);
    }
  }
  return hits;
}

export function validateV340Parameters(params: Record<string, string>): string[] {
  const errors = validateV331Parameters(params);
  for (const b2Key of findForbiddenB2Keys(params)) {
    errors.push(`forbidden_b2_param:${b2Key}`);
  }
  const reqInt = (key: string, minVal: number, maxVal = Number.MAX_SAFE_INTEGER): number | null => {
    const parsed = parseStrictInt(params[key]);
    if (parsed === null || parsed < minVal || parsed > maxVal) {
      errors.push(`invalid_int:${key}:${params[key] ?? 'MISSING'}`);
      return null;
    }
    return parsed;
  };
  const reqBool = (key: string): boolean | null => {
    const parsed = parseStrictBool(params[key]);
    if (parsed === null) {
      errors.push(`invalid_bool:${key}:${params[key] ?? 'MISSING'}`);
      return null;
    }
    return parsed;
  };
  const reqEnum = (key: string, allowed: Set<string>): string | null => {
    const raw = params[key]?.trim();
    if (!raw || !allowed.has(raw)) {
      errors.push(`invalid_enum:${key}:${params[key] ?? 'MISSING'}`);
      return null;
    }
    return raw;
  };

  reqEnum('lowvol_core_mode', new Set(['CORE_40', 'LEGACY']));
  if (!params.gold_core_etf?.trim()) errors.push('missing_param:gold_core_etf');
  reqInt('gold_core_share_bps', 0, 5000);
  reqInt('gold_core_drift_band_bps', 0, 5000);
  reqInt('gold_core_min_trade_cny', 0);
  reqInt('strategic_bond_core_share_bps', 0, 5000);
  reqInt('defensive_bond_reservoir_min_trade_cny', 0);
  reqInt('satellite_max_share_bps', 0, 10000);

  reqBool('ice10_floor_enabled');
  reqInt('ice10_pct_ma60_max_bps', 0, 5000);
  reqInt('ice10_window_trade_days', 1, 60);
  reqInt('ice10_equity_bps', 0, 10000);
  reqBool('ice10_disable_on_p0_lock');

  reqBool('fundamental_envelope_enabled');
  if (!params.fundamental_envelope_mode?.trim()) errors.push('missing_param:fundamental_envelope_mode');
  reqInt('fundamental_envelope_lookback_days', 60, 2500);
  reqInt('fundamental_hysteresis_bps', 0, 3000);
  reqInt('fundamental_underval_erp_enter_bps', 0, 10000);
  reqInt('fundamental_underval_erp_exit_bps', 0, 10000);
  reqInt('fundamental_underval_bp_enter_bps', 0, 10000);
  reqInt('fundamental_underval_bp_exit_bps', 0, 10000);
  reqInt('fundamental_bubble_erp_enter_bps', 0, 10000);
  reqInt('fundamental_bubble_erp_exit_bps', 0, 10000);
  reqInt('fundamental_bubble_bp_enter_bps', 0, 10000);
  reqInt('fundamental_bubble_bp_exit_bps', 0, 10000);
  reqInt('fundamental_underval_offensive_bps', 0, 10000);
  reqInt('fundamental_underval_structural_bps', 0, 10000);
  reqInt('fundamental_underval_recovery_bps', 0, 10000);
  reqInt('fundamental_underval_ice10_bps', 0, 10000);
  reqInt('fundamental_underval_defensive_bps', 0, 10000);
  reqInt('fundamental_bubble_offensive_bps', 0, 10000);
  reqInt('fundamental_bubble_structural_bps', 0, 10000);
  reqInt('fundamental_bubble_recovery_bps', 0, 10000);
  reqInt('fundamental_bubble_ice10_bps', 0, 10000);
  reqInt('fundamental_bubble_defensive_bps', 0, 10000);

  reqEnum('align_trigger_mode', new Set(['REGIME_ONLY', 'STANDARD']));
  reqInt('satellite_align_drift_band_bps', 0, 10000);

  reqEnum('quality_core_version', new Set(['v1', 'v2']));
  reqInt('quality_core_roe_dt_ann_min_bps', 0, 10000);
  reqInt('quality_core_eps_min', 0, 10000);
  reqInt('quality_core_ocf_to_profit_min_bps', 0, 20000);
  reqInt('quality_core_bps_min', 0, 10000);
  reqBool('quality_core_strict_ann_date');
  reqInt('stock_bp1_reverify_nav_cny', 0);

  reqBool('fvo_enabled');
  const scalarOnly = reqBool('fvo_scalar_only');
  if (scalarOnly === false) errors.push('invalid_bool:fvo_scalar_only_must_be_true');
  const fvoDefault = reqInt('fvo_equity_delta_default_bps', -1000, 1000);
  if (fvoDefault !== null && fvoDefault !== 0) errors.push(`invalid_int:fvo_equity_delta_default_bps:${fvoDefault}`);
  reqInt('fvo_max_abs_delta_bps', 0, 1000);
  reqInt('fvo_max_ttl_trade_days', 1, 20);
  reqBool('fvo_zero_positive_on_l1_or_bubble');
  reqInt('fvo_l1_drawdown_bps', 0, 5000);
  reqInt('fvo_60d_attribution_halve_trigger_bps', -5000, 0);
  reqInt('fvo_60d_attribution_halved_cap_bps', 0, 1000);

  return errors;
}

function intParam(params: Record<string, string>, key: string, fallback: number): number {
  const n = Number(params[key]);
  return Number.isSafeInteger(n) ? n : fallback;
}

function boolParam(params: Record<string, string>, key: string, fallback: boolean): boolean {
  const v = params[key]?.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

interface OverrideLoadResult {
  release: StrategyRelease | null;
  hash: string | null;
  diagnostics: string[];
  /** 坏覆盖文件（存在但不可用）：只停新增买入，不打断日报。 */
  blocksNewBuys: boolean;
}

/**
 * 尝试读取运行时策略覆盖文件。任何失败都只返回诊断并回退内嵌基线：
 * 日报、止损与减仓不因覆盖文件部署/权限/内容问题被打断。
 */
function tryLoadOverrideRelease(overridePath: string, embedded: StrategyRelease): OverrideLoadResult {
  if (!existsSync(overridePath)) {
    return { release: null, hash: null, diagnostics: [`v3_policy_override_missing:${overridePath}`], blocksNewBuys: false };
  }
  let raw: string;
  try {
    raw = readFileSync(overridePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_unreadable:${overridePath}:${detail}`],
      blocksNewBuys: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { release: null, hash: null, diagnostics: [`v3_policy_override_invalid_json:${overridePath}`], blocksNewBuys: true };
  }
  // 自洽性只是最低门槛：还必须命中受控哈希白名单，绝不接受“仅仅是自洽”的文件。
  let verifiedHash: string;
  try {
    verifiedHash = validateStrategyRelease(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { release: null, hash: null, diagnostics: [`v3_policy_override_invalid_release:${detail}`], blocksNewBuys: true };
  }
  const allowRaw = process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES?.trim();
  const allowlisted = allowRaw
    ? allowRaw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    : [V3_POLICY_EXPECTED_HASH];
  if (!allowlisted.includes(verifiedHash)) {
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_hash_not_allowed:${verifiedHash}`],
      blocksNewBuys: true,
    };
  }

  const release = parsed as StrategyRelease;
  if (release.strategy.id !== V3_OFFENSIVE_STRATEGY_ID || release.strategy.id !== embedded.strategy.id) {
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_strategy_mismatch:${release.strategy.id}`],
      blocksNewBuys: true,
    };
  }
  if (release.applicability.market !== embedded.applicability.market) {
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_market_mismatch:${release.applicability.market}`],
      blocksNewBuys: true,
    };
  }
  if (release.applicability.environment !== embedded.applicability.environment) {
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_environment_mismatch:${release.applicability.environment}`],
      blocksNewBuys: true,
    };
  }
  for (const b2Key of findForbiddenB2Keys(release.parameters)) {
    return {
      release: null,
      hash: null,
      diagnostics: [`v3_policy_override_forbidden_b2:${b2Key}`],
      blocksNewBuys: true,
    };
  }
  if (isVersionAtLeast340(release.strategy.version)) {
    const schemaErrors = validateV340Parameters(release.parameters);
    if (schemaErrors.length > 0) {
      return {
        release: null,
        hash: null,
        diagnostics: schemaErrors.map(err => `v3_policy_override_schema_invalid:${err}`),
        blocksNewBuys: true,
      };
    }
  } else if (isVersionAtLeast331(release.strategy.version)) {
    const schemaErrors = validateV331Parameters(release.parameters);
    if (schemaErrors.length > 0) {
      return {
        release: null,
        hash: null,
        diagnostics: schemaErrors.map(err => `v3_policy_override_schema_invalid:${err}`),
        blocksNewBuys: true,
      };
    }
  }
  return { release, hash: verifiedHash, diagnostics: [], blocksNewBuys: false };
}

/**
 * 可选运行时准入：仅当 `ASHARE_V3_ADMISSION_DB` 显式配置、且调用方给出实际
 * `accountId` / `asOf` 时才读取与评估（不使用环境变量账户或墙钟）。
 *
 * 语义（未建库不得成为隐性封锁）：
 * - 准入库不存在/不可读/权限不符 → 不阻断；
 * - 无对应事件 → 不阻断；
 * - 最新事件为 SUSPEND/REVOKE 且在目标交易日仍有效 → 阻断新开仓（止损与减仓不受影响）。
 */
function loadRuntimeAdmission(
  release: StrategyRelease,
  releaseHash: string,
  options: { accountId?: string; asOf?: string },
): { canOpen: boolean; state: RuntimeAdmissionState } {
  const dbPath = process.env.ASHARE_V3_ADMISSION_DB?.trim();
  const state: RuntimeAdmissionState = {
    configured: Boolean(dbPath),
    store_available: false,
    latest_action: null,
    latest_in_validity: false,
    evaluated_as_of: null,
  };
  if (!dbPath) return { canOpen: true, state };
  const accountId = options.accountId?.trim();
  const asOf = options.asOf?.trim();
  if (!accountId || !/^\d{8}$/.test(asOf ?? '')) return { canOpen: true, state };

  // 以 Asia/Shanghai 目标日收盘（15:00 CST = 07:00Z）作为评估时刻；之后记录的准入事件
  // 不得改变该日的历史回放。23:59:59Z 是北京时间次日 07:59，不能当收盘。
  const evaluatedAt = `${asOf!.slice(0, 4)}-${asOf!.slice(4, 6)}-${asOf!.slice(6, 8)}T07:00:00.000Z`;
  state.evaluated_as_of = evaluatedAt;

  let store: StrategyAdmissionStore | null = null;
  try {
    store = new StrategyAdmissionStore(dbPath, { readOnly: true });
    state.store_available = true;
    const scope = {
      account: accountId,
      market: release.applicability.market,
      environment: release.applicability.environment,
    };
    const latest = store.history()
      // 只取评估时刻之前已经记录的事件：明天写入的 RESUME 不能解除昨天的回放。
      .filter(event => event.recorded_at <= evaluatedAt)
      .filter(event => event.strategy_id === release.strategy.id
        && event.version === release.strategy.version
        && event.release_hash === releaseHash
        && event.account === scope.account
        && event.market === scope.market
        && event.environment === scope.environment)
      .sort((a, b) => b.seq - a.seq)[0];
    if (!latest) return { canOpen: true, state };
    state.latest_action = latest.action;
    state.latest_in_validity = latest.valid_from <= evaluatedAt && evaluatedAt < latest.valid_until;
    if ((latest.action === 'SUSPEND' || latest.action === 'REVOKE') && state.latest_in_validity) {
      return { canOpen: false, state };
    }
    return { canOpen: true, state };
  } catch {
    // 打不开/读不出不是“暂停”证据：按未配置处理，保持新开仓可用。
    return { canOpen: true, state: { ...state, store_available: false } };
  } finally {
    try { store?.close(); } catch { /* 关闭失败不影响已得到的准入结论 */ }
  }
}

/**
 * Load and verify the approved V3 offensive policy release (v3.2.0).
 *
 * `ASHARE_V3_POLICY_RELEASE_PATH` 是可选的运行时覆盖。覆盖文件缺失、不可读、JSON 非法、
 * 哈希不在白名单或策略/市场/环境不匹配时，一律回退内嵌已签基线并记录诊断；存在但不可用的
 * 覆盖文件只停止新增买入（`runtime_can_open=false`），P0/P1 减仓与日报照常。
 * 白名单由 `ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES`（逗号分隔）控制，未设置时只允许
 * 内嵌的 `V3_POLICY_EXPECTED_HASH`。
 *
 * `options.accountId` / `options.asOf` 用于按实际账户与目标交易日评估可选准入库；
 * 未提供时跳过准入评估（研究/筛选路径），不使用环境变量账户或墙钟。
 */
export function loadApprovedV3Policy(options: { accountId?: string; asOf?: string } = {}): ApprovedV3Policy {
  const embedded = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0;
  const embeddedHash = validateStrategyRelease(embedded);
  if (embeddedHash !== V3_POLICY_EXPECTED_HASH) {
    throw new Error(`v3_policy_hash_mismatch:${embeddedHash}`);
  }

  const overridePath = process.env.ASHARE_V3_POLICY_RELEASE_PATH?.trim();
  let release = embedded;
  let verifiedHash = embeddedHash;
  let overrideDiagnostics: string[] = [];
  let overrideBlocksNewBuys = false;
  if (overridePath) {
    const override = tryLoadOverrideRelease(overridePath, embedded);
    overrideDiagnostics = override.diagnostics;
    overrideBlocksNewBuys = override.blocksNewBuys;
    if (override.release && override.hash) {
      release = override.release;
      verifiedHash = override.hash;
    }
  }

  const runtime = loadRuntimeAdmission(release, verifiedHash, options);

  const p = release.parameters;
  const approved = release.production_admission === 'APPROVED_FOR_ACCOUNT';
  const deconcMode = p.deconcentration_mode === 'BOTTOM_GRIND_25' ? 'BOTTOM_GRIND_25' : 'STANDARD';
  const ddRaw = p.drawdown_control_mode?.trim();
  const drawdownMode: ApprovedV3Policy['drawdown_control_mode'] =
    ddRaw === 'TWO_STAGE_GRADUAL' || ddRaw === 'CPPI_F15_M5' ? ddRaw : 'HARD_STEP_LOCK';
  return {
    release,
    approved,
    strategy_id: release.strategy.id,
    version: release.strategy.version.startsWith('v') ? release.strategy.version : `v${release.strategy.version}`,
    content_hash: verifiedHash,
    override_diagnostics: overrideDiagnostics,
    runtime_can_open: runtime.canOpen && !overrideBlocksNewBuys,
    runtime_admission: runtime.state,
    bp1_pullback_enabled: p.bp1_pullback_status === 'ENABLED',
    bp2_breakout_enabled: p.bp2_breakout_status === 'ENABLED',
    bp2_breakout_status: p.bp2_breakout_status ?? 'DROPPED_NEGATIVE_OOS',
    stock_max_positions: intParam(p, 'stock_max_positions', 2),
    stock_max_single_weight_bps: intParam(p, 'stock_max_single_weight_bps', 1800),
    stock_risk_budget_bps: intParam(p, 'stock_risk_budget_per_trade_bps', 130),
    stock_min_order_cny: 8000,
    stock_price_cap_cny: 90,
    l1_warn_drawdown_bps: intParam(p, 'l1_warn_drawdown_bps', 1000),
    l2_normal_trigger_drawdown_bps: intParam(
      p,
      'l2_normal_trigger_drawdown_bps',
      intParam(p, 'drawdown_lock_trigger_bps', intParam(p, 'l2_hard_lifeline_drawdown_bps', 1500)),
    ),
    l2_normal_post_breaker_equity_bps: intParam(
      p,
      'l2_normal_post_breaker_equity_bps',
      intParam(p, 'drawdown_normal_post_lock_cap_bps', 1500),
    ),
    l2_preemptive_deconcentration_trigger_drawdown_bps: intParam(p, 'l2_preemptive_trigger_drawdown_bps', 1200),
    l2_deconcentration_post_breaker_equity_bps: intParam(
      p,
      'l2_deconcentration_post_breaker_equity_bps',
      intParam(p, 'drawdown_conc_post_lock_cap_bps', 0),
    ),
    l2_lock_trade_days: intParam(p, 'l2_lock_trade_days', 15),
    defensive_bond_reservoir_etf: p.defensive_bond_reservoir_etf || '511010.SH',
    defensive_bond_reservoir_fallback_etf: p.defensive_bond_reservoir_fallback_etf?.trim() || null,
    defensive_bond_reservoir_tertiary_etf: p.defensive_bond_reservoir_tertiary_etf?.trim() || null,
    defensive_bond_reservoir_drift_band_bps: intParam(p, 'defensive_bond_reservoir_drift_band_bps', 0),
    deconcentration_mode: deconcMode,
    deconcentration_keep_weight_bps: intParam(p, 'deconcentration_keep_weight_bps', 2500),
    deconcentration_support_breakdown_confirm_days: intParam(p, 'deconcentration_support_breakdown_confirm_days', 2),
    grind_tactical_slot_bps: intParam(p, 'grind_tactical_slot_bps', 1000),
    grind_reload_min_discount_bps: intParam(p, 'grind_reload_min_discount_bps', 700),
    grind_reload_rsi14_max: intParam(p, 'grind_reload_rsi14_max', 36),
    grind_reload_bias20_max_bps: intParam(p, 'grind_reload_bias20_max_bps', -650),
    grind_take_profit_bps: intParam(p, 'grind_take_profit_bps', 750),
    grind_drift_harvest_trigger_bps: intParam(p, 'grind_drift_harvest_trigger_bps', 3400),
    recovery_overlay_enabled: boolParam(p, 'recovery_overlay_enabled', false),
    recovery_equity_bps: intParam(p, 'recovery_equity_bps', 4000),
    recovery_icepoint_pct_ma60_max_bps: intParam(p, 'recovery_icepoint_pct_ma60_max_bps', 1500),
    recovery_icepoint_pct_ma20_max_bps: intParam(p, 'recovery_icepoint_pct_ma20_max_bps', 1500),
    recovery_icepoint_lookback_days: intParam(p, 'recovery_icepoint_lookback_days', 10),
    recovery_thrust_pct_ma20_min_bps: intParam(p, 'recovery_thrust_pct_ma20_min_bps', 4500),
    recovery_thrust_5d_jump_min_bps: intParam(p, 'recovery_thrust_5d_jump_min_bps', 3000),
    recovery_thrust_floor_pct_ma20_bps: intParam(p, 'recovery_thrust_floor_pct_ma20_bps', 4000),
    recovery_min_amount_vs_ma20_bps: intParam(p, 'recovery_min_amount_vs_ma20_bps', 11500),
    recovery_false_breakout_cooldown_days: intParam(p, 'recovery_false_breakout_cooldown_days', 10),
    lowvol_core_permanent_share_bps: intParam(p, 'lowvol_core_permanent_share_bps', 0),
    drawdown_control_mode: drawdownMode,
    drawdown_stage1_bps: intParam(p, 'drawdown_stage1_bps', 800),
    drawdown_stage1_cap_bps: intParam(p, 'drawdown_stage1_cap_bps', 5000),
    drawdown_stage2_bps: intParam(p, 'drawdown_stage2_bps', 1100),
    drawdown_stage2_cap_bps: intParam(p, 'drawdown_stage2_cap_bps', 2500),
    drawdown_lock_trigger_bps: intParam(p, 'drawdown_lock_trigger_bps', intParam(p, 'l2_normal_trigger_drawdown_bps', 1350)),
    drawdown_unlock_reanchor_enabled: boolParam(p, 'drawdown_unlock_reanchor_enabled', false),
    drawdown_unlock_ramp_trade_days: intParam(p, 'drawdown_unlock_ramp_trade_days', 0),
    sector_pioneer_enabled: boolParam(p, 'sector_pioneer_enabled', false),
    sector_pioneer_top_k: intParam(p, 'sector_pioneer_top_k', 1),
    sector_pioneer_max_weight_bps: intParam(p, 'sector_pioneer_max_weight_bps', 2000),
    stock_bp1_min_investable_nav_cny: intParam(p, 'stock_bp1_min_investable_nav_cny', 0),
    stock_bp1_block_during_deconcentration: boolParam(p, 'stock_bp1_block_during_deconcentration', false),
    deconcentration_plan_enabled: boolParam(p, 'deconcentration_plan_enabled', true),
    regime_target_enforced_on_existing_holdings: boolParam(p, 'regime_target_enforced_on_existing_holdings', false),
    align_glide_carryover_bps: intParam(p, 'align_glide_carryover_bps', 0),
    equity_align_drift_band_bps: intParam(p, 'equity_align_drift_band_bps', 500),
    chassis_single_etf_per_style_bucket: boolParam(p, 'chassis_single_etf_per_style_bucket', false),
    p1_etf_trailing_sleeves: parseSleeveList(p.p1_etf_trailing_sleeves, ['ALL']).sleeves,
    lowvol_core_mode: p.lowvol_core_mode?.trim() === 'CORE_40' ? 'CORE_40' : 'LEGACY',
    gold_core_etf: p.gold_core_etf?.trim() || '518880.SH',
    gold_core_share_bps: intParam(p, 'gold_core_share_bps', 0),
    gold_core_drift_band_bps: intParam(p, 'gold_core_drift_band_bps', 400),
    gold_core_min_trade_cny: intParam(p, 'gold_core_min_trade_cny', 5000),
    strategic_bond_core_share_bps: intParam(p, 'strategic_bond_core_share_bps', 0),
    defensive_bond_reservoir_min_trade_cny: intParam(p, 'defensive_bond_reservoir_min_trade_cny', 0),
    satellite_max_share_bps: intParam(p, 'satellite_max_share_bps', 6000),
    ice10_floor_enabled: boolParam(p, 'ice10_floor_enabled', false),
    ice10_pct_ma60_max_bps: intParam(p, 'ice10_pct_ma60_max_bps', 1000),
    ice10_window_trade_days: intParam(p, 'ice10_window_trade_days', 15),
    ice10_equity_bps: intParam(p, 'ice10_equity_bps', 3500),
    ice10_disable_on_p0_lock: boolParam(p, 'ice10_disable_on_p0_lock', true),
    fundamental_envelope_enabled: boolParam(p, 'fundamental_envelope_enabled', false),
    fundamental_envelope_mode: p.fundamental_envelope_mode?.trim() || 'NONE',
    fundamental_envelope_lookback_days: intParam(p, 'fundamental_envelope_lookback_days', 756),
    fundamental_hysteresis_bps: intParam(p, 'fundamental_hysteresis_bps', 500),
    fundamental_underval_erp_enter_bps: intParam(p, 'fundamental_underval_erp_enter_bps', 8000),
    fundamental_underval_erp_exit_bps: intParam(p, 'fundamental_underval_erp_exit_bps', 7500),
    fundamental_underval_bp_enter_bps: intParam(p, 'fundamental_underval_bp_enter_bps', 7000),
    fundamental_underval_bp_exit_bps: intParam(p, 'fundamental_underval_bp_exit_bps', 6500),
    fundamental_bubble_erp_enter_bps: intParam(p, 'fundamental_bubble_erp_enter_bps', 1500),
    fundamental_bubble_erp_exit_bps: intParam(p, 'fundamental_bubble_erp_exit_bps', 2000),
    fundamental_bubble_bp_enter_bps: intParam(p, 'fundamental_bubble_bp_enter_bps', 1500),
    fundamental_bubble_bp_exit_bps: intParam(p, 'fundamental_bubble_bp_exit_bps', 2000),
    fundamental_underval_offensive_bps: intParam(p, 'fundamental_underval_offensive_bps', 8500),
    fundamental_underval_structural_bps: intParam(p, 'fundamental_underval_structural_bps', 6500),
    fundamental_underval_recovery_bps: intParam(p, 'fundamental_underval_recovery_bps', 5000),
    fundamental_underval_ice10_bps: intParam(p, 'fundamental_underval_ice10_bps', 4250),
    fundamental_underval_defensive_bps: intParam(p, 'fundamental_underval_defensive_bps', 2500),
    fundamental_bubble_offensive_bps: intParam(p, 'fundamental_bubble_offensive_bps', 7000),
    fundamental_bubble_structural_bps: intParam(p, 'fundamental_bubble_structural_bps', 5000),
    fundamental_bubble_recovery_bps: intParam(p, 'fundamental_bubble_recovery_bps', 4000),
    fundamental_bubble_ice10_bps: intParam(p, 'fundamental_bubble_ice10_bps', 3500),
    fundamental_bubble_defensive_bps: intParam(p, 'fundamental_bubble_defensive_bps', 2500),
    align_trigger_mode: p.align_trigger_mode?.trim() === 'REGIME_ONLY' ? 'REGIME_ONLY' : 'STANDARD',
    satellite_align_drift_band_bps: intParam(p, 'satellite_align_drift_band_bps', intParam(p, 'equity_align_drift_band_bps', 1000)),
    quality_core_version: p.quality_core_version?.trim() === 'v2' ? 'v2' : 'v1',
    quality_core_roe_dt_ann_min_bps: intParam(p, 'quality_core_roe_dt_ann_min_bps', 600),
    quality_core_eps_min: intParam(p, 'quality_core_eps_min', 0),
    quality_core_ocf_to_profit_min_bps: intParam(p, 'quality_core_ocf_to_profit_min_bps', 5000),
    quality_core_bps_min: intParam(p, 'quality_core_bps_min', 0),
    quality_core_strict_ann_date: boolParam(p, 'quality_core_strict_ann_date', false),
    stock_bp1_reverify_nav_cny: intParam(p, 'stock_bp1_reverify_nav_cny', 95000),
    fvo_enabled: boolParam(p, 'fvo_enabled', false),
    fvo_scalar_only: boolParam(p, 'fvo_scalar_only', true),
    fvo_equity_delta_default_bps: intParam(p, 'fvo_equity_delta_default_bps', 0),
    fvo_max_abs_delta_bps: intParam(p, 'fvo_max_abs_delta_bps', 1000),
    fvo_max_ttl_trade_days: intParam(p, 'fvo_max_ttl_trade_days', 20),
    fvo_zero_positive_on_l1_or_bubble: boolParam(p, 'fvo_zero_positive_on_l1_or_bubble', true),
    fvo_l1_drawdown_bps: intParam(p, 'fvo_l1_drawdown_bps', 800),
    fvo_60d_attribution_halve_trigger_bps: intParam(p, 'fvo_60d_attribution_halve_trigger_bps', -150),
    fvo_60d_attribution_halved_cap_bps: intParam(p, 'fvo_60d_attribution_halved_cap_bps', 500),
    policy_freeze_start_date: p.policy_freeze_start_date?.trim() || null,
    policy_freeze_end_date: p.policy_freeze_end_date?.trim() || null,
  };
}
