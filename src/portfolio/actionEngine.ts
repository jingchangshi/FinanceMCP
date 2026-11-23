import type { DatabaseSync } from 'node:sqlite';
import { EASTMONEY_SUPER_ETF_CODES, ETF_CANDIDATE_DECLARATIONS } from '../ashare/etfDeclarations.js';
import type { EtfCandidateRow, EtfCandidateScreenResult } from '../ashare/etfUniverse.js';
import {
  evaluateMarketRegime,
  type MarketRegimeResult,
  type MarketStyleTier,
} from '../ashare/marketRegime.js';
import {
  screenStockSwingCandidates,
  type StockSwingCandidate,
  type StockSwingScreenResult,
} from '../ashare/stockSwingScreener.js';
import { portfolioTableExists } from './db.js';
import {
  evaluateDeconcentrationPlan,
  persistDeconcentrationUpdates,
  type DeconcentrationEvaluation,
  type DeconcentrationPlanMode,
} from './deconcentrationPlan.js';
import { calculateFees, resolveFeeRules } from './fees.js';
import { isEtfCode } from './ledger.js';
import { inferBoard, tradabilityOf } from './rules.js';
import {
  evaluateStrategyRouter,
  persistRiskAnchor,
  type StrategyRouterResult,
} from './strategyRouter.js';
import { loadApprovedV3Policy } from './v3Policy.js';

export interface StopTrackerRow {
  account_id: string;
  ts_code: string;
  entry_date: string;
  entry_price_milli: number;
  initial_stop_milli: number;
  current_stop_milli: number;
  trailing_ma20_armed: number;
  /** As-of adj_factor 基准；NULL = 历史未记录（不缩放，并在下次运行补写）。 */
  entry_adj_factor: number | null;
  status: 'OPEN' | 'CLOSED';
  updated_at: string;
}

export interface ActionEngineLeg {
  side: 'SELL' | 'BUY';
  ts_code: string;
  name: string | null;
  quantity: number;
  lot_size: number;
  lots: number;
  price_milli: number;
  gross_cents: number;
  fees_cents: number;
  net_cents: number;
  quote_trade_date: string | null;
  executable: boolean;
  reason: string | null;
}

export interface ActionEnginePlan {
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  code: string;
  kind: 'REDUCE' | 'ROTATE' | 'ADD';
  rank: number;
  title: string;
  reasons: string[];
  counter_evidence: string[];
  legs: ActionEngineLeg[];
  fees_cents: number;
  fees_estimated: boolean;
  triggers: string[];
  invalidation_conditions: string[];
  risk_impact: string[];
}

export interface SuperEtfCandidateView {
  ts_code: string;
  name: string;
  category: string;
  close_cny: number | null;
  unit_nav: number | null;
  premium_bps: number | null;
  premium_pct: number | null;
  buy_blocked: boolean;
  score: number | null;
  fee_label_zh: string;
  style_match_zh: string;
}

export interface CrossBorderMonitorView {
  ts_code: string;
  name: string;
  close_cny: number | null;
  unit_nav: number | null;
  nav_date: string | null;
  lag_trade_days: number | null;
  premium_bps: number | null;
  premium_pct: number | null;
  buy_blocked: boolean;
  status_zh: string;
}

export interface V3ActionEngineOutput {
  schema: 'portfolio-action-engine/1.0';
  as_of_trade_date: string;
  market_regime: MarketRegimeResult;
  router: StrategyRouterResult;
  deconcentration: DeconcentrationEvaluation;
  actions: ActionEnginePlan[];
  blockers: string[];
  reconciliation_reminder: {
    lag_trade_days: number | null;
    needs_reminder: boolean;
    message_zh: string | null;
  };
  super_etf_candidates: SuperEtfCandidateView[];
  cross_border_monitor: CrossBorderMonitorView[];
  stock_swing_candidates: StockSwingCandidate[];
  stop_tracker_updates: StopTrackerRow[];
}

export interface StockSwingOrderInput {
  navCents: number;
  entryPriceMilli: number;
  hardStopPriceMilli: number;
  availableCashCents: number;
  commissionRate?: number;
  commissionMinCents?: number;
  transferFeeRate?: number;
  maxRiskBps?: number;
  maxWeightBps?: number;
  minOrderCents?: number;
}

export interface StockSwingOrderResult {
  shares: number;
  lots: number;
  gross_cents: number;
  fees_cents: number;
  net_cents: number;
  risk_at_stop_cents: number;
  weight_bps: number;
  skipped_reason: string | null;
}

const SUPER_SET = new Set<string>(EASTMONEY_SUPER_ETF_CODES);

const NON_RISK_EQUITY_CODES = new Set<string>([
  ...ETF_CANDIDATE_DECLARATIONS.filter(d => d.category === 'bond').map(d => d.ts_code),
  '511990.SH',
  '511880.SH',
  '511660.SH',
]);

/** 判断持仓是否属于应计入熔断降仓与风险敞口上限的权益风险资产（豁免国债/货基）。 */
export function isRiskEquityHolding(tsCode: string): boolean {
  return !NON_RISK_EQUITY_CODES.has(tsCode);
}

const GROWTH_PREFERRED_ETFS = ['159205.SZ', '159290.SZ', '589850.SH', '589060.SH', '589330.SH', '159337.SZ'];
const VALUE_PREFERRED_ETFS = ['159330.SZ', '530050.SH', '510140.SH', '159207.SZ', '159549.SZ'];

function roundCent(v: number): number {
  return Math.round(v);
}

/**
 * 个股以损定仓公式（严格 100 股整数倍与东财 5 元最低佣金门槛）。
 */
export function sizeStockSwingOrder(input: StockSwingOrderInput): StockSwingOrderResult {
  const { navCents, entryPriceMilli, hardStopPriceMilli, availableCashCents } = input;
  if (
    !(navCents > 0)
    || !(entryPriceMilli > 0)
    || !(hardStopPriceMilli > 0)
    || hardStopPriceMilli >= entryPriceMilli
    || availableCashCents <= 0
  ) {
    return {
      shares: 0, lots: 0, gross_cents: 0, fees_cents: 0, net_cents: 0,
      risk_at_stop_cents: 0, weight_bps: 0, skipped_reason: 'invalid_price_or_budget',
    };
  }

  const entryCentsPerShare = entryPriceMilli / 10;
  const riskPerShareCents = (entryPriceMilli - hardStopPriceMilli) / 10;
  const maxRiskRatio = (input.maxRiskBps ?? 130) / 10000;
  const maxWeightRatio = (input.maxWeightBps ?? 1800) / 10000;
  const minOrderCents = input.minOrderCents ?? 800_000;
  const maxByRisk = Math.floor((navCents * maxRiskRatio) / riskPerShareCents);
  const maxByWeight = Math.floor((navCents * maxWeightRatio) / entryCentsPerShare);
  const maxByCash = Math.floor(availableCashCents / entryCentsPerShare);
  let shares = Math.floor(Math.min(maxByRisk, maxByWeight, maxByCash) / 100) * 100;

  const commRate = input.commissionRate ?? 0.00025;
  const commMin = input.commissionMinCents ?? 500;
  const xferRate = input.transferFeeRate ?? 0.00001;

  while (shares >= 100) {
    const grossCents = roundCent(shares * entryCentsPerShare);
    const commCents = Math.max(commMin, roundCent(grossCents * commRate));
    const xferCents = roundCent(grossCents * xferRate);
    const feesCents = commCents + xferCents;
    if (grossCents + feesCents <= availableCashCents) {
      if (navCents >= 6_000_000 && grossCents < minOrderCents) {
        return {
          shares: 0, lots: 0, gross_cents: grossCents, fees_cents: feesCents, net_cents: grossCents + feesCents,
          risk_at_stop_cents: 0, weight_bps: 0,
          skipped_reason: minOrderCents === 800_000 ? 'below_8000_cny_min_ticket' : 'below_min_ticket',
        };
      }
      return {
        shares,
        lots: shares / 100,
        gross_cents: grossCents,
        fees_cents: feesCents,
        net_cents: grossCents + feesCents,
        risk_at_stop_cents: roundCent(shares * riskPerShareCents),
        weight_bps: Math.round((grossCents / navCents) * 10000),
        skipped_reason: null,
      };
    }
    shares -= 100;
  }

  return {
    shares: 0, lots: 0, gross_cents: 0, fees_cents: 0, net_cents: 0,
    risk_at_stop_cents: 0, weight_bps: 0, skipped_reason: 'insufficient_cash_for_one_lot',
  };
}

/** 读取 asOf 当日或之前最后一个复权因子（carry-forward）；缺失/不可用时按 1 处理。 */
function lastAdjFactorAt(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
): number {
  if (!marketDb || !portfolioTableExists(marketDb, 'adj_factor')) return 1;
  const row = marketDb.prepare(
    'SELECT adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1',
  ).get(tsCode, asOf) as { adj_factor?: number } | undefined;
  const factor = Number(row?.adj_factor);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function stockMa20Milli(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
): number | null {
  if (!marketDb || !portfolioTableExists(marketDb, 'daily')) return null;
  const bars = (marketDb.prepare(
    'SELECT trade_date, close FROM daily WHERE ts_code = ? AND trade_date <= ? AND close > 0 ORDER BY trade_date DESC LIMIT 25',
  ).all(tsCode, asOf) as { trade_date: string; close: number }[]).reverse();
  if (bars.length < 20) return null;
  const adjMap = new Map<string, number>();
  let carry = 1;
  if (portfolioTableExists(marketDb, 'adj_factor')) {
    // 窗口首日之前可能已有未变化的因子：先 carry 到首日，避免把窗口前的除权
    // 基准当作 1 而扭曲前复权均线。
    const prior = marketDb.prepare(
      'SELECT adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1',
    ).get(tsCode, bars[0].trade_date) as { adj_factor?: number } | undefined;
    if (prior && Number(prior.adj_factor) > 0) carry = Number(prior.adj_factor);
    const adjRows = marketDb.prepare(
      'SELECT trade_date, adj_factor FROM adj_factor WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date ASC',
    ).all(tsCode, bars[0].trade_date, asOf) as { trade_date: string; adj_factor: number }[];
    for (const row of adjRows) if (Number(row.adj_factor) > 0) adjMap.set(String(row.trade_date), Number(row.adj_factor));
  }
  const adjs = bars.map(b => {
    const f = adjMap.get(b.trade_date);
    if (f && f > 0) carry = f;
    return carry;
  });
  const base = adjs[adjs.length - 1] || 1;
  const qfqTail = bars.slice(-20).map((b, idx) => Number(b.close) * (adjs[bars.length - 20 + idx] / base));
  const ma20 = qfqTail.reduce((s, v) => s + v, 0) / 20;
  return Math.round(ma20 * 1000);
}

function countLagTradeDays(
  marketDb: DatabaseSync | null | undefined,
  reportedThrough: string | null | undefined,
  asOf: string,
): number | null {
  if (!reportedThrough) return null;
  const cleanReported = reportedThrough.replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(cleanReported)) return null;
  if (cleanReported >= asOf) return 0;
  if (marketDb && portfolioTableExists(marketDb, 'trade_cal')) {
    const row = marketDb.prepare(
      'SELECT COUNT(*) n FROM trade_cal WHERE is_open = 1 AND cal_date > ? AND cal_date <= ?',
    ).get(cleanReported, asOf) as { n?: number } | undefined;
    if (row && typeof row.n === 'number') return row.n;
  }
  return Math.max(0, Math.round(
    (Date.UTC(+asOf.slice(0, 4), +asOf.slice(4, 6) - 1, +asOf.slice(6, 8))
      - Date.UTC(+cleanReported.slice(0, 4), +cleanReported.slice(4, 6) - 1, +cleanReported.slice(6, 8))) / 86400_000,
  ));
}

function styleScoreBoost(code: string, style: MarketStyleTier): number {
  if (style === 'GROWTH_LEADING' && GROWTH_PREFERRED_ETFS.includes(code)) return 0.25;
  if (style === 'VALUE_LEADING' && VALUE_PREFERRED_ETFS.includes(code)) return 0.25;
  return 0;
}

function describeStyleMatch(code: string, style: MarketStyleTier): string {
  if (style === 'GROWTH_LEADING' && GROWTH_PREFERRED_ETFS.includes(code)) return '契合当前成长占优风格';
  if (style === 'VALUE_LEADING' && VALUE_PREFERRED_ETFS.includes(code)) return '契合当前价值红利风格';
  if (code === '159321.SZ' || code === '518880.SH' || code === '518800.SH' || code === '159934.SZ') return '贵金属/商品对冲方向';
  return '东财免五白名单候选';
}

function buildSuperEtfViews(
  candidates: EtfCandidateScreenResult | null | undefined,
  style: MarketStyleTier,
  limit = 5,
): { allEligible: EtfCandidateRow[]; views: SuperEtfCandidateView[] } {
  const rows = candidates?.candidates ?? [];
  const eligible = rows
    .filter(row => SUPER_SET.has(row.ts_code) && row.included && !row.data?.buy_blocked && (row.data?.latest_close_milli ?? 0) > 0)
    .slice()
    .sort((a, b) => {
      const sa = (a.score ?? 0) + styleScoreBoost(a.ts_code, style);
      const sb = (b.score ?? 0) + styleScoreBoost(b.ts_code, style);
      if (sb !== sa) return sb - sa;
      return a.ts_code.localeCompare(b.ts_code);
    });
  const views: SuperEtfCandidateView[] = eligible.slice(0, limit).map(row => ({
    ts_code: row.ts_code,
    name: row.name ?? row.ts_code,
    category: row.category_label,
    close_cny: row.data.latest_close_milli !== null ? row.data.latest_close_milli / 1000 : null,
    unit_nav: row.data.unit_nav ?? null,
    premium_bps: row.data.premium_bps ?? null,
    premium_pct: row.filters.premium_discount.value_pct ?? null,
    buy_blocked: Boolean(row.data.buy_blocked),
    score: row.score,
    fee_label_zh: '东财超级ETF（万分之0.5佣金，免5元低消）',
    style_match_zh: describeStyleMatch(row.ts_code, style),
  }));
  return { allEligible: eligible, views };
}

function buildCrossBorderMonitor(candidates: EtfCandidateScreenResult | null | undefined): CrossBorderMonitorView[] {
  const rows = (candidates?.candidates ?? []).filter(r => r.category === 'cross_border');
  return rows.map(row => {
    const pd = row.filters.premium_discount;
    let statusZh = '正常可关注';
    if (pd.buy_blocked) {
      statusZh = pd.reason === 'cross_border_nav_stale'
        ? '已拦截禁买（净值滞后超3个交易日或缺失）'
        : `已拦截禁买（溢价 ${pd.value_pct ?? '—'}% 高于 +2.5% 红线）`;
    } else if (pd.value_pct !== null) {
      statusZh = `溢价可控（${pd.value_pct >= 0 ? '+' : ''}${pd.value_pct.toFixed(2)}% ≤ +2.5%）`;
    } else {
      statusZh = '当日行情或净值未齐';
    }
    return {
      ts_code: row.ts_code,
      name: row.name ?? row.ts_code,
      close_cny: row.data.latest_close_milli !== null ? row.data.latest_close_milli / 1000 : null,
      unit_nav: pd.unit_nav ?? null,
      nav_date: pd.nav_date ?? null,
      lag_trade_days: pd.lag_trade_days ?? null,
      premium_bps: pd.premium_bps ?? null,
      premium_pct: pd.value_pct ?? null,
      buy_blocked: Boolean(pd.buy_blocked),
      status_zh: statusZh,
    };
  });
}

export interface RunActionEngineInput {
  portfolioDb?: DatabaseSync | null;
  marketDb?: DatabaseSync | null;
  accountId: string;
  asOf: string;
  holdings: Array<{
    ts_code: string;
    name: string;
    quantity: number;
    sellable_quantity?: number;
    weight: number;
    market_value_cents: number;
    price_milli: number;
    latest_bar_date: string | null;
    bar_quality: string;
    ref_cost_milli?: number | null;
  }>;
  cashCents: number;
  wealthCents?: number;
  totalAssetsCents: number;
  baselineTotalAssetsCents?: number;
  reportedEventsThrough?: string | null;
  lastUserReconciledAt?: string | null;
  candidates?: EtfCandidateScreenResult | null;
  marketRegime?: MarketRegimeResult;
  phase1LockStockSwing?: boolean;
  deconcentrationActive?: boolean;
  stockSwingScreen?: StockSwingScreenResult | null;
}

function resolveDeconcentrationControl(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
  holdings: RunActionEngineInput['holdings'],
): { active: boolean; mode: DeconcentrationPlanMode } {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'deconcentration_plan')) {
    return { active: false, mode: 'STANDARD' };
  }
  try {
    const cols = portfolioDb.prepare('PRAGMA table_info(deconcentration_plan)').all() as Array<{ name?: string }>;
    const hasPlanMode = cols.some(c => c.name === 'plan_mode');
    const plans = portfolioDb.prepare(`
      SELECT plan_id, ts_code${hasPlanMode ? ', plan_mode' : ''} FROM deconcentration_plan
      WHERE account_id = ? AND status = 'ACTIVE'
      ORDER BY created_at DESC
    `).all(accountId) as Array<{ plan_id: string; ts_code: string; plan_mode?: string }>;
    let detectedMode: DeconcentrationPlanMode = 'STANDARD';
    for (const p of plans) {
      if (p.plan_mode === 'BOTTOM_GRIND_25') detectedMode = 'BOTTOM_GRIND_25';
      const h = holdings.find(row => row.ts_code === p.ts_code);
      if (!h || h.quantity < 100) continue;
      if (!portfolioTableExists(portfolioDb, 'deconcentration_tranche')) {
        if (h.weight > 0.30 || detectedMode === 'STANDARD') return { active: true, mode: detectedMode };
        continue;
      }
      const pending = portfolioDb.prepare(`
        SELECT COUNT(*) AS cnt FROM deconcentration_tranche
        WHERE plan_id = ? AND status IN ('PENDING', 'TRIGGERED')
      `).get(p.plan_id) as { cnt: number };
      if (Number(pending?.cnt ?? 0) > 0 || h.weight > 0.30) {
        return { active: true, mode: detectedMode };
      }
    }
    return { active: false, mode: detectedMode };
  } catch {
    return { active: false, mode: 'STANDARD' };
  }
}

export function runActionEngine(input: RunActionEngineInput): V3ActionEngineOutput {
  const regime = input.marketRegime ?? evaluateMarketRegime(input.marketDb, input.asOf);
  const deconcControl = resolveDeconcentrationControl(input.portfolioDb, input.accountId, input.holdings);
  const deconcentrationActive = input.deconcentrationActive ?? deconcControl.active;
  const router = evaluateStrategyRouter({
    portfolioDb: input.portfolioDb,
    marketDb: input.marketDb,
    accountId: input.accountId,
    asOf: input.asOf,
    currentNavCents: input.totalAssetsCents,
    fallbackBaselineNavCents: input.baselineTotalAssetsCents,
    marketRegime: regime,
    phase1LockStockSwing: input.phase1LockStockSwing,
    deconcentrationActive,
    deconcentrationMode: deconcControl.mode,
  });

  const holding159558 = input.holdings.find(h => h.ts_code === '159558.SZ');
  const deconcentration = evaluateDeconcentrationPlan({
    portfolioDb: input.portfolioDb,
    marketDb: input.marketDb,
    accountId: input.accountId,
    tsCode: '159558.SZ',
    asOf: input.asOf,
    currentShares: holding159558?.quantity ?? 0,
    sellableShares: holding159558?.sellable_quantity ?? holding159558?.quantity ?? 0,
    currentCloseMilli: holding159558?.price_milli ?? null,
    navCents: input.totalAssetsCents,
    availableCashCents: input.cashCents,
    circuitBreakerStatus: router.circuit_breaker_status,
    marketRegime: router.effective_regime,
  });

  const lagDays = countLagTradeDays(input.marketDb, input.reportedEventsThrough, input.asOf);
  const needsReminder = lagDays !== null && lagDays > 5;
  const reconciliationReminder = {
    lag_trade_days: lagDays,
    needs_reminder: needsReminder,
    message_zh: needsReminder
      ? `提示：距离最近一次账本流水声明（${input.reportedEventsThrough}）已过 ${lagDays} 个交易日，若期间有手工成交请先补录再核对委托份数。`
      : null,
  };

  const blockers: string[] = [];
  const actions: ActionEnginePlan[] = [];
  const stopTrackerUpdates: StopTrackerRow[] = [];

  const { allEligible: superEligible, views: superViews } = buildSuperEtfViews(input.candidates, regime.style);
  const crossBorderMonitor = buildCrossBorderMonitor(input.candidates);
  const stockScreen = input.stockSwingScreen !== undefined
    ? input.stockSwingScreen
    : (router.sub_strategies.s_stock_swing === 'ACTIVE' && input.marketDb
      // 候选池取 max(持仓上限, 10)：前 2 名若已被持仓/不可买（如 920 板块），仍有替补可评估；
      // 实际新开仓数量仍由下方 policy.stock_max_positions 封顶。
      ? screenStockSwingCandidates(input.marketDb, input.asOf, {
          maxCandidates: Math.max(loadApprovedV3Policy().stock_max_positions, 10),
        })
      : null);
  const stockSwingCandidates = stockScreen?.candidates ?? [];

  const staleHoldings = input.holdings.filter(h => h.bar_quality !== 'READY');
  if (staleHoldings.length > 0) {
    blockers.push(
      `${staleHoldings.map(h => h.ts_code).join('、')} 缺少目标交易日可校验行情，已暂停当日调仓数量计算。`,
      '触发条件：补齐收盘行情与复权数据后重算动作指令。',
      '失效条件：目标交易日、账户持仓或行情发生变更。',
    );
    return {
      schema: 'portfolio-action-engine/1.0',
      as_of_trade_date: input.asOf,
      market_regime: regime,
      router,
      deconcentration,
      actions,
      blockers,
      reconciliation_reminder: reconciliationReminder,
      super_etf_candidates: superViews,
      cross_border_monitor: crossBorderMonitor,
      stock_swing_candidates: stockSwingCandidates,
      stop_tracker_updates: stopTrackerUpdates,
    };
  }

  let workingCashCents = input.cashCents;
  const workingQty = new Map<string, number>(input.holdings.map(h => [h.ts_code, h.quantity]));
  const workingSellable = new Map<string, number>(
    input.holdings.map(h => [h.ts_code, h.sellable_quantity ?? h.quantity]),
  );

  const feeFor = (code: string, kind: 'ETF' | 'STOCK') =>
    resolveFeeRules({ db: input.portfolioDb, accountId: input.accountId, code, kind, asOf: input.asOf });

  // -------------------------------- P0: 高水位账户熔断强压风险权益仓位（集中持仓前置 12%->0%，分散后 15%->15%；国债/货基豁免）
  if (router.circuit_breaker_status === 'L2_LOCKED') {
    const targetEquityPct = router.targets.target_equity_bps / 100;
    const triggerPct = router.l2_trigger_drawdown_bps / 100;
    const maxEquityCents = Math.round(input.totalAssetsCents * (router.targets.target_equity_bps / 10000));
    let currentEquityCents = input.holdings.reduce(
      (s, h) => s + (isRiskEquityHolding(h.ts_code) ? h.market_value_cents : 0),
      0,
    );
    if (currentEquityCents > maxEquityCents) {
      const sorted = input.holdings
        .filter(h => isRiskEquityHolding(h.ts_code))
        .slice()
        .sort((a, b) => b.market_value_cents - a.market_value_cents || a.ts_code.localeCompare(b.ts_code));
      for (const h of sorted) {
        if (currentEquityCents <= maxEquityCents) break;
        const sellable = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
        if (sellable < 100 || !(h.price_milli > 0)) continue;
        const excessCents = currentEquityCents - maxEquityCents;
        const priceCents = h.price_milli / 10;
        const rawLots = Math.ceil(excessCents / priceCents / 100) * 100;
        const sellShares = Math.min(sellable, rawLots);
        if (sellShares < 100) continue;
        const kind: 'ETF' | 'STOCK' = isEtfCode(h.ts_code) ? 'ETF' : 'STOCK';
        const rules = feeFor(h.ts_code, kind);
        const grossCents = roundCent(sellShares * priceCents);
        const fees = calculateFees(grossCents, 'sell', rules);
        const netCents = grossCents - fees.total_cents;
        workingQty.set(h.ts_code, Math.max(0, (workingQty.get(h.ts_code) ?? 0) - sellShares));
        workingSellable.set(h.ts_code, Math.max(0, sellable - sellShares));
        workingCashCents += netCents;
        currentEquityCents -= grossCents;
        actions.push({
          priority: 'P0',
          code: `P0-BREAKER-SELL-${h.ts_code}`,
          kind: 'REDUCE',
          rank: actions.length + 1,
          title: `触发${triggerPct.toFixed(0)}%账户熔断线：减仓 ${h.name}（${h.ts_code}）`,
          reasons: [
            `账户较动态高水位回撤已达 ${router.anchor_snapshot.hwm_drawdown_pct.toFixed(2)}%（≥ ${triggerPct.toFixed(0)}% 熔断红线），无条件压降风险权益仓位至 ${targetEquityPct.toFixed(0)}%${targetEquityPct === 0 ? '' : '以内'}（国债与现金基金保留防御席位）。`,
            `卖出回款留作账户可用现金或国债逆回购，避免对非免五货基白交 10 元往返佣金。`,
          ],
          counter_evidence: ['若次日即刻深V反弹将放弃该段超额上涨参与度，但守住本金生命线优先。'],
          legs: [{
            side: 'SELL',
            ts_code: h.ts_code,
            name: h.name,
            quantity: sellShares,
            lot_size: 100,
            lots: sellShares / 100,
            price_milli: h.price_milli,
            gross_cents: grossCents,
            fees_cents: fees.total_cents,
            net_cents: netCents,
            quote_trade_date: h.latest_bar_date,
            executable: true,
            reason: router.deconcentration_preemptive_active
              ? 'P0_CIRCUIT_BREAKER_12PCT_PREEMPTIVE'
              : 'P0_CIRCUIT_BREAKER_15PCT',
          }],
          fees_cents: fees.total_cents,
          fees_estimated: Boolean(rules.fee_model?.estimated),
          triggers: [`次日开盘竞价或盘中限价卖出 ${sellShares} 份 ${h.ts_code}`],
          invalidation_conditions: ['当日盘后账户总资产重新回升至熔断线之上且解除冷静期'],
          risk_impact: [`压降高波动权益集中暴露，确保风险权益权重不超过 ${targetEquityPct.toFixed(0)}%`],
        });
      }
    }
  }

  // -------------------------------- P1: 个股 -8% 硬止损 / +15% 保本 / 跌破 MA20 移动止盈
  const trackerByCode = new Map<string, StopTrackerRow>();
  if (portfolioTableExists(input.portfolioDb, 'position_stop_tracker') && input.portfolioDb) {
    const rows = input.portfolioDb.prepare(
      "SELECT * FROM position_stop_tracker WHERE account_id = ? AND status = 'OPEN'",
    ).all(input.accountId) as unknown as StopTrackerRow[];
    for (const r of rows) trackerByCode.set(r.ts_code, r);
  }

  for (const h of input.holdings) {
    const isStock = !isEtfCode(h.ts_code);
    const tracked = trackerByCode.get(h.ts_code);
    if (!isStock && !tracked) continue;
    const remSellable = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
    if (remSellable < 100 || !(h.price_milli > 0)) continue;
    if (isStock && !tradabilityOf(h.ts_code, { kind: 'STOCK', board: inferBoard(h.ts_code) }).tradable && remSellable < 100) continue;

    const entryMilli = tracked?.entry_price_milli ?? h.ref_cost_milli ?? h.price_milli;
    const initialStopMilli = tracked?.initial_stop_milli ?? Math.round(entryMilli * 0.92);
    let currentStopMilli = tracked?.current_stop_milli ?? initialStopMilli;
    let ma20Armed = tracked?.trailing_ma20_armed ?? 0;

    // 复权基准换算：tracker 内价格按 entry 基准（entry_adj_factor）存储。除权/拆股后
    // adj_factor 上升而原始价下跌，因此历史价的 asOf 原始口径等价价 =
    // stored × entryAdj / currentAdj（Tushare hfq 因子口径）。绝不对 h.price_milli 缩放。
    // 旧行 entry_adj_factor 为 NULL 时不缩放，并在本次落库补写当前因子。
    const currentAdj = lastAdjFactorAt(input.marketDb, h.ts_code, input.asOf);
    const entryAdj = tracked?.entry_adj_factor ?? null;
    const basisRatio = entryAdj !== null && entryAdj > 0 ? entryAdj / currentAdj : 1;
    const scaledEntryMilli = Math.round(entryMilli * basisRatio);
    let scaledCurrentStopMilli = Math.round(currentStopMilli * basisRatio);

    if (h.price_milli >= Math.round(scaledEntryMilli * 1.15)) {
      ma20Armed = 1;
      currentStopMilli = Math.max(currentStopMilli, entryMilli);
      scaledCurrentStopMilli = Math.round(currentStopMilli * basisRatio);
    }

    const ma20Milli = stockMa20Milli(input.marketDb, h.ts_code, input.asOf);
    const hardStopHit = h.price_milli <= scaledCurrentStopMilli;
    const trailingExitHit = ma20Armed === 1 && ma20Milli !== null && h.price_milli < ma20Milli;

    stopTrackerUpdates.push({
      account_id: input.accountId,
      ts_code: h.ts_code,
      entry_date: tracked?.entry_date ?? input.asOf,
      entry_price_milli: entryMilli,
      initial_stop_milli: initialStopMilli,
      current_stop_milli: currentStopMilli,
      trailing_ma20_armed: ma20Armed,
      entry_adj_factor: entryAdj ?? currentAdj,
      status: hardStopHit || trailingExitHit ? 'CLOSED' : 'OPEN',
      updated_at: input.asOf,
    });

    if (hardStopHit || trailingExitHit) {
      const kind: 'ETF' | 'STOCK' = isStock ? 'STOCK' : 'ETF';
      const rules = feeFor(h.ts_code, kind);
      const priceCents = h.price_milli / 10;
      const grossCents = roundCent(remSellable * priceCents);
      const fees = calculateFees(grossCents, 'sell', rules);
      const netCents = grossCents - fees.total_cents;
      workingQty.set(h.ts_code, Math.max(0, (workingQty.get(h.ts_code) ?? 0) - remSellable));
      workingSellable.set(h.ts_code, 0);
      workingCashCents += netCents;
      const reasonText = hardStopHit
        ? `收盘价 ${(h.price_milli / 1000).toFixed(2)} 元跌破止损线 ${(scaledCurrentStopMilli / 1000).toFixed(2)} 元，无条件执行止损。`
        : `浮盈曾达 15% 后收盘跌破 20 日均线（${((ma20Milli ?? 0) / 1000).toFixed(2)} 元），执行移动止盈离场。`;
      actions.push({
        priority: 'P1',
        code: `P1-STOP-SELL-${h.ts_code}`,
        kind: 'REDUCE',
        rank: actions.length + 1,
        title: `${hardStopHit ? '触发硬止损清仓' : '触发移动止盈离场'}：卖出 ${h.name}（${h.ts_code}）`,
        reasons: [reasonText],
        counter_evidence: ['短期洗盘可能次日反包，但单笔严守止损是 10 万本金回本纪律核心。'],
        legs: [{
          side: 'SELL',
          ts_code: h.ts_code,
          name: h.name,
          quantity: remSellable,
          lot_size: 100,
          lots: remSellable / 100,
          price_milli: h.price_milli,
          gross_cents: grossCents,
          fees_cents: fees.total_cents,
          net_cents: netCents,
          quote_trade_date: h.latest_bar_date,
          executable: true,
          reason: hardStopHit ? 'P1_HARD_STOP_8PCT' : 'P1_TRAILING_MA20_STOP',
        }],
        fees_cents: fees.total_cents,
        fees_estimated: Boolean(rules.fee_model?.estimated),
        triggers: [`下一交易日按市价/限价清仓全部可卖 ${remSellable} 股`],
        invalidation_conditions: ['交易前标的已停牌'],
        risk_impact: ['切断单笔下行尾部亏损，释放可用资金'],
      });
    }
  }

  // -------------------------------- P2: 159558.SZ 状态机减仓 / 磨底降本高抛低吸
  const keepPctLabel = (deconcentration.target_keep_bps / 100).toFixed(0);
  if (deconcentration.plan_present && deconcentration.recommended_sell_shares >= 100) {
    const h159558 = holding159558;
    const remSellable = Math.floor((workingSellable.get('159558.SZ') ?? 0) / 100) * 100;
    const sellShares = Math.min(deconcentration.recommended_sell_shares, remSellable);
    if (h159558 && sellShares >= 100 && h159558.price_milli > 0) {
      const rules = feeFor('159558.SZ', 'ETF');
      const priceCents = h159558.price_milli / 10;
      const grossCents = roundCent(sellShares * priceCents);
      const fees = calculateFees(grossCents, 'sell', rules);
      const netCents = grossCents - fees.total_cents;
      workingQty.set('159558.SZ', Math.max(0, (workingQty.get('159558.SZ') ?? 0) - sellShares));
      workingSellable.set('159558.SZ', Math.max(0, remSellable - sellShares));
      workingCashCents += netCents;

      const reason = deconcentration.active_trigger_reason;
      const trigBatches = deconcentration.tranches
        .filter(t => t.status === 'TRIGGERED')
        .map(t => `第${t.tranche_no}批`)
        .join('、') || '当前批次';
      const isTacticalTp = reason === 'GRIND_TACTICAL_TAKE_PROFIT';
      const isDriftHarvest = reason === 'GRIND_OVERWEIGHT_DRIFT_HARVEST';

      let actionCode = 'P2-DECONCENTRATE-159558';
      let actionTitle = `执行 159558.SZ 四批换马（${trigBatches}）：卖出 ${sellShares} 份`;
      let triggerDetail = '已进入月度时间保底窗口且距前次间隔满 12 个交易日';
      let actionReasons = [
        `${triggerDetail}，按计划减持 ${sellShares} 份以降低单一半导体 ETF 超额集中度（当前占比 ${(h159558.weight * 100).toFixed(2)}% -> 目标留存 ${keepPctLabel}%）。`,
        '卖出回款将按当前市场档位转入东财超级 ETF（万0.5免五）或留作现金防线。',
      ];
      if (isTacticalTp) {
        actionCode = 'P2-GRIND-TAKE-PROFIT-159558';
        actionTitle = `执行 159558.SZ 磨底降本止盈：卖出 ${sellShares} 份`;
        const tpDesc = deconcentration.grind_guards?.in_bull_trend
          ? '60日均线上方多头趋势跟踪触发右侧止盈回落条件'
          : `已达到战术回补入场价 ${(deconcentration.tactical_entry_price_cny ?? 0).toFixed(3)} 元之上 +7.5% 止盈位（${(deconcentration.tactical_take_profit_cny ?? 0).toFixed(3)} 元）`;
        actionReasons = [
          `159558.SZ 磨底机动降本仓位 ${sellShares} 份${tpDesc}，执行高抛锁盈并保留 ${keepPctLabel}%（约 ${deconcentration.target_keep_shares} 份）战略底仓。`,
          '卖出回款重新记作降本锚定价并留作下一次深折价止稳回补弹药。',
        ];
      } else if (isDriftHarvest) {
        actionCode = 'P2-GRIND-DRIFT-HARVEST-159558';
        actionTitle = `执行 159558.SZ 超配漂移获利了结：卖出 ${sellShares} 份`;
        actionReasons = [
          `159558.SZ 随板块反弹被动漂移至总资产 ${(h159558.weight * 100).toFixed(2)}%（已达 34% 以上）且出现短线超买/滞涨信号，高抛超出 ${keepPctLabel}% 底仓的 ${sellShares} 份兑现浮盈。`,
          '兑现后持仓比例回到约 25% 战略底仓，释放资金恢复防御与机动能力。',
        ];
      } else {
        if (reason === 'REBOUND_8PCT') {
          triggerDetail = `收盘 ${(h159558.price_milli / 1000).toFixed(3)} 元已达到自基准价反弹 +8% 目标（${(deconcentration.rebound_trigger_cny ?? 0).toFixed(3)} 元）`;
        } else if (reason === 'BREAKDOWN_SUPPORT_FLOOR') {
          const confirmPrefix = deconcentration.plan_mode === 'BOTTOM_GRIND_25' ? '连续两日收盘或深幅跌破' : '收盘跌破';
          triggerDetail = `${confirmPrefix}磨底箱体防守位（${(deconcentration.support_floor_cny ?? deconcentration.downside_protect_cny ?? 0).toFixed(3)} 元），触发保护减仓`;
        } else if (reason === 'BREAKDOWN_MA60') {
          triggerDetail = `空头防守环境下连续两日有效跌破 60 日线（${(deconcentration.ma60_protect_cny ?? 0).toFixed(3)} 元），触发保护减仓`;
        }
        actionReasons = [
          `${triggerDetail}，按计划减持 ${sellShares} 份以降低单一半导体 ETF 超额集中度（当前占比 ${(h159558.weight * 100).toFixed(2)}% -> 目标留存 ${keepPctLabel}%）。`,
          '卖出回款将按当前市场档位转入东财超级 ETF（万0.5免五）或留作现金防线。',
        ];
      }

      actions.push({
        priority: 'P2',
        code: actionCode,
        kind: 'REDUCE',
        rank: actions.length + 1,
        title: actionTitle,
        reasons: actionReasons,
        counter_evidence: ['若半导体板块次日继续脉冲拉升，已减仓部分不再享受后续涨幅，但核心战略底仓仍保留全部后续弹性。'],
        legs: [{
          side: 'SELL',
          ts_code: '159558.SZ',
          name: h159558.name,
          quantity: sellShares,
          lot_size: 100,
          lots: sellShares / 100,
          price_milli: h159558.price_milli,
          gross_cents: grossCents,
          fees_cents: fees.total_cents,
          net_cents: netCents,
          quote_trade_date: h159558.latest_bar_date,
          executable: true,
          reason: `P2_${reason ?? 'TRANCHE_TRIGGERED'}`,
        }],
        fees_cents: fees.total_cents,
        fees_estimated: Boolean(rules.fee_model?.estimated),
        triggers: [`次日开盘或盘中分笔限价卖出 ${sellShares} 份 159558.SZ（计划内固定整手份额）`],
        invalidation_conditions: ['成交并在账本录入卖出事件后状态机自动更新已执行批次与基准价'],
        risk_impact: [`有序维持 159558.SZ 约 ${keepPctLabel}% 核心底仓并锁盈降本`],
      });
    }
  } else if (
    deconcentration.plan_present
    && deconcentration.plan_mode === 'BOTTOM_GRIND_25'
    && deconcentration.recommended_buy_shares >= 100
    && router.circuit_breaker_status === 'NORMAL'
  ) {
    const h159558 = holding159558;
    const buyPriceMilli = h159558?.price_milli ?? deconcentration.current_close_milli ?? 0;
    if (buyPriceMilli > 0) {
      const rules = feeFor('159558.SZ', 'ETF');
      const priceCents = buyPriceMilli / 10;
      let buyShares = deconcentration.recommended_buy_shares;
      while (buyShares >= 100) {
        const grossCents = roundCent(buyShares * priceCents);
        const fees = calculateFees(grossCents, 'buy', rules);
        if (grossCents + fees.total_cents <= workingCashCents - 10_000) {
          if (grossCents >= 100_000) {
            workingCashCents -= grossCents + fees.total_cents;
            workingQty.set('159558.SZ', (workingQty.get('159558.SZ') ?? 0) + buyShares);
            const guards = deconcentration.grind_guards;
            actions.push({
              priority: 'P2',
              code: 'P2-GRIND-RELOAD-159558',
              kind: 'ADD',
              rank: actions.length + 1,
              title: `执行 159558.SZ 震荡磨底战术回补：买入 ${buyShares} 份`,
              reasons: [
                `25%底仓降本四门槛全部满足：60日均线10日斜率 ${guards?.ma60_slope10_pct?.toFixed(2) ?? '0.00'}%（未下行）、折价目标 ${(guards?.reload_target_cny ?? 0).toFixed(3)} 元达成、近3日出现极值超卖且当日右侧阳线站稳5日线。`,
                `按单个 +${(deconcentration.tactical_slot_bps / 100).toFixed(0)}% 战术降本槽买入 ${buyShares} 份（买后封顶总仓位约 ${deconcentration.max_grind_weight_pct.toFixed(0)}%），不设窄幅噪点止损，统一由账户级熔断线兜底并在反弹 +7.5% 或牛市均线破位兑现降本。`,
              ],
              counter_evidence: ['若次日行业突发黑天鹅大幅低开，短期账面波动可能放大，但仓位已严控在单槽上限内并受账户高水位熔断保护。'],
              legs: [{
                side: 'BUY',
                ts_code: '159558.SZ',
                name: h159558?.name ?? '半导体设备ETF',
                quantity: buyShares,
                lot_size: 100,
                lots: buyShares / 100,
                price_milli: buyPriceMilli,
                gross_cents: grossCents,
                fees_cents: fees.total_cents,
                net_cents: grossCents + fees.total_cents,
                quote_trade_date: h159558?.latest_bar_date ?? input.asOf,
                executable: true,
                reason: 'P2_GRIND_OVERSOLD_RELOAD',
              }],
              fees_cents: fees.total_cents,
              fees_estimated: Boolean(rules.fee_model?.estimated),
              triggers: [`次日限价买入 ${buyShares} 份 159558.SZ（参考价 ${(buyPriceMilli / 1000).toFixed(3)} 元，不追高）`],
              invalidation_conditions: ['次日跳空高开超过 +2% 失去折价空间，或账户触及高水位回撤警戒线'],
              risk_impact: [`以单槽 +${(deconcentration.tactical_slot_bps / 100).toFixed(0)}% 上限拉低 159558.SZ 综合持仓成本，严格禁止连续加仓或网格补仓`],
            });
          }
          break;
        }
        buyShares -= 100;
      }
    }
  }

  // -------------------------------- P3: 个股波段先锋开仓 + 底盘超级 ETF 对齐与减仓回款轮动（熔断/防守期禁止新开多）
  if (router.circuit_breaker_status !== 'L2_LOCKED' && router.effective_regime !== 'DEFENSIVE') {
    const policy = loadApprovedV3Policy();
    const minStockOrderCents = policy.stock_min_order_cny * 100;
    let postEquityCents = input.holdings.reduce((sum, h) => {
      if (!isRiskEquityHolding(h.ts_code)) return sum;
      const q = workingQty.get(h.ts_code) ?? h.quantity;
      return sum + Math.round(q * (h.price_milli / 10));
    }, 0);
    const targetMaxEquityCents = Math.round(input.totalAssetsCents * (router.targets.target_equity_bps / 10000));
    const targetDefensiveCashCents = Math.round(input.totalAssetsCents * (router.targets.defensive_cash_bps / 10000));

    if (router.sub_strategies.s_stock_swing === 'ACTIVE' && stockSwingCandidates.length > 0) {
      let openStockCount = input.holdings.filter(
        h => !isEtfCode(h.ts_code) && (workingQty.get(h.ts_code) ?? h.quantity) > 0,
      ).length;
      for (const cand of stockSwingCandidates) {
        if (openStockCount >= policy.stock_max_positions) break;
        if ((workingQty.get(cand.ts_code) ?? 0) > 0) continue;
        if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
        const equityGapCents = targetMaxEquityCents - postEquityCents;
        const cashRoomCents = workingCashCents - targetDefensiveCashCents;
        const deployBudgetCents = Math.min(equityGapCents, cashRoomCents);
        if (deployBudgetCents < minStockOrderCents) break;
        const rules = feeFor(cand.ts_code, 'STOCK');
        const sized = sizeStockSwingOrder({
          navCents: input.totalAssetsCents,
          entryPriceMilli: cand.entry_ref_price_milli,
          hardStopPriceMilli: cand.hard_stop_price_milli,
          availableCashCents: Math.min(deployBudgetCents, workingCashCents - 10_000),
          commissionRate: rules.commission_rate,
          commissionMinCents: rules.commission_min_cents,
          transferFeeRate: rules.transfer_fee_rate,
          maxRiskBps: policy.stock_risk_budget_bps,
          maxWeightBps: policy.stock_max_single_weight_bps,
          minOrderCents: minStockOrderCents,
        });
        if (sized.shares < 100 || sized.skipped_reason !== null) continue;
        workingCashCents -= sized.net_cents;
        workingQty.set(cand.ts_code, sized.shares);
        postEquityCents += sized.gross_cents;
        openStockCount += 1;
        const entryCny = (cand.entry_ref_price_milli / 1000).toFixed(2);
        const stopCny = (cand.hard_stop_price_milli / 1000).toFixed(2);
        const weightPct = (sized.weight_bps / 100).toFixed(1);
        const riskPct = ((sized.risk_at_stop_cents / input.totalAssetsCents) * 100).toFixed(2);
        actions.push({
          priority: 'P3',
          code: `P3-STOCK-SWING-BUY-${cand.ts_code}`,
          kind: 'ADD',
          rank: actions.length + 1,
          title: `个股波段先锋开仓：买入 ${cand.name}（${cand.ts_code}）`,
          reasons: [
            `${cand.setup_label_zh}，当前处于${regime.regime_label_zh}且个股子策略已获批解封，按以损定仓配置 ${sized.shares} 股（占总资产 ${weightPct}%，止损风控敞口 ${riskPct}%）。`,
            cand.reasons_zh.join('；'),
          ],
          counter_evidence: ['若次日高开超过 +2% 追高风险放大，应放弃追价；若跌破硬止损价须严格执行 -8% 以内止损。'],
          legs: [{
            side: 'BUY',
            ts_code: cand.ts_code,
            name: cand.name,
            quantity: sized.shares,
            lot_size: 100,
            lots: sized.lots,
            price_milli: cand.entry_ref_price_milli,
            gross_cents: sized.gross_cents,
            fees_cents: sized.fees_cents,
            net_cents: sized.net_cents,
            quote_trade_date: cand.trade_date,
            executable: true,
            reason: 'P3_STOCK_SWING_PULLBACK_ENTRY',
          }],
          fees_cents: sized.fees_cents,
          fees_estimated: Boolean(rules.fee_model?.estimated),
          triggers: [
            `次日限价挂单买入 ${sized.shares} 股 ${cand.ts_code}，参考买入价 ${entryCny} 元（最高不追过 ${cand.max_chase_price_cny.toFixed(2)} 元，预设硬止损 ${stopCny} 元）`,
          ],
          invalidation_conditions: ['次日跳空高开超过 +2% 或盘中跌破硬止损价'],
          risk_impact: [`占总资产 ${weightPct}%（不超过 18% 单股上限），单笔止损风险 ${riskPct}%（不超过 1.3% 净值风险）`],
        });
      }
    }

    const equityGapCents = targetMaxEquityCents - postEquityCents;
    const cashRoomCents = workingCashCents - targetDefensiveCashCents;
    const deployBudgetCents = Math.min(equityGapCents, cashRoomCents);

    if (deployBudgetCents >= 100_000 && superEligible.length > 0) {
      const target = superEligible.find(cand => {
        if (cand.category !== 'industry_theme') return true;
        const heldVal = (workingQty.get(cand.ts_code) ?? 0) * ((cand.data.latest_close_milli ?? 0) / 10);
        return (heldVal / input.totalAssetsCents) < 0.18;
      });
      if (target && (target.data.latest_close_milli ?? 0) > 0) {
        const buyPriceMilli = target.data.latest_close_milli!;
        const buyPriceCents = buyPriceMilli / 10;
        const rules = feeFor(target.ts_code, 'ETF');
        let buyShares = Math.floor((deployBudgetCents / buyPriceCents) / 100) * 100;
        while (buyShares >= 100) {
          const grossCents = roundCent(buyShares * buyPriceCents);
          const fees = calculateFees(grossCents, 'buy', rules);
          if (grossCents + fees.total_cents <= workingCashCents - 10_000) {
            if (grossCents >= 100_000) {
              workingCashCents -= grossCents + fees.total_cents;
              actions.push({
                priority: 'P3',
                code: `P3-SUPER-ETF-BUY-${target.ts_code}`,
                kind: 'ROTATE',
                rank: actions.length + 1,
                title: `底盘配置东财超级 ETF：买入 ${target.name ?? target.ts_code}（${target.ts_code}）`,
                reasons: [
                  `当前处于${regime.regime_label_zh}且${regime.style_label_zh}，权益仓位低于目标水位，可用超额现金配置东财免五超级 ETF。`,
                  `标的佣金率万分之 0.5 且免 5 元最低消费，无折溢价禁买阻断。`,
                ],
                counter_evidence: ['若市场次日跌破风格锚，需随环境切档缩减仓位。'],
                legs: [{
                  side: 'BUY',
                  ts_code: target.ts_code,
                  name: target.name,
                  quantity: buyShares,
                  lot_size: 100,
                  lots: buyShares / 100,
                  price_milli: buyPriceMilli,
                  gross_cents: grossCents,
                  fees_cents: fees.total_cents,
                  net_cents: grossCents + fees.total_cents,
                  quote_trade_date: target.data.latest_bar_date,
                  executable: true,
                  reason: 'P3_SUPER_ETF_ALIGNMENT',
                }],
                fees_cents: fees.total_cents,
                fees_estimated: Boolean(rules.fee_model?.estimated),
                triggers: [`次日限价买入 ${buyShares} 份 ${target.ts_code}，参考价 ${(buyPriceMilli / 1000).toFixed(3)} 元`],
                invalidation_conditions: ['次日高开超过 +2% 或跨境品种盘中溢价超 +2.5%'],
                risk_impact: ['提升组合向占优风格宽基的分散度，保留防御现金防线'],
              });
            }
            break;
          }
          buyShares -= 100;
        }
      }
    }
  }

  return {
    schema: 'portfolio-action-engine/1.0',
    as_of_trade_date: input.asOf,
    market_regime: regime,
    router,
    deconcentration,
    actions,
    blockers,
    reconciliation_reminder: reconciliationReminder,
    super_etf_candidates: superViews,
    cross_border_monitor: crossBorderMonitor,
    stock_swing_candidates: stockSwingCandidates,
    stop_tracker_updates: stopTrackerUpdates,
  };
}

/** 将当次动作引擎计算出的 HWM 锚点、分批触发状态与止损跟踪安全落库（只读库静默跳过）。 */
export function syncAccountV3State(
  portfolioDb: DatabaseSync | null | undefined,
  output: V3ActionEngineOutput,
): void {
  if (!portfolioDb) return;
  persistRiskAnchor(portfolioDb, output.router);
  persistDeconcentrationUpdates(portfolioDb, output.deconcentration);
  if (output.stop_tracker_updates.length && portfolioTableExists(portfolioDb, 'position_stop_tracker')) {
    try {
      const stmt = portfolioDb.prepare(`
        INSERT INTO position_stop_tracker (
          account_id, ts_code, entry_date, entry_price_milli, initial_stop_milli,
          current_stop_milli, trailing_ma20_armed, entry_adj_factor, status, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, ts_code) DO UPDATE SET
          -- 已清仓（CLOSED）的旧行不得复活：重新买入时全部字段以本次为准；
          -- 只有仍持仓（OPEN）时才保留 entry 基准并对止损/武装位取 MAX。
          entry_date = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.entry_date ELSE position_stop_tracker.entry_date END,
          entry_price_milli = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.entry_price_milli ELSE position_stop_tracker.entry_price_milli END,
          initial_stop_milli = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.initial_stop_milli ELSE position_stop_tracker.initial_stop_milli END,
          current_stop_milli = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.current_stop_milli
            ELSE MAX(position_stop_tracker.current_stop_milli, excluded.current_stop_milli) END,
          trailing_ma20_armed = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.trailing_ma20_armed
            ELSE MAX(position_stop_tracker.trailing_ma20_armed, excluded.trailing_ma20_armed) END,
          entry_adj_factor = CASE WHEN position_stop_tracker.status = 'CLOSED'
            THEN excluded.entry_adj_factor
            ELSE COALESCE(position_stop_tracker.entry_adj_factor, excluded.entry_adj_factor) END,
          status = excluded.status,
          updated_at = excluded.updated_at
      `);
      for (const s of output.stop_tracker_updates) {
        stmt.run(
          s.account_id, s.ts_code, s.entry_date, s.entry_price_milli, s.initial_stop_milli,
          s.current_stop_milli, s.trailing_ma20_armed, s.entry_adj_factor ?? null, s.status, s.updated_at,
        );
      }
    } catch (err: any) {
      if (!String(err?.message ?? err).includes('readonly')) throw err;
    }
  }
}
