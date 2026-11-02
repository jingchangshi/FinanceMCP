/**
 * Technical-analysis methodology V2 (goal-1102) — shared contract.
 *
 * This module owns the vocabulary and the deterministic helpers that every V2
 * module agrees on. It performs no I/O and reads no database:
 *
 *   - five research families that independently produce candidates
 *     (TREND_CONTINUATION / PLATFORM_BREAKOUT / REVERSAL /
 *      VOLATILITY_EXPANSION / MEAN_REVERSION), and
 *   - one horizontal price/volume + trading-status context layer that is
 *     stated ONCE per stock, never once per family.
 *
 * Deliberate boundaries:
 *   - There is no cross-family score. `priority`, `entry_score` and the V1
 *     `score * 100` ranking are V1 concepts and are never read here.
 *   - `research_ready` only means "worth putting on the further-research
 *     list". It is not a trade instruction, position size or return forecast.
 *   - Evidence level starts at UNVERIFIED and is never promoted by this
 *     module; promotion requires the existing evidence machinery.
 *   - Stage dates are confirmation dates, never backfilled formation lows.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Regime } from './market.js';
import type { Bars, IndicatorSet } from './indicators.js';

export const TECHNICAL_FRAMEWORK_VERSION = 'technical-v2.0.0';
/** Bump only when the fingerprint algorithm changes, never when a module does. */
export const TECHNICAL_IMPLEMENTATION_SCHEME = 'technical-modules-v1';
/**
 * Compiled modules whose bytes decide what a V2 view contains. `indicators`
 * and `patterns` are included because both families reuse their arithmetic.
 * The list deliberately excludes `hotspotPool`, `entry*` and `strategies`: V2
 * must be independent of the V1 entry/ranking implementation.
 */
export const TECHNICAL_MODULES = [
  'technicalFrameworkV2', 'technicalPatternsV2', 'technicalCandidatesV2',
  'indicators', 'patterns',
] as const;

export function technicalImplementationFingerprint(dirs: { ashare?: string } = {}): string {
  const ashare = dirs.ashare ?? fileURLToPath(new URL('./', import.meta.url));
  const h = createHash('sha256').update(TECHNICAL_IMPLEMENTATION_SCHEME).update('\0');
  for (const name of [...TECHNICAL_MODULES].sort()) {
    h.update(name).update('\0').update(readFileSync(join(ashare, `${name}.js`))).update('\0');
  }
  return createHash('sha256').update(JSON.stringify({ scheme: TECHNICAL_IMPLEMENTATION_SCHEME, build: h.digest('hex') }))
    .digest('hex');
}

// ---------------------------------------------------------------- families

export type TechnicalFamily =
  | 'TREND_CONTINUATION'
  | 'PLATFORM_BREAKOUT'
  | 'REVERSAL'
  | 'VOLATILITY_EXPANSION'
  | 'MEAN_REVERSION';

/** Display and iteration order is fixed so two runs serialize identically. */
export const TECHNICAL_FAMILIES: readonly TechnicalFamily[] = [
  'TREND_CONTINUATION', 'PLATFORM_BREAKOUT', 'REVERSAL', 'VOLATILITY_EXPANSION', 'MEAN_REVERSION',
] as const;

export const FAMILY_LABELS: Record<TechnicalFamily, string> = {
  TREND_CONTINUATION: '趋势延续',
  PLATFORM_BREAKOUT: '平台整理与突破',
  REVERSAL: '底部背离与反转',
  VOLATILITY_EXPANSION: '波动率收缩与扩张',
  MEAN_REVERSION: '震荡中的超跌均值回归',
};

/**
 * Stage semantics (goal-1102 §四):
 *   FORMING         — the price behaviour is observable but the confirming
 *                     price action has not happened.
 *   CONFIRMED       — the confirmation bar is the evaluation bar.
 *   FOLLOW_THROUGH  — the confirmation is older and the contract still holds.
 *   FAILED          — a declared invalidation happened; the episode is over.
 *   EXPIRED         — the observation window elapsed without failure.
 * A pattern is never restated at a lower stage. FORMING is never
 * `research_ready`.
 */
export type TechnicalStage = 'FORMING' | 'CONFIRMED' | 'FOLLOW_THROUGH' | 'FAILED' | 'EXPIRED';

/** Sort: confirmed/continuation first, then forming, then dead episodes. */
export const STAGE_ORDER: Record<TechnicalStage, number> = {
  CONFIRMED: 0, FOLLOW_THROUGH: 1, FORMING: 2, FAILED: 3, EXPIRED: 4,
};

export type EvidenceLevel = 'UNVERIFIED';

// ---------------------------------------------------------------- context

export type PriceVolumeTag =
  | 'VOLUME_EXPANSION'
  | 'VOLUME_CONTRACTION'
  | 'RAPID_RUNUP'
  | 'SHARP_REVERSAL'
  | 'LONG_UPPER_SHADOW'
  | 'ONE_PRICE_LIMIT_DOWN'
  | 'ONE_PRICE_LIMIT_UP'
  | 'SUSPENDED'
  | 'NO_BAR'
  | 'STALE_BAR'
  | 'ADJUSTMENT_INCOMPLETE';

export type TradingStatus =
  | 'TRADABLE'
  | 'SUSPENDED'
  | 'NO_BAR'
  | 'ONE_PRICE_LIMIT_DOWN'
  | 'ONE_PRICE_LIMIT_UP'
  | 'LIMIT_UNKNOWN';

export interface PriceVolumeContext {
  ts_code: string;
  name: string;
  /** Last daily bar used for technical evaluation (may precede `as_of`). */
  trade_date: string;
  as_of: string;
  /** Trade-day distance between the last bar and the as-of day (0 = same day). */
  bars_behind_as_of: number;
  trading_status: TradingStatus;
  price_volume_tags: PriceVolumeTag[];
  market_regime: Regime | 'UNKNOWN';
  close: number | null;
  pct_chg: number | null;
  volume_ratio_20: number | null;
  atr_pct: number | null;
  /** Background only — never a V2 gate or a standalone win-rate claim. */
  rps120: number | null;
  /** Human-readable context, stated once per stock. */
  notes: string[];
}

export interface RawContextInput {
  ts_code: string;
  name: string;
  asOf: string;
  bars: {
    dates: string[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    rawOpen: number[];
    rawHigh?: number[];
    rawLow?: number[];
    rawClose: number[];
    vol: number[];
    upLimit: number[];
    downLimit?: number[];
    adjMissing?: number;
  };
  endIdx: number;
  suspendedOnAsOf: boolean;
  /** Trade-day distance from the last bar to `asOf` (0 when the bar is as-of). */
  barsBehindAsOf: number;
  volumeRatio20: number | null;
  atrPct: number | null;
  pctChg: number | null;
  rps120: number | null;
  market_regime: Regime | 'UNKNOWN';
}

const near = (a: number | null | undefined, b: number | null | undefined, tol = 0.001): boolean =>
  typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)
  && Math.abs(a - b) <= tol;

/** One-price bar: open == high == low == close (a limit seal or a no-trade day). */
export function isOnePriceBar(i: number, b: RawContextInput['bars']): boolean {
  const rh = b.rawHigh ?? b.high;
  const rl = b.rawLow ?? b.low;
  return near(b.rawOpen[i], rh[i]) && near(rh[i], rl[i]) && near(rl[i], b.rawClose[i]);
}

export interface TradingVerdict {
  status: TradingStatus;
  tags: PriceVolumeTag[];
  blockers: string[];
}

/**
 * Trading state is decided BEFORE any pattern stage can mean "ready". A
 * suspended name, a missing bar, or a one-price limit-down close can never be
 * a normal research-ready candidate — no matter how close the price is to a
 * historical confirmation level after a fall (goal-1102 §六.1).
 */
export function tradingVerdict(input: Pick<RawContextInput,
  'bars' | 'endIdx' | 'suspendedOnAsOf' | 'barsBehindAsOf'>): TradingVerdict {
  const { bars: b, endIdx: i } = input;
  const tags: PriceVolumeTag[] = [];
  const blockers: string[] = [];
  if (input.suspendedOnAsOf) {
    tags.push('SUSPENDED');
    blockers.push('SUSPENDED');
    return { status: 'SUSPENDED', tags, blockers };
  }
  if (i < 0) {
    tags.push('NO_BAR');
    blockers.push('NO_BAR');
    return { status: 'NO_BAR', tags, blockers };
  }
  if (input.barsBehindAsOf > 0) {
    tags.push('STALE_BAR');
    blockers.push('NO_BAR_ON_AS_OF');
  }
  const onePrice = isOnePriceBar(i, b);
  const up = b.upLimit[i];
  const down = b.downLimit?.[i];
  if (onePrice && typeof down === 'number' && Number.isFinite(down) && near(b.rawClose[i], down)) {
    tags.push('ONE_PRICE_LIMIT_DOWN');
    blockers.push('ONE_PRICE_LIMIT_DOWN');
    return { status: 'ONE_PRICE_LIMIT_DOWN', tags, blockers };
  }
  if (onePrice && typeof up === 'number' && Number.isFinite(up) && near(b.rawClose[i], up)) {
    tags.push('ONE_PRICE_LIMIT_UP');
    blockers.push('ONE_PRICE_LIMIT_UP');
    return { status: 'ONE_PRICE_LIMIT_UP', tags, blockers };
  }
  if (onePrice && (!(typeof down === 'number' && Number.isFinite(down)) || !(typeof up === 'number' && Number.isFinite(up)))) {
    return { status: 'LIMIT_UNKNOWN', tags, blockers: ['LIMIT_UNKNOWN'] };
  }
  return { status: 'TRADABLE', tags, blockers };
}

/**
 * Horizontal price/volume labels. These are explanations, not extra bullish
 * signals: the number of tags is never a score. Only the trading-status
 * blockers above are hard research blockers.
 */
export function priceVolumeTags(i: number, b: RawContextInput['bars'], volumeRatio20: number | null): PriceVolumeTag[] {
  const out: PriceVolumeTag[] = [];
  if (i < 0) return out;
  if (Number.isFinite(volumeRatio20 as number)) {
    if ((volumeRatio20 as number) >= 1.5) out.push('VOLUME_EXPANSION');
    else if ((volumeRatio20 as number) <= 0.6) out.push('VOLUME_CONTRACTION');
  }
  const c = b.close;
  const o = b.open;
  const h = b.high;
  const l = b.low;
  if (i >= 5 && Number.isFinite(c[i]) && Number.isFinite(c[i - 5]) && c[i - 5] > 0) {
    const ret5 = c[i] / c[i - 5] - 1;
    if (ret5 >= 0.15) out.push('RAPID_RUNUP');
    if (i >= 1 && Number.isFinite(o[i]) && Number.isFinite(c[i - 1]) && c[i - 1] > 0) {
      const day = c[i] / c[i - 1] - 1;
      if (day <= -0.05 && ret5 >= 0.05) out.push('SHARP_REVERSAL');
      if (day >= 0.05 && ret5 <= -0.05) out.push('SHARP_REVERSAL');
    }
  }
  if (Number.isFinite(h[i]) && Number.isFinite(l[i]) && h[i] > l[i] && Number.isFinite(o[i]) && Number.isFinite(c[i])) {
    const bodyTop = Math.max(o[i], c[i]);
    const upper = (h[i] - bodyTop) / (h[i] - l[i]);
    if (upper >= 0.6) out.push('LONG_UPPER_SHADOW');
  }
  if ((b.adjMissing ?? 0) > 0) out.push('ADJUSTMENT_INCOMPLETE');
  return out;
}

export function contextNotes(v: TradingVerdict, tags: PriceVolumeTag[], barsBehindAsOf: number): string[] {
  const notes: string[] = [];
  if (v.status === 'SUSPENDED') notes.push('as-of 日停牌：不生成可正常交易的确认候选');
  if (v.status === 'NO_BAR') notes.push('as-of 日无 K 线且无停牌记录：按缺数处理，不使用前一交易日冒充当日');
  if (v.status === 'ONE_PRICE_LIMIT_DOWN') notes.push('as-of 日一字跌停：保留历史形态，但不进入正常研究清单');
  if (v.status === 'ONE_PRICE_LIMIT_UP') notes.push('as-of 日一字涨停：买入研究受成交约束');
  if (v.status === 'LIMIT_UNKNOWN' && tags.includes('ONE_PRICE_LIMIT_DOWN')) notes.push('一字K线但缺少跌停价，交易约束未知');
  if (barsBehindAsOf > 0 && v.status !== 'SUSPENDED' && v.status !== 'NO_BAR') {
    notes.push(`最后一根K线为 ${barsBehindAsOf} 个交易日前，不视为 as-of 当日数据`);
  }
  if (tags.includes('ADJUSTMENT_INCOMPLETE')) notes.push('区间复权因子缺失：技术形态不可靠');
  if (tags.includes('RAPID_RUNUP')) notes.push('短期急涨：突破类形态需与充分整理区分');
  if (tags.includes('SHARP_REVERSAL')) notes.push('短期急跌/急涨反转：仅作量价解释');
  if (tags.includes('LONG_UPPER_SHADOW')) notes.push('长上影：上方抛压观察，不是独立做空信号');
  return notes;
}

/** Build the one shared context record for a stock. */
export function buildPriceVolumeContext(input: RawContextInput): PriceVolumeContext {
  const verdict = tradingVerdict({
    bars: input.bars, endIdx: input.endIdx,
    suspendedOnAsOf: input.suspendedOnAsOf, barsBehindAsOf: input.barsBehindAsOf,
  });
  const tags = [...verdict.tags, ...priceVolumeTags(input.endIdx, input.bars, input.volumeRatio20)];
  const i = input.endIdx;
  return {
    ts_code: input.ts_code,
    name: input.name,
    trade_date: i >= 0 ? input.bars.dates[i] : '',
    as_of: input.asOf,
    bars_behind_as_of: input.barsBehindAsOf,
    trading_status: verdict.status,
    price_volume_tags: [...new Set(tags)],
    market_regime: input.market_regime,
    close: i >= 0 ? input.bars.rawClose[i] : null,
    pct_chg: input.pctChg,
    volume_ratio_20: input.volumeRatio20,
    atr_pct: input.atrPct,
    rps120: input.rps120,
    notes: contextNotes(verdict, tags, input.barsBehindAsOf),
  };
}

// ---------------------------------------------------------------- candidates

/** Everything a family detector may read. Only indices <= endIdx are valid. */
export interface PatternInput {
  code: string;
  bars: Bars;
  x: IndicatorSet;
  endIdx: number;
  asOf: string;
  regime: Regime | 'UNKNOWN';
  /** Per-bar RPS120 for background only, aligned to `bars.dates`. */
  rps120: Array<number | null> | null;
  /** Trade-day distance from the last bar to `asOf` (0 = current bar). */
  barsBehindAsOf: number;
}

export interface PatternObservation {  strategy_id: string;
  family: TechnicalFamily;
  stage: TechnicalStage;
  /** Family-specific stage label, e.g. PLATFORM_FORMING / BREAKOUT_CONFIRMED. */
  stage_detail: string;
  formed_on: string | null;
  confirmed_on: string | null;
  last_evaluated_on: string;
  formation_basis: string[];
  confirmation_conditions: string[];
  invalidation_conditions: string[];
  invalidation: { on: string; reason: string } | null;
  key_levels: Record<string, number | null>;
  evidence: Record<string, number | string | boolean | null>;
}

export interface TechnicalCandidateV2 extends Omit<PatternObservation, 'family'> {
  ts_code: string;
  name: string;
  /** Last bar the pattern was evaluated on. Never a backfilled or borrowed date. */
  trade_date: string;
  as_of: string;
  family: TechnicalFamily;
  confirmation_lag: number;
  market_regime: Regime | 'UNKNOWN';
  price_volume_tags: PriceVolumeTag[];
  trading_status: TradingStatus;
  research_ready: boolean;
  research_blockers: string[];
  evidence_level: EvidenceLevel;
}

export interface TechnicalFamilyView {
  family: TechnicalFamily;
  label: string;
  definition: string;
  candidates: TechnicalCandidateV2[];
  counts: Record<TechnicalStage, number> & { total: number; research_ready: number };
}

export interface TechnicalViewV2 {
  status: 'OK' | 'UNAVAILABLE';
  reason: string | null;
  framework_version: string;
  implementation_fingerprint: string;
  as_of: string;
  market_regime: Regime | 'UNKNOWN';
  methodology_note: string;
  /** One record per stock, however many families list it. */
  contexts: PriceVolumeContext[];
  families: TechnicalFamilyView[];
  coverage: {
    universe: number;
    preselected: number;
    analyzed: number;
    skipped_adj_missing: number;
    skipped_insufficient: number;
    capacity_limited: number;
  };
  evidence_level: EvidenceLevel;
  research_only: true;
}

export const METHODOLOGY_NOTE =
  'V2 五类策略独立产出候选，不合并为跨策略 100 分或胜率。阶段仅表示价格行为的可证时机；'
  + 'research_ready 只表示进入进一步研究清单，不是交易指令。全部证据等级默认 UNVERIFIED。';

/**
 * `research_ready` is the conjunction of a live confirmation and a normal
 * trading state. FORMING is intentionally excluded: it is an observation.
 */
export function researchReadiness(stage: TechnicalStage, status: TradingStatus): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (stage === 'FORMING') blockers.push('STAGE_FORMING');
  if (stage === 'FAILED') blockers.push('STAGE_FAILED');
  if (stage === 'EXPIRED') blockers.push('STAGE_EXPIRED');
  if (status === 'SUSPENDED') blockers.push('SUSPENDED');
  if (status === 'NO_BAR') blockers.push('NO_BAR');
  if (status === 'ONE_PRICE_LIMIT_DOWN') blockers.push('ONE_PRICE_LIMIT_DOWN');
  if (status === 'ONE_PRICE_LIMIT_UP') blockers.push('ONE_PRICE_LIMIT_UP');
  if (status === 'LIMIT_UNKNOWN') blockers.push('LIMIT_UNKNOWN');
  return { ready: blockers.length === 0, blockers };
}

/** Deterministic order: confirmed/continuation, then forming, then dead. */
export function compareCandidates(a: TechnicalCandidateV2, b: TechnicalCandidateV2): number {
  return (STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
    || ((b.confirmed_on ?? '').localeCompare(a.confirmed_on ?? ''))
    || a.ts_code.localeCompare(b.ts_code)
    || a.strategy_id.localeCompare(b.strategy_id);
}

export function emptyStageCounts(): Record<TechnicalStage, number> & { total: number; research_ready: number } {
  return { FORMING: 0, CONFIRMED: 0, FOLLOW_THROUGH: 0, FAILED: 0, EXPIRED: 0, total: 0, research_ready: 0 };
}
