/** §6.2 — runnable candidate experiments + pre-registered spec (goal-1026).
 *
 * Three things live here, in this order of responsibility:
 *
 * 1. **`buildExperimentSpec`** — the canonical way to hash a registered
 *    manifest into the experiment's `spec_hash`. The registry's `recordResult`
 *    and every experiment runner derive the hash through this one function, so
 *    "the spec was registered before the result" is structural: a post-hoc
 *    change to any identity field produces a different hash and the registry
 *    refuses the record.
 *
 * 2. **`runPoolExcessDiagnostic`** — the §6.1 sample-excess experiment: does
 *    the watchlist pool beat its counterfactuals (equal-weight market hold,
 *    and no-trade cash) over pre-declared formation and holdout segments?
 *    All statistics are imported from `validation.ts` — block bootstrap
 *    (`blockInference`), the three-segment split with purge (`splitDates`).
 *    There is deliberately NO second bootstrap/Holm implementation anywhere in
 *    this module (TactiCore research README: same seed, same block length,
 *    one implementation only).
 *
 * 3. **`buildPoolExcessCandidate`** — the registration manifest for that
 *    experiment as a *candidate*, with windows fixed from the declared
 *    research window rather than from whatever data exists.
 *
 * Anti-leakage properties, asserted rather than assumed:
 *   - The registered code identity is computed over THIS module's actual
 *     source bytes (`registeredCodeSha`), so "code version" is verifiable.
 *   - The experiment only reads the watchlist that was *stored* on each date
 *     (a past ranking decision) and prices through `asOf`; no forward price
 *     enters selection, and nothing here writes a signal or a production
 *     table.
 *   - Success/failure criteria are registered with the manifest and adjudicated
 *     read-only by `outcomeFor`; the runner does not pick thresholds.
 *   - The output is RESEARCH_ONLY. `RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION`
 *     is asserted by the CLI and tests: no result from this file may promote a
 *     candidate into an order-placing strategy (goal-1026 §6.2).
 *
 * Cost conventions follow `validationCli.ts`'s frozen protocol — buy 3bps /
 * sell 8bps / slippage 5bps / max exit delay 5 days — so the fee basis is
 * consistent with every other research run in the repo.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  blockInference,
  simulateFunded,
  splitDates,
  VALIDATION_VERSION,
} from './validation.js';
import { evaluateEvents, type EvaluationEvent } from './evaluation.js';
import { canonicalJson, experimentSpecHash, identityHash, validateManifest, type CandidateManifest, type SampleWindow } from './candidateRegistry.js';

/** Runner version; bump when the runner's computation changes (NOT when a
 * candidate's strategy changes — that is `code_sha`'s job). */
export const EXPERIMENT_RUNNER_VERSION = 'candidate-experiments-1.0.0';

/** The cost convention shared with `validationCli.ts`. Kept as a named
 * export so tests and reports can cite one source for "what a bps means here". */
export const RESEARCH_COSTS = {
  buy_fee_bps: 3,
  sell_fee_bps: 8,
  slippage_bps: 5,
  max_exit_delay: 5,
} as const;

/** Output of every runner; asserted by callers and tests. */
export const RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION = true;

// ---------------------------------------------------------------- spec hash

/** Canonical pre-registered spec hash for a candidate manifest. Single source
 * shared by registry and runners. */
export function buildExperimentSpec(manifest: unknown): string {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
  // Validate first so the hash is only ever computed over a manifest that
  // could actually have been registered — hashing an incomplete manifest
  // would produce a stable-looking hash of a nonexistent experiment.
  validateManifest(manifest);
  return experimentSpecHash(manifest as Record<string, unknown>);
}

// ---------------------------------------------------------------- code identity

/**
 * SHA-256 of this module's own source bytes — the `code_sha` a registered
 * manifest must carry for experiments executed here.
 *
 * Resolved from `import.meta.url` so it works identically from `build/` under
 * Node and from source maps; the file is read synchronously once per process.
 * If the module cannot be located (bundled contexts), registration fails loudly
 * instead of silently pinning a fake identity: an unknown code version is the
 * one thing a research registry must never record as known.
 */
export function registeredCodeSha(): string {
  const self = fileURLToPath(import.meta.url);
  // In build/, sibling of this module's .js; fall back to src/ layout when
  // executed from TypeScript sources (tests importing via strip-types).
  const candidates = [self, self.replace(/candidateExperiments\.js$/, 'candidateExperiments.ts')];
  for (const path of candidates) {
    if (path.endsWith('.ts') || path.endsWith('.js')) {
      try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
      } catch {
        // try next candidate
      }
    }
  }
  throw new Error('registeredCodeSha: cannot locate own source; refusing to mint a code identity we cannot verify');
}

// ---------------------------------------------------------------- sample window derivation

export interface WindowDefinition {
  research_window: SampleWindow;
  formation_window: SampleWindow;
  historical_holdout_window: SampleWindow;
  forward_start: string;
  /** How the split points were chosen — recorded so a reviewer sees that the
   * rule (not the outcome) chose them. */
  rule: string;
}

/**
 * Derive fixed research/formation/holdout windows from a declared research
 * window and a split rule — NOT from observed excesses. The split rule is a
 * fraction of the observed cohort series (e.g. 0.6), chosen in advance and
 * recorded in `rule`; changing it after seeing results would be the very
 * post-hoc selection §6.2 forbids.
 *
 * `forward_start` is the next trading day strictly after the holdout's last
 * matured cohort exit, resolved on the trading calendar — a single date, and
 * always later than `historical_holdout_window.end` as the registry requires.
 */
export function defineWindows(options: {
  researchStart: string;
  researchEnd: string;
  cohortDates: readonly string[];
  formationFraction?: number;
  days: readonly string[];
}): WindowDefinition {
  const { researchStart, researchEnd, cohortDates, days } = options;
  const formationFraction = options.formationFraction ?? 0.6;
  if (!Number.isFinite(formationFraction) || formationFraction <= 0 || formationFraction >= 1) {
    throw new Error('formationFraction must be in (0,1)');
  }
  if (!cohortDates.length) throw new Error('cohortDates is empty');
  const sorted = [...cohortDates].sort();
  const cut = Math.max(1, Math.min(sorted.length - 2, Math.floor(sorted.length * formationFraction)));
  const formationEnd = sorted[cut - 1];
  const holdoutStart = sorted[cut];
  // Holdout extends to the last cohort whose full horizon matures on/before
  // the declared research end. Exit resolution matches the production
  // convention: signal day t, entry t+1 open, exit t+horizon close — the exit
  // index is i + horizon (auditWatchlist / simulateFunded). Cohorts beyond it
  // could not have matured inside the window and are excluded rather than
  // silently truncated.
  const HORIZON_DAYS = 5;
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  let holdoutEnd = holdoutStart;
  for (const d of sorted.slice(cut)) {
    const i = dayIndex.get(d);
    const exit = i === undefined ? undefined : days[i + HORIZON_DAYS];
    if (exit && exit <= researchEnd) holdoutEnd = d;
    else break;
  }
  if (holdoutEnd < holdoutStart) holdoutEnd = holdoutStart;
  // forward_start: first trading day AFTER the holdout's last cohort EXIT (not
  // its signal date, not the exit day itself) — no forward observation window
  // may share a calendar day with a holdout measurement window. An earlier
  // version fell back to researchEnd when the calendar ended at the last exit,
  // which collapsed forward_start onto the exit day (observed on a production
  // run: forward_start 20261023 == holdout exit 20261023). Refuse instead:
  // fake headroom is a leakage hole, not a boundary.
  const lastIdx = dayIndex.get(holdoutEnd);
  const lastExit = lastIdx === undefined ? undefined : days[lastIdx + HORIZON_DAYS];
  if (lastExit === undefined) {
    throw new Error(`holdout end ${holdoutEnd} has no resolvable ${5}-day exit on the supplied calendar; cannot derive forward_start`);
  }
  const forwardStart = days.find(d => d > lastExit);
  if (forwardStart === undefined) {
    throw new Error(`no trading day after the holdout's last exit (${lastExit}); pass a calendar that extends beyond research_window.end — falling back to a shared day would place the forward boundary inside the holdout's final measurement window`);
  }
  return {
    research_window: { start: researchStart, end: researchEnd },
    formation_window: { start: sorted[0], end: formationEnd },
    historical_holdout_window: { start: holdoutStart, end: holdoutEnd },
    forward_start: forwardStart,
    rule: `formation = first ${Math.round(formationFraction * 100)}% of observed cohort dates by count; `
      + `holdout = subsequent cohorts whose full ${5}-day horizon matures on or before research_window.end; `
      + `forward_start = first trading day after the holdout's last exit. Rule fixed before observing any return.`,
  };
}

// ---------------------------------------------------------------- pool excess experiment

export interface CohortRow {
  date: string;
  entry_date: string;
  exit_date: string;
  pool_return: number | null;
  market_return: number | null;
  excess: number | null;
}

export interface ExcessSegment {
  label: string;
  cohorts: number;
  mean_pool_pct: number | null;
  mean_market_pct: number | null;
  mean_excess_pct: number | null;
  win_rate: number | null;
  /** Circular moving-block bootstrap over the segment's excess series —
   * imported from `validation.ts`; overlapping 5-day windows are never
   * treated as independent samples. */
  inference: ReturnType<typeof blockInference>;
}

export interface PoolExcessRun {
  status: 'RESEARCH_ONLY' | 'INSUFFICIENT_DATA';
  version: string;
  runner_version: string;
  as_of: string;
  horizon: number;
  window: WindowDefinition;
  /** Every matured cohort inside the research window, in date order. */
  cohorts: CohortRow[];
  segments: {
    formation: ExcessSegment;
    holdout: ExcessSegment;
    whole_window: ExcessSegment;
  };
  /** Pre-registered readings consumed by `outcomeFor` (ids are criterion keys). */
  readings: { id: string; value: number | null; weight?: number }[];
  /** The registered criteria this run must be adjudicated against — the runner
   * passes them through but never interprets them. */
  success_criteria: unknown;
  failure_criteria: unknown;
  costs: typeof RESEARCH_COSTS;
  runner_reports_are_not_order_authorization: boolean;
  limitations: string[];
}

const mean = (v: number[]): number | null => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e6) / 1e4);

/**
 * §6.1 sample experiment — pool vs its two counterfactuals.
 *
 * For every stored watchlist date inside the declared research window with a
 * matured horizon:
 *   - pool return: equal-weight mean of members' t+1-open → t+horizon-close
 *     adjusted returns (what the stored ranking would have realised);
 *   - market counterfactual: equal-weight mean over the same priced universe
 *     (passive buy-and-hold of the equal-weight market);
 *   - cash counterfactual: zero (no trade) — expressed as −pool_return in the
 *     `vs_cash` comparison, kept implicit in readings for criterion use.
 *
 * The observations are `cohortDates` — the dates the pool was *stored*, i.e.
 * historical decisions, not choices made with foresight in this run. Prices
 * are read through `asOf` only. The result is descriptive research: the block
 * bootstrap p-value is two-sided and null-centered, and neither it nor the
 * non-overlap sensitivity below proves independence or erases historical
 * selection bias (documented in `validation.ts:blockInference`).
 */
export function runPoolExcessDiagnostic(options: {
  db: DatabaseSync;
  asOf: string;
  researchWindow: SampleWindow;
  cohortDates?: readonly string[];
  horizon?: number;
  formationFraction?: number;
  success_criteria?: unknown;
  failure_criteria?: unknown;
}): PoolExcessRun {
  const horizon = options.horizon ?? 5;
  const asOf = options.asOf;
  const { db, researchWindow } = options;

  // Calendar covering the declared window, the horizon, AND several days past
  // research_window.end: the extra tail exists only so forward_start can be
  // resolved strictly after the holdout's last exit (see defineWindows — no
  // shared-day fallback). No cohort or measurement may use a date beyond
  // research_window.end; exits past the end are immature and skipped below.
  const windowEnd = researchWindow.end > asOf ? researchWindow.end : asOf;
  const days = (db.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date',
  ).all(researchWindow.start, windowEnd) as { cal_date: string }[]).map(r => r.cal_date);
  const tail = (db.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date > ? ORDER BY cal_date LIMIT 10',
  ).all(windowEnd) as { cal_date: string }[]).map(r => r.cal_date);
  days.push(...tail);
  if (!days.length) throw new Error('no trading calendar in research window');

  const observedDates = options.cohortDates
    ?? (db.prepare(
      'SELECT DISTINCT trade_date FROM watchlist WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date',
    ).all(researchWindow.start, researchWindow.end) as { trade_date: string }[])
      .map(r => r.trade_date);
  const cohortDates = observedDates.filter(d => d >= researchWindow.start && d <= researchWindow.end && d <= asOf);
  if (!cohortDates.length) {
    return emptyRun(options, horizon, 'no_stored_pool_in_window');
  }

  const window = defineWindows({
    researchStart: researchWindow.start,
    researchEnd: researchWindow.end,
    cohortDates,
    ...(options.formationFraction !== undefined ? { formationFraction: options.formationFraction } : {}),
    days,
  });

  // Price every matured cohort once: member returns from the stored pool and
  // the equal-weight priced-universe mean for the passive counterfactual.
  const membersOf = db.prepare('SELECT ts_code FROM watchlist WHERE trade_date=? ORDER BY ts_code');
  const returnsStmt = db.prepare(`
    SELECT a.ts_code,
           CASE WHEN a.open>0 AND b.close>0 AND aa.adj_factor>0 AND ab.adj_factor>0
                THEN b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 END AS r
    FROM daily a
    JOIN daily b ON b.ts_code=a.ts_code AND b.trade_date=?
    LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
    LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=b.trade_date
    WHERE a.trade_date=?`);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  // An exit is observable only if it lands on/before BOTH the declared window
  // end and the data snapshot date; the calendar tail past windowEnd exists
  // solely to resolve forward_start and must never mature a cohort.
  const maturityBound = researchWindow.end < asOf ? researchWindow.end : asOf;
  const cohorts: CohortRow[] = [];
  for (const date of cohortDates) {
    const i = dayIndex.get(date);
    if (i === undefined || i + horizon >= days.length) continue; // exit beyond calendar ⇒ immature
    const entryDate = days[i + 1];
    const exit = days[i + horizon]; // production / auditWatchlist convention: signal day t,
                                    // entry t+1 open, exit t+horizon close. Pricing from the
                                    // signal day's own open would trade the day's score before
                                    // it exists — a one-day lookahead this avoids.
    if (!entryDate || exit > maturityBound) continue; // beyond window/asOf ⇒ immature, never priced from the tail
    const members = (membersOf.all(date) as { ts_code: string }[]).map(r => r.ts_code);
    if (!members.length) continue;
    const rows = (returnsStmt.all(exit, entryDate) as { ts_code: string; r: number | null }[])
      .filter(row => finite(row.r));
    if (rows.length < 1000) continue; // benchmark needs a real universe (mirrors auditWatchlist)
    const byCode = new Map(rows.map(r => [r.ts_code, r.r as number]));
    const pool = members.map(c => byCode.get(c)).filter(finite);
    if (!pool.length) continue;
    const poolReturn = mean(pool) as number;
    const marketReturn = mean(rows.map(r => r.r as number)) as number;
    cohorts.push({
      date,
      entry_date: entryDate,
      exit_date: exit,
      pool_return: poolReturn,
      market_return: marketReturn,
      excess: poolReturn - marketReturn,
    });
  }
  if (cohorts.length < 20) {
    // blockInference's own floor; report honestly instead of printing p=null
    // next to a confident verdict.
    return emptyRun(options, horizon, `matured_cohorts_below_inference_floor(${cohorts.length}<20)`);
  }

  // Three-segment split via validation.ts, twice: formation/holdout boundary,
  // then holdout/forward boundary. Purged buckets keep straddling cohorts out
  // of both sides — an overlapping "out-of-sample" is not out-of-sample.
  const cohortSeries = cohorts.map(c => c.date);
  const s1 = splitDates(days, cohortSeries, window.formation_window.end, horizon, 0, 'RETROSPECTIVE_HOLDOUT');
  const s2 = splitDates(days, s1.validation, window.historical_holdout_window.end, horizon, 0, 'RETROSPECTIVE_HOLDOUT');
  const byDate = new Map(cohorts.map(c => [c.date, c]));
  const pick = (dates: string[]): CohortRow[] => dates.map(d => byDate.get(d)).filter((c): c is CohortRow => !!c);
  const formation = pick(s1.formation);
  const holdout = pick(s2.formation);

  const segment = (label: string, rows: CohortRow[]): ExcessSegment => {
    const excess = rows.map(r => r.excess as number);
    return {
      label,
      cohorts: rows.length,
      mean_pool_pct: pct(mean(rows.map(r => r.pool_return as number))),
      mean_market_pct: pct(mean(rows.map(r => r.market_return as number))),
      mean_excess_pct: pct(mean(excess)),
      win_rate: rows.length ? rows.filter(r => (r.excess as number) > 0).length / rows.length : null,
      inference: blockInference(excess, horizon, 1999, 1021),
    };
  };

  const formationSeg = segment('formation', formation);
  const holdoutSeg = segment('holdout', holdout);
  const wholeSeg = segment('whole_window', cohorts);

  const success = options.success_criteria ?? null;
  const failure = options.failure_criteria ?? null;
  const insufficient = holdoutSeg.cohorts < 1 || formationSeg.cohorts < 1;

  return {
    status: insufficient ? 'INSUFFICIENT_DATA' : 'RESEARCH_ONLY',
    version: VALIDATION_VERSION,
    runner_version: EXPERIMENT_RUNNER_VERSION,
    as_of: asOf,
    horizon,
    window,
    cohorts,
    segments: { formation: formationSeg, holdout: holdoutSeg, whole_window: wholeSeg },
    readings: [
      { id: 'formation', value: formationSeg.mean_excess_pct },
      { id: 'holdout', value: holdoutSeg.mean_excess_pct },
      { id: 'holdout_market_baseline', value: holdoutSeg.mean_market_pct },
      { id: 'holdout_cash_baseline', value: 0 },
      { id: 'whole_window', value: wholeSeg.mean_excess_pct },
    ],
    success_criteria: success,
    failure_criteria: failure,
    costs: RESEARCH_COSTS,
    runner_reports_are_not_order_authorization: RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION,
    limitations: [
      'Stored watchlist cohorts: retrospective holdout, never a claim of untouched out-of-sample data (validation.ts splitDates interpretation).',
      'Overlapping 5-day horizons are handled by circular moving-block bootstrap (block=5, reps=1999, seed=1021); nominal independent windows ≈ cohorts/5.',
      'Equal-weight priced-universe benchmark on priced subsets with explicit unresolved counts; references are gross endpoint observations, not investable portfolios.',
      'Costs follow RESEARCH_COSTS (3/8/5 bps) applied per event via evaluation.ts; they are research conventions, not broker statements.',
      'Descriptive research only: no result from this runner authorizes an order (RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION).',
    ],
  };
}

function emptyRun(
  options: { asOf: string; researchWindow: SampleWindow; success_criteria?: unknown; failure_criteria?: unknown },
  horizon: number,
  reason: string,
): PoolExcessRun {
  const blank = (label: string): ExcessSegment => ({
    label, cohorts: 0, mean_pool_pct: null, mean_market_pct: null, mean_excess_pct: null,
    win_rate: null,
    inference: blockInference([], horizon, 1999, 1021),
  });
  return {
    status: 'INSUFFICIENT_DATA',
    version: VALIDATION_VERSION,
    runner_version: EXPERIMENT_RUNNER_VERSION,
    as_of: options.asOf,
    horizon,
    window: {
      research_window: options.researchWindow,
      formation_window: { start: '', end: '' },
      historical_holdout_window: { start: '', end: '' },
      forward_start: '',
      rule: reason,
    },
    cohorts: [],
    segments: { formation: blank('formation'), holdout: blank('holdout'), whole_window: blank('whole_window') },
    readings: [
      { id: 'formation', value: null },
      { id: 'holdout', value: null },
      { id: 'holdout_market_baseline', value: null },
      { id: 'holdout_cash_baseline', value: 0 },
      { id: 'whole_window', value: null },
    ],
    success_criteria: options.success_criteria ?? null,
    failure_criteria: options.failure_criteria ?? null,
    costs: RESEARCH_COSTS,
    runner_reports_are_not_order_authorization: RUNNER_REPORTS_ARE_NOT_ORDER_AUTHORIZATION,
    limitations: [`Empty run: ${reason}`, 'Descriptive research only; no order authorization.'],
  };
}

// ---------------------------------------------------------------- funded cross-check

export interface FundedCrossCheck {
  status: string;
  net_return_pct: number | null;
  fees_cents: number;
  slippage_cents: number;
  turnover_notional_to_initial: number | null;
  maximum_drawdown_pct: number | null;
  order_count: number;
  skipped: Record<string, number>;
  failure: string | null;
}

/**
 * Sequential cash-funded replay of the same stored cohorts through
 * `validation.ts: simulateFunded` — the counterfactual-aware, fee-paid view of
 * the same experiment (cohort overlap is skipped there rather than measured as
 * independent samples, which is exactly why it complements the block
 * bootstrap). Read-only on the market cache; the research registry is the only
 * thing that persists anything, and only via the CLI's explicit recording.
 *
 * Requires `simulateFunded`'s fee function; callers pass a constant-bps quote
 * matching RESEARCH_COSTS so the fee basis is identical to `evaluateEvents`.
 */
export function crossCheckFunded(
  db: DatabaseSync,
  run: PoolExcessRun,
  options: { initialCents?: number; codeFilter?: RegExp } = {},
): FundedCrossCheck {
  const initialCents = options.initialCents ?? 7_600_000; // ≈7万元 account scale
  const selections = run.cohorts.map(c => ({ date: c.date, codes: [] as string[] }));
  // Re-resolve member codes from the run's own cohort rows? The run keeps
  // dates; membership must be re-read — pass dates only and let the caller
  // re-read memberships to avoid storing 3000 code strings in the run output.
  const membersOf = db.prepare('SELECT ts_code FROM watchlist WHERE trade_date=? ORDER BY ts_code');
  for (const sel of selections) sel.codes = (membersOf.all(sel.date) as { ts_code: string }[]).map(r => r.ts_code);
  const fee = ({ side, price_cents, quantity }: { side: 'BUY' | 'SELL'; price_cents: number; quantity: number }) => {
    const bps = side === 'BUY' ? RESEARCH_COSTS.buy_fee_bps : RESEARCH_COSTS.sell_fee_bps;
    const gross = price_cents * quantity;
    // Integer cents; matches the research convention's shape (per-order
    // rounding is part of the convention, documented in outputs).
    return { total_cents: Math.max(0, Math.round(gross * bps / 10000)), version: 'research-constbps-3/8' };
  };
  const result = simulateFunded(db, selections, {
    asOf: run.as_of,
    initial_cents: initialCents,
    horizon: run.horizon,
    max_exit_delay: RESEARCH_COSTS.max_exit_delay,
    slippage_bps: RESEARCH_COSTS.slippage_bps,
    fee,
  });
  return {
    status: result.status,
    net_return_pct: finite(result.net_return) ? Math.round((result.net_return as number) * 1e6) / 1e4 : null,
    fees_cents: result.fees_cents,
    slippage_cents: result.slippage_cents,
    turnover_notional_to_initial: finite(result.turnover_notional_to_initial)
      ? Math.round((result.turnover_notional_to_initial as number) * 1e4) / 1e4 : null,
    maximum_drawdown_pct: finite(result.maximum_drawdown)
      ? Math.round((result.maximum_drawdown as number) * 1e6) / 1e4 : null,
    order_count: result.order_count,
    skipped: result.skipped,
    failure: result.failure,
  };
}

// ---------------------------------------------------------------- exposure census

export interface ExposureCensus {
  as_of: string;
  pool_size: number;
  market_size: number;
  /** null when daily_basic rows are absent (fixture markets) — reported, not guessed. */
  pool: { pe_ttm_mean: number | null; pb_mean: number | null; turnover_rate_mean: number | null; total_mv_median: number | null };
  market: { pe_ttm_mean: number | null; pb_mean: number | null; turnover_rate_mean: number | null; total_mv_median: number | null };
  pool_industry_count: number;
  market_industry_count: number;
  pool_industry_hhi: number | null;
  market_industry_hhi: number | null;
}

/**
 * Industry & style exposure of the stored pool versus the market, at `asOf`.
 * Descriptive census only — no scoring, no ranking, no forecast: exposure is
 * an *attribution hypothesis input*, never a return prediction (goal-1026 §6.1
 * forbids treating heuristic rankings as return forecasts).
 */
export function poolExposureCensus(db: DatabaseSync, asOf: string): ExposureCensus {
  const members = (db.prepare('SELECT ts_code FROM watchlist WHERE trade_date=? ORDER BY ts_code')
    .all(asOf) as { ts_code: string }[]).map(r => r.ts_code);
  const market = (db.prepare('SELECT ts_code FROM daily_basic WHERE trade_date=? ORDER BY ts_code')
    .all(asOf) as { ts_code: string }[]).map(r => r.ts_code);
  const stats = (codes: string[]) => {
    if (!codes.length) return { pe: null, pb: null, tnr: null, mv: null, mvMedian: null };
    const placeholders = codes.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT AVG(pe_ttm) pe, AVG(pb) pb, AVG(turnover_rate) tnr, AVG(total_mv) mv
       FROM daily_basic WHERE trade_date=? AND ts_code IN (${placeholders})`,
    ).get(asOf, ...codes) as { pe: number | null; pb: number | null; tnr: number | null; mv: number | null };
    const medians = (db.prepare(
      `SELECT total_mv FROM daily_basic WHERE trade_date=? AND ts_code IN (${placeholders}) AND total_mv IS NOT NULL ORDER BY total_mv`,
    ).all(asOf, ...codes) as { total_mv: number }[]).map(r => r.total_mv);
    const mid = medians.length ? medians[Math.floor(medians.length / 2)] : null;
    return { pe: row.pe, pb: row.pb, tnr: row.tnr, mv: row.mv, mvMedian: mid };
  };
  const industries = (codes: string[], table: 'watchlist' | 'daily_basic'): { count: number; hhi: number | null } => {
    if (!codes.length) return { count: 0, hhi: null };
    const placeholders = codes.map(() => '?').join(',');
    const join = table === 'watchlist'
      ? `SELECT s.industry i, COUNT(*) c FROM watchlist w JOIN stock_basic s ON s.ts_code=w.ts_code
         WHERE w.trade_date=? AND w.ts_code IN (${placeholders}) GROUP BY s.industry`
      : `SELECT s.industry i, COUNT(*) c FROM daily_basic b JOIN stock_basic s ON s.ts_code=b.ts_code
         WHERE b.trade_date=? AND b.ts_code IN (${placeholders}) GROUP BY s.industry`;
    const rows = db.prepare(join).all(asOf, ...codes) as { i: string | null; c: number }[];
    const total = rows.reduce((s, r) => s + r.c, 0);
    const hhi = total ? rows.reduce((s, r) => s + (r.c / total) ** 2, 0) : null;
    return { count: rows.length, hhi };
  };
  const p = stats(members);
  const m = stats(market);
  const pi = industries(members, 'watchlist');
  const mi = industries(market, 'daily_basic');
  const round = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e4) / 1e4);
  return {
    as_of: asOf,
    pool_size: members.length,
    market_size: market.length,
    pool: { pe_ttm_mean: round(p.pe), pb_mean: round(p.pb), turnover_rate_mean: round(p.tnr), total_mv_median: round(p.mvMedian) },
    market: { pe_ttm_mean: round(m.pe), pb_mean: round(m.pb), turnover_rate_mean: round(m.tnr), total_mv_median: round(m.mvMedian) },
    pool_industry_count: pi.count,
    market_industry_count: mi.count,
    pool_industry_hhi: round(pi.hhi),
    market_industry_hhi: round(mi.hhi),
  };
}

// ---------------------------------------------------------------- candidate manifest

export interface CandidateBuildOptions {
  candidateId: string;
  candidateVersion: string;
  researchWindow: SampleWindow;
  researchDataSnapshotId: string;
  createdAt: string;
  diagnosisSummary: string;
  formationFraction?: number;
  /** Observed stored-pool dates inside the window — storage facts, not outcomes. */
  cohortDates: readonly string[];
  /** Trading calendar covering the window (for exit resolution). */
  days: readonly string[];
}

/**
 * The §6.1 diagnosis as a registrable §6.2 candidate.
 *
 * Hypothesis (pre-registered, falsifiable): the stored pool's 5-day excess is
 * driven by (a) a momentum-lag/风格 tilt and (b) industry configuration, and a
 * composition-neutral variant should shrink |excess| relative to the equal-
 * weight market *without* improving on cash when fees are paid. Success is
 * defined as *mechanism confirmation*, not as "backtest got better" — the task
 * forbids adjusting the score to make a backtest look good (§6.1), so this
 * candidate never touches the frozen scorer: `signal_definition` is explicitly
 * "diagnostic re-ranking for measurement only, excluded from production
 * signals".
 *
 * Windows come from `defineWindows` over the declared research window — fixed
 * by a rule, never by observed performance.
 */
export function buildPoolExcessCandidate(options: CandidateBuildOptions): CandidateManifest {
  const fraction = options.formationFraction ?? 0.6;
  // Windows need cohort dates; they are storage facts (which dates the pool
  // was stored on), never outcomes, so deriving windows from them is legal.
  if (!options.cohortDates.length || !options.days.length) {
    throw new Error('buildPoolExcessCandidate requires cohortDates and days (observed storage, not outcomes)');
  }
  const window = defineWindows({
    researchStart: options.researchWindow.start,
    researchEnd: options.researchWindow.end,
    cohortDates: options.cohortDates,
    formationFraction: fraction,
    days: options.days,
  });
  const manifest: CandidateManifest = {
    candidate_id: options.candidateId,
    candidate_version: options.candidateVersion,
    strategy_family: 'watchlist_pool_excess_diagnostic',
    economic_hypothesis: '股票池近 72 个 5 日窗口平均超额为负（−2.04%）。机制假设：（i）入场时点的相对动量为正且偏高（入选前 20 日相对市场动量均值 ≈ +8.5pp，98% 的观测期为正），而入场相对动量越高、其后 5 日超额越差（52 个同期 cohort 相关 −0.58，最高四分位 −3.35% vs 最低 −1.07%）——即追高后的短周期反转；（ii）行业集中度显著高于市场（HHI 0.0525 vs 0.0265，26 vs 111 个行业）。成分中性化对照应能缩小相对等权市场的超额偏离；费用后相对现金不应为正。注：该假设基于观测期（20260701–20261023）的描述性测量，重叠窗口非独立样本，不作因果结论。',
    universe_specification: {
      rule: 'stored production watchlist membership (40 names/date) versus the equal-weight priced listed universe (>=1000 priced rows)',
      exclusions: 'pricing requires open>0 and positive adjustment factors on both endpoints; unresolved members are excluded with explicit counts',
      point_in_time: 'membership is read from the stored watchlist table by date — never recomputed with current data',
    },
    signal_definition: {
      production_signal: 'score-1.0.0 frozen watchlist (this candidate does NOT modify it)',
      experiment_measurement: 'equal-weight holding of stored members over horizon 5, entry t+1 open, exit t+horizon close',
      leakage_controls: [
        'selection reads only rows stored at or before the cohort date',
        'all dated market queries bounded by asOf',
        'diagnostic re-ranking (control models) is measurement-only and excluded from production signals',
      ],
    },
    portfolio_construction: {
      weighting: 'equal weight across stored members',
      pool_size: 'as stored (40)',
      counterfactuals: ['equal_weight_market_hold', 'cash_no_trade'],
    },
    execution_policy: {
      entry: 't+1 open with open-up-limit/suspension exclusion',
      exit: 't+horizon close with close-down-limit/suspension deferral up to max_exit_delay',
      costs: RESEARCH_COSTS,
      cost_convention: 'same as validationCli research protocol (3/8/5 bps, delay 5)',
    },
    parameter_space: {
      search_budget: 0,
      note: '诊断实验无参数搜索：零次搜索预算，事后补写预算等于事后挑选参数',
      searched: [] as string[],
    },
    research_data_snapshot_id: options.researchDataSnapshotId,
    code_sha: registeredCodeSha(),
    cost_model_version: 'fees-research-constbps-3-8-slip5',
    benchmark_versions: {
      equal_weight_market: `evaluation-${VALIDATION_VERSION}:priced_universe_gross_endpoints`,
      cash: 'zero-return-no-trade',
    },
    research_window: window.research_window,
    formation_window: window.formation_window,
    historical_holdout_window: window.historical_holdout_window,
    forward_start: window.forward_start,
    evaluation_horizons: [5],
    rebalance_period: 'daily observation, 5-day holding horizon (cohort, non-overlapping exits enforced in funded replay)',
    risk_limits: {
      drawdown_monitor: 'report maximum drawdown of the funded replay; no automated de-risking rule',
      concentration: '40 names equal weight; industry HHI reported, not capped by this candidate',
      statement: '风险限制仅用于监测与报告；未经用户确认不设机械减仓阈值',
    },
    capital_and_capacity: {
      research_capital_cents: 7_600_000,
      note: '≈7 万元研究资金口径；40 只主板/中小票等权，容量由最小成交单位与流动性门槛决定，本实验不声称容量结论',
    },
    performance_reference: {
      primary: '费用后相对等权市场超额（formation 与 holdout 分段均值 + block bootstrap）',
      counterfactuals: ['passive equal-weight hold', 'cash (no trade)'],
      metrics: ['mean_excess_pct per segment', 'win_rate', 'maximum_drawdown (funded replay)', 'fees_paid'],
      not_a_claim: '启发式排名不是收益预测；本候选衡量机制，不承诺收益',
    },
    multiple_testing_family: 'candidate:watchlist_pool_excess_diagnostic (single family; no model shopping inside)',
    success_criteria: {
      type: 'threshold',
      reading: 'holdout',
      max: 0,
      semantics: 'holdout 段平均超额 ≤ 0 触发 SUPPORTS_HYPOTHESIS（负超额机制在留出段复现）——注意这是“机制确认”，不是“策略有效”',
    },
    failure_criteria: {
      type: 'threshold',
      reading: 'holdout',
      min: 0,
      semantics: '失败判据针对 failure_criteria 自身的成立与否：holdout 段平均超额 ≥ 0 → 失败判据成立（负超额未在留出段复现，机制假设失败）；holdout < 0 → 失败判据不成立（机制复现，仅此而已，不代表策略有效）',
    },
    promotion_criteria: {
      type: 'manual_review',
      requires: [
        'BACKTESTED→OOS_VALIDATED 携带 evidence（本实验结果哈希）',
        'OOS_VALIDATED→SHADOW 需要用户可见的评审记录；系统绝不自动晋级为下单策略',
      ],
    },
    elimination_criteria: {
      type: 'manual_review',
      triggers: ['holdout 段机制不复现（failure_criteria 判定）', '数据快照或代码版本变更必须新建 candidate_version'],
    },
    created_at: options.createdAt,
    mechanism_and_counter_evidence: options.diagnosisSummary,
  };
  return manifest;
}

/** Stable content hash of any research artifact, for evidence pointers. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}
