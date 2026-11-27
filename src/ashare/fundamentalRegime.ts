import type { DatabaseSync } from 'node:sqlite';

export type FundamentalEnvelopeState = 'EXTREME_UNDERVAL' | 'NEUTRAL' | 'EXTREME_BUBBLE';

export interface FundamentalEnvelopePoint {
  trade_date: string;
  erp_pct_756: number | null;
  bp_pct_756: number | null;
}

export interface FundamentalEnvelopeThresholds {
  erpHighEnter?: number;
  erpHighExit?: number;
  bpHighEnter?: number;
  bpHighExit?: number;
  lowEnter?: number;
  lowExit?: number;
}

export interface FundamentalDailySnapshot {
  trade_date: string;
  ep_median_bps: number | null;
  bp_median_bps: number | null;
  dv_lowvol_bps: number | null;
  erp_bps: number | null;
  erp_pct_756: number | null;
  bp_pct_756: number | null;
  edi_bps: number | null;
}

export interface MacroYieldSnapshot {
  trade_date: string;
  cgb_1y_bps: number | null;
  cgb_10y_bps: number | null;
  term_spread_bps: number | null;
  source: string | null;
}

export interface FundamentalRegimeResult {
  available: boolean;
  as_of_trade_date: string;
  b1_state: FundamentalEnvelopeState;
  b1_state_label_zh: string;
  erp_pct_756: number | null;
  bp_pct_756: number | null;
  erp_bps: number | null;
  ep_median_bps: number | null;
  bp_median_bps: number | null;
  dv_lowvol_bps: number | null;
  edi_bps: number | null;
  cgb_1y_bps: number | null;
  cgb_10y_bps: number | null;
  term_spread_bps: number | null;
  stale_fallback_days: number;
  warning: string | null;
  summary_zh: string;
}

export const B1_STATE_LABELS_ZH: Record<FundamentalEnvelopeState, string> = {
  EXTREME_UNDERVAL: '历史极端低估区间（B1 估值安全垫充足）',
  NEUTRAL: '历史估值中性区间（B1 透传技术档位）',
  EXTREME_BUBBLE: '历史极端泡沫区间（B1 估值过热削顶）',
};

const DEFAULT_THRESHOLDS: Required<FundamentalEnvelopeThresholds> = {
  erpHighEnter: 0.80,
  erpHighExit: 0.75,
  bpHighEnter: 0.70,
  bpHighExit: 0.65,
  lowEnter: 0.15,
  lowExit: 0.20,
};

function tableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * 归一化分位至 [0, 1] 区间：支持 [0, 1] 原生小数与 [0, 100] 百分位（> 1 自动除 100）。
 */
export function normalizePercentile01(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value > 1) return Math.min(1, value / 100);
  if (value < 0) return 0;
  return value;
}

/**
 * 纯函数：按严格因果顺序计算 B1 756d ERP+B/P 双重确认极值包络状态序列（含 5% 滞回带）。
 * 口径与 TactiCore `exp_v3_14_backtest.py` 完全一致。
 */
export function computeB1EnvelopeSeries(
  points: readonly FundamentalEnvelopePoint[],
  thresholds: FundamentalEnvelopeThresholds = {},
): FundamentalEnvelopeState[] {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const out: FundamentalEnvelopeState[] = [];
  let cur: FundamentalEnvelopeState = 'NEUTRAL';

  for (const pt of points) {
    const e = normalizePercentile01(pt.erp_pct_756);
    const b = normalizePercentile01(pt.bp_pct_756);
    if (e === null || b === null) {
      out.push('NEUTRAL');
      continue;
    }
    if (cur === 'EXTREME_UNDERVAL') {
      if (e <= th.lowEnter && b <= th.lowEnter) cur = 'EXTREME_BUBBLE';
      else if (e < th.erpHighExit || b < th.bpHighExit) cur = 'NEUTRAL';
    } else if (cur === 'EXTREME_BUBBLE') {
      if (e >= th.erpHighEnter && b >= th.bpHighEnter) cur = 'EXTREME_UNDERVAL';
      else if (e > th.lowExit || b > th.lowExit) cur = 'NEUTRAL';
    } else {
      if (e >= th.erpHighEnter && b >= th.bpHighEnter) cur = 'EXTREME_UNDERVAL';
      else if (e <= th.lowEnter && b <= th.lowEnter) cur = 'EXTREME_BUBBLE';
    }
    out.push(cur);
  }
  return out;
}

/**
 * 纯函数：在单点场景（无历史序列）直接判定 B1 极值状态（以 prevState 为滞回前置态）。
 */
export function evaluateB1EnvelopeStep(
  erpPct756: number | null | undefined,
  bpPct756: number | null | undefined,
  prevState: FundamentalEnvelopeState = 'NEUTRAL',
  thresholds: FundamentalEnvelopeThresholds = {},
): FundamentalEnvelopeState {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const e = normalizePercentile01(erpPct756);
  const b = normalizePercentile01(bpPct756);
  if (e === null || b === null) return 'NEUTRAL';
  if (prevState === 'EXTREME_UNDERVAL') {
    if (e <= th.lowEnter && b <= th.lowEnter) return 'EXTREME_BUBBLE';
    if (e < th.erpHighExit || b < th.bpHighExit) return 'NEUTRAL';
    return 'EXTREME_UNDERVAL';
  }
  if (prevState === 'EXTREME_BUBBLE') {
    if (e >= th.erpHighEnter && b >= th.bpHighEnter) return 'EXTREME_UNDERVAL';
    if (e > th.lowExit || b > th.lowExit) return 'NEUTRAL';
    return 'EXTREME_BUBBLE';
  }
  if (e >= th.erpHighEnter && b >= th.bpHighEnter) return 'EXTREME_UNDERVAL';
  if (e <= th.lowEnter && b <= th.lowEnter) return 'EXTREME_BUBBLE';
  return 'NEUTRAL';
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

/**
 * 从 `ashare.sqlite` 只读评估 asOf 日的 B1 基本面极值包络与只读宏观观察指标。
 * 内置 <=5 交易日慢变量 Fail-Safe 沿用：缺失当日数据时不退回 NO_ACTION。
 */
export function evaluateFundamentalRegime(
  db: DatabaseSync | null | undefined,
  asOf: string,
  thresholds: FundamentalEnvelopeThresholds = {},
): FundamentalRegimeResult {
  const empty: FundamentalRegimeResult = {
    available: false,
    as_of_trade_date: asOf,
    b1_state: 'NEUTRAL',
    b1_state_label_zh: B1_STATE_LABELS_ZH.NEUTRAL,
    erp_pct_756: null,
    bp_pct_756: null,
    erp_bps: null,
    ep_median_bps: null,
    bp_median_bps: null,
    dv_lowvol_bps: null,
    edi_bps: null,
    cgb_1y_bps: null,
    cgb_10y_bps: null,
    term_spread_bps: null,
    stale_fallback_days: 0,
    warning: null,
    summary_zh: '基本面慢变量缓存暂不可用，按中性状态（100% 透传技术面档位）运行。',
  };

  if (!db || !tableExists(db, 'market_fundamental_daily')) return empty;

  const rows = (db.prepare(`
    SELECT trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps
    FROM market_fundamental_daily
    WHERE trade_date <= ?
    ORDER BY trade_date DESC
    LIMIT 250
  `).all(asOf) as unknown as FundamentalDailySnapshot[]).reverse();

  const macroRow = tableExists(db, 'macro_yield_curve')
    ? (db.prepare(`
        SELECT trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source
        FROM macro_yield_curve
        WHERE trade_date <= ? AND cgb_10y_bps IS NOT NULL
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(asOf) as MacroYieldSnapshot | undefined)
    : undefined;

  const macroGap = macroRow ? countTradeDaysGap(db, macroRow.trade_date, asOf) : 999;
  const macroValid = macroRow && macroGap <= 5 ? macroRow : null;

  if (rows.length === 0) {
    return {
      ...empty,
      cgb_1y_bps: macroValid?.cgb_1y_bps ?? null,
      cgb_10y_bps: macroValid?.cgb_10y_bps ?? null,
      term_spread_bps: macroValid?.term_spread_bps ?? null,
    };
  }

  const latestValid = [...rows].reverse().find(
    r => r.erp_pct_756 !== null && r.bp_pct_756 !== null && Number.isFinite(r.erp_pct_756) && Number.isFinite(r.bp_pct_756),
  ) ?? rows[rows.length - 1];
  const gapDays = countTradeDaysGap(db, latestValid.trade_date, asOf);
  if (gapDays > 5) {
    return {
      ...empty,
      stale_fallback_days: gapDays,
      warning: `基本面慢变量已滞后 ${gapDays} 个交易日（>5 日），按中性状态透传技术面档位`,
      cgb_1y_bps: macroValid?.cgb_1y_bps ?? null,
      cgb_10y_bps: macroValid?.cgb_10y_bps ?? null,
      term_spread_bps: macroValid?.term_spread_bps ?? null,
    };
  }

  const states = computeB1EnvelopeSeries(rows, thresholds);
  const validIdx = rows.lastIndexOf(latestValid);
  const b1State = validIdx >= 0 ? states[validIdx] : 'NEUTRAL';
  const warning = gapDays > 0
    ? `基本面慢变量沿用最近有效交易日 ${latestValid.trade_date}（滞后 ${gapDays} 个交易日）`
    : (macroGap > 0 && macroValid ? `国债曲线沿用最近有效交易日 ${macroValid.trade_date}（滞后 ${macroGap} 个交易日）` : null);

  const erpPctDisplay = normalizePercentile01(latestValid.erp_pct_756);
  const bpPctDisplay = normalizePercentile01(latestValid.bp_pct_756);
  const summaryZh = `${B1_STATE_LABELS_ZH[b1State]}；三年期股权风险溢价分位 ${erpPctDisplay !== null ? `${(erpPctDisplay * 100).toFixed(1)}%` : '—'}，市净率倒数分位 ${bpPctDisplay !== null ? `${(bpPctDisplay * 100).toFixed(1)}%` : '—'}。`;

  return {
    available: true,
    as_of_trade_date: asOf,
    b1_state: b1State,
    b1_state_label_zh: B1_STATE_LABELS_ZH[b1State],
    erp_pct_756: erpPctDisplay,
    bp_pct_756: bpPctDisplay,
    erp_bps: latestValid.erp_bps,
    ep_median_bps: latestValid.ep_median_bps,
    bp_median_bps: latestValid.bp_median_bps,
    dv_lowvol_bps: latestValid.dv_lowvol_bps,
    edi_bps: latestValid.edi_bps,
    cgb_1y_bps: macroValid?.cgb_1y_bps ?? null,
    cgb_10y_bps: macroValid?.cgb_10y_bps ?? null,
    term_spread_bps: macroValid?.term_spread_bps ?? null,
    stale_fallback_days: gapDays,
    warning,
    summary_zh: summaryZh,
  };
}
