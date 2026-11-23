import type { DatabaseSync } from 'node:sqlite';
import {
  REGIME_TARGET_EQUITY_BPS,
  type MarketRegimeResult,
  type MarketRegimeTier,
} from '../ashare/marketRegime.js';
import { portfolioTableExists } from './db.js';
import { loadApprovedV3Policy } from './v3Policy.js';

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
    /** 持久锚点之后 `(hwm_date, asOf]` 区间内的外部净现金流（分）：正 = 净入金，负 = 净出金。 */
    hwm_cash_flow_adjustment_cents: number;
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

/**
 * 读取 `(fromExclusiveYmd, toInclusiveYmd]` 区间内已入账的外部净现金流（分）。
 *
 * 口径：只统计未撤销的 `CASH_DEPOSIT` / `CASH_WITHDRAW`（`cash_delta_cents` 出金为负）。
 * 成交、分红与费用属于账户内部变动，不是外部出入金，不计入高水位调整。
 * 账本表缺失（只读库/未迁移库）或查询失败时返回 0：高水位退化为原始口径，绝不阻断日报。
 */
export function readNetExternalCashFlowCents(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
  fromExclusiveYmd: string,
  toInclusiveYmd: string,
): number {
  if (!portfolioDb || fromExclusiveYmd >= toInclusiveYmd) return 0;
  if (!portfolioTableExists(portfolioDb, 'account_event')) return 0;
  try {
    const row = portfolioDb.prepare(`
      SELECT COALESCE(SUM(cash_delta_cents), 0) AS net
      FROM account_event
      WHERE account_id = ?
        AND event_type IN ('CASH_DEPOSIT', 'CASH_WITHDRAW')
        AND reversed_by IS NULL
        AND occurred_on > ?
        AND occurred_on <= ?
    `).get(accountId, fromExclusiveYmd, toInclusiveYmd) as { net?: number } | undefined;
    const net = Number(row?.net ?? 0);
    return Number.isSafeInteger(net) ? net : 0;
  } catch {
    return 0;
  }
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

  let effectiveHwmCents = input.currentNavCents;
  let effectiveHwmDate = input.asOf;
  let hwmCashFlowAdjustmentCents = 0;
  let shouldAdvanceHwm = false;
  let shouldPersistAnchor = false;

  if (existing) {
    // 外部现金流只调整“比较基准”，不直接改写持久锚点：
    // 每轮都用持久锚点 + (hwm_date, asOf] 区间净流水重算，因此同一笔流水只折入一次。
    hwmCashFlowAdjustmentCents = readNetExternalCashFlowCents(
      input.portfolioDb,
      input.accountId,
      existing.hwm_date,
      input.asOf,
    );
    const flowAdjustedHwmCents = existing.hwm_nav_cents + hwmCashFlowAdjustmentCents;
    if (input.asOf >= existing.hwm_date && input.currentNavCents > flowAdjustedHwmCents) {
      // 真新高：把期间外部流水一次性折入新锚点（hwm = 当前净值，hwm_date = asOf）。
      // 下一次运行的区间从 asOf 之后开始，不会再次计入同一笔流水。
      effectiveHwmCents = input.currentNavCents;
      effectiveHwmDate = input.asOf;
      shouldAdvanceHwm = true;
      shouldPersistAnchor = true;
    } else {
      // 未创新高：只在内存里用调整后的高水位算回撤，不写回数据库。
      effectiveHwmCents = flowAdjustedHwmCents;
      effectiveHwmDate = existing.hwm_date;
      shouldPersistAnchor = input.asOf >= existing.hwm_date;
    }
  } else {
    effectiveHwmCents = Math.max(input.fallbackBaselineNavCents ?? input.currentNavCents, input.currentNavCents);
    effectiveHwmDate = input.asOf;
    shouldAdvanceHwm = true;
    shouldPersistAnchor = true;
  }

  const v3Policy = loadApprovedV3Policy();
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
    ? Math.max(0, Math.round(((effectiveHwmCents - input.currentNavCents) / effectiveHwmCents) * 10000))
    : 0;
  const hwmDrawdownPct = r2(hwmDrawdownBps / 100);
  const lifelineNavCents = Math.round(effectiveHwmCents * (10000 - l2TriggerBps) / 10000);
  const lifelineBufferCents = input.currentNavCents - lifelineNavCents;
  const lifelineBufferPct = effectiveHwmCents > 0
    ? r2(((input.currentNavCents - lifelineNavCents) / effectiveHwmCents) * 100)
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
      hwm_cash_flow_adjustment_cents: hwmCashFlowAdjustmentCents,
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
    // 只有真新高（should_advance_hwm）才允许改写高水位锚点。现金流调整后的高水位只在内存中
    // 用于回撤计算；若把它写回旧 hwm_date，下一轮会把同一笔流水再叠加一次。
    const advance = router.should_advance_hwm ? 1 : 0;
    portfolioDb.prepare(`
      INSERT INTO account_risk_anchor (
        account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
        circuit_breaker_status, locked_until_trade_date, updated_at
      ) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET
        initial_principal_cents = excluded.initial_principal_cents,
        hwm_nav_cents = CASE
          WHEN ? = 1 AND excluded.hwm_nav_cents > account_risk_anchor.hwm_nav_cents AND excluded.hwm_date >= account_risk_anchor.hwm_date
          THEN excluded.hwm_nav_cents
          ELSE account_risk_anchor.hwm_nav_cents
        END,
        hwm_date = CASE
          WHEN ? = 1 AND excluded.hwm_nav_cents > account_risk_anchor.hwm_nav_cents AND excluded.hwm_date >= account_risk_anchor.hwm_date
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
