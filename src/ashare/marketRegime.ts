import type { DatabaseSync } from 'node:sqlite';
import { scanMarket } from './analysis.js';
import { recentTradeDays } from './ingest.js';
import { marketBreadth } from './market.js';
import { latestReportMeta, loadReport } from './report.js';

export type IndexTrendState = 'BULL' | 'RANGE' | 'BEAR';
export type MarketRegimeTier = 'OFFENSIVE' | 'STRUCTURAL' | 'DEFENSIVE';
export type MarketStyleTier = 'GROWTH_LEADING' | 'VALUE_LEADING' | 'BALANCED';

export interface AnchorTrendSnapshot {
  ts_code: string;
  close: number | null;
  ma20: number | null;
  ma20_prev5: number | null;
  ma60: number | null;
  pct_chg: number | null;
  ret20_pct: number | null;
  state: IndexTrendState;
  bars_available: number;
}

export interface DailyRegimePoint {
  trade_date: string;
  value_state: IndexTrendState;
  growth_state: IndexTrendState;
  pct_above_ma60: number | null;
  amount_vs_ma20: number | null;
  limit_down: number | null;
  crash_override: boolean;
  raw_regime: MarketRegimeTier;
  confirmed_regime: MarketRegimeTier;
}

export interface MarketRegimeResult {
  schema: 'ashare-market-regime/1.0';
  as_of_trade_date: string;
  available: boolean;
  regime: MarketRegimeTier;
  raw_regime: MarketRegimeTier;
  target_equity_bps: number;
  target_equity_pct: number;
  hysteresis_held: boolean;
  crash_override: boolean;
  style: MarketStyleTier;
  style_spread_20d_pct: number | null;
  value_anchor: AnchorTrendSnapshot;
  growth_anchor: {
    csi500: AnchorTrendSnapshot;
    chinext: AnchorTrendSnapshot;
    synthesized_state: IndexTrendState;
    ret20_pct: number | null;
    pct_chg: number | null;
  };
  breadth: {
    pct_above_ma60: number | null;
    pct_above_ma60_pct: number | null;
    amount_yi: number | null;
    amount_ma20_yi: number | null;
    amount_vs_ma20: number | null;
    up: number | null;
    down: number | null;
    limit_down: number | null;
  };
  history: DailyRegimePoint[];
  regime_label_zh: string;
  style_label_zh: string;
  summary_zh: string;
  notes: string[];
}

export interface EvaluateMarketRegimeOptions {
  /** 可选：历史回溯确认窗口长度（默认 5 个交易日）。 */
  hysteresisLookbackDays?: number;
  /** 可选（测试注入）：按交易日覆盖全市场站上 MA60 比例（0~1），避免在小样本单测里扫描全市场。 */
  pctAboveMa60ByDate?: Record<string, number>;
}

const INDEX_STATE_ZH: Record<IndexTrendState, string> = {
  BULL: '多头',
  RANGE: '震荡',
  BEAR: '空头',
};

export const REGIME_TARGET_EQUITY_BPS: Record<MarketRegimeTier, number> = {
  OFFENSIVE: 8500,
  STRUCTURAL: 6000,
  DEFENSIVE: 1500,
};

export const REGIME_LABELS_ZH: Record<MarketRegimeTier, string> = {
  OFFENSIVE: '全面进攻档（目标总仓位 85%）',
  STRUCTURAL: '震荡结构档（目标总仓位 60%）',
  DEFENSIVE: '空头防守档（目标总仓位 15%）',
};

export const STYLE_LABELS_ZH: Record<MarketStyleTier, string> = {
  GROWTH_LEADING: '成长风格占优',
  VALUE_LEADING: '价值红利占优',
  BALANCED: '大小盘均衡',
};

function tableExists(db: DatabaseSync | null | undefined, name: string): boolean {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function r2(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function emptyAnchor(tsCode: string): AnchorTrendSnapshot {
  return {
    ts_code: tsCode,
    close: null,
    ma20: null,
    ma20_prev5: null,
    ma60: null,
    pct_chg: null,
    ret20_pct: null,
    state: 'RANGE',
    bars_available: 0,
  };
}

function meanTail(values: number[], length: number, endInclusive: number): number | null {
  if (endInclusive + 1 < length) return null;
  let sum = 0;
  for (let i = endInclusive - length + 1; i <= endInclusive; i += 1) {
    if (!Number.isFinite(values[i])) return null;
    sum += values[i];
  }
  return sum / length;
}

function evaluateIndexAnchor(
  db: DatabaseSync,
  tsCode: string,
  asOf: string,
): AnchorTrendSnapshot {
  const rows = db.prepare(
    'SELECT trade_date, close FROM index_daily WHERE ts_code = ? AND trade_date <= ? AND close > 0 ORDER BY trade_date DESC LIMIT 80',
  ).all(tsCode, asOf) as { trade_date: string; close: number }[];
  if (!rows.length) return emptyAnchor(tsCode);
  const series = rows.reverse();
  const closes = series.map(row => Number(row.close));
  const lastIdx = closes.length - 1;
  const close = closes[lastIdx];
  const prevClose = lastIdx >= 1 ? closes[lastIdx - 1] : null;
  const pctChg = prevClose && prevClose > 0 ? r2(((close / prevClose) - 1) * 100) : null;
  const ret20 = lastIdx >= 20 && closes[lastIdx - 20] > 0
    ? r2(((close / closes[lastIdx - 20]) - 1) * 100)
    : null;
  const ma20 = r2(meanTail(closes, 20, lastIdx), 4);
  const ma20Prev5 = r2(meanTail(closes, 20, lastIdx - 5), 4);
  const ma60 = r2(meanTail(closes, 60, lastIdx), 4);

  let state: IndexTrendState = 'RANGE';
  if (ma60 !== null && ma20 !== null && ma20Prev5 !== null) {
    if (close > ma60 && ma20 > ma60 && ma20 > ma20Prev5) state = 'BULL';
    else if (close < ma60 && ma20 <= ma20Prev5) state = 'BEAR';
  }

  return {
    ts_code: tsCode,
    close: r2(close, 3),
    ma20,
    ma20_prev5: ma20Prev5,
    ma60,
    pct_chg: pctChg,
    ret20_pct: ret20,
    state,
    bars_available: closes.length,
  };
}

function synthesizeGrowthState(a: AnchorTrendSnapshot, b: AnchorTrendSnapshot): IndexTrendState {
  const active = [a, b].filter(item => item.bars_available >= 65);
  if (active.length === 0) {
    // 若仅有 20~64 根指数行，仍返回中性震荡以避免误切空头。
    return 'RANGE';
  }
  if (active.every(item => item.state === 'BEAR')) return 'BEAR';
  if (active.some(item => item.state === 'BULL') && active.every(item => item.state !== 'BEAR')) return 'BULL';
  return 'RANGE';
}

function averageFinite(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return null;
  return r2(valid.reduce((sum, v) => sum + v, 0) / valid.length);
}

function resolveBreadthSnapshot(
  db: DatabaseSync,
  date: string,
  pctOverride: number | undefined,
): {
  pctAboveMa60: number | null;
  amountYi: number | null;
  amountMa20Yi: number | null;
  amountVsMa20: number | null;
  up: number | null;
  down: number | null;
  limitDown: number | null;
  note?: string;
} {
  let pctAboveMa60: number | null = typeof pctOverride === 'number' && Number.isFinite(pctOverride)
    ? pctOverride
    : null;
  let amountYi: number | null = null;
  let amountMa20Yi: number | null = null;
  let up: number | null = null;
  let down: number | null = null;
  let limitDown: number | null = null;
  let note: string | undefined;

  if (tableExists(db, 'report')) {
    try {
      const meta = latestReportMeta(db, date);
      if (meta && meta.trade_date === date) {
        const rep = loadReport(meta);
        const br = rep?.market?.breadth;
        if (rep && (rep.as_of_trade_date === date || rep.trade_date === date) && br) {
          if (pctAboveMa60 === null && typeof br.pct_above_ma60 === 'number' && Number.isFinite(br.pct_above_ma60)) {
            pctAboveMa60 = br.pct_above_ma60 / 100;
          }
          if (typeof br.amount_yi === 'number') amountYi = br.amount_yi;
          if (typeof br.amount_ma20_yi === 'number') amountMa20Yi = br.amount_ma20_yi;
          if (typeof br.up === 'number') up = br.up;
          if (typeof br.down === 'number') down = br.down;
          if (typeof br.limit_down === 'number') limitDown = br.limit_down;
        }
      }
    } catch {
      // 已发布 JSON 不存在或路径不同时回退至市场缓存直算。
    }
  }

  if (tableExists(db, 'daily') && (amountYi === null || limitDown === null || up === null)) {
    try {
      const mb = marketBreadth(db, date);
      if (mb.stocks > 0) {
        amountYi = amountYi ?? mb.amount_yi;
        amountMa20Yi = amountMa20Yi ?? mb.amount_ma20_yi;
        up = up ?? mb.up;
        down = down ?? mb.down;
        limitDown = limitDown ?? mb.limit_down;
      }
    } catch {
      // daily_basic/stk_limit 缺失时保持 null。
    }
  }

  if (pctAboveMa60 === null && tableExists(db, 'daily') && tableExists(db, 'stock_basic')) {
    try {
      const dateCountRow = db.prepare('SELECT COUNT(DISTINCT trade_date) n FROM daily WHERE trade_date <= ?').get(date) as { n?: number } | undefined;
      if ((dateCountRow?.n ?? 0) >= 65) {
        const scan = scanMarket(db, date);
        if (scan.rows.length > 0 && Number.isFinite(scan.pct_above_ma60)) {
          pctAboveMa60 = scan.pct_above_ma60;
        }
      } else {
        note = '个股日线历史不足 65 根，市场宽度占比暂不可用';
      }
    } catch {
      note = '扫描市场宽度失败，按缺省中性广度处理';
    }
  }

  const amountVsMa20 = amountYi !== null && amountMa20Yi !== null && amountMa20Yi > 0
    ? r2(amountYi / amountMa20Yi, 3)
    : null;

  return { pctAboveMa60, amountYi, amountMa20Yi, amountVsMa20, up, down, limitDown, note };
}

function classifyRawRegime(
  valueState: IndexTrendState,
  growthState: IndexTrendState,
  pctAboveMa60: number | null,
  amountVsMa20: number | null,
): MarketRegimeTier {
  const offensiveBreadthOk = pctAboveMa60 !== null && pctAboveMa60 >= 0.45;
  const offensiveVolumeOk = amountVsMa20 !== null && amountVsMa20 >= 0.85;
  if (
    (valueState === 'BULL' || growthState === 'BULL')
    && valueState !== 'BEAR'
    && growthState !== 'BEAR'
    && offensiveBreadthOk
    && offensiveVolumeOk
  ) {
    return 'OFFENSIVE';
  }
  const defensiveBreadthHit = pctAboveMa60 !== null && pctAboveMa60 < 0.30;
  if (
    (valueState === 'BEAR' && growthState === 'BEAR')
    || ((valueState === 'BEAR' || growthState === 'BEAR') && defensiveBreadthHit)
  ) {
    return 'DEFENSIVE';
  }
  return 'STRUCTURAL';
}

export function evaluateMarketRegime(
  db: DatabaseSync | null | undefined,
  asOf: string,
  opts: EvaluateMarketRegimeOptions = {},
): MarketRegimeResult {
  if (!db || !tableExists(db, 'index_daily')) {
    return {
      schema: 'ashare-market-regime/1.0',
      as_of_trade_date: asOf,
      available: false,
      regime: 'STRUCTURAL',
      raw_regime: 'STRUCTURAL',
      target_equity_bps: REGIME_TARGET_EQUITY_BPS.STRUCTURAL,
      target_equity_pct: 60,
      hysteresis_held: false,
      crash_override: false,
      style: 'BALANCED',
      style_spread_20d_pct: null,
      value_anchor: emptyAnchor('000300.SH'),
      growth_anchor: {
        csi500: emptyAnchor('000905.SH'),
        chinext: emptyAnchor('399006.SZ'),
        synthesized_state: 'RANGE',
        ret20_pct: null,
        pct_chg: null,
      },
      breadth: {
        pct_above_ma60: null,
        pct_above_ma60_pct: null,
        amount_yi: null,
        amount_ma20_yi: null,
        amount_vs_ma20: null,
        up: null,
        down: null,
        limit_down: null,
      },
      history: [],
      regime_label_zh: REGIME_LABELS_ZH.STRUCTURAL,
      style_label_zh: STYLE_LABELS_ZH.BALANCED,
      summary_zh: '市场指数缓存不可用，暂按震荡结构档（目标总仓位 60%）防守运行。',
      notes: ['缺少指数日线缓存，双锚环境退化为默认结构档。'],
    };
  }

  const lookback = Math.max(2, opts.hysteresisLookbackDays ?? 5);
  let dates = tableExists(db, 'trade_cal') ? recentTradeDays(db, asOf, lookback) : [];
  if (!dates.length) {
    dates = (db.prepare(
      "SELECT DISTINCT trade_date FROM index_daily WHERE ts_code = '000300.SH' AND trade_date <= ? ORDER BY trade_date DESC LIMIT ?",
    ).all(asOf, lookback) as { trade_date: string }[]).map(row => row.trade_date).reverse();
  }
  if (!dates.length) dates = [asOf];

  const notes: string[] = [];
  const history: DailyRegimePoint[] = [];
  let confirmed: MarketRegimeTier = 'STRUCTURAL';
  let latestValue = emptyAnchor('000300.SH');
  let latestCsi500 = emptyAnchor('000905.SH');
  let latestChinext = emptyAnchor('399006.SZ');
  let latestGrowthState: IndexTrendState = 'RANGE';
  let latestGrowthPctChg: number | null = null;
  let latestGrowthRet20: number | null = null;
  let latestBreadth = resolveBreadthSnapshot(db, dates[dates.length - 1], opts.pctAboveMa60ByDate?.[dates[dates.length - 1]]);

  for (let idx = 0; idx < dates.length; idx += 1) {
    const d = dates[idx];
    const valueA = evaluateIndexAnchor(db, '000300.SH', d);
    const csi500A = evaluateIndexAnchor(db, '000905.SH', d);
    const chinextA = evaluateIndexAnchor(db, '399006.SZ', d);
    const growthState = synthesizeGrowthState(csi500A, chinextA);
    const growthPctChg = averageFinite([csi500A.pct_chg, chinextA.pct_chg]);
    const growthRet20 = averageFinite([csi500A.ret20_pct, chinextA.ret20_pct]);
    const b = resolveBreadthSnapshot(db, d, opts.pctAboveMa60ByDate?.[d]);
    const raw = classifyRawRegime(valueA.state, growthState, b.pctAboveMa60, b.amountVsMa20);

    const crash = valueA.pct_chg !== null
      && valueA.pct_chg < -3.5
      && growthPctChg !== null
      && growthPctChg < -3.5
      && (b.limitDown ?? 0) > 80;

    if (idx === 0) {
      confirmed = crash ? 'DEFENSIVE' : raw;
    } else if (crash) {
      confirmed = 'DEFENSIVE';
    } else if (raw === history[idx - 1].raw_regime) {
      confirmed = raw;
    }

    history.push({
      trade_date: d,
      value_state: valueA.state,
      growth_state: growthState,
      pct_above_ma60: b.pctAboveMa60 !== null ? r2(b.pctAboveMa60, 4) : null,
      amount_vs_ma20: b.amountVsMa20,
      limit_down: b.limitDown,
      crash_override: crash,
      raw_regime: raw,
      confirmed_regime: confirmed,
    });

    if (idx === dates.length - 1) {
      latestValue = valueA;
      latestCsi500 = csi500A;
      latestChinext = chinextA;
      latestGrowthState = growthState;
      latestGrowthPctChg = growthPctChg;
      latestGrowthRet20 = growthRet20;
      latestBreadth = b;
      if (b.note) notes.push(b.note);
    }
  }

  const lastPoint = history[history.length - 1];
  const rawRegime = lastPoint.raw_regime;
  const regime = lastPoint.confirmed_regime;
  const hysteresisHeld = regime !== rawRegime;
  const crashOverride = lastPoint.crash_override;

  const styleSpread = latestGrowthRet20 !== null && latestValue.ret20_pct !== null
    ? r2(latestGrowthRet20 - latestValue.ret20_pct)
    : null;
  let style: MarketStyleTier = 'BALANCED';
  if (styleSpread !== null) {
    if (styleSpread > 3) style = 'GROWTH_LEADING';
    else if (styleSpread < -3) style = 'VALUE_LEADING';
  }

  const targetEquityBps = REGIME_TARGET_EQUITY_BPS[regime];
  const pctMa60Pct = latestBreadth.pctAboveMa60 !== null ? r2(latestBreadth.pctAboveMa60 * 100, 1) : null;
  const volPart = latestBreadth.amountVsMa20 !== null ? `成交量比 ${latestBreadth.amountVsMa20.toFixed(2)} 倍` : '成交量比数据不足';
  const breadthPart = pctMa60Pct !== null ? `站上 60 日线占比 ${pctMa60Pct.toFixed(1)}%` : '全市场站上 60 日线占比不足';
  const hysteresisNote = crashOverride
    ? '触发单日极端暴跌保护，当日直接切换防守档。'
    : hysteresisHeld
      ? `当日原始状态为「${REGIME_LABELS_ZH[rawRegime]}」，未满足连续两日确认，按滞回防抖规则维持当前档位。`
      : '连续两日趋势信号一致确认。';
  const styleSpreadTxt = styleSpread !== null
    ? `近 20 日成长锚相对沪深 300 超额 ${styleSpread >= 0 ? '+' : ''}${styleSpread.toFixed(2)}%`
    : '20 日风格剪刀差数据不足';

  const summaryZh =
    `大盘价值锚（沪深300）${INDEX_STATE_ZH[latestValue.state]}，成长弹性锚（中证500/创业板）${INDEX_STATE_ZH[latestGrowthState]}；`
    + `${breadthPart}，${volPart}。判定为【${REGIME_LABELS_ZH[regime]}】，风格为【${STYLE_LABELS_ZH[style]}】（${styleSpreadTxt}）。${hysteresisNote}`;

  if (latestValue.bars_available < 65 || (latestCsi500.bars_available < 65 && latestChinext.bars_available < 65)) {
    notes.push('部分指数有效 K 线不足 65 根，趋势状态已按震荡中性处理。');
  }

  return {
    schema: 'ashare-market-regime/1.0',
    as_of_trade_date: asOf,
    available: true,
    regime,
    raw_regime: rawRegime,
    target_equity_bps: targetEquityBps,
    target_equity_pct: targetEquityBps / 100,
    hysteresis_held: hysteresisHeld,
    crash_override: crashOverride,
    style,
    style_spread_20d_pct: styleSpread,
    value_anchor: latestValue,
    growth_anchor: {
      csi500: latestCsi500,
      chinext: latestChinext,
      synthesized_state: latestGrowthState,
      ret20_pct: latestGrowthRet20,
      pct_chg: latestGrowthPctChg,
    },
    breadth: {
      pct_above_ma60: latestBreadth.pctAboveMa60 !== null ? r2(latestBreadth.pctAboveMa60, 4) : null,
      pct_above_ma60_pct: pctMa60Pct,
      amount_yi: latestBreadth.amountYi,
      amount_ma20_yi: latestBreadth.amountMa20Yi,
      amount_vs_ma20: latestBreadth.amountVsMa20,
      up: latestBreadth.up,
      down: latestBreadth.down,
      limit_down: latestBreadth.limitDown,
    },
    history,
    regime_label_zh: REGIME_LABELS_ZH[regime],
    style_label_zh: STYLE_LABELS_ZH[style],
    summary_zh: summaryZh,
    notes,
  };
}
