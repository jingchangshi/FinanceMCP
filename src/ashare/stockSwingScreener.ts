import type { DatabaseSync } from 'node:sqlite';
import { inferBoard } from '../portfolio/rules.js';
import { loadApprovedV3Policy, type ApprovedV3Policy } from '../portfolio/v3Policy.js';
import { scanMarket } from './analysis.js';
import { addDays, recentTradeDays } from './ingest.js';
import { annualizeQuarterMultiplier, evaluateQualityCoreV2 } from './qualityCore.js';
import { rpsFromCloses } from './rps.js';

export const STOCK_SWING_SCREENER_SCHEMA = 'ashare-v3-stock-swing/1.0';

const FINANCIAL_INDUSTRIES = new Set(['银行', '证券', '保险', '多元金融']);

const r2 = (v: number): number => Math.round(v * 100) / 100;
const isSt = (name: string): boolean => /ST|退/i.test(name ?? '');

export interface StockSwingCandidate {
  ts_code: string;
  name: string;
  industry: string;
  trade_date: string;
  setup: 'BP1_PULLBACK';
  setup_label_zh: string;
  close_cny: number;
  entry_ref_price_cny: number;
  entry_ref_price_milli: number;
  max_chase_price_cny: number;
  hard_stop_price_cny: number;
  hard_stop_price_milli: number;
  stop_loss_pct: number;
  ma20_cny: number;
  low_5d_cny: number;
  rps60: number | null;
  rps120: number | null;
  rps_best: number;
  industry_rank: number | null;
  industry_total: number;
  amount20_yi: number;
  circ_mv_yi: number;
  roe_annualized_pct: number;
  roe_dt_annualized_pct?: number | null;
  eps: number;
  bps?: number | null;
  ocf_to_profit_pct: number;
  quality_core_version?: 'v1' | 'v2';
  composite_score: number;
  reasons_zh: string[];
  trailing_exit_rule_zh: string;
}

export interface StockSwingScreenResult {
  schema: typeof STOCK_SWING_SCREENER_SCHEMA;
  as_of_trade_date: string;
  policy_version: string;
  policy_content_hash: string;
  bp1_pullback_enabled: true;
  bp2_breakout_enabled: false;
  bp2_status: 'DROPPED_NEGATIVE_OOS';
  scanned_stocks: number;
  qualified_count: number;
  candidates: StockSwingCandidate[];
}

export interface ScreenStockSwingOptions {
  maxCandidates?: number;
  priceCapCny?: number;
  minAmount20Yi?: number;
  minCircMvYi?: number;
  minRps?: number;
  requireIndustryTop30?: boolean;
  /** When true, zero sector buckets fail closed; default skips sector ranking only when <5 stocks exist in every industry. */
  strictSectorGate?: boolean;
  /** 调用方已加载的策略（与 router/engine 共用），避免重复读取覆盖文件/准入库。 */
  policy?: ApprovedV3Policy;
  /** 显式指定 QualityCore 版本（v3.4.0 默认 v2，v3.1.0..v3.3.1 默认 v1）。 */
  qualityCoreVersion?: 'v1' | 'v2';
}

interface PreQualifiedStock {
  ts_code: string;
  name: string;
  industry: string;
  trade_date: string;
  close_cny: number;
  ma20_cny: number;
  low_5d_cny: number;
  amount20_yi: number;
  circ_mv_yi: number;
  roe_annualized_pct: number;
  roe_dt_annualized_pct: number | null;
  eps: number;
  bps: number | null;
  ocf_to_profit_pct: number;
}

/**
 * Screen CN A-share mainboard stocks for Phase-2 validated BP1_PULLBACK entries.
 * Reuses scanMarket (single full-market bar pass) and rpsFromCloses (no duplicate table scan).
 * BP2_BREAKOUT is permanently disabled per EXP-V3-02 negative OOS expectancy.
 */
export function screenStockSwingCandidates(
  db: DatabaseSync | null | undefined,
  asOf: string,
  options: ScreenStockSwingOptions = {},
): StockSwingScreenResult {
  const policy = options.policy ?? loadApprovedV3Policy({ asOf });
  const qcVersion: 'v1' | 'v2' = options.qualityCoreVersion ?? (policy.quality_core_version === 'v2' ? 'v2' : 'v1');
  const maxCandidates = options.maxCandidates ?? policy.stock_max_positions;
  const priceCapCny = options.priceCapCny ?? policy.stock_price_cap_cny;
  const minAmount20Yi = options.minAmount20Yi ?? 1.5;
  const minCircMvYi = options.minCircMvYi ?? 50;
  const minRps = options.minRps ?? 80;
  // 默认不强制行业前 30%：EXP-V3-02 OOS 证据（OOS_100K_BP1_QC 净 +2.329%，ind30=False）
  // 优于行业过滤版（OOS_100K_QC_IND30_SENS 净 -0.131%），与 TactiCore
  // research/ashare/experiments/exp_v3_02_stock_swing_rqalpha.py 的默认值保持一致。
  const requireIndustryTop30 = options.requireIndustryTop30 ?? false;

  if (!db) {
    return {
      schema: STOCK_SWING_SCREENER_SCHEMA,
      as_of_trade_date: asOf,
      policy_version: policy.version,
      policy_content_hash: policy.content_hash,
      bp1_pullback_enabled: true,
      bp2_breakout_enabled: false,
      bp2_status: 'DROPPED_NEGATIVE_OOS',
      scanned_stocks: 0,
      qualified_count: 0,
      candidates: [],
    };
  }

  const requiredTables = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sqlite_master
    WHERE type = 'table' AND name IN ('trade_cal', 'stock_basic', 'daily', 'daily_basic', 'fina_indicator')
  `).get() as { cnt: number };
  if (Number(requiredTables?.cnt ?? 0) < 5) {
    return {
      schema: STOCK_SWING_SCREENER_SCHEMA,
      as_of_trade_date: asOf,
      policy_version: policy.version,
      policy_content_hash: policy.content_hash,
      bp1_pullback_enabled: true,
      bp2_breakout_enabled: false,
      bp2_status: 'DROPPED_NEGATIVE_OOS',
      scanned_stocks: 0,
      qualified_count: 0,
      candidates: [],
    };
  }

  const tradeDays = recentTradeDays(db, asOf, 260);
  if (!tradeDays.includes(asOf)) {
    return {
      schema: STOCK_SWING_SCREENER_SCHEMA,
      as_of_trade_date: asOf,
      policy_version: policy.version,
      policy_content_hash: policy.content_hash,
      bp1_pullback_enabled: true,
      bp2_breakout_enabled: false,
      bp2_status: 'DROPPED_NEGATIVE_OOS',
      scanned_stocks: 0,
      qualified_count: 0,
      candidates: [],
    };
  }

  const basicExtra = new Map<string, { list_status: string | null; list_date: string | null }>();
  try {
    const basicRows = db.prepare('SELECT ts_code, list_status, list_date FROM stock_basic').all() as Array<{
      ts_code: string;
      list_status: string | null;
      list_date: string | null;
    }>;
    for (const b of basicRows) {
      basicExtra.set(b.ts_code, { list_status: b.list_status ?? null, list_date: b.list_date ?? null });
    }
  } catch {
    // Minimal test schemas may omit list_status; fall back gracefully.
  }

  const minListDate = addDays(asOf, -250);
  const rpsCloses = new Map<string, number[]>();
  const preQualified: PreQualifiedStock[] = [];

  const scan = scanMarket(db, asOf, {
    // The stock-swing strategy follows the TactiCore experiment's PIT rule (latest announcement
    // on or before asOf); the public financialsAsOf default stays period-first.
    fundamentals_order: 'announcement-first',
    onStock: (code, bars, x, i, row) => {
      const adjMissing = bars.adjMissing ?? 0;
      if (adjMissing > 0) return;

      // Feed cross-sectional RPS map over all active stocks with clean qfq bars on asOf.
      rpsCloses.set(
        code,
        bars.close.map((v, idx) => (Number.isFinite(bars.rawClose[idx]) ? v : NaN)),
      );

      // 1. Mainboard only (excludes ChiNext 300/301, STAR 688/689, BSE 8/4/920).
      if (inferBoard(code) !== 'main') return;
      const meta = basicExtra.get(code);
      if (meta?.list_status && meta.list_status !== 'L') return;
      if (!meta?.list_date || meta.list_date > minListDate) return;
      if (isSt(row.name)) return;

      // 2. Sufficient history, active trading, non-limit-locked bar.
      if (i < 129 || bars.dates[i] !== asOf) return;
      if (!(bars.vol[i] > 0) || !(bars.amount[i] > 0)) return;
      const rawCloseT = bars.rawClose[i];
      const rawOpenT = bars.rawOpen[i];
      const rawHighT = bars.rawHigh?.[i] ?? NaN;
      const rawLowT = bars.rawLow?.[i] ?? NaN;
      if (!Number.isFinite(rawCloseT) || !Number.isFinite(rawOpenT)) return;
      if (!Number.isFinite(rawHighT) || !Number.isFinite(rawLowT) || rawHighT <= rawLowT) return;
      if (Number.isFinite(bars.upLimit[i]) && rawCloseT >= bars.upLimit[i] - 1e-4) return;
      if (bars.downLimit && Number.isFinite(bars.downLimit[i]) && rawCloseT <= bars.downLimit[i] + 1e-4) return;

      // 3. 100k small-capital affordability & liquidity gates.
      if (!(rawCloseT > 0 && rawCloseT <= priceCapCny)) return;
      if (!(row.amount20_yi >= minAmount20Yi)) return;
      if (row.circ_mv_yi === null || !(row.circ_mv_yi >= minCircMvYi)) return;

      // 4. Point-in-time QualityCore (ann_date <= asOf already enforced by scanMarket).
      const f = row.fundamentals;
      if (!f) return;
      const mult = annualizeQuarterMultiplier(f.end_date);
      const roeAnn = f.roe != null && Number.isFinite(f.roe) ? f.roe * mult : NaN;
      const epsVal = f.eps != null && Number.isFinite(f.eps) ? f.eps : NaN;
      const ocfPct = f.ocf_to_profit != null && Number.isFinite(f.ocf_to_profit) ? f.ocf_to_profit : NaN;
      const bpsVal = f.bps != null && Number.isFinite(f.bps) ? f.bps : null;
      let roeDtAnn: number | null = f.roe_dt != null && Number.isFinite(f.roe_dt) ? f.roe_dt * mult : null;
      if (qcVersion === 'v2') {
        const v2 = evaluateQualityCoreV2(
          { end_date: f.end_date, ann_date: f.ann_date, roe_dt: f.roe_dt, eps: f.eps, ocf_to_profit: f.ocf_to_profit, bps: f.bps },
          asOf,
        );
        if (!v2.passed) return;
        roeDtAnn = v2.roe_dt_annualized;
      } else {
        if (!(roeAnn > 5.0) || !(epsVal > 0) || !(ocfPct > 50.0)) return;
      }
      if (row.eligible === false && row.ineligible_reason === '最近已披露财报亏损') return;
      if (!FINANCIAL_INDUSTRIES.has(row.industry) && f.debt_to_assets != null && f.debt_to_assets > 80) return;

      // 5. Trend & Anti-Chase filters.
      const closeT = bars.close[i];
      const ma5T = x.ma5[i];
      const ma20T = x.ma20[i];
      const ma60T = x.ma60[i];
      const ma20Prev5 = x.ma20[i - 5];
      const ma60Prev5 = x.ma60[i - 5];
      const closePrev5 = bars.close[i - 5];
      const rsi14T = x.rsi14[i];
      if (
        !Number.isFinite(closeT) || !Number.isFinite(ma5T) || !Number.isFinite(ma20T) || !Number.isFinite(ma60T)
        || !Number.isFinite(ma20Prev5) || !Number.isFinite(ma60Prev5) || !(closePrev5 > 0) || !Number.isFinite(rsi14T)
      ) {
        return;
      }
      if (!(closeT > ma20T && ma20T > ma60T && ma20T > ma20Prev5 && ma60T > ma60Prev5)) return;

      const ret5 = closeT / closePrev5 - 1;
      const distMa20 = (closeT - ma20T) / ma20T;
      if (!(ret5 < 0.12 && distMa20 <= 0.08 && rsi14T < 75)) return;

      // 6. BP1_PULLBACK ONLY: prior 20d high within k=3..8 bars, 5d low near MA20, volume contraction, today bullish reclaim.
      let hasPriorHigh = false;
      for (let k = 3; k <= 8; k += 1) {
        const p = i - k;
        if (p >= 19 && Number.isFinite(x.high20[p]) && bars.high[p] >= x.high20[p] - 1e-9 && bars.high[p] > closeT) {
          hasPriorHigh = true;
          break;
        }
      }
      if (!hasPriorHigh) return;

      let low5Qfq = Infinity;
      let low5Raw = Infinity;
      for (let j = i - 4; j <= i; j += 1) {
        if (bars.low[j] < low5Qfq) low5Qfq = bars.low[j];
        const rawL = bars.rawLow?.[j];
        if (rawL !== undefined && Number.isFinite(rawL) && rawL < low5Raw) low5Raw = rawL;
      }
      if (!(low5Qfq >= ma20T * 0.985 && low5Qfq <= ma20T * 1.025)) return;

      const volMa20T = x.volMa20[i];
      const minPullbackVol = Math.min(bars.vol[i - 3], bars.vol[i - 2], bars.vol[i - 1]);
      if (!(volMa20T > 0 && minPullbackVol <= 0.8 * volMa20T)) return;

      if (!(rawCloseT > rawOpenT && closeT > bars.close[i - 1] && closeT > ma5T && closeT > ma20T)) return;

      const scaleToRaw = closeT > 0 ? rawCloseT / closeT : 1;
      const ma20Raw = ma20T * scaleToRaw;
      const safeLow5Raw = Number.isFinite(low5Raw) ? low5Raw : low5Qfq * scaleToRaw;

      preQualified.push({
        ts_code: code,
        name: row.name,
        industry: row.industry,
        trade_date: asOf,
        close_cny: r2(rawCloseT),
        ma20_cny: r2(ma20Raw),
        low_5d_cny: r2(safeLow5Raw),
        amount20_yi: r2(row.amount20_yi),
        circ_mv_yi: r2(row.circ_mv_yi),
        roe_annualized_pct: r2(Number.isFinite(roeAnn) ? roeAnn : (roeDtAnn ?? 0)),
        roe_dt_annualized_pct: roeDtAnn !== null ? r2(roeDtAnn) : null,
        eps: r2(epsVal),
        bps: bpsVal !== null ? r2(bpsVal) : null,
        ocf_to_profit_pct: r2(ocfPct),
      });
    },
  });

  if (preQualified.length === 0) {
    return {
      schema: STOCK_SWING_SCREENER_SCHEMA,
      as_of_trade_date: asOf,
      policy_version: policy.version,
      policy_content_hash: policy.content_hash,
      bp1_pullback_enabled: true,
      bp2_breakout_enabled: false,
      bp2_status: 'DROPPED_NEGATIVE_OOS',
      scanned_stocks: scan.rows.length,
      qualified_count: 0,
      candidates: [],
    };
  }

  const rpsResult = rpsFromCloses(rpsCloses);
  const sectorCount = scan.sectors.length;
  const maxAllowedSectorRank = sectorCount > 0 ? Math.max(1, Math.ceil(sectorCount * 0.30)) : 0;
  const sectorRankMap = new Map(scan.sectors.map(s => [s.industry, s.rank]));

  const qualified: StockSwingCandidate[] = [];
  for (const item of preQualified) {
    const rpsRow = rpsResult.rows.get(item.ts_code);
    const rps60 = rpsRow?.rps[60] ?? null;
    const rps120 = rpsRow?.rps[120] ?? null;
    const rpsBest = Math.max(rps60 ?? -1, rps120 ?? -1);
    if (!(rpsBest >= minRps)) continue;

    const secRank = sectorRankMap.get(item.industry) ?? null;
    if (requireIndustryTop30) {
      if (sectorCount === 0) {
        if (options.strictSectorGate) continue;
      } else if (secRank === null || secRank > maxAllowedSectorRank) {
        continue;
      }
    }

    const entryRef = item.close_cny;
    const entryRefMilli = Math.round(entryRef * 1000);
    const maxChase = r2(entryRef * 1.02);
    const techStop = r2(Math.min(item.low_5d_cny, item.ma20_cny * 0.97));
    const maxLossStop = r2(entryRef * 0.92);
    let hardStop = Math.max(maxLossStop, techStop);
    if (hardStop >= entryRef * 0.99) hardStop = r2(entryRef * 0.96);
    const hardStopMilli = Math.round(hardStop * 1000);
    const stopLossPct = r2(((hardStop - entryRef) / entryRef) * 100);

    const sectorBonus = sectorCount > 0 && secRank !== null ? (1 - (secRank - 1) / sectorCount) * 10 : 5;
    const compositeScore = r2(rpsBest * 0.7 + Math.min(20, item.roe_annualized_pct) * 0.8 + sectorBonus);

    qualified.push({
      ts_code: item.ts_code,
      name: item.name,
      industry: item.industry,
      trade_date: item.trade_date,
      setup: 'BP1_PULLBACK',
      setup_label_zh: '强势股缩量低于 20 日均值回踩 20 日线企稳',
      close_cny: item.close_cny,
      entry_ref_price_cny: entryRef,
      entry_ref_price_milli: entryRefMilli,
      max_chase_price_cny: maxChase,
      hard_stop_price_cny: hardStop,
      hard_stop_price_milli: hardStopMilli,
      stop_loss_pct: stopLossPct,
      ma20_cny: item.ma20_cny,
      low_5d_cny: item.low_5d_cny,
      rps60: rps60 !== null ? r2(rps60) : null,
      rps120: rps120 !== null ? r2(rps120) : null,
      rps_best: r2(rpsBest),
      industry_rank: secRank,
      industry_total: sectorCount,
      amount20_yi: item.amount20_yi,
      circ_mv_yi: item.circ_mv_yi,
      roe_annualized_pct: item.roe_annualized_pct,
      roe_dt_annualized_pct: item.roe_dt_annualized_pct,
      eps: item.eps,
      bps: item.bps,
      ocf_to_profit_pct: item.ocf_to_profit_pct,
      quality_core_version: qcVersion,
      composite_score: compositeScore,
      reasons_zh: [
        `相对强度百分位达 ${r2(rpsBest).toFixed(1)}${secRank !== null ? `，所属行业「${item.industry}」排名第 ${secRank}/${sectorCount} 位（前 30%）` : ''}`,
        `均线多头向上且近 3 日缩量（低于成交量 20 日均值的 0.8 倍）回踩 20 日均线（${item.ma20_cny.toFixed(2)} 元）企稳收阳`,
        `基本面合格：年化净资产收益率 ${item.roe_annualized_pct.toFixed(1)}%，现金流占净利比 ${item.ocf_to_profit_pct.toFixed(1)}%`,
      ],
      trailing_exit_rule_zh: '跌破硬止损价无条件清仓；浮盈满 +15% 后上移至成本保本；收盘跌破 20 日均线无条件离场。',
    });
  }

  qualified.sort((a, b) => b.composite_score - a.composite_score || a.ts_code.localeCompare(b.ts_code));

  return {
    schema: STOCK_SWING_SCREENER_SCHEMA,
    as_of_trade_date: asOf,
    policy_version: policy.version,
    policy_content_hash: policy.content_hash,
    bp1_pullback_enabled: true,
    bp2_breakout_enabled: false,
    bp2_status: 'DROPPED_NEGATIVE_OOS',
    scanned_stocks: scan.rows.length,
    qualified_count: qualified.length,
    candidates: qualified.slice(0, Math.max(0, maxCandidates)),
  };
}
