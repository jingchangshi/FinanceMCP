import type { DatabaseSync } from 'node:sqlite';
import { CORE_INDICES, recentTradeDays } from './ingest.js';
import { sma } from './indicators.js';
import { breadthByDate } from './data.js';

export type Regime = 'uptrend' | 'downtrend' | 'range';

export interface IndexPerformance {
  ts_code: string;
  name: string;
  close: number;
  pct_chg: number;
  ret5: number | null;
  ret20: number | null;
  amount_yi: number;
  above_ma20: boolean | null;
  above_ma60: boolean | null;
}

export interface MarketBreadth {
  stocks: number;
  up: number;
  down: number;
  flat: number;
  limit_up: number;
  limit_down: number;
  up_ratio: number;
  median_pct_chg: number;
  amount_yi: number;
  amount_prev_yi: number | null;
  amount_chg_pct: number | null;
  amount_ma20_yi: number | null;
  /** Descriptive observations; incomplete inputs are not interpreted as zero. */
  environment_facts: {
    as_of: string;
    source: 'daily';
    scope: string;
    research_status: 'unvalidated';
    quality: { status: 'complete' | 'partial' | 'missing'; rows: number; pct_chg_rows: number; amount_rows: number };
    up_ratio: number | null;
    median_pct_chg: number | null;
    amount_yi: number | null;
  };
}

const round = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : NaN);

export function indexPerformance(db: DatabaseSync, date: string): IndexPerformance[] {
  const out: IndexPerformance[] = [];
  for (const [code, name] of Object.entries(CORE_INDICES)) {
    const rows = (db.prepare('SELECT trade_date, close, pct_chg, amount FROM index_daily WHERE ts_code = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 61')
      .all(code, date) as any[]).reverse();
    const last = rows[rows.length - 1];
    if (!last || last.trade_date !== date) continue;
    const closes = rows.map(r => r.close);
    const n = closes.length - 1;
    const ret = (k: number) => (n >= k ? round((closes[n] / closes[n - k] - 1) * 100) : null);
    const ma = (k: number) => (n + 1 >= k ? closes.slice(-k).reduce((a, b) => a + b, 0) / k : NaN);
    out.push({
      ts_code: code,
      name,
      close: round(last.close),
      pct_chg: round(last.pct_chg),
      ret5: ret(5),
      ret20: ret(20),
      // index_daily amount is in thousand yuan.
      amount_yi: round(last.amount / 1e5),
      above_ma20: Number.isFinite(ma(20)) ? last.close > ma(20) : null,
      above_ma60: Number.isFinite(ma(60)) ? last.close > ma(60) : null,
    });
  }
  return out;
}

/**
 * Counts and turnover use all daily rows present for `date` (same-day market
 * coverage). `amount_ma20_yi` is the mean of the prior 20 trading-day totals,
 * excluding `date`; `amount_chg_pct` separately compares with the prior day.
 */
export function marketBreadth(db: DatabaseSync, date: string): MarketBreadth {
  const row: any = breadthByDate(db, date, date).get(date) ?? { stocks: 0, up: 0, down: 0, flat: 0, limit_up: 0, limit_down: 0, amount: 0 };
  const pcts = (db.prepare('SELECT pct_chg FROM daily WHERE trade_date = ? ORDER BY pct_chg').all(date) as any[]).map(r => r.pct_chg);
  const days = recentTradeDays(db, date, 21);
  const amounts = days.map(d => (db.prepare('SELECT SUM(amount) a FROM daily WHERE trade_date = ?').get(d) as any).a ?? NaN);
  const prev = amounts.length >= 2 ? amounts[amounts.length - 2] : NaN;
  const ma20 = amounts.length >= 21 ? sma(amounts.slice(0, 20), 20)[19] : NaN;
  const amount = row.amount ?? 0;
  const coverage = db.prepare(`SELECT COUNT(*) AS rows, COUNT(pct_chg) AS pct_chg_rows,
    COUNT(amount) AS amount_rows FROM daily WHERE trade_date = ?`).get(date) as {
      rows: number; pct_chg_rows: number; amount_rows: number;
    };
  const pctComplete = coverage.rows > 0 && coverage.pct_chg_rows === coverage.rows;
  const amountComplete = coverage.rows > 0 && coverage.amount_rows === coverage.rows;
  return {
    stocks: row.stocks,
    up: row.up ?? 0,
    down: row.down ?? 0,
    flat: row.flat ?? 0,
    limit_up: row.limit_up ?? 0,
    limit_down: row.limit_down ?? 0,
    up_ratio: round(row.stocks ? (row.up ?? 0) / row.stocks : NaN, 4),
    median_pct_chg: round(pcts.length ? pcts[Math.floor(pcts.length / 2)] : NaN),
    // daily.amount is in thousand yuan; 1 亿 = 1e5 thousand yuan.
    amount_yi: round(amount / 1e5),
    amount_prev_yi: Number.isFinite(prev) ? round(prev / 1e5) : null,
    amount_chg_pct: Number.isFinite(prev) && prev > 0 ? round((amount / prev - 1) * 100) : null,
    amount_ma20_yi: Number.isFinite(ma20) ? round(ma20 / 1e5) : null,
    environment_facts: {
      as_of: date,
      source: 'daily',
      scope: '当日 daily 行；不含停牌或缺失行情的股票，不能代表全部上市股票。',
      research_status: 'unvalidated',
      quality: {
        status: !coverage.rows ? 'missing' : pctComplete && amountComplete ? 'complete' : 'partial',
        ...coverage,
      },
      up_ratio: pctComplete ? round(row.up / coverage.rows, 4) : null,
      median_pct_chg: pctComplete
        ? round((pcts[Math.floor((pcts.length - 1) / 2)] + pcts[Math.floor(pcts.length / 2)]) / 2)
        : null,
      amount_yi: amountComplete ? round(amount / 1e5) : null,
    },
  };
}

/**
 * Market regime from CSI 300 only: uptrend when close > MA60 and today's
 * MA20 > MA20 five trading sessions earlier; downtrend when close < MA60 and
 * today's MA20 <= MA20 five sessions earlier; otherwise range. Requires the
 * current MA60 and five-session MA20 comparison to be available and uses no
 * index data after `end`.
 */
export function regimeSeries(db: DatabaseSync, end: string): Map<string, Regime> {
  const rows = db.prepare("SELECT trade_date, close FROM index_daily WHERE ts_code = '000300.SH' AND trade_date <= ? ORDER BY trade_date").all(end) as any[];
  const closes = rows.map(r => r.close);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const out = new Map<string, Regime>();
  rows.forEach((r, i) => {
    if (i < 65) return;
    const rising = ma20[i] > ma20[i - 5];
    const regime: Regime = closes[i] > ma60[i] && rising ? 'uptrend' : closes[i] < ma60[i] && !rising ? 'downtrend' : 'range';
    out.set(r.trade_date, regime);
  });
  return out;
}

export const REGIME_LABELS: Record<Regime, string> = { uptrend: '上升趋势', downtrend: '下降趋势', range: '震荡' };
