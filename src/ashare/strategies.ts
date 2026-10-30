import type { DatabaseSync } from 'node:sqlite';
import { forEachStockBars } from './bars.js';
import { computeIndicators, type Bars, type IndicatorSet } from './indicators.js';
import { detectSignals, SIGNAL_VERSION } from './signals.js';
import { percentileRank, RPS_VERSION } from './rps.js';
import {
  detectWBottom, detectRangeBreakout, detectPullbackResume, detectRpsHold, confirmedLocalLows,
  DEFAULT_MACD_W_OPTS, DEFAULT_RSI_W_OPTS, DEFAULT_RANGE_BREAKOUT_OPTS,
  DEFAULT_PULLBACK_OPTS, DEFAULT_RPS_HOLD_OPTS, PATTERN_VERSION,
} from './patterns.js';
import { recentTradeDays } from './ingest.js';
import {
  evaluateInvalidation, hasInsufficientData, maxAgeOf, signalAgeTradeDays, signalIdOf,
  SIGNAL_LIFECYCLE_VERSION,
} from './signalLifecycle.js';
import { assessCandidateEntry } from './entryAssessment.js';
import type {
  StrategyDef, SignalEvent, SignalDirection, RiskEpisode, FormingSignal, CandidateEntry,
} from './hotspotTypes.js';
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
  /** Risk overlay collapsed into episodes (goal-1030 WC-1). */
  risk_events: RiskEpisode[];
  /**
   * Raw per-bar firings. Kept so the legacy `priority` formula (which used
   * `risk_events.length`) stays byte-compatible for the constrained rollout;
   * it is not exposed on the wire.
   */
  risk_firings: Array<{ id: RiskId; on: string }>;
  /** Patterns forming but not confirmed — PREPARING evidence, never a signal. */
  forming: FormingSignal[];
  /** Entry-timing assessment (goal-1030 WP2); research state, not an order. */
  entry: CandidateEntry;
  bars: number;
}

interface ScanState {
  events: SignalEvent[];
}

interface OpenSignal {
  event: SignalEvent;
  confirmIdx: number;
  counters: Record<string, number>;
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
    trigger_conditions: strat.trigger_conditions,
    confirmation_conditions: strat.confirmation_conditions,
    invalidation_conditions: strat.invalidation_conditions,
    invalidation: null,
    status: 'active',
    risk_flags: [...strat.risk_flags],
    signal_id: signalIdOf(code, strat.strategy_id, dateAt(bars, i)),
    last_validated_on: dateAt(bars, i),
    invalidated_on: null,
    invalidation_reason: null,
    signal_age_trade_days: 0,
    conflicting_risks: [],
    max_age_trade_days: maxAgeOf(strat.strategy_id),
  };
}

/**
 * Scan ONE stock over its loaded window up to `endIdx` (inclusive).
 *
 * Lifecycle (goal-1030 WP1): each strategy keeps at most one OPEN signal. Every
 * later bar re-evaluates that signal's declared invalidation predicate and its
 * frozen observation window. An invalidated/expired strategy may confirm again
 * and the new event carries a new `signal_id`; an old identity never revives.
 * Risk overlay firings are collapsed into episodes. `forming` lists patterns
 * that are still unconfirmed so entry assessment can show PREPARING names.
 */
export function detectStrategyEvents(
  code: string, b: Bars, x: IndicatorSet, rpsByDate: Map<string, number | null>, endIdx: number,
): StockStrategyScan {
  const state: ScanState = { events: [] };
  const open = new Map<string, OpenSignal>();
  const risk: RiskEpisode[] = [];
  const riskFirings: Array<{ id: RiskId; on: string }> = [];
  const riskSeen = new Set<string>();
  const lastRiskIdx = new Map<RiskId, number>();
  // Per-bar RPS120 aligned to this stock's date axis (never an end-date
  // snapshot reused for earlier bars).
  const rpsArr: Array<number | null> = b.dates.map(d => rpsByDate.get(d) ?? null);
  const asOf = dateAt(b, endIdx);

  const first = (strat: HotspotStrategy, i: number, formed: number | null, evidence: SignalEvent['evidence']): void => {
    if (open.has(strat.strategy_id)) return; // still valid ⇒ no duplicate identity
    const event = baseEvent(code, strat, b, i, formed, evidence);
    state.events.push(event);
    open.set(strat.strategy_id, { event, confirmIdx: i, counters: {} });
  };

  for (let i = 0; i <= endIdx; i++) {
    // ---- 1. validate open signals (data ≤ i only; confirmation bar excluded)
    for (const [sid, signal] of [...open]) {
      if (i <= signal.confirmIdx) continue;
      const verdict = evaluateInvalidation({
        strategyId: sid, event: signal.event, bars: b, x, i, rps: rpsArr[i] ?? null,
        counters: signal.counters,
      });
      if (verdict) {
        signal.event.status = 'invalidated';
        signal.event.invalidated_on = verdict.on;
        signal.event.invalidation_reason = verdict.code;
        signal.event.invalidation = { on: verdict.on, reason: verdict.detail };
        signal.event.last_validated_on = dateAt(b, i);
        open.delete(sid);
        continue;
      }
      const maxAge = maxAgeOf(sid);
      if (maxAge !== null && signalAgeTradeDays(signal.confirmIdx, i) > maxAge) {
        signal.event.status = 'expired';
        signal.event.expired_on = dateAt(b, i);
        signal.event.invalidation_reason = 'max_age_exceeded';
        signal.event.last_validated_on = dateAt(b, i);
        open.delete(sid);
      }
    }

    if (i >= 61) {
      const ids = detectSignals(b, x, i);
      for (const id of ids) {
        if (id === 'trend_breakdown' || id === 'macd_bear_divergence' || id === 'overheated') {
          const key = `${id}@${i}`;
          if (!riskSeen.has(key)) {
            riskSeen.add(key);
            riskFirings.push({ id: id as RiskId, on: dateAt(b, i) });
            const prev = risk[risk.length - 1];
            if (prev && prev.id === id && lastRiskIdx.get(id as RiskId) === i - 1) {
              prev.last_on = dateAt(b, i);
              prev.bars += 1;
            } else {
              risk.push({ id: id as RiskId, on: dateAt(b, i), last_on: dateAt(b, i), bars: 1 });
            }
            lastRiskIdx.set(id as RiskId, i);
          }
          continue;
        }
        const strat = HOTSPOT_STRATEGIES.find(s => s.existingSignalId === id);
        if (strat) first(strat, i, null, existingSignalEvidence(id, b, x, i));
      }
    }

    // new detectors
    if (!open.has('tc_pullback_resume')) {
      const p = detectPullbackResume(b.close, b.low, x.ma20, x.ma60, i, DEFAULT_PULLBACK_OPTS);
      if (p) first(STRATEGY_BY_ID.get('tc_pullback_resume')!, i, p.touchIndex, {
        touch_index: dateAt(b, p.touchIndex), ma20: round4(p.ma20),
      });
    }

    if (!open.has('bo_range')) {
      const r = detectRangeBreakout(b.high, b.low, b.close, b.vol, x.volMa20, i, DEFAULT_RANGE_BREAKOUT_OPTS);
      if (r) first(STRATEGY_BY_ID.get('bo_range')!, i, null, {
        prior_high: round4(r.priorHigh), prior_low: round4(r.priorLow), vol_ratio: round2(r.volRatio),
      });
    }

    if (!open.has('tc_rps_hold')) {
      const h = detectRpsHold(b.close, x.ma20, rpsArr, i, DEFAULT_RPS_HOLD_OPTS);
      if (h) first(STRATEGY_BY_ID.get('tc_rps_hold')!, i, null, {
        rps120: round2(h.rps), rps_version: RPS_VERSION,
      });
    }

    // W-bottom: evaluate DIF and RSI14; DIF takes precedence when both fire same bar.
    if (!open.has('rv_macd_w_bottom')) {
      const wDif = detectWBottom(x.dif, i, DEFAULT_MACD_W_OPTS);
      const wRsi = !wDif ? detectWBottom(x.rsi14, i, DEFAULT_RSI_W_OPTS) : null;
      const w = wDif ?? wRsi;
      if (w && i === w.confirmIndex) {
        first(STRATEGY_BY_ID.get('rv_macd_w_bottom')!, i, w.j2, {
          series: wDif ? 'dif' : 'rsi14',
          first_low: round4(w.firstLow), second_low: round4(w.secondLow),
          neckline: round4(w.neckline), j1_date: dateAt(b, w.j1), j2_date: dateAt(b, w.j2),
          pattern_version: PATTERN_VERSION,
        });
      }
    }
  }

  // ---- finalize lifecycle fields at the as-of bar
  for (const ev of state.events) {
    const confirmIdx = b.dates.indexOf(ev.confirmed_on);
    ev.source_data_as_of = asOf;
    ev.signal_id = signalIdOf(code, ev.strategy_id, ev.confirmed_on);
    if (ev.status === 'active') {
      if (hasInsufficientData(ev.strategy_id, x, endIdx)) ev.status = 'insufficient_data';
      else if (ev.confirmed_on === asOf) ev.status = 'confirmed';
    }
    // A terminal signal's `last_validated_on` is the bar it was closed on, not
    // the as-of bar: that date must stay meaningful for the audit trail.
    const stillOpen = ev.status === 'active' || ev.status === 'confirmed' || ev.status === 'insufficient_data';
    if (stillOpen) ev.last_validated_on = asOf;
    const lastIdx = stillOpen ? endIdx : b.dates.indexOf(ev.last_validated_on ?? asOf);
    ev.signal_age_trade_days = confirmIdx >= 0 && lastIdx >= confirmIdx ? lastIdx - confirmIdx : 0;
    // Risks overlapping the post-confirmation window, not only those starting after it.
    ev.conflicting_risks = risk
      .filter(r => r.last_on >= ev.confirmed_on && !(r.on === ev.confirmed_on && r.last_on === ev.confirmed_on))
      .map(r => `${r.id}@${r.on}`);
  }

  const forming = detectForming(b, x, endIdx).filter(f => !open.has(f.strategy_id));
  const scan: StockStrategyScan = {
    ts_code: code,
    events: state.events,
    risk_events: risk,
    risk_firings: riskFirings,
    forming,
    entry: {
      entry_stage: null, entry_eligibility: false, entry_score: null,
      rejection_reasons: [], entry_assessments: [], analysis_version: 'pending',
    },
    bars: b.dates.length,
  };
  scan.entry = assessCandidateEntry({ ts_code: code, scan, bars: b, x, asOf, asOfIndex: endIdx });
  return scan;
}

/**
 * Evidence carried by the six frozen `detectSignals` ids. The extra fields are
 * exactly what their lifecycle predicates need later (breakout level, the price
 * low behind a divergence, the oversold RSI trough); they are read from bars
 * ≤ i at confirmation time, never backfilled.
 */
function existingSignalEvidence(
  id: string, b: Bars, x: IndicatorSet, i: number,
): SignalEvent['evidence'] {
  const base = { source_signal: id, signal_version: SIGNAL_VERSION };
  switch (id) {
    case 'breakout_20d':
      return { ...base, breakout_level: round4(x.high20[i - 1]) };
    case 'macd_bull_divergence': {
      let low = Infinity;
      for (let k = Math.max(0, i - 9); k <= i; k++) low = Math.min(low, b.low[k]);
      return { ...base, divergence_low: round4(low) };
    }
    case 'rsi_oversold_rebound': {
      let trough = Infinity;
      for (let k = Math.max(0, i - 10); k <= i; k++) trough = Math.min(trough, x.rsi14[k]);
      return { ...base, rsi_trough: round4(trough) };
    }
    default:
      return base;
  }
}

/** Unconfirmed patterns at the as-of bar — PREPARING evidence for WP2. */
function detectForming(b: Bars, x: IndicatorSet, i: number): FormingSignal[] {
  if (i < 61) return [];
  const out: FormingSignal[] = [];
  const close = b.close[i];
  const fresh = (strategyId: string, sinceIdx: number): boolean => {
    const maxAge = maxAgeOf(strategyId) ?? 20;
    return i - sinceIdx <= maxAge;
  };

  // W-bottom: two confirmed DIF lows passed the pair tests, neckline not crossed.
  const lows = confirmedLocalLows(x.dif, i, DEFAULT_MACD_W_OPTS, i - DEFAULT_MACD_W_OPTS.lookback - DEFAULT_MACD_W_OPTS.L);
  outer:
  for (let n = 0; n < lows.length - 1; n++) {
    const j2 = lows[n].index;
    for (let m = n + 1; m < lows.length; m++) {
      const j1 = lows[m].index;
      const gap = j2 - j1;
      if (gap < DEFAULT_MACD_W_OPTS.minGap) continue;
      if (gap > DEFAULT_MACD_W_OPTS.maxGap) break;
      const v1 = x.dif[j1], v2 = x.dif[j2];
      if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;
      if (v1 > DEFAULT_MACD_W_OPTS.lowCeiling || v2 > DEFAULT_MACD_W_OPTS.lowCeiling) continue;
      const scale = Math.max(Math.abs(v1), Math.abs(v2));
      if (!(Math.abs(v2 - v1) <= DEFAULT_MACD_W_OPTS.relTol * scale)) continue;
      let neckline = -Infinity;
      for (let k = j1 + 1; k < j2; k++) neckline = Math.max(neckline, x.dif[k]);
      if (!(neckline > v1 && neckline > v2)) continue;
      if (close <= 0) continue;
      if (x.dif[i] <= neckline && fresh('rv_macd_w_bottom', j2)) {
        out.push({
          strategy_id: 'rv_macd_w_bottom', family: 'REVERSAL', since: dateAt(b, j2),
          evidence: { first_low: round4(v1), second_low: round4(v2), neckline: round4(neckline), needs: 'DIF close above neckline' },
        });
      }
      break outer;
    }
  }

  // Squeeze: width in the bottom 20% of 120 bars, no upper-band cross yet.
  if (i >= 125) {
    const window = x.bollWidth.slice(i - 120, i).filter(Number.isFinite).sort((a, c) => a - c);
    const level = window[Math.floor(window.length * 0.2)];
    const squeezedIdx = [1, 2, 3, 4, 5].filter(k => x.bollWidth[i - k] <= level).map(k => i - k).sort((a, c) => a - c)[0];
    if (window.length >= 100 && Number.isFinite(level) && squeezedIdx !== undefined
      && Number.isFinite(x.bollUp[i]) && close <= x.bollUp[i] && fresh('bo_squeeze', squeezedIdx)) {
      out.push({
        strategy_id: 'bo_squeeze', family: 'BREAKOUT', since: dateAt(b, squeezedIdx),
        evidence: { boll_width: round4(x.bollWidth[i]), squeeze_level: round4(level), needs: 'close above upper band' },
      });
    }
  }

  // Pullback: healthy uptrend, recent MA20 touch, not yet resumed.
  if (i >= 5 && Number.isFinite(x.ma20[i]) && Number.isFinite(x.ma60[i]) && Number.isFinite(x.ma20[i - 5])
    && close > x.ma20[i] && x.ma20[i] > x.ma60[i] && x.ma20[i] > x.ma20[i - 5]) {
    let touched: number | null = null;
    for (let k = 1; k <= 5; k++) {
      if (Number.isFinite(x.ma20[i - k]) && b.low[i - k] <= x.ma20[i - k] * 1.01) { touched = i - k; break; }
    }
    const resumed = b.close[i] > b.open[i] && close > x.ma20[i];
    if (touched !== null && !resumed && fresh('tc_pullback_resume', touched)) {
      out.push({
        strategy_id: 'tc_pullback_resume', family: 'TREND_CONTINUATION', since: dateAt(b, touched),
        evidence: { touch_index: dateAt(b, touched), ma20: round4(x.ma20[i]), needs: 'up close above MA20' },
      });
    }
  }

  // Range: pressing the 60-day prior high without a volume-qualified break.
  if (i >= 61) {
    let priorHigh = -Infinity;
    for (let k = i - 60; k < i; k++) priorHigh = Math.max(priorHigh, b.high[k]);
    if (Number.isFinite(priorHigh) && close > priorHigh * 0.97 && close <= priorHigh) {
      out.push({
        strategy_id: 'bo_range', family: 'BREAKOUT', since: dateAt(b, i),
        evidence: { prior_high: round4(priorHigh), distance: round4(priorHigh / close - 1), needs: 'close above prior high on volume' },
      });
    }
  }

  return out;
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
