import type { DatabaseSync } from 'node:sqlite';
import { recentTradeDays } from './ingest.js';
import { forEachStockBars } from './bars.js';
import { percentileRank, computeRps } from './rps.js';
import { ensureHotspotSchema, hotspotCoverage, hotspotTableExists } from './hotspotTables.js';
import { activeSwMembers, swMemberIndex } from './industryClassification.js';
import type {
  HotspotFactor, HotspotSector, HotspotSectorSnapshot, IndustryState,
  DataQuality, CoverageSummary,
} from './hotspotTypes.js';
import { HOTSPOT_CONFIG_VERSION } from './hotspotTypes.js';

/**
 * Hotspot industry identification (goal-1028 §P2, architecture.md §5.1).
 * Pre-registered factor set `hotspot-config-1.0.0` — 13 sub-factors mapped to
 * the 10 documented groups. All factors are cross-sectionally percentile-
 * ranked (0..1, higher = stronger unless the factor is inverted); the
 * composite strength is the weight-normalized mean over AVAILABLE factors
 * (null factors are dropped and weights renormalized — a missing factor never
 * silently scores zero).
 *
 * Time semantics: every factor at date d reads only rows with trade_date ≤ d.
 * Rank history (5d/20d ago) is computed from the index-only factor subset at
 * those dates (member metrics exist only for the as-of pass — recomputing
 * full-market member history per historical date is out of scope for v1 and
 * is recorded as a documented approximation, not a hidden one).
 */

export interface HotspotConfig {
  /** Composite factor weights; renormalized over available factors per sector. */
  weights: Record<string, number>;
  /** Leading band width for LEADING / WEAKENING "still ahead" tests. */
  topK: number;
  /** Rank must improve by at least this many places over 5 days for EMERGING. */
  emergingRankImprove: number;
  /** Rank must drop by at least this many places over 5 days for WEAKENING. */
  weakeningRankDrop: number;
  /** WEAKENING requires the sector to still be inside this (wider) band. */
  weakeningTopBand: number;
  /** Selected hotspot capacity bounds (capacity, not a quota). */
  capacityMin: number;
  capacityMax: number;
  /** Minimum index bars before a sector may leave UNKNOWN. */
  minIndexBars: number;
  /** Member-pool minimum before breadth/MA/RPS factors are trusted. */
  minMembers: number;
}

export const DEFAULT_HOTSPOT_CONFIG: HotspotConfig = {
  weights: {
    ret_5: 0.08, ret_20: 0.10, ret_60: 0.06,
    excess_20: 0.12, excess_60: 0.06, risk_adj_20: 0.10,
    amount_trend: 0.08, breadth: 0.12,
    above_ma20_ratio: 0.07, above_ma60_ratio: 0.04, rps80_density: 0.10,
    excess_streak: 0.04, vol_dd: 0.03,
  },
  topK: 10,
  emergingRankImprove: 8,
  weakeningRankDrop: 5,
  weakeningTopBand: 15,
  capacityMin: 5,
  capacityMax: 8,
  minIndexBars: 25,
  minMembers: 10,
};

export const RANK_LOOKBACK_5D = 5;
export const RANK_LOOKBACK_20D = 20;
const INDEX_ONLY_FACTORS = new Set([
  'ret_5', 'ret_20', 'ret_60', 'excess_20', 'excess_60', 'risk_adj_20',
  'amount_trend', 'excess_streak', 'vol_dd',
]);
export const CSI300_CODE = '000300.SH';

// ---------------------------------------------------------------- index panel

interface IndexBar { date: string; close: number; amount: number; pctChg: number; }

function loadIndexBars(db: DatabaseSync, table: 'sw_index_daily' | 'ths_index_daily' | 'index_daily',
  tsCode: string, asOf: string, count: number): IndexBar[] {
  if (!hotspotTableExists(db, table) && table !== 'index_daily') return [];
  const pctCol = table === 'index_daily' ? 'pct_chg' : 'pct_change';
  // Upstream THS `ths_daily` has no turnover-amount field (see THS_DAILY_FIELDS,
  // docs/tushare-interface-coverage.md). Select NULL instead of a column that
  // does not exist: amount_trend then evaluates to null and the composite
  // weight renormalizes over the available factors — the factor is honestly
  // unavailable for THS-sourced sectors, never fabricated from another metric.
  const amountCol = table === 'ths_index_daily' ? 'NULL AS amount' : 'amount';
  const sql = `SELECT trade_date, close, ${amountCol}, ${pctCol} pct FROM ${table}
    WHERE ts_code = ? AND trade_date <= ? AND close IS NOT NULL
    ORDER BY trade_date DESC LIMIT ?`;
  const rows = db.prepare(sql).all(tsCode, asOf, count) as Array<{ trade_date: string; close: number; amount: number; pct: number | null }>;
  return rows.reverse().map(r => ({ date: r.trade_date, close: r.close, amount: r.amount ?? 0, pctChg: r.pct ?? 0 }));
}

function ret(bars: IndexBar[], endIdx: number, window: number): number | null {
  if (endIdx < window || !Number.isFinite(bars[endIdx].close) || !Number.isFinite(bars[endIdx - window].close)) return null;
  const base = bars[endIdx - window].close;
  return base === 0 ? null : bars[endIdx].close / base - 1;
}

function std(values: number[]): number | null {
  const v = values.filter(Number.isFinite);
  if (v.length < 6) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
}

/** Index-only factor raw values at date index `i` of the panel (reads ≤ i). */
function indexFactors(bars: IndexBar[], csi: IndexBar[], i: number): Record<string, number | null> {
  const csiIdxAlign = (d: string): number => { // csi panel index of the same date
    let lo = 0, hi = csi.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (csi[m].date <= d) { best = m; lo = m + 1; } else hi = m - 1; }
    return best;
  };
  const j = csiIdxAlign(bars[i].date);
  const excess = (window: number): number | null => {
    const a = ret(bars, i, window);
    const b = j >= window ? ret(csi, j, window) : null;
    return a !== null && b !== null ? a - b : null;
  };
  const r20 = ret(bars, i, 20);
  let streak = 0;
  for (let k = i; k >= 1; k--) {
    const jj = csiIdxAlign(bars[k].date);
    if (jj < 1) break;
    const a = bars[k].pctChg, b = csi[jj].pctChg;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a - b <= 0) break;
    streak++;
  }
  const dd = (() => {
    if (i < 59) return null;
    let hi = -Infinity;
    for (let k = i - 59; k <= i; k++) if (bars[k].close > hi) hi = bars[k].close;
    return Number.isFinite(hi) && hi > 0 ? bars[i].close / hi - 1 : null;
  })();
  const rets20: number[] = [];
  for (let k = Math.max(1, i - 19); k <= i; k++) if (Number.isFinite(bars[k].pctChg)) rets20.push(bars[k].pctChg / 100);
  const sd20 = std(rets20);
  return {
    ret_5: ret(bars, i, 5),
    ret_20: r20,
    ret_60: ret(bars, i, 60),
    excess_20: excess(20),
    excess_60: excess(60),
    risk_adj_20: r20 !== null && sd20 !== null && sd20 > 0 ? r20 / sd20 : null,
    amount_trend: (() => {
      if (i < 24) return null;
      let recent = 0, prior = 0;
      for (let k = i - 4; k <= i; k++) recent += bars[k].amount;
      for (let k = i - 24; k <= i - 5; k++) prior += bars[k].amount;
      return prior > 0 ? recent / 5 / (prior / 20) - 1 : null;
    })(),
    excess_streak: streak,
    vol_dd: dd, // inverted below: closer to 0 is better
  };
}

// ---------------------------------------------------------------- member metrics

interface MemberMetrics {
  /** ts_code → { pctUp (as-of day breadth), above20, above60 } */
  perStock: Map<string, { pctUp: boolean; above20: boolean; above60: boolean }>;
  rps80: Set<string>;
  quality: DataQuality;
  members: number;
}

function loadMemberMetrics(db: DatabaseSync, asOf: string, tradeDays: string[]): MemberMetrics {
  const empty: MemberMetrics = { perStock: new Map(), rps80: new Set(), quality: 'UNAVAILABLE', members: 0 };
  if (!hotspotTableExists(db, 'sw_member') || !hotspotTableExists(db, 'sw_index_daily')) return empty;
  const rows = db.prepare('SELECT ts_code, l1_code, l2_code, l3_code, name, in_date, out_date, is_new FROM sw_member').all() as any[];
  if (rows.length === 0) return empty;
  const members = activeSwMembers(rows, asOf);
  if (members.length === 0) return { ...empty, quality: 'DEGRADED', members: 0 };
  const uniqueMembers = new Set(members.map(m => m.ts_code));

  // RPS over the full stock_basic universe (cross-section needs the market).
  const rpsStart = tradeDays[Math.max(0, tradeDays.length - 260)];
  const rps = computeRps(db, rpsStart, asOf);

  // One batched pass per member for MA20/MA60 at asOf (70 bars is enough for MA60).
  const maStart = tradeDays[Math.max(0, tradeDays.length - 70)];
  const memberCodes = [...new Set(members.map(m => m.ts_code))];
  const perStock = new Map<string, { pctUp: boolean; above20: boolean; above60: boolean }>();
  forEachStockBars(db, maStart, asOf, (ts, b) => {
    const n = b.dates.length;
    if (n < 61) return;
    const last = n - 1;
    const sma = (w: number): number => { let s = 0; for (let k = last - w + 1; k <= last; k++) s += b.close[k]; return s / w; };
    const ma20 = sma(20), ma60 = sma(60);
    const pctUp = b.dates.length >= 2 && Number.isFinite(b.close[last]) && Number.isFinite(b.close[last - 1]) && b.close[last - 1] > 0
      ? b.close[last] / b.close[last - 1] - 1 > 0 : false;
    perStock.set(ts, { pctUp, above20: b.close[last] > ma20, above60: b.close[last] > ma60 });
  }, memberCodes);

  const rps80 = new Set<string>();
  for (const ts of uniqueMembers) {
    const row = rps.rows.get(ts);
    if (row && row.rps[120] !== null && row.rps[120] >= 80) rps80.add(ts);
  }
  return { perStock, rps80, quality: 'OK', members: uniqueMembers.size };
}

// ---------------------------------------------------------------- evaluation

interface SectorRow {
  key: string; name: string; source: 'SW2021' | 'THS';
  indexCode: string;
  raw: Record<string, number | null>;
  quality: DataQuality;
  qualityNotes: Array<{ quality: DataQuality; reason: string; detail?: string }>;
  memberAgg: { breadth: number | null; above20: number | null; above60: number | null; rps80Count: number | null } | null;
  rankNow: number | null; rank5: number | null; rank20: number | null;
  strength: number | null;
  barsAvailable: number;
}

function evaluateAt(db: DatabaseSync, asOf: string, tradeDays: string[],
  sectors: Array<{ key: string; name: string; source: 'SW2021' | 'THS'; indexCode: string }>,
  memberMetrics: MemberMetrics | null, cfg: HotspotConfig): SectorRow[] {
  const csi = loadIndexBars(db, 'index_daily', CSI300_CODE, asOf, 70);
  const swRows = hotspotTableExists(db, 'sw_member')
    ? (db.prepare('SELECT ts_code, l1_code, l2_code, l3_code, name, in_date, out_date, is_new FROM sw_member').all() as any[])
    : [];
  const rows: SectorRow[] = [];
  for (const s of sectors) {
    const table = s.source === 'SW2021' ? 'sw_index_daily' : 'ths_index_daily';
    const bars = loadIndexBars(db, table, s.indexCode, asOf, 70);
    const qualityNotes: SectorRow['qualityNotes'] = [];
    let quality: DataQuality = 'OK';
    if (bars.length < cfg.minIndexBars) {
      quality = 'UNAVAILABLE';
      qualityNotes.push({ quality: 'UNAVAILABLE', reason: 'insufficient_index_bars', detail: `${bars.length}<${cfg.minIndexBars}` });
      rows.push({ key: s.key, name: s.name, source: s.source, indexCode: s.indexCode, raw: {}, quality, qualityNotes, memberAgg: null, rankNow: null, rank5: null, rank20: null, strength: null, barsAvailable: bars.length });
      continue;
    }
    const i = bars.length - 1;
    const raw = indexFactors(bars, csi, i);

    // Member aggregates (SW only; THS membership is NO_POINT_IN_TIME).
    let memberAgg: SectorRow['memberAgg'] = null;
    if (s.source === 'SW2021' && memberMetrics && memberMetrics.quality === 'OK') {
      // Deduped by ts_code: one stock with several L3 rows counts once.
      const ms = swMemberIndex(swRows, s.indexCode, asOf);
      if (ms.size >= cfg.minMembers) {
        let up = 0, a20 = 0, a60 = 0, counted = 0;
        for (const ts of ms.keys()) {
          const pm = memberMetrics.perStock.get(ts);
          if (!pm) continue;
          counted++;
          if (pm.pctUp) up++;
          if (pm.above20) a20++;
          if (pm.above60) a60++;
        }
        let rps80 = 0;
        for (const ts of ms.keys()) if (memberMetrics.rps80.has(ts)) rps80++;
        if (counted >= cfg.minMembers) {
          memberAgg = { breadth: up / counted, above20: a20 / counted, above60: a60 / counted, rps80Count: rps80 };
        } else {
          quality = quality === 'OK' ? 'DEGRADED' : quality;
          qualityNotes.push({ quality: 'DEGRADED', reason: 'member_metrics_thin', detail: `${counted}<${cfg.minMembers}` });
        }
      } else {
        quality = quality === 'OK' ? 'DEGRADED' : quality;
        qualityNotes.push({ quality: 'DEGRADED', reason: 'few_members', detail: `${ms.size}<${cfg.minMembers}` });
      }
    } else if (s.source === 'THS') {
      quality = 'NO_POINT_IN_TIME';
      qualityNotes.push({ quality: 'NO_POINT_IN_TIME', reason: 'ths_member_snapshot_only' });
    } else {
      quality = quality === 'OK' ? 'DEGRADED' : quality;
      qualityNotes.push({ quality: 'DEGRADED', reason: 'member_dataset_unavailable' });
    }
    // Member aggregates live in `raw` under their factor ids so
    // standardizeAndRank treats them exactly like index factors.
    if (memberAgg) {
      raw.breadth = memberAgg.breadth;
      raw.above_ma20_ratio = memberAgg.above20;
      raw.above_ma60_ratio = memberAgg.above60;
      raw.rps80_density = memberAgg.rps80Count;
    }
    rows.push({ key: s.key, name: s.name, source: s.source, indexCode: s.indexCode, raw, quality, qualityNotes, memberAgg, rankNow: null, rank5: null, rank20: null, strength: null, barsAvailable: bars.length });
  }
  return rows;
}

/** Cross-sectional percentile (0..1) of each raw factor across `rows`; sets `.strength`. */
function standardizeAndRank(rows: SectorRow[], cfg: HotspotConfig, factorSubset?: Set<string>): void {
  const active = rows.filter(r => r.barsAvailable >= cfg.minIndexBars);
  const factorIds = Object.keys(cfg.weights).filter(id => !factorSubset || factorSubset.has(id));
  for (const id of factorIds) {
    const vals = active.map(r => r.raw[id]).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length < 3) continue;
    const pct = percentileRank(vals);
    let k = 0;
    for (const r of active) {
      const v = r.raw[id];
      if (v !== null && Number.isFinite(v)) (r as any)[`p_${id}`] = pct[k++];
    }
  }
  for (const r of active) {
    let wsum = 0, acc = 0;
    for (const id of factorIds) {
      const p = (r as any)[`p_${id}`] as number | undefined;
      if (p === undefined) continue;
      const w = cfg.weights[id];
      // vol_dd is inverted: drawdown closer to 0 is better.
      acc += w * (id === 'vol_dd' ? 1 - p : p);
      wsum += w;
    }
    r.strength = wsum > 0 ? acc / wsum : null;
  }
  // Ranks by strength (1 = strongest); nulls last.
  const ranked = active.filter(r => r.strength !== null).sort((a, b) => (b.strength! - a.strength!));
  ranked.forEach((r, idx) => { r.rankNow = idx + 1; });
}

function assignHistoricalRanks(db: DatabaseSync, asOf: string, tradeDays: string[],
  sectors: Array<{ key: string; name: string; source: 'SW2021' | 'THS'; indexCode: string }>,
  cfg: HotspotConfig, into: SectorRow[]): void {
  for (const [field, back] of [['rank5', RANK_LOOKBACK_5D], ['rank20', RANK_LOOKBACK_20D]] as const) {
    if (tradeDays.length <= back) continue;
    const pastDate = tradeDays[tradeDays.length - 1 - back];
    const pastRows = evaluateAt(db, pastDate, tradeDays, sectors, null, cfg);
    // Index-only historical composite (member metrics are as-of-only in v1).
    const subsetWeights: Record<string, number> = {};
    for (const id of Object.keys(cfg.weights)) if (INDEX_ONLY_FACTORS.has(id)) subsetWeights[id] = cfg.weights[id];
    standardizeAndRank(pastRows, { ...cfg, weights: subsetWeights });
    for (const r of into) {
      const p = pastRows.find(x => x.key === r.key);
      (r as any)[field] = p ? p.rankNow : null;
    }
  }
}

function industryState(r: SectorRow, cfg: HotspotConfig): { state: IndustryState; reasons: string[] } {
  const reasons: string[] = [];
  if (r.quality === 'UNAVAILABLE' || r.strength === null || r.rankNow === null) {
    return { state: 'UNKNOWN', reasons: ['数据覆盖不足'] };
  }
  const ret5 = r.raw.ret_5;
  const excess20 = r.raw.excess_20;
  const rankDelta5 = r.rank5 !== null ? r.rank5 - r.rankNow : null; // positive = improved
  if (r.rank5 !== null && rankDelta5 !== null
    && rankDelta5 >= cfg.emergingRankImprove && ret5 !== null && ret5 > 0
    && excess20 !== null /* 20d trend context */) {
    // "20 日趋势未破坏": excess_20 positive OR rank still inside top band.
    if (excess20 > 0 || r.rankNow <= cfg.topK) {
      reasons.push(`5日排名上升${rankDelta5}位(≥${cfg.emergingRankImprove})且5日收益转强(${(ret5 * 100).toFixed(1)}%)`);
      return { state: 'EMERGING', reasons };
    }
  }
  if (r.rankNow <= cfg.topK && excess20 !== null && excess20 > 0) {
    const ex60 = r.raw.excess_60;
    if (ex60 !== null && ex60 > 0) {
      reasons.push(`排名${r.rankNow}≤${cfg.topK}且20/60日超额为正`);
      return { state: 'LEADING', reasons };
    }
    reasons.push(`排名${r.rankNow}≤${cfg.topK}且20日超额为正`);
    return { state: 'LEADING', reasons };
  }
  if (r.rank5 !== null && rankDelta5 !== null && rankDelta5 <= -cfg.weakeningRankDrop
    && ret5 !== null && ret5 < 0 && r.rankNow <= cfg.weakeningTopBand) {
    reasons.push(`5日排名下降${-rankDelta5}位(≥${cfg.weakeningRankDrop})且5日收益转负,仍居前${cfg.weakeningTopBand}`);
    return { state: 'WEAKENING', reasons };
  }
  return { state: 'NEUTRAL', reasons };
}

function counterEvidence(r: SectorRow): string[] {
  const out: string[] = [];
  const pct = (v: number | null): string => v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
  if ((r.raw.excess_20 ?? 0) <= 0) out.push(`20日超额为负(${pct(r.raw.excess_20)})`);
  if (r.memberAgg && r.memberAgg.breadth !== null && r.memberAgg.breadth < 0.5) out.push(`上涨广度偏低(${pct(r.memberAgg.breadth)})`);
  if ((r.raw.amount_trend ?? 0) < 0) out.push(`成交额萎缩(${pct(r.raw.amount_trend)})`);
  if (r.rank5 !== null && r.rankNow !== null && r.rankNow > r.rank5) out.push(`5日排名下降(${r.rank5}→${r.rankNow})`);
  if ((r.raw.vol_dd ?? 0) < -0.08) out.push(`60日回撤较深(${pct(r.raw.vol_dd)})`);
  if (r.quality !== 'OK') out.push(`数据质量:${r.quality}`);
  if (out.length === 0) out.push('截面未见显著反证;仍需关注市场整体状态变化');
  return out;
}

export function evaluateHotspotSectors(
  db: DatabaseSync, asOf: string, config: HotspotConfig = DEFAULT_HOTSPOT_CONFIG,
): HotspotSectorSnapshot {
  ensureHotspotSchema(db);
  const tradeDays = recentTradeDays(db, asOf, 70);
  const l1Rows = hotspotTableExists(db, 'sw_classify')
    ? (db.prepare("SELECT index_code, name FROM sw_classify WHERE level = 'L1'").all() as Array<{ index_code: string; name: string }>)
    : [];
  if (l1Rows.length === 0) {
    return {
      as_of: asOf, config_version: HOTSPOT_CONFIG_VERSION, sectors: [], selected: [],
      coverage: hotspotCoverage(db, asOf),
    };
  }
  const swSectors = l1Rows.map(r => ({ key: `SW2021:${r.index_code}`, name: r.name ?? r.index_code, source: 'SW2021' as const, indexCode: r.index_code }));

  // THS themes: concept/industry indexes with usable daily history; capped for scope.
  const thsSectors: Array<{ key: string; name: string; source: 'THS'; indexCode: string }> = [];
  if (hotspotTableExists(db, 'ths_index') && hotspotTableExists(db, 'ths_index_daily')) {
    const ths = db.prepare("SELECT ts_code, name FROM ths_index WHERE idx_type IN ('N','I') ORDER BY count DESC LIMIT 30").all() as Array<{ ts_code: string; name: string }>;
    for (const t of ths) {
      const n = (db.prepare('SELECT COUNT(*) n FROM ths_index_daily WHERE ts_code = ? AND trade_date <= ?').get(t.ts_code, asOf) as { n: number }).n;
      if (n >= config.minIndexBars) thsSectors.push({ key: `THS:${t.ts_code}`, name: t.name ?? t.ts_code, source: 'THS', indexCode: t.ts_code });
    }
  }

  const sectors = [...swSectors, ...thsSectors];
  const memberMetrics = loadMemberMetrics(db, asOf, tradeDays);
  const rows = evaluateAt(db, asOf, tradeDays, sectors, memberMetrics, config);
  standardizeAndRank(rows, config);
  assignHistoricalRanks(db, asOf, tradeDays, swSectors, config, rows);

  // Build output sectors.
  const outSectors: HotspotSector[] = rows.map(r => {
    const { state, reasons } = industryState(r, config);
    const factors: HotspotFactor[] = Object.keys(config.weights).map(id => {
      const rawVal = r.raw[id] ?? null;
      const z = (r as any)[`p_${id}`] as number | undefined;
      return { id, raw: rawVal, z: z ?? null, quality: r.quality };
    });
    return {
      key: r.key, name: r.name,
      kind: r.source === 'SW2021' ? 'SW_INDUSTRY_L1' : (r.name.includes('概念') ? 'THS_CONCEPT' : 'THS_INDUSTRY'),
      source: r.source,
      state,
      rank: r.rankNow, rank_5d_ago: r.rank5, rank_20d_ago: r.rank20,
      strength: r.strength,
      factors,
      entry_reason: reasons.join(';') || (state === 'NEUTRAL' ? '未满足入选状态' : ''),
      counter_evidence: counterEvidence(r),
      data_quality: r.quality,
      quality_notes: r.qualityNotes,
      representative_etfs: [],
    };
  });

  // Selection: strongest eligible, capacity bounds, never pad with UNKNOWN.
  const eligible = outSectors
    .filter(s => s.rank !== null && s.state !== 'UNKNOWN' && s.strength !== null)
    .sort((a, b) => a.rank! - b.rank!);
  const selected = eligible.slice(0, config.capacityMax).map(s => s.key);
  if (selected.length > 0 && selected.length < config.capacityMin) {
    // Allowed: capacity bounds permit shortfall; nothing to do (do not pad).
  }

  const coverage: CoverageSummary[] = [
    ...hotspotCoverage(db, asOf),
    { dataset: 'member_metrics', rows: memberMetrics.members, quality: memberMetrics.quality },
    { dataset: 'csi300_daily', rows: (db.prepare("SELECT COUNT(*) n FROM index_daily WHERE ts_code = ? AND trade_date <= ?").get(CSI300_CODE, asOf) as { n: number }).n, quality: 'OK' },
  ];

  return { as_of: asOf, config_version: HOTSPOT_CONFIG_VERSION, sectors: outSectors, selected, coverage };
}
