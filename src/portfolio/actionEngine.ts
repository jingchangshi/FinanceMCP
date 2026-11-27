import type { DatabaseSync } from 'node:sqlite';
import {
  EASTMONEY_SUPER_ETF_CODES,
  ETF_CANDIDATE_DECLARATIONS,
  V3_SUPER_ETF_DEFENSIVE_BUCKET,
  V3_SUPER_ETF_GROWTH_BUCKET,
  V3_SUPER_ETF_SECTOR_PIONEER_CODES,
  V3_SUPER_ETF_VALUE_BUCKET,
} from '../ashare/etfDeclarations.js';
import type { EtfCandidateRow, EtfCandidateScreenResult } from '../ashare/etfUniverse.js';
import {
  evaluateMarketRegime,
  type MarketRegimeResult,
  type MarketRegimeTier,
  type MarketStyleTier,
} from '../ashare/marketRegime.js';
import {
  evaluateFundamentalRegime,
  type FundamentalRegimeResult,
} from '../ashare/fundamentalRegime.js';
import type { ForwardViewOverlayRow } from './forwardViewOverlay.js';
import {
  screenSectorPioneerCandidates,
  type SectorPioneerCandidate,
  type SectorPioneerScreenResult,
} from '../ashare/sectorPioneer.js';
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
import {
  classifyHoldingSleeve,
  isRiskEquitySleeve,
  type PortfolioSleeve,
} from './sleeveClassifier.js';
import { buildTargetPortfolio, type TargetPortfolioResult } from './targetPortfolio.js';
import { loadApprovedV3Policy, type ApprovedV3Policy } from './v3Policy.js';

export interface StopTrackerRow {
  account_id: string;
  ts_code: string;
  entry_date: string;
  entry_price_milli: number;
  initial_stop_milli: number;
  current_stop_milli: number;
  trailing_ma20_armed: number;
  /** 价格所属复权基准；NULL = 历史未记录（回查 entry_date 因子，查不到则不缩放并保持 NULL）。 */
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

export interface AlignSummaryView {
  enabled: boolean;
  align_due: boolean;
  carryover_cap_bps: number;
  pre_sell_excess_cents: number;
  target_glide_sell_cents: number;
  p0_sold_cents: number;
  p3_sold_cents: number;
  unmanaged_legacy_before_cents: number;
  unmanaged_legacy_after_cents: number;
  post_action_risk_equity_bps: number;
  target_equity_cap_bps: number;
  chassis_target_count: number;
  target_slots: Array<{
    ts_code: string;
    sleeve: PortfolioSleeve;
    target_bps: number;
    target_cents: number;
    held_cents: number;
    buy_blocked: boolean;
  }>;
}

export interface V3ActionEngineOutput {
  schema: 'portfolio-action-engine/1.0';
  as_of_trade_date: string;
  market_regime: MarketRegimeResult;
  fundamental_regime: FundamentalRegimeResult;
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
  sector_pioneer_candidates: SectorPioneerCandidate[];
  stop_tracker_updates: StopTrackerRow[];
  align_summary?: AlignSummaryView;
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

type AdjTable = 'adj_factor' | 'fund_adj';
type PriceTable = 'daily' | 'fund_daily';

/** 读取 asOf 当日或之前最后一个复权因子（carry-forward）；缺失/不可用时返回 null。 */
function adjFactorAt(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
  table: AdjTable,
): number | null {
  if (!marketDb || !portfolioTableExists(marketDb, table)) return null;
  const row = marketDb.prepare(
    `SELECT adj_factor FROM ${table} WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1`,
  ).get(tsCode, asOf) as { adj_factor?: number } | undefined;
  const factor = Number(row?.adj_factor);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** 前复权 MA20：股票用 daily/adj_factor，ETF 用 fund_daily/fund_adj。 */
function computeMa20Milli(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
  priceTable: PriceTable,
  adjTable: AdjTable,
): number | null {
  if (!marketDb || !portfolioTableExists(marketDb, priceTable)) return null;
  const bars = (marketDb.prepare(
    `SELECT trade_date, close FROM ${priceTable} WHERE ts_code = ? AND trade_date <= ? AND close > 0 ORDER BY trade_date DESC LIMIT 25`,
  ).all(tsCode, asOf) as { trade_date: string; close: number }[]).reverse();
  if (bars.length < 20) return null;
  const adjMap = new Map<string, number>();
  // carry 从窗口首日或之前的真实因子起步（缺失按 1），避免把窗口前的除权基准
  // 当作 1 而扭曲前复权均线。
  let carry = adjFactorAt(marketDb, tsCode, bars[0].trade_date, adjTable) ?? 1;
  if (portfolioTableExists(marketDb, adjTable)) {
    const adjRows = marketDb.prepare(
      `SELECT trade_date, adj_factor FROM ${adjTable} WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date ASC`,
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

interface SuperEtfBucketSpec {
  key: 'growth' | 'value' | 'defensive';
  label_zh: string;
  codes: readonly string[];
  share_bps: number;
}

/**
 * V3-01 / V3-07 风格桶权重：
 * - DEFENSIVE 档权益全部进入防御红利桶；
 * - lowVolShareBps > 0 (v3.3.0 = 3000bps) 时永久保留 30% 低波核心（159549/159207），剩余 70% 按成长/价值风格拆桶（45/25/30、25/45/30、35/35/30）；
 * - lowVolShareBps = 0 (v3.2.0 基线) 时按 65/35、35/65、50/50 拆成成长/价值两桶。
 */
function superEtfBucketSpecs(
  regime: MarketRegimeTier,
  style: MarketStyleTier,
  lowVolShareBps = 0,
): SuperEtfBucketSpec[] {
  if (regime === 'DEFENSIVE') {
    return [{ key: 'defensive', label_zh: '防御红利', codes: V3_SUPER_ETF_DEFENSIVE_BUCKET, share_bps: 10000 }];
  }
  if (lowVolShareBps > 0 && lowVolShareBps < 10000) {
    const rem = 10000 - lowVolShareBps;
    const growthShareBps = lowVolShareBps === 3000
      ? (style === 'GROWTH_LEADING' ? 4500 : style === 'VALUE_LEADING' ? 2500 : 3500)
      : Math.round(rem * (style === 'GROWTH_LEADING' ? 0.65 : style === 'VALUE_LEADING' ? 0.35 : 0.50));
    const valueShareBps = rem - growthShareBps;
    return [
      { key: 'defensive', label_zh: '红利低波核心', codes: V3_SUPER_ETF_DEFENSIVE_BUCKET, share_bps: lowVolShareBps },
      { key: 'growth', label_zh: '成长', codes: V3_SUPER_ETF_GROWTH_BUCKET.slice(0, 3), share_bps: growthShareBps },
      { key: 'value', label_zh: '价值', codes: V3_SUPER_ETF_VALUE_BUCKET, share_bps: valueShareBps },
    ];
  }
  const growthShareBps = style === 'GROWTH_LEADING' ? 6500 : style === 'VALUE_LEADING' ? 3500 : 5000;
  return [
    { key: 'growth', label_zh: '成长', codes: V3_SUPER_ETF_GROWTH_BUCKET.slice(0, 3), share_bps: growthShareBps },
    { key: 'value', label_zh: '价值', codes: V3_SUPER_ETF_VALUE_BUCKET, share_bps: 10000 - growthShareBps },
  ];
}

interface SizedEtfBuy {
  shares: number;
  gross_cents: number;
  fees_cents: number;
  net_cents: number;
}

/**
 * ETF 买单定量：整数手、单腿最低毛额、总成本不超过可用现金。
 * 返回 null 表示预算内连一手都满足不了门槛，调用方必须跳过而不是把份额折到别的标的。
 */
function sizeEtfBuy(input: {
  priceMilli: number;
  budgetCents: number;
  availableCashCents: number;
  rules: ReturnType<typeof resolveFeeRules>;
  minGrossCents: number;
}): SizedEtfBuy | null {
  const priceCents = input.priceMilli / 10;
  if (!(priceCents > 0) || input.budgetCents <= 0 || input.availableCashCents <= 0) return null;
  let shares = Math.floor(Math.min(input.budgetCents, input.availableCashCents) / priceCents / 100) * 100;
  while (shares >= 100) {
    const grossCents = roundCent(shares * priceCents);
    const fees = calculateFees(grossCents, 'buy', input.rules);
    if (
      grossCents >= input.minGrossCents
      && grossCents + fees.total_cents <= input.availableCashCents
    ) {
      return { shares, gross_cents: grossCents, fees_cents: fees.total_cents, net_cents: grossCents + fees.total_cents };
    }
    shares -= 100;
  }
  return null;
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
  sectorPioneerScreen?: SectorPioneerScreenResult | null;
  /** 调用方已加载的策略（与报告共用同一次加载）；缺省时按实际 accountId/asOf 加载。 */
  policy?: ApprovedV3Policy;
  /** 可选覆盖无状态 align_due 判定（供跨仓一致性黄金快照测试）。 */
  alignDue?: boolean;
  /** 可选显式指示市场档位或风格较前一日是否变化（缺省从账本历史/regime 历史推断）。 */
  regimeOrStyleChanged?: boolean;
  /** v3.4.0 基本面 B1 756d 评估结果（可选直接注入，免重复查库）。 */
  fundamentalRegime?: FundamentalRegimeResult | null;
  /** v3.4.0 前瞻主观标量 FVO 测试注入。 */
  fvoOverride?: Partial<ForwardViewOverlayRow> | null;
  /** v3.4.0 近 60 交易日 FVO 归因（bps）。 */
  fvoAttribution60dBps?: number | null;
  /** v3.4.0 BP1 开仓前可投资净值 >=95k 二次复核标记（默认 true）。 */
  bp1Reverified?: boolean;
}

interface PendingRiskSell {
  ts_code: string;
  name: string;
  sleeve: PortfolioSleeve;
  price_milli: number;
  latest_bar_date: string | null;
  p0_shares: number;
  p1_shares: number;
  p2_shares: number;
  p3_shares: number;
  highest_priority: 'P0' | 'P1' | 'P2' | 'P3';
  p0_code: string | null;
  p1_code: string | null;
  p2_code: string | null;
  p3_code: string | null;
  titles: string[];
  reasons: string[];
  counter_evidence: string[];
  reason_codes: string[];
  triggers: string[];
  invalidation_conditions: string[];
  risk_impact: string[];
}

interface RegimeStylePoint {
  date: string;
  regime: string;
  style: string;
  eff_budget_bps?: number;
}

interface PersistedRegimeStyleHistory {
  prev?: RegimeStylePoint;
  curr: RegimeStylePoint;
}

function parseRegimeStyleHistory(raw: string): PersistedRegimeStyleHistory | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as PersistedRegimeStyleHistory;
      if (parsed?.curr?.date && parsed.curr.regime && parsed.curr.style) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  const parts = trimmed.split('|');
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { curr: { date: parts[0], regime: parts[1], style: parts[2] } };
  }
  return null;
}

function resolveInitialEntryFromLedger(
  portfolioDb: DatabaseSync | null | undefined,
  accountId: string,
  tsCode: string,
  asOf: string,
): { entryDate: string; entryPriceMilli: number } | null {
  if (!portfolioDb || !portfolioTableExists(portfolioDb, 'account_event')) return null;
  try {
    const row = portfolioDb.prepare(`
      SELECT occurred_on, price_milli FROM account_event
      WHERE account_id = ? AND ts_code = ? AND event_type IN ('TRADE_BUY', 'BUY')
        AND occurred_on <= ? AND reversed_by IS NULL AND price_milli > 0
      ORDER BY occurred_on DESC, rowid DESC LIMIT 1
    `).get(accountId, tsCode, asOf) as { occurred_on?: string; price_milli?: number } | undefined;
    if (row?.occurred_on && Number.isFinite(Number(row.price_milli)) && Number(row.price_milli) > 0) {
      return { entryDate: String(row.occurred_on), entryPriceMilli: Math.round(Number(row.price_milli)) };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 按市值比例分配整手卖出，并用最大小数残差补足 1 手直到覆盖 neededCents（或耗尽可卖数量）。
 */
function allocateProportionalSellLots(
  items: Array<{ ts_code: string; valueCents: number; priceMilli: number }>,
  neededCents: number,
  workingSellable: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (neededCents <= 0 || items.length === 0) return out;

  const eligible = items
    .map(item => {
      const maxShares = Math.floor((workingSellable.get(item.ts_code) ?? 0) / 100) * 100;
      const lotCents = item.priceMilli > 0 ? roundCent(100 * (item.priceMilli / 10)) : 0;
      return { ...item, maxShares, maxLots: Math.floor(maxShares / 100), lotCents };
    })
    .filter(item => item.maxLots > 0 && item.lotCents > 0 && item.valueCents > 0)
    .sort((a, b) => a.ts_code.localeCompare(b.ts_code));

  if (eligible.length === 0) return out;
  const totalValue = eligible.reduce((s, item) => s + item.valueCents, 0);
  if (!(totalValue > 0)) return out;

  if (neededCents >= totalValue) {
    for (const item of eligible) out.set(item.ts_code, item.maxShares);
    return out;
  }

  const state = eligible.map(item => {
    const idealCents = neededCents * (item.valueCents / totalValue);
    const lots = Math.min(item.maxLots, Math.floor(idealCents / item.lotCents));
    return { ...item, idealCents, lots };
  });

  let soldSum = state.reduce((s, item) => s + item.lots * item.lotCents, 0);
  while (soldSum < neededCents) {
    let bestIdx = -1;
    let bestResidual = -Infinity;
    for (let i = 0; i < state.length; i += 1) {
      if (state[i].lots >= state[i].maxLots) continue;
      const residual = state[i].idealCents - state[i].lots * state[i].lotCents;
      if (residual > bestResidual) {
        bestResidual = residual;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    state[bestIdx].lots += 1;
    soldSum += state[bestIdx].lotCents;
  }

  for (const item of state) {
    if (item.lots > 0) out.set(item.ts_code, item.lots * 100);
  }
  return out;
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
  const policy = input.policy ?? loadApprovedV3Policy({ accountId: input.accountId, asOf: input.asOf });
  const regime = input.marketRegime ?? evaluateMarketRegime(
    input.marketDb,
    input.asOf,
    policy.recovery_overlay_enabled
      ? {
          recoveryOverlay: {
            enabled: true,
            equityBps: policy.recovery_equity_bps,
            icepointPctMa60Max: policy.recovery_icepoint_pct_ma60_max_bps / 10000,
            icepointPctMa20Max: policy.recovery_icepoint_pct_ma20_max_bps / 10000,
            icepointLookbackDays: policy.recovery_icepoint_lookback_days,
            thrustPctMa20Min: policy.recovery_thrust_pct_ma20_min_bps / 10000,
            thrust5dJumpMin: policy.recovery_thrust_5d_jump_min_bps / 10000,
            thrustFloorPctMa20: policy.recovery_thrust_floor_pct_ma20_bps / 10000,
            minAmountVsMa20: policy.recovery_min_amount_vs_ma20_bps / 10000,
            cooldownDays: policy.recovery_false_breakout_cooldown_days,
          },
        }
      : {},
  );
  const useExecArchV2 = policy.regime_target_enforced_on_existing_holdings;
  const deconcControl = policy.deconcentration_plan_enabled
    ? resolveDeconcentrationControl(input.portfolioDb, input.accountId, input.holdings)
    : { active: false, mode: 'STANDARD' as DeconcentrationPlanMode };
  const deconcentrationActive = policy.deconcentration_plan_enabled
    ? (input.deconcentrationActive ?? deconcControl.active)
    : false;
  // 高水位/熔断只覆盖可投资净值（现金+证券）；理财 wealth 不计入 buildNavSeries 的单位化，
  // 因此从比较 NAV 中一并剔除，避免“证券+理财”与“证券+现金”两套口径互相打架。
  const wealthCents = input.wealthCents ?? 0;
  const hwmNavCents = Math.max(0, input.totalAssetsCents - wealthCents);
  const hwmBaselineCents = input.baselineTotalAssetsCents === undefined
    ? undefined
    : Math.max(0, input.baselineTotalAssetsCents - wealthCents);
  const fundamentalRegime: FundamentalRegimeResult = input.fundamentalRegime
    ?? (policy.fundamental_envelope_enabled
      ? evaluateFundamentalRegime(input.marketDb, input.asOf, {
          erpHighEnter: policy.fundamental_underval_erp_enter_bps / 10000,
          erpHighExit: policy.fundamental_underval_erp_exit_bps / 10000,
          bpHighEnter: policy.fundamental_underval_bp_enter_bps / 10000,
          bpHighExit: policy.fundamental_underval_bp_exit_bps / 10000,
          lowEnter: Math.min(policy.fundamental_bubble_erp_enter_bps, policy.fundamental_bubble_bp_enter_bps) / 10000,
          lowExit: Math.max(policy.fundamental_bubble_erp_exit_bps, policy.fundamental_bubble_bp_exit_bps) / 10000,
        })
      : evaluateFundamentalRegime(null, input.asOf));
  const router = evaluateStrategyRouter({
    portfolioDb: input.portfolioDb,
    marketDb: input.marketDb,
    accountId: input.accountId,
    asOf: input.asOf,
    currentNavCents: hwmNavCents,
    displayNavCents: input.totalAssetsCents,
    fallbackBaselineNavCents: hwmBaselineCents,
    marketRegime: regime,
    phase1LockStockSwing: input.phase1LockStockSwing,
    deconcentrationActive,
    deconcentrationMode: deconcControl.mode,
    policy,
    fundamentalRegime,
    fvoOverride: input.fvoOverride,
    fvoAttribution60dBps: input.fvoAttribution60dBps,
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
    planEnabled: policy.deconcentration_plan_enabled,
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

  // 运行时策略准入（默认未配置 = 不阻断）。SUSPEND/REVOKE 只冻结新增买入，
  // 止损、止盈与减仓卖出一律照常生成。
  const runtimeCanOpen = policy.runtime_can_open;
  if (!runtimeCanOpen) {
    const why = policy.override_diagnostics.length > 0
      ? `覆盖策略文件不可用（${policy.override_diagnostics[0]}）`
      : '策略准入状态为暂停/撤销（SUSPEND/REVOKE 仍在有效期）';
    blockers.push(`${why}：本次不生成任何新增买入；止损、止盈与现有减仓计划照常执行。`);
  }

  const { allEligible: superEligible, views: superViews } = buildSuperEtfViews(input.candidates, regime.style);
  const crossBorderMonitor = buildCrossBorderMonitor(input.candidates);
  const stockScreen = input.stockSwingScreen !== undefined
    ? input.stockSwingScreen
    : (router.sub_strategies.s_stock_swing === 'ACTIVE' && input.marketDb
      // 内部候选池取 max(持仓上限, 10)：前 2 名若不可买（如已被持仓）仍有替补可评估；
      // 实际新开仓数量仍由下方 policy.stock_max_positions 封顶。策略对象由上层一次加载。
      ? screenStockSwingCandidates(input.marketDb, input.asOf, {
          policy,
          maxCandidates: Math.max(policy.stock_max_positions, 10),
        })
      : null);
  const screenedStockCandidates = stockScreen?.candidates ?? [];
  // 对外披露仍只给 Top N（policy.stock_max_positions），仓位循环使用完整候选池。
  const stockSwingCandidates = screenedStockCandidates.slice(0, policy.stock_max_positions);

  const sectorScreen = input.sectorPioneerScreen !== undefined
    ? input.sectorPioneerScreen
    : (policy.sector_pioneer_enabled
        && router.circuit_breaker_status === 'NORMAL'
        && (router.effective_regime === 'OFFENSIVE' || router.effective_regime === 'STRUCTURAL')
        && input.marketDb
        ? screenSectorPioneerCandidates(input.marketDb, input.asOf, {
            etfScreen: input.candidates,
            maxCandidates: Math.max(policy.sector_pioneer_top_k, 3),
          })
        : null);
  const sectorPioneerCandidates = (sectorScreen?.candidates ?? []).slice(0, policy.sector_pioneer_top_k);

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
      fundamental_regime: fundamentalRegime,
      router,
      deconcentration,
      actions,
      blockers,
      reconciliation_reminder: reconciliationReminder,
      super_etf_candidates: superViews,
      cross_border_monitor: crossBorderMonitor,
      stock_swing_candidates: stockSwingCandidates,
      sector_pioneer_candidates: sectorPioneerCandidates,
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

  const investableAssetsCents = Math.max(0, input.totalAssetsCents - wealthCents);
  const minStockOrderCentsPre = policy.stock_min_order_cny * 100;
  const bp1ReverifyOk = (input.bp1Reverified ?? true)
    && (policy.stock_bp1_reverify_nav_cny <= 0 || hwmNavCents >= policy.stock_bp1_reverify_nav_cny * 100);
  if (
    router.sub_strategies.s_stock_swing === 'ACTIVE'
    && !bp1ReverifyOk
  ) {
    blockers.push(`可投资净值未通过开仓前 ${(policy.stock_bp1_reverify_nav_cny / 10000).toFixed(1)} 万元二次复核，本次暂不开新股。`);
  }
  const plannedStockSlots: Array<{ ts_code: string; target_cents: number }> = [];
  if (
    useExecArchV2
    && policy.lowvol_core_mode === 'CORE_40'
    && runtimeCanOpen
    && bp1ReverifyOk
    && router.circuit_breaker_status === 'NORMAL'
    && (router.effective_regime === 'OFFENSIVE' || router.effective_regime === 'STRUCTURAL')
    && router.sub_strategies.s_stock_swing === 'ACTIVE'
    && screenedStockCandidates.length > 0
  ) {
    let simOpenCount = input.holdings.filter(h => !isEtfCode(h.ts_code) && h.quantity > 0).length;
    let simHeldStockCents = input.holdings.reduce(
      (s, h) => s + (!isEtfCode(h.ts_code) && h.quantity > 0 ? h.market_value_cents : 0),
      0,
    );
    let simPioneerRem = Math.max(0, Math.round(investableAssetsCents * (router.targets.pioneer_bps / 10000)) - simHeldStockCents);
    for (const cand of screenedStockCandidates) {
      if (simOpenCount >= policy.stock_max_positions || simPioneerRem < minStockOrderCentsPre) break;
      if (input.holdings.some(h => h.ts_code === cand.ts_code && h.quantity > 0)) continue;
      if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
      const rules = feeFor(cand.ts_code, 'STOCK');
      const sized = sizeStockSwingOrder({
        navCents: investableAssetsCents,
        entryPriceMilli: cand.entry_ref_price_milli,
        hardStopPriceMilli: cand.hard_stop_price_milli,
        availableCashCents: simPioneerRem,
        commissionRate: rules.commission_rate,
        commissionMinCents: rules.commission_min_cents,
        transferFeeRate: rules.transfer_fee_rate,
        maxRiskBps: policy.stock_risk_budget_bps,
        maxWeightBps: policy.stock_max_single_weight_bps,
        minOrderCents: minStockOrderCentsPre,
      });
      if (sized.shares < 100 || sized.skipped_reason !== null) continue;
      plannedStockSlots.push({ ts_code: cand.ts_code, target_cents: sized.gross_cents });
      simPioneerRem = Math.max(0, simPioneerRem - sized.gross_cents);
      simOpenCount += 1;
    }
  }
  const p0CapCheckBps = router.circuit_breaker_status === 'L2_LOCKED'
    ? router.targets.target_equity_bps
    : router.drawdown_equity_cap_bps;
  const p0ReduceApplied = p0CapCheckBps !== null && input.holdings.reduce(
    (s, h) => s + (isRiskEquityHolding(h.ts_code) ? h.market_value_cents : 0),
    0,
  ) > Math.round(investableAssetsCents * (p0CapCheckBps / 10000)) + Math.round(investableAssetsCents * 0.02);

  const targetPortfolio: TargetPortfolioResult | null = useExecArchV2
    ? buildTargetPortfolio({
        policy,
        router,
        marketRegime: regime,
        investableAssetsCents,
        asOf: input.asOf,
        holdings: input.holdings,
        candidates: input.candidates,
        sectorPioneerCandidates,
        plannedStockSlots,
        p0ReduceApplied,
      })
    : null;

  const pendingSells = new Map<string, PendingRiskSell>();
  const soldCodesToday = new Set<string>();
  let p0SoldCents = 0;
  let p1SoldCents = 0;
  let p2SoldCents = 0;
  let p3SoldCents = 0;

  const priorityRank = (p: 'P0' | 'P1' | 'P2' | 'P3'): number =>
    p === 'P0' ? 0 : p === 'P1' ? 1 : p === 'P2' ? 2 : 3;

  const addPendingSell = (opts: {
    priority: 'P0' | 'P1' | 'P2' | 'P3';
    tsCode: string;
    name: string;
    sleeve: PortfolioSleeve;
    priceMilli: number;
    latestBarDate: string | null;
    shares: number;
    code: string;
    title: string;
    reason: string;
    counterEvidence: string;
    reasonCode: string;
    trigger: string;
    invalidation: string;
    riskImpact: string;
  }) => {
    if (opts.shares < 100) return;
    soldCodesToday.add(opts.tsCode);
    const existing = pendingSells.get(opts.tsCode);
    if (!existing) {
      pendingSells.set(opts.tsCode, {
        ts_code: opts.tsCode,
        name: opts.name,
        sleeve: opts.sleeve,
        price_milli: opts.priceMilli,
        latest_bar_date: opts.latestBarDate,
        p0_shares: opts.priority === 'P0' ? opts.shares : 0,
        p1_shares: opts.priority === 'P1' ? opts.shares : 0,
        p2_shares: opts.priority === 'P2' ? opts.shares : 0,
        p3_shares: opts.priority === 'P3' ? opts.shares : 0,
        highest_priority: opts.priority,
        p0_code: opts.priority === 'P0' ? opts.code : null,
        p1_code: opts.priority === 'P1' ? opts.code : null,
        p2_code: opts.priority === 'P2' ? opts.code : null,
        p3_code: opts.priority === 'P3' ? opts.code : null,
        titles: [opts.title],
        reasons: [opts.reason],
        counter_evidence: [opts.counterEvidence],
        reason_codes: [opts.reasonCode],
        triggers: [opts.trigger],
        invalidation_conditions: [opts.invalidation],
        risk_impact: [opts.riskImpact],
      });
      return;
    }
    if (opts.priority === 'P0') { existing.p0_shares += opts.shares; existing.p0_code = existing.p0_code ?? opts.code; }
    else if (opts.priority === 'P1') { existing.p1_shares += opts.shares; existing.p1_code = existing.p1_code ?? opts.code; }
    else if (opts.priority === 'P2') { existing.p2_shares += opts.shares; existing.p2_code = existing.p2_code ?? opts.code; }
    else { existing.p3_shares += opts.shares; existing.p3_code = existing.p3_code ?? opts.code; }
    if (priorityRank(opts.priority) < priorityRank(existing.highest_priority)) {
      existing.highest_priority = opts.priority;
    }
    if (!existing.titles.includes(opts.title)) existing.titles.push(opts.title);
    if (!existing.reasons.includes(opts.reason)) existing.reasons.push(opts.reason);
    if (!existing.counter_evidence.includes(opts.counterEvidence)) existing.counter_evidence.push(opts.counterEvidence);
    if (!existing.reason_codes.includes(opts.reasonCode)) existing.reason_codes.push(opts.reasonCode);
    if (!existing.triggers.includes(opts.trigger)) existing.triggers.push(opts.trigger);
    if (!existing.invalidation_conditions.includes(opts.invalidation)) existing.invalidation_conditions.push(opts.invalidation);
    if (!existing.risk_impact.includes(opts.riskImpact)) existing.risk_impact.push(opts.riskImpact);
  };

  // -------------------------------- P0: 高水位账户熔断/渐进风控强压风险权益仓位（国债/货基豁免）
  if (useExecArchV2 && targetPortfolio) {
    const p0CapBps = router.circuit_breaker_status === 'L2_LOCKED'
      ? router.targets.target_equity_bps
      : router.drawdown_equity_cap_bps;
    if (p0CapBps !== null) {
      const capPct = p0CapBps / 100;
      const maxEquityCents = Math.round(investableAssetsCents * (p0CapBps / 10000));
      const deadbandCents = Math.round(investableAssetsCents * 0.02);
      const currentEquityCents = input.holdings.reduce(
        (s, h) => s + (isRiskEquityHolding(h.ts_code) ? h.market_value_cents : 0),
        0,
      );
      if (currentEquityCents > maxEquityCents + deadbandCents) {
        let remainingNeeded = currentEquityCents - maxEquityCents;
        const dustThresholdCents = Math.round(investableAssetsCents * 0.02);
        const isL2 = router.circuit_breaker_status === 'L2_LOCKED';
        const triggerPct = router.l2_trigger_drawdown_bps / 100;
        const triggerPctText = Math.round(triggerPct * 10) % 10 === 0 ? triggerPct.toFixed(0) : triggerPct.toFixed(1);

        const applyP0Sell = (h: RunActionEngineInput['holdings'][number], sellShares: number, notePrefix: string) => {
          const maxLots = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
          const actual = Math.min(maxLots, Math.floor(sellShares / 100) * 100);
          if (actual < 100 || !(h.price_milli > 0)) return;
          const kind: 'ETF' | 'STOCK' = isEtfCode(h.ts_code) ? 'ETF' : 'STOCK';
          const rules = feeFor(h.ts_code, kind);
          const priceCents = h.price_milli / 10;
          const grossCents = roundCent(actual * priceCents);
          const fees = calculateFees(grossCents, 'sell', rules);
          const netCents = grossCents - fees.total_cents;
          workingQty.set(h.ts_code, Math.max(0, (workingQty.get(h.ts_code) ?? 0) - actual));
          workingSellable.set(h.ts_code, Math.max(0, maxLots - actual));
          workingCashCents += netCents;
          p0SoldCents += grossCents;
          remainingNeeded = Math.max(0, remainingNeeded - grossCents);
          const slot = targetPortfolio.slots.get(h.ts_code);
          const sleeve: PortfolioSleeve = slot?.sleeve ?? classifyHoldingSleeve(h.ts_code, {
            activeSectorPioneerCodes: targetPortfolio.activeSectorPioneerCodes,
            bondCodes: targetPortfolio.bondCodes,
            goldCodes: targetPortfolio.goldCodes,
          });
          addPendingSell({
            priority: 'P0',
            tsCode: h.ts_code,
            name: h.name,
            sleeve,
            priceMilli: h.price_milli,
            latestBarDate: h.latest_bar_date,
            shares: actual,
            code: isL2 ? `P0-BREAKER-SELL-${h.ts_code}` : `P0-DRAWDOWN-CAP-SELL-${h.ts_code}`,
            title: isL2
              ? `触发 ${triggerPctText}% 账户熔断线：减仓 ${h.name}（${h.ts_code}）`
              : `触发渐进回撤降仓线（权益上限 ${capPct.toFixed(0)}%）：减仓 ${h.name}（${h.ts_code}）`,
            reason: isL2
              ? `${notePrefix}账户较动态高水位回撤已达 ${router.anchor_snapshot.hwm_drawdown_pct.toFixed(2)}%（≥ ${triggerPctText}% 熔断线），压降风险权益至 ${capPct.toFixed(0)}% 以内（债基与现金保留防御席位）。`
              : `${notePrefix}工作高水位回撤已达 ${router.anchor_snapshot.work_hwm_drawdown_pct.toFixed(2)}%，按两段渐进风控将风险权益上限压降至 ${capPct.toFixed(0)}% 以内。`,
            counterEvidence: '若市场次日即刻大幅反弹将阶段性放弃对应高波参与度，但守住回撤生命线优先。',
            reasonCode: isL2 ? 'P0_CIRCUIT_BREAKER_LOCK' : 'P0_DRAWDOWN_GRADUAL_CAP',
            trigger: `次日开盘竞价或盘中限价卖出 ${h.ts_code}`,
            invalidation: '当日盘后账户回撤修复至风控警戒线之上',
            riskImpact: `压降风险权益至 ${capPct.toFixed(0)}% 上限以内，绝不被单日平滑换手上限截断`,
          });
        };

        const nonTargetRisk = input.holdings
          .filter(h => {
            if (!isRiskEquityHolding(h.ts_code) || !(h.price_milli > 0)) return false;
            if ((Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100) < 100) return false;
            return (targetPortfolio.slots.get(h.ts_code)?.target_cents ?? 0) === 0;
          });
        // 1) 优先清零非目标/遗留零碎仓（< 2% 可投资净值）
        const dustNonTarget = nonTargetRisk
          .filter(h => h.market_value_cents < dustThresholdCents)
          .slice()
          .sort((a, b) => a.market_value_cents - b.market_value_cents || a.ts_code.localeCompare(b.ts_code));
        for (const h of dustNonTarget) {
          if (remainingNeeded <= 0) break;
          const sellable = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
          applyP0Sell(h, sellable, '优先清出非目标零碎仓：');
        }
        // 2) 其余非目标/遗留风险仓按市值比例分摊压降
        if (remainingNeeded > 0) {
          const remLegacy = nonTargetRisk
            .filter(h => (workingSellable.get(h.ts_code) ?? 0) >= 100)
            .map(h => ({
              h,
              valueCents: roundCent((workingQty.get(h.ts_code) ?? 0) * (h.price_milli / 10)),
            }))
            .filter(x => x.valueCents > 0);
          const alloc = allocateProportionalSellLots(
            remLegacy.map(x => ({ ts_code: x.h.ts_code, valueCents: x.valueCents, priceMilli: x.h.price_milli })),
            remainingNeeded,
            workingSellable,
          );
          for (const item of remLegacy) {
            const shares = alloc.get(item.h.ts_code) ?? 0;
            if (shares >= 100) applyP0Sell(item.h, shares, '优先按市值比例压降非目标存量仓位：');
          }
        }
        // 3) 若仍超上限，再对目标内风险仓按市值等比例压降（取代“先砸最大持仓”）
        if (remainingNeeded > 0) {
          const inTargetRisk = input.holdings
            .filter(h => {
              if (!isRiskEquityHolding(h.ts_code) || !(h.price_milli > 0)) return false;
              if ((Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100) < 100) return false;
              return (targetPortfolio.slots.get(h.ts_code)?.target_cents ?? 0) > 0;
            })
            .map(h => ({
              h,
              valueCents: roundCent((workingQty.get(h.ts_code) ?? 0) * (h.price_milli / 10)),
            }))
            .filter(x => x.valueCents > 0);
          const alloc = allocateProportionalSellLots(
            inTargetRisk.map(x => ({ ts_code: x.h.ts_code, valueCents: x.valueCents, priceMilli: x.h.price_milli })),
            remainingNeeded,
            workingSellable,
          );
          for (const item of inTargetRisk) {
            const shares = alloc.get(item.h.ts_code) ?? 0;
            if (shares >= 100) applyP0Sell(item.h, shares, '对目标内风险仓按比例等比压降：');
          }
        }
      }
    }
  } else if (router.circuit_breaker_status === 'L2_LOCKED') {
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
          title: `触发${Math.round(triggerPct * 10) % 10 === 0 ? triggerPct.toFixed(0) : triggerPct.toFixed(1)}%账户熔断线：减仓 ${h.name}（${h.ts_code}）`,
          reasons: [
            `账户较动态高水位回撤已达 ${router.anchor_snapshot.hwm_drawdown_pct.toFixed(2)}%（≥ ${Math.round(triggerPct * 10) % 10 === 0 ? triggerPct.toFixed(0) : triggerPct.toFixed(1)}% 熔断红线），无条件压降风险权益仓位至 ${targetEquityPct.toFixed(0)}%${targetEquityPct === 0 ? '' : '以内'}（国债与现金基金保留防御席位）。`,
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
  } else if (router.drawdown_equity_cap_bps !== null) {
    const capPct = router.drawdown_equity_cap_bps / 100;
    const maxEquityCents = Math.round(hwmNavCents * (router.drawdown_equity_cap_bps / 10000));
    const deadbandCents = Math.round(hwmNavCents * 0.02);
    let currentEquityCents = input.holdings.reduce(
      (s, h) => s + (isRiskEquityHolding(h.ts_code) ? h.market_value_cents : 0),
      0,
    );
    if (currentEquityCents > maxEquityCents + deadbandCents) {
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
          code: `P0-DRAWDOWN-CAP-SELL-${h.ts_code}`,
          kind: 'REDUCE',
          rank: actions.length + 1,
          title: `触发渐进回撤降仓线（权益上限 ${capPct.toFixed(0)}%）：减仓 ${h.name}（${h.ts_code}）`,
          reasons: [
            `工作高水位回撤已达 ${router.anchor_snapshot.work_hwm_drawdown_pct.toFixed(2)}%，按两段渐进风控规则将风险权益上限压降至 ${capPct.toFixed(0)}%，提前降低继续回撤触及硬熔断线的概率。`,
            `卖出回款留作账户可用现金或低票面国债蓄水池防御仓位。`,
          ],
          counter_evidence: ['若市场即刻大幅反弹将阶段性降低高波弹性参与度，但可保护回撤生命线。'],
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
            reason: 'P0_DRAWDOWN_GRADUAL_CAP',
          }],
          fees_cents: fees.total_cents,
          fees_estimated: Boolean(rules.fee_model?.estimated),
          triggers: [`次日开盘或盘中限价卖出 ${sellShares} 份 ${h.ts_code}`],
          invalidation_conditions: ['当日盘后净值回升至回撤警戒线之上'],
          risk_impact: [`将风险权益权重压降至 ${capPct.toFixed(0)}% 以内，防止硬熔断拉锯`],
        });
      }
    }
  }

  // -------------------------------- P1: 个股 -8% 硬止损 / +15% 保本 / 收盘跌破 MA20 无条件离场（ETF 仅按 p1_etf_trailing_sleeves 控制移动止盈，绝不触发 -8% 硬止损）
  // tracker 生命周期由真实持仓驱动：仍持有则保持 OPEN（即使本轮建议卖出），
  // 持仓已消失的 OPEN 行才转 CLOSED；持有但旧行为 CLOSED 视为重新建仓。
  const trackerByCode = new Map<string, StopTrackerRow>();
  if (portfolioTableExists(input.portfolioDb, 'position_stop_tracker') && input.portfolioDb) {
    const rows = input.portfolioDb.prepare(
      'SELECT * FROM position_stop_tracker WHERE account_id = ?',
    ).all(input.accountId) as unknown as StopTrackerRow[];
    for (const r of rows) trackerByCode.set(r.ts_code, r);
  }

  const allowAllEtfSleeves = policy.p1_etf_trailing_sleeves.includes('ALL');
  for (const h of input.holdings) {
    const isStock = !isEtfCode(h.ts_code);
    const tracked = trackerByCode.get(h.ts_code);
    const continuing = tracked?.status === 'OPEN';
    const sleeve: PortfolioSleeve = isStock
      ? 'STOCK_BP1'
      : classifyHoldingSleeve(h.ts_code, {
          activeSectorPioneerCodes: targetPortfolio?.activeSectorPioneerCodes,
          bondCodes: targetPortfolio?.bondCodes,
          goldCodes: targetPortfolio?.goldCodes,
          includeInactiveSectorPoolAsPioneer: policy.sector_pioneer_enabled,
        });
    if (!isStock) {
      const sleeveAllowed = allowAllEtfSleeves || policy.p1_etf_trailing_sleeves.includes(sleeve);
      if (!sleeveAllowed) continue;
      if (allowAllEtfSleeves && !tracked) continue;
    }
    const remSellable = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
    if (!useExecArchV2 && remSellable < 100) continue;
    if (h.quantity <= 0 || !(h.price_milli > 0)) continue;
    if (isStock && !tradabilityOf(h.ts_code, { kind: 'STOCK', board: inferBoard(h.ts_code) }).tradable && remSellable < 100) continue;

    const adjTable: AdjTable = isStock ? 'adj_factor' : 'fund_adj';
    const currentAdj = adjFactorAt(input.marketDb, h.ts_code, input.asOf, adjTable);
    let initEntryDate = input.asOf;
    let initEntryMilli = h.ref_cost_milli ?? h.price_milli;
    let initEntryAdj = currentAdj;
    if (!continuing && !isStock && sleeve === 'SECTOR_PIONEER') {
      const fromLedger = resolveInitialEntryFromLedger(input.portfolioDb, input.accountId, h.ts_code, input.asOf);
      if (fromLedger) {
        initEntryDate = fromLedger.entryDate;
        initEntryMilli = fromLedger.entryPriceMilli;
        initEntryAdj = adjFactorAt(input.marketDb, h.ts_code, initEntryDate, adjTable);
      }
    }

    const entryMilli = continuing ? tracked!.entry_price_milli : initEntryMilli;
    const initialStopMilli = continuing ? tracked!.initial_stop_milli : Math.round(entryMilli * 0.92);
    let currentStopMilli = continuing ? tracked!.current_stop_milli : initialStopMilli;
    let ma20Armed = continuing ? tracked!.trailing_ma20_armed : 0;

    // 复权基准换算：tracker 内价格按 entry 基准（entry_adj_factor）存储。除权/拆股后
    // adj_factor 上升而原始价下跌，因此历史价的 asOf 原始口径等价价 =
    // stored × entryAdj / currentAdj（本地缓存复权因子口径）。绝不对 h.price_milli 缩放。
    // 旧 OPEN 行缺 entry 基准时回查 entry_date 的真实因子（股票 adj_factor / ETF fund_adj）；
    // 查不到则保持 NULL。只有 entry 与 as-of 两个真实因子齐备时才缩放；缺失任一侧
    // 一律跳过比值（不缩放、不写 1 冒充）。
    const entryAdj = continuing
      ? (tracked!.entry_adj_factor ?? adjFactorAt(input.marketDb, h.ts_code, tracked!.entry_date, adjTable))
      : initEntryAdj;
    const basisRatio = entryAdj !== null && currentAdj !== null && entryAdj > 0 && currentAdj > 0
      ? entryAdj / currentAdj
      : 1;
    const scaledEntryMilli = Math.round(entryMilli * basisRatio);
    let scaledCurrentStopMilli = Math.round(currentStopMilli * basisRatio);

    if (h.price_milli >= Math.round(scaledEntryMilli * 1.15)) {
      ma20Armed = 1;
      currentStopMilli = Math.max(currentStopMilli, entryMilli);
      scaledCurrentStopMilli = Math.round(currentStopMilli * basisRatio);
    }

    const ma20Milli = computeMa20Milli(
      input.marketDb, h.ts_code, input.asOf,
      isStock ? 'daily' : 'fund_daily',
      isStock ? 'adj_factor' : 'fund_adj',
    );
    // -8% 硬止损严格限定仅对主板个股（STOCK_BP1）生效；ETF 严禁触发硬止损。
    const hardStopHit = isStock && h.price_milli <= scaledCurrentStopMilli;
    // EXP-V3-02（research/ashare/experiments/exp_v3_02_stock_swing_rqalpha.py）：
    // 个股在硬止损之后，收盘价 < MA20 即无条件离场，不依赖 +15% 武装；ETF tracker
    // 行保持“浮盈 +15% 后才启用 MA20 移动止盈”的语义。
    const trailingExitHit = ma20Milli !== null && h.price_milli < ma20Milli && (isStock || ma20Armed === 1);

    stopTrackerUpdates.push({
      account_id: input.accountId,
      ts_code: h.ts_code,
      entry_date: continuing ? tracked!.entry_date : initEntryDate,
      entry_price_milli: entryMilli,
      initial_stop_milli: initialStopMilli,
      current_stop_milli: currentStopMilli,
      trailing_ma20_armed: ma20Armed,
      entry_adj_factor: entryAdj,
      // 只要本轮仍真实持有，即使建议卖出也保持 OPEN；CLOSED 由持仓消失驱动。
      status: 'OPEN',
      updated_at: input.asOf,
    });

    if ((hardStopHit || trailingExitHit) && remSellable >= 100) {
      const kind: 'ETF' | 'STOCK' = isStock ? 'STOCK' : 'ETF';
      const rules = feeFor(h.ts_code, kind);
      const priceCents = h.price_milli / 10;
      const grossCents = roundCent(remSellable * priceCents);
      const fees = calculateFees(grossCents, 'sell', rules);
      const netCents = grossCents - fees.total_cents;
      workingQty.set(h.ts_code, Math.max(0, (workingQty.get(h.ts_code) ?? 0) - remSellable));
      workingSellable.set(h.ts_code, 0);
      workingCashCents += netCents;
      p1SoldCents += grossCents;
      const stockMa20Exit = isStock && trailingExitHit && ma20Armed !== 1;
      const reasonText = hardStopHit
        ? `收盘价 ${(h.price_milli / 1000).toFixed(2)} 元跌破止损线 ${(scaledCurrentStopMilli / 1000).toFixed(2)} 元，无条件执行止损。`
        : stockMa20Exit
          ? `收盘价 ${(h.price_milli / 1000).toFixed(2)} 元跌破 20 日均线（${((ma20Milli ?? 0) / 1000).toFixed(2)} 元），个股波段规则无条件离场（EXP-V3-02 口径）。`
          : `浮盈曾达 15% 后收盘跌破 20 日均线（${((ma20Milli ?? 0) / 1000).toFixed(2)} 元），执行移动止盈离场。`;
      const p1Title = `${hardStopHit ? '触发硬止损清仓' : stockMa20Exit ? '个股跌破 20 日均线离场' : '触发移动止盈离场'}：卖出 ${h.name}（${h.ts_code}）`;
      const p1ReasonCode = hardStopHit ? 'P1_HARD_STOP_8PCT' : stockMa20Exit ? 'P1_MA20_EXIT' : 'P1_TRAILING_MA20_STOP';
      if (useExecArchV2) {
        addPendingSell({
          priority: 'P1',
          tsCode: h.ts_code,
          name: h.name,
          sleeve,
          priceMilli: h.price_milli,
          latestBarDate: h.latest_bar_date,
          shares: remSellable,
          code: `P1-STOP-SELL-${h.ts_code}`,
          title: p1Title,
          reason: reasonText,
          counterEvidence: '短期洗盘可能次日反包，但单笔严守止损/止盈纪律优先。',
          reasonCode: p1ReasonCode,
          trigger: `下一交易日按市价/限价清仓全部可卖 ${remSellable} 股/份`,
          invalidation: '交易前标的已停牌',
          riskImpact: '切断单笔下行尾部亏损或兑现移动止盈，释放可用资金',
        });
      } else {
        actions.push({
          priority: 'P1',
          code: `P1-STOP-SELL-${h.ts_code}`,
          kind: 'REDUCE',
          rank: actions.length + 1,
          title: p1Title,
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
            reason: p1ReasonCode,
          }],
          fees_cents: fees.total_cents,
          fees_estimated: Boolean(rules.fee_model?.estimated),
          triggers: [`下一交易日按市价/限价清仓全部可卖 ${remSellable} 股`],
          invalidation_conditions: ['交易前标的已停牌'],
          risk_impact: ['切断单笔下行尾部亏损，释放可用资金'],
        });
      }
    }
  }

  // 已从当前持仓消失的 OPEN tracker 才转 CLOSED；卖出建议被忽略时保持 OPEN 与保本线。
  const heldCodes = new Set(input.holdings.filter(h => h.quantity > 0).map(h => h.ts_code));
  for (const r of trackerByCode.values()) {
    if (r.status !== 'OPEN' || heldCodes.has(r.ts_code)) continue;
    stopTrackerUpdates.push({
      ...r,
      entry_adj_factor: r.entry_adj_factor ?? null,
      status: 'CLOSED',
      updated_at: input.asOf,
    });
  }

  // -------------------------------- P2: 159558.SZ 状态机减仓 / 磨底降本高抛低吸（停用时完全旁路）
  const keepPctLabel = (deconcentration.target_keep_bps / 100).toFixed(0);
  if (policy.deconcentration_plan_enabled && deconcentration.plan_present && deconcentration.recommended_sell_shares >= 100) {
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
      p2SoldCents += grossCents;

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

      if (useExecArchV2) {
        addPendingSell({
          priority: 'P2',
          tsCode: '159558.SZ',
          name: h159558.name,
          sleeve: targetPortfolio?.slots.get('159558.SZ')?.sleeve ?? 'UNMANAGED_LEGACY',
          priceMilli: h159558.price_milli,
          latestBarDate: h159558.latest_bar_date,
          shares: sellShares,
          code: actionCode,
          title: actionTitle,
          reason: actionReasons[0],
          counterEvidence: '若半导体板块次日继续脉冲拉升，已减仓部分不再享受后续涨幅。',
          reasonCode: `P2_${reason ?? 'TRANCHE_TRIGGERED'}`,
          trigger: `次日开盘或盘中分笔限价卖出 ${sellShares} 份 159558.SZ`,
          invalidation: '成交并在账本录入卖出事件后自动更新',
          riskImpact: `有序维持 159558.SZ 约 ${keepPctLabel}% 核心底仓并锁盈降本`,
        });
      } else {
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
    }
  } else if (
    policy.deconcentration_plan_enabled
    && deconcentration.plan_present
    && deconcentration.plan_mode === 'BOTTOM_GRIND_25'
    && deconcentration.recommended_buy_shares >= 100
    && router.circuit_breaker_status === 'NORMAL'
    && runtimeCanOpen
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
                `25%底仓降本回补条件满足：60日均线10日斜率 ${guards?.ma60_slope10_pct?.toFixed(2) ?? '0.00'}%（未下行）、折价目标 ${(guards?.reload_target_cny ?? 0).toFixed(3)} 元达成、近3日出现极值超卖，且当日收阳、收盘 >= MA5×0.995（3 日冷却与 <30% 仓位上限为系统附加护栏，非 EXP-V3-04 签发条件）。`,
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

  // -------------------------------- 共享估值与国债蓄水池辅助（V2 P3-SELL align_due 与 P3-BUY 共用）
  const cashBufferCents = 10_000;
  const targetBaseEtfCents = Math.round(investableAssetsCents * (router.targets.base_super_etf_bps / 10000));
  const targetSectorPioneerCents = Math.round(investableAssetsCents * (router.targets.sector_pioneer_bps / 10000));
  const targetPioneerCents = Math.round(investableAssetsCents * (router.targets.pioneer_bps / 10000));
  const targetDefensiveCents = Math.round(investableAssetsCents * (router.targets.defensive_cash_bps / 10000));
  const driftBandCents = Math.round(investableAssetsCents * (policy.equity_align_drift_band_bps / 10000));

  const superByCode = new Map(superEligible.map(row => [row.ts_code, row]));
  const holdingPriceMilli = (code: string): number =>
    input.holdings.find(h => h.ts_code === code)?.price_milli ?? 0;
  const priceMilliOf = (code: string): number => {
    const close = superByCode.get(code)?.data.latest_close_milli ?? 0;
    return close > 0 ? close : holdingPriceMilli(code);
  };
  const heldValueCents = (code: string): number => {
    const qty = workingQty.get(code) ?? 0;
    if (qty <= 0) return 0;
    const price = priceMilliOf(code);
    return price > 0 ? roundCent(qty * (price / 10)) : 0;
  };

  // 防御资产 = 现金 + 全部国债蓄水池持仓市值（v3.3.0+ 优先级 159649.SZ -> 511260.SH -> 511010.SH）。
  const reservoirCodes: string[] = [];
  for (const raw of [
    policy.defensive_bond_reservoir_etf,
    policy.defensive_bond_reservoir_fallback_etf,
    policy.defensive_bond_reservoir_tertiary_etf,
    '511010.SH',
  ]) {
    if (raw && !reservoirCodes.includes(raw)) reservoirCodes.push(raw);
  }
  const quoteOfBond = (code: string) => {
    const row = (input.candidates?.candidates ?? []).find(r => r.ts_code === code);
    const holding = input.holdings.find(h => h.ts_code === code);
    const freshQuoteMilli = row
      && row.data.latest_bar_date === input.asOf
      && (row.data.latest_close_milli ?? 0) > 0
      ? row.data.latest_close_milli!
      : 0;
    const priceMilli = freshQuoteMilli > 0 ? freshQuoteMilli : (holding?.price_milli ?? 0);
    const quoteDate = freshQuoteMilli > 0
      ? row!.data.latest_bar_date
      : (holding?.latest_bar_date ?? null);
    return { row, holding, freshQuoteMilli, priceMilli, quoteDate };
  };
  const totalReservoirHeldCents = (): number | null => {
    let sum = 0;
    for (const code of reservoirCodes) {
      const qty = workingQty.get(code) ?? 0;
      if (qty <= 0) continue;
      const { priceMilli } = quoteOfBond(code);
      if (!(priceMilli > 0)) return null;
      sum += roundCent(qty * (priceMilli / 10));
    }
    return sum;
  };
  const defensiveAssetsCents = (): number | null => {
    const bondCents = totalReservoirHeldCents();
    return bondCents === null ? null : workingCashCents + bondCents;
  };

  let inferredRegimeOrStyleChanged = false;
  if (input.regimeOrStyleChanged === undefined) {
    let matchedMeta = false;
    if (input.portfolioDb && portfolioTableExists(input.portfolioDb, 'account_meta')) {
      try {
        const meta = input.portfolioDb.prepare('SELECT value FROM account_meta WHERE key = ?')
          .get(`v3_last_regime_style:${input.accountId}`) as { value?: string } | undefined;
        const parsed = meta?.value ? parseRegimeStyleHistory(String(meta.value)) : null;
        if (parsed) {
          const refPoint = parsed.curr.date < input.asOf
            ? parsed.curr
            : (parsed.curr.date === input.asOf && parsed.prev && parsed.prev.date < input.asOf ? parsed.prev : null);
          if (refPoint) {
            matchedMeta = true;
            inferredRegimeOrStyleChanged = policy.align_trigger_mode === 'REGIME_ONLY'
              ? (refPoint.regime !== router.effective_regime
                  || (refPoint.eff_budget_bps !== undefined && refPoint.eff_budget_bps !== router.targets.target_equity_bps))
              : (refPoint.regime !== router.effective_regime || refPoint.style !== regime.style);
          }
        }
      } catch { /* 只读或无记录则回退 history 推断 */ }
    }
    if (!matchedMeta) {
      const prevPt = regime.history.length >= 2 ? regime.history[regime.history.length - 2] : null;
      inferredRegimeOrStyleChanged = Boolean(
        regime.recovery_state?.triggered_today
        || regime.recovery_state?.stopped_today
        || (prevPt && prevPt.confirmed_regime !== regime.regime),
      );
    }
  }
  const regimeOrStyleChanged = input.regimeOrStyleChanged !== undefined
    ? input.regimeOrStyleChanged
    : inferredRegimeOrStyleChanged;
  const p0Triggered = p0SoldCents > 0;

  // -------------------------------- V3 执行架构 2.0：P3-SELL 双向目标对齐卖出（含无状态 2 日收敛 + P0 协同）与卖出腿合并
  let alignDue = false;
  let preSellExcessCents = 0;
  let targetGlideSellCents = 0;
  let unmanagedLegacyBeforeCents = 0;
  if (useExecArchV2 && targetPortfolio) {
    const dustDeadbandCents = Math.round(investableAssetsCents * 0.02);
    let hasNonTargetRisk = false;
    for (const h of input.holdings) {
      if (h.quantity <= 0) continue;
      if (!isRiskEquityHolding(h.ts_code)) continue;
      const slot = targetPortfolio.slots.get(h.ts_code);
      if ((slot?.target_cents ?? 0) === 0) {
        hasNonTargetRisk = true;
        if (slot?.sleeve === 'UNMANAGED_LEGACY') unmanagedLegacyBeforeCents += h.market_value_cents;
      }
    }
    // P-3: 偏离按 P0 后持仓与目标权重比较（各槽位可配独立漂移带，如黄金 400bps / 卫星 1000bps）；另加债基 1000bps 偏离判定
    let anySlotDriftExceeded = false;
    for (const slot of targetPortfolio.slots.values()) {
      if (!isRiskEquitySleeve(slot.sleeve) || slot.target_cents <= 0) continue;
      const postP0Held = heldValueCents(slot.ts_code);
      const drift = Math.abs(slot.target_cents - postP0Held);
      const slotBandCents = Math.round(
        investableAssetsCents * ((slot.drift_band_bps || policy.equity_align_drift_band_bps) / 10000),
      );
      if (drift >= slotBandCents) {
        anySlotDriftExceeded = true;
      }
    }
    const curBondForAlign = totalReservoirHeldCents() ?? 0;
    const targetBondSlotCents = targetPortfolio.primaryBondCode
      ? (targetPortfolio.slots.get(targetPortfolio.primaryBondCode)?.target_cents ?? 0)
      : Math.max(0, targetDefensiveCents - cashBufferCents);
    const bondDriftCents = Math.abs(targetBondSlotCents - curBondForAlign);
    const bondDriftBandCents = Math.round(investableAssetsCents * (policy.defensive_bond_reservoir_drift_band_bps / 10000));

    alignDue = input.alignDue !== undefined
      ? input.alignDue
      : Boolean(
          router.circuit_breaker_status !== 'L2_LOCKED'
          && (
            hasNonTargetRisk
            || regimeOrStyleChanged
            || router.just_unlocked
            || p0Triggered
            || anySlotDriftExceeded
            || bondDriftCents >= bondDriftBandCents
          ),
        );

    // P-1: 对齐日计入所有风险权益持仓（含目标内小幅超配）的 max(0, held - target)，不按漂移带过滤卖出
    for (const h of input.holdings) {
      if (!isRiskEquityHolding(h.ts_code) || h.quantity <= 0) continue;
      const targetCents = targetPortfolio.slots.get(h.ts_code)?.target_cents ?? 0;
      if (h.market_value_cents > targetCents) {
        preSellExcessCents += h.market_value_cents - targetCents;
      }
    }

    if (router.circuit_breaker_status !== 'L2_LOCKED' && alignDue && preSellExcessCents > 0) {
      const carryoverCapCents = Math.round(investableAssetsCents * (policy.align_glide_carryover_bps / 10000));
      if (carryoverCapCents <= 0 || preSellExcessCents <= carryoverCapCents + dustDeadbandCents) {
        targetGlideSellCents = preSellExcessCents;
      } else {
        targetGlideSellCents = Math.max(carryoverCapCents, preSellExcessCents - carryoverCapCents);
      }

      let remainingAllowance = Math.max(0, targetGlideSellCents - p0SoldCents - p1SoldCents - p2SoldCents);
      if (remainingAllowance > 0) {
        const applyP3Sell = (h: RunActionEngineInput['holdings'][number], shares: number, isClearance: boolean) => {
          const maxLots = Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100;
          const actual = Math.min(maxLots, Math.floor(shares / 100) * 100);
          if (actual < 100 || !(h.price_milli > 0)) return;
          const priceCents = h.price_milli / 10;
          const grossCents = roundCent(actual * priceCents);
          const minNonClearSellCents = targetPortfolio.goldCodes.has(h.ts_code)
            ? Math.max(500_000, (policy.gold_core_min_trade_cny ?? 5000) * 100)
            : 200_000;
          if (!isClearance && !SUPER_SET.has(h.ts_code) && grossCents < minNonClearSellCents) return;
          const kind: 'ETF' | 'STOCK' = isEtfCode(h.ts_code) ? 'ETF' : 'STOCK';
          const rules = feeFor(h.ts_code, kind);
          const fees = calculateFees(grossCents, 'sell', rules);
          const netCents = grossCents - fees.total_cents;
          workingQty.set(h.ts_code, Math.max(0, (workingQty.get(h.ts_code) ?? 0) - actual));
          workingSellable.set(h.ts_code, Math.max(0, maxLots - actual));
          workingCashCents += netCents;
          p3SoldCents += grossCents;
          remainingAllowance = Math.max(0, remainingAllowance - grossCents);
          const slot = targetPortfolio.slots.get(h.ts_code);
          const sleeve: PortfolioSleeve = slot?.sleeve ?? classifyHoldingSleeve(h.ts_code, {
            activeSectorPioneerCodes: targetPortfolio.activeSectorPioneerCodes,
            bondCodes: targetPortfolio.bondCodes,
            goldCodes: targetPortfolio.goldCodes,
          });
          addPendingSell({
            priority: 'P3',
            tsCode: h.ts_code,
            name: h.name,
            sleeve,
            priceMilli: h.price_milli,
            latestBarDate: h.latest_bar_date,
            shares: actual,
            code: `P3-REGIME-ALIGN-SELL-${h.ts_code}`,
            title: isClearance
              ? `组合目标对齐清出非目标持仓：卖出 ${h.name}（${h.ts_code}）`
              : `组合目标对齐减仓：卖出 ${h.name}（${h.ts_code}）`,
            reason: isClearance
              ? `当前档位（${regime.regime_label_zh}）下 ${h.name} 不在目标组合内，按无状态单日换手平滑上限有序清出并回笼资金。`
              : `当前档位（${regime.regime_label_zh}）下 ${h.name} 超出目标权重，按组合双向对齐规则减持超额部分。`,
            counterEvidence: '若该标的次日短期反弹，卖出部分不再享有后续涨幅，但整体风险敞口已严格收敛至目标档位。',
            reasonCode: isClearance ? 'P3_REGIME_ALIGN_CLEAR_NON_TARGET' : 'P3_REGIME_ALIGN_TRIM_OVERWEIGHT',
            trigger: `次日开盘或盘中限价卖出 ${h.ts_code}`,
            invalidation: '市场档位切换或持仓变动导致目标差额消失',
            riskImpact: '消除非目标或超配暴露，维持目标组合权重一致',
          });
        };

        // 1) P-4: 优先处理非目标持仓（target_cents === 0）；按比例分摊后若剩余不足 2% 净值则直接清零（不留零碎尾仓）
        const postNonTarget = input.holdings
          .filter(h => {
            if (!isRiskEquityHolding(h.ts_code) || !(h.price_milli > 0)) return false;
            if ((Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100) < 100) return false;
            return (targetPortfolio.slots.get(h.ts_code)?.target_cents ?? 0) === 0;
          })
          .map(h => ({
            h,
            postValueCents: roundCent((workingQty.get(h.ts_code) ?? 0) * (h.price_milli / 10)),
          }))
          .filter(x => x.postValueCents > 0);

        if (postNonTarget.length > 0 && remainingAllowance > 0) {
          const alloc = allocateProportionalSellLots(
            postNonTarget.map(x => ({ ts_code: x.h.ts_code, valueCents: x.postValueCents, priceMilli: x.h.price_milli })),
            remainingAllowance,
            workingSellable,
          );
          for (const item of postNonTarget) {
            let shares = alloc.get(item.h.ts_code) ?? 0;
            const remAfterCents = item.postValueCents - roundCent(shares * (item.h.price_milli / 10));
            if (remAfterCents > 0 && remAfterCents < dustDeadbandCents) {
              shares = Math.floor((workingSellable.get(item.h.ts_code) ?? 0) / 100) * 100;
            }
            if (shares >= 100) applyP3Sell(item.h, shares, true);
          }
        }

        // 2) P-1: 若仍有平滑额度，对所有超配目标内持仓（postVal > targetCents）按超配差额分摊卖出
        if (remainingAllowance > 0) {
          const overweightInTarget = input.holdings
            .filter(h => {
              if (!isRiskEquityHolding(h.ts_code) || !(h.price_milli > 0)) return false;
              const targetCents = targetPortfolio.slots.get(h.ts_code)?.target_cents ?? 0;
              if (targetCents <= 0) return false;
              const postVal = roundCent((workingQty.get(h.ts_code) ?? 0) * (h.price_milli / 10));
              return postVal > targetCents;
            })
            .map(h => {
              const targetCents = targetPortfolio.slots.get(h.ts_code)!.target_cents;
              const postVal = roundCent((workingQty.get(h.ts_code) ?? 0) * (h.price_milli / 10));
              const excessVal = Math.max(0, postVal - targetCents);
              const maxExcessShares = Math.min(
                Math.floor((workingSellable.get(h.ts_code) ?? 0) / 100) * 100,
                Math.floor(excessVal / (h.price_milli / 10) / 100) * 100,
              );
              return { h, excessVal, maxExcessShares };
            })
            .filter(x => x.excessVal > 0 && x.maxExcessShares >= 100);

          const cappedSellable = new Map<string, number>(
            overweightInTarget.map(x => [x.h.ts_code, x.maxExcessShares]),
          );
          const alloc = allocateProportionalSellLots(
            overweightInTarget.map(x => ({ ts_code: x.h.ts_code, valueCents: x.excessVal, priceMilli: x.h.price_milli })),
            remainingAllowance,
            cappedSellable,
          );
          for (const item of overweightInTarget) {
            const shares = alloc.get(item.h.ts_code) ?? 0;
            if (shares >= 100) applyP3Sell(item.h, shares, false);
          }
        }
      }
    }

    // 统一落盘合并后的 SELL 腿：每只代码每日最多 1 条合并 SELL 动作
    const sortedPending = [...pendingSells.values()].sort(
      (a, b) => priorityRank(a.highest_priority) - priorityRank(b.highest_priority) || a.ts_code.localeCompare(b.ts_code),
    );
    for (const entry of sortedPending) {
      const totalShares = entry.p0_shares + entry.p1_shares + entry.p2_shares + entry.p3_shares;
      if (totalShares < 100) continue;
      const kind: 'ETF' | 'STOCK' = isEtfCode(entry.ts_code) ? 'ETF' : 'STOCK';
      const rules = feeFor(entry.ts_code, kind);
      const priceCents = entry.price_milli / 10;
      const grossCents = roundCent(totalShares * priceCents);
      const fees = calculateFees(grossCents, 'sell', rules);
      const netCents = grossCents - fees.total_cents;
      const actionCode = entry.p0_code ?? entry.p1_code ?? entry.p2_code ?? entry.p3_code ?? `P3-REGIME-ALIGN-SELL-${entry.ts_code}`;
      const mergedTitle = entry.titles.length === 1
        ? entry.titles[0]
        : `${entry.titles[0]}（合并减仓合计 ${totalShares} 份）`;
      actions.push({
        priority: entry.highest_priority,
        code: actionCode,
        kind: 'REDUCE',
        rank: actions.length + 1,
        title: mergedTitle,
        reasons: entry.reasons,
        counter_evidence: entry.counter_evidence.slice(0, 2),
        legs: [{
          side: 'SELL',
          ts_code: entry.ts_code,
          name: entry.name,
          quantity: totalShares,
          lot_size: 100,
          lots: totalShares / 100,
          price_milli: entry.price_milli,
          gross_cents: grossCents,
          fees_cents: fees.total_cents,
          net_cents: netCents,
          quote_trade_date: entry.latest_bar_date,
          executable: true,
          reason: entry.reason_codes.join('+'),
        }],
        fees_cents: fees.total_cents,
        fees_estimated: Boolean(rules.fee_model?.estimated),
        triggers: [`次日开盘或盘中限价卖出 ${totalShares} 股/份 ${entry.ts_code}（参考价 ${(entry.price_milli / 1000).toFixed(3)} 元）`],
        invalidation_conditions: entry.invalidation_conditions.slice(0, 2),
        risk_impact: entry.risk_impact.slice(0, 2),
      });
    }
  }

  // -------------------------------- P3: 个股波段先锋开仓 + 超级行业先导 + 底盘超级 ETF 风格桶 + 国债防御蓄水池（熔断期禁止新开多）
  let alignSummary: AlignSummaryView | undefined;
  const boughtCodesToday = new Set<string>();
  const minStockOrderCents = policy.stock_min_order_cny * 100;

  if (useExecArchV2 && targetPortfolio) {
    const routerEffectiveCapBps = router.circuit_breaker_status === 'L2_LOCKED'
      ? router.targets.target_equity_bps
      : (router.drawdown_equity_cap_bps !== null
          ? Math.min(router.targets.target_equity_bps, router.drawdown_equity_cap_bps)
          : router.targets.target_equity_bps);
    const maxAllowedRiskEquityCents = Math.round(investableAssetsCents * (routerEffectiveCapBps / 10000));
    const computeWorkingRiskEquityCents = (): number => {
      let sum = 0;
      for (const [code, qty] of workingQty.entries()) {
        if (!(qty > 0) || !isRiskEquityHolding(code)) continue;
        const pm = priceMilliOf(code)
          || (screenedStockCandidates.find(c => c.ts_code === code)?.entry_ref_price_milli ?? 0)
          || (sectorPioneerCandidates.find(c => c.ts_code === code)?.close_milli ?? 0);
        if (pm > 0) sum += roundCent(qty * (pm / 10));
      }
      return sum;
    };

    let riskEquityAfterSellsCents = computeWorkingRiskEquityCents();
    let remainingRiskEquityRoomCents = router.circuit_breaker_status === 'L2_LOCKED'
      ? 0
      : Math.max(0, maxAllowedRiskEquityCents - riskEquityAfterSellsCents);

    let stockHeldCents = 0;
    for (const h of input.holdings) {
      if (!isRiskEquityHolding(h.ts_code) || isEtfCode(h.ts_code)) continue;
      const qty = workingQty.get(h.ts_code) ?? h.quantity;
      stockHeldCents += roundCent(qty * (h.price_milli / 10));
    }
    let pioneerGapRemainingCents = Math.max(0, targetPioneerCents - stockHeldCents);

    const defensiveAssetsNow = defensiveAssetsCents();
    const cashRoomNowCents = defensiveAssetsNow === null
      ? Math.max(0, workingCashCents)
      : Math.max(0, defensiveAssetsNow - targetDefensiveCents);

    const etfLegs: ActionEngineLeg[] = [];
    const etfReasons: string[] = [
      policy.lowvol_core_permanent_share_bps > 0
        ? `当前处于${regime.regime_label_zh}且${regime.style_label_zh}，保留 ${(policy.lowvol_core_permanent_share_bps / 100).toFixed(0)}% 永久红利低波核心并按声明桶顺序配置成长与价值底盘，防御资金转入国债蓄水池。`
        : `当前处于${regime.regime_label_zh}且${regime.style_label_zh}，按组合目标差额配置底盘超级基金与国债蓄水池，严格控制风险权益总上限。`,
    ];
    let etfFeesEstimated = false;
    let stockBuysAdded = 0;
    let stockFeesPaidCents = 0;
    let sectorBuysAdded = 0;
    let fundingActionIndex = -1;

    // 1) 计算 P3-BUY 候选队列（仅在非 L2 锁定、准入允许且风险权益仍有额度时）
    const chassisSlots = [...targetPortfolio.slots.values()]
      .filter(s =>
        s.sleeve === 'CHASSIS_LOWVOL'
        || s.sleeve === 'CHASSIS_GOLD'
        || s.sleeve === 'CHASSIS_VALUE'
        || s.sleeve === 'CHASSIS_GROWTH',
      );
    const pendingChassisBuys: Array<{ slot: (typeof chassisSlots)[number]; row: EtfCandidateRow; gapCents: number; heldCents: number; minOrderCents: number; slotDriftBandCents: number }> = [];
    let totalChassisGapCents = 0;
    const allowSubBandTopUp = regimeOrStyleChanged || router.just_unlocked || p0Triggered;
    if (runtimeCanOpen && router.circuit_breaker_status !== 'L2_LOCKED' && alignDue && remainingRiskEquityRoomCents > 0) {
      for (const slot of chassisSlots) {
        if (slot.buy_blocked || soldCodesToday.has(slot.ts_code)) continue;
        const row = superByCode.get(slot.ts_code)
          ?? (input.candidates?.candidates ?? []).find(c => c.ts_code === slot.ts_code && c.included && !c.data?.buy_blocked && (c.data?.latest_close_milli ?? 0) > 0);
        if (!row) continue;
        const held = heldValueCents(slot.ts_code);
        let gapCents = Math.max(0, slot.target_cents - held);
        if (row.category === 'industry_theme' && slot.sleeve !== 'CHASSIS_GOLD') {
          gapCents = Math.min(gapCents, Math.max(0, Math.floor(0.20 * input.totalAssetsCents) - held));
        }
        const slotDriftBandCents = Math.round(
          investableAssetsCents * ((slot.drift_band_bps || policy.equity_align_drift_band_bps) / 10000),
        );
        // P-2: 已持有的目标内代码，若缺口 < 对应漂移带且非档位变更、非解锁日、非 P0 触发，跳过小额补仓；门槛为超级 ETF ¥1,000 / 普通与黄金 ETF ¥5,000
        if (held > 0 && !allowSubBandTopUp && gapCents < slotDriftBandCents) continue;
        const minOrderCents = slot.sleeve === 'CHASSIS_GOLD'
          ? Math.max(500_000, (policy.gold_core_min_trade_cny ?? 5000) * 100)
          : (SUPER_SET.has(slot.ts_code) ? 100_000 : 500_000);
        if (gapCents >= minOrderCents) {
          pendingChassisBuys.push({ slot, row, gapCents, heldCents: held, minOrderCents, slotDriftBandCents });
          totalChassisGapCents += gapCents;
        }
      }
    }

    if (runtimeCanOpen && router.circuit_breaker_status !== 'L2_LOCKED' && remainingRiskEquityRoomCents > 0) {
      // ---- 预估实际可落单的净买入需求，决定是否需要卖出超额国债蓄水池融资
      let stockIntentNetCents = 0;
      let intentRoomCents = remainingRiskEquityRoomCents;
      if (
        bp1ReverifyOk
        && router.effective_regime !== 'DEFENSIVE'
        && router.effective_regime !== 'ICE_10'
        && router.sub_strategies.s_stock_swing === 'ACTIVE'
        && stockSwingCandidates.length > 0
      ) {
        let intentOpenCount = input.holdings.filter(
          h => !isEtfCode(h.ts_code) && (workingQty.get(h.ts_code) ?? h.quantity) > 0,
        ).length;
        let intentGapCents = pioneerGapRemainingCents;
        for (const cand of stockSwingCandidates) {
          if (intentOpenCount >= policy.stock_max_positions || intentRoomCents < minStockOrderCents) break;
          if (soldCodesToday.has(cand.ts_code) || (workingQty.get(cand.ts_code) ?? 0) > 0) continue;
          if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
          const deployBudgetCents = Math.min(intentGapCents, cashRoomNowCents, intentRoomCents);
          if (deployBudgetCents < minStockOrderCents) break;
          const rules = feeFor(cand.ts_code, 'STOCK');
          const sized = sizeStockSwingOrder({
            navCents: investableAssetsCents,
            entryPriceMilli: cand.entry_ref_price_milli,
            hardStopPriceMilli: cand.hard_stop_price_milli,
            availableCashCents: deployBudgetCents,
            commissionRate: rules.commission_rate,
            commissionMinCents: rules.commission_min_cents,
            transferFeeRate: rules.transfer_fee_rate,
            maxRiskBps: policy.stock_risk_budget_bps,
            maxWeightBps: policy.stock_max_single_weight_bps,
            minOrderCents: minStockOrderCents,
          });
          if (sized.shares < 100 || sized.skipped_reason !== null || sized.gross_cents > intentRoomCents) continue;
          stockIntentNetCents += sized.net_cents;
          intentGapCents -= sized.gross_cents;
          intentRoomCents -= sized.gross_cents;
          intentOpenCount += 1;
        }
      }

      let sectorIntentNetCents = 0;
      if (alignDue && targetSectorPioneerCents > 0 && sectorPioneerCandidates.length > 0 && intentRoomCents >= 100_000) {
        let sectorRemaining = targetSectorPioneerCents;
        for (const cand of sectorPioneerCandidates) {
          const slot = targetPortfolio.slots.get(cand.ts_code);
          if (!slot || slot.buy_blocked || soldCodesToday.has(cand.ts_code)) continue;
          const held = heldValueCents(cand.ts_code);
        const gapCents = Math.max(0, slot.target_cents - held);
        if (held > 0 && !allowSubBandTopUp && gapCents < driftBandCents) continue;
        const minSecOrderCents = SUPER_SET.has(cand.ts_code) ? 100_000 : 500_000;
        const budgetCents = Math.min(sectorRemaining, gapCents, cashRoomNowCents, intentRoomCents);
        if (budgetCents < minSecOrderCents || !(cand.close_milli > 0)) continue;
        const rules = feeFor(cand.ts_code, 'ETF');
        const sized = sizeEtfBuy({
          priceMilli: cand.close_milli,
          budgetCents,
          availableCashCents: budgetCents * 2,
          rules,
          minGrossCents: minSecOrderCents,
        });
          if (sized && sized.gross_cents <= intentRoomCents) {
            sectorIntentNetCents += sized.net_cents;
            sectorRemaining -= sized.gross_cents;
            intentRoomCents -= sized.gross_cents;
          }
        }
      }

      let etfIntentNetCents = 0;
      if (totalChassisGapCents > 0 && intentRoomCents >= 100_000) {
        const intentScale = Math.min(1, intentRoomCents / totalChassisGapCents, cashRoomNowCents / totalChassisGapCents);
        for (const pending of pendingChassisBuys) {
          const budgetCents = Math.min(Math.floor(pending.gapCents * intentScale), intentRoomCents);
          const priceMilli = pending.row.data.latest_close_milli ?? 0;
          if (!(priceMilli > 0) || budgetCents < pending.minOrderCents) continue;
          const rules = feeFor(pending.row.ts_code, 'ETF');
          const sized = sizeEtfBuy({
            priceMilli,
            budgetCents,
            availableCashCents: budgetCents * 2,
            rules,
            minGrossCents: pending.minOrderCents,
          });
          if (sized && sized.gross_cents <= intentRoomCents) {
            etfIntentNetCents += sized.net_cents;
            intentRoomCents -= sized.gross_cents;
          }
        }
      }

      const intendedBuyNetCents = stockIntentNetCents + sectorIntentNetCents + etfIntentNetCents;
      const availableCashForBuysCents = Math.max(0, workingCashCents - cashBufferCents);
      const fundingShortfallCents = Math.max(0, intendedBuyNetCents - availableCashForBuysCents);
      const fundSellCode = [...reservoirCodes].reverse().find(c => {
        if (soldCodesToday.has(c)) return false;
        const qty = workingQty.get(c) ?? 0;
        const sellable = Math.floor((workingSellable.get(c) ?? 0) / 100) * 100;
        return qty >= 100 && sellable >= 100 && quoteOfBond(c).priceMilli > 0;
      });
      if (fundingShortfallCents > 0 && fundSellCode && intendedBuyNetCents > 0) {
        const { row: sellRow, holding: sellHolding, freshQuoteMilli: sellFreshMilli, priceMilli: sellPriceMilli, quoteDate: sellQuoteDate } = quoteOfBond(fundSellCode);
        const sellBondQty = workingQty.get(fundSellCode) ?? 0;
        const bondHeldNow = totalReservoirHeldCents() ?? 0;
        const defensiveExcessCents = defensiveAssetsNow === null
          ? 0
          : Math.max(0, defensiveAssetsNow - targetDefensiveCents);
        const sellMaxGrossCents = Math.min(roundCent(sellBondQty * (sellPriceMilli / 10)), bondHeldNow, defensiveExcessCents);
        const priceCents = sellPriceMilli / 10;
        const sellableQty = Math.floor((workingSellable.get(fundSellCode) ?? 0) / 100) * 100;
        const maxShares = Math.min(
          sellableQty,
          Math.floor((sellMaxGrossCents / priceCents) / 100) * 100,
          sellBondQty,
        );
        if (maxShares >= 100) {
          const rules = feeFor(fundSellCode, 'ETF');
          let chosen: { shares: number; gross: number; fees: number; net: number } | null = null;
          const estimateShares = Math.ceil(fundingShortfallCents / (priceCents * 100)) * 100;
          for (let shares = Math.max(100, Math.min(maxShares, estimateShares)); shares <= maxShares; shares += 100) {
            const gross = roundCent(shares * priceCents);
            const fees = calculateFees(gross, 'sell', rules).total_cents;
            if (gross - fees >= fundingShortfallCents) {
              chosen = { shares, gross, fees, net: gross - fees };
              break;
            }
          }
          if (!chosen) {
            const gross = roundCent(maxShares * priceCents);
            const fees = calculateFees(gross, 'sell', rules).total_cents;
            chosen = { shares: maxShares, gross, fees, net: gross - fees };
            blockers.push('防御蓄水池可卖超额不足以覆盖全部买入净缺口，本次按上限卖出，买入随剩余现金缩量。');
          }
          if (chosen.gross >= 500_000) {
            if (sellFreshMilli <= 0) {
              blockers.push(`${fundSellCode} 当日无新鲜行情，融资卖出腿按持仓参考价计价（未使用或臆造当日价）。`);
            }
            workingQty.set(fundSellCode, sellBondQty - chosen.shares);
            workingSellable.set(fundSellCode, Math.max(0, (workingSellable.get(fundSellCode) ?? 0) - chosen.shares));
            workingCashCents += chosen.net;
            soldCodesToday.add(fundSellCode);
            etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
            fundingActionIndex = actions.length;
            actions.push({
              priority: 'P3',
              code: 'P3-BOND-RESERVOIR-FUNDING',
              kind: 'ROTATE',
              rank: actions.length + 1,
              title: '卖出超额国债基金为买入腿融资',
              reasons: [
                '防守转进攻：卖出超出防御目标的国债基金，为本次已形成且满足风控上限的风险权益买入提供资金；该卖出腿先于所有依赖买入执行。',
              ],
              counter_evidence: ['若次日权益低开，融资买入部分承担短期波动；剩余国债与现金仍覆盖防御目标。'],
              legs: [{
                side: 'SELL',
                ts_code: fundSellCode,
                name: sellHolding?.name ?? sellRow?.name ?? null,
                quantity: chosen.shares,
                lot_size: 100,
                lots: chosen.shares / 100,
                price_milli: sellPriceMilli,
                gross_cents: chosen.gross,
                fees_cents: chosen.fees,
                net_cents: chosen.net,
                quote_trade_date: sellQuoteDate,
                executable: true,
                reason: 'P3_DEFENSIVE_RESERVOIR_FUNDING',
              }],
              fees_cents: chosen.fees,
              fees_estimated: Boolean(rules.fee_model?.estimated),
              triggers: [`先卖出 ${chosen.shares} 份 ${fundSellCode}（参考价 ${(sellPriceMilli / 1000).toFixed(3)} 元），再执行后续买入腿`],
              invalidation_conditions: ['国债基金当日无可用报价时不下单'],
              risk_impact: ['只变现防御目标以上的超额国债，防御底线不变'],
            });
          } else {
            blockers.push('国债基金融资卖出低于最低毛额门槛（最低佣金摊薄不经济），本次不融资，买入按现有现金缩量。');
          }
        }
      }

      // ---- 个股波段先锋开仓（严格服从 remainingRiskEquityRoomCents 与同日禁回买）
      if (
        bp1ReverifyOk
        && router.effective_regime !== 'DEFENSIVE'
        && router.effective_regime !== 'ICE_10'
        && router.sub_strategies.s_stock_swing === 'ACTIVE'
        && screenedStockCandidates.length > 0
      ) {
        let openStockCount = input.holdings.filter(
          h => !isEtfCode(h.ts_code) && (workingQty.get(h.ts_code) ?? h.quantity) > 0,
        ).length;
        for (const cand of screenedStockCandidates) {
          if (openStockCount >= policy.stock_max_positions || remainingRiskEquityRoomCents < minStockOrderCents) break;
          if (soldCodesToday.has(cand.ts_code) || (workingQty.get(cand.ts_code) ?? 0) > 0) continue;
          if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
          const defensiveAssets = defensiveAssetsCents();
          const cashRoomCents = defensiveAssets === null
            ? Math.max(0, workingCashCents)
            : Math.max(0, defensiveAssets - targetDefensiveCents);
          const deployBudgetCents = Math.min(
            pioneerGapRemainingCents,
            cashRoomCents,
            workingCashCents - cashBufferCents,
            remainingRiskEquityRoomCents,
          );
          if (deployBudgetCents < minStockOrderCents) break;
          const rules = feeFor(cand.ts_code, 'STOCK');
          const sized = sizeStockSwingOrder({
            navCents: investableAssetsCents,
            entryPriceMilli: cand.entry_ref_price_milli,
            hardStopPriceMilli: cand.hard_stop_price_milli,
            availableCashCents: deployBudgetCents,
            commissionRate: rules.commission_rate,
            commissionMinCents: rules.commission_min_cents,
            transferFeeRate: rules.transfer_fee_rate,
            maxRiskBps: policy.stock_risk_budget_bps,
            maxWeightBps: policy.stock_max_single_weight_bps,
            minOrderCents: minStockOrderCents,
          });
          if (sized.shares < 100 || sized.skipped_reason !== null || sized.gross_cents > remainingRiskEquityRoomCents) continue;
          workingCashCents -= sized.net_cents;
          workingQty.set(cand.ts_code, sized.shares);
          boughtCodesToday.add(cand.ts_code);
          pioneerGapRemainingCents = Math.max(0, pioneerGapRemainingCents - sized.gross_cents);
          remainingRiskEquityRoomCents = Math.max(0, remainingRiskEquityRoomCents - sized.gross_cents);
          openStockCount += 1;
          stockBuysAdded += 1;
          stockFeesPaidCents += sized.fees_cents;
          const entryCny = (cand.entry_ref_price_milli / 1000).toFixed(2);
          const stopCny = (cand.hard_stop_price_milli / 1000).toFixed(2);
          const weightPct = (sized.weight_bps / 100).toFixed(1);
          const riskPct = ((sized.risk_at_stop_cents / Math.max(1, investableAssetsCents)) * 100).toFixed(2);
          actions.push({
            priority: 'P3',
            code: `P3-STOCK-SWING-BUY-${cand.ts_code}`,
            kind: 'ADD',
            rank: actions.length + 1,
            title: `个股波段先锋开仓：买入 ${cand.name}（${cand.ts_code}）`,
            reasons: [
              `${cand.setup_label_zh}，当前处于${regime.regime_label_zh}且个股子策略已获批解封，按以损定仓配置 ${sized.shares} 股（占可投资产 ${weightPct}%，止损风控敞口 ${riskPct}%）。`,
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
            risk_impact: [`占可投资产 ${weightPct}%（不超过 18% 单股上限），单笔止损风险 ${riskPct}%（不超过 1.3% 净值风险）`],
          });
        }
      }

      // ---- 超级行业 ETF 先导开仓/补仓
      if (alignDue && targetSectorPioneerCents > 0 && sectorPioneerCandidates.length > 0 && remainingRiskEquityRoomCents >= 100_000) {
        let sectorRemaining = targetSectorPioneerCents;
        for (const cand of sectorPioneerCandidates) {
          if (!(cand.close_milli > 0) || sectorRemaining < 100_000 || remainingRiskEquityRoomCents < 100_000) break;
          const slot = targetPortfolio.slots.get(cand.ts_code);
          if (!slot || slot.buy_blocked || soldCodesToday.has(cand.ts_code)) continue;
          const held = heldValueCents(cand.ts_code);
          const gapCents = Math.max(0, slot.target_cents - held);
          if (held > 0 && !allowSubBandTopUp && gapCents < driftBandCents) continue;
          const minSecOrderCents = SUPER_SET.has(cand.ts_code) ? 100_000 : 500_000;
          const defensiveAssets = defensiveAssetsCents();
          const cashRoomCents = defensiveAssets === null
            ? Math.max(0, workingCashCents)
            : Math.max(0, defensiveAssets - targetDefensiveCents);
          const budgetCents = Math.min(sectorRemaining, gapCents, cashRoomCents, remainingRiskEquityRoomCents);
          if (budgetCents < minSecOrderCents) continue;
          const rules = feeFor(cand.ts_code, 'ETF');
          const sized = sizeEtfBuy({
            priceMilli: cand.close_milli,
            budgetCents,
            availableCashCents: workingCashCents - cashBufferCents,
            rules,
            minGrossCents: minSecOrderCents,
          });
          if (!sized || sized.gross_cents > remainingRiskEquityRoomCents) continue;
          workingCashCents -= sized.net_cents;
          workingQty.set(cand.ts_code, (workingQty.get(cand.ts_code) ?? 0) + sized.shares);
          boughtCodesToday.add(cand.ts_code);
          sectorRemaining = Math.max(0, sectorRemaining - sized.gross_cents);
          remainingRiskEquityRoomCents = Math.max(0, remainingRiskEquityRoomCents - sized.gross_cents);
          sectorBuysAdded += 1;
          actions.push({
            priority: 'P3',
            code: `P3-SECTOR-PIONEER-BUY-${cand.ts_code}`,
            kind: 'ADD',
            rank: actions.length + 1,
            title: `超级行业动量先导配置：买入 ${cand.name}（${cand.ts_code}）`,
            reasons: [
              `${cand.name} 20/60 日混合动量得分 +${cand.blend_score_pct.toFixed(2)}%（20 日 ${cand.ret20_pct.toFixed(2)}%，60 日 ${cand.ret60_pct.toFixed(2)}%）且收盘站上 60 日均线（${cand.ma60_cny.toFixed(3)} 元），按东财超级基金费率配置 ${sized.shares} 份（买后封顶总资产 20%）。`,
            ],
            counter_evidence: ['若行业短期领涨动量反转或大盘切入防守档，将按高水位风控统一收缩。'],
            legs: [{
              side: 'BUY',
              ts_code: cand.ts_code,
              name: cand.name,
              quantity: sized.shares,
              lot_size: 100,
              lots: sized.shares / 100,
              price_milli: cand.close_milli,
              gross_cents: sized.gross_cents,
              fees_cents: sized.fees_cents,
              net_cents: sized.net_cents,
              quote_trade_date: cand.as_of_trade_date,
              executable: true,
              reason: 'P3_SUPER_SECTOR_PIONEER',
            }],
            fees_cents: sized.fees_cents,
            fees_estimated: Boolean(rules.fee_model?.estimated),
            triggers: [`次日开盘或盘中限价买入 ${sized.shares} 份 ${cand.ts_code}（参考价 ${cand.close_cny.toFixed(3)} 元）`],
            invalidation_conditions: ['次日高开超 +2% 追高风险放大，或跌破 60 日均线'],
            risk_impact: ['补足单只最高 20% 行业动量先导暴露，且受账户级风险权益上限约束'],
          });
        }
      }

      // ---- 底盘超级 ETF 买入：严格受 remainingRiskEquityRoomCents（含未出清遗留仓）硬封顶
      if (pendingChassisBuys.length > 0 && totalChassisGapCents > 0) {
        const defensiveAfterPioneers = defensiveAssetsCents();
        const cashRoomCents = defensiveAfterPioneers === null
          ? Math.max(0, workingCashCents)
          : Math.max(0, defensiveAfterPioneers - targetDefensiveCents) + Math.min(cashBufferCents, stockFeesPaidCents);
        const usableEquityBudgetCents = Math.max(0, Math.min(remainingRiskEquityRoomCents, cashRoomCents));
        const budgetScale = totalChassisGapCents > 0
          ? Math.min(1, usableEquityBudgetCents / totalChassisGapCents)
          : 0;
        if (budgetScale <= 0) {
          blockers.push('当前风险权益（含剩余非目标持仓）已占满或超过目标上限，底盘超级基金本次暂不买入。');
        } else {
          for (const pending of pendingChassisBuys) {
            if (remainingRiskEquityRoomCents < pending.minOrderCents) continue;
            const budgetCents = Math.min(Math.floor(pending.gapCents * budgetScale), remainingRiskEquityRoomCents);
            const priceMilli = pending.row.data.latest_close_milli ?? 0;
            if (pending.heldCents > 0 && !allowSubBandTopUp && budgetCents < pending.slotDriftBandCents) continue;
            if (!(priceMilli > 0) || budgetCents < pending.minOrderCents) continue;
            const rules = feeFor(pending.row.ts_code, 'ETF');
            const sized = sizeEtfBuy({
              priceMilli,
              budgetCents,
              availableCashCents: workingCashCents - cashBufferCents,
              rules,
              minGrossCents: pending.minOrderCents,
            });
            if (!sized || sized.gross_cents > remainingRiskEquityRoomCents) continue;
            workingCashCents -= sized.net_cents;
            workingQty.set(pending.row.ts_code, (workingQty.get(pending.row.ts_code) ?? 0) + sized.shares);
            boughtCodesToday.add(pending.row.ts_code);
            remainingRiskEquityRoomCents = Math.max(0, remainingRiskEquityRoomCents - sized.gross_cents);
            etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
            etfLegs.push({
              side: 'BUY',
              ts_code: pending.row.ts_code,
              name: pending.row.name,
              quantity: sized.shares,
              lot_size: 100,
              lots: sized.shares / 100,
              price_milli: priceMilli,
              gross_cents: sized.gross_cents,
              fees_cents: sized.fees_cents,
              net_cents: sized.net_cents,
              quote_trade_date: pending.row.data.latest_bar_date,
              executable: true,
              reason: `P3_SUPER_ETF_${pending.slot.sleeve}`,
            });
          }
        }
      }
    } else if (runtimeCanOpen && alignDue && router.circuit_breaker_status !== 'L2_LOCKED' && remainingRiskEquityRoomCents <= 0) {
      const hasAnyTargetBuyGap = chassisSlots.some(s => !s.buy_blocked && heldValueCents(s.ts_code) < s.target_cents);
      if (hasAnyTargetBuyGap) {
        blockers.push('当前风险权益（含待平滑非目标持仓）已达或超过目标上限，底盘新增买入延后至次日非目标仓位进一步回笼后执行。');
      }
    }

    // ---- 国债蓄水池买入（即使 L2_LOCKED 仍照常执行，严格避免同日先卖后买并按普通 ETF 真实费率计费）
    if (runtimeCanOpen) {
      const reservoirHeldNow = totalReservoirHeldCents();
      const buyCode = reservoirCodes.find(c => {
        if (soldCodesToday.has(c)) return false;
        const q = quoteOfBond(c);
        return Boolean(q.row && q.freshQuoteMilli > 0 && q.row.included && !q.row.data.buy_blocked);
      }) ?? policy.defensive_bond_reservoir_etf;
      const buyQuote = quoteOfBond(buyCode);
      const reservoirTargetCents = Math.max(0, targetDefensiveCents - (reservoirHeldNow ?? 0) - cashBufferCents);
      const reservoirBudgetCents = Math.min(workingCashCents - cashBufferCents, reservoirTargetCents);
      const driftBandCents = Math.round(investableAssetsCents * (policy.defensive_bond_reservoir_drift_band_bps / 10000));
      if (reservoirHeldNow === null) {
        blockers.push(`${policy.defensive_bond_reservoir_etf} 国债基金防御蓄水池持仓缺少可用报价，无法计算防御桶余额，本次跳过且不臆造价格。`);
      } else if (soldCodesToday.has(buyCode)) {
        // 同日已卖出该代码，禁止当日买回。
      } else if (driftBandCents > 0 && reservoirTargetCents > 0 && reservoirTargetCents < driftBandCents) {
        // 处于 10% 漂移缓冲带内，不频繁微调。
      } else if (reservoirBudgetCents >= 500_000) {
        if (!buyQuote.row || buyQuote.freshQuoteMilli <= 0 || !buyQuote.row.included || buyQuote.row.data.buy_blocked) {
          blockers.push(`${buyCode} 国债基金防御蓄水池缺少当日新鲜报价或未通过可买入过滤，本次跳过且不臆造价格。`);
        } else {
          const rules = feeFor(buyCode, 'ETF');
          const sized = sizeEtfBuy({
            priceMilli: buyQuote.freshQuoteMilli,
            budgetCents: reservoirBudgetCents,
            availableCashCents: workingCashCents - cashBufferCents,
            rules,
            minGrossCents: 500_000,
          });
          if (!sized) {
            blockers.push('国债基金防御蓄水池订单不足最低毛额门槛（最低佣金摊薄不经济），本次跳过。');
          } else {
            workingCashCents -= sized.net_cents;
            workingQty.set(buyCode, (workingQty.get(buyCode) ?? 0) + sized.shares);
            boughtCodesToday.add(buyCode);
            etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
            etfLegs.push({
              side: 'BUY',
              ts_code: buyCode,
              name: buyQuote.row.name,
              quantity: sized.shares,
              lot_size: 100,
              lots: sized.shares / 100,
              price_milli: buyQuote.freshQuoteMilli,
              gross_cents: sized.gross_cents,
              fees_cents: sized.fees_cents,
              net_cents: sized.net_cents,
              quote_trade_date: buyQuote.quoteDate,
              executable: true,
              reason: 'P3_DEFENSIVE_BOND_RESERVOIR',
            });
            etfReasons.push(`防御桶中尚未配置到国债基金的闲置资金转入 ${buyCode} 蓄水池，保留日常现金缓冲。`);
          }
        }
      } else if (reservoirTargetCents > 0) {
        const affordableCents = Math.max(0, Math.min(workingCashCents - cashBufferCents, reservoirTargetCents));
        if (affordableCents > 0) {
          blockers.push('国债基金防御蓄水池待配置金额不足最低单腿门槛（最低佣金摊薄不经济），本次跳过。');
        }
      }

      if (fundingActionIndex >= 0 && stockBuysAdded === 0 && sectorBuysAdded === 0 && !etfLegs.some(leg => leg.side === 'BUY')) {
        actions.splice(fundingActionIndex, 1);
        blockers.push('本次未形成任何可执行的买入腿，已取消国债基金融资卖出。');
      }

      if (etfLegs.length > 0) {
        const buyLegs = etfLegs.filter(leg => leg.side === 'BUY');
        actions.push({
          priority: 'P3',
          code: 'P3-SUPER-ETF-REBALANCE',
          kind: 'ROTATE',
          rank: actions.length + 1,
          title: `底盘超级基金与防御蓄水池配置：${buyLegs.length} 笔买入`,
          reasons: etfReasons.slice(0, 2),
          counter_evidence: ['若市场次日跌破风格锚，需随环境切档缩减仓位；严守单日风险权益总量上限。'],
          legs: etfLegs,
          fees_cents: etfLegs.reduce((sum, leg) => sum + leg.fees_cents, 0),
          fees_estimated: etfFeesEstimated,
          triggers: etfLegs.map(leg => `${leg.side === 'SELL' ? '卖出' : '买入'} ${leg.quantity} 份 ${leg.ts_code}，参考价 ${(leg.price_milli / 1000).toFixed(3)} 元`),
          invalidation_conditions: ['次日高开超过 +2% 或跨境品种盘中溢价超 +2.5%'],
          risk_impact: ['买入前已扣除尚未出清的非目标仓位占用的风险额度，防御闲置资金统一停泊于国债蓄水池'],
        });
      }
    }

    actions.forEach((action, index) => { action.rank = index + 1; });

    // 计算 V2 alignSummary
    let unmanagedLegacyAfterCents = 0;
    let postRiskEquityTotalCents = 0;
    let targetRiskEquityTotalCents = 0;
    let maxSlotDriftBpsAfter = 0;
    for (const [code, qty] of workingQty.entries()) {
      if (!(qty > 0) || !isRiskEquityHolding(code)) continue;
      const pm = priceMilliOf(code)
        || (screenedStockCandidates.find(c => c.ts_code === code)?.entry_ref_price_milli ?? 0)
        || (sectorPioneerCandidates.find(c => c.ts_code === code)?.close_milli ?? 0);
      if (!(pm > 0)) continue;
      const mv = roundCent(qty * (pm / 10));
      postRiskEquityTotalCents += mv;
      if (targetPortfolio.slots.get(code)?.sleeve === 'UNMANAGED_LEGACY') {
        unmanagedLegacyAfterCents += mv;
      }
    }
    for (const slot of targetPortfolio.slots.values()) {
      if (isRiskEquitySleeve(slot.sleeve)) {
        targetRiskEquityTotalCents += slot.target_cents;
      }
      if (!isRiskEquitySleeve(slot.sleeve) && slot.sleeve !== 'UNMANAGED_LEGACY') continue;
      const qty = workingQty.get(slot.ts_code) ?? 0;
      const pm = priceMilliOf(slot.ts_code)
        || (screenedStockCandidates.find(c => c.ts_code === slot.ts_code)?.entry_ref_price_milli ?? 0)
        || (sectorPioneerCandidates.find(c => c.ts_code === slot.ts_code)?.close_milli ?? 0);
      const postMv = qty > 0 && pm > 0 ? roundCent(qty * (pm / 10)) : 0;
      const driftBps = investableAssetsCents > 0
        ? Math.round((Math.abs(postMv - slot.target_cents) / investableAssetsCents) * 10000)
        : 0;
      if (driftBps > maxSlotDriftBpsAfter) maxSlotDriftBpsAfter = driftBps;
    }

    alignSummary = {
      enabled: true,
      align_due: alignDue,
      carryover_cap_bps: policy.align_glide_carryover_bps,
      pre_sell_excess_cents: preSellExcessCents,
      target_glide_sell_cents: targetGlideSellCents,
      p0_sold_cents: p0SoldCents,
      p3_sold_cents: p3SoldCents,
      unmanaged_legacy_before_cents: unmanagedLegacyBeforeCents,
      unmanaged_legacy_after_cents: unmanagedLegacyAfterCents,
      post_action_risk_equity_bps: investableAssetsCents > 0 ? Math.round((postRiskEquityTotalCents / investableAssetsCents) * 10000) : 0,
      target_equity_cap_bps: routerEffectiveCapBps,
      chassis_target_count: targetPortfolio.chassisTargetCodes.size,
      target_slots: [...targetPortfolio.slots.values()]
        .map(s => {
          const qty = workingQty.get(s.ts_code) ?? 0;
          const pm = priceMilliOf(s.ts_code);
          return {
            ts_code: s.ts_code,
            sleeve: s.sleeve,
            target_bps: s.target_bps,
            target_cents: s.target_cents,
            held_cents: qty > 0 && pm > 0 ? roundCent(qty * (pm / 10)) : 0,
            buy_blocked: s.buy_blocked,
          };
        })
        .sort((a, b) => a.ts_code.localeCompare(b.ts_code)),
    };
  } else if (router.circuit_breaker_status !== 'L2_LOCKED') {
    // 先锋（个股）、超级行业先导与底盘（超级 ETF）使用各自目标额度，互不挤占。
    let stockHeldCents = 0;
    let baseEtfHeldCents = 0;
    for (const h of input.holdings) {
      if (!isRiskEquityHolding(h.ts_code)) continue;
      const qty = workingQty.get(h.ts_code) ?? h.quantity;
      const value = roundCent(qty * (h.price_milli / 10));
      if (isEtfCode(h.ts_code)) baseEtfHeldCents += value;
      else stockHeldCents += value;
    }
    let pioneerGapRemainingCents = Math.max(0, targetPioneerCents - stockHeldCents);

    const defensiveAssetsNow = defensiveAssetsCents();
    const cashRoomNowCents = defensiveAssetsNow === null
      ? Math.max(0, workingCashCents)
      : Math.max(0, defensiveAssetsNow - targetDefensiveCents);
    const baseEtfGapCents = Math.max(0, targetBaseEtfCents - baseEtfHeldCents);
    const bucketSpecs = superEtfBucketSpecs(
      router.effective_regime,
      regime.style,
      policy.lowvol_core_permanent_share_bps,
    );

    const etfLegs: ActionEngineLeg[] = [];
    const etfReasons: string[] = [
      policy.lowvol_core_permanent_share_bps > 0
        ? `当前处于${regime.regime_label_zh}且${regime.style_label_zh}，保留 ${(policy.lowvol_core_permanent_share_bps / 100).toFixed(0)}% 永久红利低波核心并与成长/价值桶按目标差额配置，防御资金按低票面国债蓄水池优先级配置。`
        : `当前处于${regime.regime_label_zh}且${regime.style_label_zh}，按目标持仓差额配置底盘超级 ETF 与防御蓄水池，不按新增现金均分、不单押一只。`,
    ];
    let etfFeesEstimated = false;
    let stockBuysAdded = 0;
    let stockFeesPaidCents = 0;
    let sectorBuysAdded = 0;
    let fundingActionIndex = -1;

    interface PendingBucketBuy { spec: SuperEtfBucketSpec; row: EtfCandidateRow; targetBuyCents: number }
    const pendingBuys: PendingBucketBuy[] = [];
    const bucketSkipped = new Map<string, string[]>();
    let totalTargetBuyCents = 0;

    if (runtimeCanOpen) {
      // ---- 先形成桶的目标差额买入计划（目标持仓 - 现有持仓，桶内等权）。
      for (const spec of bucketSpecs) {
        const bucketTargetCents = Math.floor(targetBaseEtfCents * spec.share_bps / 10000);
        const bucketHeldCents = spec.codes.reduce((sum, code) => sum + heldValueCents(code), 0);
        const bucketGapCents = Math.max(0, bucketTargetCents - bucketHeldCents);
        const members = spec.codes
          .map(code => superByCode.get(code))
          .filter((row): row is EtfCandidateRow => Boolean(row));
        if (members.length === 0) {
          blockers.push(`${spec.label_zh}桶无合格超级 ETF 成员（未入选或禁买），本次跳过，预算份额不集中到单一 ETF。`);
          continue;
        }
        const perMemberTargetCents = bucketTargetCents / members.length;
        const raw: Array<{ row: EtfCandidateRow; buyCents: number }> = [];
        for (const row of members) {
          const held = heldValueCents(row.ts_code);
          let buyCents = Math.max(0, perMemberTargetCents - held);
          if (row.category === 'industry_theme') {
            // 行业主题买后权重上限 20%（占账户总资产）。
            buyCents = Math.min(buyCents, Math.max(0, 0.20 * input.totalAssetsCents - held));
          }
          if (buyCents > 0) raw.push({ row, buyCents });
        }
        const rawSum = raw.reduce((sum, item) => sum + item.buyCents, 0);
        if (rawSum <= 0) continue;
        const gapScale = Math.min(1, bucketGapCents / rawSum);
        for (const item of raw) {
          const targetBuyCents = Math.floor(item.buyCents * gapScale);
          if (targetBuyCents <= 0) continue;
          pendingBuys.push({ spec, row: item.row, targetBuyCents });
          totalTargetBuyCents += targetBuyCents;
        }
      }

      // ---- 实际整手 ETF 买入意图（含费用），用于融资缺口。
      const bucketIntentScale = totalTargetBuyCents > 0
        ? Math.min(1, baseEtfGapCents / totalTargetBuyCents)
        : 0;
      let etfIntentNetCents = 0;
      for (const pending of pendingBuys) {
        const budgetCents = Math.floor(pending.targetBuyCents * bucketIntentScale);
        const priceMilli = pending.row.data.latest_close_milli ?? 0;
        if (!(priceMilli > 0) || budgetCents < 100_000) continue;
        const rules = feeFor(pending.row.ts_code, 'ETF');
        const sized = sizeEtfBuy({
          priceMilli,
          budgetCents,
          availableCashCents: budgetCents * 2,
          rules,
          minGrossCents: 100_000,
        });
        if (sized) etfIntentNetCents += sized.net_cents;
      }

      // ---- 超级行业 ETF 先导意图（v3.3.0 EXP-V3-10A，20/60混合动量前K名，封顶 20% 总资产）。
      let sectorIntentNetCents = 0;
      if (targetSectorPioneerCents > 0 && sectorPioneerCandidates.length > 0) {
        let sectorRemaining = targetSectorPioneerCents;
        for (const cand of sectorPioneerCandidates) {
          const held = heldValueCents(cand.ts_code);
          const capForCand = Math.min(targetSectorPioneerCents, Math.floor(0.20 * input.totalAssetsCents));
          const gapCents = Math.max(0, capForCand - held);
          const budgetCents = Math.min(sectorRemaining, gapCents, cashRoomNowCents);
          if (budgetCents < 100_000 || !(cand.close_milli > 0)) continue;
          const rules = feeFor(cand.ts_code, 'ETF');
          const sized = sizeEtfBuy({
            priceMilli: cand.close_milli,
            budgetCents,
            availableCashCents: budgetCents * 2,
            rules,
            minGrossCents: 100_000,
          });
          if (sized) {
            sectorIntentNetCents += sized.net_cents;
            sectorRemaining -= sized.gross_cents;
          }
        }
      }

      // ---- 个股先锋意图（实际整手 + 费用），同样计入融资缺口。
      let stockIntentNetCents = 0;
      if (
        router.effective_regime !== 'DEFENSIVE'
        && router.sub_strategies.s_stock_swing === 'ACTIVE'
        && stockSwingCandidates.length > 0
      ) {
        let intentOpenCount = input.holdings.filter(
          h => !isEtfCode(h.ts_code) && (workingQty.get(h.ts_code) ?? h.quantity) > 0,
        ).length;
        let intentGapCents = pioneerGapRemainingCents;
        for (const cand of stockSwingCandidates) {
          if (intentOpenCount >= policy.stock_max_positions) break;
          if ((workingQty.get(cand.ts_code) ?? 0) > 0) continue;
          if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
          const deployBudgetCents = Math.min(intentGapCents, cashRoomNowCents);
          if (deployBudgetCents < minStockOrderCents) break;
          const rules = feeFor(cand.ts_code, 'STOCK');
          const sized = sizeStockSwingOrder({
            navCents: investableAssetsCents,
            entryPriceMilli: cand.entry_ref_price_milli,
            hardStopPriceMilli: cand.hard_stop_price_milli,
            availableCashCents: deployBudgetCents,
            commissionRate: rules.commission_rate,
            commissionMinCents: rules.commission_min_cents,
            transferFeeRate: rules.transfer_fee_rate,
            maxRiskBps: policy.stock_risk_budget_bps,
            maxWeightBps: policy.stock_max_single_weight_bps,
            minOrderCents: minStockOrderCents,
          });
          if (sized.shares < 100 || sized.skipped_reason !== null) continue;
          stockIntentNetCents += sized.net_cents;
          intentGapCents -= sized.gross_cents;
          intentOpenCount += 1;
        }
      }

      const intendedBuyNetCents = stockIntentNetCents + sectorIntentNetCents + etfIntentNetCents;
      const availableCashForBuysCents = Math.max(0, workingCashCents - cashBufferCents);
      const fundingShortfallCents = Math.max(0, intendedBuyNetCents - availableCashForBuysCents);

      // ---- 最小足额可卖国债手数：优先卖出旧蓄水池标（逆序），净额覆盖实际净缺口。
      const fundSellCode = [...reservoirCodes].reverse().find(c => {
        const qty = workingQty.get(c) ?? 0;
        const sellable = Math.floor((workingSellable.get(c) ?? 0) / 100) * 100;
        return qty >= 100 && sellable >= 100 && quoteOfBond(c).priceMilli > 0;
      });
      if (fundingShortfallCents > 0 && fundSellCode && intendedBuyNetCents > 0) {
        const { row: sellRow, holding: sellHolding, freshQuoteMilli: sellFreshMilli, priceMilli: sellPriceMilli, quoteDate: sellQuoteDate } = quoteOfBond(fundSellCode);
        const sellBondQty = workingQty.get(fundSellCode) ?? 0;
        const bondHeldNow = totalReservoirHeldCents() ?? 0;
        const defensiveExcessCents = defensiveAssetsNow === null
          ? 0
          : Math.max(0, defensiveAssetsNow - targetDefensiveCents);
        const sellMaxGrossCents = Math.min(roundCent(sellBondQty * (sellPriceMilli / 10)), bondHeldNow, defensiveExcessCents);
        const priceCents = sellPriceMilli / 10;
        const sellableQty = Math.floor((workingSellable.get(fundSellCode) ?? 0) / 100) * 100;
        const maxShares = Math.min(
          sellableQty,
          Math.floor((sellMaxGrossCents / priceCents) / 100) * 100,
          sellBondQty,
        );
        if (maxShares >= 100) {
          const rules = feeFor(fundSellCode, 'ETF');
          let chosen: { shares: number; gross: number; fees: number; net: number } | null = null;
          const estimateShares = Math.ceil(fundingShortfallCents / (priceCents * 100)) * 100;
          for (let shares = Math.max(100, Math.min(maxShares, estimateShares)); shares <= maxShares; shares += 100) {
            const gross = roundCent(shares * priceCents);
            const fees = calculateFees(gross, 'sell', rules).total_cents;
            if (gross - fees >= fundingShortfallCents) {
              chosen = { shares, gross, fees, net: gross - fees };
              break;
            }
          }
          if (!chosen) {
            const gross = roundCent(maxShares * priceCents);
            const fees = calculateFees(gross, 'sell', rules).total_cents;
            chosen = { shares: maxShares, gross, fees, net: gross - fees };
            blockers.push('防御蓄水池可卖超额不足以覆盖全部买入净缺口，本次按上限卖出，买入随剩余现金缩量。');
          }
          if (chosen.gross >= 500_000) {
            if (sellFreshMilli <= 0) {
              blockers.push(`${fundSellCode} 当日无新鲜行情，融资卖出腿按持仓参考价计价（未使用或臆造当日价）。`);
            }
            workingQty.set(fundSellCode, sellBondQty - chosen.shares);
            workingSellable.set(fundSellCode, Math.max(0, (workingSellable.get(fundSellCode) ?? 0) - chosen.shares));
            workingCashCents += chosen.net;
            etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
            fundingActionIndex = actions.length;
            actions.push({
              priority: 'P3',
              code: 'P3-BOND-RESERVOIR-FUNDING',
              kind: 'ROTATE',
              rank: actions.length + 1,
              title: '卖出超额国债 ETF 为 P3 买入融资',
              reasons: [
                '防守转进攻：卖出超出新防御目标的国债 ETF，为已形成的个股/行业先导/底盘 ETF 买入腿提供资金；该卖出腿先于所有依赖的买入腿执行。',
                '只按实际整手买入净缺口卖出最小足额手数，未把整块底盘缺口一次性变现。',
              ],
              counter_evidence: ['若次日权益低开，融资买入的部分承担短期波动；剩余国债 ETF 仍覆盖防御目标。'],
              legs: [{
                side: 'SELL',
                ts_code: fundSellCode,
                name: sellHolding?.name ?? sellRow?.name ?? null,
                quantity: chosen.shares,
                lot_size: 100,
                lots: chosen.shares / 100,
                price_milli: sellPriceMilli,
                gross_cents: chosen.gross,
                fees_cents: chosen.fees,
                net_cents: chosen.net,
                quote_trade_date: sellQuoteDate,
                executable: true,
                reason: 'P3_DEFENSIVE_RESERVOIR_FUNDING',
              }],
              fees_cents: chosen.fees,
              fees_estimated: Boolean(rules.fee_model?.estimated),
              triggers: [`先卖出 ${chosen.shares} 份 ${fundSellCode}（参考价 ${(sellPriceMilli / 1000).toFixed(3)} 元），再执行后续买入腿`],
              invalidation_conditions: ['国债 ETF 当日无可用报价时不下单'],
              risk_impact: ['只变现防御目标以上的超额国债，防御底线不变'],
            });
          } else {
            blockers.push('国债 ETF 融资卖出低于最低毛额门槛（最低佣金摊薄不经济），本次不融资，买入按现有现金缩量。');
          }
        }
      }
    }

    // ---- 个股先于行业先导与底盘 ETF 执行
    if (
      runtimeCanOpen
      && router.effective_regime !== 'DEFENSIVE'
      && router.sub_strategies.s_stock_swing === 'ACTIVE'
      && screenedStockCandidates.length > 0
    ) {
      let openStockCount = input.holdings.filter(
        h => !isEtfCode(h.ts_code) && (workingQty.get(h.ts_code) ?? h.quantity) > 0,
      ).length;
      for (const cand of screenedStockCandidates) {
        if (openStockCount >= policy.stock_max_positions) break;
        if ((workingQty.get(cand.ts_code) ?? 0) > 0) continue;
        if (!(cand.entry_ref_price_milli > 0) || !(cand.hard_stop_price_milli > 0)) continue;
        const defensiveAssets = defensiveAssetsCents();
        const cashRoomCents = defensiveAssets === null
          ? Math.max(0, workingCashCents)
          : Math.max(0, defensiveAssets - targetDefensiveCents);
        const deployBudgetCents = Math.min(pioneerGapRemainingCents, cashRoomCents, workingCashCents - cashBufferCents);
        if (deployBudgetCents < minStockOrderCents) break;
        const rules = feeFor(cand.ts_code, 'STOCK');
        const sized = sizeStockSwingOrder({
          navCents: investableAssetsCents,
          entryPriceMilli: cand.entry_ref_price_milli,
          hardStopPriceMilli: cand.hard_stop_price_milli,
          availableCashCents: Math.min(deployBudgetCents, workingCashCents - cashBufferCents),
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
        pioneerGapRemainingCents -= sized.gross_cents;
        openStockCount += 1;
        const entryCny = (cand.entry_ref_price_milli / 1000).toFixed(2);
        const stopCny = (cand.hard_stop_price_milli / 1000).toFixed(2);
        const weightPct = (sized.weight_bps / 100).toFixed(1);
        const riskPct = ((sized.risk_at_stop_cents / investableAssetsCents) * 100).toFixed(2);
        actions.push({
          priority: 'P3',
          code: `P3-STOCK-SWING-BUY-${cand.ts_code}`,
          kind: 'ADD',
          rank: actions.length + 1,
          title: `个股波段先锋开仓：买入 ${cand.name}（${cand.ts_code}）`,
          reasons: [
            `${cand.setup_label_zh}，当前处于${regime.regime_label_zh}且个股子策略已获批解封，按以损定仓配置 ${sized.shares} 股（占可投资产 ${weightPct}%，止损风控敞口 ${riskPct}%）。`,
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
          risk_impact: [`占可投资产 ${weightPct}%（不超过 18% 单股上限），单笔止损风险 ${riskPct}%（不超过 1.3% 净值风险）`],
        });
        stockBuysAdded += 1;
      }
    }

    // ---- 超级行业 ETF 先导开仓/补仓（20/60 混合动量站上 MA60，封顶 20% 总资产）
    if (
      runtimeCanOpen
      && targetSectorPioneerCents > 0
      && sectorPioneerCandidates.length > 0
    ) {
      let sectorRemaining = targetSectorPioneerCents;
      for (const cand of sectorPioneerCandidates) {
        if (!(cand.close_milli > 0) || sectorRemaining < 100_000) break;
        const held = heldValueCents(cand.ts_code);
        const capForCand = Math.min(targetSectorPioneerCents, Math.floor(0.20 * input.totalAssetsCents));
        const gapCents = Math.max(0, capForCand - held);
        const defensiveAssets = defensiveAssetsCents();
        const cashRoomCents = defensiveAssets === null
          ? Math.max(0, workingCashCents)
          : Math.max(0, defensiveAssets - targetDefensiveCents);
        const budgetCents = Math.min(sectorRemaining, gapCents, cashRoomCents);
        if (budgetCents < 100_000) continue;
        const rules = feeFor(cand.ts_code, 'ETF');
        const sized = sizeEtfBuy({
          priceMilli: cand.close_milli,
          budgetCents,
          availableCashCents: workingCashCents - cashBufferCents,
          rules,
          minGrossCents: 100_000,
        });
        if (!sized) continue;
        workingCashCents -= sized.net_cents;
        workingQty.set(cand.ts_code, (workingQty.get(cand.ts_code) ?? 0) + sized.shares);
        sectorRemaining -= sized.gross_cents;
        sectorBuysAdded += 1;
        actions.push({
          priority: 'P3',
          code: `P3-SECTOR-PIONEER-BUY-${cand.ts_code}`,
          kind: 'ADD',
          rank: actions.length + 1,
          title: `超级行业 ETF 动量先导配置：买入 ${cand.name}（${cand.ts_code}）`,
          reasons: [
            `${cand.name} 20/60 日混合动量得分 +${cand.blend_score_pct.toFixed(2)}%（20 日 ${cand.ret20_pct.toFixed(2)}%，60 日 ${cand.ret60_pct.toFixed(2)}%）且收盘站上 60 日均线（${cand.ma60_cny.toFixed(3)} 元），按东财超级 ETF 万 0.5 免五费率配置 ${sized.shares} 份（买后封顶总资产 20%）。`,
          ],
          counter_evidence: ['若行业短期领涨动量反转或大盘切入防守档，将按高水位风控统一收缩。'],
          legs: [{
            side: 'BUY',
            ts_code: cand.ts_code,
            name: cand.name,
            quantity: sized.shares,
            lot_size: 100,
            lots: sized.shares / 100,
            price_milli: cand.close_milli,
            gross_cents: sized.gross_cents,
            fees_cents: sized.fees_cents,
            net_cents: sized.net_cents,
            quote_trade_date: cand.as_of_trade_date,
            executable: true,
            reason: 'P3_SUPER_SECTOR_PIONEER',
          }],
          fees_cents: sized.fees_cents,
          fees_estimated: Boolean(rules.fee_model?.estimated),
          triggers: [`次日开盘或盘中限价买入 ${sized.shares} 份 ${cand.ts_code}（参考价 ${cand.close_cny.toFixed(3)} 元）`],
          invalidation_conditions: ['次日高开超 +2% 追高风险放大，或跌破 60 日均线'],
          risk_impact: ['补足单只最高 20% 行业动量先导暴露，单边超买不会越上限'],
        });
      }
    }

    if (runtimeCanOpen) {
      // ---- 底盘 ETF 执行：按目标差额计划、以融资后的实际现金定量。
      const defensiveAfterPioneers = defensiveAssetsCents();
      const cashRoomCents = defensiveAfterPioneers === null
        ? Math.max(0, workingCashCents)
        : Math.max(0, defensiveAfterPioneers - targetDefensiveCents);
      const etfBudgetCents = Math.max(0, Math.min(baseEtfGapCents, cashRoomCents));
      const budgetScale = totalTargetBuyCents > 0
        ? Math.min(1, etfBudgetCents / totalTargetBuyCents)
        : 0;
      if (pendingBuys.length > 0 && budgetScale <= 0) {
        blockers.push('底盘 ETF 目标差额已满足或现金不足，本次不新增 ETF 仓位。');
      }
      let boughtBucketLegs = 0;
      for (const pending of pendingBuys) {
        const budgetCents = Math.floor(pending.targetBuyCents * budgetScale);
        const priceMilli = pending.row.data.latest_close_milli ?? 0;
        if (!(priceMilli > 0) || budgetCents < 100_000) {
          const codes = bucketSkipped.get(pending.spec.label_zh) ?? [];
          codes.push(pending.row.ts_code);
          bucketSkipped.set(pending.spec.label_zh, codes);
          continue;
        }
        const rules = feeFor(pending.row.ts_code, 'ETF');
        const sized = sizeEtfBuy({
          priceMilli,
          budgetCents,
          availableCashCents: workingCashCents - cashBufferCents,
          rules,
          minGrossCents: 100_000,
        });
        if (!sized) {
          const codes = bucketSkipped.get(pending.spec.label_zh) ?? [];
          codes.push(pending.row.ts_code);
          bucketSkipped.set(pending.spec.label_zh, codes);
          continue;
        }
        workingCashCents -= sized.net_cents;
        workingQty.set(pending.row.ts_code, (workingQty.get(pending.row.ts_code) ?? 0) + sized.shares);
        etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
        etfLegs.push({
          side: 'BUY',
          ts_code: pending.row.ts_code,
          name: pending.row.name,
          quantity: sized.shares,
          lot_size: 100,
          lots: sized.shares / 100,
          price_milli: priceMilli,
          gross_cents: sized.gross_cents,
          fees_cents: sized.fees_cents,
          net_cents: sized.net_cents,
          quote_trade_date: pending.row.data.latest_bar_date,
          executable: true,
          reason: `P3_SUPER_ETF_BUCKET_${pending.spec.key.toUpperCase()}`,
        });
        boughtBucketLegs += 1;
      }
      for (const [label, codes] of bucketSkipped) {
        blockers.push(`${label}桶 ${codes.join('、')} 按目标差额拆分后不足最低手数或最低毛额，本次跳过，预算份额不集中到单一 ETF。`);
      }
      if (pendingBuys.length > 0 && budgetScale > 0 && boughtBucketLegs === 0) {
        blockers.push('风格桶按目标差额拆分后全部低于最低手数或毛额，本次跳过，预算份额不集中到单一 ETF。');
      }

      // ---- 蓄水池买入：防御目标中尚未配置到国债 ETF 的部分（159649.SZ -> 511260.SH -> 511010.SH），含 10% 漂移带防频繁调仓。
      const reservoirHeldNow = totalReservoirHeldCents();
      const buyCode = reservoirCodes.find(c => {
        const q = quoteOfBond(c);
        return Boolean(q.row && q.freshQuoteMilli > 0 && q.row.included && !q.row.data.buy_blocked);
      }) ?? policy.defensive_bond_reservoir_etf;
      const buyQuote = quoteOfBond(buyCode);
      const reservoirTargetCents = Math.max(0, targetDefensiveCents - (reservoirHeldNow ?? 0) - cashBufferCents);
      const reservoirBudgetCents = Math.min(workingCashCents - cashBufferCents, reservoirTargetCents);
      const driftBandCents = Math.round(investableAssetsCents * (policy.defensive_bond_reservoir_drift_band_bps / 10000));
      if (reservoirHeldNow === null) {
        blockers.push(`${policy.defensive_bond_reservoir_etf} 国债 ETF 防御蓄水池持仓缺少可用报价，无法计算防御桶余额，本次跳过且不臆造价格。`);
      } else if (driftBandCents > 0 && reservoirTargetCents > 0 && reservoirTargetCents < driftBandCents) {
        // 处于漂移缓冲带（10%）内，不频繁微调国债蓄水池，保留现金等待更大差额或建仓资金。
      } else if (reservoirBudgetCents >= 500_000) {
        if (!buyQuote.row || buyQuote.freshQuoteMilli <= 0 || !buyQuote.row.included || buyQuote.row.data.buy_blocked) {
          blockers.push(`${buyCode} 国债 ETF 防御蓄水池缺少当日新鲜报价或未通过现有可买入过滤（included/buy_blocked），本次跳过且不臆造价格。`);
        } else {
          const rules = feeFor(buyCode, 'ETF');
          const sized = sizeEtfBuy({
            priceMilli: buyQuote.freshQuoteMilli,
            budgetCents: reservoirBudgetCents,
            availableCashCents: workingCashCents - cashBufferCents,
            rules,
            minGrossCents: 500_000,
          });
          if (!sized) {
            blockers.push('国债 ETF 防御蓄水池订单不足最低毛额门槛（最低佣金摊薄不经济），本次跳过。');
          } else {
            workingCashCents -= sized.net_cents;
            workingQty.set(buyCode, (workingQty.get(buyCode) ?? 0) + sized.shares);
            etfFeesEstimated = etfFeesEstimated || Boolean(rules.fee_model?.estimated);
            etfLegs.push({
              side: 'BUY',
              ts_code: buyCode,
              name: buyQuote.row.name,
              quantity: sized.shares,
              lot_size: 100,
              lots: sized.shares / 100,
              price_milli: buyQuote.freshQuoteMilli,
              gross_cents: sized.gross_cents,
              fees_cents: sized.fees_cents,
              net_cents: sized.net_cents,
              quote_trade_date: buyQuote.quoteDate,
              executable: true,
              reason: 'P3_DEFENSIVE_BOND_RESERVOIR',
            });
            etfReasons.push(`防御桶中尚未配置到国债 ETF 的闲置资金转入 ${buyCode} 蓄水池，保留日常现金缓冲。`);
          }
        }
      } else if (reservoirTargetCents > 0) {
        const affordableCents = Math.max(0, Math.min(workingCashCents - cashBufferCents, reservoirTargetCents));
        if (affordableCents > 0) {
          blockers.push('国债 ETF 防御蓄水池待配置金额不足最低单腿门槛（最低佣金摊薄不经济），本次跳过。');
        }
      }

      // 无买入腿不得空卖：撤销独立 funding action。
      if (fundingActionIndex >= 0 && stockBuysAdded === 0 && sectorBuysAdded === 0 && !etfLegs.some(leg => leg.side === 'BUY')) {
        actions.splice(fundingActionIndex, 1);
        blockers.push('本次未形成任何可执行的买入腿，已取消国债 ETF 融资卖出。');
      }

      if (etfLegs.length > 0) {
        const buyLegs = etfLegs.filter(leg => leg.side === 'BUY');
        actions.push({
          priority: 'P3',
          code: 'P3-SUPER-ETF-REBALANCE',
          kind: 'ROTATE',
          rank: actions.length + 1,
          title: `底盘超级 ETF 与防御蓄水池再平衡：${buyLegs.length} 笔买入`,
          reasons: etfReasons.slice(0, 2),
          counter_evidence: ['若市场次日跌破风格锚，需随环境切档缩减仓位；按目标差额买入不保证短期相对收益。'],
          legs: etfLegs,
          fees_cents: etfLegs.reduce((sum, leg) => sum + leg.fees_cents, 0),
          fees_estimated: etfFeesEstimated,
          triggers: etfLegs.map(leg => `${leg.side === 'SELL' ? '卖出' : '买入'} ${leg.quantity} 份 ${leg.ts_code}，参考价 ${(leg.price_milli / 1000).toFixed(3)} 元`),
          invalidation_conditions: ['次日高开超过 +2% 或跨境品种盘中溢价超 +2.5%'],
          risk_impact: ['按目标持仓差额而非新增现金均分，避免单一 ETF 被超额买入；蓄水池只使用防御桶资金'],
        });
      }
    }

    // rank 连续：融资 action 可能被撤销（splice）。
    actions.forEach((action, index) => { action.rank = index + 1; });
  }

  return {
    schema: 'portfolio-action-engine/1.0',
    as_of_trade_date: input.asOf,
    market_regime: regime,
    fundamental_regime: fundamentalRegime,
    router,
    deconcentration,
    actions,
    blockers,
    reconciliation_reminder: reconciliationReminder,
    super_etf_candidates: superViews,
    cross_border_monitor: crossBorderMonitor,
    stock_swing_candidates: stockSwingCandidates,
    sector_pioneer_candidates: sectorPioneerCandidates,
    stop_tracker_updates: stopTrackerUpdates,
    ...(alignSummary ? { align_summary: alignSummary } : {}),
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
  if (portfolioTableExists(portfolioDb, 'account_meta')) {
    try {
      const key = `v3_last_regime_style:${output.router.account_id}`;
      const existingRow = portfolioDb.prepare('SELECT value FROM account_meta WHERE key = ?')
        .get(key) as { value?: string } | undefined;
      const old = existingRow?.value ? parseRegimeStyleHistory(String(existingRow.value)) : null;
      const nextCurr: RegimeStylePoint = {
        date: output.as_of_trade_date,
        regime: output.router.effective_regime,
        style: output.market_regime.style,
        eff_budget_bps: output.router.targets.target_equity_bps,
      };
      let nextPrev: RegimeStylePoint | undefined;
      if (old) {
        if (old.curr.date < output.as_of_trade_date) {
          nextPrev = old.curr;
        } else if (old.curr.date === output.as_of_trade_date) {
          nextPrev = old.prev;
        }
      }
      const nextValue: PersistedRegimeStyleHistory = nextPrev
        ? { prev: nextPrev, curr: nextCurr }
        : { curr: nextCurr };
      portfolioDb.prepare(
        'INSERT INTO account_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, JSON.stringify(nextValue));
    } catch (err: any) {
      if (!String(err?.message ?? err).includes('readonly')) throw err;
    }
  }
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
