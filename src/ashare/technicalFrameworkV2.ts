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

export const TECHNICAL_FRAMEWORK_VERSION = 'technical-v2.1.0';
/** Bump only when the fingerprint algorithm changes, never when a module does. */
export const TECHNICAL_IMPLEMENTATION_SCHEME = 'technical-modules-v1';
/**
 * Compiled modules whose bytes decide what a V2 view contains. `indicators`
 * and `patterns` are included because both families reuse their arithmetic;
 * `technicalResearchStateV2` because it decides the single research state and
 * the highlights; `analysis`/`bars`/`ingest`/`market` because they feed the
 * prescreen, the bars and the regime; `rps` because RPS is part of the context.
 * The list deliberately excludes `hotspotPool`, `entry*` and `strategies`: V2
 * must be independent of the V1 entry/ranking implementation.
 */
export const TECHNICAL_MODULES = [
  'technicalFrameworkV2', 'technicalPatternsV2', 'technicalCandidatesV2',
  'technicalResearchStateV2', 'indicators', 'patterns',
  'analysis', 'bars', 'ingest', 'market', 'rps',
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

// ---------------------------------------------------------------- price position

/**
 * Fixed engineering hypothesis (goal-1106 WP4): a live setup is "price
 * extended" when the close sits at least 3.0 ATR14 units above its MA20.
 *
 * Why 3.0: MA20 is the structural anchor the trend families are defined
 * against (20 trading days ≈ one month of cost basis); ATR14 is the trailing
 * daily range, so `(close - MA20) / ATR14` measures how many *typical days of
 * movement* the price has already travelled away from that anchor. Three
 * typical days is far enough that the current price is no longer a normal
 * continuation entry relative to the confirmed structure, regardless of which
 * family produced the confirmation. It is a fixed, pre-registered research
 * hypothesis — NOT fitted to any example stock, NOT validated against returns,
 * and it carries no proven return edge. It applies to any live family; RSI is
 * descriptive only and never a gate, and MA250 is not used at all.
 */
export const PRICE_EXTENSION_ATR_THRESHOLD = 3.0;

/**
 * Descriptive price-location facts for one observation. Every price field is
 * expressed on the SAME forward-adjusted close basis as the bars/indicators
 * (`close`, MA20, MA60, ATR14, reference and invalidation levels). Raw display
 * prices live in `key_levels`; they are never subtracted from adjusted values.
 *
 * These fields explain where price is relative to the structure. They are not
 * an entry score, probability or ranking.
 */
export interface PricePosition {
  basis: 'adjusted_close';
  close: number | null;
  ma20: number | null;
  ma60: number | null;
  atr14: number | null;
  rsi6: number | null;
  rsi14: number | null;
  /** Fractional change `close / MA20 - 1` (0.05 = +5%). */
  close_vs_ma20_pct: number | null;
  /** `(close - MA20) / ATR14`: distance from the structural anchor in volatility units. */
  close_vs_ma20_atr: number | null;
  /** Fractional change `close / MA60 - 1`. */
  close_vs_ma60_pct: number | null;
  ma20_above_ma60: boolean | null;
  /** MA20 today above MA20 five bars ago. */
  ma20_rising: boolean | null;
  /** Adjusted price the pattern's confirmation is measured against (MA20 / neckline / band / close). */
  reference_price: number | null;
  /** What `reference_price` is, e.g. `ma20_reclaim`, `neckline`, `boll_upper`. */
  reference_kind: string | null;
  reference_distance_pct: number | null;
  reference_distance_atr: number | null;
  /** Trading bars since the confirmation bar; null when not confirmed. */
  bars_since_confirmation: number | null;
  /** Adjusted price level whose breach invalidates the pattern, when it is a price (not a DIF) level. */
  invalidation_level: number | null;
  invalidation_distance_pct: number | null;
  invalidation_distance_atr: number | null;
  /** Leading hypothesis: `close_vs_ma20_atr >= PRICE_EXTENSION_ATR_THRESHOLD`. */
  price_extension: boolean;
  /** Field names and arithmetic behind `price_extension`, for audit. */
  price_extension_basis: string[];
}

export interface PricePositionInput {
  /** Adjusted close of the evaluated bar. */
  close: number | null;
  x: IndicatorSet;
  endIdx: number;
  /** Index of the confirmation bar, or null when the observation is not confirmed. */
  confirmedIdx?: number | null;
  /** Adjusted reference price (pattern key level). */
  referencePrice?: number | null;
  referenceKind?: string | null;
  /** Adjusted invalidation price level, when the invalidation is a price condition. */
  invalidationLevel?: number | null;
}

const r4 = (v: number | null): number | null => (typeof v === 'number' && Number.isFinite(v)
  ? Math.round(v * 10_000) / 10_000 : null);

function finiteOrNull(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Build the descriptive price-position record. Pure; reads only indices <= endIdx. */
export function buildPricePosition(input: PricePositionInput): PricePosition {
  const i = input.endIdx;
  const close = finiteOrNull(input.close);
  const ma20 = finiteOrNull(input.x.ma20[i]);
  const ma60 = finiteOrNull(input.x.ma60[i]);
  const atr14 = finiteOrNull(input.x.atr14[i]);
  const reference = finiteOrNull(input.referencePrice);
  const invalidation = finiteOrNull(input.invalidationLevel);
  const confirmedIdx = typeof input.confirmedIdx === 'number' && input.confirmedIdx >= 0 ? input.confirmedIdx : null;

  const closeVsMa20Pct = close !== null && ma20 !== null && ma20 !== 0 ? close / ma20 - 1 : null;
  const closeVsMa20Atr = close !== null && ma20 !== null && atr14 !== null && atr14 > 0 ? (close - ma20) / atr14 : null;
  const closeVsMa60Pct = close !== null && ma60 !== null && ma60 !== 0 ? close / ma60 - 1 : null;
  const refPct = close !== null && reference !== null && reference !== 0 ? close / reference - 1 : null;
  const refAtr = close !== null && reference !== null && atr14 !== null && atr14 > 0 ? (close - reference) / atr14 : null;
  const invPct = close !== null && invalidation !== null && invalidation !== 0 ? close / invalidation - 1 : null;
  const invAtr = close !== null && invalidation !== null && atr14 !== null && atr14 > 0 ? (close - invalidation) / atr14 : null;

  const extended = closeVsMa20Atr !== null && closeVsMa20Atr >= PRICE_EXTENSION_ATR_THRESHOLD;
  const basis: string[] = [];
  if (close !== null) basis.push(`close(adjusted)=${r4(close)}`);
  if (ma20 !== null) basis.push(`ma20=${r4(ma20)}`);
  if (atr14 !== null) basis.push(`atr14=${r4(atr14)}`);
  if (closeVsMa20Atr !== null) {
    basis.push(`(close-ma20)/atr14=${r4(closeVsMa20Atr)} vs threshold ${PRICE_EXTENSION_ATR_THRESHOLD}`);
  } else {
    basis.push('(close-ma20)/atr14 不可计算：缺少 close/MA20/ATR14');
  }

  return {
    basis: 'adjusted_close',
    close: r4(close),
    ma20: r4(ma20),
    ma60: r4(ma60),
    atr14: r4(atr14),
    rsi6: r4(finiteOrNull(input.x.rsi6[i])),
    rsi14: r4(finiteOrNull(input.x.rsi14[i])),
    close_vs_ma20_pct: r4(closeVsMa20Pct),
    close_vs_ma20_atr: r4(closeVsMa20Atr),
    close_vs_ma60_pct: r4(closeVsMa60Pct),
    ma20_above_ma60: ma20 !== null && ma60 !== null ? ma20 > ma60 : null,
    ma20_rising: i >= 5 && Number.isFinite(input.x.ma20[i]) && Number.isFinite(input.x.ma20[i - 5])
      ? input.x.ma20[i] > input.x.ma20[i - 5] : null,
    reference_price: r4(reference),
    reference_kind: input.referenceKind ?? null,
    reference_distance_pct: r4(refPct),
    reference_distance_atr: r4(refAtr),
    bars_since_confirmation: confirmedIdx !== null ? i - confirmedIdx : null,
    invalidation_level: r4(invalidation),
    invalidation_distance_pct: r4(invPct),
    invalidation_distance_atr: r4(invAtr),
    price_extension: extended,
    price_extension_basis: basis,
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

export interface PatternObservation {
  strategy_id: string;
  family: TechnicalFamily;
  stage: TechnicalStage;
  /** Family-specific stage label, e.g. PLATFORM_FORMING / BREAKOUT_CONFIRMED. */
  stage_detail: string;
  /**
   * Price-event date: the bar the pattern is ABOUT (the second divergence low,
   * the pullback touch, the breakout bar). May predate the day the event became
   * observable, and must never be used as an entry date.
   */
  pattern_event_date: string | null;
  /**
   * First bar at which the pattern is provable from data ≤ that bar. For a
   * right-side swing-low confirmation this is strictly after the event low.
   */
  first_observed_date: string;
  /** Set when the observation is FAILED (the first invalidation bar). */
  invalidated_at: string | null;
  /** Set when the observation is EXPIRED (the bar at which the window elapsed). */
  expires_at: string | null;
  formed_on: string | null;
  confirmed_on: string | null;
  last_evaluated_on: string;
  formation_basis: string[];
  confirmation_conditions: string[];
  invalidation_conditions: string[];
  invalidation: { on: string; reason: string } | null;
  key_levels: Record<string, number | null>;
  evidence: Record<string, number | string | boolean | null>;
  /** Facts that argue AGAINST the reading; never deleted when a stage passes. */
  counter_evidence: string[];
  /** Descriptive price-location facts (adjusted basis); never a score. */
  price_position: PricePosition;
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

// ---------------------------------------------------------------- research state

/**
 * One research state per stock per as-of day. This is a RESEARCH ranking, not
 * a trade instruction and not a position size. The six values are decided by
 * the deterministic order in `technicalResearchStateV2.ts`:
 *
 *   1. BLOCKED       — the day's trading/data facts forbid a same-day reading
 *                      (suspended, no bar, one-price limit-down, stale bar).
 *   2. INVALIDATED   — every signal episode is dead (failed or window elapsed).
 *   3. DETERIORATING — a live setup is contradicted by NEW negative evidence
 *                      dated after the latest live confirmation. The state is
 *                      the stock's, so a failure from any family counts. A
 *                      failure or expiry that predates the live confirmation
 *                      is history and never negates the live setup.
 *   4. EXTENDED      — the setup holds but price has run too fast: either the
 *                      five-day RAPID_RUNUP tag or `price_extension`
 *                      ((close - MA20) / ATR14 >= 3.0) on a live signal.
 *   5. FOCUS         — a live, research-ready confirmation with normal trading.
 *   6. WATCH         — forming only, or a live setup the account cannot execute
 *                      at normal prices (one-price limit-up / non-mainboard).
 */
export type ResearchState = 'FOCUS' | 'WATCH' | 'EXTENDED' | 'DETERIORATING' | 'BLOCKED' | 'INVALIDATED';

/** Display order: actionable research first, dead/blocked last. */
export const RESEARCH_STATE_ORDER: Record<ResearchState, number> = {
  FOCUS: 0, WATCH: 1, EXTENDED: 2, DETERIORATING: 3, INVALIDATED: 4, BLOCKED: 5,
};

export const RESEARCH_STATE_LABELS: Record<ResearchState, string> = {
  FOCUS: '重点关注',
  WATCH: '观察',
  EXTENDED: '已延伸',
  DETERIORATING: '恶化中',
  BLOCKED: '交易受限',
  INVALIDATED: '已失效',
};

/** One signal as the stock-level view exposes it — facts and dates only. */
export interface ResearchSignalView {
  strategy_id: string;
  family: TechnicalFamily;
  family_label: string;
  stage: TechnicalStage;
  stage_detail: string;
  pattern_event_date: string | null;
  first_observed_date: string;
  confirmed_on: string | null;
  invalidated_at: string | null;
  expires_at: string | null;
  confirmation_conditions: string[];
  invalidation_conditions: string[];
  key_levels: Record<string, number | null>;
  evidence: Record<string, number | string | boolean | null>;
  counter_evidence: string[];
  price_position: PricePosition;
}

export interface ResearchStockView {
  ts_code: string;
  name: string;
  as_of_trade_date: string;
  /** Last bar used; may precede the as-of day (see `bars_behind_as_of`). */
  trade_date: string;
  bars_behind_as_of: number;
  research_state: ResearchState;
  research_state_label: string;
  primary_family: TechnicalFamily | null;
  primary_pattern: string | null;
  /** Price position of the primary signal; descriptive, never a score. */
  price_position: PricePosition | null;
  signals: ResearchSignalView[];
  decisive_reasons: string[];
  conflicting_evidence: string[];
  counter_evidence: string[];
  watch_conditions: string[];
  trading_constraints: string[];
  trading_status: TradingStatus;
  price_volume_tags: PriceVolumeTag[];
  /** SW2021 L1 membership for readability/overlap only — never a gate. */
  sectors: string[];
  market_regime: Regime | 'UNKNOWN';
  rps120: number | null;
  research_ready: boolean;
  evidence_level: EvidenceLevel;
  trade_permission: 'EXECUTABLE' | 'RESEARCH_ONLY';
  trade_permission_reason: string;
}

export interface ResearchUniverseV2 {
  as_of: string;
  counts: Record<ResearchState, number> & { total: number };
  /** Every stock with at least one signal, in display order. */
  stocks: ResearchStockView[];
  /** 2–5 actionable research names; a highlight is not a buy recommendation. */
  daily_highlights: string[];
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
  /** One record per stock: the single aggregation every reader must use. */
  research_universe: ResearchUniverseV2;
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
