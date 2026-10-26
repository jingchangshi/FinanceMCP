import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_TRANSITIONS,
  ALL_STATES,
  CandidateRegistry,
  CandidateRegistryError,
  EVIDENCE_REQUIRED_TRANSITIONS,
  LIFECYCLE_STATES,
  STATE_ALIASES,
  TERMINAL_STATES,
  canonicalJson,
  evidenceHash,
  identityHash,
  outcomeFor,
  validateManifest,
} from '../build/ashare/candidateRegistry.js';
import {
  RESEARCH_COSTS,
  buildExperimentSpec,
  contentHash,
  crossCheckFunded,
  defineWindows,
  poolExposureCensus,
  registeredCodeSha,
  runPoolExcessDiagnostic,
} from '../build/ashare/candidateExperiments.js';
import { runCandidateCommand } from '../build/ashare/candidateCli.js';
import { openAshareDb } from '../build/ashare/db.js';
import { seedReferenceUniverse, weekdays } from './ashare-fixture.mjs';

/** §6.1/§6.2 acceptance for the candidate registry & experiment framework.
 *
 * The load-bearing properties, each asserted directly rather than through a
 * happy path:
 *  - the state machine's whitelist is exhaustive (a missing row would make an
 *    impossible-looking advance silently legal, an extra row would make a real
 *    path illegal);
 *  - terminal states have zero out-edges and promotions cannot occur without
 *    an evidence pointer, in the *legal-advance-first* order (a skipped step
 *    must never be reported as "missing evidence");
 *  - identity hashing covers identity fields only, and frozen content is
 *    immutable (same key + different content ⇒ refusal; same content ⇒ idempotent);
 *  - pre-registered criteria adjudicate read-only; unreadable criteria give
 *    INVALID_RUN and missing data gives INSUFFICIENT_DATA/BLOCKED_BY_DATA,
 *    never conflated;
 *  - the §6.1 experiment derives its windows by fixed rule, runs its block
 *    bootstrap through validation.ts only, and its registered code identity is
 *    the module's real source bytes;
 *  - no output of the runner is an order authorization.
 */

const dir = mkdtempSync(join(tmpdir(), 'candidate-registry-'));
const registryPath = join(dir, 'candidates.jsonl');

// 140 trading days: enough for ≥20 matured cohorts (blockInference's floor),
// small enough for the 1100-stock pricing join to finish inside test timeouts.
// The calendar carries 10 extra tail days past DAYS' end — production's
// trade_cal always extends beyond the research window, and defineWindows
// needs those days to place forward_start strictly after the holdout's last
// exit (it refuses a shared-day fallback). Watchlist pools exist only on
// DAYS; nothing matures on the tail.
const CALENDAR = weekdays('20250106', 150);
const DAYS = CALENDAR.slice(0, 140);

function makeManifest(overrides = {}) {
  const created = new Date('2026-10-26T00:00:00Z').toISOString();
  return {
    candidate_id: 'CAND-TEST-1',
    candidate_version: 'v1',
    strategy_family: 'watchlist_pool_excess_diagnostic',
    economic_hypothesis: 'test hypothesis',
    universe_specification: { rule: 'stored watchlist' },
    signal_definition: { production_signal: 'score-1.0.0' },
    portfolio_construction: { weighting: 'equal weight' },
    execution_policy: { costs: RESEARCH_COSTS },
    parameter_space: { search_budget: 0 },
    research_data_snapshot_id: 'snapshot@test',
    code_sha: 'a'.repeat(64),
    cost_model_version: 'fees-research-constbps-3-8-slip5',
    benchmark_versions: { market: 'equal-weight priced universe' },
    research_window: { start: '20250106', end: '20250718' },
    formation_window: { start: '20250106', end: '20250410' },
    historical_holdout_window: { start: '20250411', end: '20250718' },
    forward_start: '20250721',
    evaluation_horizons: [5],
    rebalance_period: 'daily observation, 5-day horizon',
    risk_limits: { statement: 'monitor only' },
    capital_and_capacity: { research_capital_cents: 7_600_000 },
    performance_reference: { primary: 'excess vs equal-weight market' },
    multiple_testing_family: 'candidate:CAND-TEST-1',
    success_criteria: { type: 'threshold', reading: 'holdout', max: 0 },
    failure_criteria: { type: 'threshold', reading: 'holdout', min: 0 },
    promotion_criteria: { type: 'manual_review' },
    elimination_criteria: { type: 'manual_review' },
    created_at: created,
    mechanism_and_counter_evidence: 'diagnosis summary',
    ...overrides,
  };
}

// ---------------------------------------------------------------- state machine

test('state machine: whitelist is exhaustive, terminals are sinks, aliases documented', () => {
  // Completeness: every known state has a row (a missing row would make legal
  // advances un-representable; the test below proves the reverse cannot pass).
  assert.equal(ALL_STATES.length,
    LIFECYCLE_STATES.length + TERMINAL_STATES.length + 1 /* REVALIDATED */);
  for (const state of ALL_STATES) {
    assert.ok(state in ALLOWED_TRANSITIONS, `missing transition row for ${state}`);
    for (const to of ALLOWED_TRANSITIONS[state]) {
      assert.ok(ALL_STATES.includes(to), `${state} → unknown ${to}`);
    }
  }
  // Permanent terminals are sinks: zero out-edges. This is the invariant that
  // makes "REJECTED forever" machine-checkable instead of a convention.
  // INSUFFICIENT_DATA is a SOFT terminal by design — when the sample matures
  // the candidate may re-register or re-backtest — so it is excluded here and
  // covered by the reopen assertions below.
  const softTerminals = ['INSUFFICIENT_DATA'];
  for (const state of TERMINAL_STATES) {
    if (softTerminals.includes(state)) continue;
    assert.deepEqual([...ALLOWED_TRANSITIONS[state]], [], `${state} must have no out-edges`);
  }
  assert.ok(ALLOWED_TRANSITIONS.INSUFFICIENT_DATA.length > 0,
    'INSUFFICIENT_DATA stays reopenable: absence of data is temporary, rejection is not');
  // Exactly the reopenable non-lifecycle states can re-enter the lifecycle.
  const reentry = ALL_STATES.filter(s =>
    !LIFECYCLE_STATES.includes(s) && ALLOWED_TRANSITIONS[s].some(t => LIFECYCLE_STATES.includes(t)));
  assert.deepEqual([...reentry], ['INSUFFICIENT_DATA', 'REVALIDATED']);
  // Evidence is mandatory on every promotion except registration itself.
  for (const state of LIFECYCLE_STATES) {
    if (state === 'PROPOSED' || state === 'REGISTERED') {
      assert.ok(!EVIDENCE_REQUIRED_TRANSITIONS.has(state));
    } else {
      assert.ok(EVIDENCE_REQUIRED_TRANSITIONS.has(state), `${state} must require evidence`);
    }
  }
  // Documented mapping to the TactiCore naming (reporting contract).
  assert.equal(STATE_ALIASES.BACKTESTED, 'HISTORICAL_TESTED');
  assert.equal(STATE_ALIASES.VERIFIED, 'RECOMMENDED_FOR_APPROVAL');
});

test('registry: register → legal advance chain with evidence; illegal & unevidenced advances refused in order', async (t) => {
  const path = join(dir, `chain-${t.id}.jsonl`);
  const reg = new CandidateRegistry(path);
  const manifest = makeManifest();
  const first = reg.register(manifest);
  assert.equal(first.created, true);
  assert.equal(reg.state('CAND-TEST-1', 'v1'), 'PROPOSED');
  // Idempotent re-registration of the same content.
  const again = reg.register(manifest);
  assert.equal(again.created, false);
  assert.equal(again.identity_hash, first.identity_hash);
  // Same key, mutated content → refusal (frozen identity).
  const mutated = makeManifest({ success_criteria: { type: 'threshold', reading: 'holdout', max: 0.5 } });
  assert.throws(() => reg.register(mutated), CandidateRegistryError);
  // In-process visibility (no restart required).
  assert.equal(reg.state('CAND-TEST-1', 'v1'), 'PROPOSED');

  const ev = evidenceHash({ run: 'fixture-run' });
  // Legal chain PROPOSED → REGISTERED → BACKTESTED → OOS_VALIDATED → SHADOW → VERIFIED.
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'REGISTERED', '登记完成'), 'REGISTERED');
  // BACKTESTED without evidence: refused *as evidence*, because legality was OK.
  assert.throws(() => reg.advance('CAND-TEST-1', 'v1', 'BACKTESTED', 'done'), /必须附带 evidence/);
  // A skipped step (REGISTERED → OOS_VALIDATED) must be refused as ILLEGAL,
  // not reported as missing evidence — reversed order would imply that
  // supplying a hash enables the jump.
  assert.throws(() => reg.advance('CAND-TEST-1', 'v1', 'OOS_VALIDATED', 'skip', ev), /不是合法推进/);
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'BACKTESTED', 'run complete', ev), 'BACKTESTED');
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'OOS_VALIDATED', 'holdout ok', ev), 'OOS_VALIDATED');
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'SHADOW', 'enter shadow', ev), 'SHADOW');
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'VERIFIED', 'recommended', ev), 'VERIFIED');
  // VERIFIED → RECOMMENDED_FOR_APPROVAL is NOT a legal state (mapping documents
  // the equivalence); the machine's own terminal advance is RETIRED only.
  assert.throws(() => reg.advance('CAND-TEST-1', 'v1', 'SHADOW', 'back to shadow', ev), /不是合法推进/);
  // Terminal is a sink.
  assert.equal(reg.advance('CAND-TEST-1', 'v1', 'RETIRED', 'archived'), 'RETIRED');
  assert.throws(() => reg.advance('CAND-TEST-1', 'v1', 'PROPOSED', 'reopen'), /不是合法推进/);
  // reason is mandatory.
  assert.throws(() => reg.advance('CAND-TEST-1', 'v1', 'RETIRED', '  '), /reason/);
  // History is append-only and complete.
  const history = reg.history('CAND-TEST-1', 'v1');
  assert.equal(history.length, 7); // PROPOSED + 6 transitions
  assert.deepEqual(history.map(h => h.to_state),
    ['PROPOSED', 'REGISTERED', 'BACKTESTED', 'OOS_VALIDATED', 'SHADOW', 'VERIFIED', 'RETIRED']);
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 8); // 1 candidate + 7 transitions, nothing rewritten
  assert.equal(lines.filter(l => l.kind === 'candidate').length, 1);
});

test('registry: reopen via REVALIDATED must re-pass OOS_VALIDATED (no shortcut to shadow)', () => {
  const path = join(dir, 'reopen.jsonl');
  const reg = new CandidateRegistry(path);
  reg.register(makeManifest({ candidate_id: 'CAND-REOPEN' }));
  const ev = evidenceHash({ x: 1 });
  reg.advance('CAND-REOPEN', 'v1', 'REGISTERED', 'reg');
  reg.advance('CAND-REOPEN', 'v1', 'BACKTESTED', 'bt', ev);
  reg.advance('CAND-REOPEN', 'v1', 'OOS_VALIDATED', 'oos', ev);
  reg.advance('CAND-REOPEN', 'v1', 'SHADOW', 'shadow', ev);
  // Foundation broke: reopen. SHADOW → REVALIDATED is legal; REVALIDATED →
  // SHADOW is NOT — the candidate must re-verify execution before shadowing again.
  reg.advance('CAND-REOPEN', 'v1', 'REVALIDATED', 'foundation invalid');
  assert.throws(() => reg.advance('CAND-REOPEN', 'v1', 'SHADOW', 'shortcut'), /不是合法推进/);
  assert.equal(reg.advance('CAND-REOPEN', 'v1', 'OOS_VALIDATED', 're-verify', ev), 'OOS_VALIDATED');
});

test('registry: verifyIdentity detects post-freeze edits; path safety refuses database/cache paths', () => {
  const path = join(dir, 'verify.jsonl');
  const reg = new CandidateRegistry(path);
  const manifest = makeManifest({ candidate_id: 'CAND-VERIFY' });
  reg.register(manifest);
  const ok = reg.verifyIdentity(manifest);
  assert.match(ok, /^[a-f0-9]{64}$/);
  const edited = makeManifest({ candidate_id: 'CAND-VERIFY', code_sha: 'b'.repeat(64) });
  assert.throws(() => reg.verifyIdentity(edited), /身份哈希不符/);
  // Path guards: no database files, no live cache alias, no foreign file type.
  assert.throws(() => new CandidateRegistry(join(dir, 'ashare.sqlite')), /数据库文件|行情缓存/);
  const foreign = join(dir, 'not-jsonl.txt');
  writeFileSync(foreign, 'not jsonl at all\n');
  assert.throws(() => new CandidateRegistry(foreign), /不是 JSONL/);
  // A fresh JSONL path is fine.
  assert.ok(new CandidateRegistry(join(dir, 'fresh.jsonl')) instanceof CandidateRegistry);
});

test('identity hash: covers identity fields only; metadata/timestamp changes do not move it', () => {
  const a = makeManifest();
  const b = makeManifest({ created_at: new Date('2026-10-27T00:00:00Z').toISOString(), mechanism_and_counter_evidence: 'edited narrative' });
  assert.equal(identityHash(a), identityHash(b), 'metadata must not be identity');
  const c = makeManifest({ code_sha: 'c'.repeat(64) });
  assert.notEqual(identityHash(a), identityHash(c), 'code_sha must be identity');
  const d = makeManifest({ historical_holdout_window: { start: '20250412', end: '20250718' } });
  assert.notEqual(identityHash(a), identityHash(d), 'holdout window must be identity');
  // canonicalJson: key order and whitespace are irrelevant, content is all.
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(evidenceHash({ k: 'v' }), contentHash({ k: 'v' }));
});

test('validateManifest: three-segment exclusion, forward strictly after holdout, pre-registered budget', () => {
  // Overlapping formation/holdout refused.
  assert.throws(() => validateManifest(makeManifest({
    formation_window: { start: '20250106', end: '20250501' },
    historical_holdout_window: { start: '20250411', end: '20250718' },
  })), /三段互斥|早于/);
  // forward_start == holdout end refused (must be strictly later).
  assert.throws(() => validateManifest(makeManifest({ forward_start: '20250718' })), /必须晚于/);
  // search_budget missing or negative refused (pre-registration discipline).
  assert.throws(() => validateManifest(makeManifest({ parameter_space: {} })), /search_budget/);
  assert.throws(() => validateManifest(makeManifest({ parameter_space: { search_budget: -1 } })), /search_budget/);
  // Free-form criteria (no type) refused: unreadable gates are the defect class.
  assert.throws(() => validateManifest(makeManifest({ success_criteria: 'make it good' })), /结构化规则/);
  // code_sha must be a real sha256 hex.
  assert.throws(() => validateManifest(makeManifest({ code_sha: 'nothex' })), /code_sha/);
});

// ---------------------------------------------------------------- outcome adjudication

test('outcomeFor: read-only adjudication, INVALID_RUN ≠ BLOCKED_BY_DATA ≠ INSUFFICIENT_DATA', () => {
  const success = { type: 'threshold', reading: 'holdout', max: 0 };
  // Negative holdout ⇒ pre-registered success rule met (mechanism replicated).
  assert.equal(outcomeFor(success, [{ id: 'holdout', value: -1.5 }]), 'SUPPORTS_HYPOTHESIS');
  // Positive holdout ⇒ not met. The runner cannot flip this by re-reading.
  assert.equal(outcomeFor(success, [{ id: 'holdout', value: 0.4 }]), 'DOES_NOT_SUPPORT_HYPOTHESIS');
  // Unknown criterion type ⇒ INVALID_RUN, never a guessed pass/fail.
  assert.equal(outcomeFor({ type: 'make_it_look_good' }, [{ id: 'holdout', value: -9 }]), 'INVALID_RUN');
  assert.equal(outcomeFor(null, [{ id: 'holdout', value: -9 }]), 'INVALID_RUN');
  // No readings at all ⇒ INSUFFICIENT_DATA (missing world, not a verdict).
  assert.equal(outcomeFor(success, []), 'INSUFFICIENT_DATA');
  assert.equal(outcomeFor(success, [{ id: 'holdout', value: null }]), 'INSUFFICIENT_DATA');
  // Majority missing ⇒ BLOCKED_BY_DATA: half the window never matured.
  assert.equal(outcomeFor(success, [
    { id: 'holdout:0', value: -1 }, { id: 'holdout:1', value: null },
    { id: 'holdout:2', value: null }, { id: 'holdout:3', value: null },
  ]), 'BLOCKED_BY_DATA');
  // Win-rate rule.
  const wr = { type: 'win_rate', reading: 'cohort', min: 0.5 };
  assert.equal(outcomeFor(wr, [{ id: 'cohort:1', value: 1 }, { id: 'cohort:2', value: -1 }]), 'SUPPORTS_HYPOTHESIS');
  assert.equal(outcomeFor(wr, [{ id: 'cohort:1', value: -1 }, { id: 'cohort:2', value: -1 }]), 'DOES_NOT_SUPPORT_HYPOTHESIS');
  // Pairwise comparison rule (counterfactual equivalence).
  const cmp = { type: 'compare', a: 'arm_a', b: 'arm_b', max_abs_diff: 0.1 };
  assert.equal(outcomeFor(cmp, [
    { id: 'arm_a:1', value: 1 }, { id: 'arm_b:1', value: 1.05 },
    { id: 'arm_a:2', value: 2 }, { id: 'arm_b:2', value: 1.98 },
  ]), 'NO_SIGNIFICANT_DIFFERENCE');
  assert.equal(outcomeFor(cmp, [
    { id: 'arm_a:1', value: 1 }, { id: 'arm_b:1', value: 5 },
  ]), 'DOES_NOT_SUPPORT_HYPOTHESIS');
  // No matching readings ⇒ data blocked, not a verdict.
  assert.equal(outcomeFor(cmp, [{ id: 'other', value: 1 }]), 'BLOCKED_BY_DATA');
});

// ---------------------------------------------------------------- windows & code identity

test('defineWindows: rule-derived, formation strictly before holdout, forward after last exit', () => {
  const days = DAYS;
  const cohortDates = days.slice(0, 100);
  const w = defineWindows({
    researchStart: days[0], researchEnd: days.at(-1), cohortDates, days,
  });
  assert.ok(w.formation_window.end < w.historical_holdout_window.start,
    'formation must end before holdout starts');
  assert.ok(w.forward_start > w.historical_holdout_window.end,
    'forward_start must be strictly after holdout end');
  // Deterministic: same inputs ⇒ same windows (rule, not outcome, chooses).
  const again = defineWindows({
    researchStart: days[0], researchEnd: days.at(-1), cohortDates, days,
  });
  assert.deepEqual(w, again);
  // Holdout's last cohort must mature inside the research window: signal day
  // t, entry t+1 open, exit t+horizon close (production convention), so the
  // exit index = last + horizon.
  const lastIdx = days.indexOf(w.historical_holdout_window.end);
  assert.ok(lastIdx + 5 < days.length);
  assert.ok(days[lastIdx + 5] <= w.research_window.end);
  // forward_start is an actual trading day strictly after the holdout exit.
  const holdoutExit = days[lastIdx + 5];
  assert.ok(days.includes(w.forward_start));
  assert.ok(w.forward_start > holdoutExit);
});

test('registeredCodeSha: identity over the module’s real bytes, and spec hash couples to it', () => {
  const sha = registeredCodeSha();
  assert.match(sha, /^[a-f0-9]{64}$/);
  // The registered identity must equal the byte hash of the built module.
  const bytes = readFileSync(new URL('../build/ashare/candidateExperiments.js', import.meta.url));
  assert.equal(sha, createHash('sha256').update(bytes).digest('hex'));
  // Changing any identity field (code_sha, costs, windows, criteria) must
  // change the spec hash: post-hoc tuning cannot reuse a registered spec.
  const m1 = makeManifest();
  const s1 = buildExperimentSpec(m1);
  assert.equal(s1, buildExperimentSpec(makeManifest()), 'spec hash is deterministic');
  assert.notEqual(s1, buildExperimentSpec(makeManifest({ code_sha: 'd'.repeat(64) })));
  assert.notEqual(s1, buildExperimentSpec(makeManifest({ cost_model_version: 'other' })));
  assert.notEqual(s1, buildExperimentSpec(makeManifest({ historical_holdout_window: { start: '20250420', end: '20250718' } })));
  assert.notEqual(s1, buildExperimentSpec(makeManifest({ success_criteria: { type: 'threshold', reading: 'holdout', max: -0.5 } })));
  // An unregistrable manifest cannot be hashed into a spec at all.
  assert.throws(() => buildExperimentSpec(makeManifest({ parameter_space: {} })), CandidateRegistryError);
});

// ---------------------------------------------------------------- §6.1 experiment on fixture

function fixtureDb() {
  const db = openAshareDb(':memory:');
  const universe = seedReferenceUniverse(db, CALENDAR);
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  // Store a pool on EVERY trading day, exactly as production accumulates
  // them: stored decisions, never recomputed with foresight. Maturity is an
  // evaluation concern (cohorts whose 5-day exit lands beyond the window are
  // skipped downstream), not a storage condition — omitting the tail here
  // made as-of-the-last-day lookups (exposure census) empty.
  const codes = universe.slice(0, 40).map(s => s.ts_code);
  for (const day of DAYS) for (const code of codes) insert.run(day, code, 'new', 'synthetic', day);
  return { db, codes };
}

test('runPoolExcessDiagnostic: rule-based split, validation.ts inference only, research-only output', (t) => {
  const { db } = fixtureDb();
  t.after(() => db.close());
  const run = runPoolExcessDiagnostic({
    db,
    asOf: DAYS.at(-1),
    researchWindow: { start: DAYS[0], end: DAYS.at(-1) },
    success_criteria: { type: 'threshold', reading: 'holdout', max: 0 },
    failure_criteria: { type: 'threshold', reading: 'holdout', min: 0 },
  });
  assert.equal(run.status, 'RESEARCH_ONLY');
  assert.ok(run.cohorts.length >= 20, `need matured cohorts, got ${run.cohorts.length}`);
  // Segment separation: formation and holdout are disjoint in date space.
  const fDates = new Set(run.cohorts.filter(c => c.date <= run.window.formation_window.end).map(c => c.date));
  const hDates = new Set(run.cohorts.filter(c => c.date >= run.window.historical_holdout_window.start).map(c => c.date));
  for (const d of fDates) assert.ok(!hDates.has(d), `date ${d} in both segments`);
  // Inference is the single-source block bootstrap: block=5, reps=1999, seed=1021.
  for (const seg of Object.values(run.segments)) {
    assert.equal(seg.inference.method, 'circular_moving_block_bootstrap');
    assert.equal(seg.inference.block_length, 5);
    assert.equal(seg.inference.repetitions, 1999);
    assert.equal(seg.inference.seed, 1021);
  }
  // Reads pass through the registered criteria; the runner never rewrites them.
  assert.deepEqual(run.success_criteria, { type: 'threshold', reading: 'holdout', max: 0 });
  assert.ok(run.readings.some(r => r.id === 'holdout'));
  // Counterfactuals exist: market baseline is measured, cash baseline is 0.
  const ids = run.readings.map(r => r.id);
  assert.ok(ids.includes('holdout_market_baseline'));
  assert.ok(ids.includes('holdout_cash_baseline'));
  // Anti-promotion assertion is machine-visible in the artifact itself.
  assert.equal(run.runner_reports_are_not_order_authorization, true);
  assert.match(run.limitations.join(' '), /no result from this runner authorizes an order/);
  // Cost convention is explicit and matches validationCli's frozen protocol.
  assert.deepEqual(run.costs, { buy_fee_bps: 3, sell_fee_bps: 8, slippage_bps: 5, max_exit_delay: 5 });
  // No matured exit leaks beyond the declared window.
  for (const c of run.cohorts) assert.ok(c.exit_date <= run.window.research_window.end);
});

test('runPoolExcessDiagnostic: insufficient window reports INSUFFICIENT_DATA with null readings (no fake p)', (t) => {
  const { db } = fixtureDb();
  t.after(() => db.close());
  const run = runPoolExcessDiagnostic({
    db,
    asOf: DAYS[10],
    researchWindow: { start: DAYS[0], end: DAYS[10] },
  });
  assert.equal(run.status, 'INSUFFICIENT_DATA');
  assert.equal(run.segments.whole_window.inference.p_value, null);
  assert.equal(run.segments.whole_window.inference.status, 'DATA_INSUFFICIENT');
  assert.ok(run.readings.every(r => r.value === null || r.id.endsWith('baseline')));
  // Adjudicating this run cannot fabricate a verdict.
  assert.equal(outcomeFor({ type: 'threshold', reading: 'holdout', max: 0 }, run.readings), 'INSUFFICIENT_DATA');
});

test('poolExposureCensus: descriptive census with explicit structure, no scoring', (t) => {
  const { db } = fixtureDb();
  t.after(() => db.close());
  const census = poolExposureCensus(db, DAYS.at(-1));
  assert.equal(census.pool_size, 40);
  assert.ok(census.market_size > 1000);
  assert.equal(census.pool_industry_count > 0, true);
  // HHI in [1/N, 1] sanity for both sides.
  assert.ok(census.pool_industry_hhi > 0 && census.pool_industry_hhi <= 1);
  assert.ok(census.market_industry_hhi > 0 && census.market_industry_hhi <= 1);
});

test('crossCheckFunded: fee-paid counterfactual replay runs read-only and reports honestly', (t) => {
  const { db } = fixtureDb();
  t.after(() => db.close());
  const run = runPoolExcessDiagnostic({
    db,
    asOf: DAYS.at(-1),
    researchWindow: { start: DAYS[0], end: DAYS.at(-1) },
  });
  const funded = crossCheckFunded(db, run, { initialCents: 7_600_000 });
  // Whatever the market did, the artifact must be structurally honest:
  // a completed or explicitly-failed status, never a silently zeroed NAV.
  assert.ok(['COMPLETED', 'DATA_INSUFFICIENT', 'OPEN_POSITIONS_AT_CUTOFF'].includes(funded.status), funded.status);
  if (funded.status === 'COMPLETED') {
    assert.equal(funded.failure, null);
    assert.ok(funded.net_return_pct !== null && Number.isFinite(funded.net_return_pct));
    assert.ok(funded.order_count > 0);
  } else {
    assert.ok(typeof funded.failure === 'string' && funded.failure.length > 0,
      'a non-completed run must state its failure reason');
  }
  // Fees are charged (positive) whenever any order executed.
  if (funded.order_count > 0) assert.ok(funded.fees_cents > 0);
});

// ---------------------------------------------------------------- CLI end-to-end

test('CLI: diagnose → register → run → show, with production source read-only and no order authorization', async () => {
  // File-backed fixture (the CLI opens --source with readOnly:true, which
  // cannot see an in-memory DB).
  const sourcePath = join(dir, 'cache.sqlite');
  const fileDb = openAshareDb(sourcePath);
  const universe = seedReferenceUniverse(fileDb, CALENDAR);
  const insert = fileDb.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  // Every trading day, matching production storage (see fixtureDb above).
  for (const day of DAYS) {
    for (const s of universe.slice(0, 40)) insert.run(day, s.ts_code, 'new', 'synthetic', day);
  }
  fileDb.close();

  const regPath = join(dir, 'cli-registry.jsonl');
  const asOf = DAYS.at(-1);

  // 1) diagnose — writes only under --output, source untouched.
  const before = readFileSync(sourcePath);
  const diag = await runCandidateCommand([
    'diagnose', '--source', sourcePath, '--as-of', asOf, '--output', join(dir, 'diag'),
  ]);
  assert.equal(diag.status, 'RESEARCH_ONLY');
  assert.ok(existsSync(diag.json_path));
  assert.deepEqual(readFileSync(sourcePath), before, 'diagnose must not modify the source cache');

  // 2) register the derived §6.1 candidate.
  const reg = await runCandidateCommand([
    'register', '--registry', regPath, '--source', sourcePath, '--as-of', asOf,
    '--derive-sample-excess', '--id', 'CAND-POOL-EXCESS', '--version', 'v1',
    '--research-start', DAYS[0], '--research-end', asOf,
  ]);
  assert.equal(reg.status, 'REGISTERED');
  assert.equal(reg.state, 'PROPOSED');
  assert.match(reg.identity_hash, /^[a-f0-9]{64}$/);
  assert.equal(reg.promotion_is_order_authorization, false);

  // 3) run the experiment: adjudicates pre-registered criteria read-only.
  const result = await runCandidateCommand([
    'run', '--registry', regPath, '--id', 'CAND-POOL-EXCESS', '--version', 'v1',
    '--source', sourcePath, '--as-of', asOf, '--output', join(dir, 'runs'),
  ]);
  assert.equal(result.status, 'RESEARCH_ONLY');
  assert.match(result.spec_hash, /^[a-f0-9]{64}$/);
  assert.ok(['SUPPORTS_HYPOTHESIS', 'DOES_NOT_SUPPORT_HYPOTHESIS', 'INSUFFICIENT_DATA', 'BLOCKED_BY_DATA', 'NO_SIGNIFICANT_DIFFERENCE', 'INVALID_RUN'].includes(result.outcome));
  assert.equal(result.runner_reports_are_not_order_authorization, true);
  assert.equal(result.promotion_is_order_authorization, false);
  assert.ok(existsSync(result.json_path));

  // 4) show: the registry's derived view includes the recorded result.
  const view = await runCandidateCommand(['show', '--registry', regPath, '--id', 'CAND-POOL-EXCESS', '--version', 'v1']);
  assert.equal(view.candidate.state, 'PROPOSED'); // running does NOT advance state
  assert.equal(view.candidate.results.length, 1);
  assert.equal(view.candidate.results[0].outcome, result.outcome);
  assert.equal(view.candidate.results[0].spec_hash, result.spec_hash);

  // 5) The registry file itself is append-only JSONL, readable line by line.
  const lines = readFileSync(regPath, 'utf8').trim().split('\n');
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(lines.some(l => JSON.parse(l).kind === 'candidate'));
  assert.ok(lines.some(l => JSON.parse(l).kind === 'result'));

  // 6) A tampered spec_hash (post-hoc tuning) is refused by recordResult.
  const registry = new CandidateRegistry(regPath);
  assert.throws(() => registry.recordResult({
    candidate_id: 'CAND-POOL-EXCESS', candidate_version: 'v1',
    spec_hash: 'f'.repeat(64), outcome: 'SUPPORTS_HYPOTHESIS',
    reason: 'post-hoc', evidence: evidenceHash({ x: 1 }), run_id: 'RUN-x', as_of: asOf,
  }), /spec_hash 与登记候选不符/);
});

test('CLI: unknown subcommand throws usage, and importing the module never parses argv', async () => {
  await assert.rejects(() => runCandidateCommand(['bogus']), /未知子命令/);
  // The import at the top of this file already succeeded without argv side
  // effects — asserting the module's usage constant exists documents the
  // contract that made that safe.
  const { CANDIDATE_USAGE } = await import('../build/ashare/candidateCli.js');
  assert.match(CANDIDATE_USAGE, /Research only/);
});
