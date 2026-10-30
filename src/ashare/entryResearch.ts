/**
 * Entry-outcome research harness (goal-1030 WP4).
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not run its own backtest. Every executed entry, exit, delay, cost,
 * benchmark and return below comes from `evaluation.ts` (`evaluateEvents`), the
 * repository's existing observation engine — T+1 open entry, up-limit and
 * suspension blocks, deferred down-limit exits, adjusted open-to-close returns,
 * explicit CSI 300 / equal-market / industry references. There is no second
 * price path, no portfolio and no accounting here.
 *
 * What this module adds is the part that is specific to goal-1030:
 *  - replay the PRODUCTION decision path bar by bar and record what it said on
 *    each day (which family, which stage, which score, which reasons);
 *  - feed those decisions to the engine as evaluation events;
 *  - group the resulting observations by family, stage, score bucket, market
 *    regime, sample half, design-day role and threshold plateau;
 *  - report censoring, blocked entries and sample size instead of hiding them.
 *
 * `mfe` / `mae` / `max_drawdown` are the only numbers measured here rather than
 * by the engine: they are descriptive path statistics over the planned window,
 * not execution, and the engine publishes no equivalent. They are null whenever
 * the engine reports that no entry actually happened.
 */
import type { DatabaseSync } from 'node:sqlite';
import { computeIndicators, type Bars, type IndicatorSet } from './indicators.js';
import { forEachStockBars } from './bars.js';
import { tradeDaysBetween } from './ingest.js';
import { regimeSeries, type Regime } from './market.js';
import { detectStrategyEvents } from './strategies.js';
import type { EntryAssessment, EntryFamily, EntryStage } from './hotspotTypes.js';
import { HOTSPOT_EXPERIMENT_COSTS } from './hotspotTypes.js';
import { ENTRY_RULES_VERSION, ENTRY_MAX_DISTANCE_ATR } from './entryAssessment.js';
import {
  distribution, evaluateEvents, EVALUATION_VERSION,
  type EvaluationEvent, type EvaluationOutcome, type OutcomeStatus,
} from './evaluation.js';

export const DEFAULT_HORIZONS = [3, 5, 10, 20] as const;
/** Observations required before a group statistic is called anything. */
export const MIN_GROUP_SAMPLE = 20;

/**
 * Which decision the replay treats as the entry (goal-1030 WP4 arm definition).
 *
 * `eligible_only` is the new scheme under test: the production eligibility gate
 * decides, and everything it rejects is never bought.
 *
 * `all_live_signals` is the control frozen before any number was seen: the same
 * candidates and the same T+1 execution, but the timing/risk gate is removed —
 * buy at the next open on any day a CONFIRMED signal is live, whether the gate
 * called it EXTENDED, RISK_BLOCKED or eligible. The difference between the two
 * arms is the only thing that can say whether the filter adds or destroys value.
 *
 * PREPARING is excluded from the control because nothing is confirmed yet (there
 * is no signal to have "no timing filter" on), and INVALIDATED / EXPIRED are
 * excluded because those signals are dead, not merely mistimed.
 */
export type EntryArm = 'eligible_only' | 'all_live_signals';
export const LIVE_SIGNAL_STAGES: readonly EntryStage[] = ['NEWLY_CONFIRMED', 'PULLBACK_READY', 'EXTENDED', 'RISK_BLOCKED'];

export interface EntryStudyOptions {
  /** First day whose close may produce an observation. */
  start: string;
  /** Last day whose close may produce an observation; also the engine's as-of. */
  end: string;
  /** Universe; the caller decides and the report discloses how it was chosen. */
  codes: readonly string[];
  horizons?: readonly number[];
  /** Bars handed to the strategy scan (production uses 330). */
  windowDays?: number;
  /** The day whose result was inspected while the thresholds were written. */
  designDay: string;
  /** Comparison arm; defaults to the scheme under test. */
  arm?: EntryArm;
}

/** One horizon of one observation, straight from the evaluation engine. */
export interface HorizonMeasurement {
  status: OutcomeStatus;
  reason: string;
  entry_date: string | null;
  entry_price: number | null;
  exit_date: string | null;
  exit_delay: number | null;
  gross_return: number | null;
  net_return: number | null;
  excess_csi300: number | null;
  excess_industry: number | null;
  excess_equal_market: number | null;
  /** Descriptive path statistics over the planned window; null if nothing was entered. */
  mfe: number | null;
  mae: number | null;
  max_drawdown: number | null;
}

export interface EntryObservation {
  as_of: string;
  ts_code: string;
  strategy_family: EntryFamily;
  entry_stage: EntryStage;
  entry_score: number | null;
  signal_id: string | null;
  confirmed_on: string | null;
  signal_age_trade_days: number | null;
  entry_distance_atr: number | null;
  risk_reward: number | null;
  risk_reward_uncertainty: string | null;
  soft_risk_count: number;
  market_regime: Regime | null;
  /** Next-executable open vs the signal-day close, both unadjusted (descriptive). */
  entry_drift: number | null;
  /**
   * goal-1031 §2.2: the distance condition re-evaluated at the T+1 open, in
   * ATR(T) units. The gate is decided at T's close; the fill happens at T+1's
   * open, and until this field existed the study silently assumed the two were
   * the same price. ATR(T) is the only volatility estimate knowable at
   * decision time, so that is what the re-check uses.
   */
  entry_recheck_atr: number | null;
  /** Whether that re-check still passes the 1.0-ATR entry window. */
  entry_eligible_at_open: boolean | null;
  /** Trade days from the entry bar to invalidation; null = never invalidated. */
  invalidated_within: number | null;
  /** Forward bars actually available at the as-of date. */
  observed_bars_forward: number;
  /** A `trend_breakdown` fired within 10 trade days after the signal. */
  breakdown_within_10: boolean | null;
  horizons: Record<string, HorizonMeasurement>;
}

export interface HorizonStat {
  /** Observations whose outcome completed at this horizon. */
  n: number;
  pending: number;
  blocked: number;
  /** Gross return — the engine's `gross_return`, before costs. */
  mean: number | null;
  /** Gross median, same basis as `mean` so the two can be compared directly. */
  median: number | null;
  /** After the frozen round-trip cost model (`net_return`). */
  mean_net: number | null;
  median_net: number | null;
  /** Share of after-cost returns above 0 — the cost model decides every border case. */
  win_rate: number | null;
  mean_excess_csi300: number | null;
  mean_excess_industry: number | null;
  mean_mfe: number | null;
  mean_mae: number | null;
  mean_drawdown: number | null;
}

export interface GroupStat {
  /** Event-days: one row per (signal, observation day). NOT independent trials. */
  n: number;
  /** goal-1031 §2.4: distinct signal ids behind `n`. */
  unique_signals: number;
  sufficient_sample: boolean;
  /** The same 20-observation floor applied to unique signals, which is stricter. */
  sufficient_unique_signals: boolean;
  horizons: Record<string, HorizonStat>;
  /**
   * One-vote-per-signal restatement of each horizon: mean inside a signal, then
   * an unweighted mean across signals. A signal live D days contributes once,
   * not D times. Published beside the event-day figure, never instead of it.
   */
  horizons_signal_equal: Record<string, { signals: number; mean_net: number | null; win_rate: number | null }>;
  mean_entry_drift: number | null;
  /** The whole drift distribution: a mean cannot show a gate that failed in the tail. */
  entry_drift_distribution: { n: number; min: number | null; p05: number | null; p50: number | null; p95: number | null; max: number | null };
  /** goal-1031 §2.2: fills that would have failed the distance gate at the T+1 open. */
  open_recheck: { n: number; failed: number; share: number | null };
  /** Share of observations whose 10-day window closed and invalidated in time. */
  invalidated_within_10: number | null;
  breakout_within_10: number | null;
  /** Outcome statuses per horizon — never summed across horizons. */
  status_counts: Record<string, Record<string, number>>;
}

export interface EntryStudySummary {
  overall: GroupStat;
  by_family: Record<string, GroupStat>;
  by_stage: Record<string, GroupStat>;
  by_score_bucket: Record<string, GroupStat>;
  by_regime: Record<string, GroupStat>;
  by_half: Record<string, GroupStat>;
  /** The design day versus everything else. */
  by_sample_role: Record<string, GroupStat>;
  by_soft_risk: Record<string, GroupStat>;
  plateau: {
    distance_atr_max: Record<string, GroupStat>;
    age_max: Record<string, GroupStat>;
  };
  risk_event_predictive: {
    with_soft_risk_breakdown_rate: number | null;
    without_soft_risk_breakdown_rate: number | null;
    notes: string[];
  };
}

export interface EntryStudy {
  meta: {
    start: string;
    end: string;
    entry_rules_version: string;
    evaluation_version: string;
    universe_size: number;
    days_evaluated: number;
    horizons: number[];
    costs: { buyFeeBps: number; sellFeeBps: number; slippageBps: number; maxExitDelay: number };
    split_date: string;
    engine: string;
    arm: EntryArm;
    data_gaps: string[];
    generated_at: string;
  };
  observations: EntryObservation[];
  summary: EntryStudySummary;
  /** The engine's own caveats, copied verbatim so no caller can drop them. */
  limitations: string[];
}

const EMPTY_RPS = new Map<string, number | null>();
const r4 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface Replay {
  as_of: string;
  ts_code: string;
  strategy_family: EntryFamily;
  entry_stage: EntryStage;
  entry_score: number | null;
  signal_id: string | null;
  confirmed_on: string | null;
  signal_age_trade_days: number | null;
  entry_distance_atr: number | null;
  risk_reward: number | null;
  risk_reward_uncertainty: string | null;
  soft_risk_count: number;
  market_regime: Regime | null;
  entry_drift: number | null;
  entry_recheck_atr: number | null;
  entry_eligible_at_open: boolean | null;
  invalidated_within: number | null;
  observed_bars_forward: number;
  breakdown_within_10: boolean | null;
  path: Record<string, { mfe: number | null; mae: number | null; mdd: number | null }>;
}

/**
 * goal-1031 §2.2: re-apply the entry distance rule at the actual fill.
 *
 * The gate is decided at T's close; the fill happens at T+1's open. Until this
 * field existed the study assumed the two prices were the same. The re-check
 * uses the SAME rule (≤ 1.0 ATR above the reference price) and ATR(T), the only
 * volatility estimate knowable at decision time. It is RECORDED, never used to
 * re-filter the arm, so the existing event-day statistics stay comparable and
 * the count of failed fills is visible instead of silently absorbed.
 */
function openRecheck(bars: Bars, x: IndicatorSet, a: EntryAssessment, i: number, eIdx: number):
{ entry_recheck_atr: number | null; entry_eligible_at_open: boolean | null } {
  if (a.entry_stage !== 'NEWLY_CONFIRMED' && a.entry_stage !== 'PULLBACK_READY') {
    return { entry_recheck_atr: null, entry_eligible_at_open: null };
  }
  const ref = a.entry_trigger.reference_price;
  const atr = x.atr14?.[i];
  const fill = bars.rawOpen[eIdx];
  if (ref === null || !Number.isFinite(ref) || !Number.isFinite(atr) || atr <= 0 || !(fill > 0)) {
    return { entry_recheck_atr: null, entry_eligible_at_open: null };
  }
  const atrUnits = (fill - ref) / atr;
  return { entry_recheck_atr: r4(atrUnits), entry_eligible_at_open: atrUnits <= ENTRY_MAX_DISTANCE_ATR };
}

/** Path statistics over the planned window [entry .. entry + h - 1]. */
function pathStats(bars: Bars, eIdx: number, h: number): { mfe: number | null; mae: number | null; mdd: number | null } {
  const fill = bars.open[eIdx];
  if (!(fill > 0)) return { mfe: null, mae: null, mdd: null };
  const end = Math.min(eIdx + h - 1, bars.dates.length - 1);
  let mfe: number | null = null; let mae: number | null = null;
  let peak = fill; let mdd = 0;
  for (let k = eIdx; k <= end; k++) {
    const hi = bars.high[k] / fill - 1;
    const lo = bars.low[k] / fill - 1;
    if (mfe === null || hi > mfe) mfe = hi;
    if (mae === null || lo < mae) mae = lo;
    const c = bars.close[k];
    if (c > peak) peak = c;
    mdd = Math.min(mdd, c / peak - 1);
  }
  return { mfe, mae, mdd };
}

/** Replay the production decision path and collect the entries of one arm. */
function replay(db: DatabaseSync, opts: EntryStudyOptions, horizons: number[]): { rows: Replay[]; evalDays: string[] } {
  const windowDays = opts.windowDays ?? 330;
  const maxHorizon = Math.max(...horizons);
  const allDays = tradeDaysBetween(db, '20240101', opts.end);
  const evalDays = allDays.filter(d => d >= opts.start && d <= opts.end);
  const regimes = regimeSeries(db, opts.end);
  const barStart = allDays[Math.max(0, allDays.indexOf(evalDays[0] ?? opts.start) - windowDays)] ?? allDays[0];
  const rows: Replay[] = [];

  forEachStockBars(db, barStart, opts.end, (code, bars) => {
    if (bars.dates.length < 62) return;
    const x: IndicatorSet = computeIndicators(bars);
    const dateIdx = new Map(bars.dates.map((d, i) => [d, i]));
    // One scan at the last bar: the eventual fate of every signal id. This is
    // outcome data, never decision data — decisions below only see bars ≤ as_of.
    const finalScan = detectStrategyEvents(code, bars, x, EMPTY_RPS, bars.dates.length - 1);
    const fateById = new Map(finalScan.events.map(e => [e.signal_id ?? `${e.ts_code}:${e.strategy_id}:${e.confirmed_on}`, e]));

    for (const day of evalDays) {
      const i = dateIdx.get(day);
      if (i === undefined || i < 61) continue;
      const scan = detectStrategyEvents(code, bars, x, EMPTY_RPS, i);
      const entry = scan.entry;
      const arm = opts.arm ?? 'eligible_only';
      // Same day, same execution; only the gate differs between the two arms.
      const a: EntryAssessment | undefined = arm === 'all_live_signals'
        ? entry.entry_assessments.find(c => LIVE_SIGNAL_STAGES.includes(c.entry_stage))
        : (entry.entry_eligibility ? entry.entry_assessments[0] : undefined);
      if (!a) continue;
      const eIdx = i + 1;
      if (eIdx >= bars.dates.length) continue; // no next bar ⇒ no fill ⇒ nothing to measure
      const sigId = a.representative_signal_id;
      const fate = sigId ? fateById.get(sigId) : undefined;
      let invalidatedWithin: number | null = null;
      if (fate?.invalidated_on) {
        const j = dateIdx.get(fate.invalidated_on);
        if (j !== undefined && j >= eIdx) invalidatedWithin = j - eIdx;
      }
      const tenDaysOut = bars.dates[Math.min(i + 10, bars.dates.length - 1)];
      const path: Replay['path'] = {};
      for (const h of horizons) path[`${h}`] = pathStats(bars, eIdx, h);
      rows.push({
        as_of: day,
        ts_code: code,
        strategy_family: a.strategy_family,
        entry_stage: a.entry_stage,
        entry_score: a.entry_score,
        signal_id: sigId,
        confirmed_on: a.confirmed_on,
        signal_age_trade_days: a.signal_age_trade_days,
        entry_distance_atr: a.entry_distance.atr,
        risk_reward: a.risk_reward,
        risk_reward_uncertainty: a.risk_reward_uncertainty,
        soft_risk_count: a.soft_risk_warnings.length,
        market_regime: regimes.get(day) ?? null,
        entry_drift: bars.rawClose[i] > 0 && bars.rawOpen[eIdx] > 0
          ? r4(bars.rawOpen[eIdx] / bars.rawClose[i] - 1) : null,
        ...openRecheck(bars, x, a, i, eIdx),
        invalidated_within: invalidatedWithin,
        observed_bars_forward: Math.min(bars.dates.length - 1, i + maxHorizon) - i,
        breakdown_within_10: tenDaysOut === undefined ? null
          : finalScan.risk_events.some(r => r.id === 'trend_breakdown' && r.on > day && r.on <= tenDaysOut),
        path,
      });
    }
  }, [...opts.codes]);
  return { rows, evalDays };
}

/** Describe a group with the engine's own distribution definitions. */
function groupStat(rows: EntryObservation[], horizons: number[]): GroupStat {
  const out: Record<string, HorizonStat> = {};
  const statusCounts: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    for (const [h, m] of Object.entries(r.horizons)) {
      const bucket = (statusCounts[h] ??= {});
      bucket[m.status] = (bucket[m.status] ?? 0) + 1;
    }
  }
  for (const h of horizons) {
    const measured = rows.map(r => r.horizons[`${h}`]).filter((m): m is HorizonMeasurement => !!m);
    const done = measured.filter(m => m.status === 'completed');
    const gross = distribution(done.map(m => m.gross_return));
    const net = distribution(done.map(m => m.net_return));
    out[`${h}`] = {
      n: done.length,
      pending: measured.filter(m => m.status === 'pending').length,
      blocked: measured.filter(m => m.status !== 'completed' && m.status !== 'pending').length,
      mean: r4(gross.mean),
      median: r4(gross.median),
      mean_net: r4(net.mean),
      median_net: r4(net.median),
      win_rate: net.win_rate === null ? null : r4(net.win_rate),
      mean_excess_csi300: r4(mean(done.map(m => m.excess_csi300).filter((v): v is number => v !== null))),
      mean_excess_industry: r4(mean(done.map(m => m.excess_industry).filter((v): v is number => v !== null))),
      mean_mfe: r4(mean(done.map(m => m.mfe).filter((v): v is number => v !== null))),
      mean_mae: r4(mean(done.map(m => m.mae).filter((v): v is number => v !== null))),
      mean_drawdown: r4(mean(done.map(m => m.max_drawdown).filter((v): v is number => v !== null))),
    };
  }
  const mature = rows.filter(r => r.observed_bars_forward >= 10);
  const bd = rows.filter(r => r.breakdown_within_10 !== null);
  const distinctSignals = new Set(rows.map(r => r.signal_id).filter((s): s is string => s !== null));
  // One vote per signal: mean inside the signal, then average across signals.
  const signalEqual: Record<string, { signals: number; mean_net: number | null; win_rate: number | null }> = {};
  for (const h of horizons) {
    const per = new Map<string, number[]>();
    for (const r of rows) {
      const m = r.horizons[`${h}`];
      if (!m || m.status !== 'completed') continue;
      const nr = m.net_return;
      if (typeof nr !== 'number' || !Number.isFinite(nr)) continue;
      const key = r.signal_id ?? `${r.ts_code}:${r.as_of}`;
      per.set(key, [...(per.get(key) ?? []), nr]);
    }
    const means = [...per.values()].map(v => mean(v)).filter((v): v is number => v !== null);
    signalEqual[`${h}`] = {
      signals: means.length,
      mean_net: r4(mean(means)),
      win_rate: means.length ? r4(means.filter(v => v > 0).length / means.length) : null,
    };
  }
  const recheck = rows.filter(r => r.entry_eligible_at_open !== null);
  const drift = distribution(rows.map(r => r.entry_drift));
  return {
    n: rows.length,
    unique_signals: distinctSignals.size,
    sufficient_sample: rows.length >= MIN_GROUP_SAMPLE,
    sufficient_unique_signals: distinctSignals.size >= MIN_GROUP_SAMPLE,
    horizons: out,
    horizons_signal_equal: signalEqual,
    mean_entry_drift: r4(mean(rows.map(r => r.entry_drift).filter((v): v is number => v !== null))),
    entry_drift_distribution: {
      n: drift.n, min: r4(drift.min), p05: r4(drift.p05),
      p50: r4(drift.median), p95: r4(drift.p95), max: r4(drift.max),
    },
    open_recheck: {
      n: recheck.length,
      failed: recheck.filter(r => r.entry_eligible_at_open === false).length,
      share: recheck.length ? r4(recheck.filter(r => r.entry_eligible_at_open === false).length / recheck.length) : null,
    },
    invalidated_within_10: mature.length
      ? r4(mature.filter(r => r.invalidated_within !== null && r.invalidated_within <= 10).length / mature.length)
      : null,
    breakout_within_10: bd.length ? r4(bd.filter(r => r.breakdown_within_10 === true).length / bd.length) : null,
    status_counts: statusCounts,
  };
}

const groupBy = <K extends string>(rows: EntryObservation[], key: (r: EntryObservation) => K) => {
  const out = new Map<K, EntryObservation[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = out.get(k);
    if (arr) arr.push(r); else out.set(k, [r]);
  }
  return Object.fromEntries(out) as Record<K, EntryObservation[]>;
};

/**
 * Replay the production decision path over [start, end] and measure each
 * eligible entry with the shared evaluation engine. Pure read.
 */
export function runEntryStudy(db: DatabaseSync, opts: EntryStudyOptions): EntryStudy {
  const horizons = [...(opts.horizons ?? DEFAULT_HORIZONS)];
  const arm: EntryArm = opts.arm ?? 'eligible_only';
  const { rows: replayRows, evalDays } = replay(db, opts, horizons);

  // One engine run per horizon: `horizon` is a single option, and every other
  // input (events, calendar, references) is identical across runs.
  const events: EvaluationEvent[] = replayRows.map(r => ({
    date: r.as_of,
    ts_code: r.ts_code,
    score: r.entry_score,
    factors: {
      entry_distance_atr: r.entry_distance_atr,
      risk_reward: r.risk_reward,
      signal_age_trade_days: r.signal_age_trade_days,
      soft_risk_count: r.soft_risk_count,
    },
    signals: [r.strategy_family, r.entry_stage],
  }));
  let limitations: string[] = [];
  const byHorizon = new Map<number, EvaluationOutcome[]>();
  for (const h of horizons) {
    const run = evaluateEvents(db, events, {
      asOf: opts.end,
      horizon: h,
      buyFeeBps: HOTSPOT_EXPERIMENT_COSTS.buyFeeBps,
      sellFeeBps: HOTSPOT_EXPERIMENT_COSTS.sellFeeBps,
      slippageBps: HOTSPOT_EXPERIMENT_COSTS.slippageBps,
      maxExitDelay: HOTSPOT_EXPERIMENT_COSTS.maxExitDelay,
    });
    byHorizon.set(h, run.outcomes);
    limitations = run.limitations;
  }

  const observations: EntryObservation[] = replayRows.map((r, idx) => {
    const measured: Record<string, HorizonMeasurement> = {};
    for (const h of horizons) {
      const o = byHorizon.get(h)![idx];
      const p = r.path[`${h}`] ?? { mfe: null, mae: null, mdd: null };
      measured[`${h}`] = {
        status: o.status,
        reason: o.reason,
        entry_date: o.entry_date,
        entry_price: r4(o.entry_price),
        exit_date: o.exit_date,
        exit_delay: o.exit_delay,
        gross_return: r4(o.gross_return),
        net_return: r4(o.net_return),
        excess_csi300: r4(o.excess.csi300),
        excess_industry: r4(o.excess.industry),
        excess_equal_market: r4(o.excess.equal_market),
        // Path statistics describe a position that existed; a blocked entry has none.
        mfe: o.entered ? r4(p.mfe) : null,
        mae: o.entered ? r4(p.mae) : null,
        max_drawdown: o.entered ? r4(p.mdd) : null,
      };
    }
    return {
      as_of: r.as_of,
      ts_code: r.ts_code,
      strategy_family: r.strategy_family,
      entry_stage: r.entry_stage,
      entry_score: r.entry_score,
      signal_id: r.signal_id,
      confirmed_on: r.confirmed_on,
      signal_age_trade_days: r.signal_age_trade_days,
      entry_distance_atr: r.entry_distance_atr,
      risk_reward: r.risk_reward,
      risk_reward_uncertainty: r.risk_reward_uncertainty,
      soft_risk_count: r.soft_risk_count,
      market_regime: r.market_regime,
      entry_drift: r.entry_drift,
      entry_recheck_atr: r.entry_recheck_atr,
      entry_eligible_at_open: r.entry_eligible_at_open,
      invalidated_within: r.invalidated_within,
      observed_bars_forward: r.observed_bars_forward,
      breakdown_within_10: r.breakdown_within_10,
      horizons: measured,
    };
  });

  const mid = evalDays[Math.floor(evalDays.length / 2)] ?? opts.start;
  const groupAll = (rows: EntryObservation[], key: (r: EntryObservation) => string) =>
    Object.fromEntries(Object.entries(groupBy(rows, key)).map(([k, v]) => [k, groupStat(v, horizons)]));

  const summary: EntryStudySummary = {
    overall: groupStat(observations, horizons),
    by_family: groupAll(observations, o => o.strategy_family),
    by_stage: groupAll(observations, o => o.entry_stage),
    by_score_bucket: groupAll(observations, o => {
      const s = o.entry_score ?? -1;
      return s >= 95 ? 'score_ge_95' : s >= 90 ? 'score_90_95' : 'score_lt_90';
    }),
    by_regime: groupAll(observations, o => o.market_regime ?? 'unknown'),
    by_half: groupAll(observations, o => (o.as_of < mid ? 'first_half' : 'second_half')),
    by_sample_role: groupAll(observations, o => (o.as_of === opts.designDay ? 'design_day' : 'out_of_sample')),
    by_soft_risk: groupAll(observations, o => (o.soft_risk_count > 0 ? 'with_soft_risk' : 'clean')),
    plateau: {
      // Everything eligible is inside ENTRY_MAX_DISTANCE_ATR = 1.0, so these
      // thresholds only ever test whether tightening the gate would help.
      distance_atr_max: {
        '0.25': groupStat(observations.filter(o => (o.entry_distance_atr ?? 0) <= 0.25), horizons),
        '0.5': groupStat(observations.filter(o => (o.entry_distance_atr ?? 0) <= 0.5), horizons),
        '0.75': groupStat(observations.filter(o => (o.entry_distance_atr ?? 0) <= 0.75), horizons),
        '1.0 (gate)': groupStat(observations.filter(o => (o.entry_distance_atr ?? 0) <= 1.0), horizons),
      },
      age_max: {
        '3': groupStat(observations.filter(o => (o.signal_age_trade_days ?? 0) <= 3), horizons),
        '5': groupStat(observations.filter(o => (o.signal_age_trade_days ?? 0) <= 5), horizons),
        '10': groupStat(observations.filter(o => (o.signal_age_trade_days ?? 0) <= 10), horizons),
      },
    },
    risk_event_predictive: {
      with_soft_risk_breakdown_rate: groupStat(observations.filter(o => o.soft_risk_count > 0), horizons).breakout_within_10,
      without_soft_risk_breakdown_rate: groupStat(observations.filter(o => o.soft_risk_count === 0), horizons).breakout_within_10,
      notes: [
        'breakdown_within_10 统计信号日之后 10 个交易日内是否出现 trend_breakdown。',
        '若带看跌背离的那一组后续破位率更高，说明软风险标签携带信息；否则它只是噪音。',
      ],
    },
  };

  return {
    meta: {
      start: opts.start,
      end: opts.end,
      entry_rules_version: ENTRY_RULES_VERSION,
      evaluation_version: EVALUATION_VERSION,
      universe_size: opts.codes.length,
      days_evaluated: evalDays.length,
      horizons,
      costs: {
        buyFeeBps: HOTSPOT_EXPERIMENT_COSTS.buyFeeBps,
        sellFeeBps: HOTSPOT_EXPERIMENT_COSTS.sellFeeBps,
        slippageBps: HOTSPOT_EXPERIMENT_COSTS.slippageBps,
        maxExitDelay: HOTSPOT_EXPERIMENT_COSTS.maxExitDelay,
      },
      split_date: mid,
      engine: 'evaluation.evaluateEvents (T+1 开盘入场，涨跌停/停牌感知)',
      arm,
      data_gaps: [
        'SW_INDUSTRY_INDEX_ABSENT: index_daily 没有申万行业指数序列；"行业超额"改用 evaluation.ts 的等权同业参照（stock_basic.industry），是当前口径而非时点口径。',
        'RPS_HOLD_DISABLED: tc_rps_hold 需要每日全市场 RPS 截面，本次回放未计算，该策略不参与。',
        'UNIVERSE_IS_CONDITIONAL: 标的池为调用方给定的代码集合，结论不可外推到池外。',
        'OVERLAPPING_OBSERVATIONS: 同一信号在其有效期内的每个交易日各记一次，n 不是独立信号数；引擎 limitations 已声明因此不做显著性断言。',
      ],
      generated_at: new Date().toISOString(),
    },
    observations,
    summary,
    limitations,
  };
}

// ---------------------------------------------------------------- forward shadow

export interface EntryShadowResult {
  status: 'INSUFFICIENT_SAMPLE' | 'IMMATURE' | 'MATURE';
  since: string;
  as_of: string;
  snapshot_days: number;
  /** Snapshot days that actually carry an entry view (older snapshots do not). */
  snapshot_days_with_entry_view: number;
  signals_recorded: number;
  signals_evaluable: number;
  signals_matured: number;
  min_observations: number;
  horizon: number;
  stats: HorizonStat | null;
  note: string;
}

/**
 * Forward shadow: read the entry candidates the daily snapshot actually
 * published, then score them only once the window has closed. Until enough
 * matured signals exist the answer is INSUFFICIENT_SAMPLE — an honest "not
 * yet", never a number computed from three cases. Returns come from the same
 * evaluation engine as the historical study.
 */
export function entryShadow(
  db: DatabaseSync,
  opts: { since: string; asOf: string; horizon?: number; minObservations?: number },
): EntryShadowResult {
  const horizon = opts.horizon ?? 10;
  const minObs = opts.minObservations ?? MIN_GROUP_SAMPLE;
  const rows = db.prepare(
    'SELECT as_of, payload FROM hotspot_snapshot WHERE as_of BETWEEN ? AND ? ORDER BY as_of',
  ).all(opts.since, opts.asOf) as Array<{ as_of: string; payload: string }>;

  const picks: Array<{ date: string; code: string; score: number | null }> = [];
  let daysWithView = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      entry_view?: { entry_top10: Array<{ ts_code: string; entry_score: number | null }> };
    };
    if (payload.entry_view) daysWithView += 1;
    for (const e of payload.entry_view?.entry_top10 ?? []) {
      picks.push({ date: row.as_of, code: e.ts_code, score: e.entry_score });
    }
  }

  let outcomes: EvaluationOutcome[] = [];
  if (picks.length) {
    outcomes = evaluateEvents(db, picks.map(p => ({ date: p.date, ts_code: p.code, score: p.score })), {
      asOf: opts.asOf,
      horizon,
      buyFeeBps: HOTSPOT_EXPERIMENT_COSTS.buyFeeBps,
      sellFeeBps: HOTSPOT_EXPERIMENT_COSTS.sellFeeBps,
      slippageBps: HOTSPOT_EXPERIMENT_COSTS.slippageBps,
      maxExitDelay: HOTSPOT_EXPERIMENT_COSTS.maxExitDelay,
    }).outcomes;
  }

  const entered = outcomes.filter(o => o.entered).length;
  const completed = outcomes.filter(o => o.status === 'completed');
  const status = daysWithView === 0 || completed.length < minObs ? 'INSUFFICIENT_SAMPLE'
    : completed.length < entered ? 'IMMATURE' : 'MATURE';
  let stats: HorizonStat | null = null;
  if (completed.length) {
    const gross = distribution(completed.map(o => o.gross_return));
    const net = distribution(completed.map(o => o.net_return));
    stats = {
      n: completed.length,
      pending: outcomes.filter(o => o.status === 'pending').length,
      blocked: outcomes.filter(o => o.status !== 'completed' && o.status !== 'pending').length,
      mean: r4(gross.mean),
      median: r4(gross.median),
      mean_net: r4(net.mean),
      median_net: r4(net.median),
      win_rate: net.win_rate === null ? null : r4(net.win_rate),
      mean_excess_csi300: r4(mean(completed.map(o => o.excess.csi300).filter((v): v is number => v !== null))),
      mean_excess_industry: r4(mean(completed.map(o => o.excess.industry).filter((v): v is number => v !== null))),
      mean_mfe: null, mean_mae: null, mean_drawdown: null,
    };
  }
  return {
    status,
    since: opts.since,
    as_of: opts.asOf,
    snapshot_days: rows.length,
    snapshot_days_with_entry_view: daysWithView,
    signals_recorded: picks.length,
    signals_evaluable: entered,
    signals_matured: completed.length,
    min_observations: minObs,
    horizon,
    stats,
    note: daysWithView === 0
      ? `${rows.length} 份快照中没有任何一份携带 entry_view（均为 WP3 之前生成），前瞻样本尚未开始积累。`
      : status === 'INSUFFICIENT_SAMPLE'
        ? `只有 ${completed.length} 个到期的前瞻样本（需要 ≥ ${minObs}），不足以说明任何事。`
        : '前瞻样本已到期，但任务验收不等于策略有效——仍需跨市场状态检验。',
  };
}
