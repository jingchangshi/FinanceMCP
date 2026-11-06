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
import {
  buildPricePosition,
  type PatternInput, type PatternObservation, type TechnicalFamily, type TechnicalStage,
} from './technicalFrameworkV2.js';
import {
  confirmedLocalLows, detectPullbackForming, detectPullbackResume, detectWBottom,
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
    '上升趋势内收盘回踩 MA20（前一日收盘 ≤ MA20、low 触及 MA20）后重新收上 MA20；'
    + '趋势背景须在回踩时已存在，当日才形成的 MA20/MA60 多头排列不算；失效为收盘跌破 MA60。',
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
  /** Adjusted reference price for the descriptive PricePosition (never a raw key level). */
  reference_price?: number | null;
  reference_kind?: string | null;
  /** Adjusted price invalidation level; null when the invalidation is not a price (e.g. DIF). */
  invalidation_level?: number | null;
  /** Confirmation bar index; null while the observation is unconfirmed. */
  confirmed_idx?: number | null;
}

function makeObservation(
  input: PatternInput, strategy_id: string, family: TechnicalFamily, parts: ObservationParts,
): PatternObservation {
  const eventDate = parts.pattern_event_date ?? parts.confirmed_on ?? parts.formed_on ?? null;
  const confirmedIdx = parts.confirmed_idx !== undefined
    ? parts.confirmed_idx
    : (parts.confirmed_on ? input.bars.dates.indexOf(parts.confirmed_on) : null);
  return {
    strategy_id,
    family,
    stage: parts.stage,
    stage_detail: parts.stage_detail,
    pattern_event_date: eventDate,
    first_observed_date: parts.first_observed_date ?? parts.confirmed_on ?? parts.formed_on
      ?? input.bars.dates[input.endIdx],
    invalidated_at: parts.invalidated_at ?? (parts.stage === 'FAILED' ? parts.invalidation?.on ?? null : null),
    // EXPIRED must name the first bar the window elapsed; never default to the
    // evaluation bar (goal-1106 WP3).
    expires_at: parts.expires_at ?? null,
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
    price_position: buildPricePosition({
      close: input.bars.close[input.endIdx],
      x: input.x,
      endIdx: input.endIdx,
      confirmedIdx,
      referencePrice: parts.reference_price ?? null,
      referenceKind: parts.reference_kind ?? null,
      invalidationLevel: parts.invalidation_level ?? null,
    }),
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

// ---------------------------------------------------------------- episode walk

/**
 * One candidate formation. `visibleFrom` is the earliest bar at which the
 * formation is provable from data <= that bar; `eventIdx` is the price-event
 * bar the episode is about (a touch, a second low, a platform start...).
 */
interface Formation {
  eventIdx: number;
  visibleFrom: number;
}

/** Everything an episode knows before its stage is decided at the reporting bar. */
type EpisodeBase = Omit<ObservationParts, 'stage' | 'stage_detail'>;

interface ResolvedEpisode {
  parts: ObservationParts;
  /** First fail/expiry bar, or null while the episode is still live / forming. */
  terminalIdx: number | null;
}

/**
 * Forward episode walk (goal-1106 WP2 rules 5 and 8).
 *
 * Formations are enumerated chronologically. The EARLIEST formation is
 * followed to its first terminal event (fail or expiry); only a formation whose
 * own event bar lies strictly after that terminal may begin next. The last
 * episode is reported — live if it has no terminal, otherwise the most recent
 * terminal one. An observed episode is never re-dated and a live episode is
 * never replaced by a newer structure that formed underneath it.
 */
function walkEpisodes<F extends Formation>(
  formations: F[], end: number, resolve: (f: F) => ResolvedEpisode,
): ResolvedEpisode | null {
  let cursor = -Infinity;
  let last: ResolvedEpisode | null = null;
  for (const f of formations) {
    if (f.visibleFrom > end) break;
    if (f.eventIdx <= cursor) continue;
    const ep = resolve(f);
    last = ep;
    if (ep.terminalIdx === null) return ep;
    cursor = ep.terminalIdx;
  }
  return last;
}

// ---------------------------------------------------------------- A. trend continuation

/**
 * TREND_CONTINUATION — a pullback-to-MA20 resume inside an established trend.
 *
 * Thresholds (goal-1106 WP1): a close-based pullback of at most 5 bars
 * (close <= MA20) whose low tags MA20 within 1%; price above MA20 before the
 * pullback; MA20 > MA60 and MA20 rising AT THE TOUCH (strictly before the
 * reclaim, so same-day alignment cannot fake a pre-existing trend). The
 * reclaim bar is the first bar closing back above MA20, up on the day. The
 * 10-bar evaluation window starts at that confirmation bar.
 *
 * A bullish MA20 > MA60 alignment is background context, never a standalone
 * event: the family only dates a pullback into MA20 and its later resume.
 * That is why there is no `trend_established` confirmation here (A01 / D13).
 */
export function detectTrendContinuation(input: PatternInput): PatternObservation[] {
  const { bars: b, x, endIdx: i } = input;
  if (i < 61) return [];
  const close = b.close;
  const ma20 = x.ma20;
  const ma60 = x.ma60;
  const toRaw = rawScaler(input);
  const opts = DEFAULT_PULLBACK_OPTS;
  const rpsEvidence = { rps_background_only: true, rps120: rpsValue(input) };

  // ---- tc_v2_pullback_resume
  // One formation per pullback run, dated at its FIRST MA20 tag. The tag is
  // provable on its own bar, so the episode cannot drift as later bars keep
  // tagging the average.
  interface PullbackFormation extends Formation { startIdx: number; touchIdx: number }
  const formations: PullbackFormation[] = [];
  const seenStarts = new Set<number>();
  for (let k = 61; k <= i; k++) {
    const ep = detectPullbackForming(close, b.low, ma20, ma60, k, opts);
    if (!ep || seenStarts.has(ep.pullbackStartIndex)) continue;
    seenStarts.add(ep.pullbackStartIndex);
    formations.push({
      eventIdx: ep.touchIndex,
      visibleFrom: ep.touchIndex,
      startIdx: ep.pullbackStartIndex,
      touchIdx: ep.touchIndex,
    });
  }
  formations.sort((a, b) => a.eventIdx - b.eventIdx);

  const resolved = walkEpisodes(formations, i, (f): ResolvedEpisode => {
    const { startIdx: s, touchIdx: t } = f;
    // A confirmation must be a first close-cross back above MA20 while the
    // pullback is still at most `touchWindow` bars old.
    const confirmEnd = Math.min(i, s + opts.touchWindow);
    let confirm = -1;
    for (let c = t + 1; c <= confirmEnd; c++) {
      const r = detectPullbackResume(close, b.low, ma20, ma60, c, opts);
      if (r && r.pullbackStartIndex === s && r.touchIndex === t) { confirm = c; break; }
    }
    const levelIdx = confirm >= 0 ? confirm : t;
    const common: EpisodeBase = {
      pattern_event_date: b.dates[t],
      first_observed_date: b.dates[t],
      formed_on: b.dates[t],
      confirmed_on: confirm >= 0 ? b.dates[confirm] : null,
      confirmed_idx: confirm >= 0 ? confirm : null,
      reference_price: ma20[levelIdx], reference_kind: 'ma20_reclaim',
      invalidation_level: isFin(ma60[levelIdx]) ? ma60[levelIdx] : null,
      formation_basis: ['上升趋势中，收盘回踩 MA20（前一日收盘 ≤ MA20，low 触及 MA20）'],
      confirmation_conditions: ['前一日收盘 ≤ MA20，当日收盘 > MA20 且高于前一日收盘'],
      invalidation_conditions: ['收盘跌破 MA60'],
      key_levels: { ma20: toRaw(ma20[levelIdx]), ma60: toRaw(ma60[levelIdx]), touch_low: toRaw(b.low[t]) },
      evidence: {
        ...rpsEvidence,
        touch_date: b.dates[t],
        pullback_start_date: b.dates[s],
        ma20: round4(ma20[t]),
        confirmation_lag: confirm >= 0 ? confirm - t : null,
        bars_since_confirmation: confirm >= 0 ? i - confirm : null,
      },
    };

    // First event decides: a close below MA60 before the reclaim kills the
    // setup and it can never confirm later. The touch bar itself is the first
    // bar the setup is provable on, so a close below MA60 there counts.
    const failBefore = (isFin(close[t]) && isFin(ma60[t]) && close[t] < ma60[t]) ? t
      : firstWhere(t, confirmEnd, k => isFin(close[k]) && isFin(ma60[k]) && close[k] < ma60[k]);
    if (failBefore >= 0 && (confirm < 0 || failBefore < confirm)) {
      return {
        terminalIdx: failBefore,
        parts: {
          ...common, stage: 'FAILED', stage_detail: 'PULLBACK_RESUME',
          // The instance died before any confirmation: it can never confirm
          // later, so no confirmation date may be emitted (WP2 inversion fix).
          confirmed_on: null, confirmed_idx: null,
          invalidation: { on: b.dates[failBefore], reason: 'close_below_ma60' },
          evidence: {
            ...common.evidence,
            confirmation_lag: null,
            bars_since_confirmation: null,
            invalidation_close: round4(close[failBefore]),
          },
        },
      };
    }

    if (confirm >= 0) {
      const failAfter = firstWhere(confirm, Math.min(i, confirm + 10),
        k => isFin(close[k]) && isFin(ma60[k]) && close[k] < ma60[k]);
      if (failAfter >= 0) {
        return {
          terminalIdx: failAfter,
          parts: {
            ...common, stage: 'FAILED', stage_detail: 'PULLBACK_RESUME',
            invalidation: { on: b.dates[failAfter], reason: 'close_below_ma60' },
            evidence: { ...common.evidence, invalidation_close: round4(close[failAfter]) },
          },
        };
      }
      const expiresIdx = confirm + 11; // first bar with `i - confirm > 10`
      if (i >= expiresIdx) {
        return {
          terminalIdx: expiresIdx,
          parts: {
            ...common, stage: 'EXPIRED', stage_detail: 'PULLBACK_RESUME',
            expires_at: b.dates[expiresIdx],
            evidence: { ...common.evidence, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: {
          ...common,
          stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
          stage_detail: 'PULLBACK_RESUME',
        },
      };
    }

    // No reclaim inside the pullback window: the setup simply ages out.
    const expiresIdx = s + opts.touchWindow + 1;
    if (i >= expiresIdx) {
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...common, stage: 'EXPIRED', stage_detail: 'PULLBACK_TO_MA20',
          expires_at: b.dates[expiresIdx],
          evidence: { ...common.evidence, expired: true },
        },
      };
    }
    return {
      terminalIdx: null,
      parts: {
        ...common, stage: 'FORMING', stage_detail: 'PULLBACK_TO_MA20',
        reference_kind: 'ma20_reclaim_level',
        evidence: { ...common.evidence, close: round4(close[i]) },
      },
    };
  });

  return resolved
    ? [makeObservation(input, 'tc_v2_pullback_resume', 'TREND_CONTINUATION', resolved.parts)]
    : [];
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

  // Every platform from a FIXED start of the loaded history: a bar's zone
  // depends only on bars before it, so a platform keeps its identity as the
  // as-of advances.
  const zones: (PlatformZone | null)[] = new Array(i + 1).fill(null);
  for (let k = 61; k <= i; k++) zones[k] = zoneAt(k);

  const breakoutAt = (k: number): boolean => {
    const zone = zones[k];
    if (!zone) return false;
    if (!isFin(close[k]) || !isFin(b.vol[k]) || !isFin(x.volMa20[k])) return false;
    if (!(close[k] > zone.high)) return false;
    return b.vol[k] >= 1.2 * x.volMa20[k];
  };

  interface PlatformFormation extends Formation { zone: PlatformZone }
  const formations: PlatformFormation[] = [];
  for (let k = 61; k <= i; k++) {
    const zone = zones[k];
    if (!zone) continue;
    if (k > 61 && zones[k - 1]) continue; // inside the same platform run
    formations.push({ eventIdx: k, visibleFrom: k, zone });
  }

  const resolved = walkEpisodes(formations, i, (f): ResolvedEpisode => {
    let confirm = -1;
    let runEnd = -1;
    for (let k = f.eventIdx; k <= i; k++) {
      if (!zones[k]) { runEnd = k; break; } // the platform aged out first
      if (breakoutAt(k)) { confirm = k; break; }
    }
    const zone = confirm >= 0 ? (zones[confirm] as PlatformZone) : f.zone;
    const common: EpisodeBase = {
      pattern_event_date: b.dates[f.eventIdx],
      first_observed_date: b.dates[f.eventIdx],
      formed_on: b.dates[Math.max(0, f.eventIdx - 30)],
      confirmed_on: confirm >= 0 ? b.dates[confirm] : null,
      confirmed_idx: confirm >= 0 ? confirm : null,
      reference_price: zone.high, reference_kind: 'platform_high',
      invalidation_level: zone.high * 0.97,
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
        volume_ratio: confirm >= 0 && isFin(b.vol[confirm]) && isFin(x.volMa20[confirm]) && x.volMa20[confirm] !== 0
          ? round4(b.vol[confirm] / x.volMa20[confirm]) : null,
        bars_since_confirmation: confirm >= 0 ? i - confirm : null,
      },
    };

    if (confirm >= 0) {
      const fail = firstWhere(confirm, Math.min(i, confirm + 20),
        k => isFin(close[k]) && close[k] < zone.high * 0.97);
      if (fail >= 0) {
        return {
          terminalIdx: fail,
          parts: {
            ...common, stage: 'FAILED', stage_detail: 'PLATFORM_BREAKOUT_FAILED',
            invalidation: { on: b.dates[fail], reason: 'close_below_platform_high' },
            evidence: { ...common.evidence, invalidation_close: round4(close[fail]) },
          },
        };
      }
      const expiresIdx = confirm + 21; // first bar with `i - confirm > 20`
      if (i >= expiresIdx) {
        return {
          terminalIdx: expiresIdx,
          parts: {
            ...common, stage: 'EXPIRED', stage_detail: 'PLATFORM_BREAKOUT_EXPIRED',
            expires_at: b.dates[expiresIdx],
            evidence: { ...common.evidence, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: {
          ...common,
          stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
          stage_detail: confirm === i ? 'BREAKOUT_CONFIRMED' : 'FOLLOW_THROUGH',
        },
      };
    }

    if (runEnd >= 0) {
      // The platform lost its shape before any volume breakout: terminal.
      return {
        terminalIdx: runEnd,
        parts: {
          ...common, stage: 'EXPIRED', stage_detail: 'PLATFORM_BREAKOUT_EXPIRED',
          expires_at: b.dates[runEnd],
          evidence: { ...common.evidence, expired: true },
        },
      };
    }
    return {
      terminalIdx: null,
      parts: {
        ...common, stage: 'FORMING', stage_detail: 'PLATFORM_FORMING',
        evidence: { ...common.evidence, close: round4(close[i]) },
      },
    };
  });

  return resolved
    ? [makeObservation(input, 'pb_v2_platform_breakout', 'PLATFORM_BREAKOUT', resolved.parts)]
    : [];
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
  interface DivFormation extends Formation {
    j1: number; j2: number; formationIdx: number; neckline: number; divergenceLow: number;
  }
  // Oldest first: the walk must consume formations in chronological order.
  const priceLows = confirmedLocalLows(b.low, i, { L: 3, K: 3 }, 0)
    .slice().sort((a, b2) => a.index - b2.index);
  const divFormations: DivFormation[] = [];
  for (let n = 0; n < priceLows.length; n++) {
    const j2 = priceLows[n].index;
    const formationIdx = j2 + 3;
    if (formationIdx > i) continue; // the second low is not provable yet
    for (let m = n - 1; m >= 0; m--) {
      const j1 = priceLows[m].index;
      const gap = j2 - j1;
      if (gap < 8) continue;
      if (gap > 60) break;
      if (!isFin(b.low[j1]) || !isFin(b.low[j2]) || !isFin(dif[j1]) || !isFin(dif[j2])) continue;
      if (!(b.low[j2] < b.low[j1])) continue;   // lower price low
      if (!(dif[j2] > dif[j1])) continue;       // higher DIF low
      if (!(dif[j2] < 0)) continue;             // still below the zero line
      const neckline = maxFinite(b.high, j1 + 1, j2 - 1);
      if (!isFin(neckline) || !(neckline > b.low[j2])) break; // nearest pair decides, even if unusable
      divFormations.push({
        eventIdx: j2, visibleFrom: formationIdx, j1, j2, formationIdx,
        neckline, divergenceLow: Math.min(b.low[j1], b.low[j2]),
      });
      break;
    }
  }

  const resolvedDiv = walkEpisodes(divFormations, i, (f): ResolvedEpisode => {
    const { j1, j2, formationIdx, neckline, divergenceLow } = f;
    // One finite instance window: the 40-bar evaluation starts at the
    // formation bar. Confirmation and invalidation are both searched only
    // inside it, so the FIRST event decides the instance (goal-1106 WP2).
    const expiresIdx = formationIdx + 41;           // first bar with `i - formationIdx > 40`
    const windowEnd = Math.min(i, formationIdx + 40);
    // The formation bar itself is the first bar the pair is provable on, so a
    // condition already true there must be dated there rather than one bar late.
    const fail = isFin(close[formationIdx]) && close[formationIdx] < divergenceLow
      ? formationIdx
      : firstWhere(formationIdx, windowEnd, k => isFin(close[k]) && close[k] < divergenceLow);
    const confirm = isFin(close[formationIdx]) && close[formationIdx] > neckline
      ? formationIdx
      : firstWhere(formationIdx, windowEnd, k => isFin(close[k]) && close[k] > neckline);
    const base: EpisodeBase = {
      pattern_event_date: b.dates[j2],
      first_observed_date: b.dates[formationIdx],
      formed_on: b.dates[formationIdx],
      reference_price: neckline, reference_kind: 'neckline',
      invalidation_level: divergenceLow,
      formation_basis: [`价格低点 ${b.dates[j2]} < ${b.dates[j1]}，但 DIF 低点抬高`],
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

    if (fail >= 0 && (confirm < 0 || fail < confirm)) {
      // The instance died BEFORE it ever confirmed: it can never be confirmed
      // later, and confirmed_on stays null.
      return {
        terminalIdx: fail,
        parts: {
          ...base, stage: 'FAILED', stage_detail: 'DIF_DIVERGENCE_FAILED',
          confirmed_on: null, confirmed_idx: null,
          invalidation: { on: b.dates[fail], reason: 'close_below_divergence_low' },
          evidence: { ...base.evidence, bars_since_formation: fail - formationIdx },
        },
      };
    }
    if (confirm >= 0) {
      const confirmExpiresIdx = confirm + 41;        // first bar with `i - confirm > 40`
      const failAfter = firstWhere(confirm, Math.min(i, confirm + 40),
        k => isFin(close[k]) && close[k] < divergenceLow);
      if (failAfter >= 0) {
        return {
          terminalIdx: failAfter,
          parts: {
            ...base, stage: 'FAILED', stage_detail: 'DIF_DIVERGENCE_FAILED',
            confirmed_on: b.dates[confirm], confirmed_idx: confirm,
            invalidation: { on: b.dates[failAfter], reason: 'close_below_divergence_low' },
            evidence: { ...base.evidence, bars_since_confirmation: failAfter - confirm, invalidation_close: round4(close[failAfter]) },
          },
        };
      }
      if (i >= confirmExpiresIdx) {
        return {
          terminalIdx: confirmExpiresIdx,
          parts: {
            ...base, stage: 'EXPIRED', stage_detail: 'DIF_DIVERGENCE_EXPIRED',
            confirmed_on: b.dates[confirm], confirmed_idx: confirm,
            expires_at: b.dates[confirmExpiresIdx],
            evidence: { ...base.evidence, bars_since_confirmation: i - confirm, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: {
          ...base,
          stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
          stage_detail: 'DIF_DIVERGENCE_CONFIRMED',
          confirmed_on: b.dates[confirm], confirmed_idx: confirm,
          evidence: { ...base.evidence, bars_since_confirmation: i - confirm },
        },
      };
    }
    if (i >= expiresIdx) {
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...base, stage: 'EXPIRED', stage_detail: 'DIF_DIVERGENCE_EXPIRED',
          confirmed_on: null, confirmed_idx: null,
          expires_at: b.dates[expiresIdx],
          evidence: { ...base.evidence, bars_since_formation: i - formationIdx, expired: true },
        },
      };
    }
    return {
      terminalIdx: null,
      parts: {
        ...base, stage: 'FORMING', stage_detail: 'DIVERGENCE_FORMING',
        confirmed_on: null, confirmed_idx: null,
        evidence: { ...base.evidence, dif_at_end: round4(dif[i]) },
      },
    };
  });
  if (resolvedDiv) out.push(makeObservation(input, 'rv_v2_macd_dif_divergence', 'REVERSAL', resolvedDiv.parts));

  // ---- rv_v2_macd_w_bottom
  interface WFormation extends Formation {
    j1: number; j2: number; formationIdx: number;
    neckline: number; below: number; v1: number; v2: number;
  }
  const wOpts = DEFAULT_MACD_W_OPTS;
  const difLows = confirmedLocalLows(dif, i, wOpts, 0).slice().sort((a, b2) => a.index - b2.index);
  const wFormations: WFormation[] = [];
  for (let n = 0; n < difLows.length; n++) {
    const j2 = difLows[n].index;
    // The second low is only a *confirmed* swing low `L` bars to its right, so
    // the pair is unknowable before then.
    const formationIdx = j2 + wOpts.L;
    if (formationIdx > i) continue;
    for (let m = n - 1; m >= 0; m--) {
      const j1 = difLows[m].index;
      const gap = j2 - j1;
      if (gap < wOpts.minGap) continue;
      if (gap > wOpts.maxGap) break;
      const v1 = dif[j1];
      const v2 = dif[j2];
      if (!isFin(v1) || !isFin(v2)) continue;
      if (v1 > wOpts.lowCeiling || v2 > wOpts.lowCeiling) continue;
      const scale = Math.max(Math.abs(v1), Math.abs(v2));
      if (!(Math.abs(v2 - v1) <= wOpts.relTol * scale)) continue;
      const neckline = maxFinite(dif, j1 + 1, j2 - 1);
      if (!isFin(neckline) || !(neckline > v1 && neckline > v2)) continue;
      wFormations.push({
        eventIdx: j2, visibleFrom: formationIdx, j1, j2, formationIdx,
        neckline, below: Math.min(v1, v2), v1, v2,
      });
      break;
    }
  }

  const resolvedW = walkEpisodes(wFormations, i, (f): ResolvedEpisode => {
    const { j1, j2, formationIdx, neckline, below, v1, v2 } = f;
    // First neckline cross at or after the second low; before the pair is
    // provable it is only a latent event, so the effective confirmation is
    // max(cross, formation) — never a date the detector could not know.
    // A confirmation must land inside the episode's own evaluation window: a
    // neckline cross that only appears after the window elapsed cannot revive
    // an episode that has already expired.
    const wWindowEnd = Math.min(i, formationIdx + 40);
    let confirmRaw = -1;
    for (let c = Math.max(j2, 1); c <= wWindowEnd; c++) {
      if (isFin(dif[c]) && isFin(dif[c - 1]) && dif[c] > neckline && dif[c - 1] <= neckline) {
        confirmRaw = c; break;
      }
    }
    const confirmedIdx = confirmRaw >= 0 ? Math.max(confirmRaw, formationIdx) : null;
    const base: EpisodeBase = {
      pattern_event_date: b.dates[j2],
      first_observed_date: b.dates[formationIdx],
      formed_on: b.dates[formationIdx],
      formation_basis: [`DIF 双底 ${b.dates[j1]} / ${b.dates[j2]}，颈线 ${round4(neckline)}`],
      confirmation_conditions: ['DIF 上穿两低点之间的颈线'],
      invalidation_conditions: ['DIF 跌破两个低点'],
      key_levels: {
        neckline_dif: round4(neckline),
        first_low_dif: round4(v1),
        second_low_dif: round4(v2),
      },
      evidence: {
        first_low_date: b.dates[j1],
        second_low_date: b.dates[j2],
        first_low: round4(v1),
        second_low: round4(v2),
        neckline: round4(neckline),
      },
    };
    const failed = (breach: number, confirmed: number | null): ResolvedEpisode => {
      // A breach before the pair was provable cannot be dated before the
      // formation itself; anchor formed_on at the second low in that case.
      const formedOn = breach < formationIdx ? b.dates[j2] : b.dates[formationIdx];
      const levelIdx = confirmed !== null ? confirmed : j2;
      return {
        terminalIdx: breach,
        parts: {
          ...base, formed_on: formedOn,
          stage: 'FAILED', stage_detail: 'DIF_W_INVALIDATED',
          confirmed_on: confirmed === null ? null : b.dates[confirmed],
          confirmed_idx: confirmed,
          invalidated_at: b.dates[breach],
          invalidation: { on: b.dates[breach], reason: 'dif_w_invalidated' },
          reference_price: isFin(close[levelIdx]) ? close[levelIdx] : null,
          reference_kind: 'confirmation_close',
          invalidation_level: null,
          evidence: { ...base.evidence, invalidate_below: round4(below) },
        },
      };
    };

    // First event inside the instance window decides. A breach anywhere between
    // the formation bar and the eventual neckline cross kills the instance
    // BEFORE it ever confirmed, and a later cross must not resurrect it.
    const failBefore = isFin(dif[formationIdx]) && dif[formationIdx] < below
      ? formationIdx
      : firstWhere(formationIdx, wWindowEnd, k => isFin(dif[k]) && dif[k] < below);
    if (failBefore >= 0 && (confirmRaw < 0 || failBefore < confirmRaw)) return failed(failBefore, null);

    if (confirmedIdx !== null && confirmRaw >= 0) {
      const breach = firstWhere(confirmedIdx, Math.min(i, confirmedIdx + 40),
        k => isFin(dif[k]) && dif[k] < below);
      if (breach >= 0) return failed(breach, confirmedIdx);
      const expiresIdx = confirmedIdx + 41;
      const live: ObservationParts = {
        ...base,
        stage: 'FOLLOW_THROUGH', stage_detail: 'DIF_W_CONFIRMED',
        confirmed_on: b.dates[confirmedIdx], confirmed_idx: confirmedIdx,
        reference_price: isFin(close[confirmedIdx]) ? close[confirmedIdx] : null,
        reference_kind: 'confirmation_close',
        invalidation_level: null,
        evidence: { ...base.evidence, bars_since_confirmation: i - confirmedIdx },
      };
      if (i >= expiresIdx) {
        return {
          terminalIdx: expiresIdx,
          parts: {
            ...live, stage: 'EXPIRED', expires_at: b.dates[expiresIdx],
            evidence: { ...live.evidence, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: { ...live, stage: i === confirmedIdx ? 'CONFIRMED' : 'FOLLOW_THROUGH' },
      };
    }

    // No confirmation inside the window and no breach: the instance expires
    // at the first bar the window elapsed. A later breach is past the window
    // and must not re-date it as FAILED.
    const expiresIdx = formationIdx + 41;
    const forming: ObservationParts = {
      ...base, stage: 'FORMING', stage_detail: 'DIF_W_FORMING',
      confirmed_on: null, confirmed_idx: null,
      reference_price: isFin(close[i]) ? close[i] : null,
      reference_kind: 'confirmation_close_pending',
      invalidation_level: null,
      evidence: { ...base.evidence, dif_at_end: round4(dif[i]) },
    };
    if (i >= expiresIdx) {
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...forming, stage: 'EXPIRED', expires_at: b.dates[expiresIdx],
          evidence: { ...forming.evidence, expired: true },
        },
      };
    }
    return { terminalIdx: null, parts: forming };
  });
  if (resolvedW) out.push(makeObservation(input, 'rv_v2_macd_w_bottom', 'REVERSAL', resolvedW.parts));

  return out;
}

// ---------------------------------------------------------------- D. volatility expansion

/**
 * VOLATILITY_EXPANSION — bollinger squeeze breakout and a sustained upper-band
 * ride.
 *
 * Thresholds (research hypotheses): squeeze = width ≤ 20th percentile of the
 * prior 120 bars (at least 100 finite); breakout = close crosses above the
 * upper band within 5 bars of a squeeze run; ride = ≥3 of the last 5 closes at
 * or above the upper band while width exceeds its 120-bar median. Touching the
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

  // Bar k's squeeze flag depends only on bars before k, so the run structure
  // is fixed as the as-of advances.
  const squeeze: ({ level: number; width: number } | null)[] = new Array(i + 1).fill(null);
  for (let k = 120; k <= i; k++) squeeze[k] = squeezeAt(k);

  const bandLevels = (k: number): Record<string, number | null> => ({
    boll_up: toRaw(x.bollUp[k]),
    boll_mid: toRaw(x.bollMid[k]),
    boll_low: toRaw(x.bollLow[k]),
  });

  // ---- ve_v2_boll_squeeze_breakout
  interface SqueezeFormation extends Formation { runEnd: number }
  const sqFormations: SqueezeFormation[] = [];
  for (let k = 120; k <= i; k++) {
    if (!squeeze[k]) continue;
    if (k > 120 && squeeze[k - 1]) continue; // inside the same squeeze run
    let runEnd = k;
    while (runEnd + 1 <= i && squeeze[runEnd + 1]) runEnd++;
    sqFormations.push({ eventIdx: k, visibleFrom: k, runEnd });
  }

  const resolvedSq = walkEpisodes(sqFormations, i, (f): ResolvedEpisode => {
    const k0 = f.eventIdx;
    // A breakout is only attributable to this run while its squeeze is within
    // the last 5 bars, i.e. through `runEnd + 5`.
    const confirmEnd = Math.min(i, f.runEnd + 5);
    let confirm = -1;
    for (let c = k0; c <= confirmEnd; c++) {
      if (!isFin(close[c]) || !isFin(close[c - 1]) || !isFin(x.bollUp[c]) || !isFin(x.bollUp[c - 1])) continue;
      if (close[c] > x.bollUp[c] && close[c - 1] <= x.bollUp[c - 1]) { confirm = c; break; }
    }
    const squeezeInfo = squeeze[k0];
    const common: EpisodeBase = {
      pattern_event_date: b.dates[k0],
      first_observed_date: b.dates[k0],
      formed_on: b.dates[k0],
      confirmed_on: confirm >= 0 ? b.dates[confirm] : null,
      confirmed_idx: confirm >= 0 ? confirm : null,
      reference_price: x.bollUp[confirm >= 0 ? confirm : k0],
      reference_kind: confirm >= 0 ? 'boll_upper' : 'boll_upper_pending',
      invalidation_level: x.bollMid[confirm >= 0 ? confirm : k0],
      formation_basis: ['布林带宽处于近 120 日 20% 分位（收口）'],
      confirmation_conditions: ['收盘上穿上轨，且前一日收盘不高于上轨'],
      invalidation_conditions: ['收盘跌破布林中轨'],
      key_levels: bandLevels(i),
      evidence: {
        squeeze_date: b.dates[k0],
        squeeze_level: squeezeInfo?.level !== undefined && isFin(squeezeInfo.level) ? round4(squeezeInfo.level) : null,
        boll_width: round4(x.bollWidth[i]),
        boll_width_at_formation: round4(x.bollWidth[k0]),
        boll_up: round4(x.bollUp[i]),
        close: round4(close[i]),
      },
    };

    if (confirm >= 0) {
      const fail = firstWhere(confirm, Math.min(i, confirm + 20),
        k => isFin(close[k]) && isFin(x.bollMid[k]) && close[k] < x.bollMid[k]);
      if (fail >= 0) {
        return {
          terminalIdx: fail,
          parts: {
            ...common, stage: 'FAILED', stage_detail: 'SQUEEZE_BREAKOUT_FAILED',
            invalidation: { on: b.dates[fail], reason: 'close_below_boll_mid' },
            evidence: { ...common.evidence, bars_since_confirmation: fail - confirm, invalidation_close: round4(close[fail]) },
          },
        };
      }
      const expiresIdx = confirm + 21; // first bar with `i - confirm > 20`
      if (i >= expiresIdx) {
        return {
          terminalIdx: expiresIdx,
          parts: {
            ...common, stage: 'EXPIRED', stage_detail: 'EXPANSION_FOLLOW_THROUGH',
            expires_at: b.dates[expiresIdx],
            evidence: { ...common.evidence, bars_since_confirmation: i - confirm, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: {
          ...common,
          stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
          stage_detail: confirm === i ? 'SQUEEZE_BREAKOUT' : 'EXPANSION_FOLLOW_THROUGH',
          evidence: { ...common.evidence, bars_since_confirmation: i - confirm },
        },
      };
    }

    if (i >= f.runEnd + 6) {
      // The squeeze run ended and the 5-bar breakout window elapsed.
      const expiresIdx = f.runEnd + 6;
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...common, stage: 'EXPIRED', stage_detail: 'EXPANSION_FOLLOW_THROUGH',
          expires_at: b.dates[expiresIdx],
          evidence: { ...common.evidence, expired: true },
        },
      };
    }
    return { terminalIdx: null, parts: { ...common, stage: 'FORMING', stage_detail: 'SQUEEZE_FORMING' } };
  });
  if (resolvedSq) out.push(makeObservation(input, 've_v2_boll_squeeze_breakout', 'VOLATILITY_EXPANSION', resolvedSq.parts));

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

  // First-cross by construction: the ride must not already hold on the
  // previous bar, so one advance cannot be confirmed twice.
  const rideStart = (k: number): boolean => k >= 1 && rideAt(k) && !rideAt(k - 1) && background(k);

  const rideFormations: Formation[] = [];
  for (let k = 1; k <= i; k++) if (rideStart(k)) rideFormations.push({ eventIdx: k, visibleFrom: k });

  const resolvedRide = walkEpisodes(rideFormations, i, (f): ResolvedEpisode => {
    const c = f.eventIdx;
    const expiresIdx = c + 21; // first bar with `i - c > 20`
    const fail = firstWhere(c, Math.min(i, c + 20),
      k => isFin(close[k]) && isFin(x.bollMid[k]) && close[k] < x.bollMid[k]);
    const common: EpisodeBase = {
      pattern_event_date: b.dates[c],
      first_observed_date: b.dates[c],
      formed_on: b.dates[c],
      confirmed_on: b.dates[c],
      confirmed_idx: c,
      reference_price: x.bollUp[c], reference_kind: 'boll_upper',
      invalidation_level: x.bollMid[c],
      formation_basis: ['上升趋势中，近 5 日至少 3 日收盘触及/站上布林上轨，且带宽高于 120 日中位数'],
      confirmation_conditions: ['上轨骑行条件首次成立'],
      invalidation_conditions: ['收盘跌破布林中轨（触碰上轨不是卖出信号）'],
      key_levels: bandLevels(i),
      evidence: {
        upper_band_touches: touchesIn(i),
        boll_width: round4(x.bollWidth[i]),
        width_median_120: round4(medianFinite(x.bollWidth.slice(Math.max(0, i - 120), i).filter(isFin))),
        touching_upper_band_is_not_a_sell_signal: true,
        bars_since_confirmation: i - c,
      },
    };
    if (fail >= 0) {
      return {
        terminalIdx: fail,
        parts: {
          ...common, stage: 'FAILED', stage_detail: 'UPPER_BAND_RIDE_FAILED',
          invalidation: { on: b.dates[fail], reason: 'close_below_boll_mid' },
          evidence: { ...common.evidence, boll_mid: round4(x.bollMid[i]), invalidation_close: round4(close[fail]) },
        },
      };
    }
    if (i >= expiresIdx) {
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...common, stage: 'EXPIRED', stage_detail: 'UPPER_BAND_RIDE',
          expires_at: b.dates[expiresIdx],
          evidence: { ...common.evidence, expired: true },
        },
      };
    }
    return {
      terminalIdx: null,
      parts: {
        ...common, stage: c === i ? 'CONFIRMED' : 'FOLLOW_THROUGH', stage_detail: 'UPPER_BAND_RIDE',
      },
    };
  });
  if (resolvedRide) out.push(makeObservation(input, 've_v2_boll_upper_ride', 'VOLATILITY_EXPANSION', resolvedRide.parts));

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

  // Environment at each bar: a confirmed downtrend (falling MA20 and close
  // below MA60) never confirms a reversion. Evaluated per bar, not at the
  // as-of, so a later advance cannot re-decide an earlier confirmation.
  const downAt = (k: number): boolean => k >= 10
    && isFin(x.ma20[k]) && isFin(x.ma20[k - 10]) && x.ma20[k] < x.ma20[k - 10]
    && isFin(close[k]) && isFin(x.ma60[k]) && close[k] < x.ma60[k];

  const bandLevels = (k: number): Record<string, number | null> => ({
    boll_low: toRaw(x.bollLow[k]),
    boll_mid: toRaw(x.bollMid[k]),
    rsi14: round4(x.rsi14[k]),
  });

  // The reversion environment is decided from each bar's own price facts and
  // that bar's market regime, never from the as-of day's label: a market label
  // read at the reporting day would re-decide (and could revoke) an earlier
  // confirmation as the as-of advances.
  const regimeAtBar = (k: number): string | null => (input.regimeAt
    ? input.regimeAt(b.dates[k])
    : input.regime);

  /** First bar of the oversold run that contains `k` (bar k must be oversold). */
  const runStartAt = (k: number): number => {
    let f = k;
    while (f > 0 && obsAt(f - 1)) f--;
    return f;
  };

  interface MrFormation extends Formation { obsIdx: number }
  const formations: MrFormation[] = [];
  for (let k = 1; k <= i; k++) {
    if (!obsAt(k)) continue;
    if (obsAt(k - 1)) continue; // inside the same oversold run
    formations.push({ eventIdx: k, visibleFrom: k, obsIdx: k });
  }

  const resolved = walkEpisodes(formations, i, (f): ResolvedEpisode => {
    const o = f.obsIdx;
    const confirmEnd = Math.min(i, o + 5);
    let confirm = -1;
    let obsIdx = -1;
    for (let c = o + 1; c <= confirmEnd; c++) {
      // Outside a range regime, a stock-level downtrend at the bar being
      // decided cannot confirm a reversion. Both inputs are bar-local, so the
      // decision is stable across as-of days.
      if (regimeAtBar(c) !== 'range' && downAt(c)) continue;
      if (!(isFin(close[c]) && isFin(x.bollLow[c]) && isFin(close[c - 1])
        && isFin(x.rsi14[c]) && isFin(x.rsi14[c - 1]))) continue;
      if (!(close[c] > x.bollLow[c] && close[c] > close[c - 1] && x.rsi14[c] >= x.rsi14[c - 1])) continue;
      const seen = lastWhere(Math.max(o, c - 5), c, obsAt);
      if (seen < 0) continue;
      confirm = c; obsIdx = seen; break;
    }
    const common: EpisodeBase = {
      pattern_event_date: b.dates[o],
      first_observed_date: b.dates[o],
      formed_on: b.dates[o],
      confirmed_on: confirm >= 0 ? b.dates[confirm] : null,
      confirmed_idx: confirm >= 0 ? confirm : null,
      reference_price: x.bollLow[confirm >= 0 ? confirm : o],
      reference_kind: confirm >= 0 ? 'boll_lower_reentry' : 'boll_lower_pending',
      formation_basis: ['震荡环境中出现超卖观察（布林下轨附近或 RSI14 < 30）'],
      confirmation_conditions: ['收盘高于下轨、高于前一日收盘，且 RSI14 不低于前一日'],
      invalidation_conditions: ['收盘跌破超卖区低点'],
      key_levels: bandLevels(i),
      evidence: {
        observation_date: b.dates[o],
        counter_trend_observation: false,
        band_observation: isFin(close[o]) && isFin(x.bollLow[o]) && close[o] <= x.bollLow[o] * 1.01,
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
        bars_since_confirmation: confirm >= 0 ? i - confirm : null,
      },
    };

    if (confirm >= 0) {
      // The oversold low is frozen at the confirmation bar; later lows must not
      // move the invalidation level (no rolling self-reference).
      const observationLow = minFinite(b.low, obsIdx, confirm);
      const failIdx = firstWhere(confirm, Math.min(i, confirm + 10),
        k => isFin(observationLow) && isFin(close[k]) && close[k] < observationLow);
      const withLevel: EpisodeBase = {
        ...common,
        invalidation_level: observationLow,
        evidence: { ...common.evidence, observation_low: toRaw(observationLow) },
      };
      if (failIdx >= 0) {
        return {
          terminalIdx: failIdx,
          parts: {
            ...withLevel, stage: 'FAILED', stage_detail: 'REVERSION_FAILED',
            invalidation: { on: b.dates[failIdx], reason: 'new_low_after_oversold' },
            evidence: { ...withLevel.evidence, invalidation_close: round4(close[failIdx]) },
          },
        };
      }
      const expiresIdx = confirm + 11; // first bar with `i - confirm > 10`
      if (i >= expiresIdx) {
        return {
          terminalIdx: expiresIdx,
          parts: {
            ...withLevel, stage: 'EXPIRED', stage_detail: 'REVERSION_EXPIRED',
            expires_at: b.dates[expiresIdx],
            evidence: { ...withLevel.evidence, expired: true },
          },
        };
      }
      return {
        terminalIdx: null,
        parts: {
          ...withLevel,
          stage: confirm === i ? 'CONFIRMED' : 'FOLLOW_THROUGH',
          stage_detail: confirm === i ? 'BAND_REENTRY_CONFIRMED' : 'REVERSION_FOLLOW_THROUGH',
          evidence: { ...withLevel.evidence, reached_mid_band: isFin(close[i]) && isFin(x.bollMid[i]) && close[i] >= x.bollMid[i] },
        },
      };
    }

    const expiresIdx = o + 6; // first bar after the 5-bar re-entry window
    const withLevel: EpisodeBase = {
      ...common,
      invalidation_level: isFin(b.low[o]) ? b.low[o] : null,
    };
    if (i >= expiresIdx) {
      return {
        terminalIdx: expiresIdx,
        parts: {
          ...withLevel, stage: 'EXPIRED', stage_detail: 'REVERSION_EXPIRED',
          expires_at: b.dates[expiresIdx],
          evidence: { ...withLevel.evidence, expired: true },
        },
      };
    }
    return { terminalIdx: null, parts: { ...withLevel, stage: 'FORMING', stage_detail: 'OVERSOLD_OBSERVATION' } };
  });

  // A stock-level downtrend relabels the CURRENT, still-unconfirmed oversold
  // observation as a counter-trend note. It never revokes a confirmation that
  // already happened, and it keeps the walk's dates, so the standing
  // observation can never re-date itself as new oversold runs come and go.
  if (!resolved) return [];
  const backgroundDown = isFin(x.ma20[i]) && isFin(x.ma20[i - 10]) && x.ma20[i] < x.ma20[i - 10]
    && isFin(close[i]) && isFin(x.ma60[i]) && close[i] < x.ma60[i];
  if (regimeAtBar(i) !== 'range' && backgroundDown && resolved.parts.confirmed_on === null && obsAt(i)
    && resolved.parts.pattern_event_date === b.dates[runStartAt(i)]) {
    return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', {
      ...resolved.parts,
      stage: 'FORMING', stage_detail: 'OVERSOLD_IN_DOWNTREND',
      confirmed_on: null, confirmed_idx: null,
      invalidated_at: null, expires_at: null,
      counter_evidence: ['下跌趋势仍在：超卖只作逆势观察，不构成低风险机会'],
      confirmation_conditions: [],
      invalidation_conditions: ['收盘跌破超卖区低点', '超卖不等于低风险机会'],
      evidence: {
        ...resolved.parts.evidence,
        counter_trend_observation: true,
        observation_date: resolved.parts.pattern_event_date,
        rsi14: round4(x.rsi14[i]),
        boll_low: round4(x.bollLow[i]),
        close: round4(close[i]),
      },
    })];
  }
  return [makeObservation(input, 'mr_v2_oversold_reversion', 'MEAN_REVERSION', resolved.parts)];
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
