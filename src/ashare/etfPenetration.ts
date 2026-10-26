/**
 * ETF 穿透研究摘要（goal-1026 §4.1 十二项数据 + §4.2 归因）。
 *
 * 边界与纪律：
 *  - 核心是纯函数：`buildEtfPenetrationSummary(input)` / `buildPriceAttribution(input)`
 *    不做任何 IO；`collectEtfPenetrationInputs(db, opts)` 是可选的只读本地缓存读取器，
 *    供开发期与验收组装真实输入（不访问网络）。
 *  - 成分股权重必须带有效日期（weight_date）；相对 as_of 过期时显式标注
 *    `freshness.status`，禁止把历史权重称为最新权重。
 *  - 权重来源三级：显式传入 weightRows+weightDate → 数据文件缓存
 *    `$ASHARE_DATA_DIR/etf-weights/<code>.json`（weightCaptureCli 只读采集落盘）→
 *    均无则 UNAVAILABLE（不 throw、不臆造）。
 *  - 覆盖率按分量计算（成分/财报/估值/预测/行情），缺口逐条列出；
 *    **禁止用代表性企业代替 ETF 整体**：覆盖不足时对应结论块置为
 *    `insufficient_evidence` 且不给出伪精确数字。
 *  - 盈利预测只做历史描述；不可靠时标缺口，不宣称识别出错误定价。
 *  - 每个结论块标注 evidence_class：
 *    `verified_fact`（已验证的基本面事实）/ `model_derived`（模型推导）/
 *    `interpretation`（主观解释）/ `insufficient_evidence`（证据不足）。
 *  - 归因恒等式：盈利增长 + 预期修订 + 估值倍数变化 + 分红 + 残差 ≡ 总回报，
 *    相关性与分解是描述，不作因果宣称。
 *  - 不做任何费用/SUPER_ETF 分类（费用分类属于 portfolio/fees.ts 的既有边界）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { financialsAsOf } from './data.js';
import { addDays } from './ingest.js';
import { ashareDataDir } from './db.js';

export const ETF_PENETRATION_SCHEMA = 'etf-penetration-summary@1';
export const ETF_PENETRATION_VERSION = 'etf-penetration-20261026-v1';
/** 权重新鲜度阈值：成分权重多为月末刷新，超过 45 个自然日判为过期。 */
export const DEFAULT_MAX_WEIGHT_AGE_DAYS = 45;

export type EvidenceClass = 'verified_fact' | 'model_derived' | 'interpretation' | 'insufficient_evidence';

export interface PenetrationGap {
  /** 缺口的机器可读代码，如 `fundamentals_coverage`、`benchmark_index_daily`。 */
  code: string;
  field: string;
  description: string;
}

export interface WeightFreshness {
  status: 'CURRENT' | 'STALE' | 'FUTURE_DATED' | 'UNAVAILABLE';
  weight_date: string | null;
  as_of: string;
  age_days: number | null;
  max_weight_age_days: number;
  note: string;
}

export interface CoverageRow {
  component: 'constituents' | 'fundamentals' | 'valuation' | 'forecasts' | 'stock_prices' | 'etf_prices';
  covered: number;
  total: number;
  /** 已覆盖条目的权重占比（%），成分股口径；非成分股分量为 null。 */
  weight_covered_pct: number | null;
  status: 'COMPLETE' | 'PARTIAL' | 'MISSING';
}

export interface ConstituentRow {
  con_code: string;
  weight: number;
  name?: string | null;
  industry?: string | null;
}

export interface FundamentalFact {
  end_date: string;
  ann_date: string;
  netprofit_yoy?: number | null;
  or_yoy?: number | null;
  grossprofit_margin?: number | null;
  ocf_to_profit?: number | null;
  roe?: number | null;
}

export interface ValuationFact {
  pe_ttm?: number | null;
  pb?: number | null;
  ps_ttm?: number | null;
  dv_ttm?: number | null;
  total_mv?: number | null;
}

export interface ForecastFact {
  ann_date: string;
  end_date: string;
  type?: string | null;
  p_change_min?: number | null;
  p_change_max?: number | null;
}

export interface DriverEvidence {
  /** 调用方提供的反证叙述（研究判断，标 interpretation）。 */
  counters?: Array<{ claim: string; basis: string }>;
}

export interface ComparableRow {
  ts_code: string;
  name: string | null;
  kind: 'broad_based' | 'same_theme_etf' | 'industry_etf';
  return_pct: number | null;
  /** ETF 回报 − 该对比标的回报（百分点；正=ETF 跑赢）。 */
  etf_excess_pct: number | null;
  /** 区间日收益相关系数（≥20 个配对日才给出）。 */
  correlation: number | null;
}

/** §4.2 归因的输入分量（调用方/采集器提供，纯函数只做分解）。 */
export interface AttributionInput {
  /** 归因窗口起止（交易日，YYYYMMDD），仅作元数据。 */
  start_date: string;
  end_date: string;
  /** 区间 ETF 总回报（价格，%）。 */
  etf_price_return_pct: number;
  /** 区间分红等现金分派的近似收益贡献（%）；无法估计时为 null。 */
  dividend_return_pct: number | null;
  start_pe_median: number | null;
  end_pe_median: number | null;
  /** 区间起点时点的加权营收同比（%），公告日约束。 */
  start_weighted_or_yoy_pct: number | null;
  end_weighted_or_yoy_pct: number | null;
  /** 预期修订：无可靠数据时为 null（模块强制该分支为证据不足）。 */
  start_weighted_forecast_pct: number | null;
  end_weighted_forecast_pct: number | null;
}

export interface PriceAttribution {
  evidence_class: 'model_derived';
  status: 'DECOMPOSED' | 'INSUFFICIENT_EVIDENCE';
  start_date: string;
  end_date: string;
  total_return_pct: number;
  components: {
    earnings_growth_pp: number | null;
    forecast_revision_pp: number | null;
    valuation_multiple_pp: number | null;
    dividend_pp: number | null;
    residual_pp: number;
  };
  /** 分解口径说明与不可作因果解读的告诫。 */
  method: string;
  gaps: PenetrationGap[];
}

export interface EtfPenetrationInput {
  as_of: string;
  etf: {
    ts_code: string;
    name?: string | null;
    /** fund_basic.benchmark 原文（跟踪标的名称），缺失即缺口。 */
    benchmark?: string | null;
    list_date?: string | null;
  };
  /** 跟踪指数代码；只有当该指数在 index_daily 有缓存时才做指数对比。 */
  benchmark_index_code?: string | null;
  weight: {
    source: 'index_weight' | 'fund_portfolio';
    /** index_weight 必带；fund_portfolio 无则为 null。 */
    index_code?: string | null;
    weight_date: string;
    /** 数据发布/公告日（fund_portfolio 的最晚 ann_date；index_weight 未知为 null）。 */
    publication_date?: string | null;
    rows: ConstituentRow[];
  };
  fundamentals?: Record<string, FundamentalFact>;
  valuations?: Record<string, ValuationFact>;
  forecasts?: Record<string, ForecastFact[]>;
  etfPerformance?: {
    start_date: string | null;
    end_date: string | null;
    window_sessions: number;
    return_pct: number | null;
    /** true=分红已复权进价格（fund_adj 因子）；false=价格不含分红。 */
    dividend_adjusted: boolean;
    note?: string | null;
  } | null;
  benchmarkPerformance?: {
    return_pct: number | null;
    window_sessions: number;
    note?: string | null;
  } | null;
  driverEvidence?: DriverEvidence;
  comparables?: ComparableRow[];
  attribution?: AttributionInput | null;
  /** 成分股在 as_of 的行情覆盖（由组装方统计：本地 daily 缓存命中的成分数量）。 */
  stockPriceCoverage?: { covered: number; total: number; weight_covered_pct: number | null } | null;
  freshness?: { max_weight_age_days?: number };
}

export interface EtfPenetrationSummary {
  schema: typeof ETF_PENETRATION_SCHEMA;
  version: string;
  as_of: string;
  generated_note: string;
  etf: {
    ts_code: string;
    name: string | null;
    benchmark: string | null;
    benchmark_index_code: string | null;
  };
  constituents: {
    evidence_class: EvidenceClass;
    source: string;
    weight_date: string;
    publication_date: string | null;
    count: number;
    weight_sum_pct: number;
    freshness: WeightFreshness;
    top: Array<{ con_code: string; name: string | null; weight_pct: number }>;
    concentration: {
      top1_weight_pct: number;
      top5_weight_pct: number;
      top10_weight_pct: number;
      hhi: number;
    };
  };
  coverage: { components: CoverageRow[] };
  earnings: {
    evidence_class: EvidenceClass;
    report_period_latest: string | null;
    weighted: { or_yoy_pct: number; netprofit_yoy_pct: number; weight_covered_pct: number } | null;
    top_positive: Array<{ con_code: string; name: string | null; weight_pct: number; netprofit_yoy_pct: number | null; or_yoy_pct: number | null }>;
    top_negative: Array<{ con_code: string; name: string | null; weight_pct: number; netprofit_yoy_pct: number | null; or_yoy_pct: number | null }>;
    gaps: PenetrationGap[];
  };
  margins_cashflow: {
    evidence_class: EvidenceClass;
    weighted: { grossprofit_margin_pct: number; roe_pct: number | null; ocf_to_profit: number | null; weight_covered_pct: number } | null;
    /** 经营现金流/净利润明显偏低（<60%）的权重与清单，现金流质量反证。 */
    weak_cash_conversion: { weight_pct: number; rows: Array<{ con_code: string; name: string | null; weight_pct: number; ocf_to_profit: number }> };
    gaps: PenetrationGap[];
  };
  valuation: {
    evidence_class: EvidenceClass;
    price_date: string;
    weighted: { pe_ttm: number | null; pb: number | null; ps_ttm: number | null; dv_ttm: number | null } | null;
    /** pe_ttm<=0 或缺失（亏损/不可比）的权重占比（%）。 */
    pe_not_meaningful_weight_pct: number;
    history: {
      evidence_class: EvidenceClass;
      start_date: string | null;
      end_date: string;
      start_pe_median: number | null;
      end_pe_median: number | null;
      change_pct: number | null;
      note: string;
    };
    gaps: PenetrationGap[];
  };
  forecasts: {
    evidence_class: EvidenceClass;
    coverage: { covered: number; total: number };
    latest: Array<{ con_code: string; ann_date: string; end_date: string; type: string | null; p_change_min: number | null; p_change_max: number | null }>;
    note: string;
    gaps: PenetrationGap[];
  };
  performance: {
    evidence_class: EvidenceClass;
    etf: { start_date: string | null; end_date: string | null; window_sessions: number; return_pct: number | null; dividend_adjusted: boolean; note: string | null };
    benchmark: { return_pct: number | null; excess_pct: number | null; note: string | null };
    gaps: PenetrationGap[];
  };
  drivers: {
    evidence_class: EvidenceClass;
    /** 加权贡献近似 = 权重 × 同比（算术分解，非因果）。 */
    earnings_contributors: { positive: Array<{ con_code: string; name: string | null; weight_pct: number; netprofit_yoy_pct: number | null; contribution_pp: number | null }>; negative: Array<{ con_code: string; name: string | null; weight_pct: number; netprofit_yoy_pct: number | null; contribution_pp: number | null }> };
    counters: Array<{ claim: string; basis: string; evidence_class: EvidenceClass }>;
    method_note: string;
  };
  comparables: {
    evidence_class: EvidenceClass;
    rows: ComparableRow[];
    gaps: PenetrationGap[];
  };
  attribution: PriceAttribution | null;
  gaps: PenetrationGap[];
  sources: string[];
}

// ------------------------------------------------------------------ helpers

export function daysBetween(earlier: string, later: string): number {
  const a = Date.UTC(+earlier.slice(0, 4), +earlier.slice(4, 6) - 1, +earlier.slice(6, 8));
  const b = Date.UTC(+later.slice(0, 4), +later.slice(4, 6) - 1, +later.slice(6, 8));
  return Math.round((b - a) / 86400000);
}

const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 权重有效日期的显式新鲜度判定；未来日期单独标注，过期必须让调用方看见。 */
export function weightFreshness(weightDate: string | null | undefined, asOf: string, maxAgeDays = DEFAULT_MAX_WEIGHT_AGE_DAYS): WeightFreshness {
  const base = { as_of: asOf, max_weight_age_days: maxAgeDays };
  if (!weightDate || !/^\d{8}$/.test(weightDate)) {
    return { ...base, status: 'UNAVAILABLE', weight_date: null, age_days: null, note: '成分权重缺少有效日期，禁止把任何权重称为最新权重。' };
  }
  const age = daysBetween(weightDate, asOf);
  if (age < 0) {
    return { ...base, status: 'FUTURE_DATED', weight_date: weightDate, age_days: age, note: `权重日期 ${weightDate} 晚于研究时点 ${asOf}，时序不合法。` };
  }
  if (age > maxAgeDays) {
    return { ...base, status: 'STALE', weight_date: weightDate, age_days: age, note: `权重日期 ${weightDate} 距 ${asOf} 已 ${age} 天，超过 ${maxAgeDays} 天阈值，属过期权重，不能当作最新持仓。` };
  }
  return { ...base, status: 'CURRENT', weight_date: weightDate, age_days: age, note: `权重日期 ${weightDate}，距 ${asOf} ${age} 天，在 ${maxAgeDays} 天阈值内。` };
}

function weightOf(covered: Set<string>, weights: Map<string, number>): number {
  let w = 0;
  for (const [code, weight] of weights) if (covered.has(code)) w += weight;
  return round(w);
}

function makeCoverage(component: CoverageRow['component'], covered: number, total: number, weightPct: number | null): CoverageRow {
  const status: CoverageRow['status'] = total === 0 ? 'MISSING' : covered >= total ? 'COMPLETE' : covered > 0 ? 'PARTIAL' : 'MISSING';
  return { component, covered, total, weight_covered_pct: weightPct, status };
}

/** 按权重加权的平均值，只在有效值上归一化（并报告覆盖权重）。 */
function weightedAvg(entries: Array<{ weight: number; value: number | null }>): { value: number | null; weightCovered: number } {
  let ws = 0;
  let vs = 0;
  for (const e of entries) {
    if (e.value === null || !Number.isFinite(e.value)) continue;
    ws += e.weight;
    vs += e.value * e.weight;
  }
  return { value: ws > 0 ? round(vs / ws) : null, weightCovered: round(ws) };
}

function topBy<T>(rows: T[], score: (row: T) => number, limit = 5): T[] {
  return [...rows].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/**
 * §4.2 归因分解（纯函数、可复现）：
 *  - earnings_growth = 加权营收增速的同比变化（盈利增长的当期代理）；
 *  - forecast_revision = 加权一致预期（业绩预告口径）的变化；无可靠预期数据 → null；
 *  - valuation_multiple = ln(end_PE / start_PE)（倍数变化的对数近似）；
 *  - dividend = 调用方给出的现金分派近似贡献；不可估计 → null（并在缺口披露）；
 *  - residual = total − 以上可得分量之和（恒等式保证）。
 * 分解是代数恒等，不是因果识别；不得据此宣称市场错误定价。
 */
export function buildPriceAttribution(input: AttributionInput): PriceAttribution {
  const gaps: PenetrationGap[] = [];
  const get = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : v);

  const earningsStart = get(input.start_weighted_or_yoy_pct);
  const earningsEnd = get(input.end_weighted_or_yoy_pct);
  const earnings = earningsStart !== null && earningsEnd !== null ? round(earningsEnd - earningsStart) : null;
  if (earnings === null) {
    gaps.push({ code: 'attribution_earnings_unavailable', field: 'start_weighted_or_yoy_pct/end_weighted_or_yoy_pct', description: '归因窗口两端缺少公告日约束下的加权营收增速，盈利增长分量不可得。' });
  }

  const fcStart = get(input.start_weighted_forecast_pct);
  const fcEnd = get(input.end_weighted_forecast_pct);
  let forecast: number | null = null;
  if (fcStart !== null && fcEnd !== null) {
    forecast = round(fcEnd - fcStart);
  } else {
    gaps.push({
      code: 'attribution_forecast_unavailable', field: 'start_weighted_forecast_pct/end_weighted_forecast_pct',
      description: '缺少可靠的一致盈利预期数据（本地缓存无预期库；业绩预告是离散事实而非市场预期），预期修订分量按证据不足处理。',
    });
  }

  let valuation: number | null = null;
  const peStart = get(input.start_pe_median);
  const peEnd = get(input.end_pe_median);
  if (peStart !== null && peEnd !== null && peStart > 0 && peEnd > 0) {
    valuation = round((Math.log(peEnd) - Math.log(peStart)) * 100);
  } else {
    gaps.push({ code: 'attribution_valuation_unavailable', field: 'start_pe_median/end_pe_median', description: '归因窗口两端缺少可比的成分加权 PE 中位数（亏损或缺行情），估值倍数分量不可得。' });
  }

  const dividend = get(input.dividend_return_pct);
  if (dividend === null) {
    gaps.push({ code: 'attribution_dividend_unavailable', field: 'dividend_return_pct', description: 'ETF 现金分派记录未缓存，分红贡献不可估计（价格口径是否含分红见 performance 分量）。' });
  }

  const total = round(input.etf_price_return_pct);
  const knownParts = [earnings, forecast, valuation, dividend].filter((v): v is number => v !== null);
  // 残差 = 总回报 − 全部可得分量之和；不可得分量（null）由残差一并吸收，
  // 恒等式成立：Σ(可得分量 + 残差) = total（null 分量不重复计数）。
  const knownSum = round(knownParts.reduce((s, v) => s + v, 0));
  const residual = round(total - knownSum);

  return {
    evidence_class: 'model_derived',
    status: knownParts.length >= 1 ? 'DECOMPOSED' : 'INSUFFICIENT_EVIDENCE',
    start_date: input.start_date,
    end_date: input.end_date,
    total_return_pct: total,
    components: {
      earnings_growth_pp: earnings,
      forecast_revision_pp: forecast,
      valuation_multiple_pp: valuation,
      dividend_pp: dividend,
      residual_pp: residual,
    },
    method: 'earnings_growth=窗口两端加权营收同比之差；forecast_revision=窗口两端加权（业绩预告口径）预期之差，无可靠预期数据时为 null；valuation_multiple=ln(end_PE/start_PE)×100；dividend=现金分派收益近似；residual=total−其余可得分量。恒等式：各分量之和=总回报（残差吸收全部未建模项）。分解是代数恒等与描述性归因，不构成因果识别。',
    gaps,
  };
}

/** 盈利驱动：加权贡献近似（权重 × 同比 / 100），按贡献排序取正负各 topN。 */
function topEarningsContributions(
  rows: Array<{ con_code: string; name: string | null; weight: number; netprofit_yoy: number | null }>,
  limit = 3,
) {
  const scored = rows.flatMap(r => {
    const npy = r.netprofit_yoy;
    if (npy === null || !Number.isFinite(npy)) return [];
    return [{ ...r, netprofit_yoy: npy, contribution: round((r.weight * npy) / 100) }];
  });
  const positive = topBy(scored.filter(r => r.contribution > 0), r => r.contribution, limit)
    .map(r => ({ con_code: r.con_code, name: r.name, weight_pct: r.weight, netprofit_yoy_pct: r.netprofit_yoy, contribution_pp: r.contribution }));
  const negative = topBy(scored.filter(r => r.contribution < 0), r => -r.contribution, limit)
    .map(r => ({ con_code: r.con_code, name: r.name, weight_pct: r.weight, netprofit_yoy_pct: r.netprofit_yoy, contribution_pp: r.contribution }));
  return { positive, negative };
}

/**
 * 组装穿透研究摘要（纯函数）。缺什么就报什么缺口：覆盖不足的结论块
 * `evidence_class` 落到 `insufficient_evidence`，不输出伪精确数字，
 * 也不用任何代表性企业替代 ETF 整体。
 */
export function buildEtfPenetrationSummary(input: EtfPenetrationInput): EtfPenetrationSummary {
  const asOf = input.as_of;
  const gaps: PenetrationGap[] = [];
  const sources: string[] = [];
  const maxWeightAge = input.freshness?.max_weight_age_days ?? DEFAULT_MAX_WEIGHT_AGE_DAYS;

  const weights = new Map<string, number>();
  let weightSum = 0;
  for (const row of input.weight.rows) {
    weights.set(row.con_code, row.weight);
    weightSum += row.weight;
  }
  const n = weights.size;
  const sorted = [...input.weight.rows].sort((a, b) => b.weight - a.weight);

  // ---- freshness & source
  const freshness = weightFreshness(input.weight.weight_date, asOf, maxWeightAge);
  if (freshness.status === 'STALE' || freshness.status === 'FUTURE_DATED' || freshness.status === 'UNAVAILABLE') {
    gaps.push({ code: `weight_${freshness.status.toLowerCase()}`, field: 'weight_date', description: freshness.note });
  }
  if (input.weight.source === 'index_weight') {
    sources.push(`index_weight(${input.weight.index_code ?? 'unknown'}@${input.weight.weight_date})`);
  } else {
    sources.push(`fund_portfolio(${input.etf.ts_code}@${input.weight.weight_date}${input.weight.publication_date ? `,ann=${input.weight.publication_date}` : ''})`);
  }
  if (input.weight.source === 'fund_portfolio' && freshness.age_days !== null && freshness.age_days > 0) {
    gaps.push({
      code: 'fund_portfolio_lag', field: 'weight_date',
      description: `基金持仓为季度定期报告口径，该口径天然落后于研究时点 ${freshness.age_days} 天；期间的成分调整未反映。`,
    });
  }
  if (!input.etf.name) gaps.push({ code: 'fund_basic_name', field: 'etf.name', description: 'fund_basic 未缓存该 ETF 名称。' });
  if (!input.etf.benchmark) gaps.push({ code: 'fund_basic_benchmark', field: 'etf.benchmark', description: 'fund_basic.benchmark（跟踪标的）缺失，跟踪指数只能来自外部核验的声明。' });
  if (!input.benchmark_index_code) {
    gaps.push({ code: 'benchmark_index_code', field: 'benchmark_index_code', description: '跟踪指数代码未经权威来源核验，指数日线对比不可用。' });
  }

  // ---- concentration
  const top1 = sorted[0]?.weight ?? 0;
  const sumUp = (k: number) => round(sorted.slice(0, k).reduce((s, r) => s + r.weight, 0));
  const hhi = round(sorted.reduce((s, r) => s + r.weight ** 2, 0) / 100, 2); // 权重按 %，HHI∈[0,100]

  // ---- coverage components
  const fundamentals = input.fundamentals ?? {};
  const valuations = input.valuations ?? {};
  const forecasts = input.forecasts ?? {};
  const finaCovered = new Set(Object.keys(fundamentals));
  const valCovered = new Set(Object.keys(valuations));
  const fcCovered = new Set(Object.keys(forecasts).filter(c => (forecasts[c]?.length ?? 0) > 0));

  const etfPerf = input.etfPerformance ?? null;
  const benchmarkPerf = input.benchmarkPerformance ?? null;
  const spc = input.stockPriceCoverage ?? null;

  const components: CoverageRow[] = [
    makeCoverage('constituents', n, n, n ? round(weightSum) : null),
    makeCoverage('fundamentals', finaCovered.size, n, weightOf(finaCovered, weights)),
    makeCoverage('valuation', valCovered.size, n, weightOf(valCovered, weights)),
    makeCoverage('forecasts', fcCovered.size, n, weightOf(fcCovered, weights)),
    spc
      ? makeCoverage('stock_prices', spc.covered, spc.total, spc.weight_covered_pct)
      : makeCoverage('stock_prices', 0, 0, null),
    makeCoverage('etf_prices', etfPerf?.return_pct !== null && etfPerf?.return_pct !== undefined ? 1 : 0, 1, null),
  ];
  const byComponent = (c: CoverageRow['component']): CoverageRow => components.find(x => x.component === c)!;

  const fundCoverage = byComponent('fundamentals');
  const valCoverage = byComponent('valuation');
  const fcCoverage = byComponent('forecasts');
  if (fundCoverage.status !== 'COMPLETE') {
    gaps.push({ code: 'fundamentals_coverage', field: 'fundamentals', description: `成分股财报覆盖 ${fundCoverage.covered}/${fundCoverage.total}（权重 ${fundCoverage.weight_covered_pct}%），缺口不得用代表性企业替代。` });
  }
  if (fcCoverage.status !== 'COMPLETE') {
    gaps.push({ code: 'forecasts_coverage', field: 'forecasts', description: `盈利预测覆盖 ${fcCoverage.covered}/${fcCoverage.total}（权重 ${fcCoverage.weight_covered_pct}%）。` });
  }
  if (components.find(x => x.component === 'etf_prices')?.status !== 'COMPLETE') {
    gaps.push({ code: 'etf_prices', field: 'etfPerformance', description: 'ETF 区间行情缺失，表现分量不可得。' });
  }
  if (!benchmarkPerf?.return_pct && benchmarkPerf?.return_pct !== 0) {
    gaps.push({ code: 'benchmark_performance', field: 'benchmarkPerformance', description: '跟踪指数区间行情缺失（index_daily 未缓存该指数），无法计算相对基准表现。' });
  }

  // ---- earnings
  const finaRows = sorted
    .filter(r => fundCoverage.weight_covered_pct !== null && fundCoverage.weight_covered_pct > 0)
    .map(r => ({ row: r, f: fundamentals[r.con_code] }))
    .filter(x => x.f !== undefined);
  const reportPeriods = [...new Set(finaRows.map(x => x.f!.end_date))].sort();
  const orAvg = weightedAvg(finaRows.map(x => ({ weight: x.row.weight, value: num(x.f!.or_yoy) })));
  const npAvg = weightedAvg(finaRows.map(x => ({ weight: x.row.weight, value: num(x.f!.netprofit_yoy) })));
  const earningsComplete = fundCoverage.status === 'COMPLETE' && orAvg.value !== null && npAvg.value !== null;
  const npSorted = [...finaRows].sort((a, b) => (num(b.f!.netprofit_yoy) ?? -Infinity) - (num(a.f!.netprofit_yoy) ?? -Infinity));
  const earnings = {
    evidence_class: (earningsComplete ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    report_period_latest: reportPeriods.at(-1) ?? null,
    weighted: earningsComplete
      ? { or_yoy_pct: orAvg.value!, netprofit_yoy_pct: npAvg.value!, weight_covered_pct: fundCoverage.weight_covered_pct! }
      : null,
    top_positive: npSorted.slice(0, 5).map(x => ({ con_code: x.row.con_code, name: x.row.name ?? null, weight_pct: x.row.weight, netprofit_yoy_pct: num(x.f!.netprofit_yoy), or_yoy_pct: num(x.f!.or_yoy) })),
    top_negative: npSorted.slice(-5).reverse().map(x => ({ con_code: x.row.con_code, name: x.row.name ?? null, weight_pct: x.row.weight, netprofit_yoy_pct: num(x.f!.netprofit_yoy), or_yoy_pct: num(x.f!.or_yoy) })),
    gaps: earningsComplete ? [] : [{ code: 'earnings_insufficient', field: 'earnings.weighted', description: '成分覆盖或增速字段不足，加权营收/净利润增速不可信，按证据不足处理。' }],
  };

  // ---- margins & cash flow
  const gmAvg = weightedAvg(finaRows.map(x => ({ weight: x.row.weight, value: num(x.f!.grossprofit_margin) })));
  const roeAvg = weightedAvg(finaRows.map(x => ({ weight: x.row.weight, value: num(x.f!.roe) })));
  const ocfAvg = weightedAvg(finaRows.map(x => ({ weight: x.row.weight, value: num(x.f!.ocf_to_profit) })));
  const weakCash = finaRows
    .map(x => ({ con_code: x.row.con_code, name: x.row.name ?? null, weight_pct: x.row.weight, ocf_to_profit: num(x.f!.ocf_to_profit) }))
    .filter(r => r.ocf_to_profit !== null && r.ocf_to_profit < 60);
  const marginsComplete = fundCoverage.status === 'COMPLETE' && gmAvg.value !== null;
  const margins = {
    evidence_class: (marginsComplete ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    weighted: marginsComplete
      ? { grossprofit_margin_pct: gmAvg.value!, roe_pct: roeAvg.value, ocf_to_profit: ocfAvg.value, weight_covered_pct: fundCoverage.weight_covered_pct! }
      : null,
    weak_cash_conversion: {
      weight_pct: round(weakCash.reduce((s, r) => s + r.weight_pct, 0)),
      rows: weakCash.filter((r): r is { con_code: string; name: string | null; weight_pct: number; ocf_to_profit: number } => r.ocf_to_profit !== null),
    },
    gaps: marginsComplete ? [] : [{ code: 'margins_insufficient', field: 'margins_cashflow', description: '毛利率等字段覆盖不足，利润率结论按证据不足处理。' }],
  };

  // ---- valuation
  const valRows = sorted.map(r => ({ row: r, v: valuations[r.con_code] })).filter(x => x.v !== undefined);
  const peAvg = weightedAvg(valRows.map(x => ({ weight: x.row.weight, value: num(x.v!.pe_ttm) })));
  const pbAvg = weightedAvg(valRows.map(x => ({ weight: x.row.weight, value: num(x.v!.pb) })));
  const psAvg = weightedAvg(valRows.map(x => ({ weight: x.row.weight, value: num(x.v!.ps_ttm) })));
  const dvAvg = weightedAvg(valRows.map(x => ({ weight: x.row.weight, value: num(x.v!.dv_ttm) })));
  const peMissWeight = round(valRows
    .filter(x => { const pe = num(x.v!.pe_ttm); return pe === null || pe <= 0; })
    .reduce((s, x) => s + x.row.weight, 0));
  const valComplete = valCoverage.status === 'COMPLETE';
  const valuation = {
    evidence_class: (valComplete ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    price_date: asOf,
    weighted: valComplete
      ? { pe_ttm: peAvg.value, pb: pbAvg.value, ps_ttm: psAvg.value, dv_ttm: dvAvg.value }
      : null,
    pe_not_meaningful_weight_pct: peMissWeight,
    history: {
      evidence_class: 'insufficient_evidence' as EvidenceClass,
      start_date: null,
      end_date: asOf,
      start_pe_median: null,
      end_pe_median: null,
      change_pct: null,
      note: '本地缓存无逐股历史估值（daily_basic 仅按日缓存且窗口未采集），估值历史变化不可得；归因窗口两端 PE 由组装方以窗口端点采集后回填。',
    },
    gaps: valComplete ? [] : [{ code: 'valuation_coverage', field: 'valuation', description: `估值覆盖 ${valCoverage.covered}/${valCoverage.total}（权重 ${valCoverage.weight_covered_pct}%）。` }],
  };
  if (!valComplete) {
    gaps.push({ code: 'valuation_coverage', field: 'valuation', description: `估值覆盖 ${valCoverage.covered}/${valCoverage.total}（权重 ${valCoverage.weight_covered_pct}%），估值结论按证据不足处理。` });
  }

  // ---- forecasts
  const fcLatest = [...fcCovered]
    .map(code => {
      const rows = [...(forecasts[code] ?? [])].sort((a, b) => (b.ann_date > a.ann_date ? 1 : -1));
      const r = rows[0];
      return r ? { con_code: code, ann_date: r.ann_date, end_date: r.end_date, type: r.type ?? null, p_change_min: r.p_change_min ?? null, p_change_max: r.p_change_max ?? null } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => (b.ann_date > a.ann_date ? 1 : -1))
    .slice(0, 10);
  const forecastsBlock = {
    evidence_class: (fcCoverage.status === 'COMPLETE' ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    coverage: { covered: fcCoverage.covered, total: fcCoverage.total },
    latest: fcLatest,
    note: '业绩预告是公司披露的离散事实，不是市场一致预期；本摘要不将其表述为预期修订，也不据此宣称错误定价。' +
      (fcCoverage.status === 'COMPLETE' ? '' : '覆盖不足，相关结论按证据不足处理。'),
    gaps: fcCoverage.status === 'COMPLETE'
      ? []
      : [{ code: 'forecast_revision_unavailable', field: 'forecasts', description: `盈利预测覆盖 ${fcCoverage.covered}/${fcCoverage.total}；无可靠一致预期库，预期修订归因分量为 null。` }],
  };

  // ---- performance
  const perf = {
    evidence_class: (etfPerf?.return_pct !== null && etfPerf?.return_pct !== undefined ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    etf: {
      start_date: etfPerf?.start_date ?? null,
      end_date: etfPerf?.end_date ?? null,
      window_sessions: etfPerf?.window_sessions ?? 0,
      return_pct: etfPerf?.return_pct ?? null,
      dividend_adjusted: etfPerf?.dividend_adjusted ?? false,
      note: etfPerf?.note ?? (etfPerf?.return_pct === null || etfPerf === null ? 'ETF 区间行情缺失。' : null),
    },
    benchmark: {
      return_pct: benchmarkPerf?.return_pct ?? null,
      excess_pct: etfPerf?.return_pct !== null && etfPerf?.return_pct !== undefined && benchmarkPerf?.return_pct !== null && benchmarkPerf?.return_pct !== undefined
        ? round(etfPerf.return_pct - benchmarkPerf.return_pct) : null,
      note: benchmarkPerf?.note ?? '跟踪指数行情缺失。',
    },
    gaps: [] as PenetrationGap[],
  };

  // ---- drivers
  const contribRows = finaRows.map(x => ({ con_code: x.row.con_code, name: x.row.name ?? null, weight: x.row.weight, netprofit_yoy: num(x.f!.netprofit_yoy) }));
  const contributions = topEarningsContributions(contribRows);
  const counters = (input.driverEvidence?.counters ?? []).map(c => ({ ...c, evidence_class: 'interpretation' as EvidenceClass }));
  const drivers = {
    evidence_class: (earningsComplete ? 'model_derived' : 'insufficient_evidence') as EvidenceClass,
    earnings_contributors: contributions,
    counters,
    method_note: '贡献=权重×净利润同比/100 的算术分解（近似，忽略权重变动与基数效应），按贡献排序；这是描述性排序，不是因果归因。反证条目为主观解释（interpretation），须另有事实依据。',
  };

  // ---- comparables
  const comparableGaps: PenetrationGap[] = [];
  if (!input.comparables?.length) {
    comparableGaps.push({ code: 'comparables_missing', field: 'comparables', description: '宽基/行业/同类 ETF 对比数据缺失（本地 fund_daily 需按代码缓存）。' });
  }
  const comparables = {
    evidence_class: (input.comparables?.length ? 'verified_fact' : 'insufficient_evidence') as EvidenceClass,
    rows: input.comparables ?? [],
    gaps: comparableGaps,
  };

  // ---- attribution (from provided window inputs)
  const attribution = input.attribution ? buildPriceAttribution(input.attribution) : null;
  if (!attribution) {
    gaps.push({ code: 'attribution_input_missing', field: 'attribution', description: '归因窗口输入未提供，§4.2 分解未执行。' });
  } else {
    gaps.push(...attribution.gaps);
  }

  if (spc && spc.total > 0 && spc.covered < spc.total) {
    gaps.push({ code: 'stock_prices_coverage', field: 'stockPriceCoverage', description: `成分股行情覆盖 ${spc.covered}/${spc.total}（权重 ${spc.weight_covered_pct}%）。` });
  }

  const summary: EtfPenetrationSummary = {
    schema: ETF_PENETRATION_SCHEMA,
    version: ETF_PENETRATION_VERSION,
    as_of: asOf,
    generated_note: '穿透研究摘要：结论块按 evidence_class 区分（verified_fact=已验证事实、model_derived=模型推导、interpretation=主观解释、insufficient_evidence=证据不足）；覆盖率与缺口逐条列示，覆盖不足时不做 ETF 整体断言。',
    etf: {
      ts_code: input.etf.ts_code,
      name: input.etf.name ?? null,
      benchmark: input.etf.benchmark ?? null,
      benchmark_index_code: input.benchmark_index_code ?? null,
    },
    constituents: {
      evidence_class: 'verified_fact',
      source: input.weight.source,
      weight_date: input.weight.weight_date,
      publication_date: input.weight.publication_date ?? null,
      count: n,
      weight_sum_pct: round(weightSum),
      freshness,
      top: sorted.slice(0, 10).map(r => ({ con_code: r.con_code, name: r.name ?? null, weight_pct: r.weight })),
      concentration: { top1_weight_pct: top1, top5_weight_pct: sumUp(5), top10_weight_pct: sumUp(10), hhi },
    },
    coverage: { components },
    earnings,
    margins_cashflow: margins,
    valuation,
    forecasts: forecastsBlock,
    performance: perf,
    drivers,
    comparables,
    attribution,
    gaps,
    sources,
  };
  return summary;
}

// ------------------------------------------------------------------ collector

export interface CollectOptions {
  as_of: string;
  etfCode: string;
  /**
   * 权重有效日期（index_weight 的 trade_date 或 fund_portfolio 的 end_date）。
   * 空串/缺省时：先读 `$ASHARE_DATA_DIR/etf-weights/<etfCode>.json` 数据文件缓存
   * （由 weightCaptureCli 只读采集落盘）；缓存也无则 UNAVAILABLE（不 throw）。
   */
  weightDate?: string;
  /** 归因/表现窗口的交易日数（默认 20）。 */
  window_sessions?: number;
  /** 成分股权重的上游行（由调用方只读取得，本函数不访问网络）。 */
  weightRows?: Array<{ con_code: string; weight: number }>;
  weightSource?: 'index_weight' | 'fund_portfolio';
  indexCode?: string | null;
  benchmarkIndexCode?: string | null;
  /** fund_portfolio 口径下的报告期公告日。 */
  weightPublicationDate?: string | null;
  forecastRows?: Record<string, ForecastFact[]>;
  comparables?: Array<{ ts_code: string; kind: ComparableRow['kind'] }>;
  driverEvidence?: DriverEvidence;
  /** 覆盖数据根（测试用；缺省 ashareDataDir()）。 */
  dataDir?: string;
}

/** `$ASHARE_DATA_DIR/etf-weights/<code>.json` 的文件契约（weightCaptureCli 写入）。 */
export interface WeightCacheFile {
  schema?: string;
  as_of: string;
  weight_date: string;
  weight_source: 'index_weight' | 'fund_portfolio';
  publication_date: string | null;
  index_code: string | null;
  weightRows: Array<{ ts_code: string; weight: number }>;
  captured_at: string;
  source_note?: string;
}

export function etfWeightCachePath(etfCode: string, dataDir?: string): string {
  return join(dataDir ?? ashareDataDir(), 'etf-weights', `${etfCode}.json`);
}

/**
 * 读取权重数据文件缓存。文件缺失/损坏/日期非法/空行 → 返回 null（不 throw），
 * 调用方按 UNAVAILABLE 降级。weight_date 必须是 8 位数字才被采信。
 */
export function readEtfWeightCache(etfCode: string, dataDir?: string): WeightCacheFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(etfWeightCachePath(etfCode, dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const file = parsed as Partial<WeightCacheFile>;
  const weightDate = String(file.weight_date ?? '');
  if (!/^\d{8}$/.test(weightDate)) return null;
  if (!Array.isArray(file.weightRows)) return null;
  const rows: WeightCacheFile['weightRows'] = [];
  for (const raw of file.weightRows) {
    const code = String((raw as any)?.ts_code ?? (raw as any)?.con_code ?? '');
    const weight = Number((raw as any)?.weight);
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(code) && Number.isFinite(weight)) rows.push({ ts_code: code, weight });
  }
  if (!rows.length) return null;
  return {
    schema: file.schema,
    as_of: String(file.as_of ?? ''),
    weight_date: weightDate,
    weight_source: file.weight_source === 'index_weight' ? 'index_weight' : 'fund_portfolio',
    publication_date: file.publication_date ?? null,
    index_code: file.index_code ?? null,
    weightRows: rows,
    captured_at: String(file.captured_at ?? ''),
    source_note: file.source_note,
  };
}

interface FundRow { ts_code: string; name: string | null; benchmark: string | null; list_date: string | null }

function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** 复权收盘价序列（与 etfResearch 同口径：不跨缺失因子桥接）。 */
function adjSeries(db: DatabaseSync, code: string, start: string, end: string): Array<{ date: string; close: number }> {
  if (!hasTable(db, 'fund_daily')) return [];
  const rows = db.prepare(`
    SELECT d.trade_date, d.close, a.adj_factor FROM fund_daily d
    LEFT JOIN fund_adj a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
    WHERE d.ts_code = ? AND d.trade_date BETWEEN ? AND ? ORDER BY d.trade_date`).all(code, start, end) as any[];
  if (!rows.length) return [];
  const base = rows[0].adj_factor;
  if (!(base > 0)) return [];
  return rows
    .filter(r => r.adj_factor !== null && r.adj_factor > 0 && r.close > 0)
    .map(r => ({ date: r.trade_date, close: round(r.close * r.adj_factor / base, 6) }));
}

function seriesReturn(series: Array<{ date: string; close: number }>): { return_pct: number | null; start: string | null; end: string | null } {
  if (series.length < 2) return { return_pct: null, start: null, end: null };
  const first = series[0];
  const last = series[series.length - 1];
  return { return_pct: round((last.close / first.close - 1) * 100), start: first.date, end: last.date };
}

function corrOf(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 20) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(a), mb = mean(b);
  let numr = 0, da = 0, dbv = 0;
  for (let i = 0; i < a.length; i++) {
    numr += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbv += (b[i] - mb) ** 2;
  }
  return da > 0 && dbv > 0 ? round(numr / Math.sqrt(da * dbv), 4) : null;
}

function dailyReturns(series: Array<{ date: string; close: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1].close > 0) out.set(series[i].date, series[i].close / series[i - 1].close - 1);
  }
  return out;
}

/** 分位数（含端点的线性插值中位数口径）。 */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : round((xs[mid - 1] + xs[mid]) / 2, 4);
}

/**
 * 组装 `buildEtfPenetrationSummary` 的输入：只读本地缓存 + 调用方提供的
 * 成分权重行。不做网络请求，不写库。缺表/缺数一律降级为缺口而非抛错。
 */
export function collectEtfPenetrationInputs(db: DatabaseSync, opts: CollectOptions): EtfPenetrationInput {
  const asOf = opts.as_of;
  const window = Math.max(2, Math.trunc(opts.window_sessions ?? 20));

  // fund_basic（ETF 资料与跟踪标的）
  const fund = (hasTable(db, 'fund_basic')
    ? db.prepare('SELECT ts_code, name, benchmark, list_date FROM fund_basic WHERE ts_code = ?').get(opts.etfCode) as FundRow | undefined
    : undefined) ?? null;
  const etfCode = opts.etfCode;

  // ---- 权重解析（三级）：显式传入 → etf-weights 数据文件缓存 → UNAVAILABLE。
  // 显式成立条件 = 有行 且 weightDate 为合法 8 位日期；否则尝试缓存文件；
  // 缓存也无 → weight_date=''（weightFreshness → UNAVAILABLE）且 rows 为空，
  // 调用方（bundle 层）按 rows.length===0 降级，全程不 throw、不臆造。
  const explicitWeight = (opts.weightRows?.length ?? 0) > 0 && /^\d{8}$/.test(opts.weightDate ?? '');
  let weightRows: Array<{ con_code: string; weight: number }> = explicitWeight ? opts.weightRows! : [];
  let weightDate = explicitWeight ? opts.weightDate! : '';
  let weightSource: 'index_weight' | 'fund_portfolio' | null = explicitWeight ? (opts.weightSource ?? null) : null;
  let publicationDate: string | null = explicitWeight ? (opts.weightPublicationDate ?? null) : null;
  let indexCode: string | null = explicitWeight ? (opts.indexCode ?? null) : null;
  if (!explicitWeight) {
    const cached = readEtfWeightCache(etfCode, opts.dataDir);
    if (cached) {
      weightRows = cached.weightRows.map(r => ({ con_code: r.ts_code, weight: r.weight }));
      weightDate = cached.weight_date;
      weightSource = cached.weight_source;
      publicationDate = cached.publication_date;
      indexCode = cached.index_code;
    }
  }

  // 名称/行业来自本地 stock_basic，仅补充展示字段
  const nameMap = new Map<string, { name: string | null; industry: string | null }>();
  if (hasTable(db, 'stock_basic') && weightRows.length) {
    const codes = weightRows.map(r => r.con_code);
    for (const row of db.prepare(`SELECT ts_code, name, industry FROM stock_basic WHERE ts_code IN (${codes.map(() => '?').join(',')})`).all(...codes) as any[]) {
      nameMap.set(row.ts_code, { name: row.name ?? null, industry: row.industry ?? null });
    }
  }
  const weight: EtfPenetrationInput['weight'] = {
    source: weightSource ?? 'fund_portfolio',
    index_code: indexCode,
    weight_date: weightDate,
    publication_date: publicationDate,
    rows: weightRows.map(r => ({
      con_code: r.con_code, weight: r.weight,
      name: nameMap.get(r.con_code)?.name ?? null,
      industry: nameMap.get(r.con_code)?.industry ?? null,
    })),
  };

  // 财报（公告日约束）与估值：只取该 ETF 的成分股，覆盖率才有意义
  const conCodes = weightRows.map(r => r.con_code);
  const inCon = conCodes.length ? `(${conCodes.map(() => '?').join(',')})` : '(NULL)';
  const fundamentals: Record<string, FundamentalFact> = {};
  if (hasTable(db, 'fina_indicator') && conCodes.length) {
    for (const row of db.prepare(`
      SELECT * FROM (
        SELECT f.*, ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY end_date DESC, ann_date DESC) rn
        FROM fina_indicator f
        WHERE ann_date <= ? AND end_date >= ? AND ann_date >= end_date AND ts_code IN ${inCon}
      ) WHERE rn = 1`).all(asOf, addDays(asOf, -550), ...conCodes) as any[]) {
      fundamentals[row.ts_code] = {
        end_date: row.end_date, ann_date: row.ann_date,
        netprofit_yoy: num(row.netprofit_yoy), or_yoy: num(row.or_yoy),
        grossprofit_margin: num(row.grossprofit_margin), ocf_to_profit: num(row.ocf_to_profit), roe: num(row.roe),
      };
    }
  }
  const valuations: Record<string, ValuationFact> = {};
  if (hasTable(db, 'daily_basic') && conCodes.length) {
    for (const row of db.prepare(`SELECT ts_code, pe_ttm, pb, ps_ttm, dv_ttm, total_mv FROM daily_basic WHERE trade_date = ? AND ts_code IN ${inCon}`)
      .all(asOf, ...conCodes) as any[]) {
      valuations[row.ts_code] = {
        pe_ttm: num(row.pe_ttm), pb: num(row.pb), ps_ttm: num(row.ps_ttm), dv_ttm: num(row.dv_ttm), total_mv: num(row.total_mv),
      };
    }
  }

  // ETF 表现（复权口径含分红再投资近似）
  const etfSeries = adjSeries(db, etfCode, windowStartDate(db, asOf, window), asOf);
  const etfRet = seriesReturn(etfSeries);
  const etfPerformance: EtfPenetrationInput['etfPerformance'] = etfSeries.length >= 2
    ? {
      start_date: etfRet.start, end_date: etfRet.end, window_sessions: etfSeries.length - 1,
      return_pct: etfRet.return_pct, dividend_adjusted: true,
      note: '按 fund_adj 复权因子计算，含份额拆分调整；分红再投资为近似（因子口径），非精确总回报。',
    }
    : null;

  // 跟踪指数表现（仅当 index_daily 缓存了该指数）
  let benchmarkPerformance: EtfPenetrationInput['benchmarkPerformance'] = null;
  if (opts.benchmarkIndexCode && hasTable(db, 'index_daily')) {
    const rows = db.prepare('SELECT trade_date, close FROM index_daily WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date')
      .all(opts.benchmarkIndexCode, etfRet.start ?? asOf, asOf) as any[];
    const closes = rows.map(r => ({ date: r.trade_date, close: Number(r.close) })).filter(r => Number.isFinite(r.close) && r.close > 0);
    const bRet = seriesReturn(closes);
    benchmarkPerformance = closes.length >= 2
      ? { return_pct: bRet.return_pct, window_sessions: closes.length - 1, note: '指数收盘价（价格指数，不含分红）。' }
      : { return_pct: null, window_sessions: 0, note: `index_daily 未缓存 ${opts.benchmarkIndexCode} 的区间行情。` };
  }

  // 成分股行情覆盖
  let stockPriceCoverage: EtfPenetrationInput['stockPriceCoverage'] = null;
  if (hasTable(db, 'daily') && weightRows.length) {
    const coveredSet = new Set<string>();
    let weightCovered = 0;
    const totalW = weightRows.reduce((s, r) => s + r.weight, 0) || 1;
    for (const row of weightRows) {
      const hit = db.prepare('SELECT 1 FROM daily WHERE ts_code = ? AND trade_date = ?').get(row.con_code, asOf);
      if (hit) { coveredSet.add(row.con_code); weightCovered += row.weight; }
    }
    stockPriceCoverage = { covered: coveredSet.size, total: weightRows.length, weight_covered_pct: round((weightCovered / totalW) * 100) };
  }

  // 可比 ETF
  const comparables: ComparableRow[] = [];
  const subjectRetMap = dailyReturns(etfSeries);
  for (const peer of opts.comparables ?? []) {
    const peerSeries = adjSeries(db, peer.ts_code, etfRet.start ?? asOf, asOf);
    const pRet = seriesReturn(peerSeries);
    const peerRetMap = dailyReturns(peerSeries);
    const dates = [...subjectRetMap.keys()].filter(d => peerRetMap.has(d)).sort();
    let name: string | null = null;
    if (hasTable(db, 'fund_basic')) {
      name = (db.prepare('SELECT name FROM fund_basic WHERE ts_code = ?').get(peer.ts_code) as any)?.name ?? null;
    }
    comparables.push({
      ts_code: peer.ts_code, name, kind: peer.kind,
      return_pct: pRet.return_pct,
      etf_excess_pct: etfRet.return_pct !== null && pRet.return_pct !== null ? round(etfRet.return_pct - pRet.return_pct) : null,
      correlation: corrOf(dates.map(d => subjectRetMap.get(d)!), dates.map(d => peerRetMap.get(d)!)),
    });
  }

  // 归因窗口输入：窗口两端的加权增速与 PE 中位数
  const start = etfRet.start ?? asOf;
  const codes = weightRows.map(r => r.con_code);
  const peAt = (date: string): number | null => {
    if (!hasTable(db, 'daily_basic') || !codes.length) return null;
    const vals = (db.prepare(`SELECT pe_ttm FROM daily_basic WHERE trade_date = ? AND ts_code IN (${codes.map(() => '?').join(',')})`).all(date, ...codes) as any[])
      .map(r => num(r.pe_ttm))
      .filter((v): v is number => v !== null && v > 0);
    return median(vals);
  };
  const weightedYoYAt = (date: string): number | null => {
    if (!hasTable(db, 'fina_indicator')) return null;
    const fin = financialsAsOf(db, date);
    const entries: Array<{ weight: number; value: number | null }> = [];
    for (const row of weightRows) {
      const f = fin.get(row.con_code);
      entries.push({ weight: row.weight, value: f ? num(f.or_yoy) : null });
    }
    return weightedAvg(entries).value;
  };
  const attribution: AttributionInput | null = (etfRet.return_pct !== null)
    ? {
      start_date: start, end_date: etfRet.end ?? asOf,
      etf_price_return_pct: etfRet.return_pct,
      dividend_return_pct: null, // 现金分派记录未缓存 → 缺口披露
      start_pe_median: peAt(start), end_pe_median: peAt(etfRet.end ?? asOf),
      start_weighted_or_yoy_pct: weightedYoYAt(start), end_weighted_or_yoy_pct: weightedYoYAt(asOf),
      start_weighted_forecast_pct: null, end_weighted_forecast_pct: null, // 无可靠一致预期 → 证据不足
    }
    : null;

  return {
    as_of: asOf,
    etf: { ts_code: etfCode, name: fund?.name ?? null, benchmark: fund?.benchmark ?? null, list_date: fund?.list_date ?? null },
    benchmark_index_code: opts.benchmarkIndexCode ?? null,
    weight,
    fundamentals,
    valuations,
    forecasts: opts.forecastRows ?? {},
    etfPerformance,
    benchmarkPerformance,
    driverEvidence: opts.driverEvidence,
    comparables: comparables.length ? comparables : undefined,
    attribution,
    stockPriceCoverage,
    freshness: { max_weight_age_days: DEFAULT_MAX_WEIGHT_AGE_DAYS },
  };
}

function windowStartDate(db: DatabaseSync, asOf: string, sessions: number): string {
  if (!hasTable(db, 'fund_daily')) return asOf;
  // ORDER DESC → rows[0] 是最新，rows.at(-1) 才是窗口起点。
  const rows = db.prepare('SELECT DISTINCT trade_date FROM fund_daily WHERE trade_date <= ? ORDER BY trade_date DESC LIMIT ?').all(asOf, sessions + 1) as any[];
  return rows.at(-1)?.trade_date ?? asOf;
}
