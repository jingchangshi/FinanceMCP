import type { DatabaseSync } from 'node:sqlite';
import { inTransaction, logSync } from './db.js';
import { addDays } from './ingest.js';
import { fetchChinaBondYieldCurve, type ChinaBondYieldRow } from './providers/eastmoneyClient.js';

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function countTradeDaysGap(db: DatabaseSync, fromDate: string, toDate: string): number {
  if (fromDate >= toDate) return 0;
  if (tableExists(db, 'trade_cal')) {
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM trade_cal WHERE is_open = 1 AND cal_date > ? AND cal_date <= ?',
    ).get(fromDate, toDate) as { n?: number } | undefined;
    if (row && typeof row.n === 'number') return row.n;
  }
  const ms = Date.UTC(+toDate.slice(0, 4), +toDate.slice(4, 6) - 1, +toDate.slice(6, 8))
    - Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(4, 6) - 1, +fromDate.slice(6, 8));
  return Math.max(0, Math.round(ms / 86_400_000 / 1.48));
}

function median(values: number[]): number | null {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile30(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = 0.3 * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function causalEmpiricalPercentile(history: number[], current: number | null, window = 756, minPeriods = 60): number | null {
  if (current === null || !Number.isFinite(current)) return null;
  const combined = [...history.filter(Number.isFinite), current];
  const slice = combined.slice(Math.max(0, combined.length - window));
  if (slice.length < minPeriods) return null;
  let le = 0;
  for (const v of slice) {
    if (v <= current) le += 1;
  }
  return le / slice.length;
}

export interface MacroYieldSyncResult {
  trade_date: string;
  status: 'ok' | 'fallback' | 'failed';
  source: string | null;
  cgb_1y_bps: number | null;
  cgb_10y_bps: number | null;
  term_spread_bps: number | null;
  fallback_from_date?: string | null;
  warning?: string;
}

/**
 * 日频增量同步当日中债 1Y/10Y 收益率（仅查近 10 日窗口写入 asOf）。
 * Fail-Safe：上游超时或空返回时自动沿用 <=5 交易日内最近有效值并记录告警，绝不抛错阻断日报。
 */
export async function syncMacroYieldCurve(
  db: DatabaseSync,
  asOf: string,
  options: {
    fetcher?: (startYmd: string, endYmd: string) => Promise<ChinaBondYieldRow[]>;
  } = {},
): Promise<MacroYieldSyncResult> {
  const start = addDays(asOf, -14);
  const fetcher = options.fetcher ?? fetchChinaBondYieldCurve;
  try {
    const rows = await fetcher(start, asOf);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO macro_yield_curve (
        trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source
      ) VALUES (?,?,?,?,?)
    `);
    if (rows.length > 0) {
      inTransaction(db, () => {
        for (const r of rows) {
          insert.run(r.trade_date, r.cgb_1y_bps, r.cgb_10y_bps, r.term_spread_bps, r.source);
        }
      });
    }
    const exact = rows.find(r => r.trade_date === asOf)
      ?? (db.prepare('SELECT trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source FROM macro_yield_curve WHERE trade_date = ?').get(asOf) as any);
    if (exact && exact.cgb_10y_bps != null) {
      logSync(db, 'macro_yield_curve', asOf, rows.length, 'ok', '', {
        refresh_status: 'REFRESH_OK',
        write_mode: 'merged',
      });
      return {
        trade_date: asOf,
        status: 'ok',
        source: exact.source ?? 'chinabond_free',
        cgb_1y_bps: exact.cgb_1y_bps ?? null,
        cgb_10y_bps: exact.cgb_10y_bps ?? null,
        term_spread_bps: exact.term_spread_bps ?? null,
      };
    }
  } catch (error: any) {
    const msg = String(error?.message ?? error).slice(0, 160);
    console.warn(`[ashare] 中债收益率曲线刷新失败（尝试 <=5 交易日 Fail-Safe 沿用）: ${msg}`);
  }

  // Fail-Safe: 沿用最近 <= 5 交易日有效值
  const recent = db.prepare(`
    SELECT trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source
    FROM macro_yield_curve
    WHERE trade_date <= ? AND cgb_10y_bps IS NOT NULL
    ORDER BY trade_date DESC
    LIMIT 1
  `).get(asOf) as { trade_date: string; cgb_1y_bps: number | null; cgb_10y_bps: number | null; term_spread_bps: number | null; source: string | null } | undefined;

  if (recent && countTradeDaysGap(db, recent.trade_date, asOf) <= 5) {
    const warn = `中债曲线当日未就绪，沿用最近有效日 ${recent.trade_date}`;
    inTransaction(db, () => {
      db.prepare(`
        INSERT OR REPLACE INTO macro_yield_curve (trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source)
        VALUES (?,?,?,?,?)
      `).run(asOf, recent.cgb_1y_bps, recent.cgb_10y_bps, recent.term_spread_bps, `failsafe_carry:${recent.trade_date}`);
      logSync(db, 'macro_yield_curve', asOf, 1, 'fallback', warn, {
        refresh_status: 'REFRESH_INCOMPLETE',
        write_mode: 'merged',
      });
    });
    return {
      trade_date: asOf,
      status: 'fallback',
      source: `failsafe_carry:${recent.trade_date}`,
      cgb_1y_bps: recent.cgb_1y_bps,
      cgb_10y_bps: recent.cgb_10y_bps,
      term_spread_bps: recent.term_spread_bps,
      fallback_from_date: recent.trade_date,
      warning: warn,
    };
  }

  logSync(db, 'macro_yield_curve', asOf, 0, 'failed', 'no valid ChinaBond yield within 5 trade days', {
    refresh_status: 'REFRESH_FAILED',
    write_mode: 'none',
  });
  return {
    trade_date: asOf,
    status: 'failed',
    source: null,
    cgb_1y_bps: null,
    cgb_10y_bps: null,
    term_spread_bps: null,
    warning: '中债曲线缺失且近 5 个交易日内无可用历史值',
  };
}

export interface MarketFundamentalDailySyncResult {
  trade_date: string;
  status: 'ok' | 'fallback' | 'failed';
  ep_median_bps: number | null;
  bp_median_bps: number | null;
  dv_lowvol_bps: number | null;
  erp_bps: number | null;
  erp_pct_756: number | null;
  bp_pct_756: number | null;
  edi_bps: number | null;
  fallback_from_date?: string | null;
  warning?: string;
}

/**
 * 日频单日增量计算 `market_fundamental_daily`（Top-800 流动性活跃非北交 A 股）：
 * 仅算 `asOf` 1 行并追加进历史序列，严格因果 756d 分位；数据不足时自动沿用 <=5 交易日最近有效值。
 */
export function computeAndStoreMarketFundamentalDaily(
  db: DatabaseSync,
  asOf: string,
): MarketFundamentalDailySyncResult {
  const carryForward = (reason: string): MarketFundamentalDailySyncResult => {
    const prev = db.prepare(`
      SELECT trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps
      FROM market_fundamental_daily
      WHERE trade_date < ? AND ep_median_bps IS NOT NULL AND bp_median_bps IS NOT NULL AND erp_bps IS NOT NULL
      ORDER BY trade_date DESC
      LIMIT 1
    `).get(asOf) as any;
    if (prev && countTradeDaysGap(db, prev.trade_date, asOf) <= 5) {
      const warn = `${reason}，慢变量沿用 ${prev.trade_date}`;
      inTransaction(db, () => {
        db.prepare(`
          INSERT OR REPLACE INTO market_fundamental_daily (
            trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps
          ) VALUES (?,?,?,?,?,?,?,?)
        `).run(
          asOf,
          prev.ep_median_bps,
          prev.bp_median_bps,
          prev.dv_lowvol_bps,
          prev.erp_bps,
          prev.erp_pct_756,
          prev.bp_pct_756,
          prev.edi_bps,
        );
        logSync(db, 'market_fundamental_daily', asOf, 1, 'fallback', warn, {
          refresh_status: 'REFRESH_INCOMPLETE',
          write_mode: 'merged',
        });
      });
      console.warn(`[ashare] ${warn}`);
      return {
        trade_date: asOf,
        status: 'fallback',
        ep_median_bps: prev.ep_median_bps,
        bp_median_bps: prev.bp_median_bps,
        dv_lowvol_bps: prev.dv_lowvol_bps,
        erp_bps: prev.erp_bps,
        erp_pct_756: prev.erp_pct_756,
        bp_pct_756: prev.bp_pct_756,
        edi_bps: prev.edi_bps,
        fallback_from_date: prev.trade_date,
        warning: warn,
      };
    }
    logSync(db, 'market_fundamental_daily', asOf, 0, 'failed', reason, {
      refresh_status: 'REFRESH_FAILED',
      write_mode: 'none',
    });
    return {
      trade_date: asOf,
      status: 'failed',
      ep_median_bps: null,
      bp_median_bps: null,
      dv_lowvol_bps: null,
      erp_bps: null,
      erp_pct_756: null,
      bp_pct_756: null,
      edi_bps: null,
      warning: reason,
    };
  };

  if (!tableExists(db, 'daily') || !tableExists(db, 'fina_indicator')) {
    return carryForward('缺少 daily 或 fina_indicator 表');
  }

  const recentDates = tableExists(db, 'trade_cal')
    ? (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date <= ? ORDER BY cal_date DESC LIMIT 65').all(asOf) as Array<{ cal_date: string }>).map(r => r.cal_date).reverse()
    : (db.prepare('SELECT DISTINCT trade_date FROM daily WHERE trade_date <= ? ORDER BY trade_date DESC LIMIT 65').all(asOf) as Array<{ trade_date: string }>).map(r => r.trade_date).reverse();

  if (!recentDates.includes(asOf)) {
    return carryForward(`交易日 ${asOf} 无日线上下文`);
  }

  const suspSet = new Set<string>();
  if (tableExists(db, 'suspend_d')) {
    const sRows = db.prepare('SELECT ts_code FROM suspend_d WHERE trade_date = ?').all(asOf) as Array<{ ts_code: string }>;
    for (const r of sRows) suspSet.add(r.ts_code);
  }

  const todayBars = db.prepare(`
    SELECT ts_code, close, vol, amount
    FROM daily
    WHERE trade_date = ? AND ts_code NOT LIKE '%.BJ' AND close > 0 AND vol > 0 AND amount > 0
  `).all(asOf) as Array<{ ts_code: string; close: number; vol: number; amount: number }>;

  const activeToday = todayBars.filter(r => !suspSet.has(r.ts_code));
  if (activeToday.length === 0) {
    return carryForward(`${asOf} 无有效活跃非北交股票行情`);
  }

  // 20日平均成交额 Top-800
  const amt20Start = recentDates[Math.max(0, recentDates.length - 20)];
  const amtMap = new Map<string, number>();
  const amtRows = db.prepare(`
    SELECT ts_code, AVG(amount) AS amt20
    FROM daily
    WHERE trade_date BETWEEN ? AND ? AND ts_code NOT LIKE '%.BJ' AND amount > 0
    GROUP BY ts_code
  `).all(amt20Start, asOf) as Array<{ ts_code: string; amt20: number }>;
  for (const r of amtRows) amtMap.set(r.ts_code, Number(r.amt20));

  const ranked = [...activeToday].sort(
    (a, b) => (amtMap.get(b.ts_code) ?? b.amount) - (amtMap.get(a.ts_code) ?? a.amount),
  );
  const top800 = ranked.slice(0, 800);
  const topSet = new Set(top800.map(r => r.ts_code));
  const closeMap = new Map(top800.map(r => [r.ts_code, Number(r.close)]));

  // 加载 PIT 财报（ann_date <= asOf, 近 2 年以支持 TTM 与环比 EDI）
  const finaCutoff = addDays(asOf, -800);
  const finaCols = new Set((db.prepare('PRAGMA table_info(fina_indicator)').all() as Array<{ name: string }>).map(c => c.name));
  const hasBps = finaCols.has('bps');
  const finaRows = db.prepare(`
    SELECT ts_code, end_date, ann_date, eps, roe_dt, dt_netprofit_yoy${hasBps ? ', bps' : ', NULL AS bps'}
    FROM fina_indicator
    WHERE ann_date <= ? AND end_date >= ? AND ann_date >= end_date
    ORDER BY ts_code ASC, ann_date ASC, end_date ASC
  `).all(asOf, finaCutoff) as Array<{
    ts_code: string; end_date: string; ann_date: string;
    eps: number | null; roe_dt: number | null; dt_netprofit_yoy: number | null; bps: number | null;
  }>;

  const finaByCode = new Map<string, Map<string, typeof finaRows[number]>>();
  for (const r of finaRows) {
    if (!topSet.has(r.ts_code)) continue;
    let byEnd = finaByCode.get(r.ts_code);
    if (!byEnd) {
      byEnd = new Map();
      finaByCode.set(r.ts_code, byEnd);
    }
    const prev = byEnd.get(r.end_date);
    if (!prev || r.ann_date >= prev.ann_date) byEnd.set(r.end_date, r);
  }

  // 加载 xdxr 纯送转拆股事件，用于把报告期末 BPS / EPS 除权到 asOf 股本口径
  const splitMap = new Map<string, Array<{ ex_date: string; fac: number }>>();
  if (tableExists(db, 'xdxr')) {
    const xRows = db.prepare(`
      SELECT ts_code, ex_date, songzhuangu, peigu
      FROM xdxr
      WHERE category = 1 AND ex_date <= ? AND ((songzhuangu IS NOT NULL AND songzhuangu > 0) OR (peigu IS NOT NULL AND peigu > 0))
      ORDER BY ex_date ASC
    `).all(asOf) as Array<{ ts_code: string; ex_date: string; songzhuangu: number | null; peigu: number | null }>;
    for (const x of xRows) {
      if (!topSet.has(x.ts_code)) continue;
      const fac = 1 + ((x.songzhuangu ?? 0) + (x.peigu ?? 0)) / 10;
      if (fac > 1 + 1e-6) {
        let arr = splitMap.get(x.ts_code);
        if (!arr) { arr = []; splitMap.set(x.ts_code, arr); }
        arr.push({ ex_date: x.ex_date, fac });
      }
    }
  }

  const dailyBasicMap = new Map<string, { pb: number | null; dv_ttm: number | null }>();
  if (tableExists(db, 'daily_basic')) {
    const dbRows = db.prepare('SELECT ts_code, pb, dv_ttm FROM daily_basic WHERE trade_date = ?')
      .all(asOf) as Array<{ ts_code: string; pb: number | null; dv_ttm: number | null }>;
    for (const r of dbRows) dailyBasicMap.set(r.ts_code, { pb: r.pb, dv_ttm: r.dv_ttm });
  }

  const epList: number[] = [];
  const bpList: number[] = [];
  const ediList: number[] = [];
  const dvCandidates: Array<{ code: string; dvBps: number }> = [];

  for (const item of top800) {
    const close = closeMap.get(item.ts_code)!;
    const byEnd = finaByCode.get(item.ts_code);
    if (byEnd && byEnd.size > 0) {
      const sortedEnds = [...byEnd.keys()].sort((a, b) => b.localeCompare(a));
      const latest = byEnd.get(sortedEnds[0])!;
      const mmdd = latest.end_date.slice(4, 8);
      const year = Number(latest.end_date.slice(0, 4));
      let epsTtm: number | null = null;
      if (latest.eps !== null && Number.isFinite(latest.eps)) {
        if (mmdd === '1231') {
          epsTtm = latest.eps;
        } else {
          const pa = byEnd.get(`${year - 1}1231`);
          const ps = byEnd.get(`${year - 1}${mmdd}`);
          if (pa?.eps != null && ps?.eps != null && Number.isFinite(pa.eps) && Number.isFinite(ps.eps)) {
            epsTtm = latest.eps + pa.eps - ps.eps;
          } else if (pa?.eps != null && Number.isFinite(pa.eps)) {
            epsTtm = pa.eps;
          } else {
            const qIdx = mmdd === '0331' ? 1 : mmdd === '0630' ? 2 : mmdd === '0930' ? 3 : 4;
            epsTtm = latest.eps * (4 / qIdx);
          }
        }
      }

      let relSplit = 1;
      for (const sp of splitMap.get(item.ts_code) ?? []) {
        if (sp.ex_date > latest.end_date && sp.ex_date <= asOf) relSplit *= sp.fac;
      }

      if (epsTtm !== null && Number.isFinite(epsTtm)) {
        epList.push(((epsTtm / relSplit) / close) * 10000);
      }
      if (latest.bps !== null && Number.isFinite(latest.bps) && latest.bps > 0) {
        bpList.push(((latest.bps / relSplit) / close) * 10000);
      } else {
        const pb = dailyBasicMap.get(item.ts_code)?.pb;
        if (pb !== null && pb !== undefined && Number.isFinite(pb) && pb > 0) {
          bpList.push((1 / pb) * 10000);
        }
      }

      if (sortedEnds.length >= 2) {
        const prev = byEnd.get(sortedEnds[1])!;
        if (latest.dt_netprofit_yoy != null && prev.dt_netprofit_yoy != null) {
          ediList.push(latest.dt_netprofit_yoy > prev.dt_netprofit_yoy ? 1 : 0);
        } else if (latest.roe_dt != null && prev.roe_dt != null) {
          ediList.push(latest.roe_dt > prev.roe_dt ? 1 : 0);
        }
      }
    } else {
      const pb = dailyBasicMap.get(item.ts_code)?.pb;
      if (pb !== null && pb !== undefined && Number.isFinite(pb) && pb > 0) {
        bpList.push((1 / pb) * 10000);
      }
    }

    const dvTtm = dailyBasicMap.get(item.ts_code)?.dv_ttm;
    if (dvTtm !== null && dvTtm !== undefined && Number.isFinite(dvTtm) && dvTtm > 0) {
      dvCandidates.push({ code: item.ts_code, dvBps: dvTtm * 100 });
    }
  }

  const epMed = median(epList);
  const bpMed = median(bpList);
  const ediBps = ediList.length > 0 ? (ediList.reduce((s, v) => s + v, 0) / ediList.length) * 10000 : null;

  // 低波红利中位数：60日收益波动率后 30%
  let dvLowvolBps: number | null = null;
  if (dvCandidates.length >= 20 && recentDates.length >= 21) {
    const start60 = recentDates[Math.max(0, recentDates.length - 61)];
    const dvSet = new Set(dvCandidates.map(d => d.code));
    const closeSeries = new Map<string, number[]>();
    const barRows = db.prepare(`
      SELECT ts_code, close FROM daily
      WHERE trade_date BETWEEN ? AND ? AND close > 0
      ORDER BY ts_code ASC, trade_date ASC
    `).all(start60, asOf) as Array<{ ts_code: string; close: number }>;
    for (const br of barRows) {
      if (!dvSet.has(br.ts_code)) continue;
      let arr = closeSeries.get(br.ts_code);
      if (!arr) { arr = []; closeSeries.set(br.ts_code, arr); }
      arr.push(Number(br.close));
    }
    const volPairs: Array<{ dvBps: number; vol: number }> = [];
    for (const d of dvCandidates) {
      const cs = closeSeries.get(d.code);
      if (!cs || cs.length < 21) continue;
      const rets: number[] = [];
      for (let i = 1; i < cs.length; i += 1) {
        if (cs[i - 1] > 0) rets.push(cs[i] / cs[i - 1] - 1);
      }
      const s = stddev(rets);
      if (s !== null && Number.isFinite(s)) volPairs.push({ dvBps: d.dvBps, vol: s });
    }
    if (volPairs.length >= 20) {
      const thresh = percentile30(volPairs.map(v => v.vol));
      if (thresh !== null) {
        dvLowvolBps = median(volPairs.filter(v => v.vol <= thresh).map(v => v.dvBps));
      }
    }
  }

  const macroRow = tableExists(db, 'macro_yield_curve')
    ? (db.prepare(`
        SELECT trade_date, cgb_10y_bps
        FROM macro_yield_curve
        WHERE trade_date <= ? AND cgb_10y_bps IS NOT NULL
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(asOf) as { trade_date: string; cgb_10y_bps: number } | undefined)
    : undefined;
  const macroValid = macroRow && countTradeDaysGap(db, macroRow.trade_date, asOf) <= 5 ? macroRow : null;
  const erpBps = epMed !== null && macroValid ? epMed - macroValid.cgb_10y_bps : null;

  if (epMed === null || bpMed === null || erpBps === null) {
    return carryForward(`${asOf} 截面估值或 10Y 国债收益率缺失`);
  }

  const histRows = db.prepare(`
    SELECT erp_bps, bp_median_bps
    FROM market_fundamental_daily
    WHERE trade_date < ?
    ORDER BY trade_date DESC
    LIMIT 755
  `).all(asOf) as Array<{ erp_bps: number | null; bp_median_bps: number | null }>;
  histRows.reverse();

  const erpPct756 = causalEmpiricalPercentile(
    histRows.map(r => r.erp_bps).filter((v): v is number => v !== null && Number.isFinite(v)),
    erpBps,
  );
  const bpPct756 = causalEmpiricalPercentile(
    histRows.map(r => r.bp_median_bps).filter((v): v is number => v !== null && Number.isFinite(v)),
    bpMed,
  );

  inTransaction(db, () => {
    db.prepare(`
      INSERT OR REPLACE INTO market_fundamental_daily (
        trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(asOf, epMed, bpMed, dvLowvolBps, erpBps, erpPct756, bpPct756, ediBps);
    logSync(db, 'market_fundamental_daily', asOf, 1, 'ok', '', {
      refresh_status: 'REFRESH_OK',
      write_mode: 'merged',
    });
  });

  return {
    trade_date: asOf,
    status: 'ok',
    ep_median_bps: epMed,
    bp_median_bps: bpMed,
    dv_lowvol_bps: dvLowvolBps,
    erp_bps: erpBps,
    erp_pct_756: erpPct756,
    bp_pct_756: bpPct756,
    edi_bps: ediBps,
  };
}
