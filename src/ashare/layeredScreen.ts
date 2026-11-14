import type { DatabaseSync } from 'node:sqlite';
import { analyzeTechnicalDay } from './technicalCandidatesV2.js';
import type { TechnicalViewV2 } from './technicalFrameworkV2.js';
import { screenEtfCandidates, type EtfCandidateScreenResult } from './etfUniverse.js';
import { recentTradeDays } from './ingest.js';
import { computeRps } from './rps.js';

/** A disclosure adapter over the existing research screens, not a trading strategy. */
export function stockLayers(view: TechnicalViewV2) {
  if (view.status !== 'OK') return { status: view.status, reason: view.reason, investable_scope: null, evaluated: null, core: null, signal_focus: null, watch: null, candidates: null, quality: null };
  const stocks = view.research_universe.stocks;
  return {
    status: view.status,
    investable_scope: {
      count: view.coverage.universe,
      definition: 'scanMarket 实际扫描到的股票，并非已验证的全部可投资股票；预筛要求非 ST/退、复权因子、至少130根历史、20日成交额至少0.5亿元及有效收盘价。强制研究代码可额外进入详析。',
    },
    evaluated: { count: view.coverage.analyzed, preselected_including_forced: view.coverage.preselected },
    core: null,
    core_note: '现有 V2 形态数据不构成质量核心库；缺少显式质量核心规则。',
    signal_focus: { rule: 'V2 FOCUS：有效且 research_ready 的确认形态，交易状态正常；属于形态关注候选，仅供研究。', rows: stocks.filter(s => s.research_state === 'FOCUS') },
    watch: { rule: 'V2 WATCH：形成中，或有效形态存在交易限制；仅供研究。', rows: stocks.filter(s => s.research_state === 'WATCH') },
    candidates: { definition: 'V2 有形态记录的去重股票，包含其他状态；不等同全部已评价股票。', rows: stocks },
    exclusions: {
      prescreen_reasons: ['ST/退市标记', '缺复权因子', '历史不足130根', '20日成交额不足0.5亿元或缺失', '收盘价无效'],
      prescreen_reason_counts: null,
      note: '预筛未提供逐项计数；强制研究代码可能在扫描范围之外，因此不能直接相减。无形态的已评价股票未列明。',
      detailed_skipped: { missing_adjustment: view.coverage.skipped_adj_missing, insufficient_history: view.coverage.skipped_insufficient, denominator: view.coverage.preselected },
    },
    quality: { detailed_capacity_limited: view.coverage.capacity_limited, note: '覆盖仅限本地缓存与扫描口径；预筛阶段的历史不足及缺因子数量不可得。' },
  };
}

export function etfLayers(screen: EtfCandidateScreenResult) {
  const rows = screen.candidates;
  const returnedIncluded = rows.filter(row => row.included);
  return {
    status: screen.data_coverage.status,
    investable_scope: { count: screen.universe_discovery.unavailable_reason ? null : screen.universe_discovery.discovered_total, definition: '缓存基础资料中按 ETF 身份及上市日期识别的产品；基础资料非历史时点主数据，不能保证全市场覆盖。' },
    evaluated: { count: screen.evaluated, definition: '声明种子、动态样本及持仓去重后的评估数，可能包含未确认身份或上市状态的种子。' },
    core: null,
    watch: null,
    tier_note: 'ETF 现有筛选没有核心/观察的显式规则，故不推导。',
    candidates: { count: screen.included, rows: returnedIncluded, definition: '现有 ETF 筛选入选项；数据降级不一定导致排除。此入口未指定账户持仓。' },
    exclusions: { denominator: screen.evaluated, count: screen.excluded.length, rows: screen.excluded, note: '仅包括未入选行；持仓的失败项保留在候选明细中。' },
    quality: {
      discovery: screen.universe_discovery,
      coverage: screen.data_coverage,
      degraded_codes: screen.degraded,
      displayed_included: returnedIncluded.length,
      display_omitted: screen.included - returnedIncluded.length,
      row_quality: rows.map(row => ({ ts_code: row.ts_code, bars_used: row.data.bars_used, adj_missing_bars: row.data.adj_missing_bars, latest_bar_date: row.data.latest_bar_date, status_reasons: row.status_reasons })),
    },
  };
}

export function buildLayeredScreen(db: DatabaseSync, asOf: string) {
  const attempt = <T>(fn: () => T): T | { status: 'UNAVAILABLE'; reason: string } => {
    try { return fn(); } catch (error) { return { status: 'UNAVAILABLE', reason: error instanceof Error ? error.message : String(error) }; }
  };
  return {
    schema: 'ashare-layered-research-screen/1.0', as_of: asOf, research_only: true,
    disclaimer: '研究筛选并非生产策略、收益预测或交易建议；缺失数据不作零值。',
    stock: attempt(() => {
      // Match technical-preview: RPS uses up to 260 trading days ending at asOf.
      const days = recentTradeDays(db, asOf, 260);
      const rps = days.length > 1 ? computeRps(db, days[0], asOf) : null;
      return {
        ...stockLayers(analyzeTechnicalDay(db, asOf, rps)),
        rps_quality: rps ? { start: days[0], end: rps.end, version: rps.version, universe: rps.universe, denominators: rps.denominators, input: rps.quality }
          : { status: 'UNAVAILABLE', reason: '交易日不足以计算 RPS', trading_days: days.length },
      };
    }),
    etf: attempt(() => etfLayers(screenEtfCandidates(db, { asOf, heldCodes: [], limit: Number.MAX_SAFE_INTEGER }))),
  };
}
