/** `candidate` — the §6.2 candidate experiment CLI (goal-1026).
 *
 * A standalone entry, deliberately NOT wired into `cli.ts`: nothing in the
 * production daily pipeline may accidentally acquire a path that promotes a
 * candidate. The intended usages:
 *
 *   node build/ashare/cli.js candidate <subcommand> ...    # (if a future owner wires it)
 *   node --input-type=module -e "import('./build/ashare/candidateCli.js').then(m => m.main())" candidate ...
 *   imported by tests: `runCandidateCommand(argv, env)`
 *
 * Subcommands:
 *   diagnose  --source PATH --as-of YYYYMMDD [--horizon 5] [--observation-dates 72] [--output DIR]
 *             §6.1 one-shot: runs researchDiagnosis (existing) + sample excess
 *             stats, writes JSON/MD. READ-ONLY on --source.
 *   register  --registry PATH --manifest JSON|@file --source PATH --as-of YYYYMMDD [--research-start D] [--research-end D]
 *             Builds the sample-excess candidate manifest (windows derived by
 *             fixed rule from observed storage), validates it, appends it to
 *             the JSONL registry, and records the evidence pointer.
 *   run       --registry PATH --id ID --version V --source PATH --as-of YYYYMMDD [--output DIR] [--funded]
 *             Executes the registered experiment read-only, adjudicates the
 *             pre-registered criteria via `outcomeFor`, appends the result
 *             record. NEVER writes production data.
 *   show      --registry PATH [--id ID --version V]
 *             Derived view: state, transitions, recorded results.
 *   list      --registry PATH
 *
 * Exit codes: 0 ok, 2 usage/contract error, 1 unexpected failure.
 * stdout: one JSON document. stderr: human progress (config.ts's token-source
 * logs also land on stderr via cli.ts's console override — keep that pattern).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CandidateRegistry,
  CandidateRegistryError,
  evidenceHash,
  outcomeFor,
} from './candidateRegistry.js';
import {
  buildExperimentSpec,
  buildPoolExcessCandidate,
  crossCheckFunded,
  poolExposureCensus,
  registeredCodeSha,
  runPoolExcessDiagnostic,
} from './candidateExperiments.js';
import { auditWatchlist, blockInference } from './validation.js';
import { diagnoseWatchlist, renderDiagnosisMarkdown } from './researchDiagnosis.js';

export const CANDIDATE_USAGE = [
  'candidate <subcommand> ...',
  '',
  '  diagnose  --source PATH --as-of YYYYMMDD [--horizon 5] [--observation-dates 72] [--output DIR]',
  '  register  --registry PATH --manifest JSON|@file --source PATH --as-of YYYYMMDD',
  '            [--research-start YYYYMMDD] [--research-end YYYYMMDD]',
  '  run       --registry PATH --id ID --version V --source PATH --as-of YYYYMMDD [--output DIR] [--funded]',
  '  show      --registry PATH [--id ID --version V]',
  '  list      --registry PATH',
  '',
  'Research only. The registry is append-only JSONL; --source (market cache) is opened READ-ONLY;',
  'no subcommand writes production data, and no result authorizes an order.',
].join('\n');

export interface CliIo {
  arg: (name: string, fallback?: string) => string | undefined;
  flag: (name: string) => boolean;
  ymd: (value: string | undefined, label: string) => string;
  print: (value: unknown) => void;
}

const hex64 = /^[a-f0-9]{64}$/;

/** Open the market cache strictly read-only. The query_only pragma plus a
 * BEGIN keeps accidental writes impossible even if a future edit introduces a
 * stray statement — read-only *intent* must be enforced by the *command*. */
function openReadOnly(source: string): DatabaseSync {
  const db = new DatabaseSync(resolve(source), { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=15000; BEGIN;');
  return db;
}

function readManifestArg(raw: string): unknown {
  const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
  try { return JSON.parse(text); } catch (e) { throw new Error(`manifest 不是合法 JSON: ${(e as Error).message}`); }
}

function tradingDays(db: DatabaseSync, start: string, end: string): string[] {
  return (db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date')
    .all(start, end) as { cal_date: string }[]).map(r => r.cal_date);
}

/** §6.1 diagnose: existing diagnosis engine + the sample-excess numbers the
 * report documents. Pure read; writes only under --output. */
async function cmdDiagnose(io: CliIo): Promise<Record<string, unknown>> {
  const source = resolve(io.arg('source') ?? (() => { throw new Error('--source required'); })());
  const asOf = io.ymd(io.arg('as-of'), '--as-of');
  const horizon = Number(io.arg('horizon', '5'));
  const observationDates = Number(io.arg('observation-dates', '72'));
  const output = resolve(io.arg('output', 'data/ashare/candidate-diagnosis')!);
  const db = openReadOnly(source);
  try {
    const report = diagnoseWatchlist(db, { asOf, horizon, observationDates });
    const audit = auditWatchlist(db, asOf, observationDates, horizon);
    const inference = audit.inference;
    const nonOverlapping = audit.non_overlapping;
    const doc = {
      status: 'RESEARCH_ONLY',
      as_of: asOf,
      horizon,
      observation_dates: observationDates,
      sample_excess: {
        dates: audit.cohorts.length,
        mean_excess_pct: audit.mean_excess_pct,
        win_rate: audit.win_rate,
        inference: {
          // Single statistics source: validation.ts blockInference (circular
          // moving-block bootstrap, block=horizon, reps=1999, seed=1021).
          method: inference.method,
          block_length: inference.block_length,
          repetitions: inference.repetitions,
          seed: inference.seed,
          ci95_pct: inference.ci95 ? inference.ci95.map(v => Math.round(v * 1e6) / 1e4) : null,
          p_value: inference.p_value,
          status: inference.status,
          nominal_independent_blocks: inference.nominal_blocks,
        },
        non_overlapping_sensitivity: nonOverlapping.map(n => ({
          offset: n.offset, cohorts: n.n, status: n.status, p_value: n.p_value,
          mean_pct: n.mean === null ? null : Math.round(n.mean * 1e6) / 1e4,
        })),
        note: '重叠窗口不能当独立样本：名义独立窗口 ≈ cohorts/horizon；non_overlapping 分段均给 DATA_INSUFFICIENT 是正确行为',
      },
      diagnosis: report,
      exposure_census: poolExposureCensus(db, asOf),
      runner_reports_are_not_order_authorization: true,
    };
    mkdirSync(output, { recursive: true });
    const jsonPath = join(output, `diagnosis-${asOf}.json`);
    const mdPath = join(output, `diagnosis-${asOf}.md`);
    if (jsonPath === source || mdPath === source) throw new Error('Output aliases source');
    writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
    writeFileSync(mdPath, renderDiagnosisMarkdown(report));
    return {
      status: 'RESEARCH_ONLY', as_of: asOf, verdict: report.verdict,
      mean_excess_pct: audit.mean_excess_pct, win_rate: audit.win_rate,
      block_p_value: inference.p_value, json_path: jsonPath, markdown_path: mdPath,
    };
  } finally { db.close(); }
}

/** register: manifest → validate → append. Either a supplied manifest
 * (`--manifest JSON|@file`) or the derived §6.1 sample-excess candidate
 * (`--derive-sample-excess`, requires `--id`/`--version`). Windows are derived
 * by fixed rule from observed storage; nothing here observes a return. */
async function cmdRegister(io: CliIo): Promise<Record<string, unknown>> {
  const registryPath = resolve(io.arg('registry') ?? (() => { throw new Error('--registry required'); })());
  const source = resolve(io.arg('source') ?? (() => { throw new Error('--source required'); })());
  const asOf = io.ymd(io.arg('as-of'), '--as-of');
  const derive = io.flag('derive-sample-excess');
  const manifestRaw = io.arg('manifest');
  if (!derive && !manifestRaw) throw new Error('--manifest JSON|@file 或 --derive-sample-excess 二选一');
  const db = openReadOnly(source);
  try {
    let manifest: unknown;
    if (derive) {
      const id = io.arg('id') ?? (() => { throw new Error('--id required with --derive-sample-excess'); })();
      const version = io.arg('version') ?? (() => { throw new Error('--version required with --derive-sample-excess'); })();
      const researchStart = io.ymd(io.arg('research-start', '20260701'), '--research-start');
      const researchEnd = io.ymd(io.arg('research-end', asOf), '--research-end');
      const cohortDates = (db.prepare(
        'SELECT DISTINCT trade_date FROM watchlist WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date',
      ).all(researchStart, researchEnd) as { trade_date: string }[]).map(r => r.trade_date);
      // Calendar with a tail past research_end: defineWindows refuses a
      // forward_start that shares a day with the holdout's last exit, so the
      // trading days after the window must be visible here. The tail is
      // boundary-only — no cohort matures on it (bounded by research_end).
      const days = [
        ...tradingDays(db, researchStart, researchEnd),
        ...(db.prepare(
          'SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date > ? ORDER BY cal_date LIMIT 10',
        ).all(researchEnd) as { cal_date: string }[]).map(r => r.cal_date),
      ];
      // Evidence narrative: the §6.1 measured facts (single source: this run's
      // audit), written before any §6.2 experiment executes. Only the cheap
      // audit here — re-running diagnoseWatchlist would price the whole
      // control family (~1 min) to compose one metadata sentence, and this
      // string is identity-exempt metadata (mechanism_and_counter_evidence).
      const audit = auditWatchlist(db, asOf, 72, 5);
      const summary = [
        `§6.1 诊断(as_of=${asOf}): 5 日窗口平均超额 ${audit.mean_excess_pct}%，跑赢比例 ${audit.win_rate}，`,
        `block bootstrap(block=5,reps=1999,seed=1021) p=${audit.inference.p_value}，名义独立窗口≈${audit.inference.nominal_blocks}（重叠窗口非独立样本）；`,
        `诊断性质=归因与假设生成，详见 16_WATCHLIST_DIAGNOSIS.md；本候选的预注册规则在 success/failure_criteria 中，未观察任何结果前登记。`,
      ].join(' ');
      manifest = buildPoolExcessCandidate({
        candidateId: id,
        candidateVersion: version,
        researchWindow: { start: researchStart, end: researchEnd },
        researchDataSnapshotId: `watchlist+cache@${asOf}`,
        createdAt: new Date().toISOString(),
        diagnosisSummary: summary,
        cohortDates,
        days,
      });
    } else {
      manifest = readManifestArg(manifestRaw!);
    }
    const registry = new CandidateRegistry(registryPath);
    const identity = registry.register(manifest);
    const m = manifest as { candidate_id: string; candidate_version: string };
    return {
      status: identity.created ? 'REGISTERED' : 'ALREADY_REGISTERED',
      registry: registryPath,
      identity_hash: identity.identity_hash,
      state: registry.state(m.candidate_id, m.candidate_version),
      code_sha: registeredCodeSha(),
      as_of: asOf,
      source_opened_read_only: true,
      promotion_is_order_authorization: false,
    };
  } finally { db.close(); }
}

/** run: execute the registered experiment, adjudicate, append the result. */
async function cmdRun(io: CliIo): Promise<Record<string, unknown>> {
  const registryPath = resolve(io.arg('registry') ?? (() => { throw new Error('--registry required'); })());
  const id = io.arg('id') ?? (() => { throw new Error('--id required'); })();
  const version = io.arg('version') ?? (() => { throw new Error('--version required'); })();
  const source = resolve(io.arg('source') ?? (() => { throw new Error('--source required'); })());
  const asOf = io.ymd(io.arg('as-of'), '--as-of');
  const output = io.arg('output');
  const registry = new CandidateRegistry(registryPath);
  const view = registry.describe(id, version);
  const manifest = view.manifest as unknown as Record<string, unknown>;
  const researchWindow = manifest.research_window as { start: string; end: string };
  const db = openReadOnly(source);
  try {
    const run = runPoolExcessDiagnostic({
      db,
      asOf,
      researchWindow,
      horizon: (manifest.evaluation_horizons as number[])[0] ?? 5,
      success_criteria: manifest.success_criteria,
      failure_criteria: manifest.failure_criteria,
    });
    const specHash = buildExperimentSpec(manifest);
    // Adjudicate the PRE-registered criteria read-only: no threshold is chosen
    // here, no sub-period is inspected to pick a verdict.
    const outcome = run.status === 'INSUFFICIENT_DATA'
      ? 'INSUFFICIENT_DATA'
      : outcomeFor(manifest.success_criteria, run.readings);
    const failureOutcome = outcomeFor(manifest.failure_criteria, run.readings);
    const evidence = evidenceHash(run);
    const runId = `RUN-${evidence.slice(0, 16)}`;
    const funded = io.flag('funded')
      ? crossCheckFunded(db, run)
      : null;
    const record = registry.recordResult({
      candidate_id: id,
      candidate_version: version,
      spec_hash: specHash,
      outcome,
      reason: `success_criteria→${outcome}; failure_criteria→${failureOutcome}; `
        + `formation=${run.segments.formation.mean_excess_pct}%, holdout=${run.segments.holdout.mean_excess_pct}%, `
        + `holdout_block_p=${run.segments.holdout.inference.p_value ?? 'n/a'}`,
      evidence,
      run_id: runId,
      as_of: asOf,
    });
    const doc = { ...run, funded, result_record: record, spec_hash: specHash, outcome, failure_outcome: failureOutcome };
    let jsonPath: string | undefined;
    if (output) {
      mkdirSync(resolve(output), { recursive: true });
      jsonPath = join(resolve(output), `${runId}.json`);
      writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
    }
    return {
      status: 'RESEARCH_ONLY',
      run_id: runId,
      spec_hash: specHash,
      outcome,
      failure_outcome: failureOutcome,
      formation_mean_excess_pct: run.segments.formation.mean_excess_pct,
      holdout_mean_excess_pct: run.segments.holdout.mean_excess_pct,
      holdout_block_p_value: run.segments.holdout.inference.p_value,
      state: registry.state(id, version),
      json_path: jsonPath ?? null,
      runner_reports_are_not_order_authorization: true,
      // machine-checkable anti-promotion assertion
      promotion_is_order_authorization: false,
    };
  } finally { db.close(); }
}

async function cmdShow(io: CliIo): Promise<Record<string, unknown>> {
  const registryPath = resolve(io.arg('registry') ?? (() => { throw new Error('--registry required'); })());
  const registry = new CandidateRegistry(registryPath);
  const id = io.arg('id');
  const version = io.arg('version');
  if (id && version) return { status: 'OK', registry: registryPath, candidate: registry.describe(id, version) };
  return { status: 'OK', registry: registryPath, candidates: registry.list() };
}

async function cmdList(io: CliIo): Promise<Record<string, unknown>> {
  const registryPath = resolve(io.arg('registry') ?? (() => { throw new Error('--registry required'); })());
  const registry = new CandidateRegistry(registryPath);
  return { status: 'OK', registry: registryPath, candidates: registry.list() };
}

export async function runCandidateCommand(argv: string[], env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  void env;
  const sub = argv[0];
  const arg = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 缺少取值`);
    return v;
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const ymd = (value: string | undefined, label: string): string => {
    if (!value || !/^\d{8}$/.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
    return value;
  };
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const io: CliIo = { arg, flag, ymd, print };
  switch (sub) {
    case 'diagnose': return cmdDiagnose(io);
    case 'register': return cmdRegister(io);
    case 'run': return cmdRun(io);
    case 'show': return cmdShow(io);
    case 'list': return cmdList(io);
    default:
      throw new Error(`未知子命令 ${sub ?? ''}\n${CANDIDATE_USAGE}`);
  }
}

/** Executed only when this file is the process entry (`node .../candidateCli.js`),
 * never on import — so `import`ing the module from tests or a future cli.ts
 * wiring cannot accidentally parse argv or open files. */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  runCandidateCommand(process.argv.slice(2))
    .then(result => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(0); })
    .catch((error: unknown) => {
      const message = error instanceof CandidateRegistryError ? `[registry] ${error.message}` : `[candidate] ${(error as Error)?.stack || error}`;
      process.stderr.write(message + '\n');
      process.exit(error instanceof CandidateRegistryError ? 2 : 1);
    });
}
