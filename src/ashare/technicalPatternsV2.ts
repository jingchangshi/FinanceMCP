/**
 * Technical-analysis methodology V2 (goal-1102) — family pattern detectors.
 *
 * Five independent research families produce `PatternObservation`s. The module
 * is pure: it reads only bars/indicators at indices <= `input.endIdx`, never
 * touches the database and never mutates its input. `research_ready`, scoring
 * and trade instructions belong to other modules — this file only dates the
 * observable price behaviour.
 *
 * Time semantics (shared with `patterns.ts`):
 *   - `formed_on` is the first bar at which the forming state is provable.
 *   - `confirmed_on` is the first bar at which the confirmation is provable,
 *     never the formation low / first dip / platform start.
 *   - A swing low at `j` is provable only from `j + L` (right-side bars).
 *   - Stage after confirmation: CONFIRMED on the confirmation bar,
 *     FOLLOW_THROUGH while intact, FAILED on the first invalidation bar,
 *     EXPIRED when the frozen evaluation window elapses.
 *
 * All thresholds below are pre-registered research hypotheses, not fitted
 * parameters. They must never be tuned to a single stock; change a threshold
 * only by changing the methodology version.
 *
 * Deliberate boundaries: no sell signals. A touch of an upper band is an
 * observation, not an order.
 */
import type {
  PatternInput, PatternObservation, TechnicalFamily, TechnicalStage,
} from './technicalFrameworkV2.js';
import {
  confirmedLocalLows, detectPullbackResume, detectWBottom,
  DEFAULT_MACD_W_OPTS, DEFAULT_PULLBACK_OPTS,
} from './patterns.js';

const isFin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Indicator values (DIF/RSI/width) are reported unadjusted and rounded to 4 dp. */
function round4(v: number | null | undefined): number | null {
  return isFin(v) ? Math.round(v * 10_000) / 10_000 : null;
}

/** Population standard deviation; null when the window is not fully finite. */
function stdevAll(values: number[]): number | null {
  if (values.length === 0 || values.some(v => !isFin(v))) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

function medianFinite(values: number[]): number | null {
  const f = values.filter(isFin).sort((a, b) => a - b);
  if (f.length === 0) return null;
  const mid = f.length >> 1;
  return f.length % 2 === 1 ? f[mid] : (f[mid - 1] + f[mid]) / 2;
}

/** 20th percentile of the finite values (same rank rule as the V1 squeeze). */
function percentile20(values: number[]): number | null {
  const f = values.filter(isFin).sort((a, b) => a - b);
  if (f.length === 0) return null;
  return f[Math.floor(f.length * 0.2)];
}

function maxFinite(values: number[], from: number, to: number): number | null {
  let out: number | null = null;
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) {
    if (isFin(values[i]) && (out === null || values[i] > out)) out = values[i];
  }
  return out;
}

function minFinite(values: number[], from: number, to: number): number | null {
  let out: number | null = null;
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) {
    if (isFin(values[i]) && (out === null || values[i] < out)) out = values[i];
  }
  return out;
}

/** First bar in (from, to] where `pred` holds, or -1. */
function firstWhere(from: number, to: number, pred: (k: number) => boolean): number {
  for (let k = from + 1; k <= to; k++) if (pred(k)) return k;
  return -1;
}

/** Most recent bar in [from, to] where `pred` holds, or -1. */
function lastWhere(from: number, to: number, pred: (k: number) => boolean): number {
  for (let k = to; k >= from; k--) if (pred(k)) return k;
  return -1;
}

// ---------------------------------------------------------------- definitions

export const PATTERN_DEFINITIONS_V2: Record<TechnicalFamily, string> = {
  TREND_CONTINUATION:
    '趋势内回踩 MA20 后重新收上 MA20；均线多头排列只是背景，不单独构成信号；失效为收盘跌破 MA60。',
  PLATFORM_BREAKOUT:
    '30 日窄幅平台（振幅 ≤15%、后半段波动收缩、非急涨）被放量收盘突破；无平台的急涨新高不算平台突破。',
  REVERSAL:
    'MACD DIF 底背离（价格创新低、DIF 低点抬高）或 DIF W 底；确认需收盘越过颈线， DIF 跌破两低点失效。',
  VOLATILITY_EXPANSION:
    '布林带宽处于近 120 日 20% 分位后的上轨突破，或趋势中连续触及上轨的带宽扩张；触碰上轨不是卖出指令。',
  MEAN_REVERSION:
    '震荡环境中的超卖观察与布林下轨再入；下跌趋势中的超卖只记为逆势观察，不确认。',
};

// ---------------------------------------------------------------- observation

interface ObservationParts {
  stage: TechnicalStage;
  stage_detail: string;
  /** Price-event date (the bar the pattern is about). Defaults to the earliest dated stage fact. */
  pattern_event_date?: string | null;
  /** First bar at which the pattern is provable from data ≤ that bar. */
  first_observed_date?: string | null;
  invalidated_at?: string | null;
  expires_at?: string | null;
  formed_on?: string | null;
  confirmed_on?: string | null;
  formation_basis?: string[];
  confirmation_conditions?: string[];
  invalidation_conditions?: string[];
  invalidation?: { on: string; reason: string } | null;
  key_levels?: Record<string, number | null>;
  evidence?: Record<string, number | string | boolean | null>;
  counter_evidence?: string[];
}

function makeObservation(
  input: PatternInput, strategy_id: string, family: TechnicalFamily, parts: ObservationParts,
): PatternObservation {
  const eventDate = parts.pattern_event_date ?? parts.confirmed_on ?? parts.formed_on ?? null;
  return {
    strategy_id,
    family,
    stage: parts.stage,
    stage_detail: parts.stage_detail,
    pattern_event_date: eventDate,
    first_observed_date: parts.first_observed_date ?? parts.confirmed_on ?? parts.formed_on
      ?? input.bars.dates[input.endIdx],
    invalidated_at: parts.invalidated_at ?? (parts.stage === 'FAILED' ? parts.invalidation?.on ?? null : null),
    expires_at: parts.expires_at ?? (parts.stage === 'EXPIRED' ? input.bars.dates[input.endIdx] : null),
    formed_on: parts.formed_on ?? null,
    confirmed_on: parts.confirmed_on ?? null,
    last_evaluated_on: input.bars.dates[input.endIdx],
    formation_basis: parts.formation_basis ?? [],
    confirmation_conditions: parts.confirmation_conditions ?? [],
    invalidation_conditions: parts.invalidation_conditions ?? [],
    invalidation: parts.invalidation ?? null,
    key_levels: parts.key_levels ?? {},
    evidence: parts.evidence ?? {},
    counter_evidence: parts.counter_evidence
      ?? (parts.stage === 'FORMING' ? ['尚无可观察的确认价格行为'] : []),
  };
}

/** Adjusted → raw price scaler for every price level exposed to the caller. */
function rawScaler(input: PatternInput): (v: number | null | undefined) => number | null {
  const i = input.endIdx;
  const adj = input.bars.close[i];
  const raw = input.bars.rawClose[i];
  const factor = isFin(adj) && isFin(raw) && adj !== 0 ? raw / adj : 1;
  return (v) => (isFin(v) ? round4(v * factor) : null);
}

function rpsValue(input: PatternInput): number | null {
  const r = input.rps120?.[input.endIdx];
  return isFin(r) ? round4(r) : null;
}

// ---------------------------------------------------------------- A. trend continuation

/**
 * TREND_CONTINUATION — a pullback-to-MA20 resume inside an established trend.
 *
 * Thresholds: MA20 above its value 5 bars ago; pullback touch tolerance 1%
 * (shared with `DEFAULT_PULLBACK_OPTS`); evaluation window 10 bars for the
 * pullback resume.
 *
 * A bullish MA20 > MA60 alignment is background context, never a standalone
 * event: the family only dates a pullback into MA20 and its later resume.
 * That is why there is no `trend_established` confirmation here (A01 / D13).
 */
export function detectTrendContinuation(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 0) return [];
  const close = b.close;
  const ma20 = x.ma20;
  const ma60 = x.ma60;
  const toRaw = rawScaler(input);
  const out: PatternObservation[] = [];

  // ---- tc_v2_pullback_resume
  const pullbackAt = (k: number) => detectPullbackResume(close, b.low, ma20, ma60, k, DEFAULT_PULLBACK_OPTS);
  const current = i >= 61 ? pullbackAt(i) : null;

  // Latest earlier confirmation inside the tracking window. First-cross
  // semantics of `detectPullbackResume` prevent re-firing while the resume
  // condition is already in force.
  const confirmations: number[] = [];
  for (let k = Math.max(61, i - 200); k <= i; k++) if (pullbackAt(k)) confirmations.push(k);
  const latest = confirmations.length > 0 ? confirmations[confirmations.length - 1] : -1;

  const rpsEvidence = { rps_background_only: true, rps120: rpsValue(input) };
  if (current) {
    out.push(makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', {
      stage: 'CONFIRMED', stage_detail: 'PULLBACK_RESUME',
      pattern_event_date: b.dates[current.touchIndex], first_observed_date: b.dates[i],
      formed_on: b.dates[current.touchIndex], confirmed_on: b.dates[i],
      formation_basis: ['上升趋势中回踩 MA20（low ≤ MA20 × 1.01）'],
      confirmation_conditions: ['收盘重新站上 MA20 且高于前一日收盘，MA20 > MA60'],
      invalidation_conditions: ['收盘跌破 MA60'],
      key_levels: { ma20: toRaw(current.ma20), ma60: toRaw(ma60[i]), touch_low: toRaw(b.low[current.touchIndex]) },
      evidence: {
        ...rpsEvidence,
        touch_date: b.dates[current.touchIndex],
        ma20: round4(current.ma20),
        confirmation_lag: i - current.touchIndex,
      },
    }));
  } else if (latest >= 0) {
    const fail = firstWhere(latest, i, k => isFin(close[k]) && isFin(ma60[k]) && close[k] < ma60[k]);
    const priorTouch = pullbackAt(latest)?.touchIndex ?? latest;
    const common = {
      pattern_event_date: b.dates[priorTouch],
      first_observed_date: b.dates[latest],
      formed_on: null as string | null,
      confirmed_on: b.dates[latest],
      formation_basis: ['上升趋势中回踩 MA20（low ≤ MA20 × 1.01）'],
      confirmation_conditions: ['收盘重新站上 MA20 且高于前一日收盘，MA20 > MA60'],
      invalidation_conditions: ['收盘跌破 MA60'],
      key_levels: { ma20: toRaw(ma20[latest]), ma60: toRaw(ma60[latest]) },
    };
    if (fail >= 0) {
      out.push(makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', {
        ...common, stage: 'FAILED', stage_detail: 'PULLBACK_RESUME',
        invalidation: { on: b.dates[fail], reason: 'close_below_ma60' },
        evidence: { ...rpsEvidence, bars_since_confirmation: i - latest, invalidation_close: round4(close[fail]) },
      }));
    } else if (i - latest > 10) {
      out.push(makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', {
        ...common, stage: 'EXPIRED', stage_detail: 'PULLBACK_RESUME',
        evidence: { ...rpsEvidence, bars_since_confirmation: i - latest, expired: true },
      }));
    } else {
      out.push(makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', {
        ...common, stage: 'FOLLOW_THROUGH', stage_detail: 'PULLBACK_RESUME',
        evidence: { ...rpsEvidence, bars_since_confirmation: i - latest },
      }));
    }
  } else {
    // FORMING only while the uptrend background itself still holds; a close
    // below MA20 is a pullback in progress, not a confirmed resume.
    const background = i >= 60 && isFin(close[i]) && isFin(ma20[i]) && isFin(ma60[i]) && isFin(ma20[i - 5])
      && close[i] > ma20[i] && ma20[i] > ma60[i] && ma20[i] > ma20[i - 5];
    let touch = -1;
    if (background) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (isFin(b.low[j]) && isFin(ma20[j]) && b.low[j] <= ma20[j] * (1 + DEFAULT_PULLBACK_OPTS.touchTol)) { touch = j; break; }
      }
    }
    const notAboveMa20 = isFin(close[i]) && isFin(ma20[i]) && close[i] <= ma20[i];
    if (background && touch >= 0 && notAboveMa20) {
      out.push(makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', {
        stage: 'FORMING', stage_detail: 'PULLBACK_TO_MA20',
        formed_on: b.dates[touch], confirmed_on: null,
        formation_basis: ['上升趋势中回踩 MA20（low ≤ MA20 × 1.01），尚未收上 MA20'],
        confirmation_conditions: ['收盘重新站上 MA20 且高于前一日收盘'],
        invalidation_conditions: ['收盘跌破 MA60'],
        key_levels: { ma20: toRaw(ma20[i]), ma60: toRaw(ma60[i]), touch_low: toRaw(b.low[touch]) },
        evidence: { ...rpsEvidence, touch_date: b.dates[touch], ma20: round4(ma20[i]), close: round4(close[i]) },
      }));
    }
  }

  return out;
}

// ---------------------------------------------------------------- B. platform breakout

interface PlatformZone {
  high: number;
  low: number;
  rangeWidth: number;
}

/**
 * PLATFORM_BREAKOUT — a tight 30-day platform (window excludes today) broken
 * by a volume-qualified close.
 *
 * Thresholds (research hypotheses): range width ≤15%; recent 10-bar close
 * dispersion ≤0.8× the prior 20-bar dispersion; prior 20-bar gain ≤25% and
 * ATR14/close ≤6%; breakout volume ≥1.2× MA20 volume.
 */
export function detectPlatformBreakout(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 61) return [];
  const close = b.close;
  const toRaw = rawScaler(input);

  const zoneAt = (k: number): PlatformZone | null => {
    if (k < 61) return null;
    const high = maxFinite(b.high, k - 30, k - 1);
    const low = minFinite(b.low, k - 30, k - 1);
    if (!isFin(high) || !isFin(low) || high <= 0) return null;
    const rangeWidth = (high - low) / high;

    const recentBase = close[k - 1];
    const priorBase = close[k - 11];
    if (!isFin(recentBase) || !isFin(priorBase) || recentBase === 0 || priorBase === 0) return null;
    const recent = close.slice(k - 10, k).map(v => v / recentBase);
    const prior = close.slice(k - 30, k - 10).map(v => v / priorBase);
    const recentSd = stdevAll(recent);
    const priorSd = stdevAll(prior);
    if (!isFin(recentSd) || !isFin(priorSd)) return null;

    const c21 = close[k - 21];
    const atr = x.atr14[k - 1];
    if (!isFin(c21) || c21 === 0 || !isFin(atr)) return null;

    if (!(rangeWidth <= 0.15)) return null;                    // (a) narrow enough
    if (!(recentSd <= 0.8 * priorSd)) return null;             // (b) contracting
    if (!(recentBase / c21 - 1 <= 0.25)) return null;          // (c) no rapid run-up
    if (!(atr / recentBase <= 0.06)) return null;
    return { high, low, rangeWidth };
  };

  const breakoutAt = (k: number): PlatformZone | null => {
    const zone = zoneAt(k);
    if (!zone) return null;
    if (!isFin(close[k]) || !isFin(b.vol[k]) || !isFin(x.volMa20[k])) return null;
    if (!(close[k] > zone.high)) return null;
    if (!(b.vol[k] >= 1.2 * x.volMa20[k])) return null;
    return zone;
  };

  const currentZone = zoneAt(i);
  const currentBreak = currentZone !== null && breakoutAt(i) !== null;

  const build = (
    stage: TechnicalStage, stage_detail: string, zone: PlatformZone,
    formedIdx: number, confirmedIdx: number,
    extra: Omit<ObservationParts, 'stage' | 'stage_detail'> = {},
  ): PatternObservation => makeObservation(input, 'pb_v2_platform_breakout', 'PLATFORM_BREAKOUT', {
    stage,
    stage_detail,
    pattern_event_date: stage === 'FORMING' ? b.dates[i] : b.dates[confirmedIdx],
    first_observed_date: stage === 'FORMING' ? b.dates[i] : b.dates[confirmedIdx],
    formed_on: b.dates[formedIdx],
    confirmed_on: b.dates[confirmedIdx],
    formation_basis: ['30 日平台振幅 ≤15%，近 10 日波动 ≤ 前 20 日的 0.8 倍，且非急涨'],
    confirmation_conditions: ['收盘突破平台高点，且成交量 ≥ 20 日均量 1.2 倍'],
    invalidation_conditions: ['收盘跌破平台高点 ×0.97 或跌破平台低点'],
    key_levels: {
      platform_high: toRaw(zone.high),
      platform_low: toRaw(zone.low),
      invalidation_level: toRaw(zone.high * 0.97),
    },
    evidence: {
      platform_high: toRaw(zone.high),
      platform_low: toRaw(zone.low),
      range_width: round4(zone.rangeWidth),
      volume_ratio: stage === 'FORMING' ? null
        : isFin(b.vol[confirmedIdx]) && isFin(x.volMa20[confirmedIdx]) && x.volMa20[confirmedIdx] > 0
          ? round4(b.vol[confirmedIdx] / x.volMa20[confirmedIdx]) : null,
      ...(extra.evidence ?? {}),
    },
    ...extra,
  });

  if (currentBreak) {
    return [build('CONFIRMED', 'BREAKOUT_CONFIRMED', currentZone as PlatformZone, i - 30, i)];
  }

  // Most recent earlier breakout; scan far enough to reach EXPIRED (20 bars).
  let confirmed = -1;
  for (let k = i - 1; k >= Math.max(61, i - 120); k--) {
    if (breakoutAt(k)) { confirmed = k; break; }
  }
  if (confirmed >= 0) {
    const zone = zoneAt(confirmed) as PlatformZone;
    const fail = firstWhere(confirmed, i, k => isFin(close[k]) && close[k] < zone.high * 0.97);
    if (fail >= 0) {
      return [build('FAILED', 'PLATFORM_BREAKOUT_FAILED', zone, confirmed - 30, confirmed, {
        invalidation: { on: b.dates[fail], reason: 'close_below_platform_high' },
        evidence: { bars_since_confirmation: i - confirmed, invalidation_close: round4(close[fail]) },
      })];
    }
    if (i - confirmed > 20) {
      return [build('EXPIRED', 'PLATFORM_BREAKOUT_EXPIRED', zone, confirmed - 30, confirmed, {
        evidence: { bars_since_confirmation: i - confirmed, expired: true },
      })];
    }
    if (isFin(close[i]) && close[i] > close[confirmed]) {
      return [build('FOLLOW_THROUGH', 'FOLLOW_THROUGH', zone, confirmed - 30, confirmed, {
        evidence: { bars_since_confirmation: i - confirmed },
      })];
    }
    return [];
  }

  // No breakout: a close inside the upper 3% of a valid platform is forming.
  if (currentZone && isFin(close[i])
    && close[i] >= currentZone.high * 0.97 && close[i] <= currentZone.high) {
    return [build('FORMING', 'PLATFORM_FORMING', currentZone, i - 30, i - 30, {
      confirmed_on: null,
      evidence: { close: round4(close[i]) },
    })];
  }
  return [];
}

// ---------------------------------------------------------------- C. reversal

/**
 * REVERSAL — MACD DIF price/DIF bottom divergence plus the retained DIF W bottom.
 *
 * Thresholds: swing lows L=3, K=3; gap 8–60 bars; DIF second low higher and
 * negative; neckline is the highest high between the lows; 40-bar evaluation
 * window after formation/confirmation.
 */
export function detectReversal(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 10) return [];
  const close = b.close;
  const dif = x.dif;
  const toRaw = rawScaler(input);
  const out: PatternObservation[] = [];
  const invalidConds = ['收盘跌破背离低点（两低点较低者）'];

  // ---- rv_v2_macd_dif_divergence
  const lows = confirmedLocalLows(b.low, i, { L: 3, K: 3 }, i - 180);
  let pair: { j1: number; j2: number } | null = null;
  for (let n = 0; n < lows.length - 1 && !pair; n++) {
    const j2 = lows[n].index;
    for (let m = n + 1; m < lows.length; m++) {
      const j1 = lows[m].index;
      const gap = j2 - j1;
      if (gap < 8) continue;
      if (gap > 60) break;
      if (!isFin(b.low[j1]) || !isFin(b.low[j2]) || !isFin(dif[j1]) || !isFin(dif[j2])) continue;
      if (!(b.low[j2] < b.low[j1])) continue;   // lower price low
      if (!(dif[j2] > dif[j1])) continue;       // higher DIF low
      if (!(dif[j2] < 0)) continue;             // still below the zero line
      pair = { j1, j2 };
      break;
    }
  }

  if (pair) {
    const { j1, j2 } = pair;
    const formationIdx = j2 + 3;
    const neckline = maxFinite(b.high, j1 + 1, j2 - 1);
    if (formationIdx <= i && isFin(neckline) && neckline > b.low[j2]) {
      const divergenceLow = Math.min(b.low[j1], b.low[j2]);
      const fail = firstWhere(formationIdx, i, k => isFin(close[k]) && close[k] < divergenceLow);
      const confirm = firstWhere(formationIdx, i, k => isFin(close[k]) && close[k] > neckline);
      const base = {
        pattern_event_date: b.dates[j2],
        first_observed_date: b.dates[formationIdx],
        formed_on: b.dates[formationIdx],
        formation_basis: [
          `价格低点 ${b.dates[j2]} < ${b.dates[j1]}，但 DIF 低点抬高`,
        ],
        confirmation_conditions: ['收盘越过两低点之间的颈线'],
        invalidation_conditions: invalidConds,
        key_levels: {
          neckline: toRaw(neckline),
          divergence_low: toRaw(divergenceLow),
          first_low: toRaw(b.low[j1]),
          second_low: toRaw(b.low[j2]),
        },
        evidence: {
          first_low_date: b.dates[j1],
          second_low_date: b.dates[j2],
          first_low: toRaw(b.low[j1]),
          second_low: toRaw(b.low[j2]),
          dif_first_low: round4(dif[j1]),
          dif_second_low: round4(dif[j2]),
          neckline: toRaw(neckline),
          rsi_divergence: isFin(x.rsi14[j1]) && isFin(x.rsi14[j2]) ? x.rsi14[j2] > x.rsi14[j1] : null,
        },
      };
      if (fail >= 0) {
        out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', {
          ...base, stage: 'FAILED', stage_detail: 'DIF_DIVERGENCE_FAILED',
          confirmed_on: confirm >= 0 ? b.dates[confirm] : null,
          invalidation: { on: b.dates[fail], reason: 'close_below_divergence_low' },
        }));
      } else if (confirm >= 0) {
        if (i - confirm > 40) {
          out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', {
            ...base, stage: 'EXPIRED', stage_detail: 'DIF_DIVERGENCE_EXPIRED',
            confirmed_on: b.dates[confirm],
            evidence: { ...base.evidence, bars_since_confirmation: i - confirm, expired: true },
          }));
        } else {
          out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', {
            ...base,
            stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
            stage_detail: 'DIF_DIVERGENCE_CONFIRMED',
            confirmed_on: b.dates[confirm],
            evidence: { ...base.evidence, bars_since_confirmation: i - confirm },
          }));
        }
      } else if (i - formationIdx > 40) {
        out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', {
          ...base, stage: 'EXPIRED', stage_detail: 'DIF_DIVERGENCE_EXPIRED',
          confirmed_on: null,
          evidence: { ...base.evidence, bars_since_formation: i - formationIdx, expired: true },
        }));
      } else {
        out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', {
          ...base, stage: 'FORMING', stage_detail: 'DIVERGENCE_FORMING',
          confirmed_on: null,
          evidence: { ...base.evidence, dif_at_end: round4(dif[i]) },
        }));
      }
    }
  }

  // ---- rv_v2_macd_w_bottom
  const w = detectWBottom(dif, i, DEFAULT_MACD_W_OPTS);
  if (w) {
    // The second low is only a *confirmed* swing low `L` bars to its right, so
    // the pair is unknowable before then even if the neckline cross came
    // earlier. Both the visibility date and the confirmation date respect that.
    const firstObsIdx = Math.max(w.confirmIndex, w.j2 + DEFAULT_MACD_W_OPTS.L);
    const base = {
      pattern_event_date: b.dates[w.j2],
      first_observed_date: b.dates[firstObsIdx],
      formed_on: b.dates[firstObsIdx],
      confirmed_on: b.dates[firstObsIdx],
      formation_basis: [`DIF 双底 ${b.dates[w.j1]} / ${b.dates[w.j2]}，颈线 ${round4(w.neckline)}`],
      confirmation_conditions: ['DIF 上穿两低点之间的颈线'],
      invalidation_conditions: ['DIF 跌破两个低点'],
      key_levels: {
        neckline_dif: round4(w.neckline),
        first_low_dif: round4(w.firstLow),
        second_low_dif: round4(w.secondLow),
      },
      evidence: {
        first_low_date: b.dates[w.j1],
        second_low_date: b.dates[w.j2],
        first_low: round4(w.firstLow),
        second_low: round4(w.secondLow),
        neckline: round4(w.neckline),
      },
    };
    if (i === firstObsIdx) {
      out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', {
        ...base, stage: 'CONFIRMED', stage_detail: 'DIF_W_CONFIRMED',
      }));
    } else if (w.invalidateIndex !== null) {
      out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', {
        ...base, stage: 'FAILED', stage_detail: 'DIF_W_INVALIDATED',
        invalidated_at: b.dates[Math.max(w.invalidateIndex, firstObsIdx)],
        invalidation: { on: b.dates[Math.max(w.invalidateIndex, firstObsIdx)], reason: 'dif_w_invalidated' },
        evidence: { ...base.evidence, invalidate_below: round4(w.invalidateBelow) },
      }));
    } else if (i - firstObsIdx > 40) {
      out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', {
        ...base, stage: 'EXPIRED', stage_detail: 'DIF_W_CONFIRMED',
        evidence: { ...base.evidence, bars_since_confirmation: i - firstObsIdx, expired: true },
      }));
    } else {
      out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', {
        ...base, stage: 'FOLLOW_THROUGH', stage_detail: 'DIF_W_CONFIRMED',
        evidence: { ...base.evidence, bars_since_confirmation: i - firstObsIdx },
      }));
    }
  } else {
    // FORMING W: same pair test as `detectForming` in strategies.ts (local copy,
    // because that helper is intentionally not exported).
    const opts = DEFAULT_MACD_W_OPTS;
    const difLows = confirmedLocalLows(dif, i, opts, i - opts.lookback - opts.L);
    outer:
    for (let n = 0; n < difLows.length - 1; n++) {
      const j2 = difLows[n].index;
      for (let m = n + 1; m < difLows.length; m++) {
        const j1 = difLows[m].index;
        const gap = j2 - j1;
        if (gap < opts.minGap) continue;
        if (gap > opts.maxGap) break;
        const v1 = dif[j1];
        const v2 = dif[j2];
        if (!isFin(v1) || !isFin(v2)) continue;
        if (v1 > opts.lowCeiling || v2 > opts.lowCeiling) continue;
        const scale = Math.max(Math.abs(v1), Math.abs(v2));
        if (!(Math.abs(v2 - v1) <= opts.relTol * scale)) continue;
        const neckline = maxFinite(dif, j1 + 1, j2 - 1);
        if (!isFin(neckline) || !(neckline > v1 && neckline > v2)) continue;
        if (isFin(dif[i]) && dif[i] <= neckline) {
          out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', {
            stage: 'FORMING', stage_detail: 'DIF_W_FORMING',
            pattern_event_date: b.dates[j2],
            first_observed_date: b.dates[j2 + opts.L],
            formed_on: b.dates[j2 + opts.L], confirmed_on: null,
            formation_basis: [`DIF 双底 ${b.dates[j1]} / ${b.dates[j2]}，尚未越过颈线`],
            confirmation_conditions: ['DIF 上穿两低点之间的颈线'],
            invalidation_conditions: ['DIF 跌破两个低点'],
            key_levels: { neckline_dif: round4(neckline), first_low_dif: round4(v1), second_low_dif: round4(v2) },
            evidence: {
              first_low_date: b.dates[j1], second_low_date: b.dates[j2],
              first_low: round4(v1), second_low: round4(v2), neckline: round4(neckline),
              dif_at_end: round4(dif[i]),
            },
          }));
        }
        break outer;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------- D. volatility expansion

/**
 * VOLATILITY_EXPANSION — bollinger squeeze breakout and a sustained upper-band
 * ride.
 *
 * Thresholds (research hypotheses): squeeze = width ≤ 20th percentile of the
 * prior 120 bars (at least 100 finite); breakout = close crosses above the
 * upper band within 5 bars of a squeeze; ride = ≥3 of the last 5 closes at or
 * above the upper band while width exceeds its 120-bar median. Touching the
 * upper band is never a sell instruction.
 */
export function detectVolatilityExpansion(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 61) return [];
  const close = b.close;
  const toRaw = rawScaler(input);
  const out: PatternObservation[] = [];

  const squeezeAt = (k: number): { level: number; width: number } | null => {
    if (k < 120) return null;
    const window = x.bollWidth.slice(Math.max(0, k - 120), k).filter(isFin);
    if (window.length < 100) return null;
    const level = percentile20(window);
    const width = x.bollWidth[k];
    if (!isFin(level) || !isFin(width)) return null;
    return width <= level ? { level, width } : null;
  };

  const recentSqueeze = (from: number, to: number): number => lastWhere(from, to, k => squeezeAt(k) !== null);

  const breakoutAt = (k: number): boolean => {
    if (k < 121 || !isFin(close[k]) || !isFin(close[k - 1]) || !isFin(x.bollUp[k]) || !isFin(x.bollUp[k - 1])) return false;
    if (!(close[k] > x.bollUp[k] && close[k - 1] <= x.bollUp[k - 1])) return false;
    return recentSqueeze(k - 5, k - 1) >= 0;
  };

  // ---- ve_v2_boll_squeeze_breakout
  const squeezeBreak = breakoutAt(i);
  const currentSqueeze = recentSqueeze(i - 5, i);


  const bandLevels = (k: number): Record<string, number | null> => ({
    boll_up: toRaw(x.bollUp[k]),
    boll_mid: toRaw(x.bollMid[k]),
    boll_low: toRaw(x.bollLow[k]),
  });

  if (squeezeBreak) {
    const sq = recentSqueeze(i - 5, i - 1);
    out.push(makeObservation(input, 've_v2_boll_squeeze_breakout', 'VOLATILITY_EXPANSION', {
      stage: 'CONFIRMED', stage_detail: 'SQUEEZE_BREAKOUT',
      pattern_event_date: b.dates[i], first_observed_date: b.dates[i],
      formed_on: b.dates[sq], confirmed_on: b.dates[i],
      formation_basis: ['布林带宽处于近 120 日 20% 分位（收口）'],
      confirmation_conditions: ['收盘上穿上轨，且前一日收盘不高于上轨'],
      invalidation_conditions: ['收盘跌破布林中轨'],
      key_levels: bandLevels(i),
      evidence: {
        squeeze_date: b.dates[sq],
        squeeze_level: squeezeAt(sq)?.level != null ? round4(squeezeAt(sq)!.level) : null,
        boll_width: round4(x.bollWidth[i]),
        boll_up: round4(x.bollUp[i]),
        close: round4(close[i]),
      },
    }));
  } else {
    let confirmed = -1;
    for (let k = i - 1; k >= Math.max(121, i - 60); k--) {
      if (breakoutAt(k)) { confirmed = k; break; }
    }
    if (confirmed >= 0) {
      const sq = recentSqueeze(confirmed - 5, confirmed - 1);
      const fail = firstWhere(confirmed, i, k => isFin(close[k]) && isFin(x.bollMid[k]) && close[k] < x.bollMid[k]);
      const tail = (extra: ObservationParts): PatternObservation => makeObservation(input, 've_v2_boll_squeeze_breakout', 'VOLATILITY_EXPANSION', {
        stage: extra.stage, stage_detail: extra.stage_detail ?? 'EXPANSION_FOLLOW_THROUGH',
        pattern_event_date: b.dates[confirmed], first_observed_date: b.dates[confirmed],
        formed_on: b.dates[sq], confirmed_on: b.dates[confirmed],
        formation_basis: ['布林带宽处于近 120 日 20% 分位（收口）'],
        confirmation_conditions: ['收盘上穿上轨'],
        invalidation_conditions: ['收盘跌破布林中轨'],
        key_levels: bandLevels(i),
        evidence: {
          squeeze_date: b.dates[sq],
          boll_width_at_confirmation: round4(x.bollWidth[confirmed]),
          boll_width: round4(x.bollWidth[i]),
          bars_since_confirmation: i - confirmed,
          ...(extra.evidence ?? {}),
        },
        invalidation: extra.invalidation ?? null,
      });
      if (fail >= 0) {
        out.push(tail({ stage: 'FAILED', stage_detail: 'SQUEEZE_BREAKOUT_FAILED',
          invalidation: { on: b.dates[fail], reason: 'close_below_boll_mid' } }));
      } else if (i - confirmed > 20) {
        out.push(tail({ stage: 'EXPIRED', stage_detail: 'EXPANSION_FOLLOW_THROUGH', evidence: { expired: true } }));
      } else {
        let staysAboveMid = true;
        for (let k = confirmed; k <= i; k++) {
          if (!isFin(close[k]) || !isFin(x.bollMid[k]) || close[k] < x.bollMid[k]) { staysAboveMid = false; break; }
        }
        const expanding = isFin(x.bollWidth[i]) && isFin(x.bollWidth[confirmed]) && x.bollWidth[i] > x.bollWidth[confirmed];
        if (staysAboveMid && expanding) {
          out.push(tail({ stage: 'FOLLOW_THROUGH', stage_detail: 'EXPANSION_FOLLOW_THROUGH' }));
        }
      }
    } else if (currentSqueeze >= 0 && isFin(close[i]) && isFin(x.bollUp[i]) && isFin(x.bollMid[i])
      && close[i] <= x.bollUp[i] && close[i] > x.bollMid[i]) {
      out.push(makeObservation(input, 've_v2_boll_squeeze_breakout', 'VOLATILITY_EXPANSION', {
        stage: 'FORMING', stage_detail: 'SQUEEZE_FORMING',
        pattern_event_date: b.dates[currentSqueeze], first_observed_date: b.dates[currentSqueeze],
        formed_on: b.dates[currentSqueeze], confirmed_on: null,
        formation_basis: ['布林带宽处于近 120 日 20% 分位（收口）'],
        confirmation_conditions: ['收盘上穿上轨，且前一日收盘不高于上轨'],
        invalidation_conditions: ['收盘跌破布林中轨'],
        key_levels: bandLevels(i),
        evidence: {
          squeeze_date: b.dates[currentSqueeze],
          squeeze_level: squeezeAt(currentSqueeze)?.level != null ? round4(squeezeAt(currentSqueeze)!.level) : null,
          boll_width: round4(x.bollWidth[i]),
          boll_up: round4(x.bollUp[i]),
          close: round4(close[i]),
        },
      }));
    }
  }

  // ---- ve_v2_boll_upper_ride
  const background = (k: number): boolean => k >= 60
    && isFin(close[k]) && isFin(x.ma20[k]) && isFin(x.ma60[k]) && isFin(x.ma20[k - 5])
    && close[k] > x.ma20[k] && x.ma20[k] > x.ma60[k] && x.ma20[k] > x.ma20[k - 5];

  const touchesIn = (k: number): number => {
    let n = 0;
    for (let j = Math.max(0, k - 4); j <= k; j++) {
      if (isFin(close[j]) && isFin(x.bollUp[j]) && close[j] >= x.bollUp[j]) n++;
    }
    return n;
  };

  const rideAt = (k: number): boolean => {
    if (k < 4 || !isFin(x.bollWidth[k])) return false;
    if (touchesIn(k) < 3) return false;
    const widths = x.bollWidth.slice(Math.max(0, k - 120), k).filter(isFin);
    if (widths.length < 100) return false;
    const med = medianFinite(widths);
    return isFin(med) && x.bollWidth[k] > med;
  };

  const rideStart = (k: number): boolean => k >= 1 && rideAt(k) && !rideAt(k - 1) && background(k);

  const latestRide = rideStart(i)
    ? i
    : lastWhere(Math.max(1, i - 120), i - 1, k => rideStart(k));

  if (latestRide >= 0 && background(i)) {
    const fail = firstWhere(latestRide, i, k => isFin(close[k]) && isFin(x.bollMid[k]) && close[k] < x.bollMid[k]);
    const base = {
      pattern_event_date: b.dates[latestRide],
      first_observed_date: b.dates[latestRide],
      formed_on: b.dates[latestRide],
      confirmed_on: b.dates[latestRide],
      formation_basis: ['上升趋势中，近 5 日至少 3 日收盘触及/站上布林上轨，且带宽高于 120 日中位数'],
      confirmation_conditions: ['上轨骑行条件首次成立'],
      invalidation_conditions: ['收盘跌破布林中轨（触碰上轨不是卖出信号）'],
      key_levels: bandLevels(i),
      evidence: {
        upper_band_touches: touchesIn(i),
        boll_width: round4(x.bollWidth[i]),
        width_median_120: round4(medianFinite(x.bollWidth.slice(Math.max(0, i - 120), i).filter(isFin))),
        touching_upper_band_is_not_a_sell_signal: true,
      },
    };
    if (fail >= 0) {
      out.push(makeObservation(input, 've_v2_boll_upper_ride', 'VOLATILITY_EXPANSION', {
        ...base, stage: 'FAILED', stage_detail: 'UPPER_BAND_RIDE_FAILED',
        invalidation: { on: b.dates[fail], reason: 'close_below_boll_mid' },
        evidence: { ...base.evidence, boll_mid: round4(x.bollMid[i]) },
      }));
    } else if (i - latestRide > 20) {
      out.push(makeObservation(input, 've_v2_boll_upper_ride', 'VOLATILITY_EXPANSION', {
        ...base, stage: 'EXPIRED', stage_detail: 'UPPER_BAND_RIDE',
        evidence: { ...base.evidence, bars_since_confirmation: i - latestRide, expired: true },
      }));
    } else if (isFin(close[i]) && isFin(x.bollMid[i]) && close[i] > x.bollMid[i]) {
      out.push(makeObservation(input, 've_v2_boll_upper_ride', 'VOLATILITY_EXPANSION', {
        ...base,
        stage: latestRide === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
        stage_detail: 'UPPER_BAND_RIDE',
        evidence: { ...base.evidence, bars_since_confirmation: i - latestRide },
      }));
    }
  }

  return out;
}

// ---------------------------------------------------------------- E. mean reversion

/**
 * MEAN_REVERSION — oversold observation and lower-band re-entry, restricted to
 * a range/neutral environment. Thresholds (research hypotheses): close within
 * 1% of the lower band or RSI14 < 30; re-entry confirmation within 5 bars,
 * 10-bar follow window.
 */
export function detectMeanReversion(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 1) return [];
  const close = b.close;
  const toRaw = rawScaler(input);

  const obsAt = (k: number): boolean => (isFin(close[k]) && isFin(x.bollLow[k]) && close[k] <= x.bollLow[k] * 1.01)
    || (isFin(x.rsi14[k]) && x.rsi14[k] < 30);

  const latestObs = lastWhere(Math.max(0, i - 5), i, k => obsAt(k));

  // Environment: range regime, or "not a confirmed downtrend". A market
  // downtrend with close < MA60 and a falling MA20 is never a reversion buy.
  const ma20Falling = isFin(x.ma20[i]) && isFin(x.ma20[i - 10]) && x.ma20[i] < x.ma20[i - 10];
  const belowMa60 = isFin(close[i]) && isFin(x.ma60[i]) && close[i] < x.ma60[i];
  const backgroundDown = ma20Falling && belowMa60;
  const rangeEnvironment = input.regime === 'range' || !backgroundDown;

  const bandLevels = (k: number): Record<string, number | null> => ({
    boll_low: toRaw(x.bollLow[k]),
    boll_mid: toRaw(x.bollMid[k]),
    rsi14: round4(x.rsi14[k]),
  });

  if (!rangeEnvironment) {
    if (latestObs < 0) return [];
    return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
      stage: 'FORMING', stage_detail: 'OVERSOLD_IN_DOWNTREND',
      formed_on: b.dates[latestObs], confirmed_on: null,
      counter_evidence: ['下跌趋势仍在：超卖只作逆势观察，不构成低风险机会'],
      formation_basis: ['下跌趋势中出现超卖（收盘 ≤ 布林下轨 ×1.01 或 RSI14 < 30）'],
      confirmation_conditions: [],
      invalidation_conditions: ['收盘跌破超卖区低点', '超卖不等于低风险机会'],
      key_levels: bandLevels(i),
      evidence: {
        counter_trend_observation: true,
        observation_date: b.dates[latestObs],
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
      },
    })];
  }

  const confirmObsAt = (k: number): number => {
    if (k < 1) return -1;
    if (!(isFin(close[k]) && isFin(x.bollLow[k]) && isFin(close[k - 1]) && isFin(x.rsi14[k]) && isFin(x.rsi14[k - 1]))) return -1;
    if (!(close[k] > x.bollLow[k] && close[k] > close[k - 1] && x.rsi14[k] >= x.rsi14[k - 1])) return -1;
    return lastWhere(Math.max(0, k - 5), k, j => obsAt(j));
  };

  // Current re-entry confirmation.
  if (latestObs >= 0 && confirmObsAt(i) >= 0) {
    return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
      stage: 'CONFIRMED', stage_detail: 'BAND_REENTRY_CONFIRMED',
      pattern_event_date: b.dates[latestObs], first_observed_date: b.dates[i],
      formed_on: b.dates[latestObs], confirmed_on: b.dates[i],
      formation_basis: ['震荡环境中出现超卖观察（布林下轨附近或 RSI14 < 30）'],
      confirmation_conditions: ['收盘高于下轨、高于前一日收盘，且 RSI14 不低于前一日'],
      invalidation_conditions: ['收盘跌破超卖区低点'],
      key_levels: bandLevels(i),
      evidence: {
        observation_date: b.dates[latestObs],
        counter_trend_observation: false,
        band_observation: isFin(close[i]) && isFin(x.bollLow[i]) && close[i] <= x.bollLow[i] * 1.01,
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
      },
    })];
  }

  // Prior confirmation: follow / fail / expire.
  let confirmed = -1;
  let confirmedObs = -1;
  for (let k = i - 1; k >= Math.max(1, i - 60); k--) {
    const o = confirmObsAt(k);
    if (o >= 0) { confirmed = k; confirmedObs = o; break; }
  }
  if (confirmed >= 0) {
    const observationLow = minFinite(b.low, confirmedObs, i);
    const failed = isFin(observationLow) && isFin(close[i]) && close[i] < observationLow;
    const base = {
      pattern_event_date: b.dates[confirmedObs],
      first_observed_date: b.dates[confirmed],
      formed_on: b.dates[confirmedObs], confirmed_on: b.dates[confirmed],
      formation_basis: ['震荡环境中出现超卖观察（布林下轨附近或 RSI14 < 30）'],
      confirmation_conditions: ['收盘高于下轨、高于前一日收盘，且 RSI14 不低于前一日'],
      invalidation_conditions: ['收盘跌破超卖区低点'],
      key_levels: bandLevels(i),
      evidence: {
        observation_date: b.dates[confirmedObs],
        counter_trend_observation: false,
        reached_mid_band: isFin(close[i]) && isFin(x.bollMid[i]) && close[i] >= x.bollMid[i],
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
        bars_since_confirmation: i - confirmed,
      },
    };
    if (failed) {
      return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
        ...base, stage: 'FAILED', stage_detail: 'REVERSION_FAILED',
        invalidation: { on: b.dates[i], reason: 'new_low_after_oversold' },
        evidence: { ...base.evidence, observation_low: toRaw(observationLow) },
      })];
    }
    if (i - confirmed > 10) {
      return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
        ...base, stage: 'EXPIRED', stage_detail: 'REVERSION_EXPIRED',
        evidence: { ...base.evidence, expired: true },
      })];
    }
    return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
      ...base, stage: 'FOLLOW_THROUGH', stage_detail: 'REVERSION_FOLLOW_THROUGH',
    })];
  }

  // Range environment, oversold today, no re-entry yet.
  if (obsAt(i)) {
    return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
      stage: 'FORMING', stage_detail: 'OVERSOLD_OBSERVATION',
      formed_on: b.dates[i], confirmed_on: null,
      formation_basis: ['震荡环境中出现超卖观察（布林下轨附近或 RSI14 < 30）'],
      confirmation_conditions: ['收盘高于下轨、高于前一日收盘，且 RSI14 不低于前一日'],
      invalidation_conditions: ['收盘跌破超卖区低点'],
      key_levels: bandLevels(i),
      evidence: {
        observation_date: b.dates[i],
        counter_trend_observation: false,
        band_observation: isFin(close[i]) && isFin(x.bollLow[i]) && close[i] <= x.bollLow[i] * 1.01,
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
      },
    })];
  }
  return [];
}

// ---------------------------------------------------------------- aggregate

/** All families, in the frozen family order. Purely concatenates detectors. */
export function detectAllPatterns(input: PatternInput): PatternObservation[] {
  return [
    ...detectTrendContinuation(input),
    ...detectPlatformBreakout(input),
    ...detectReversal(input),
    ...detectVolatilityExpansion(input),
    ...detectMeanReversion(input),
  ];
}
