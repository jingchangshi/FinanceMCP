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
  deconcentration_mode: 'STANDARD' | 'BOTTOM_GRIND_25';
  deconcentration_keep_weight_bps: number;
  deconcentration_support_breakdown_confirm_days: number;
  grind_tactical_slot_bps: number;
  grind_reload_min_discount_bps: number;
  grind_reload_rsi14_max: number;
  grind_reload_bias20_max_bps: number;
  grind_take_profit_bps: number;
  grind_drift_harvest_trigger_bps: number;
}

function intParam(params: Record<string, string>, key: string, fallback: number): number {
  const n = Number(params[key]);
  return Number.isSafeInteger(n) ? n : fallback;
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
    l2_normal_trigger_drawdown_bps: intParam(p, 'l2_hard_lifeline_drawdown_bps', 1500),
    l2_normal_post_breaker_equity_bps: 1500,
    l2_preemptive_deconcentration_trigger_drawdown_bps: intParam(p, 'l2_preemptive_trigger_drawdown_bps', 1200),
    l2_deconcentration_post_breaker_equity_bps: intParam(p, 'l2_deconcentration_post_breaker_equity_bps', 0),
    l2_lock_trade_days: intParam(p, 'l2_lock_trade_days', 15),
    defensive_bond_reservoir_etf: p.defensive_bond_reservoir_etf || '511010.SH',
    deconcentration_mode: deconcMode,
    deconcentration_keep_weight_bps: intParam(p, 'deconcentration_keep_weight_bps', 2500),
    deconcentration_support_breakdown_confirm_days: intParam(p, 'deconcentration_support_breakdown_confirm_days', 2),
    grind_tactical_slot_bps: intParam(p, 'grind_tactical_slot_bps', 1000),
    grind_reload_min_discount_bps: intParam(p, 'grind_reload_min_discount_bps', 700),
    grind_reload_rsi14_max: intParam(p, 'grind_reload_rsi14_max', 36),
    grind_reload_bias20_max_bps: intParam(p, 'grind_reload_bias20_max_bps', -650),
    grind_take_profit_bps: intParam(p, 'grind_take_profit_bps', 750),
    grind_drift_harvest_trigger_bps: intParam(p, 'grind_drift_harvest_trigger_bps', 3400),
  };
}
