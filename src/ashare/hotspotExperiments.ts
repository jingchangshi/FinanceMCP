import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recentTradeDays } from './ingest.js';
import { evaluateEvents } from './evaluation.js';
import { blockInference, holmAdjust } from './validation.js';
import { CandidateRegistry, experimentSpecHash, outcomeFor, type CandidateManifest, type RegisterResult } from './candidateRegistry.js';
import { loadHotspotCandidates } from './hotspotSnapshots.js';
import {
  CHAMPION_ARM, CHALLENGER_ARM, HOTSPOT_EXPERIMENT_COSTS,
} from './hotspotTypes.js';

/**
 * Champion–Challenger evaluation (goal-1028 §P4, architecture.md §6).
 *
 * Champion = the stored `wl-1.0.0` watchlist membership on the selection date
 * (the system that is already in production research). Challenger = the
 * hotspot FOCUS pool. Both arms share ONE cost model (HOTSPOT_EXPERIMENT_
 * COSTS, identical to EXPERIMENT_A_COSTS), ONE horizon set ([5, 10, 20]),
 * and ONE evaluator (`evaluateEvents` — t+1 open entry, limit-up unbuyable,
 * limit-down/suspension exit deferral, fees + slippage). No new portfolio
 * accounting or statistical engine is created here: inference reuses
 * `blockInference` + `holmAdjust`, and registry bookkeeping reuses
 * CandidateRegistry. Runner reports are research observations, never order
 * authorization (RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION stays in force).
 */

export const HOTSPOT_POOL_SIZE = 30;
export const CC_HORIZONS = [5, 10, 20] as const;
export type CcHorizon = (typeof CC_HORIZONS)[number];

export interface CcArmSelection {
  arm: string;
  as_of: string;
  universe_size: number;
  pool: string[];
  /** Why the pool is what it is (for the record). */
  note: string;
}

export interface CcArmOutcome {
  arm: string;
  as_of: string;
  horizon: CcHorizon;
  pool: string[];
  net_return: number | null;
  market_return: number | null;
  excess: number | null;
  coverage: 'complete' | 'partial' | 'unavailable';
  entered: number;
  completed: number;
  not_entered: number;
}

/** Champion pool: watchlist membership at the latest snapshot ≤ asOf, cut to the shared size. */
export function selectChampionPool(db: DatabaseSync, asOf: string): CcArmSelection {
  const day = (db.prepare('SELECT MAX(trade_date) d FROM watchlist WHERE trade_date <= ?').get(asOf) as { d: string | null } | undefined)?.d;
  if (!day) return { arm: CHAMPION_ARM, as_of: asOf, universe_size: 0, pool: [], note: 'no_watchlist_snapshot_on_or_before' };
  const rows = db.prepare('SELECT ts_code FROM watchlist WHERE trade_date = ? ORDER BY rank ASC, ts_code ASC').all(day) as Array<{ ts_code: string }>;
  return {
    arm: CHAMPION_ARM, as_of: asOf, universe_size: rows.length,
    pool: rows.slice(0, HOTSPOT_POOL_SIZE).map(r => r.ts_code),
    note: `watchlist@${day}`,
  };
}

/** Challenger pool: hotspot FOCUS candidates from that date's snapshot. */
export function selectChallengerPool(db: DatabaseSync, asOf: string): CcArmSelection {
  const cands = loadHotspotCandidates(db, asOf, 'FOCUS');
  const stocks = cands.filter(c => c.instrument_type === 'STOCK');
  return {
    arm: CHALLENGER_ARM, as_of: asOf, universe_size: stocks.length,
    pool: stocks.slice(0, HOTSPOT_POOL_SIZE).map(c => c.ts_code),
    note: stocks.length ? `hotspot_focus@${asOf}` : 'no_hotspot_snapshot_on_date',
  };
}

function evaluateCcArm(db: DatabaseSync, sel: CcArmSelection, horizon: CcHorizon): CcArmOutcome {
  const report = evaluateEvents(
    db,
    sel.pool.map(code => ({ date: sel.as_of, ts_code: code })),
    { asOf: forwardAsOf(sel.as_of, horizon), horizon, ...HOTSPOT_EXPERIMENT_COSTS },
  );
  const outcomes = report.outcomes;
  const priced = outcomes.filter(o => o.status === 'completed' && Number.isFinite(o.net_return));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const net = mean(priced.map(o => o.net_return!));
  const paired = priced.filter(o => Number.isFinite(o.excess.equal_market));
  const market = mean(paired.map(o => o.net_return! - o.excess.equal_market!));
  const refs = priced.map(o => o.references.equal_market.status);
  return {
    arm: sel.arm, as_of: sel.as_of, horizon,
    pool: sel.pool, net_return: net, market_return: market,
    excess: net != null && market != null ? net - market : null,
    coverage: refs.length && refs.every(s => s === 'complete') ? 'complete'
      : refs.some(s => s === 'complete' || s === 'partial') ? 'partial' : 'unavailable',
    entered: outcomes.filter(o => o.entered).length,
    completed: priced.length,
    not_entered: outcomes.filter(o => !o.entered).length,
  };
}

/** YYYYMMDD + n calendar days (evaluator needs a real as-of, not just horizon). */
function forwardAsOf(yyyymmdd: string, horizon: number): string {
  const d = new Date(Date.parse(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() + horizon + HOTSPOT_EXPERIMENT_COSTS.maxExitDelay + 2);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export interface CcRunOptions {
  start: string;
  end: string;
  /** Last date on which forward windows must fully resolve; selections whose horizon+delay crosses it are skipped, never truncated. */
  observation_end: string;
  /** Sample one selection every N trade days (default 1 = daily). */
  step_days?: number;
}

export interface CcHorizonResult {
  horizon: CcHorizon;
  /** Paired challenger-minus-champion net returns (only dates where BOTH arms priced). */
  paired: Array<{ date: string; challenger: number; champion: number; diff: number }>;
  mean_diff: number | null;
  inference: {
    method: string; n: number; status: string;
    p_value: number | null; p_holm: number | null; rejected_at_005: boolean;
  };
}

export interface CcReport {
  version: string;
  cost_model: typeof HOTSPOT_EXPERIMENT_COSTS;
  horizons: readonly number[];
  selection_dates: string[];
  skipped: { no_champion: number; no_challenger: number; window_incomplete: number };
  per_horizon: CcHorizonResult[];
  /** True when inference is descriptive only (n < 20 or missing pairs). */
  research_only: true;
}

const CC_VERSION = 'cc-hotspot-1.0.0';

/** Run the walk-forward comparison over a selection window. */
export function runChampionChallenger(db: DatabaseSync, opts: CcRunOptions): CcReport {
  const allDays = recentTradeDays(db, opts.observation_end, 400);
  const step = opts.step_days ?? 1;
  const selectionDates = allDays.filter(d => d >= opts.start && d <= opts.end);
  const skipped = { no_champion: 0, no_challenger: 0, window_incomplete: 0 };
  const perHorizon: Record<CcHorizon, Array<{ date: string; challenger: number; champion: number; diff: number }>> =
    { 5: [], 10: [], 20: [] };

  selectionDates.forEach((d, idx) => {
    if (idx % step !== 0) return;
    const champion = selectChampionPool(db, d);
    const challenger = selectChallengerPool(db, d);
    if (champion.pool.length === 0) { skipped.no_champion++; return; }
    if (challenger.pool.length === 0) { skipped.no_challenger++; return; }
    for (const h of CC_HORIZONS) {
      // Both arms must be fully evaluable; a truncated forward window is
      // missing data, never a partial return.
      const lastNeeded = allDays[allDays.indexOf(d) + h + HOTSPOT_EXPERIMENT_COSTS.maxExitDelay];
      if (!lastNeeded || lastNeeded > opts.observation_end) { skipped.window_incomplete++; continue; }
      const c = evaluateCcArm(db, champion, h);
      const k = evaluateCcArm(db, challenger, h);
      if (c.net_return === null || k.net_return === null) continue;
      perHorizon[h].push({ date: d, challenger: k.net_return, champion: c.net_return, diff: k.net_return - c.net_return });
    }
  });

  // Inference family: exactly the three pre-registered horizons (Holm).
  const raw = CC_HORIZONS.map(h => {
    const series = perHorizon[h].map(p => p.diff);
    const inf = blockInference(series);
    return { h, series, inf };
  });
  const holm = holmAdjust(raw.map(r => ({ id: `cc_excess:${r.h}`, p_value: r.inf.p_value })));

  return {
    version: CC_VERSION,
    cost_model: HOTSPOT_EXPERIMENT_COSTS,
    horizons: CC_HORIZONS,
    selection_dates: selectionDates,
    skipped,
    per_horizon: raw.map((r, i) => ({
      horizon: r.h,
      paired: perHorizon[r.h],
      mean_diff: r.series.length ? r.series.reduce((s, x) => s + x, 0) / r.series.length : null,
      inference: {
        method: r.inf.method, n: r.inf.n, status: r.inf.status,
        p_value: r.inf.p_value, p_holm: holm[i].p_holm, rejected_at_005: holm[i].rejected_at_005,
      },
    })),
    research_only: true,
  };
}

// ---------------------------------------------------------------- registry integration

export const CHALLENGER_CANDIDATE_ID = 'hotspot-multistrategy-pool';
export const CHALLENGER_CANDIDATE_VERSION = 'hs-pool-1.0.0';

/** Pre-registered success gate: challenger wins on a majority of paired dates. */
export const CC_SUCCESS_CRITERIA = { type: 'win_rate', reading: 'cc_excess', min: 0.55 } as const;

/** Build the challenger's CandidateManifest (spec BEFORE results, always). */
export function challengerManifest(args: {
  researchWindow: { start: string; end: string };
  formationWindow: { start: string; end: string };
  holdoutWindow: { start: string; end: string };
  forwardStart: string;
  researchSnapshotId: string;
  codeSha: string;
  createdAt: string;
}): CandidateManifest {
  return {
    candidate_id: CHALLENGER_CANDIDATE_ID,
    candidate_version: CHALLENGER_CANDIDATE_VERSION,
    strategy_family: 'HOTSPOT_MULTISTRATEGY',
    economic_hypothesis: '热点行业驱动的动态候选池在共享成本与成交约束下,净收益分布优于既有 wl-1.0.0 观察池',
    universe_specification: { pool: 'hotspot FOCUS 30-50, focus cut 30', instrument: 'STOCK', dedup: 'ts_code' },
    signal_definition: { engine: 'strategies-hs-1.0.0', families: ['TREND_CONTINUATION', 'BREAKOUT', 'REVERSAL'], confirmation: 'confirmed_on, never backdated' },
    portfolio_construction: { scheme: 'equal_weight_top_30', pool_size: HOTSPOT_POOL_SIZE, shortfall_allowed: true },
    execution_policy: { entry: 't+1_open', limit_up_entry: 'skip', limit_down_exit: 'defer', max_exit_delay: HOTSPOT_EXPERIMENT_COSTS.maxExitDelay },
    parameter_space: { source: 'pre-registered hotspot-config-1.0.0', search_budget: 0 },
    research_data_snapshot_id: args.researchSnapshotId,
    code_sha: args.codeSha,
    cost_model_version: 'hotspot-costs-1.0.0',
    benchmark_versions: { equal_market: 'eq-mkt-1.0.0', csi300: '000300.SH' },
    research_window: args.researchWindow,
    formation_window: args.formationWindow,
    historical_holdout_window: args.holdoutWindow,
    forward_start: args.forwardStart,
    evaluation_horizons: [...CC_HORIZONS],
    rebalance_period: 'daily_selection',
    risk_limits: { max_positions: HOTSPOT_POOL_SIZE, trade_permission: 'research_only' },
    capital_and_capacity: { note: 'research simulation only; no capital attached' },
    performance_reference: { champion: CHAMPION_ARM, pool: 'wl-1.0.0 watchlist' },
    multiple_testing_family: 'cc_excess:5,cc_excess:10,cc_excess:20',
    success_criteria: CC_SUCCESS_CRITERIA,
    failure_criteria: { type: 'threshold', reading: 'cc_excess', max: 0 },
    promotion_criteria: {
      type: 'manual_review',
      requires: [
        'TRUE_FORWARD 观察记录（validation.ts）先行，win_rate 达标只是必要非充分条件',
        '用户可见的评审记录；本 spec 绝不授权生产变更或下单',
      ],
    },
    elimination_criteria: { type: 'threshold', reading: 'cc_excess', max: 0 },
    created_at: args.createdAt,
    mechanism_and_counter_evidence: '机制:行业动量/广度/RPS截面与形态确认时滞的组合在A股热点扩散期可能有超额;反证:样本可能集中于牛市段、热点识别滞后、W底确认滞后削弱入场价,幸存者偏差受index_member_all无out_date限制',
  };
}

export function registerChallenger(registry: CandidateRegistry, manifest: CandidateManifest): RegisterResult {
  return registry.register(manifest);
}

export function challengerSpecHash(manifest: CandidateManifest): string {
  return experimentSpecHash(manifest as unknown as Record<string, unknown>);
}

/** Adjudicate a CC report against the pre-registered criteria. */
export function adjudicateCcReport(report: CcReport): {
  outcome: string;
  readings: Array<{ id: string; value: number | null }>;
} {
  const readings = report.per_horizon.map(h => ({ id: `cc_excess:${h.horizon}`, value: h.mean_diff }));
  // One reading per paired date so a win_rate criterion sees the daily
  // evidence, not only the horizon means.
  for (const h of report.per_horizon) for (const p of h.paired) {
    readings.push({ id: `cc_excess:${h.horizon}:${p.date}`, value: p.diff });
  }
  const outcome = outcomeFor(CC_SUCCESS_CRITERIA, readings);
  return { outcome, readings };
}

/** Adjudicate AND record the run in the registry (spec hash checked against the registered manifest). */
export function recordChallengerRun(
  registry: CandidateRegistry, manifest: CandidateManifest, report: CcReport, runId: string,
): { outcome: string; evidence: string; recorded: boolean } {
  const { outcome, readings } = adjudicateCcReport(report);
  const evidence = evidenceHash(report);
  registry.recordResult({
    candidate_id: CHALLENGER_CANDIDATE_ID,
    candidate_version: CHALLENGER_CANDIDATE_VERSION,
    spec_hash: challengerSpecHash(manifest),
    outcome,
    reason: `champion-challenger ${report.version} over ${report.selection_dates.length} selection dates`,
    evidence,
    run_id: runId,
    as_of: report.selection_dates[report.selection_dates.length - 1] ?? new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  });
  void readings;
  return { outcome, evidence, recorded: true };
}

export function evidenceHash(report: CcReport): string {
  return createHash('sha256').update(JSON.stringify({
    version: report.version,
    selection_dates: report.selection_dates,
    per_horizon: report.per_horizon.map(h => ({ h: h.horizon, paired: h.paired })),
  })).digest('hex');
}
