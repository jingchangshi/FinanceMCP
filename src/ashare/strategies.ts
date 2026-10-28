import type { DatabaseSync } from 'node:sqlite';
import { forEachStockBars } from './bars.js';
import { computeIndicators, type Bars, type IndicatorSet } from './indicators.js';
import { detectSignals, SIGNAL_VERSION } from './signals.js';
import { percentileRank, RPS_VERSION } from './rps.js';
import {
  detectWBottom, detectRangeBreakout, detectPullbackResume, detectRpsHold,
  DEFAULT_MACD_W_OPTS, DEFAULT_RSI_W_OPTS, DEFAULT_RANGE_BREAKOUT_OPTS,
  DEFAULT_PULLBACK_OPTS, DEFAULT_RPS_HOLD_OPTS, PATTERN_VERSION,
} from './patterns.js';
import { recentTradeDays } from './ingest.js';
import type { StrategyDef, SignalEvent, SignalDirection } from './hotspotTypes.js';
import { HOTSPOT_STRATEGY_SET_VERSION } from './hotspotTypes.js';

/**
 * Unified multi-strategy signal engine (goal-1028 §P3). Nine pre-registered
 * strategies across three families. Six reuse the frozen `detectSignals`
 * ids with zero re-implementation; three are new pattern detectors from
 * patterns.ts. All events carry `confirmed_on` = the first bar at which the
 * rule is provable from data ≤ that bar — never the formation bar.
 *
 * Bearish/risk overlay signals (trend_breakdown, macd_bear_divergence,
 * overheated) are collected per stock as `risk_events` so pool ranking can
 * penalize conflicted names; they are not part of the nine and never count
 * as entry candidates.
 */

export const SCAN_BAR_COUNT = 330; // ≥250 for RPS250 + MA120 + W-bottom lookback

type ExistingId = 'trend_up' | 'breakout_20d' | 'boll_squeeze_breakout' | 'macd_bull_divergence' | 'rsi_oversold_rebound';
export type RiskId = 'trend_breakdown' | 'macd_bear_divergence' | 'overheated';

export interface HotspotStrategy extends StrategyDef {
  direction: Extract<SignalDirection, 'bullish'>;
  /** Frozen signals.ts id this strategy delegates to, when applicable. */
  existingSignalId?: ExistingId;
}

const S = (d: HotspotStrategy): HotspotStrategy => d;

export const HOTSPOT_STRATEGIES: readonly HotspotStrategy[] = [
  // ---------------------------------------------------------- TREND_CONTINUATION
  S({
    strategy_id: 'tc_ma_trend', strategy_version: '1.0.0', family: 'TREND_CONTINUATION',
    direction: 'bullish', existingSignalId: 'trend_up',
    required_indicators: ['ma20', 'ma60'], minimum_history: 66,
    market_regime: 'uptrend',
    trigger_conditions: 'close>MA20>MA60 and MA20 rising vs 5 bars ago (detectSignals trend_up, first-cross)',
    confirmation_conditions: 'same-bar; rule false on prior bar',
    invalidation_conditions: 'detectSignals trend_breakdown on any later bar (close<MA60 with volume)',
    risk_flags: ['trend_end_lag'],
  }),
  S({
    strategy_id: 'tc_pullback_resume', strategy_version: '1.0.0', family: 'TREND_CONTINUATION',
    direction: 'bullish',
    required_indicators: ['ma20', 'ma60'], minimum_history: 66,
    market_regime: 'uptrend',
    trigger_conditions: 'close>MA20>MA60; low touched MA20(≤+1%) within last 5 bars (not today); today closes above MA20 and up on the day',
    confirmation_conditions: 'first resume bar of the episode (yesterday not already a resume day)',
    invalidation_conditions: 'close < MA60',
    risk_flags: ['whipsaw_touch'],
  }),
  S({
    strategy_id: 'tc_rps_hold', strategy_version: '1.0.0', family: 'TREND_CONTINUATION',
    direction: 'bullish',
    required_indicators: ['ma20', 'rps120'], minimum_history: 130,
    market_regime: 'uptrend',
    trigger_conditions: 'RPS120 ≥ 80 (full-market cross-section), close>MA20, MA20 higher than 5 bars ago; first-cross of the compound condition',
    confirmation_conditions: 'same-bar; condition false on prior bar',
    invalidation_conditions: 'RPS120 < 80 or close < MA20 or MA20 non-rising for 5 bars',
    risk_flags: ['crowded_leader', 'regime_sensitive'],
  }),
  // ---------------------------------------------------------- BREAKOUT
  S({
    strategy_id: 'bo_volume_20d', strategy_version: '1.0.0', family: 'BREAKOUT',
    direction: 'bullish', existingSignalId: 'breakout_20d',
    required_indicators: ['high20', 'volMa20'], minimum_history: 66,
    market_regime: 'ANY',
    trigger_conditions: 'close > prior-20d high (high20 shifted) and vol ≥ 1.5× volMa20 (detectSignals breakout_20d)',
    confirmation_conditions: 'same-bar; rule false on prior bar',
    invalidation_conditions: 'close back below the 20-day high for 3 consecutive closes',
    risk_flags: ['false_breakout'],
  }),
  S({
    strategy_id: 'bo_range', strategy_version: '1.0.0', family: 'BREAKOUT',
    direction: 'bullish',
    required_indicators: ['high', 'low', 'volMa20'], minimum_history: 82,
    market_regime: 'range',
    trigger_conditions: 'close > max(high[−60,−1]) with vol ≥ 1.2× volMa20; today excluded from the range window; first-cross only',
    confirmation_conditions: 'same-bar',
    invalidation_conditions: 'close back below the 60-day prior high',
    risk_flags: ['false_breakout'],
  }),
  S({
    strategy_id: 'bo_squeeze', strategy_version: '1.0.0', family: 'BREAKOUT',
    direction: 'bullish', existingSignalId: 'boll_squeeze_breakout',
    required_indicators: ['bollUp', 'bollWidth'], minimum_history: 186,
    market_regime: 'range',
    trigger_conditions: 'bollinger width in bottom 20% of last 120 bars within prior 5 bars, close crosses above bollUp (detectSignals boll_squeeze_breakout)',
    confirmation_conditions: 'same-bar cross',
    invalidation_conditions: 'close < bollMid',
    risk_flags: ['squeeze_failure'],
  }),
  // ---------------------------------------------------------- REVERSAL
  S({
    strategy_id: 'rv_macd_w_bottom', strategy_version: '1.0.0', family: 'REVERSAL',
    direction: 'bullish',
    required_indicators: ['dif'], minimum_history: 190,
    market_regime: 'downtrend',
    trigger_conditions: 'two confirmed DIF local lows (L=5,K=5, gap 10–60 bars, relative proximity ≤0.35) then first DIF close above the intermediate neckline',
    confirmation_conditions: 'neckline-cross bar (≥5 bars after second low) is the signal date',
    invalidation_conditions: 'DIF < min(first low, second low) after confirmation',
    risk_flags: ['confirmation_lag', 'counter_trend'],
  }),
  S({
    strategy_id: 'rv_macd_divergence', strategy_version: '1.0.0', family: 'REVERSAL',
    direction: 'bullish', existingSignalId: 'macd_bull_divergence',
    required_indicators: ['dif', 'ma5'], minimum_history: 66,
    market_regime: 'downtrend',
    trigger_conditions: 'price makes a lower low (recent 10-bar low < low 20–60 bars ago) while DIF makes a higher low; close > open and > MA5 (detectSignals macd_bull_divergence)',
    confirmation_conditions: 'same-bar',
    invalidation_conditions: 'close < the recent price low that formed the divergence',
    risk_flags: ['counter_trend', 'repeat_fire'],
  }),
  S({
    strategy_id: 'rv_rsi_oversold', strategy_version: '1.0.0', family: 'REVERSAL',
    direction: 'bullish', existingSignalId: 'rsi_oversold_rebound',
    required_indicators: ['rsi14'], minimum_history: 66,
    market_regime: 'downtrend',
    trigger_conditions: 'RSI14 crosses up through 30 from below (detectSignals rsi_oversold_rebound)',
    confirmation_conditions: 'same-bar cross',
    invalidation_conditions: 'RSI14 makes a new low below the oversold trough',
    risk_flags: ['counter_trend', 'whipsaw'],
  }),
] as const;

export const STRATEGY_BY_ID: ReadonlyMap<string, HotspotStrategy> =
  new Map(HOTSPOT_STRATEGIES.map(s => [s.strategy_id, s]));

export const RISK_OVERLAY_IDS: readonly RiskId[] =
  ['trend_breakdown', 'macd_bear_divergence', 'overheated'] as const;

// ---------------------------------------------------------------- per-stock scan

export interface StockStrategyScan {
  ts_code: string;
  events: SignalEvent[];
  risk_events: Array<{ id: RiskId; on: string }>;
  bars: number;
}

interface ScanState {
  emitted: Set<string>; // strategy_id
  events: SignalEvent[];
}

function dateAt(bars: Bars, i: number): string { return bars.dates[i]; }

function baseEvent(
  code: string, strat: HotspotStrategy, bars: Bars, i: number,
  formed: number | null, evidence: SignalEvent['evidence'],
): SignalEvent {
  return {
    ts_code: code,
    strategy_id: strat.strategy_id,
    strategy_version: strat.strategy_version,
    family: strat.family,
    direction: 'bullish',
    confirmed_on: dateAt(bars, i),
    formed_on: formed !== null ? dateAt(bars, formed) : null,
    confirmation_lag: formed !== null ? i - formed : 0,
    evidence,
    invalidation_conditions: strat.invalidation_conditions,
    invalidation: null,
    status: 'active',
    risk_flags: [...strat.risk_flags],
  };
}

/**
 * Scan ONE stock over its full loaded window up to `endIdx` (inclusive).
 * Each strategy emits at most once (first confirmation within the window).
 * W-bottom is re-evaluated every bar so a later invalidation is captured;
 * the other new detectors are first-cross by construction.
 */
export function detectStrategyEvents(
  code: string, b: Bars, x: IndicatorSet, rpsByDate: Map<string, number | null>, endIdx: number,
): StockStrategyScan {
  const state: ScanState = { emitted: new Set(), events: [] };
  const risk: Array<{ id: RiskId; on: string }> = [];
  const riskSeen = new Set<string>();
  // Per-bar RPS120 aligned to this stock's date axis (never an end-date
  // snapshot reused for earlier bars).
  const rpsArr: Array<number | null> = b.dates.map(d => rpsByDate.get(d) ?? null);

  // W-bottom bookkeeping: emitted event + matched pattern for invalidation.
  let wEvent: SignalEvent | null = null;
  let wPattern: { j1: number; j2: number } | null = null;

  const first = (strat: HotspotStrategy, i: number, formed: number | null, evidence: SignalEvent['evidence']): void => {
    if (state.emitted.has(strat.strategy_id)) return;
    state.emitted.add(strat.strategy_id);
    state.events.push(baseEvent(code, strat, b, i, formed, evidence));
  };

  for (let i = 0; i <= endIdx; i++) {
    if (i >= 61) {
      const ids = detectSignals(b, x, i);
      for (const id of ids) {
        if (id === 'trend_breakdown' || id === 'macd_bear_divergence' || id === 'overheated') {
          const key = `${id}@${i}`;
          if (!riskSeen.has(key)) { riskSeen.add(key); risk.push({ id: id as RiskId, on: dateAt(b, i) }); }
          continue;
        }
        const strat = HOTSPOT_STRATEGIES.find(s => s.existingSignalId === id);
        if (strat) first(strat, i, null, { source_signal: id, signal_version: SIGNAL_VERSION });
      }
    }

    // new detectors
    if (!state.emitted.has('tc_pullback_resume')) {
      const p = detectPullbackResume(b.close, b.low, x.ma20, x.ma60, i, DEFAULT_PULLBACK_OPTS);
      if (p) first(STRATEGY_BY_ID.get('tc_pullback_resume')!, i, p.touchIndex, {
        touch_index: dateAt(b, p.touchIndex), ma20: round4(p.ma20),
      });
    }

    if (!state.emitted.has('bo_range')) {
      const r = detectRangeBreakout(b.high, b.low, b.close, b.vol, x.volMa20, i, DEFAULT_RANGE_BREAKOUT_OPTS);
      if (r) first(STRATEGY_BY_ID.get('bo_range')!, i, null, {
        prior_high: round4(r.priorHigh), prior_low: round4(r.priorLow), vol_ratio: round2(r.volRatio),
      });
    }

    if (!state.emitted.has('tc_rps_hold')) {
      const h = detectRpsHold(b.close, x.ma20, rpsArr, i, DEFAULT_RPS_HOLD_OPTS);
      if (h) first(STRATEGY_BY_ID.get('tc_rps_hold')!, i, null, {
        rps120: round2(h.rps), rps_version: RPS_VERSION,
      });
    }

    // W-bottom: evaluate DIF and RSI14; DIF takes precedence when both fire same bar.
    const wDif = detectWBottom(x.dif, i, DEFAULT_MACD_W_OPTS);
    const wRsi = !wDif && !state.emitted.has('rv_macd_w_bottom')
      ? detectWBottom(x.rsi14, i, DEFAULT_RSI_W_OPTS) : null;
    const w = wDif ?? wRsi;
    if (w && !state.emitted.has('rv_macd_w_bottom') && i === w.confirmIndex) {
      const strat = STRATEGY_BY_ID.get('rv_macd_w_bottom')!;
      first(strat, i, w.j2, {
        series: wDif ? 'dif' : 'rsi14',
        first_low: round4(w.firstLow), second_low: round4(w.secondLow),
        neckline: round4(w.neckline), j1_date: dateAt(b, w.j1), j2_date: dateAt(b, w.j2),
        pattern_version: PATTERN_VERSION,
      });
      wEvent = state.events[state.events.length - 1];
      wPattern = { j1: w.j1, j2: w.j2 };
    } else if (w && wPattern && w.j1 === wPattern.j1 && w.j2 === wPattern.j2
      && w.invalidateIndex !== null && w.invalidateIndex === i && wEvent && wEvent.status === 'active') {
      wEvent.status = 'invalidated';
      wEvent.invalidation = { on: dateAt(b, i), reason: `series fell below ${round4(w.invalidateBelow)} (both lows)` };
    }
  }

  return { ts_code: code, events: state.events, risk_events: risk, bars: b.dates.length };
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const round2 = (v: number): number => Math.round(v * 1e2) / 1e2;

// ---------------------------------------------------------------- pool scan

export interface PoolStrategyScan {
  as_of: string;
  versions: {
    strategy_set: string; patterns: string; signals: string; rps: string;
  };
  results: StockStrategyScan[];
  coverage: {
    requested: number;
    scanned: number;
    skipped_adj_missing: number;
    skipped_insufficient: number;
  };
}

/**
 * Calendar-aligned per-bar RPS120 history for the full market over the scan
 * window. Returns, for each scan date, the cross-sectional percentile of each
 * stock's trailing 120-bar return ending at that date — so a strategy scan
 * can read RPS at bar i without ever seeing the future. Stocks whose qfq
 * adjustment is incomplete are excluded from the cross-section entirely.
 *
 * Alignment: the base (120 trade days earlier) is taken on the GLOBAL trade
 * calendar; a suspended stock contributes its last close ≤ each date.
 */
export interface RpsSeries {
  dates: string[];
  byCode: Map<string, Array<number | null>>; // aligned to `dates`
  universe: number;
  version: string;
}

export function computeRps120Series(db: DatabaseSync, asOf: string, barCount = SCAN_BAR_COUNT): RpsSeries {
  const RPS_WINDOW = 120;
  const allDays = recentTradeDays(db, asOf, barCount + RPS_WINDOW + 10);
  if (allDays.length <= RPS_WINDOW) throw new Error(`calendar too short for RPS history at ${asOf}`);
  const dates = allDays.slice(-(barCount + RPS_WINDOW)).slice(RPS_WINDOW); // scan window (ascending)
  const baseOffset = allDays.length - barCount - RPS_WINDOW; // index of allDays[0] relative to scan start

  // Collect closes per stock over the FULL loaded span (scan + RPS lookback).
  const stockDates = new Map<string, string[]>();
  const stockCloses = new Map<string, number[]>();
  forEachStockBars(db, allDays[0], asOf, (ts, b) => {
    if (b.adjMissing && b.adjMissing > 0) return;
    stockDates.set(ts, b.dates);
    stockCloses.set(ts, b.close);
  });

  const byCode = new Map<string, Array<number | null>>();
  const rets = new Array<number | null>(stockDates.size).fill(null);
  const codes = [...stockDates.keys()];
  const ptrs1 = new Int32Array(codes.length); // pointer for the scan-date close
  const ptrs2 = new Int32Array(codes.length); // pointer for the base-date close

  for (let t = 0; t < dates.length; t++) {
    const scanDay = allDays[baseOffset + RPS_WINDOW + t];
    const baseDay = allDays[baseOffset + t];
    let n = 0;
    for (let s = 0; s < codes.length; s++) {
      const dts = stockDates.get(codes[s])!;
      const cls = stockCloses.get(codes[s])!;
      while (ptrs1[s] < dts.length && dts[ptrs1[s]] <= scanDay) ptrs1[s]++;
      while (ptrs2[s] < dts.length && dts[ptrs2[s]] <= baseDay) ptrs2[s]++;
      const c1 = ptrs1[s] > 0 ? cls[ptrs1[s] - 1] : NaN;
      const c0 = ptrs2[s] > 0 ? cls[ptrs2[s] - 1] : NaN;
      if (Number.isFinite(c1) && Number.isFinite(c0) && c0 > 0) {
        rets[s] = c1 / c0 - 1;
        n++;
      } else {
        rets[s] = null;
      }
    }
    const values: number[] = [];
    const idxOf: number[] = [];
    for (let s = 0; s < codes.length; s++) {
      if (rets[s] !== null) { values.push(rets[s]!); idxOf.push(s); }
    }
    const pct = percentileRank(values);
    for (let k = 0; k < idxOf.length; k++) {
      const s = idxOf[k];
      let arr = byCode.get(codes[s]);
      if (!arr) { arr = new Array(dates.length).fill(null); byCode.set(codes[s], arr); }
      arr[t] = pct[k] * 100;
    }
  }

  return { dates, byCode, universe: codes.length, version: RPS_VERSION };
}

/**
 * Scan a pool of codes for all nine strategies + risk overlay.
 * RPS is computed cross-sectionally over the FULL market (a pool-only
 * cross-section would rank pool members against each other, which is not the
 * RPS hypothesis), per bar; pool stocks with incomplete qfq adjustment are
 * skipped honestly (goal §P3.4). Each stock's bars are loaded one window
 * longer than the scan so indicators are warm at the window start.
 */
export function scanPoolStrategies(
  db: DatabaseSync, codes: string[], asOf: string, barCount = SCAN_BAR_COUNT,
): PoolStrategyScan {
  const rpsSeries = computeRps120Series(db, asOf, barCount);
  const start = rpsSeries.dates[0];
  const end = rpsSeries.dates[rpsSeries.dates.length - 1];

  const results: StockStrategyScan[] = [];
  let adjSkip = 0;
  let shortSkip = 0;
  forEachStockBars(db, start, end, (ts, b) => {
    if (b.adjMissing && b.adjMissing > 0) { adjSkip++; return; }
    if (b.dates.length < 130) { shortSkip++; return; } // below any strategy's minimum_history floor
    const x = computeIndicators(b);
    const rpsByDate = new Map<string, number | null>();
    const series = rpsSeries.byCode.get(ts);
    if (series) {
      for (let k = 0; k < rpsSeries.dates.length; k++) rpsByDate.set(rpsSeries.dates[k], series[k]);
    }
    results.push(detectStrategyEvents(ts, b, x, rpsByDate, b.dates.length - 1));
  }, codes);

  return {
    as_of: end,
    versions: {
      strategy_set: HOTSPOT_STRATEGY_SET_VERSION,
      patterns: PATTERN_VERSION,
      signals: SIGNAL_VERSION,
      rps: RPS_VERSION,
    },
    results,
    coverage: {
      requested: codes.length,
      scanned: results.length,
      skipped_adj_missing: adjSkip,
      skipped_insufficient: shortSkip,
    },
  };
}
