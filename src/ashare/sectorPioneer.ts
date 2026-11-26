import type { DatabaseSync } from 'node:sqlite';
import { portfolioTableExists } from '../portfolio/db.js';
import { V3_SUPER_ETF_SECTOR_PIONEER_CODES } from './etfDeclarations.js';
import type { EtfCandidateRow, EtfCandidateScreenResult } from './etfUniverse.js';

export interface SectorPioneerCandidate {
  ts_code: string;
  name: string;
  as_of_trade_date: string;
  close_cny: number;
  close_milli: number;
  ma60_cny: number;
  ret20_pct: number;
  ret60_pct: number;
  blend_score_pct: number;
}

export interface SectorPioneerScreenResult {
  schema: 'ashare-sector-pioneer-screen/1.0';
  as_of_trade_date: string;
  pool_size: number;
  eligible_count: number;
  candidates: SectorPioneerCandidate[];
}

interface BarWithAdj {
  trade_date: string;
  raw_close: number;
  qfq_close: number;
}

function loadQfqSeries(db: DatabaseSync, tsCode: string, asOf: string): BarWithAdj[] {
  if (!portfolioTableExists(db, 'fund_daily')) return [];
  const rows = (db.prepare(`
    SELECT d.trade_date, d.close, a.adj_factor
    FROM fund_daily d
    LEFT JOIN fund_adj a ON a.ts_code = d.ts_code AND a.trade_date = d.trade_date
    WHERE d.ts_code = ? AND d.trade_date <= ? AND d.close > 0
    ORDER BY d.trade_date DESC LIMIT 70
  `).all(tsCode, asOf) as Array<{ trade_date: string; close: number; adj_factor: number | null }>).reverse();
  if (rows.length < 61) return [];
  const latestAdj = Number(rows[rows.length - 1]?.adj_factor);
  const useAdj = Number.isFinite(latestAdj) && latestAdj > 0;
  let carry = 1;
  if (useAdj) {
    for (const r of rows) {
      if (r.adj_factor && r.adj_factor > 0) {
        carry = Number(r.adj_factor);
        break;
      }
    }
  }
  const baseAdj = useAdj ? latestAdj : 1;
  return rows.map(r => {
    if (useAdj && r.adj_factor && r.adj_factor > 0) carry = Number(r.adj_factor);
    const raw = Number(r.close);
    return {
      trade_date: String(r.trade_date),
      raw_close: raw,
      qfq_close: useAdj ? raw * (carry / baseAdj) : raw,
    };
  });
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * EXP-V3-10A/11 超级行业 ETF 20/60 混合动量先导筛选：
 * 仅保留纳入超级行业池、当期可买且收盘高于 MA60 的品种，按 0.5*ret20 + 0.5*ret60 降序排列。
 */
export function screenSectorPioneerCandidates(
  marketDb: DatabaseSync | null | undefined,
  asOf: string,
  opts: {
    etfScreen?: EtfCandidateScreenResult | null;
    poolCodes?: readonly string[];
    maxCandidates?: number;
  } = {},
): SectorPioneerScreenResult {
  const pool = opts.poolCodes ?? V3_SUPER_ETF_SECTOR_PIONEER_CODES;
  const maxN = Math.max(1, opts.maxCandidates ?? 3);
  if (!marketDb) {
    return {
      schema: 'ashare-sector-pioneer-screen/1.0',
      as_of_trade_date: asOf,
      pool_size: pool.length,
      eligible_count: 0,
      candidates: [],
    };
  }
  const screenMap = new Map<string, EtfCandidateRow>(
    (opts.etfScreen?.candidates ?? []).map(c => [c.ts_code, c]),
  );

  const candidates: SectorPioneerCandidate[] = [];
  for (const tsCode of pool) {
    const screened = screenMap.get(tsCode);
    if (screenMap.size > 0) {
      if (!screened || !screened.included || screened.data?.buy_blocked) continue;
    }
    const series = loadQfqSeries(marketDb, tsCode, asOf);
    if (series.length < 61) continue;
    const last = series[series.length - 1];
    if (last.trade_date !== asOf || !(last.raw_close > 0)) continue;
    const ma60 = series.slice(-60).reduce((s, x) => s + x.qfq_close, 0) / 60;
    const c20 = series[series.length - 21].qfq_close;
    const c60 = series[series.length - 61].qfq_close;
    if (!(c20 > 0) || !(c60 > 0) || !(last.qfq_close > ma60)) continue;
    const ret20 = (last.qfq_close / c20) - 1;
    const ret60 = (last.qfq_close / c60) - 1;
    const blend = 0.5 * ret20 + 0.5 * ret60;
    let name = screened?.name ?? tsCode;
    if (!screened && portfolioTableExists(marketDb, 'fund_basic')) {
      const row = marketDb.prepare('SELECT name FROM fund_basic WHERE ts_code = ?').get(tsCode) as { name?: string } | undefined;
      if (row?.name) name = row.name;
    }
    candidates.push({
      ts_code: tsCode,
      name,
      as_of_trade_date: asOf,
      close_cny: Math.round(last.raw_close * 1000) / 1000,
      close_milli: Math.round(last.raw_close * 1000),
      ma60_cny: Math.round(ma60 * 1000) / 1000,
      ret20_pct: r2(ret20 * 100),
      ret60_pct: r2(ret60 * 100),
      blend_score_pct: r2(blend * 100),
    });
  }

  candidates.sort((a, b) => b.blend_score_pct - a.blend_score_pct || a.ts_code.localeCompare(b.ts_code));
  return {
    schema: 'ashare-sector-pioneer-screen/1.0',
    as_of_trade_date: asOf,
    pool_size: pool.length,
    eligible_count: candidates.length,
    candidates: candidates.slice(0, maxN),
  };
}
