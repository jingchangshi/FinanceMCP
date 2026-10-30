/**
 * Signal lifecycle (goal-1030 WP1).
 *
 * The 2026-10-29 audit found that a strategy emitted at most one event per
 * 330-bar scan window, carried `status:'active'` forever, and never had its
 * own declared invalidation condition evaluated (only the W-bottom had that
 * bookkeeping). This module makes the declared contract executable:
 *
 *   confirmed ──► active ──► invalidated | expired
 *      │             │
 *      └─────────────┴──► confirmed (a *new* signal_id after re-confirmation)
 *
 * Rules (all deterministic, only data ≤ bar i is read):
 *   1. Each strategy has ONE open signal at a time. Once it is invalidated or
 *      expires, the strategy may confirm again — the new event gets a new
 *      `signal_id` because its `confirmed_on` differs. An invalid event never
 *      returns to active under its old identity.
 *   2. A signal's own `invalidation_conditions` text is evaluated every bar by
 *      `evaluateInvalidation`. `trend_breakdown` is a HARD invalidation only
 *      for the strategy that names it (`tc_ma_trend`); for reversal strategies
 *      a bearish divergence is a soft risk, not an automatic invalidation.
 *   3. Every strategy has a frozen observation window
 *      (`SIGNAL_MAX_AGE_TRADE_DAYS`). Past it the signal is EXPIRED: it stays
 *      in the audit trail but stops counting as current entry evidence.
 *   4. Missing required inputs at validation time yield INSUFFICIENT_DATA
 *      rather than a silent "active".
 */
import type { Bars, IndicatorSet } from './indicators.js';
import { detectSignals } from './signals.js';
import type { SignalEvent } from './hotspotTypes.js';

export const SIGNAL_LIFECYCLE_VERSION = 'lifecycle-1.0.0';

/**
 * Frozen observation window per strategy, in trade days after confirmation
 * (inclusive). Parameters are research parameters fixed before any outcome on
 * 2026-10-29 was known; they may only change through a new lifecycle version
 * and an out-of-sample re-validation (goal WP4), never by tuning to a day.
 */
export const SIGNAL_MAX_AGE_TRADE_DAYS: Readonly<Record<string, number>> = {
  tc_ma_trend: 20,
  tc_pullback_resume: 10,
  tc_rps_hold: 20,
  bo_volume_20d: 20,
  bo_range: 20,
  bo_squeeze: 20,
  rv_macd_w_bottom: 40,
  rv_macd_divergence: 40,
  rv_rsi_oversold: 30,
};

/** Indicators that must be finite at validation time, else INSUFFICIENT_DATA. */
export const SIGNAL_REQUIRED_INDICATORS: Readonly<Record<string, (keyof IndicatorSet)[]>> = {
  tc_ma_trend: ['ma60'],
  tc_pullback_resume: ['ma60'],
  tc_rps_hold: ['ma20'],
  bo_volume_20d: ['high20', 'volMa20'],
  bo_range: [],
  bo_squeeze: ['bollMid'],
  rv_macd_w_bottom: ['dif'],
  rv_macd_divergence: ['dif', 'ma5'],
  rv_rsi_oversold: ['rsi14'],
};

export type SignalState =
  | 'confirmed'   // confirmed on the as-of bar itself
  | 'active'      // confirmed earlier, contract still intact
  | 'invalidated' // a hard invalidation predicate fired
  | 'expired'     // observation window elapsed
  | 'insufficient_data';

export interface InvalidationVerdict {
  on: string;
  /** Machine-readable rule id — also used as `invalidation_reason`. */
  code: string;
  /** Human-readable detail kept in `invalidation.reason` for old clients. */
  detail: string;
}

export interface EvaluationInput {
  strategyId: string;
  event: SignalEvent;
  bars: Bars;
  x: IndicatorSet;
  i: number;
  rps: number | null;
  /** Mutable counters owned by the open signal (e.g. consecutive closes). */
  counters: Record<string, number>;
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function evidenceNumber(event: SignalEvent, key: string): number | null {
  const v = event.evidence[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Evaluate the strategy's declared invalidation predicate on bar `i`.
 * Returns null while the contract is intact.
 */
export function evaluateInvalidation(input: EvaluationInput): InvalidationVerdict | null {
  const { strategyId, event, bars, x, i, rps, counters } = input;
  const on = bars.dates[i];

  switch (strategyId) {
    case 'tc_ma_trend': {
      // Declared: "detectSignals trend_breakdown on any later bar (close<MA60 with volume)".
      if (detectSignals(bars, x, i).includes('trend_breakdown')) {
        return { on, code: 'trend_breakdown', detail: 'close crossed below MA60 with volume ≥ volMA20' };
      }
      return null;
    }
    case 'tc_pullback_resume': {
      if (finite(x.ma60[i]) && bars.close[i] < x.ma60[i]) {
        return { on, code: 'close_below_ma60', detail: `close ${bars.close[i]} < MA60 ${x.ma60[i]}` };
      }
      return null;
    }
    case 'tc_rps_hold': {
      if (rps !== null && rps < 80) {
        return { on, code: 'rps_below_80', detail: `RPS120 ${rps} < 80` };
      }
      if (finite(x.ma20[i]) && bars.close[i] < x.ma20[i]) {
        return { on, code: 'close_below_ma20', detail: `close ${bars.close[i]} < MA20 ${x.ma20[i]}` };
      }
      if (finite(x.ma20[i]) && finite(x.ma20[i - 5]) && x.ma20[i] <= x.ma20[i - 5]) {
        counters.ma20NotRising = (counters.ma20NotRising ?? 0) + 1;
        if (counters.ma20NotRising >= 5) {
          return { on, code: 'ma20_not_rising_5', detail: 'MA20 non-rising for 5 bars' };
        }
      } else {
        counters.ma20NotRising = 0;
      }
      return null;
    }
    case 'bo_volume_20d': {
      // Declared: "close back below the 20-day high for 3 consecutive closes".
      const level = evidenceNumber(event, 'breakout_level');
      if (level === null) return null;
      if (bars.close[i] < level) {
        counters.belowBreakout = (counters.belowBreakout ?? 0) + 1;
        if (counters.belowBreakout >= 3) {
          return { on, code: 'close_below_breakout_3', detail: `close below ${level} for 3 closes` };
        }
      } else {
        counters.belowBreakout = 0;
      }
      return null;
    }
    case 'bo_range': {
      // Declared: "close back below the 60-day prior high" (the breakout level).
      const level = evidenceNumber(event, 'prior_high');
      if (level !== null && bars.close[i] < level) {
        return { on, code: 'close_below_prior_high', detail: `close ${bars.close[i]} < prior high ${level}` };
      }
      return null;
    }
    case 'bo_squeeze': {
      if (finite(x.bollMid[i]) && bars.close[i] < x.bollMid[i]) {
        return { on, code: 'close_below_boll_mid', detail: `close ${bars.close[i]} < bollMid ${x.bollMid[i]}` };
      }
      return null;
    }
    case 'rv_rsi_oversold': {
      // Declared: "RSI14 makes a new low below the oversold trough".
      const trough = evidenceNumber(event, 'rsi_trough');
      if (trough !== null && finite(x.rsi14[i]) && x.rsi14[i] < trough) {
        return { on, code: 'rsi_new_low', detail: `RSI14 ${x.rsi14[i]} < trough ${trough}` };
      }
      return null;
    }
    case 'rv_macd_divergence': {
      // Declared: "close < the recent price low that formed the divergence".
      const low = evidenceNumber(event, 'divergence_low');
      if (low !== null && bars.close[i] < low) {
        return { on, code: 'close_below_divergence_low', detail: `close ${bars.close[i]} < divergence low ${low}` };
      }
      return null;
    }
    case 'rv_macd_w_bottom': {
      // Declared: "DIF < min(first low, second low) after confirmation".
      const firstLow = evidenceNumber(event, 'first_low');
      const secondLow = evidenceNumber(event, 'second_low');
      if (firstLow !== null && secondLow !== null) {
        const floor = Math.min(firstLow, secondLow);
        if (finite(x.dif[i]) && x.dif[i] < floor) {
          return { on, code: 'dif_below_w_lows', detail: `DIF ${x.dif[i]} < both lows (${floor})` };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Trade-day age of a signal at the validation bar. */
export function signalAgeTradeDays(confirmIdx: number, i: number): number {
  return Math.max(0, i - confirmIdx);
}

export function signalIdOf(tsCode: string, strategyId: string, confirmedOn: string): string {
  return `${tsCode}:${strategyId}:${confirmedOn}`;
}

export function maxAgeOf(strategyId: string): number | null {
  return SIGNAL_MAX_AGE_TRADE_DAYS[strategyId] ?? null;
}

/** True when a required indicator is missing at the validation bar. */
export function hasInsufficientData(strategyId: string, x: IndicatorSet, i: number): boolean {
  const required = SIGNAL_REQUIRED_INDICATORS[strategyId];
  if (!required) return false;
  return required.some(key => !Number.isFinite(x[key][i] as number));
}
