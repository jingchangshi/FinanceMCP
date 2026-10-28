import type { DatabaseSync } from 'node:sqlite';
import type { Bars } from './indicators.js';
import { forEachStockBars } from './bars.js';

/**
 * Relative Price Strength (RPS) — cross-sectional percentile of trailing
 * returns over the scanned universe.
 *
 * FinanceMCP previously had NO RPS implementation (verified by audit). The
 * formula adopted is the true cross-sectional percentile used by
 * sngyai/Sequoia-X `rps_breakout` (120-day return → cross-sectional rank,
 * MIT-licensed intent; see AShareInvestor docs/hotspot-multistrategy/
 * opensource-reuse.md), reimplemented here on FinanceMCP's own qfq bars —
 * no third-party code copied.
 *
 * Time semantics: every return ends at `end` (the caller's as-of bar) and is
 * computed from qfq closes that never depend on data after `end`
 * (forEachStockBars guarantees this). RPS for a stock with fewer bars than
 * the window is `null`, never a stale carry.
 */

export const RPS_VERSION = 'rps-1.0.0';

/** Windows in trading bars. 250 ≈ one year, 120 ≈ half year. */
export const RPS_WINDOWS = [60, 120, 250] as const;
export type RpsWindow = (typeof RPS_WINDOWS)[number];

export interface RpsRow {
  ts_code: string;
  /** Trailing return per window over the SAME universe (decimal). */
  ret: Record<RpsWindow, number | null>;
  /** Cross-sectional percentile 0..100 (100 = strongest). Null when unavailable. */
  rps: Record<RpsWindow, number | null>;
  /** Bars available at `end`. */
  bars: number;
}

export interface RpsResult {
  version: string;
  end: string;
  /** Universe size that entered the cross-section (rows with a finite ret for a window vary per window). */
  universe: number;
  rows: Map<string, RpsRow>;
}

/** Percentile rank, same ordinal semantics as analysis.ts `percentileRanks`: ascending rank/(n-1), 0..1. NaN inputs are excluded from the ranking entirely. */
export function percentileRank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).filter(x => Number.isFinite(x.v));
  const n = indexed.length;
  const out = new Array<number>(values.length).fill(NaN);
  if (n === 0) return out;
  if (n === 1) { out[indexed[0].i] = 1; return out; }
  // Deterministic tie handling: equal values share the mean of their ordinal slots.
  const sorted = [...indexed].sort((a, b) => a.v - b.v || a.i - b.i);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    const meanRank = (i + j) / 2;
    for (let k = i; k <= j; k++) out[sorted[k].i] = meanRank / (n - 1);
    i = j + 1;
  }
  return out;
}

/** Trailing return for a close series ending at its last element, `window` bars back. */
export function trailingReturn(closes: number[], window: number): number | null {
  if (closes.length <= window) return null;
  const base = closes[closes.length - 1 - window];
  const last = closes[closes.length - 1];
  if (!Number.isFinite(base) || !Number.isFinite(last) || base === 0) return null;
  return last / base - 1;
}

/**
 * Pure builder: cross-sectional RPS from per-stock close series.
 * Each series must be aligned to the SAME `end` (forEachStockBars guarantees
 * alignment when called with one end date).
 */
export function rpsFromCloses(closes: Map<string, number[]>): RpsResult {
  const rows = new Map<string, RpsRow>();
  const returns: Record<RpsWindow, Map<string, number>> = {
    60: new Map(), 120: new Map(), 250: new Map(),
  };
  for (const [ts, series] of closes) {
    const ret = {} as Record<RpsWindow, number | null>;
    for (const w of RPS_WINDOWS) {
      const r = trailingReturn(series, w);
      ret[w] = r;
      if (r !== null) returns[w].set(ts, r);
    }
    rows.set(ts, {
      ts_code: ts, ret,
      rps: { 60: null, 120: null, 250: null },
      bars: series.length,
    });
  }
  for (const w of RPS_WINDOWS) {
    const values = [...returns[w].values()];
    const pct = percentileRank(values).map(p => p * 100);
    let k = 0;
    for (const ts of returns[w].keys()) {
      rows.get(ts)!.rps[w] = pct[k++];
    }
  }
  let universe = 0;
  for (const r of rows.values()) if (Number.isFinite(r.ret[120]) || Number.isFinite(r.ret[60])) universe++;
  return { version: RPS_VERSION, end: '', universe, rows };
}

/**
 * Compute RPS over a universe of stocks for the window ending `end`
 * (inclusive). One batched pass per stock via forEachStockBars — never a
 * per-bar query. `codes` restricts the universe (e.g. a candidate pool);
 * without it the full stock_basic universe is used, which is what a
 * cross-sectional percentile needs.
 */
export function computeRps(
  db: DatabaseSync,
  start: string,
  end: string,
  codes?: string[],
): RpsResult {
  const closes = new Map<string, number[]>();
  forEachStockBars(db, start, end, (ts, bars) => {
    if (bars.adjMissing && bars.adjMissing > 0) return; // incomplete adjustment ⇒ no RPS (honest gap, not a stale value)
    closes.set(ts, bars.close.slice());
  }, codes);
  const result = rpsFromCloses(closes);
  result.end = end;
  return result;
}

/**
 * Start date for an RPS window that needs `RPS_MAX_WINDOW` bars plus buffer:
 * callers pass `start` such that `end - start` covers 250 trading days.
 * Provided so callers do not each invent their own buffer.
 */
export function rpsStartDate(tradeDaysDescendingNewestFirst: string[], fallbackDays = 400): string {
  // tradeDaysDescendingNewestFirst: [end, prev, ...] from recentTradeDays.
  const idx = 250;
  if (tradeDaysDescendingNewestFirst.length > idx) return tradeDaysDescendingNewestFirst[idx];
  const last = tradeDaysDescendingNewestFirst[0];
  const d = new Date(Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() - fallbackDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
