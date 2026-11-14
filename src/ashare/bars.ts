import type { DatabaseSync } from 'node:sqlite';
import type { Bars } from './indicators.js';
import { adjustmentRatio } from './data.js';

/**
 * Stream forward-adjusted daily bars for every stock between `start` and
 * `end`, one stock at a time. Prices are scaled by adj_factor / adj_factor at
 * the stock's last bar ≤ `end`, so bars never depend on data after `end`.
 */
export interface BarsOptions {
  /**
   * `false` (default): preserve the legacy V1 series exactly, including a
   * missing OHLC value becoming 0 through numeric multiplication and a missing
   * adjustment factor being carried forward. V1 scores and ranks depend on it.
   * `true`: missing/non-finite OHLC and missing/invalid factors become NaN;
   * never carry a factor across a gap. Research code must opt in.
   */
  strictMissing?: boolean;
}

export function forEachStockBars(
  db: DatabaseSync,
  start: string,
  end: string,
  cb: (tsCode: string, bars: Bars) => void,
  codes?: string[],
  options: BarsOptions = {},
): number {
  const strictMissing = options.strictMissing === true;
  // One indexed range query per stock: efficient for both a 260-day window and full history.
  const stmt = db.prepare(`
    SELECT d.ts_code, d.trade_date, d.open, d.high, d.low, d.close, d.vol, d.amount, a.adj_factor, l.up_limit, l.down_limit
    FROM daily d
    LEFT JOIN adj_factor a ON a.trade_date = d.trade_date AND a.ts_code = d.ts_code
    LEFT JOIN stk_limit l ON l.trade_date = d.trade_date AND l.ts_code = d.ts_code
    WHERE d.ts_code = ? AND d.trade_date BETWEEN ? AND ?
    ORDER BY d.trade_date`);
  const universe = codes !== undefined
    ? codes
    : (db.prepare('SELECT ts_code FROM stock_basic ORDER BY ts_code').all() as any[]).map(r => r.ts_code as string);

  let current: string | undefined;
  let rows: any[] = [];
  let stocks = 0;
  const flush = () => {
    if (!current || rows.length === 0) return;
    const validFactor = (factor: unknown): factor is number =>
      typeof factor === 'number' && Number.isFinite(factor) && factor > 0;
    const price = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : NaN;
    let lastFactor = NaN;
    for (let k = rows.length - 1; k >= 0; k--) {
      const factor = rows[k].adj_factor;
      if (strictMissing ? validFactor(factor) : Number.isFinite(factor)) { lastFactor = factor; break; }
    }
    const bars: Bars = { dates: [], open: [], high: [], low: [], close: [], vol: [], amount: [], rawOpen: [], rawClose: [], rawHigh: [], rawLow: [], upLimit: [], downLimit: [], adjMissing: 0 };
    // Legacy V1 path: byte-for-byte the original arithmetic, including JS's
    // NULL * ratio → 0. score-1.0.0 is frozen against this series.
    let carry = Number.isFinite(lastFactor) ? lastFactor : 1;
    for (const r of rows) {
      if (strictMissing) {
        // Research path: a gap is unknown, never a zero and never bridged.
        if (!validFactor(r.adj_factor)) bars.adjMissing!++;
        const ratio = adjustmentRatio('qfq', validFactor(r.adj_factor) ? r.adj_factor : NaN, lastFactor);
        const open = price(r.open), high = price(r.high), low = price(r.low), close = price(r.close);
        bars.dates.push(r.trade_date);
        bars.open.push(open * ratio);
        bars.high.push(high * ratio);
        bars.low.push(low * ratio);
        bars.close.push(close * ratio);
        bars.vol.push(r.vol ?? 0);
        bars.amount.push(r.amount ?? 0);
        bars.rawOpen.push(open);
        bars.rawClose.push(close);
        bars.rawHigh!.push(high);
        bars.rawLow!.push(low);
      } else {
        if (Number.isFinite(r.adj_factor)) carry = r.adj_factor;
        else bars.adjMissing!++;
        // Same qfq definition as the data tools (data.ts), based on the last factor ≤ end.
        const ratio = Number.isFinite(lastFactor) ? adjustmentRatio('qfq', carry, lastFactor) : 1;
        bars.dates.push(r.trade_date);
        bars.open.push(r.open * ratio);
        bars.high.push(r.high * ratio);
        bars.low.push(r.low * ratio);
        bars.close.push(r.close * ratio);
        bars.vol.push(r.vol ?? 0);
        bars.amount.push(r.amount ?? 0);
        bars.rawOpen.push(r.open);
        bars.rawClose.push(r.close);
        bars.rawHigh!.push(r.high);
        bars.rawLow!.push(r.low);
      }
      bars.upLimit.push(r.up_limit ?? NaN);
      bars.downLimit!.push(r.down_limit ?? NaN);
    }
    stocks++;
    cb(current, bars);
  };
  for (const code of universe) {
    current = code;
    rows = stmt.all(code, start, end) as any[];
    flush();
  }
  return stocks;
}
