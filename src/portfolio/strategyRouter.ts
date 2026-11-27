import type { DatabaseSync } from 'node:sqlite';
import {
  REGIME_TARGET_EQUITY_BPS,
  type MarketRegimeResult,
  type MarketRegimeTier,
} from '../ashare/marketRegime.js';
import { readSnapshot } from './account.js';
import { portfolioTableExists } from './db.js';
import { buildNavSeries, readBaseline } from './ledger.js';
import { buildLedgerPriceTable } from './riskPolicy.js';
import { loadApprovedV3Policy, type ApprovedV3Policy } from './v3Policy.js';

export type CircuitBreakerStatus = 'NORMAL' | 'L1_WARN' | 'L2_LOCKED';
export type SubStrategyStatus = 'ACTIVE' | 'STOP_ONLY' | 'REDUCE_ONLY' | 'LOCKED_PENDING_VALIDATION';

export type DrawdownControlStage =
  | 'NORMAL'
  | 'STAGE1_CAP_50'
  | 'STAGE2_CAP_25'
  | 'CPPI_CAPPED'
  | 'L1_WARN'
  | 'L2_LOCKED';

export interface PersistedRiskAnchor {
  account_id: string;
  initial_principal_cents: number;
  hwm_nav_cents: number;
  hwm_date: string;
  /** 锚点建立时已把哪一天的当日流水折入高水位；同日重跑据此避免重复扣减。 */
  hwm_flows_applied_through: string | null;
  /** 锚点建立时已折入的当日外部净流入（分）。 */
  hwm_applied_same_day_flow_cents: number;
  /** 高水位口径：TOTAL = 迁移前含理财的总资产峰值；INVESTABLE = 现金+证券可投资净值。 */
  hwm_nav_scope: 'INVESTABLE' | 'TOTAL' | null;
  work_hwm_nav_cents?: number | null;
  work_hwm_date?: string | null;
  ramp_until_trade_date?: string | null;
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
  drawdown_control_mode: ApprovedV3Policy['drawdown_control_mode'];
  drawdown_control_stage: DrawdownControlStage;
  drawdown_equity_cap_bps: number | null;
  ramp_until_trade_date: string | null;
  ramp_factor_bps: number;
  locked_until_trade_date: string | null;
  just_unlocked: boolean;
  l2_trigger_drawdown_bps: number;
  post_breaker_equity_bps: number;
  deconcentration_preemptive_active: boolean;
  policy_version: string;
  should_advance_hwm: boolean;
  /** 单位新高、同日新流水重基或口径迁移时需要写库（即使名义峰值未创新高）。 */
  should_write_hwm: boolean;
  should_persist_anchor: boolean;
  anchor_snapshot: {
    initial_principal_cents: number;
    /** 展示口径 NAV（默认含理财 wealth），用于本金盈亏/回本展示。 */
    current_nav_cents: number;
    /** 风险/高水位口径 NAV（可投资净值），用于回撤与生命线缓冲。 */
    hwm_comparison_nav_cents: number;
    cumulative_pnl_cents: number;
    cumulative_return_pct: number;
    recovery_needed_pct: number;
    /** 展示用“当前份额下的等价高水位”。 */
    hwm_nav_cents: number;
    /** 峰日原始基准（写库值）；绝不把展示等价峰写回旧峰日。 */
    hwm_original_nav_cents: number;
    hwm_date: string;
    /** 工作高水位（v3.3.0 解锁再锚定后用于风控，全历史 true peak 仍严格保留在 hwm_nav_cents）。 */
    work_hwm_nav_cents: number;
    work_hwm_date: string;
    work_hwm_drawdown_bps: number;
    work_hwm_drawdown_pct: number;
    /** 锚点建立时已折入的当日流水日期与金额；同日重跑不会重复扣减。 */
    hwm_flows_applied_through: string | null;
    hwm_applied_same_day_flow_cents: number;
    /** hwm_date → asOf 的单位净值比（1 = 无真实盈亏；<1 = 回撤）。单位净值不可用时为 null。 */
    hwm_unit_nav_ratio: number | null;
    /** UNIT_NAV = 已按单位净值折算出入金；RAW_NAV = 缺少账本/估值，退化为名义净值比较。 */
    hwm_nav_basis: 'UNIT_NAV' | 'RAW_NAV';
    /** INVESTABLE = 现金+证券；TOTAL = 迁移前含理财的旧口径。 */
    hwm_nav_scope: 'INVESTABLE' | 'TOTAL';
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
    sector_pioneer_bps: number;
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
  /** 风险/高水位口径 NAV（可投资净值，通常为总资产 − 理财）。 */
  currentNavCents: number;
  /** 本金盈亏/回本展示口径 NAV（通常为含理财的总资产）；缺省时等于 currentNavCents。 */
  displayNavCents?: number;
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

function countOpenTradeDaysBetween(
  marketDb: DatabaseSync | null | undefined,
  fromDate: string,
  toDate: string,
): number {
  if (fromDate >= toDate) return 0;
  if (marketDb && portfolioTableExists(marketDb, 'trade_cal')) {
    const row = marketDb.prepare(
      'SELECT COUNT(*) AS n FROM trade_cal WHERE is_open = 1 AND cal_date > ? AND cal_date <= ?',
    ).get(fromDate, toDate) as { n?: number } | undefined;
    if (row && typeof row.n === 'number') return row.n;
  }
  const ms = Date.UTC(+toDate.slice(0, 4), +toDate.slice(4, 6) - 1, +toDate.slice(6, 8))
    - Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(4, 6) - 1, +fromDate.slice(6, 8));
  return Math.max(0, Math.round((ms / 86_400_000) / 1.48));
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

function readLastUnlockDate(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
): string | null {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_meta')) return null;
  try {
    const row = portfolioDb.prepare('SELECT value FROM account_meta WHERE key = ?')
      .get(`v3_last_unlock_date:${accountId}`) as { value?: string } | undefined;
    return row?.value ? String(row.value) : null;
  } catch {
    return null;
  }
}

export function readRiskAnchor(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
): PersistedRiskAnchor | null {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_risk_anchor')) return null;
  const cols = new Set(
    (portfolioDb.prepare('PRAGMA table_info(account_risk_anchor)').all() as Array<{ name?: string }>)
      .map(row => row.name)
      .filter((name): name is string => Boolean(name)),
  );
  // 迁移前建立的旧库（只读打开）还没有流水列或工作峰值列：按缺省/空值读取，写路径扩容后自然补齐。
  const flowCols = cols.has('hwm_flows_applied_through') && cols.has('hwm_applied_same_day_flow_cents');
  const scopeCol = cols.has('hwm_nav_scope');
  const workCols = cols.has('work_hwm_nav_cents') && cols.has('work_hwm_date') && cols.has('ramp_until_trade_date');
  const row = portfolioDb.prepare(
    `SELECT account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
       ${flowCols ? 'hwm_flows_applied_through, hwm_applied_same_day_flow_cents' : 'NULL AS hwm_flows_applied_through, 0 AS hwm_applied_same_day_flow_cents'},
       ${scopeCol ? 'hwm_nav_scope' : "'TOTAL' AS hwm_nav_scope"},
       ${workCols ? 'work_hwm_nav_cents, work_hwm_date, ramp_until_trade_date' : 'NULL AS work_hwm_nav_cents, NULL AS work_hwm_date, NULL AS ramp_until_trade_date'},
       circuit_breaker_status, locked_until_trade_date, updated_at
     FROM account_risk_anchor WHERE account_id = ?`,
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

/**
 * 读取指定日期的真实可投资资产（现金+证券）市值，用于把迁移前的 TOTAL 旧锚点按
 * “峰日真实基准”迁移。
 *
 * 只有**精确证据**才允许迁移：
 * - 峰日估值点 `confidence === 'exact'`（每个持仓当日都有真实价格）；或
 * - 峰日正好是账本基线快照日（用户导入的同日账户快照，可独立核实）。
 * `carried_forward`（沿用前日价）/`cost_fallback`（成本估价）/`no_price` 一律视为估计：
 * 返回 null，让调用方复用 TOTAL fallback，不改峰、不持久化估计值。
 */
function readInvestableValueAt(
  portfolioDb: DatabaseSync | null | undefined,
  marketDb: DatabaseSync | null | undefined,
  accountId: string,
  date: string,
): number | null {
  if (!portfolioDb) return null;
  try {
    const baseline = readBaseline(portfolioDb, accountId);
    if (!baseline || baseline.as_of > date) return null;
    // 峰日就是基线快照日：基线快照的现金+证券是用户导入的同日真实账户状态。
    if (baseline.as_of === date && baseline.snapshot_id) {
      const snapshot = readSnapshot(portfolioDb, baseline.snapshot_id);
      if (snapshot) {
        const investable = snapshot.totals.securities_mv_cents + snapshot.totals.cash_cents;
        if (Number.isSafeInteger(investable) && investable > 0) return investable;
      }
    }
    const prices = buildLedgerPriceTable(portfolioDb, marketDb ?? null, accountId, baseline.as_of, date);
    const series = buildNavSeries(portfolioDb, accountId, { from: date, to: date, prices });
    const point = series.points.find(item => item.date === date);
    if (!point || point.nav_per_unit === null) return null;
    // carried_forward / cost_fallback 也是非空 NAV，但它们是估计值，不能永久标成峰值。
    if (point.confidence !== 'exact') return null;
    return Number.isSafeInteger(point.total_value_cents) && point.total_value_cents > 0
      ? point.total_value_cents
      : null;
  } catch {
    return null;
  }
}

interface HwmEvaluation {
  /** 报告展示的“当前份额下的等价高水位”。 */
  effectiveHwmCents: number;
  /** 峰日原始基准（写库值）：绝不把展示等价峰写回旧峰日。 */
  originalHwmCents: number;
  effectiveHwmDate: string;
  /** 用于回撤/生命线缓冲的比较 NAV（同日新增流水场景下为扣除新增流水后的 NAV）。 */
  comparisonNavCents: number;
  flowsAppliedThrough: string | null;
  appliedSameDayFlowCents: number;
  /** 高水位口径：迁移前无证据的旧锚点为 TOTAL，其余为 INVESTABLE。 */
  hwmScope: 'INVESTABLE' | 'TOTAL';
  unitNavRatio: number | null;
  basis: 'UNIT_NAV' | 'RAW_NAV';
  shouldAdvanceHwm: boolean;
  /** 非单位新高、但检测到锚点未折入的新流水或真实口径迁移时，也必须写库。 */
  shouldWriteHwm: boolean;
  shouldPersistAnchor: boolean;
}

/**
 * 高水位判定：有账本基线与估值时按“单位份额折算后的净值比”比较（出入金不改变净值）。
 *
 * 迁移前的 TOTAL 旧锚点：
 * - 能从峰日快照/账本重建真实同日可投资资产时，按该真实基准迁移到 INVESTABLE，并只把
 *   **峰日原始基准**写回旧日期；展示等价峰（currentNav/ratio）绝不写回，避免二次折算。
 * - 缺证据时保留明确的 TOTAL 口径，按总资产原始峰做名义比较，绝不持久化估计值。
 *
 * 同日重跑：锚点记录已折入的当日净流水；检测到新增流水时按
 * `currentNav / (currentNav - incrementalFlow)` 重基持久名义峰并写库（即使不是单位新高），
 * 这样 D+1 buildNavSeries 不会把同一笔流水当成假回撤。
 */
function evaluateHwm(
  input: EvaluateStrategyRouterInput,
  existing: PersistedRiskAnchor | null,
): HwmEvaluation {
  const currentNav = input.currentNavCents;
  const currentTotal = input.displayNavCents ?? input.currentNavCents;

  if (!existing) {
    const sameDayFlow = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
    const initial = Math.max(input.fallbackBaselineNavCents ?? currentNav, currentNav);
    return {
      effectiveHwmCents: initial,
      originalHwmCents: initial,
      effectiveHwmDate: input.asOf,
      comparisonNavCents: currentNav,
      flowsAppliedThrough: input.asOf,
      appliedSameDayFlowCents: sameDayFlow,
      hwmScope: 'INVESTABLE',
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: true,
      shouldWriteHwm: true,
      shouldPersistAnchor: true,
    };
  }

  const legacyScope = existing.hwm_nav_scope !== 'INVESTABLE';
  const investablePeakCents = legacyScope
    ? readInvestableValueAt(input.portfolioDb, input.marketDb, input.accountId, existing.hwm_date)
    : null;
  const legacyFallback = legacyScope && (investablePeakCents === null || investablePeakCents <= 0);
  const baseHwmCents = legacyFallback ? existing.hwm_nav_cents : (legacyScope ? investablePeakCents! : existing.hwm_nav_cents);
  const migrationWrite = legacyScope && !legacyFallback;

  // ---- 无峰日可投资证据：保留 TOTAL 口径，按总资产原始峰比较；只允许同日流水的真实重基。
  if (legacyFallback) {
    if (existing.hwm_date === input.asOf) {
      const sameDayFlowCents = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
      const appliedAtAnchorCents = existing.hwm_flows_applied_through === input.asOf
        ? existing.hwm_applied_same_day_flow_cents
        : 0;
      const incrementalFlowCents = sameDayFlowCents - appliedAtAnchorCents;
      const preIncrementalTotalCents = currentTotal - incrementalFlowCents;
      if (incrementalFlowCents !== 0 && baseHwmCents > 0 && preIncrementalTotalCents > 0) {
        const rebased = Math.round(baseHwmCents * currentTotal / preIncrementalTotalCents);
        return {
          effectiveHwmCents: rebased,
          originalHwmCents: rebased,
          effectiveHwmDate: input.asOf,
          comparisonNavCents: currentTotal,
          flowsAppliedThrough: input.asOf,
          appliedSameDayFlowCents: sameDayFlowCents,
          hwmScope: 'TOTAL',
          unitNavRatio: null,
          basis: 'RAW_NAV',
          shouldAdvanceHwm: false,
          shouldWriteHwm: true,
          shouldPersistAnchor: true,
        };
      }
      return {
        effectiveHwmCents: baseHwmCents,
        originalHwmCents: baseHwmCents,
        effectiveHwmDate: existing.hwm_date,
        comparisonNavCents: preIncrementalTotalCents,
        flowsAppliedThrough: existing.hwm_flows_applied_through,
        appliedSameDayFlowCents: existing.hwm_applied_same_day_flow_cents,
        hwmScope: 'TOTAL',
        unitNavRatio: null,
        basis: 'RAW_NAV',
        shouldAdvanceHwm: false,
        shouldWriteHwm: false,
        shouldPersistAnchor: true,
      };
    }
    return {
      effectiveHwmCents: baseHwmCents,
      originalHwmCents: baseHwmCents,
      effectiveHwmDate: existing.hwm_date,
      comparisonNavCents: currentTotal,
      flowsAppliedThrough: existing.hwm_flows_applied_through,
      appliedSameDayFlowCents: existing.hwm_applied_same_day_flow_cents,
      hwmScope: 'TOTAL',
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: false,
      shouldWriteHwm: false,
      shouldPersistAnchor: input.asOf >= existing.hwm_date,
    };
  }

  // ---- 可投资口径：新锚点，或已由峰日真实基准迁移的旧锚点。
  const shares = readUnitSharePair(input.portfolioDb, input.marketDb, input.accountId, existing.hwm_date, input.asOf);
  if (shares && baseHwmCents > 0) {
    const ratio = (currentNav / baseHwmCents) * (shares.from_units / shares.to_units);
    if (input.asOf >= existing.hwm_date && ratio > 1 + 1e-6) {
      const sameDayFlow = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
      return {
        effectiveHwmCents: currentNav,
        originalHwmCents: currentNav,
        effectiveHwmDate: input.asOf,
        comparisonNavCents: currentNav,
        flowsAppliedThrough: input.asOf,
        appliedSameDayFlowCents: sameDayFlow,
        hwmScope: 'INVESTABLE',
        unitNavRatio: ratio,
        basis: 'UNIT_NAV',
        shouldAdvanceHwm: true,
        shouldWriteHwm: true,
        shouldPersistAnchor: true,
      };
    }
    return {
      effectiveHwmCents: Math.round(currentNav / ratio),
      originalHwmCents: baseHwmCents,
      effectiveHwmDate: existing.hwm_date,
      comparisonNavCents: currentNav,
      flowsAppliedThrough: existing.hwm_flows_applied_through,
      appliedSameDayFlowCents: existing.hwm_applied_same_day_flow_cents,
      hwmScope: 'INVESTABLE',
      unitNavRatio: ratio,
      basis: 'UNIT_NAV',
      shouldAdvanceHwm: false,
      shouldWriteHwm: migrationWrite,
      shouldPersistAnchor: input.asOf >= existing.hwm_date,
    };
  }

  if (existing.hwm_date === input.asOf) {
    const sameDayFlowCents = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
    const appliedAtAnchorCents = existing.hwm_flows_applied_through === input.asOf
      ? existing.hwm_applied_same_day_flow_cents
      : 0;
    const incrementalFlowCents = sameDayFlowCents - appliedAtAnchorCents;
    const preIncrementalNavCents = currentNav - incrementalFlowCents;

    if (preIncrementalNavCents > baseHwmCents) {
      return {
        effectiveHwmCents: currentNav,
        originalHwmCents: currentNav,
        effectiveHwmDate: input.asOf,
        comparisonNavCents: currentNav,
        flowsAppliedThrough: input.asOf,
        appliedSameDayFlowCents: sameDayFlowCents,
        hwmScope: 'INVESTABLE',
        unitNavRatio: null,
        basis: 'RAW_NAV',
        shouldAdvanceHwm: true,
        shouldWriteHwm: true,
        shouldPersistAnchor: true,
      };
    }

    if (incrementalFlowCents !== 0 && baseHwmCents > 0 && preIncrementalNavCents > 0) {
      const rebasedHwmCents = Math.round(baseHwmCents * currentNav / preIncrementalNavCents);
      return {
        effectiveHwmCents: rebasedHwmCents,
        originalHwmCents: rebasedHwmCents,
        effectiveHwmDate: input.asOf,
        comparisonNavCents: currentNav,
        flowsAppliedThrough: input.asOf,
        appliedSameDayFlowCents: sameDayFlowCents,
        hwmScope: 'INVESTABLE',
        unitNavRatio: rebasedHwmCents > 0 ? currentNav / rebasedHwmCents : null,
        basis: 'RAW_NAV',
        shouldAdvanceHwm: false,
        shouldWriteHwm: true,
        shouldPersistAnchor: true,
      };
    }

    return {
      effectiveHwmCents: baseHwmCents,
      originalHwmCents: baseHwmCents,
      effectiveHwmDate: existing.hwm_date,
      comparisonNavCents: preIncrementalNavCents,
      flowsAppliedThrough: existing.hwm_flows_applied_through,
      appliedSameDayFlowCents: existing.hwm_applied_same_day_flow_cents,
      hwmScope: 'INVESTABLE',
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: false,
      shouldWriteHwm: migrationWrite,
      shouldPersistAnchor: true,
    };
  }

  if (input.asOf >= existing.hwm_date && currentNav > baseHwmCents) {
    const sameDayFlow = readSameDayNetExternalFlowCents(input.portfolioDb, input.accountId, input.asOf);
    return {
      effectiveHwmCents: currentNav,
      originalHwmCents: currentNav,
      effectiveHwmDate: input.asOf,
      comparisonNavCents: currentNav,
      flowsAppliedThrough: input.asOf,
      appliedSameDayFlowCents: sameDayFlow,
      hwmScope: 'INVESTABLE',
      unitNavRatio: null,
      basis: 'RAW_NAV',
      shouldAdvanceHwm: true,
      shouldWriteHwm: true,
      shouldPersistAnchor: true,
    };
  }
  return {
    effectiveHwmCents: baseHwmCents,
    originalHwmCents: baseHwmCents,
    effectiveHwmDate: existing.hwm_date,
    comparisonNavCents: currentNav,
    flowsAppliedThrough: existing.hwm_flows_applied_through,
    appliedSameDayFlowCents: existing.hwm_applied_same_day_flow_cents,
    hwmScope: 'INVESTABLE',
    unitNavRatio: null,
    basis: 'RAW_NAV',
    shouldAdvanceHwm: false,
    shouldWriteHwm: migrationWrite,
    shouldPersistAnchor: input.asOf >= existing.hwm_date,
  };
}

function fmtPct(v: number): string {
  return Math.round(v * 10) % 10 === 0 ? v.toFixed(0) : v.toFixed(1);
}

function targetBucketsFor(
  regime: MarketRegimeTier,
  policy: ApprovedV3Policy,
  bp1Allowed: boolean,
): StrategyRouterResult['targets'] {
  const isV32Legacy = !policy.sector_pioneer_enabled
    && policy.stock_bp1_min_investable_nav_cny === 0
    && !policy.stock_bp1_block_during_deconcentration;
  if (isV32Legacy) {
    if (regime === 'OFFENSIVE') {
      return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.OFFENSIVE, base_super_etf_bps: 3750, pioneer_bps: 4750, sector_pioneer_bps: 0, defensive_cash_bps: 1500 };
    }
    if (regime === 'STRUCTURAL') {
      return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.STRUCTURAL, base_super_etf_bps: 2500, pioneer_bps: 3500, sector_pioneer_bps: 0, defensive_cash_bps: 4000 };
    }
    if (regime === 'RECOVERY') {
      const rec = policy.recovery_equity_bps;
      return { target_equity_bps: rec, base_super_etf_bps: rec, pioneer_bps: 0, sector_pioneer_bps: 0, defensive_cash_bps: 10000 - rec };
    }
    return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.DEFENSIVE, base_super_etf_bps: 1500, pioneer_bps: 0, sector_pioneer_bps: 0, defensive_cash_bps: 8500 };
  }

  if (regime === 'DEFENSIVE') {
    return { target_equity_bps: REGIME_TARGET_EQUITY_BPS.DEFENSIVE, base_super_etf_bps: 1500, pioneer_bps: 0, sector_pioneer_bps: 0, defensive_cash_bps: 8500 };
  }
  if (regime === 'RECOVERY') {
    const rec = policy.recovery_equity_bps;
    return { target_equity_bps: rec, base_super_etf_bps: rec, pioneer_bps: 0, sector_pioneer_bps: 0, defensive_cash_bps: 10000 - rec };
  }
  const sec = policy.sector_pioneer_enabled ? Math.min(policy.sector_pioneer_max_weight_bps, 2000) : 0;
  if (regime === 'OFFENSIVE') {
    const stock = bp1Allowed ? 3500 : 0;
    return {
      target_equity_bps: REGIME_TARGET_EQUITY_BPS.OFFENSIVE,
      base_super_etf_bps: 8500 - sec - stock,
      pioneer_bps: stock,
      sector_pioneer_bps: sec,
      defensive_cash_bps: 1500,
    };
  }
  const stock = bp1Allowed ? 2000 : 0;
  return {
    target_equity_bps: REGIME_TARGET_EQUITY_BPS.STRUCTURAL,
    base_super_etf_bps: 6000 - sec - stock,
    pioneer_bps: stock,
    sector_pioneer_bps: sec,
    defensive_cash_bps: 4000,
  };
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
  // 风险/HWM 用可投资净值；本金盈亏/回本展示用含理财的总资产（displayNavCents）。
  const displayNavCents = input.displayNavCents ?? input.currentNavCents;

  const v3Policy = input.policy ?? loadApprovedV3Policy({ accountId: input.accountId, asOf: input.asOf });
  const deconcActive = v3Policy.deconcentration_plan_enabled ? Boolean(input.deconcentrationActive) : false;
  const l2TriggerBps = deconcActive
    ? v3Policy.l2_preemptive_deconcentration_trigger_drawdown_bps
    : v3Policy.l2_normal_trigger_drawdown_bps;
  const postBreakerEquityBps = deconcActive
    ? v3Policy.l2_deconcentration_post_breaker_equity_bps
    : v3Policy.l2_normal_post_breaker_equity_bps;
  const l2TriggerPct = l2TriggerBps / 100;

  const cumulativePnlCents = displayNavCents - initialPrincipalCents;
  const cumulativeReturnPct = initialPrincipalCents > 0
    ? r2(((displayNavCents / initialPrincipalCents) - 1) * 100)
    : 0;
  const recoveryNeededPct = displayNavCents > 0 && displayNavCents < initialPrincipalCents
    ? r2(((initialPrincipalCents - displayNavCents) / displayNavCents) * 100)
    : 0;

  const hwmDrawdownBps = effectiveHwmCents > 0
    ? Math.max(0, Math.round(((effectiveHwmCents - comparisonNavCents) / effectiveHwmCents) * 10000))
    : 0;
  const hwmDrawdownPct = r2(hwmDrawdownBps / 100);

  const existingLockActive = Boolean(
    existing
    && input.asOf >= existing.updated_at
    && existing.circuit_breaker_status === 'L2_LOCKED'
    && existing.locked_until_trade_date
    && existing.locked_until_trade_date >= input.asOf,
  );
  const rawJustUnlocked = Boolean(
    existing
    && input.asOf >= existing.updated_at
    && existing.circuit_breaker_status === 'L2_LOCKED'
    && existing.locked_until_trade_date
    && existing.locked_until_trade_date < input.asOf,
  );
  const lastUnlockDate = readLastUnlockDate(input.portfolioDb, input.accountId);
  const justUnlocked = rawJustUnlocked || lastUnlockDate === input.asOf;

  // 工作高水位（v3.3.0 解锁再锚定）；全历史 true_peak 仍严格保留在 effectiveHwmCents/effectiveHwmDate。
  let workHwmNavCents = effectiveHwmCents;
  let workHwmDate = effectiveHwmDate;
  let rampUntilTradeDate: string | null = null;
  if (v3Policy.drawdown_control_mode !== 'HARD_STEP_LOCK') {
    if (existing && (existing.work_hwm_nav_cents == null || !existing.work_hwm_date)) {
      shouldPersistAnchor = true;
    }
    if (rawJustUnlocked && v3Policy.drawdown_unlock_reanchor_enabled) {
      workHwmNavCents = comparisonNavCents;
      workHwmDate = input.asOf;
      rampUntilTradeDate = v3Policy.drawdown_unlock_ramp_trade_days > 0
        ? nextOpenTradeDayAfterN(input.marketDb, input.asOf, v3Policy.drawdown_unlock_ramp_trade_days)
        : null;
      shouldPersistAnchor = true;
    } else {
      rampUntilTradeDate = existing?.ramp_until_trade_date && existing.ramp_until_trade_date >= input.asOf
        ? existing.ramp_until_trade_date
        : null;
      const baseWork = existing?.work_hwm_nav_cents && existing.work_hwm_nav_cents > 0
        ? existing.work_hwm_nav_cents
        : effectiveHwmCents;
      const baseWorkDate = existing?.work_hwm_date ?? effectiveHwmDate;
      const workShares = readUnitSharePair(input.portfolioDb, input.marketDb, input.accountId, baseWorkDate, input.asOf);
      if (workShares && baseWork > 0) {
        const wRatio = (comparisonNavCents / baseWork) * (workShares.from_units / workShares.to_units);
        if (input.asOf >= baseWorkDate && wRatio > 1 + 1e-6) {
          workHwmNavCents = comparisonNavCents;
          workHwmDate = input.asOf;
          shouldPersistAnchor = true;
        } else {
          workHwmNavCents = Math.round(comparisonNavCents / wRatio);
          workHwmDate = baseWorkDate;
        }
      } else if (input.asOf >= baseWorkDate && comparisonNavCents > baseWork) {
        workHwmNavCents = comparisonNavCents;
        workHwmDate = input.asOf;
        shouldPersistAnchor = true;
      } else {
        workHwmNavCents = baseWork;
        workHwmDate = baseWorkDate;
      }
    }
  }
  const workHwmDrawdownBps = workHwmNavCents > 0
    ? Math.max(0, Math.round(((workHwmNavCents - comparisonNavCents) / workHwmNavCents) * 10000))
    : 0;
  const workHwmDrawdownPct = r2(workHwmDrawdownBps / 100);

  const lifelineRefHwmCents = v3Policy.drawdown_control_mode === 'HARD_STEP_LOCK' ? effectiveHwmCents : workHwmNavCents;
  const lifelineNavCents = Math.round(lifelineRefHwmCents * (10000 - l2TriggerBps) / 10000);
  const lifelineBufferCents = comparisonNavCents - lifelineNavCents;
  const lifelineBufferPct = lifelineRefHwmCents > 0
    ? r2(((comparisonNavCents - lifelineNavCents) / lifelineRefHwmCents) * 100)
    : 0;

  let circuitBreakerStatus: CircuitBreakerStatus = 'NORMAL';
  let drawdownControlStage: DrawdownControlStage = 'NORMAL';
  let drawdownEquityCapBps: number | null = null;
  let lockedUntil: string | null = null;

  if (existingLockActive) {
    circuitBreakerStatus = 'L2_LOCKED';
    drawdownControlStage = 'L2_LOCKED';
    lockedUntil = existing!.locked_until_trade_date;
  } else if (v3Policy.drawdown_control_mode === 'TWO_STAGE_GRADUAL') {
    if (workHwmDrawdownBps >= l2TriggerBps) {
      circuitBreakerStatus = 'L2_LOCKED';
      drawdownControlStage = 'L2_LOCKED';
      lockedUntil = nextOpenTradeDayAfterN(input.marketDb, input.asOf, v3Policy.l2_lock_trade_days);
      rampUntilTradeDate = null;
      shouldPersistAnchor = true;
    } else if (workHwmDrawdownBps >= v3Policy.drawdown_stage2_bps) {
      circuitBreakerStatus = 'L1_WARN';
      drawdownControlStage = 'STAGE2_CAP_25';
      drawdownEquityCapBps = v3Policy.drawdown_stage2_cap_bps;
      if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
    } else if (workHwmDrawdownBps >= v3Policy.drawdown_stage1_bps) {
      circuitBreakerStatus = 'L1_WARN';
      drawdownControlStage = 'STAGE1_CAP_50';
      drawdownEquityCapBps = v3Policy.drawdown_stage1_cap_bps;
      if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
    }
  } else if (v3Policy.drawdown_control_mode === 'CPPI_F15_M5') {
    if (workHwmDrawdownBps >= l2TriggerBps) {
      circuitBreakerStatus = 'L2_LOCKED';
      drawdownControlStage = 'L2_LOCKED';
      lockedUntil = nextOpenTradeDayAfterN(input.marketDb, input.asOf, v3Policy.l2_lock_trade_days);
      rampUntilTradeDate = null;
      shouldPersistAnchor = true;
    } else {
      const cushion = Math.max(0, 1 - 0.85 / Math.max(0.01, 1 - workHwmDrawdownBps / 10000));
      const cppiCap = Math.min(8500, Math.max(0, Math.round(cushion * 5 * 10000)));
      if (workHwmDrawdownBps >= v3Policy.l1_warn_drawdown_bps || cppiCap < 8500) {
        drawdownEquityCapBps = cppiCap;
        if (workHwmDrawdownBps >= v3Policy.l1_warn_drawdown_bps) {
          circuitBreakerStatus = 'L1_WARN';
          drawdownControlStage = 'CPPI_CAPPED';
        }
      }
    }
  } else {
    if (hwmDrawdownBps >= l2TriggerBps) {
      circuitBreakerStatus = 'L2_LOCKED';
      drawdownControlStage = 'L2_LOCKED';
      lockedUntil = nextOpenTradeDayAfterN(input.marketDb, input.asOf, v3Policy.l2_lock_trade_days);
      if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
    } else if (hwmDrawdownBps >= v3Policy.l1_warn_drawdown_bps) {
      circuitBreakerStatus = 'L1_WARN';
      drawdownControlStage = 'L1_WARN';
      if (existing && input.asOf >= existing.hwm_date) shouldPersistAnchor = true;
    }
  }

  let rampFactorBps = 10000;
  if (
    v3Policy.drawdown_control_mode !== 'HARD_STEP_LOCK'
    && circuitBreakerStatus !== 'L2_LOCKED'
    && rampUntilTradeDate
    && rampUntilTradeDate >= input.asOf
    && v3Policy.drawdown_unlock_ramp_trade_days > 0
  ) {
    const remaining = countOpenTradeDaysBetween(input.marketDb, input.asOf, rampUntilTradeDate);
    const total = v3Policy.drawdown_unlock_ramp_trade_days;
    const elapsed = Math.max(0, total - remaining);
    rampFactorBps = Math.min(10000, Math.max(5000, Math.round(5000 + 5000 * (elapsed / total))));
  }

  const bp1CapitalOk = comparisonNavCents >= v3Policy.stock_bp1_min_investable_nav_cny * 100;
  const bp1DeconcOk = !(v3Policy.stock_bp1_block_during_deconcentration && deconcActive);
  const bp1Allowed = bp1CapitalOk && bp1DeconcOk;

  const effectiveRegime: MarketRegimeTier = circuitBreakerStatus === 'L2_LOCKED'
    ? 'DEFENSIVE'
    : input.marketRegime.regime;
  const targets: StrategyRouterResult['targets'] = circuitBreakerStatus === 'L2_LOCKED'
    ? {
        target_equity_bps: postBreakerEquityBps,
        base_super_etf_bps: postBreakerEquityBps,
        pioneer_bps: 0,
        sector_pioneer_bps: 0,
        defensive_cash_bps: 10000 - postBreakerEquityBps,
      }
    : targetBucketsFor(effectiveRegime, v3Policy, bp1Allowed);

  if (circuitBreakerStatus !== 'L2_LOCKED') {
    let capBps = targets.target_equity_bps;
    if (drawdownEquityCapBps !== null) capBps = Math.min(capBps, drawdownEquityCapBps);
    if (rampFactorBps < 10000) capBps = Math.min(capBps, Math.round(targets.target_equity_bps * rampFactorBps / 10000));
    if (capBps < targets.target_equity_bps) {
      if (circuitBreakerStatus === 'L1_WARN') {
        const secCap = drawdownControlStage === 'STAGE2_CAP_25'
          ? 0
          : Math.min(targets.sector_pioneer_bps, Math.floor(capBps * 0.25));
        targets.pioneer_bps = 0;
        targets.sector_pioneer_bps = secCap;
        targets.base_super_etf_bps = Math.max(0, capBps - secCap);
      } else {
        const scale = targets.target_equity_bps > 0 ? capBps / targets.target_equity_bps : 0;
        const scaledSec = Math.round(targets.sector_pioneer_bps * scale);
        const scaledStock = Math.round(targets.pioneer_bps * scale);
        targets.sector_pioneer_bps = scaledSec;
        targets.pioneer_bps = scaledStock;
        targets.base_super_etf_bps = Math.max(0, capBps - scaledSec - scaledStock);
      }
      targets.target_equity_bps = capBps;
      targets.defensive_cash_bps = 10000 - capBps;
    }
  }

  const phase1Lock = input.phase1LockStockSwing ?? !v3Policy.approved;
  const sDeconcentrate: SubStrategyStatus = 'ACTIVE';
  const sBaseSuperEtf: SubStrategyStatus = circuitBreakerStatus === 'L2_LOCKED' ? 'REDUCE_ONLY' : 'ACTIVE';
  let sStockSwing: SubStrategyStatus = 'ACTIVE';
  if (
    circuitBreakerStatus !== 'NORMAL'
    || effectiveRegime === 'DEFENSIVE'
    || effectiveRegime === 'RECOVERY'
    || !bp1Allowed
  ) {
    sStockSwing = 'STOP_ONLY';
  } else if (phase1Lock) {
    sStockSwing = 'LOCKED_PENDING_VALIDATION';
  }

  const l2PctText = fmtPct(l2TriggerPct);
  const l1PctText = fmtPct(v3Policy.l1_warn_drawdown_bps / 100);
  const breakerLabelZh = circuitBreakerStatus === 'L2_LOCKED'
    ? deconcActive
      ? `二级熔断锁定（重仓换马期回撤达 ${l2PctText}% 前置保护触发，风险权益清零防守至 ${lockedUntil}）`
      : `二级熔断锁定（高水位回撤达 ${l2PctText}%，防守冷静期至 ${lockedUntil}）`
    : circuitBreakerStatus === 'L1_WARN'
      ? drawdownControlStage === 'STAGE2_CAP_25'
        ? `二级渐进警戒（工作高水位回撤超 ${fmtPct(v3Policy.drawdown_stage2_bps / 100)}%，权益上限收紧至 ${(drawdownEquityCapBps! / 100).toFixed(0)}%，冻结个股新开仓）`
        : drawdownControlStage === 'STAGE1_CAP_50'
          ? `一级渐进警戒（工作高水位回撤超 ${fmtPct(v3Policy.drawdown_stage1_bps / 100)}%，权益上限收紧至 ${(drawdownEquityCapBps! / 100).toFixed(0)}%，冻结个股新开仓）`
          : `一级回撤警戒（高水位回撤超 ${l1PctText}%，冻结个股新开仓）`
      : rampFactorBps < 10000
        ? `解锁爬坡受控（解除熔断后 10 日线性恢复期，权益系数 ${(rampFactorBps / 100).toFixed(0)}%，守卫 ${l2PctText}% 生命线）`
        : deconcActive
          ? `正常受控（重仓换马期启用 ${l2PctText}% 前置熔断保护，守卫 ${l2PctText}% 生命线）`
          : `正常受控（位于 ${l2PctText}% 熔断生命线之上）`;

  const stockSwingLabelZh = sStockSwing === 'STOP_ONLY'
    ? !bp1DeconcOk && circuitBreakerStatus === 'NORMAL' && effectiveRegime !== 'DEFENSIVE' && effectiveRegime !== 'RECOVERY'
      ? '存量重仓换马未完成前由超级行业主题指数基金先导替代，个股仅允许存量止损或止盈'
      : !bp1CapitalOk && circuitBreakerStatus === 'NORMAL' && effectiveRegime !== 'DEFENSIVE' && effectiveRegime !== 'RECOVERY'
        ? '可投资净值未满 10 万元门槛，暂由超级行业主题指数基金先导替代，个股仅允许存量止损或止盈'
        : '仅允许执行存量止损或止盈，禁止新开仓'
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
    drawdown_control_mode: v3Policy.drawdown_control_mode,
    drawdown_control_stage: drawdownControlStage,
    drawdown_equity_cap_bps: drawdownEquityCapBps,
    ramp_until_trade_date: rampUntilTradeDate,
    ramp_factor_bps: rampFactorBps,
    locked_until_trade_date: lockedUntil,
    just_unlocked: justUnlocked,
    l2_trigger_drawdown_bps: l2TriggerBps,
    post_breaker_equity_bps: postBreakerEquityBps,
    deconcentration_preemptive_active: deconcActive,
    policy_version: v3Policy.version,
    should_advance_hwm: shouldAdvanceHwm,
    should_write_hwm: hwm.shouldWriteHwm,
    should_persist_anchor: shouldPersistAnchor,
    anchor_snapshot: {
      initial_principal_cents: initialPrincipalCents,
      current_nav_cents: displayNavCents,
      hwm_comparison_nav_cents: comparisonNavCents,
      cumulative_pnl_cents: cumulativePnlCents,
      cumulative_return_pct: cumulativeReturnPct,
      recovery_needed_pct: recoveryNeededPct,
      hwm_nav_cents: effectiveHwmCents,
      hwm_original_nav_cents: hwm.originalHwmCents,
      hwm_date: effectiveHwmDate,
      work_hwm_nav_cents: workHwmNavCents,
      work_hwm_date: workHwmDate,
      work_hwm_drawdown_bps: workHwmDrawdownBps,
      work_hwm_drawdown_pct: workHwmDrawdownPct,
      hwm_flows_applied_through: hwm.flowsAppliedThrough,
      hwm_applied_same_day_flow_cents: hwm.appliedSameDayFlowCents,
      hwm_unit_nav_ratio: unitNavRatio,
      hwm_nav_basis: navBasis,
      hwm_nav_scope: hwm.hwmScope,
      hwm_drawdown_bps: hwmDrawdownBps,
      hwm_drawdown_pct: hwmDrawdownPct,
      lifeline_nav_cents: lifelineNavCents,
      lifeline_buffer_cents: lifelineBufferCents,
      lifeline_buffer_pct: lifelineBufferPct,
    },
    targets,
    sub_strategies: {
      s_deconcentrate: v3Policy.deconcentration_plan_enabled ? sDeconcentrate : 'STOP_ONLY',
      s_base_super_etf: sBaseSuperEtf,
      s_stock_swing: sStockSwing,
    },
    sub_strategies_zh: {
      deconcentrate_label: !v3Policy.deconcentration_plan_enabled
        ? '存量降浓状态机：已停用（由组合双向目标对齐统一管理）'
        : input.deconcentrationMode === 'BOTTOM_GRIND_25'
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
    const cols = new Set(
      (portfolioDb.prepare('PRAGMA table_info(account_risk_anchor)').all() as Array<{ name?: string }>)
        .map(row => row.name)
        .filter((name): name is string => Boolean(name)),
    );
    const hasWorkCols = cols.has('work_hwm_nav_cents')
      && cols.has('work_hwm_date')
      && cols.has('ramp_until_trade_date');
    // 单位新高、同日新流水重基或旧口径迁移都允许改写高水位锚点；名义大小不是写入条件
    // （出金后单位新高 70 -> 63 名义更低，也要落库）。
    const writeHwm = router.should_write_hwm ? 1 : 0;
    if (hasWorkCols) {
      portfolioDb.prepare(`
        INSERT INTO account_risk_anchor (
          account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
          hwm_flows_applied_through, hwm_applied_same_day_flow_cents, hwm_nav_scope,
          work_hwm_nav_cents, work_hwm_date, ramp_until_trade_date,
          circuit_breaker_status, locked_until_trade_date, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
          hwm_flows_applied_through = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_flows_applied_through
            ELSE account_risk_anchor.hwm_flows_applied_through
          END,
          hwm_applied_same_day_flow_cents = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_applied_same_day_flow_cents
            ELSE account_risk_anchor.hwm_applied_same_day_flow_cents
          END,
          hwm_nav_scope = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_nav_scope
            ELSE account_risk_anchor.hwm_nav_scope
          END,
          work_hwm_nav_cents = excluded.work_hwm_nav_cents,
          work_hwm_date = excluded.work_hwm_date,
          ramp_until_trade_date = excluded.ramp_until_trade_date,
          circuit_breaker_status = excluded.circuit_breaker_status,
          locked_until_trade_date = excluded.locked_until_trade_date,
          updated_at = excluded.updated_at
      `).run(
        router.account_id,
        router.anchor_snapshot.initial_principal_cents,
        router.anchor_snapshot.hwm_original_nav_cents,
        router.anchor_snapshot.hwm_date,
        router.anchor_snapshot.hwm_flows_applied_through,
        router.anchor_snapshot.hwm_applied_same_day_flow_cents,
        router.anchor_snapshot.hwm_nav_scope,
        router.anchor_snapshot.work_hwm_nav_cents,
        router.anchor_snapshot.work_hwm_date,
        router.ramp_until_trade_date,
        router.circuit_breaker_status,
        router.locked_until_trade_date,
        router.as_of_trade_date,
        writeHwm,
        writeHwm,
        writeHwm,
        writeHwm,
        writeHwm,
      );
    } else {
      portfolioDb.prepare(`
        INSERT INTO account_risk_anchor (
          account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
          hwm_flows_applied_through, hwm_applied_same_day_flow_cents, hwm_nav_scope,
          circuit_breaker_status, locked_until_trade_date, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
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
          hwm_flows_applied_through = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_flows_applied_through
            ELSE account_risk_anchor.hwm_flows_applied_through
          END,
          hwm_applied_same_day_flow_cents = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_applied_same_day_flow_cents
            ELSE account_risk_anchor.hwm_applied_same_day_flow_cents
          END,
          hwm_nav_scope = CASE
            WHEN ? = 1 AND excluded.hwm_date >= account_risk_anchor.hwm_date
            THEN excluded.hwm_nav_scope
            ELSE account_risk_anchor.hwm_nav_scope
          END,
          circuit_breaker_status = excluded.circuit_breaker_status,
          locked_until_trade_date = excluded.locked_until_trade_date,
          updated_at = excluded.updated_at
      `).run(
        router.account_id,
        router.anchor_snapshot.initial_principal_cents,
        router.anchor_snapshot.hwm_original_nav_cents,
        router.anchor_snapshot.hwm_date,
        router.anchor_snapshot.hwm_flows_applied_through,
        router.anchor_snapshot.hwm_applied_same_day_flow_cents,
        router.anchor_snapshot.hwm_nav_scope,
        router.circuit_breaker_status,
        router.locked_until_trade_date,
        router.as_of_trade_date,
        writeHwm,
        writeHwm,
        writeHwm,
        writeHwm,
        writeHwm,
      );
    }
    if (router.just_unlocked && portfolioTableExists(portfolioDb, 'account_meta')) {
      portfolioDb.prepare(
        'INSERT INTO account_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(`v3_last_unlock_date:${router.account_id}`, router.as_of_trade_date);
    }
    return true;
  } catch (err: any) {
    if (String(err?.message ?? err).includes('readonly')) return false;
    throw err;
  }
}
