import type { DatabaseSync } from 'node:sqlite';
import {
  REGIME_TARGET_EQUITY_BPS,
  type MarketRegimeResult,
  type MarketRegimeTier,
} from '../ashare/marketRegime.js';
import { portfolioTableExists } from './db.js';
import { buildNavSeries, readBaseline } from './ledger.js';
import { buildLedgerPriceTable } from './riskPolicy.js';
import { loadApprovedV3Policy, type ApprovedV3Policy } from './v3Policy.js';

export type CircuitBreakerStatus = 'NORMAL' | 'L1_WARN' | 'L2_LOCKED';
export type SubStrategyStatus = 'ACTIVE' | 'STOP_ONLY' | 'REDUCE_ONLY' | 'LOCKED_PENDING_VALIDATION';

export interface PersistedRiskAnchor {
  account_id: string;
  initial_principal_cents: number;
  hwm_nav_cents: number;
  hwm_date: string;
  circuit_breaker_status: CircuitBreakerStatus;
  locked_until_trade_date: string | null;
  updated_at: string;
}

export interface StrategyRouterResult {
  schema: 'portfolio-strategy-router/1.0';
  as_of_trade_date: string;
  account_id: string;
  anchor_persisted: boolean;
  effective_regime: MarketRegimeTier;
  circuit_breaker_status: CircuitBreakerStatus;
  circuit_breaker_label_zh: string;
  locked_until_trade_date: string | null;
  l2_trigger_drawdown_bps: number;
  post_breaker_equity_bps: number;
  deconcentration_preemptive_active: boolean;
  policy_version: string;
  should_advance_hwm: boolean;
  should_persist_anchor: boolean;
  anchor_snapshot: {
    initial_principal_cents: number;
    current_nav_cents: number;
    cumulative_pnl_cents: number;
    cumulative_return_pct: number;
    recovery_needed_pct: number;
    hwm_nav_cents: number;
    hwm_date: string;
    /** hwm_date → asOf 的单位净值比（1 = 无真实盈亏；<1 = 回撤）。单位净值不可用时为 null。 */
    hwm_unit_nav_ratio: number | null;
    /** UNIT_NAV = 已按单位净值折算出入金；RAW_NAV = 缺少账本/估值，退化为名义净值比较。 */
    hwm_nav_basis: 'UNIT_NAV' | 'RAW_NAV';
    hwm_drawdown_bps: number;
    hwm_drawdown_pct: number;
    lifeline_nav_cents: number;
    lifeline_buffer_cents: number;
    lifeline_buffer_pct: number;
  };
  targets: {
    target_equity_bps: number;
    base_super_etf_bps: number;
    pioneer_bps: number;
    defensive_cash_bps: number;
  };
  sub_strategies: {
    s_deconcentrate: SubStrategyStatus;
    s_base_super_etf: SubStrategyStatus;
    s_stock_swing: SubStrategyStatus;
  };
  sub_strategies_zh: {
    deconcentrate_label: string;
    base_etf_label: string;
    stock_swing_label: string;
  };
}

export interface EvaluateStrategyRouterInput {
  portfolioDb?: DatabaseSync | null;
  marketDb?: DatabaseSync | null;
  accountId: string;
  asOf: string;
  currentNavCents: number;
  fallbackBaselineNavCents?: number;
  marketRegime: MarketRegimeResult;
  phase1LockStockSwing?: boolean;
  /** True when a concentrated sector ETF deconcentration plan is active (triggers preemptive -12%->0% L2). */
  deconcentrationActive?: boolean;
  deconcentrationMode?: 'STANDARD' | 'BOTTOM_GRIND_25';
  /** 调用方已加载的策略（一次加载传给 router/screen/engine）；缺省时按实际 accountId/asOf 自行加载。 */
  policy?: ApprovedV3Policy;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + deltaDays));
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

export function nextOpenTradeDayAfterN(
  marketDb: DatabaseSync | null | undefined,
  asOf: string,
  openDays: number,
): string {
  if (openDays <= 0) return asOf;
  if (marketDb && portfolioTableExists(marketDb, 'trade_cal')) {
    const rows = marketDb.prepare(
      'SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date > ? ORDER BY cal_date ASC LIMIT ?',
    ).all(asOf, openDays) as { cal_date: string }[];
    if (rows.length >= openDays) return rows[openDays - 1].cal_date;
  }
  return addCalendarDaysYmd(asOf, Math.ceil(openDays * 1.48));
}

export function readInitialPrincipalCents(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
): number | null {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_meta')) return null;
  const row = portfolioDb.prepare('SELECT value FROM account_meta WHERE key = ?')
    .get(`initial_principal_cents:${accountId}`) as { value?: string } | undefined;
  if (!row?.value) return null;
  const parsed = Number(row.value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readRiskAnchor(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
): PersistedRiskAnchor | null {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_risk_anchor')) return null;
  const row = portfolioDb.prepare(
    'SELECT account_id, initial_principal_cents, hwm_nav_cents, hwm_date, circuit_breaker_status, locked_until_trade_date, updated_at FROM account_risk_anchor WHERE account_id = ?',
  ).get(accountId) as PersistedRiskAnchor | undefined;
  return row ?? null;
}

interface UnitSharePair {
  /** hwm_date 当日单位份额数（buildNavSeries 的 units 口径）。 */
  from_units: number;
  /** asOf 当日单位份额数。 */
  to_units: number;
}

/**
 * 计算 `hwmDate → asOf` 的单位份额对（复用 `buildNavSeries` 的日终现金流单位化口径）。
 *
 * 出入金按流水日扣流前估值折算份额：入金增加份额、出金减少份额，单位净值本身不因流水改变。
 * 回撤 = 1 − (当前净值 / 持久高水位) × (hwm_date 份额 / asOf 份额)，
 * 因此入金不会摊薄回撤，出金不会放大回撤；持久高水位仍是名义净值的唯一锚。
 * 缺少基线、流水日/目标日无法单位化时返回 null，调用方退化为名义净值比较（不做加法折入）。
 */
function readUnitSharePair(
  portfolioDb: DatabaseSync | null | undefined,
  marketDb: DatabaseSync | null | undefined,
  accountId: string,
  fromDate: string,
  toDate: string,
): UnitSharePair | null {
  if (!portfolioDb || fromDate >= toDate) return null;
  try {
    const baseline = readBaseline(portfolioDb, accountId);
    if (!baseline || baseline.as_of > fromDate) return null;
    const prices = buildLedgerPriceTable(portfolioDb, marketDb ?? null, accountId, baseline.as_of, toDate);
    const series = buildNavSeries(portfolioDb, accountId, { from: fromDate, to: toDate, prices });
    const fromPoint = series.points.find(point => point.date === fromDate);
    const toPoint = series.points.find(point => point.date === toDate);
    // nav_per_unit 为 null 表示当日无法可靠单位化（unitisation_skipped），此时份额不可信。
    if (fromPoint?.nav_per_unit === null || fromPoint?.nav_per_unit === undefined) return null;
    if (toPoint?.nav_per_unit === null || toPoint?.nav_per_unit === undefined) return null;
    if (!(fromPoint.units > 0) || !(toPoint.units > 0)) return null;
    return { from_units: fromPoint.units, to_units: toPoint.units };
  } catch {
    return null;
  }
}

/**
 * 读取目标交易日当天的未撤销外部净现金流（分）。仅用于锚点日与目标日相同、无法单位化的
 * 同日场景：用扣流前 NAV 比较，避免当日入/出金触发假熔断。
 */
function readSameDayNetExternalFlowCents(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
  day: string,
): number {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_event')) return 0;
  try {
    const row = portfolioDb.prepare(`
      SELECT COALESCE(SUM(cash_delta_cents), 0) AS net
      FROM account_event
      WHERE account_id = ?
        AND event_type IN ('CASH_DEPOSIT', 'CASH_WITHDRAW')
        AND reversed_by IS NULL
        AND occurred_on = ?
    `).get(accountId, day) as { net?: number } | undefined;
    const net = Number(row?.net ?? 0);
    return Number.isSafeInteger(net) ? net : 0;
  } catch {
    return 0;
  }
}

interface HwmEvaluation {
  effectiveHwmCents: number;
  effectiveHwmDate: string;
  /** 用于回撤/生命线缓冲的比较 NAV（同日外部流水场景下为扣流前 NAV）。 */
  comparisonNavCents: number;
  unitNavRatio: number | null;
  basis: 'UNIT_NAV' | 'RAW_NAV';
  shouldAdvanceHwm: boolean;
  shouldPersistAnchor: boolean;
}

/**
 * 高水位判定：有账本基线与估值时按“单位份额折算后的净值比”比较（出入金不改变净值），
 * 否则退化为名义净值比较。单位净值创新高时把锚点推进到当日名义净值——
 * 即使该名义值低于旧高水位（出金后 70 -> 63 的场景）。
 */
function evaluateHwm(
  input: EvaluateStrategyRouterInput,
  existing: PersistedRiskAnchor | null,
): HwmEvaluation {
  if (!existing) {
    return {
      effectiveHwmCents: Math.max(input.fallbackBaselineNavCents ?? input.currentNavCents, input.currentNavCents),
      effectiveHwmDate: input.asOf,
      comparisonNavCents: input.currentNavCents,
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: true,
      shouldPersistAnchor: true,
    };
  }

  const shares = readUnitSharePair(input.portfolioDb, input.marketDb, input.accountId, existing.hwm_date, input.asOf);
  if (shares && existing.hwm_nav_cents > 0) {
    const ratio = (input.currentNavCents / existing.hwm_nav_cents) * (shares.from_units / shares.to_units);
    // 单位份额按 1e-6 精度取整；用极小容差避免无流水日因舍入抖动推进锚点。
    if (input.asOf >= existing.hwm_date && ratio > 1 + 1e-6) {
      return {
        effectiveHwmCents: input.currentNavCents,
        effectiveHwmDate: input.asOf,
        comparisonNavCents: input.currentNavCents,
        unitNavRatio: ratio,
        basis: 'UNIT_NAV',
        shouldAdvanceHwm: true,
        shouldPersistAnchor: true,
      };
    }
    return {
      effectiveHwmCents: Math.round(input.currentNavCents / ratio),
      effectiveHwmDate: existing.hwm_date,
      comparisonNavCents: input.currentNavCents,
      unitNavRatio: ratio,
      basis: 'UNIT_NAV',
      shouldAdvanceHwm: false,
      shouldPersistAnchor: input.asOf >= existing.hwm_date,
    };
  }

  // 锚点日 == 目标日（同日建锚或重跑）且无法单位化：用扣流前 NAV 比较，
  // 避免当日入金/出金被当成真实盈亏触发假熔断。
  if (existing.hwm_date === input.asOf) {
    const sameDayFlowCents = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
    const preFlowNavCents = input.currentNavCents - sameDayFlowCents;
    if (preFlowNavCents > existing.hwm_nav_cents) {
      return {
        effectiveHwmCents: input.currentNavCents,
        effectiveHwmDate: input.asOf,
        comparisonNavCents: input.currentNavCents,
        unitNavRatio: null,
        basis: 'RAW_NAV',
        shouldAdvanceHwm: true,
        shouldPersistAnchor: true,
      };
    }
    return {
      effectiveHwmCents: existing.hwm_nav_cents,
      effectiveHwmDate: existing.hwm_date,
      comparisonNavCents: preFlowNavCents,
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: false,
      shouldPersistAnchor: true,
    };
  }

  if (input.asOf >= existing.hwm_date && input.currentNavCents > existing.hwm_nav_cents) {
    return {
      effectiveHwmCents: input.currentNavCents,
      effectiveHwmDate: input.asOf,
      comparisonNavCents: input.currentNavCents,
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: true,
      shouldPersistAnchor: true,
    };
  }
  return {
    effectiveHwmCents: existing.hwm_nav_cents,
    effectiveHwmDate: existing.hwm_date,
    comparisonNavCents: input.currentNavCents,
    unitNavRatio: null,
    basis: 'RAW_NAV',
    shouldAdvanceHwm: false,
    shouldPersistAnchor: input.asOf >= existing.hwm_date,
  };
}

function targetBucketsFor(regime: MarketRegimeTier): StrategyRouterResult['targets'] {
  if (regime === 'OFFENSIVE') {
    return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.OFFENSIVE, base_super_etf_bps: 3750, pioneer_bps: 4750, defensive_cash_bps: 1500 };
  }
  if (regime === 'STRUCTURAL') {
    return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.STRUCTURAL, base_super_etf_bps: 2500, pioneer_bps: 3500, defensive_cash_bps: 4000 };
  }
  return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.DEFENSIVE, base_super_etf_bps: 1500, pioneer_bps: 0, defensive_cash_bps: 8500 };
}

export function evaluateStrategyRouter(input: EvaluateStrategyRouterInput): StrategyRouterResult {
  const existing = readRiskAnchor(input.portfolioDb, input.accountId);
  const metaPrincipal = readInitialPrincipalCents(input.portfolioDb, input.accountId);
  const initialPrincipalCents = metaPrincipal
    ?? existing?.initial_principal_cents
    ?? input.fallbackBaselineNavCents
    ?? input.currentNavCents;

  const hwm = evaluateHwm(input, existing);
  const effectiveHwmCents = hwm.effectiveHwmCents;
  const effectiveHwmDate = hwm.effectiveHwmDate;
  const comparisonNavCents = hwm.comparisonNavCents;
  const unitNavRatio = hwm.unitNavRatio;
  const navBasis = hwm.basis;
  const shouldAdvanceHwm = hwm.shouldAdvanceHwm;
  let shouldPersistAnchor = hwm.shouldPersistAnchor;

  const v3Policy = input.policy ?? loadApprovedV3Policy({ accountId: input.accountId, asOf: input.asOf });
  const deconcActive = Boolean(input.deconcentrationActive);
  const l2TriggerBps = deconcActive
    ? v3Policy.l2_preemptive_deconcentration_trigger_drawdown_bps
    : v3Policy.l2_normal_trigger_drawdown_bps;
  const postBreakerEquityBps = deconcActive
    ? v3Policy.l2_deconcentration_post_breaker_equity_bps
    : v3Policy.l2_normal_post_breaker_equity_bps;
  const l2TriggerPct = l2TriggerBps / 100;

  const cumulativePnlCents = input.currentNavCents - initialPrincipalCents;
  const cumulativeReturnPct = initialPrincipalCents > 0
    ? r2(((input.currentNavCents / initialPrincipalCents) - 1) * 100)
    : 0;
  const recoveryNeededPct = input.currentNavCents > 0 && input.currentNavCents < initialPrincipalCents
    ? r2(((initialPrincipalCents - input.currentNavCents) / input.currentNavCents) * 100)
    : 0;

  const hwmDrawdownBps = effectiveHwmCents > 0
    ? Math.max(0, Math.round(((effectiveHwmCents - comparisonNavCents) / effectiveHwmCents) * 10000))
    : 0;
  const hwmDrawdownPct = r2(hwmDrawdownBps / 100);
  const lifelineNavCents = Math.round(effectiveHwmCents * (10000 - l2TriggerBps) / 10000);
  const lifelineBufferCents = comparisonNavCents - lifelineNavCents;
  const lifelineBufferPct = effectiveHwmCents > 0
    ? r2(((comparisonNavCents - lifelineNavCents) / effectiveHwmCents) * 100)
    : 0;

  let circuitBreakerStatus: CircuitBreakerStatus = 'NORMAL';
  let lockedUntil: string | null = null;
  if (
    existing
    && input.asOf >= existing.updated_at
    && existing.circuit_breaker_status === 'L2_LOCKED'
    && existing.locked_until_trade_date
    && existing.locked_until_trade_date >= input.asOf
  ) {
    circuitBreakerStatus = 'L2_LOCKED';
    lockedUntil = existing.locked_until_trade_date;
  } else if (hwmDrawdownBps >= l2TriggerBps) {
    circuitBreakerStatus = 'L2_LOCKED';
    lockedUntil = nextOpenTradeDayAfterN(input.marketDb, input.asOf, v3Policy.l2_lock_trade_days);
    if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
  } else if (hwmDrawdownBps >= v3Policy.l1_warn_drawdown_bps) {
    circuitBreakerStatus = 'L1_WARN';
    if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
  }

  const effectiveRegime: MarketRegimeTier = circuitBreakerStatus === 'L2_LOCKED'
    ? 'DEFENSIVE'
    : input.marketRegime.regime;
  const targets: StrategyRouterResult['targets'] = circuitBreakerStatus === 'L2_LOCKED'
    ? {
        target_equity_bps: postBreakerEquityBps,
        base_super_etf_bps: postBreakerEquityBps,
        pioneer_bps: 0,
        defensive_cash_bps: 10000 - postBreakerEquityBps,
      }
    : targetBucketsFor(effectiveRegime);

  const phase1Lock = input.phase1LockStockSwing ?? !v3Policy.approved;
  const sDeconcentrate: SubStrategyStatus = 'ACTIVE';
  const sBaseSuperEtf: SubStrategyStatus = circuitBreakerStatus === 'L2_LOCKED' ? 'REDUCE_ONLY' : 'ACTIVE';
  let sStockSwing: SubStrategyStatus = 'ACTIVE';
  if (circuitBreakerStatus !== 'NORMAL' || effectiveRegime === 'DEFENSIVE') {
    sStockSwing = 'STOP_ONLY';
  } else if (phase1Lock) {
    sStockSwing = 'LOCKED_PENDING_VALIDATION';
  }

  const breakerLabelZh = circuitBreakerStatus === 'L2_LOCKED'
    ? deconcActive
      ? `二级熔断锁定（重仓换马期回撤达 ${l2TriggerPct.toFixed(0)}% 前置保护触发，风险权益清零防守至 ${lockedUntil}）`
      : `二级熔断锁定（高水位回撤达 ${l2TriggerPct.toFixed(0)}%，防守冷静期至 ${lockedUntil}）`
    : circuitBreakerStatus === 'L1_WARN'
      ? '一级回撤警戒（高水位回撤超 10%，冻结个股新开仓）'
      : deconcActive
        ? `正常受控（重仓换马期启用 ${l2TriggerPct.toFixed(0)}% 前置熔断保护，守卫 ${l2TriggerPct.toFixed(0)}% 生命线）`
        : `正常受控（位于 ${l2TriggerPct.toFixed(0)}% 熔断生命线之上）`;

  const stockSwingLabelZh = sStockSwing === 'STOP_ONLY'
    ? '仅允许执行存量止损或止盈，禁止新开仓'
    : sStockSwing === 'LOCKED_PENDING_VALIDATION'
      ? '待策略准入验证通过后解锁'
      : '强势股缩量低于 20 日均值回踩 20 日均线买点已解锁运行（平台突破买点已按实证剔除，严守-8%硬止损）';

  return {
    schema: 'portfolio-strategy-router/1.0',
    as_of_trade_date: input.asOf,
    account_id: input.accountId,
    anchor_persisted: !!existing,
    effective_regime: effectiveRegime,
    circuit_breaker_status: circuitBreakerStatus,
    circuit_breaker_label_zh: breakerLabelZh,
    locked_until_trade_date: lockedUntil,
    l2_trigger_drawdown_bps: l2TriggerBps,
    post_breaker_equity_bps: postBreakerEquityBps,
    deconcentration_preemptive_active: deconcActive,
    policy_version: v3Policy.version,
    should_advance_hwm: shouldAdvanceHwm,
    should_persist_anchor: shouldPersistAnchor,
    anchor_snapshot: {
      initial_principal_cents: initialPrincipalCents,
      current_nav_cents: input.currentNavCents,
      cumulative_pnl_cents: cumulativePnlCents,
      cumulative_return_pct: cumulativeReturnPct,
      recovery_needed_pct: recoveryNeededPct,
      hwm_nav_cents: effectiveHwmCents,
      hwm_date: effectiveHwmDate,
      hwm_unit_nav_ratio: unitNavRatio,
      hwm_nav_basis: navBasis,
      hwm_drawdown_bps: hwmDrawdownBps,
      hwm_drawdown_pct: hwmDrawdownPct,
      lifeline_nav_cents: lifelineNavCents,
      lifeline_buffer_cents: lifelineBufferCents,
      lifeline_buffer_pct: lifelineBufferPct,
    },
    targets,
    sub_strategies: {
      s_deconcentrate: sDeconcentrate,
      s_base_super_etf: sBaseSuperEtf,
      s_stock_swing: sStockSwing,
    },
    sub_strategies_zh: {
      deconcentrate_label: input.deconcentrationMode === 'BOTTOM_GRIND_25'
        ? '存量重仓 25%底仓与震荡磨底降本状态机：运行中'
        : '存量重仓四批换马状态机：运行中',
      base_etf_label: sBaseSuperEtf === 'REDUCE_ONLY'
        ? '底盘超级 ETF 桶：熔断期间只降不加'
        : '底盘超级 ETF 桶：正常运行',
      stock_swing_label: `先锋主板强势股波段：${stockSwingLabelZh}`,
    },
  };
}

export function persistRiskAnchor(
  portfolioDb: DatabaseSync | null | undefined,
  router: StrategyRouterResult,
): boolean {
  if (!portfolioDb || !router.should_persist_anchor) return false;
  if (!portfolioTableExists(portfolioDb, 'account_risk_anchor')) return false;
  try {
    // 只有真新高（should_advance_hwm）才允许改写高水位锚点。单位净值新高时名义净值可能
    // 低于旧锚点（出金后 70 -> 63），因此这里不能用名义大小做写入条件。
    const advance = router.should_advance_hwm ? 1 : 0;
    portfolioDb.prepare(`
      INSERT INTO account_risk_anchor (
        account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
        circuit_breaker_status, locked_until_trade_date, updated_at
      ) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET
        initial_principal_cents = excluded.initial_principal_cents,
        hwm_nav_cents = CASE
          WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
          THEN excluded.hwm_nav_cents
          ELSE account_risk_anchor.hwm_nav_cents
        END,
        hwm_date = CASE
          WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
          THEN excluded.hwm_date
          ELSE account_risk_anchor.hwm_date
        END,
        circuit_breaker_status = excluded.circuit_breaker_status,
        locked_until_trade_date = excluded.locked_until_trade_date,
        updated_at = excluded.updated_at
    `).run(
      router.account_id,
      router.anchor_snapshot.initial_principal_cents,
      router.anchor_snapshot.hwm_nav_cents,
      router.anchor_snapshot.hwm_date,
      router.circuit_breaker_status,
      router.locked_until_trade_date,
      router.as_of_trade_date,
      advance,
      advance,
    );
    return true;
  } catch (err: any) {
    if (String(err?.message ?? err).includes('readonly')) return false;
    throw err;
  }
}
