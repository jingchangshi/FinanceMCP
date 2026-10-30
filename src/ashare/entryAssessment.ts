/**
 * Entry-timing assessment (goal-1030 WP2).
 *
 * Research value and entry timing are different questions: `analysis.ts`
 * scores how interesting a company is, this module asks whether *now* is a
 * researchable entry window. Nothing here changes the factor score, the FOCUS
 * definition or the watchlist; the output is a research stage plus a fully
 * reproducible score, and it never emits a target price or an execution
 * instruction.
 *
 * Rules are frozen under `entry-rules-1.0.0` BEFORE any 2026-10-29 entry
 * outcome was evaluated; changing a parameter requires a new version and the
 * out-of-sample re-validation in WP4.
 *
 * 1.1.0 (goal-1031 §2.1-3): `entry_trigger.condition` no longer copies the
 * strategy's invalidation text. Only the wording of an existing field changed;
 * no stage, distance, score, gate or threshold moved, so 1.0.0 results remain
 * numerically comparable and are NOT recomputed with this version.
 *
 * 1.2.0 (goal-1031 §2.1): three substantive corrections, each with a test.
 *   a. `entry_trigger.condition` now quotes the strategy's own trigger text
 *      (`signal.trigger_conditions`) and states whether it is already met —
 *      the 1.1.0 wording was generic and did not say what was actually true.
 *   b. eligibility rejects a setup whose close is already beyond its own
 *      invalidation level (`INVALIDATION_ALREADY_BREACHED`). Previously such a
 *      row could be eligible (603119.SH, 2026-10-30: risk −0.03 ATR).
 *   c. reward windows exclude the as-of bar. The trend `prior_high`, the
 *      divergence `recentHigh`, the RSI resistance and the squeeze base are all
 *      "prior" structure, and including today let a stock's own spike set its
 *      own target. This lowers some reward estimates; it is not a re-tune.
 * `risk_basis` / `risk_note` are disclosure only. No score weight, no ATR
 * threshold and no stage boundary moved, so score comparability across 1.1.0
 * holds; reward and eligibility do change, hence the version bump.
 */
import type { Bars, IndicatorSet } from './indicators.js';
import type {
  CandidateEntry, DataQuality, EntryAssessment, EntryDistance, EntryFamily, EntryStage,
  RewardEstimate, ScoreContribution, SignalEvent, TradePermission,
} from './hotspotTypes.js';
import { tradePermissionOf } from './hotspotTypes.js';
import type { StockStrategyScan } from './strategies.js';
import { maxAgeOf } from './signalLifecycle.js';

export const ENTRY_RULES_VERSION = 'entry-rules-1.2.0';

/** Trade days a confirmation still counts as "new" for entry timing. */
export const NEWLY_CONFIRMED_MAX_AGE: Readonly<Record<EntryFamily, number>> = {
  REVERSAL: 10,
  BREAKOUT: 5,
  TREND_CONTINUATION: 3,
};

/** Price may sit at most this many ATR above the reference entry price. */
export const ENTRY_MAX_DISTANCE_ATR = 1.0;
/** Distance to MA20 that still counts as a healthy pullback entry. */
export const PULLBACK_TOUCH_TOL_ATR = 0.5;
/** A hard risk inside this many trade days blocks entry. */
export const RISK_BLOCK_WINDOW_TRADE_DAYS = 3;
/** Risk distances below a quarter of one ATR sit inside ordinary daily noise. */
export const MIN_MEANINGFUL_RISK_ATR = 0.25;
export const ENTRY_MIN_BARS = 61;

const FAMILIES: readonly EntryFamily[] = ['REVERSAL', 'BREAKOUT', 'TREND_CONTINUATION'];

/** Lower is closer to an actionable research window. */
const STAGE_RANK: Record<EntryStage, number> = {
  PULLBACK_READY: 0,
  NEWLY_CONFIRMED: 1,
  PREPARING: 2,
  EXTENDED: 3,
  RISK_BLOCKED: 4,
  INVALIDATED: 5,
  EXPIRED: 6,
  INSUFFICIENT_DATA: 7,
};

/** Only a confirmed setup may be an entry candidate; PREPARING is researchable
 * but has not passed the confirmation gate yet (goal WP3 class 2). */
const ELIGIBLE_STAGES = new Set<EntryStage>(['NEWLY_CONFIRMED', 'PULLBACK_READY']);

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/** Indicator lookup that tolerates a missing/short series: absent ⇒ NaN ⇒ "unknown". */
const at = (arr: ArrayLike<number> | undefined, k: number): number =>
  (arr && Number.isFinite(arr[k]) ? arr[k] : Number.NaN);

function evNumber(e: SignalEvent, key: string): number | null {
  const v = e.evidence[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface EntryInput {
  ts_code: string;
  scan: StockStrategyScan;
  bars: Bars;
  x: IndicatorSet;
  asOf: string;
  /**
   * Index of the as-of bar. A historical replay scans only bars ≤ endIdx, so the
   * assessment must read that same bar — never the last bar of the loaded
   * series, which would be look-ahead.
   */
  asOfIndex?: number;
  tradePermission?: TradePermission;
}

/**
 * Assess every family that has evidence at `asOf`, then roll up one verdict.
 * A candidate with no evidence in any family gets `entry_stage: null` — it is
 * a research candidate, not a broken one.
 */
export function assessCandidateEntry(input: EntryInput): CandidateEntry {
  const perm = input.tradePermission ?? tradePermissionOf(input.ts_code).perm;
  const i = Math.min(input.asOfIndex ?? input.bars.dates.length - 1, input.bars.dates.length - 1);
  const assessments = FAMILIES
    .map(family => assessFamily(family, input, perm, i))
    .filter((a): a is EntryAssessment => a !== null);

  if (assessments.length === 0) {
    return {
      entry_stage: null, entry_eligibility: false, entry_score: null,
      rejection_reasons: ['NO_ENTRY_EVIDENCE'], entry_assessments: [],
      analysis_version: ENTRY_RULES_VERSION,
    };
  }

  const sorted = [...assessments].sort((a, b) =>
    Number(b.entry_eligibility) - Number(a.entry_eligibility)
    || STAGE_RANK[a.entry_stage] - STAGE_RANK[b.entry_stage]
    || (b.entry_score ?? -1) - (a.entry_score ?? -1)
    || (b.confirmed_on ?? '').localeCompare(a.confirmed_on ?? ''));

  const primary = sorted[0];
  return {
    entry_stage: primary.entry_stage,
    entry_eligibility: primary.entry_eligibility,
    entry_score: primary.entry_score,
    rejection_reasons: primary.entry_eligibility ? [] : [...primary.rejection_reasons],
    entry_assessments: sorted,
    analysis_version: ENTRY_RULES_VERSION,
  };
}

function assessFamily(
  family: EntryFamily, input: EntryInput, perm: TradePermission, i: number,
): EntryAssessment | null {
  const { scan, bars, x, asOf } = input;
  const famSignals = scan.events.filter(e => e.family === family);
  const forming = scan.forming.filter(f => f.family === family);
  if (famSignals.length === 0 && forming.length === 0) return null;

  const close = bars.close[i];
  const atr = at(x.atr14, i);
  const indexOf = new Map(bars.dates.map((d, k) => [d, k]));
  const open = famSignals
    .filter(e => e.status === 'active' || e.status === 'confirmed')
    .sort((a, b) => b.confirmed_on.localeCompare(a.confirmed_on));
  const rep = open[0] ?? [...famSignals].sort((a, b) => b.confirmed_on.localeCompare(a.confirmed_on))[0] ?? null;

  const base = (): EntryAssessment => ({
    strategy_family: family,
    entry_stage: 'INSUFFICIENT_DATA',
    entry_eligibility: false,
    active_signal_ids: open.map(e => e.signal_id ?? `${e.ts_code}:${e.strategy_id}:${e.confirmed_on}`),
    supporting_signal_ids: open.slice(1).map(e => e.signal_id ?? `${e.ts_code}:${e.strategy_id}:${e.confirmed_on}`),
    representative_signal_id: rep?.signal_id ?? null,
    confirmed_on: rep?.confirmed_on ?? null,
    last_validated_on: rep?.last_validated_on ?? null,
    invalidated_on: rep?.invalidated_on ?? null,
    signal_age_trade_days: rep?.signal_age_trade_days ?? null,
    entry_trigger: { condition: '', reference_price: null, reference_kind: null },
    entry_distance: { price: null, pct: null, atr: null },
    invalidation_condition: { code: null, level: null, description: '' },
    objective_risk_distance: { price: null, pct: null, atr: null },
    risk_distance_reason: null,
    risk_basis: null,
    risk_note: 'no risk distance was computed for this state',
    reward_estimate: { kind: 'none', price: null, distance: null, pct: null, note: '' },
    risk_reward: null,
    risk_reward_uncertainty: null,
    hard_invalidations: [],
    soft_risk_warnings: [],
    entry_score: null,
    ranking_contributions: [],
    rejection_reasons: [],
    data_quality: 'OK',
    as_of_trade_date: asOf,
    analysis_version: ENTRY_RULES_VERSION,
  });

  const out = base();

  // ---- data sufficiency
  if (i < ENTRY_MIN_BARS || !finite(close)) {
    out.entry_stage = 'INSUFFICIENT_DATA';
    out.data_quality = 'UNAVAILABLE';
    out.rejection_reasons.push('INSUFFICIENT_HISTORY');
    return out;
  }
  if (rep && rep.status === 'insufficient_data') {
    out.entry_stage = 'INSUFFICIENT_DATA';
    out.data_quality = 'DEGRADED';
    out.rejection_reasons.push('REQUIRED_INDICATOR_MISSING');
    return out;
  }

  // ---- hard invalidation: terminal state of the representative signal
  if (rep && rep.status === 'invalidated') {
    out.hard_invalidations.push(rep.invalidation_reason ?? 'invalidated');
    out.entry_stage = 'INVALIDATED';
    out.invalidation_condition = {
      code: rep.invalidation_reason ?? null,
      level: null,
      description: rep.invalidation_conditions,
    };
    out.rejection_reasons.push('SIGNAL_INVALIDATED');
    return out;
  }

  // ---- risk conflicts (hard blocks vs soft warnings)
  //
  // A hard risk is evidence *against the live signal*, so it only blocks when it
  // fired on or after the representative confirmation bar. A breakdown strictly
  // earlier than the confirmation is superseded by it (the contract that
  // confirmed the signal re-established the trend), and re-using it would let
  // stale history veto a fresh setup — the defect WP1 removed from scoring.
  // With no confirmed signal (PREPARING) the window is simply the recent past.
  const repConfIdx = rep ? indexOf.get(rep.confirmed_on) : undefined;
  const hardRisks = scan.risk_events.filter(r => {
    const idx = indexOf.get(r.last_on);
    if (idx === undefined) return false;
    const windowOk = open.length > 0 && repConfIdx !== undefined
      ? idx >= repConfIdx
      : i - idx <= RISK_BLOCK_WINDOW_TRADE_DAYS;
    if (!windowOk) return false;
    if (r.id === 'trend_breakdown') return true;
    // Overheating only blocks an established signal; on the confirmation bar
    // itself it describes the breakout, not a chase.
    return r.id === 'overheated' && (out.signal_age_trade_days ?? 0) > 0;
  });
  const softRisks = scan.risk_events.filter(r =>
    r.id === 'macd_bear_divergence' && r.last_on >= (rep?.confirmed_on ?? asOf));
  out.soft_risk_warnings = softRisks.map(r => `${r.id}@${r.on}`);

  // ---- lifecycle-only states when nothing is open
  if (open.length === 0 && forming.length === 0) {
    out.entry_stage = 'EXPIRED';
    out.rejection_reasons.push(rep && rep.status === 'expired' ? 'SIGNAL_EXPIRED' : 'NO_CURRENT_SIGNAL');
    return out;
  }

  // ---- entry reference and trigger (only current evidence may define it)
  const refSignal = open[0] ?? (forming.length === 0 ? rep : null);
  const ref = referenceFor(refSignal, forming[0], bars, x, i, indexOf);
  out.entry_trigger = ref.trigger;
  out.entry_distance = distanceTo(close, ref.price, atr);

  if (open.length === 0) {
    out.entry_stage = hardRisks.length > 0 ? 'RISK_BLOCKED' : 'PREPARING';
    if (out.entry_stage === 'RISK_BLOCKED') out.rejection_reasons.push('HARD_RISK_CONFLICT');
  } else {
    const maxAge = NEWLY_CONFIRMED_MAX_AGE[family];
    const age = out.signal_age_trade_days ?? 0;
    const atrDist = out.entry_distance.atr;
    const nearMa20 = family === 'TREND_CONTINUATION'
      && finite(at(x.ma20, i)) && finite(atr) && atr > 0
      && Math.abs(close - at(x.ma20, i)) / atr <= PULLBACK_TOUCH_TOL_ATR
      && close > at(x.ma20, i) * 0.99;
    if (hardRisks.length > 0) {
      out.entry_stage = 'RISK_BLOCKED';
      out.rejection_reasons.push('HARD_RISK_CONFLICT');
    } else if (nearMa20) {
      out.entry_stage = 'PULLBACK_READY';
    } else if (age <= maxAge && atrDist !== null && atrDist <= ENTRY_MAX_DISTANCE_ATR) {
      out.entry_stage = 'NEWLY_CONFIRMED';
    } else {
      out.entry_stage = 'EXTENDED';
      out.rejection_reasons.push(atrDist !== null && atrDist > ENTRY_MAX_DISTANCE_ATR ? 'ENTRY_TOO_FAR' : 'ENTRY_WINDOW_PASSED');
    }
  }

  // ---- invalidation level, reward, distances
  const inv = invalidationLevelFor(open[0] ?? null, bars, x, i);
  out.invalidation_condition = inv;
  if (inv.level !== null) {
    out.objective_risk_distance = distanceTo(close, inv.level, atr);
    // goal-1031 §2.1-2: name what the number is. It is the distance to the
    // invalidation trigger; a gap through the level loses more than this, so
    // it is an input to the ratio, not a maximum loss.
    out.risk_basis = 'invalidation_trigger';
    out.risk_note = 'distance to the invalidation trigger, not a maximum loss: '
      + 'a gap through the level realises more than this distance';
  } else {
    out.risk_distance_reason = 'indicator_based_invalidation';
    out.risk_basis = null;
    out.risk_note = 'no price level; the invalidation is indicator-based, so no risk distance exists';
  }

  out.reward_estimate = rewardFor(open[0] ?? null, bars, x, i, close, indexOf);
  if (finite(out.reward_estimate.distance) && finite(out.objective_risk_distance.price)) {
    const risk = close - out.objective_risk_distance.price;
    const reward = out.reward_estimate.distance as number;
    if (risk > 0 && reward > 0) {
      out.risk_reward = Math.round((reward / risk) * 100) / 100;
      out.risk_reward_uncertainty = out.reward_estimate.kind === 'measured_move'
        ? 'MEDIUM' : 'LOW';
      // A stop that sits inside one bar's noise produces a spectacular ratio
      // that is arithmetically true and practically meaningless, so the ratio is
      // reported but flagged HIGH rather than trusted.
      const riskAtr = out.objective_risk_distance.atr;
      if (riskAtr !== null && riskAtr < MIN_MEANINGFUL_RISK_ATR) out.risk_reward_uncertainty = 'HIGH';
    } else if (reward <= 0) {
      out.risk_reward_uncertainty = 'HIGH';
    }
  } else {
    out.risk_reward_uncertainty = 'HIGH';
  }

  // ---- score and eligibility
  const scored = scoreEntry(out, family, rep);
  out.entry_score = scored.score;
  out.ranking_contributions = scored.parts;
  out.entry_eligibility = eligibility(out, perm);
  return out;
}

/** Entry reference price + trigger wording for the current evidence. */
function referenceFor(
  signal: SignalEvent | null,
  forming: StockStrategyScan['forming'][number] | undefined,
  bars: Bars, x: IndicatorSet, i: number, indexOf: Map<string, number>,
): { trigger: EntryAssessment['entry_trigger']; price: number | null } {
  if (signal) {
    const sid = signal.strategy_id;
    const confIdx = indexOf.get(signal.confirmed_on);
    // goal-1031 §2.1-3: the field is the strategy's own entry predicate, not its
    // exit predicate. The invalidation text lives only in `invalidation_condition`.
    const met = signal.trigger_conditions ?? 'the strategy confirmation rule';
    if (sid === 'tc_pullback_resume' || sid === 'tc_ma_trend' || sid === 'tc_rps_hold') {
      const ma20 = at(x.ma20, i);
      if (finite(ma20)) {
        return {
          // For a trend setup the entry still waits for something: price coming
          // back to MA20. That is a real trigger, and it is disjoint from the
          // invalidation ("close below MA60"), which is the opposite claim.
          trigger: {
            condition: `pullback entry: price returns to MA20; the signal was confirmed on ${signal.confirmed_on} by: ${met}`,
            reference_price: r4(ma20),
            reference_kind: 'ma20',
          },
          price: ma20,
        };
      }
    }
    // A confirmed breakout is referenced by its confirmation close, never by
    // the level it broke out of: that level is by construction below the
    // confirmation bar, so using it would mark every valid breakout EXTENDED.
    // The broken level is still carried — as the invalidation price.
    if (confIdx !== undefined) {
      const p = bars.close[confIdx];
      return {
        // Nothing is still "needed": the trigger is already met on the
        // confirmation bar, and the text says so instead of describing failure.
        trigger: {
          condition: `already met on ${signal.confirmed_on}: ${met}`,
          reference_price: r4(p),
          reference_kind: 'confirmation_close',
        },
        price: p,
      };
    }
  }
  if (forming) {
    const sid = forming.strategy_id;
    if (sid === 'bo_range') {
      const level = typeof forming.evidence.prior_high === 'number' ? forming.evidence.prior_high : null;
      return {
        trigger: { condition: 'close above the prior high on volume', reference_price: level, reference_kind: 'prior_high' },
        price: level,
      };
    }
    if (sid === 'bo_squeeze' && finite(at(x.bollUp, i))) {
      return {
        trigger: { condition: 'close above the upper band', reference_price: r4(at(x.bollUp, i)), reference_kind: 'upper_band' },
        price: at(x.bollUp, i),
      };
    }
    if (sid === 'tc_pullback_resume' && finite(at(x.ma20, i))) {
      return {
        trigger: { condition: 'up close above MA20', reference_price: r4(at(x.ma20, i)), reference_kind: 'ma20' },
        price: at(x.ma20, i),
      };
    }
    return {
      trigger: { condition: 'pattern confirmation', reference_price: null, reference_kind: null },
      price: null,
    };
  }
  return { trigger: { condition: '', reference_price: null, reference_kind: null }, price: null };
}

function distanceTo(close: number, price: number | null, atr: number): EntryDistance {
  if (!finite(price) || price <= 0) return { price: null, pct: null, atr: null };
  const pct = close / price - 1;
  return {
    price: r4(price),
    pct: r4(pct),
    atr: finite(atr) && atr > 0 ? r2((close - price) / atr) : null,
  };
}

/** Objective invalidation price for the representative strategy. */
function invalidationLevelFor(
  signal: SignalEvent | null, bars: Bars, x: IndicatorSet, i: number,
): EntryAssessment['invalidation_condition'] {
  if (!signal) return { code: null, level: null, description: '' };
  const sid = signal.strategy_id;
  const description = signal.invalidation_conditions;
  switch (sid) {
    case 'tc_ma_trend':
    case 'tc_pullback_resume':
      return finite(at(x.ma60, i))
        ? { code: 'close_below_ma60', level: r4(at(x.ma60, i)), description }
        : { code: 'close_below_ma60', level: null, description };
    case 'tc_rps_hold':
      return finite(at(x.ma20, i))
        ? { code: 'close_below_ma20', level: r4(at(x.ma20, i)), description }
        : { code: 'close_below_ma20', level: null, description };
    case 'bo_volume_20d': {
      const level = evNumber(signal, 'breakout_level');
      return { code: 'close_below_breakout_3', level, description };
    }
    case 'bo_range':
      return { code: 'close_below_prior_high', level: evNumber(signal, 'prior_high'), description };
    case 'bo_squeeze':
      return finite(at(x.bollMid, i))
        ? { code: 'close_below_boll_mid', level: r4(at(x.bollMid, i)), description }
        : { code: 'close_below_boll_mid', level: null, description };
    case 'rv_macd_divergence':
      return { code: 'close_below_divergence_low', level: evNumber(signal, 'divergence_low'), description };
    case 'rv_macd_w_bottom':
      return { code: 'dif_below_w_lows', level: null, description };
    case 'rv_rsi_oversold':
      return { code: 'rsi_new_low', level: null, description };
    default:
      return { code: null, level: null, description };
  }
}

/**
 * Objective upside estimate. Only three pre-defined conventions are allowed;
 * when the geometry is unavailable the answer is "unknown", never a guess.
 */
function rewardFor(
  signal: SignalEvent | null, bars: Bars, x: IndicatorSet, i: number, close: number,
  indexOf: Map<string, number>,
): RewardEstimate {
  const none = (note: string): RewardEstimate => ({ kind: 'none', price: null, distance: null, pct: null, note });
  if (!signal) return none('no confirmed signal to measure');
  const sid = signal.strategy_id;
  const mk = (kind: RewardEstimate['kind'], price: number | null, note: string): RewardEstimate => {
    if (!finite(price) || price <= 0) return none(note);
    const distance = price - close;
    return { kind, price: r4(price), distance: r4(distance), pct: r4(distance / close), note };
  };

  if (sid === 'rv_macd_w_bottom') {
    const j1 = typeof signal.evidence.j1_date === 'string' ? indexOf.get(signal.evidence.j1_date) : undefined;
    const j2 = typeof signal.evidence.j2_date === 'string' ? indexOf.get(signal.evidence.j2_date) : undefined;
    if (j1 === undefined || j2 === undefined) return none('W pattern dates unavailable');
    const patternLow = Math.min(bars.low[j1], bars.low[j2]);
    let neckline = -Infinity;
    for (let k = j1; k <= j2; k++) neckline = Math.max(neckline, bars.high[k]);
    if (!finite(neckline) || !(neckline > patternLow)) return none('no measurable W geometry');
    return mk('measured_move', close + (neckline - patternLow), 'W-bottom height projected from entry');
  }
  if (sid === 'rv_macd_divergence') {
    const low = evNumber(signal, 'divergence_low');
    if (low === null) return none('divergence low unavailable');
    // goal-1031 §2.1-4: the reference high must predate the as-of bar. Including
    // it let today's own spike enlarge today's reward estimate.
    let recentHigh = -Infinity;
    for (let k = Math.max(0, i - 9); k < i; k++) recentHigh = Math.max(recentHigh, bars.high[k]);
    if (!Number.isFinite(recentHigh)) return none('no bar before the as-of bar to measure from');
    return mk('measured_move', close + (recentHigh - low), 'divergence height projected from entry');
  }
  if (sid === 'rv_rsi_oversold') {
    let resistance = -Infinity;
    for (let k = Math.max(0, i - 20); k < i; k++) resistance = Math.max(resistance, bars.high[k]);
    if (!Number.isFinite(resistance)) return none('no bar before the as-of bar to measure from');
    return mk('resistance', resistance, '20-bar high (pre-as-of) as objective resistance');
  }
  if (sid === 'bo_range' || sid === 'bo_volume_20d') {
    const priorHigh = evNumber(signal, 'prior_high') ?? evNumber(signal, 'breakout_level');
    let priorLow = evNumber(signal, 'prior_low');
    if (priorLow === null) {
      priorLow = Infinity;
      for (let k = Math.max(0, i - 20); k < i; k++) priorLow = Math.min(priorLow, bars.low[k]);
      if (!Number.isFinite(priorLow)) return none('range low unavailable');
    }
    if (priorHigh === null || !(priorHigh > priorLow)) return none('no measurable range');
    return mk('measured_move', close + (priorHigh - priorLow), 'box height projected from entry');
  }
  if (sid === 'bo_squeeze') {
    const width = finite(at(x.bollUp, i)) && finite(at(x.bollMid, i)) ? (at(x.bollUp, i) - at(x.bollMid, i)) * 4 : null;
    if (width === null) return none('no band width');
    let base = Infinity;
    for (let k = Math.max(0, i - 20); k < i; k++) base = Math.min(base, bars.low[k]);
    if (!Number.isFinite(base)) return none('no bar before the as-of bar to measure from');
    return mk('measured_move', close + (close - base) + width, 'squeeze range projected from entry');
  }
  // Trend continuation: objective upside is the prior swing high. "Prior" means
  // the bars before the as-of bar: including it made today's own high the
  // resistance and shrank the reward of exactly the strongest days.
  let priorHigh = -Infinity;
  for (let k = Math.max(0, i - 60); k < i; k++) priorHigh = Math.max(priorHigh, bars.high[k]);
  if (!finite(priorHigh) || priorHigh <= close) return none('price already at the prior swing high');
  return mk('prior_high', priorHigh, 'prior 60-bar swing high as objective resistance');
}

function scoreEntry(
  a: EntryAssessment, family: EntryFamily, rep: SignalEvent | null,
): { score: number | null; parts: ScoreContribution[] } {
  // Dead states carry no score: an invalidated or expired setup has nothing to
  // rank, and a score would invite comparing incomparable things. PREPARING is
  // scored (with a stage penalty) so the watch list can be ordered by how close
  // the pattern is to confirming, even though it is not entry-eligible.
  const scoreable = ELIGIBLE_STAGES.has(a.entry_stage)
    || a.entry_stage === 'PREPARING' || a.entry_stage === 'EXTENDED' || a.entry_stage === 'RISK_BLOCKED';
  if (!scoreable) return { score: null, parts: [] };
  const parts: ScoreContribution[] = [];
  const atrDist = a.entry_distance.atr;
  // Confirmed setups are penalized only for sitting above their reference (a
  // chase); an unconfirmed pattern is penalized for being far from the trigger
  // in either direction, because proximity is the whole point of PREPARING.
  const distInput = atrDist === null ? null
    : a.entry_stage === 'PREPARING' ? Math.abs(atrDist) : atrDist;
  const distancePen = distInput === null ? 10 : Math.min(30, Math.max(0, distInput - 0.5) * 20);
  parts.push({ factor: 'distance', raw: atrDist, weight: 20, points: -r2(distancePen) });

  const hard = a.hard_invalidations.length;
  const hardPen = a.entry_stage === 'RISK_BLOCKED' ? 40 : 0;
  const softPen = Math.min(20, a.soft_risk_warnings.length * 10);
  parts.push({ factor: 'hard_risk', raw: hard, weight: 40, points: -hardPen });
  parts.push({ factor: 'soft_risk', raw: a.soft_risk_warnings.length, weight: 10, points: -softPen });

  const maxAge = rep ? maxAgeOf(rep.strategy_id) : null;
  // Only a *live* confirmation ages: for PREPARING the representative is a past
  // (already closed) event and its age says nothing about the forming pattern.
  const age = a.active_signal_ids.length > 0 ? (a.signal_age_trade_days ?? 0) : 0;
  const agePen = maxAge && age > 0 ? Math.min(20, (age / maxAge) * 20) : 0;
  parts.push({ factor: 'age', raw: age, weight: 20, points: -r2(agePen) });

  const dataPen = a.data_quality === 'DEGRADED' ? 10 : a.data_quality === 'OK' ? 0 : 20;
  parts.push({ factor: 'data_quality', raw: a.data_quality === 'OK' ? 1 : 0, weight: 10, points: -dataPen });

  const stagePen = a.entry_stage === 'PREPARING' ? 15 : 0;
  parts.push({ factor: 'stage', raw: a.entry_stage === 'PREPARING' ? 0 : 1, weight: 15, points: -stagePen });

  // Risk/reward is the comparison the report asks the reader to make, so it is
  // scored too, as a penalty: a ratio of 3 or better costs nothing, and the
  // shortfall costs up to 15 points. An unknown ratio — or one flagged HIGH —
  // costs the full 15, so ignorance is never rewarded like evidence.
  const rr = a.risk_reward;
  const rrPen = finite(rr) && a.risk_reward_uncertainty !== 'HIGH'
    ? 15 - Math.min(15, Math.max(0, rr) * 5) : 15;
  parts.push({ factor: 'risk_reward', raw: rr, weight: 15, points: -r2(rrPen) });

  const raw = 100 - distancePen - hardPen - softPen - agePen - dataPen - stagePen - rrPen;
  return { score: r2(Math.max(0, Math.min(100, raw))), parts };
}

function eligibility(a: EntryAssessment, perm: TradePermission): boolean {
  const reasons: string[] = [];
  if (a.data_quality === 'UNAVAILABLE') reasons.push('DATA_UNAVAILABLE');
  if (perm !== 'EXECUTABLE') reasons.push('RESEARCH_ONLY_PERMISSION');
  if (!ELIGIBLE_STAGES.has(a.entry_stage)) {
    reasons.push(a.entry_stage === 'PREPARING' ? 'NOT_CONFIRMED' : `STAGE_${a.entry_stage}`);
  }
  if (a.hard_invalidations.length > 0) reasons.push('HARD_INVALIDATION');
  if (a.entry_stage === 'RISK_BLOCKED') reasons.push('RISK_BLOCKED');
  const atrDist = a.entry_distance.atr;
  if (atrDist !== null && atrDist > ENTRY_MAX_DISTANCE_ATR) reasons.push('ENTRY_TOO_FAR');
  // goal-1031 §2.1-2: a close already beyond its own invalidation level is not
  // an entry at all — the setup's failure condition is satisfied on the as-of
  // bar. Before this check such a row could still be eligible (603119.SH on
  // 2026-10-30: risk distance −0.03 ATR, no rejection reason).
  const riskAtr = a.objective_risk_distance.atr;
  if (riskAtr !== null && riskAtr < 0) reasons.push('INVALIDATION_ALREADY_BREACHED');
  a.rejection_reasons = [...new Set([...a.rejection_reasons, ...reasons])];
  return reasons.length === 0;
}
