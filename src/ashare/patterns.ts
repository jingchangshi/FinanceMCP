/**
 * Chart-pattern detectors with explicit confirmation-lag semantics (goal-1028
 * §P3.3). Every function here obeys one rule:
 *
 *   Reading index i may only observe values[m] for m <= i, and a pattern's
 *   `confirmIndex` is the FIRST bar at which the pattern is provable — never
 *   the bar where the shape started forming. Signals are dated at
 *   `confirmIndex`. Backfilling a signal date to the formation low is a
 *   future function and is forbidden (tested by truncation equality).
 *
 * The module is pure (no DB, no I/O) so tests can pin exact time semantics.
 * Configuration constants live in `DEFAULT_*_OPTS` and are pre-registered:
 * changing them means changing `strategy_version`.
 */

export const PATTERN_VERSION = 'patterns-hs-1.0.0';

const isFin = (v: number | undefined | null): v is number => Number.isFinite(v);

export interface LocalLowOpts {
  /** Neighborhood half-width: low must be the leftmost minimum of [j-L, j+L]. */
  L: number;
  /** Required subsequent bars after the formation bar before it may count. */
  K: number;
}

export interface ConfirmedLow {
  /** Formation index of the low. */
  index: number;
  value: number;
}

/** Leftmost argmin of values[from..to] (inclusive), or -1. */
function argMinLeftmost(values: number[], from: number, to: number): number {
  let best = -1;
  for (let m = Math.max(0, from); m <= Math.min(values.length - 1, to); m++) {
    if (!isFin(values[m])) continue;
    if (best === -1 || values[m] < values[best]) best = m;
  }
  return best;
}

/** Rightmost argmax (for the neckline), values[from..to]. */
function argMaxRightmost(values: number[], from: number, to: number): number {
  let best = -1;
  for (let m = Math.max(0, from); m <= Math.min(values.length - 1, to); m++) {
    if (!isFin(values[m])) continue;
    if (best === -1 || values[m] >= values[best]) best = m;
  }
  return best;
}

/**
 * All confirmed local lows in effect at evaluation index `i`, newest first.
 * A bar `j` is confirmed iff:
 *   - the full neighborhood [j-L, j+L] is observable (j + L <= i),
 *   - at least K bars follow j (j + K <= i),
 *   - j is the leftmost minimum of its neighborhood.
 * Only indices <= i are read ⇒ identical results on a series truncated at i.
 */
export function confirmedLocalLows(values: number[], i: number, opts: LocalLowOpts, fromIndex = 0): ConfirmedLow[] {
  const out: ConfirmedLow[] = [];
  const lo = Math.max(fromIndex, 0);
  const hi = Math.min(i - Math.max(opts.L, opts.K), i);
  for (let j = lo; j <= hi; j++) {
    if (argMinLeftmost(values, j - opts.L, j + opts.L) === j) out.push({ index: j, value: values[j] });
  }
  return out.sort((a, b) => b.index - a.index);
}

// ---------------------------------------------------------------- W bottom

export interface WBottomOpts extends LocalLowOpts {
  /** Min/max bars between the two lows. */
  minGap: number;
  maxGap: number;
  /** How far back from i the first low may originate (bars). */
  lookback: number;
  /**
   * Relative tolerance: the second low must satisfy
   * |v2 - v1| <= relTol * max(|v1|, |v2|) — a W, not a random double dip.
   */
  relTol: number;
  /** Require both lows below this absolute ceiling (RSI-style levels). Infinity disables. */
  lowCeiling: number;
}

export const DEFAULT_MACD_W_OPTS: WBottomOpts = {
  L: 5, K: 5, minGap: 10, maxGap: 60, lookback: 180, relTol: 0.35, lowCeiling: Infinity,
};

export const DEFAULT_RSI_W_OPTS: WBottomOpts = {
  L: 5, K: 5, minGap: 8, maxGap: 60, lookback: 180, relTol: 0.35, lowCeiling: 40,
};

export interface WBottom {
  /** Formation indices of the two lows (j1 < j2). */
  j1: number;
  j2: number;
  /** Max of the series strictly between the two lows — the neckline. */
  neckline: number;
  /** First index c >= j2 where v[c] > neckline and v[c-1] <= neckline (the confirmation bar). */
  confirmIndex: number;
  firstLow: number;
  secondLow: number;
  /** Invalidation line: a later breach below both lows voids the pattern. */
  invalidateBelow: number;
  /**
   * First index > confirmIndex with v < invalidateBelow, or null when intact.
   * Resolved only with data <= the evaluation index.
   */
  invalidateIndex: number | null;
}

/**
 * Detect a confirmed double bottom ("W") on `v` as of evaluation index `i`.
 * Returns null until the neckline is crossed (confirmation), and includes an
 * invalidation index when the cross has since failed. Only reads <= i.
 */
export function detectWBottom(v: number[], i: number, opts: WBottomOpts = DEFAULT_MACD_W_OPTS): WBottom | null {
  if (i < opts.L + opts.K + 1) return null;
  const lows = confirmedLocalLows(v, i, opts, i - opts.lookback - opts.L);
  if (lows.length < 2) return null;
  // lows is sorted newest-first; prefer the most recent valid pair (largest j2).
  for (let n = 0; n < lows.length - 1; n++) {
    const j2 = lows[n].index;
    for (let m = n + 1; m < lows.length; m++) {
      const j1 = lows[m].index;
      const gap = j2 - j1;
      if (gap < opts.minGap) continue; // lows too close: same trough, not a W
      if (gap > opts.maxGap) break;    // lows too far apart: two separate events (lows sorted desc)
      const v1 = v[j1];
      const v2 = v[j2];
      if (!isFin(v1) || !isFin(v2)) continue;
      if (v1 > opts.lowCeiling || v2 > opts.lowCeiling) continue;
      const scale = Math.max(Math.abs(v1), Math.abs(v2));
      if (!(Math.abs(v2 - v1) <= opts.relTol * scale)) continue;
      // Neckline: strongest value strictly between the two lows.
      const neckIdx = argMaxRightmost(v, j1 + 1, j2 - 1);
      if (neckIdx <= 0 || !isFin(v[neckIdx])) continue;
      const neckline = v[neckIdx];
      if (!(neckline > v1 && neckline > v2)) continue; // no intermediate high above both lows ⇒ not a W
      // Confirmation: first neckline cross at or after j2, observable at i.
      let confirm = -1;
      for (let c = Math.max(j2, 1); c <= i; c++) {
        if (isFin(v[c]) && isFin(v[c - 1]) && v[c] > neckline && v[c - 1] <= neckline) { confirm = c; break; }
      }
      if (confirm < 0) continue; // formed but unconfirmed ⇒ not a signal yet
      const invalidateBelow = Math.min(v1, v2);
      let invalidateIndex: number | null = null;
      for (let m2 = confirm + 1; m2 <= i; m2++) {
        if (isFin(v[m2]) && v[m2] < invalidateBelow) { invalidateIndex = m2; break; }
      }
      return { j1, j2, neckline, confirmIndex: confirm, firstLow: v1, secondLow: v2, invalidateBelow, invalidateIndex };
    }
  }
  return null;
}

// ---------------------------------------------------------------- range breakout

export interface RangeBreakoutOpts {
  /** Excluded today: prior window is [i-range, i-1]. */
  range: number;
  /** Volume confirmation vs the 20-day volume mean. */
  volRatio: number;
}

export const DEFAULT_RANGE_BREAKOUT_OPTS: RangeBreakoutOpts = { range: 60, volRatio: 1.2 };

export interface RangeBreakout {
  breakIndex: number;
  priorHigh: number;
  priorLow: number;
  volRatio: number;
}

/**
 * Close breaks above the prior `range`-day high (today excluded from the
 * window — no self-referential high) with volume confirmation.
 * Emitted only on the crossing bar (first-cross semantics, detect at i only).
 */
export function detectRangeBreakout(
  high: number[], low: number[], close: number[], vol: number[], volMa20: number[],
  i: number, opts: RangeBreakoutOpts = DEFAULT_RANGE_BREAKOUT_OPTS,
): RangeBreakout | null {
  if (i < opts.range + 1 || i < 21) return null;
  const priorHigh = high[argMaxRightmost(high, i - opts.range, i - 1)];
  let priorLow = Infinity;
  for (let m = i - opts.range; m <= i - 1; m++) if (isFin(low[m]) && low[m] < priorLow) priorLow = low[m];
  if (!isFin(priorHigh) || !isFin(priorLow) || !isFin(close[i]) || !isFin(vol[i]) || !isFin(volMa20[i])) return null;
  const wasAbove = isFin(close[i - 1]) && isFin(high[i - 1])
    ? close[i - 1] > high[argMaxRightmost(high, i - opts.range - 1, i - 2)]
    : false;
  if (close[i] <= priorHigh || wasAbove) return null; // first-cross only
  if (!(vol[i] >= opts.volRatio * volMa20[i])) return null;
  return { breakIndex: i, priorHigh, priorLow, volRatio: vol[i] / volMa20[i] };
}

// ---------------------------------------------------------------- pullback resume

export interface PullbackOpts {
  /** Bars back a touch of MA20 may have occurred (exclusive of today). */
  touchWindow: number;
  /** Close may exceed MA20 by at most this fraction when counting as a touch. */
  touchTol: number;
}

export const DEFAULT_PULLBACK_OPTS: PullbackOpts = { touchWindow: 5, touchTol: 0.01 };

export interface PullbackResume {
  confirmIndex: number;
  /** Last bar (<= i) whose low touched the MA20 band. */
  touchIndex: number;
  ma20: number;
}

/**
 * Uptrend (close > MA20 > MA60) that recently tagged the MA20 from above
 * (within `touchWindow` bars, not today) and resumes: today closes back above
 * MA20 and up on the day. First-cross semantics over the episode.
 */
export function detectPullbackResume(
  close: number[], low: number[], ma20: number[], ma60: number[],
  i: number, opts: PullbackOpts = DEFAULT_PULLBACK_OPTS,
): PullbackResume | null {
  if (i < 61 || i < opts.touchWindow + 1) return null;
  if (!isFin(close[i]) || !isFin(ma20[i]) || !isFin(ma60[i])) return null;
  if (!(close[i] > ma20[i] && ma20[i] > ma60[i])) return null;
  if (!isFin(close[i - 1]) || !(close[i] > close[i - 1])) return null;
  let touchIndex = -1;
  for (let j = i - 1; j >= i - opts.touchWindow; j--) {
    if (!isFin(low[j]) || !isFin(ma20[j])) continue;
    if (low[j] <= ma20[j] * (1 + opts.touchTol)) { touchIndex = j; break; }
  }
  if (touchIndex < 0) return null;
  // First-cross uniqueness: the compound resume condition must not have held
  // yesterday (with yesterday not itself the touch day). This blocks re-fires
  // on every up-bar of a multi-day run while still emitting on the first bar
  // after a touch.
  const resumeCond = (k: number): boolean => k >= 1 && isFin(close[k]) && isFin(ma20[k]) && isFin(ma60[k])
    && isFin(close[k - 1]) && close[k] > ma20[k] && ma20[k] > ma60[k] && close[k] > close[k - 1];
  if (touchIndex < i - 1 && resumeCond(i - 1)) return null;
  return { confirmIndex: i, touchIndex, ma20: ma20[i] };
}

// ---------------------------------------------------------------- RPS hold

export interface RpsHoldOpts {
  /** RPS120 percentile floor (0..100). */
  rpsFloor: number;
  /** Required bars of MA20 rising (ma20[i] > ma20[i-risingBars]). */
  risingBars: number;
}

export const DEFAULT_RPS_HOLD_OPTS: RpsHoldOpts = { rpsFloor: 80, risingBars: 5 };

/**
 * RPS strength continuation: RPS120 at/above the floor while the MA20 keeps
 * rising and price holds above it. First-cross semantics over the COMPOUND
 * condition — including the RPS floor crossing itself, so callers must pass
 * a per-bar RPS history (never an end-date snapshot reused for earlier bars,
 * which would be a future function).
 */
export function detectRpsHold(
  close: number[], ma20: number[], rps120: Array<number | null>, i: number,
  opts: RpsHoldOpts = DEFAULT_RPS_HOLD_OPTS,
): { confirmIndex: number; rps: number } | null {
  if (i < opts.risingBars + 1) return null;
  const r = rps120[i];
  if (r === null || r === undefined || !Number.isFinite(r) || r < opts.rpsFloor) return null;
  if (!isFin(close[i]) || !isFin(ma20[i]) || !isFin(ma20[i - opts.risingBars])) return null;
  if (!(close[i] > ma20[i] && ma20[i] > ma20[i - opts.risingBars])) return null;
  const holdingAt = (k: number): boolean => {
    const rk = rps120[k];
    return k >= opts.risingBars && rk !== null && rk !== undefined && Number.isFinite(rk) && rk >= opts.rpsFloor
      && isFin(close[k]) && isFin(ma20[k]) && isFin(ma20[k - opts.risingBars])
      && close[k] > ma20[k] && ma20[k] > ma20[k - opts.risingBars];
  };
  if (holdingAt(i - 1)) return null; // continuation already in force — first-cross only
  return { confirmIndex: i, rps: r };
}
