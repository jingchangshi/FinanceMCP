/** §6.2 — strategy candidate identity and lifecycle registry (goal-1026).
 *
 * This module answers one question: *this candidate is who, it is now at which
 * step, and may that step be advanced?* It does not run strategies, does not
 * compute returns, does not touch production scheduling, and never decides a
 * candidate is "good" — experiments and independent review do that.
 *
 * Design lineage (reused as design semantics, re-implemented in TypeScript):
 * TactiCore `research/ashare/candidates/registry.py` — append-only JSONL,
 * whitelist transitions, identity hash over identity fields only, evidence
 * pointers mandatory on promotions, terminal states with zero out-edges.
 * The state names are the task spec's (goal-1026.md §6.2), mapped 1:1 to
 * TactiCore's as documented in `STATE_ALIASES`.
 *
 * The four invariants, each enforceable by reading one file:
 *
 * 1. **Identity is immutable.** `candidate_id` + `candidate_version` freeze the
 *    content on registration. The same key with different content is refused;
 *    the same key with the same content is idempotent (a repeat submission of
 *    one fact is not an accident).
 * 2. **History is append-only.** Every lifecycle change appends one hashed
 *    transition line; there is no code path that rewrites an earlier line, and
 *    state is *derived* from transitions, never stored as an overwritable field.
 * 3. **Code, data or protocol change ⇒ new version.** `code_sha`,
 *    `research_data_snapshot_id`, `cost_model_version` are identity fields, so
 *    tuning a parameter in place is structurally impossible — it either fails
 *    the identity hash or becomes a new candidate version.
 * 4. **Recommendation is not promotion.** `RECOMMENDED_FOR_APPROVAL` means
 *    "worth a human's approval", not "approved". No path in this module turns
 *    the former into the latter; the framework forbids automatic promotion of
 *    any candidate into a real order-placing strategy (goal-1026 §6.2).
 *
 * Anti-leakage: a registered candidate is research bookkeeping only. Nothing
 * here reads the watchlist scorer's weights or writes a production signal, and
 * `promotion_is_order_authorization` is asserted `false` on every recommendation
 * so the claim is machine-checkable rather than a comment.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export const REGISTRY_MODULE_VERSION = 'ashare-candidate-registry-1.0.0';

// ---------------------------------------------------------------- states

/** Lifecycle states in task-spec order (goal-1026.md §6.2).
 *
 * Mapping to TactiCore's names (registry.py) — the semantics are identical:
 *   BACKTESTED          ≈ HISTORICAL_TESTED
 *   OOS_VALIDATED       ≈ EXECUTION_VERIFIED + FROZEN (frozen before forward observation)
 *   SHADOW              ≈ SHADOW_ACTIVE
 *   VERIFIED            ≈ RECOMMENDED_FOR_APPROVAL  (never REJECTED-with-approval;
 *                          "verified" here = recommended for *human* approval)
 * Terminal / blocked:
 *   INSUFFICIENT_DATA, REJECTED, RETIRED are the task spec's REJECTED/RETIRED
 *   plus TactiCore's INSUFFICIENT_DATA; INVALIDATED carries TactiCore's
 *   "the observation foundation was invalid, not the idea" meaning.
 * Reopening:
 *   REVALIDATED ≈ TactiCore's REVALIDATED; it must re-pass execution
 *   verification and refreeze — it is NOT a shortcut back into shadow. */
export const LIFECYCLE_STATES = [
  'PROPOSED',
  'REGISTERED',
  'BACKTESTED',
  'OOS_VALIDATED',
  'SHADOW',
  'VERIFIED',
] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

export const TERMINAL_STATES = ['INSUFFICIENT_DATA', 'REJECTED', 'INVALIDATED', 'RETIRED'] as const;
export type TerminalState = typeof TERMINAL_STATES[number];

/** Non-terminal reopen state: leaving shadow because its foundation broke must
 * return to historical re-verification, never jump straight back into shadow —
 * the observations it produced cannot simply be counted again. */
export const REOPENING_STATES = ['REVALIDATED'] as const;
export type ReopeningState = typeof REOPENING_STATES[number];

export type CandidateState = LifecycleState | TerminalState | ReopeningState;

export const ALL_STATES: readonly CandidateState[] = [...LIFECYCLE_STATES, ...TERMINAL_STATES, ...REOPENING_STATES];

/** Whitelist of legal advances. The table is *exhaustive*: an advance absent
 * from it is refused, never "allowed by default". Terminal states have zero
 * out-edges by construction. */
export const ALLOWED_TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  PROPOSED: ['REGISTERED', 'REJECTED', 'RETIRED'],
  REGISTERED: ['BACKTESTED', 'INSUFFICIENT_DATA', 'REJECTED', 'RETIRED'],
  BACKTESTED: ['OOS_VALIDATED', 'INSUFFICIENT_DATA', 'REJECTED', 'INVALIDATED', 'RETIRED'],
  OOS_VALIDATED: ['SHADOW', 'REJECTED', 'INVALIDATED', 'RETIRED'],
  SHADOW: ['VERIFIED', 'INSUFFICIENT_DATA', 'REVALIDATED'],
  VERIFIED: ['RETIRED'],
  REVALIDATED: ['OOS_VALIDATED', 'REJECTED', 'RETIRED'],
  INSUFFICIENT_DATA: ['REGISTERED', 'BACKTESTED', 'RETIRED'],
  REJECTED: [],
  INVALIDATED: [],
  RETIRED: [],
};

/** State the given task-spec state maps to under TactiCore's naming, for
 * cross-repository review. Purely documentary; not used for decisions. */
export const STATE_ALIASES: Readonly<Record<string, string>> = {
  BACKTESTED: 'HISTORICAL_TESTED',
  OOS_VALIDATED: 'EXECUTION_VERIFIED→FROZEN',
  SHADOW: 'SHADOW_ACTIVE',
  VERIFIED: 'RECOMMENDED_FOR_APPROVAL',
};

/** Advances that must carry an `evidence` pointer (64-hex sha256 of the
 * evidence payload). REGISTERED is deliberately absent: registration only
 * needs the manifest, and no experiment product exists yet. The registry
 * cannot verify that the evidence is *true* — only that a pointer exists and
 * a reviewer can trace it back months later. */
export const EVIDENCE_REQUIRED_TRANSITIONS: ReadonlySet<CandidateState> = new Set<CandidateState>([
  'BACKTESTED',
  'OOS_VALIDATED',
  'SHADOW',
  'VERIFIED',
]);

// ---------------------------------------------------------------- manifest

/** Identity fields. These jointly define "the same candidate, the same
 * version"; any change must mint a new `candidate_version` instead of editing
 * in place. Together they are exactly the field list goal-1026 §6.2 demands:
 * fixed strategy definition, code version, data version, research window,
 * train/validation split, time-series out-of-sample split, benchmark,
 * fees & slippage, rebalance period, risk limits, capital & capacity,
 * drawdown/return metrics, failure causes, and promotion/elimination rules. */
export const IDENTITY_FIELDS = [
  'candidate_id',
  'candidate_version',
  'strategy_family',
  'economic_hypothesis',
  'universe_specification',
  'signal_definition',
  'portfolio_construction',
  'execution_policy',
  'parameter_space',
  'research_data_snapshot_id',
  'code_sha',
  'cost_model_version',
  'benchmark_versions',
  'research_window',
  'formation_window',
  'historical_holdout_window',
  'forward_start',
  'evaluation_horizons',
  'rebalance_period',
  'risk_limits',
  'capital_and_capacity',
  'performance_reference',
  'multiple_testing_family',
  'success_criteria',
  'failure_criteria',
  'promotion_criteria',
  'elimination_criteria',
] as const;

/** Present at registration, recorded, but deliberately *outside* the identity
 * hash: `created_at` (a wall-clock instant) must not change who the candidate
 * is, and `mechanism_and_counter_evidence` is the diagnosis narrative, which
 * may be corrected in a later version's text without pretending the strategy
 * changed. */
export const REQUIRED_METADATA_FIELDS = [
  'created_at',
  'mechanism_and_counter_evidence',
] as const;

export interface SampleWindow { start: string; end: string }

export interface CandidateManifest {
  candidate_id: string;
  candidate_version: string;
  strategy_family: string;
  economic_hypothesis: string;
  universe_specification: unknown;
  signal_definition: unknown;
  portfolio_construction: unknown;
  execution_policy: unknown;
  parameter_space: { [k: string]: unknown; search_budget: number };
  research_data_snapshot_id: string;
  /** 64-hex sha256 of the actual experiment/strategy code that will run. */
  code_sha: string;
  cost_model_version: string;
  benchmark_versions: unknown;
  research_window: SampleWindow;
  formation_window: SampleWindow;
  historical_holdout_window: SampleWindow;
  /** Forward (truly unseen) observation start; a single date, not a window. */
  forward_start: string;
  evaluation_horizons: number[];
  rebalance_period: string;
  risk_limits: unknown;
  capital_and_capacity: unknown;
  performance_reference: unknown;
  multiple_testing_family: string;
  success_criteria: unknown;
  failure_criteria: unknown;
  promotion_criteria: unknown;
  elimination_criteria: unknown;
  created_at: string;
  mechanism_and_counter_evidence: string;
  [k: string]: unknown;
}

export class CandidateRegistryError extends Error {
  constructor(message: string) { super(message); this.name = 'CandidateRegistryError'; }
}

// ---------------------------------------------------------------- helpers

const HEX64 = /^[a-f0-9]{64}$/;
const YMD = /^\d{8}$/;
const validDate = (d: unknown): d is string =>
  typeof d === 'string' && YMD.test(d)
  && new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).toISOString().slice(0, 10).replace(/-/g, '') === d;

const validInstant = (v: unknown): v is string => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return false;
  // Timezone-aware: a bare local timestamp would silently mean different
  // instants on different machines, which is fatal for "recorded before".
  return /(Z|[+-]\d{2}:\d{2})$/.test(v);
};

/** Stable serialization: keys sorted, no whitespace, undefined dropped —
 * so identical content is always identical bytes. Without this normalization
 * the hash is meaningless: field order alone would read as tampering and every
 * repeat registration of one fact would look like an edit. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
        .filter(key => (v as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, sort((v as Record<string, unknown>)[key])]))
      : v;
  const result = JSON.stringify(sort(value));
  if (result === undefined) throw new CandidateRegistryError('JSON content is required');
  return result;
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Evidence pointer: callers hash their evidence payload (report JSON, run
 * record) with exactly this so `advance` can verify the format. */
export const evidenceHash = sha256;

/** Identity hash — covers `IDENTITY_FIELDS` only. State, timestamps and
 * notes are excluded on purpose: otherwise every appended line would "change
 * the identity" and identity would mean nothing. */
export function identityHash(manifest: Record<string, unknown>): string {
  const missing = IDENTITY_FIELDS.filter(name => !(name in manifest));
  if (missing.length) throw new CandidateRegistryError(`候选缺少身份字段: ${missing.join(', ')}`);
  const payload: Record<string, unknown> = {};
  for (const name of IDENTITY_FIELDS) payload[name] = manifest[name];
  return sha256(payload);
}

/** Hash of the whole manifest as submitted: records *what* was registered. */
export const manifestHash = sha256;

/** Structural validation. Deliberately does NOT judge whether the strategy is
 * sensible, the parameters optimal, or the hypothesis economic — those are
 * research-review questions. This only guarantees the identity is complete
 * and self-consistent. Returns the identity hash. */
export function validateManifest(manifest: unknown): string {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CandidateRegistryError('manifest 必须是对象');
  }
  const m = manifest as Record<string, unknown>;
  // Missing identity fields and missing metadata are reported separately: the
  // first means "this is not a registrable candidate", the second only "a
  // field was forgotten". One blended message leaves the caller unable to
  // tell what to fix.
  const missingIdentity = IDENTITY_FIELDS.filter(name => !(name in m));
  if (missingIdentity.length) throw new CandidateRegistryError(`候选缺少身份字段: ${missingIdentity.join(', ')}`);
  const missingMetadata = REQUIRED_METADATA_FIELDS.filter(name => !(name in m));
  if (missingMetadata.length) throw new CandidateRegistryError(`manifest 缺少元数据字段: ${missingMetadata.join(', ')}`);

  for (const name of ['candidate_id', 'candidate_version', 'strategy_family',
    'research_data_snapshot_id', 'cost_model_version', 'rebalance_period',
    'multiple_testing_family'] as const) {
    const v = m[name];
    if (typeof v !== 'string' || !v.trim()) throw new CandidateRegistryError(`${name} 必须是非空字符串`);
  }
  if (typeof m.code_sha !== 'string' || !HEX64.test(m.code_sha)) {
    throw new CandidateRegistryError('code_sha 必须是 64 位十六进制 sha256（代码版本是身份的一部分）');
  }
  if (typeof m.created_at !== 'string' || !validInstant(m.created_at)) {
    throw new CandidateRegistryError('created_at 必须是带时区的 UTC 时刻（如 2026-10-26T03:00:00Z），不是日期');
  }
  for (const name of ['research_window', 'formation_window', 'historical_holdout_window'] as const) {
    const w = m[name];
    if (!w || typeof w !== 'object') throw new CandidateRegistryError(`${name} 必须是含 start/end 的对象`);
    const { start, end } = w as SampleWindow;
    if (!validDate(start) || !validDate(end)) throw new CandidateRegistryError(`${name}.start/.end 必须是合法 YYYYMMDD`);
    if (start > end) throw new CandidateRegistryError(`${name} 的 start(${start}) 晚于 end(${end})`);
  }
  if (!validDate(m.forward_start)) throw new CandidateRegistryError('forward_start 必须是合法 YYYYMMDD');
  const holdout = (m.historical_holdout_window as SampleWindow).end;
  if ((m.forward_start as string) <= holdout) {
    throw new CandidateRegistryError(
      `forward_start(${m.forward_start}) 必须晚于 historical_holdout_window.end(${holdout})；`
      + '否则前瞻观察与历史回测重叠，不能称为样本外');
  }
  const rw = m.research_window as SampleWindow;
  const fw = m.formation_window as SampleWindow;
  const hw = m.historical_holdout_window as SampleWindow;
  // Three-segment mutual exclusion (TactiCore SampleSplit): formation and
  // holdout may not overlap — an overlapping "out-of-sample" is not
  // out-of-sample — and both must sit inside the declared research window.
  if (fw.end >= hw.start) {
    throw new CandidateRegistryError(
      `formation_window.end(${fw.end}) 必须早于 historical_holdout_window.start(${hw.start})；训练与验证三段互斥`);
  }
  if (fw.start < rw.start || hw.end > rw.end) {
    throw new CandidateRegistryError('formation/holdout 必须落在 research_window 之内');
  }
  const horizons = m.evaluation_horizons;
  if (!Array.isArray(horizons) || !horizons.length || horizons.some(h => !Number.isInteger(h) || h < 2)) {
    throw new CandidateRegistryError('evaluation_horizons 必须是非空数组，每个元素为 >=2 的整数');
  }
  // The parameter search budget must be recorded up front: writing the budget
  // after the search is writing a budget after picking the winner.
  const space = m.parameter_space;
  if (!space || typeof space !== 'object') throw new CandidateRegistryError('parameter_space 必须是对象');
  const budget = (space as { search_budget?: unknown }).search_budget;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0) {
    throw new CandidateRegistryError('parameter_space.search_budget 必须是 >=0 的整数（预先登记，不得事后补写）');
  }
  // Criteria fields must be *readable* decision rules, not free-form prose:
  // a promotion condition nobody can parse becomes an unreadable gate, and an
  // unreadable gate behaves exactly like no gate (the TactiCore lesson of
  // experiment B). The framework parses `outcome_for` rules; the registry
  // enforces that they exist as structured rules with a `type`.
  for (const name of ['success_criteria', 'failure_criteria', 'promotion_criteria', 'elimination_criteria'] as const) {
    const c = m[name];
    if (!c || typeof c !== 'object' || Array.isArray(c) || !('type' in (c as object))) {
      throw new CandidateRegistryError(`${name} 必须是结构化规则对象（含 type 字段），供只读判据解析`);
    }
  }
  return identityHash(m);
}

// ---------------------------------------------------------------- records

export interface CandidateRecord {
  kind: 'candidate';
  candidate_id: string;
  candidate_version: string;
  identity_hash: string;
  manifest_hash: string;
  registered_at: string;
  manifest: CandidateManifest;
}

export interface TransitionRecord {
  kind: 'transition';
  candidate_id: string;
  candidate_version: string;
  from_state: CandidateState | null;
  to_state: CandidateState;
  at: string;
  reason: string;
  /** 64-hex evidence pointer; required on promotion transitions. */
  evidence: string | null;
}

export interface ExperimentResultRecord {
  kind: 'result';
  candidate_id: string;
  candidate_version: string;
  /** Recomputed from the run's spec; must equal the registry's own hash. */
  spec_hash: string;
  /** Pre-registered criterion decision, read-only — see framework/outcome. */
  outcome: string;
  reason: string;
  evidence: string;
  run_id: string;
  as_of: string;
  recorded_at: string;
}

export type RegistryRecord = CandidateRecord | TransitionRecord | ExperimentResultRecord;

// ---------------------------------------------------------------- registry

export interface RegisterResult { identity_hash: string; created: boolean }

/** Append-only JSONL candidate registry. No database, no service.
 *
 * JSONL instead of SQLite is deliberate: this file's value is that a human can
 * read it line by line and `git diff` it. Once it becomes a binary database,
 * "old results were not replaced" requires trust instead of one `git log`.
 * The caller supplies the path; nothing here writes a fixed production
 * location, and `assertSafePath` refuses a market cache. */
export class CandidateRegistry {
  readonly path: string;
  private entries = new Map<string, CandidateRecord>();
  private transitions: TransitionRecord[] = [];
  private results: ExperimentResultRecord[] = [];
  private loaded = false;

  constructor(path: string) {
    this.path = resolve(path);
    CandidateRegistry.assertSafePath(this.path);
  }

  /** The registry must never alias the live market cache: appending JSONL to
   * `ashare.sqlite` would at best fail, at worst corrupt the one file the whole
   * pipeline depends on. Read-only detection — refuses existing non-JSONL
   * files and the canonical cache name wherever it appears. */
  static assertSafePath(path: string): void {
    if (path.endsWith('.sqlite') || path.endsWith('.sqlite3') || path.endsWith('.db')) {
      throw new CandidateRegistryError(`登记簿路径不得是数据库文件: ${path}`);
    }
    if (/(^|\/)ashare\.sqlite3?$/.test(path)) {
      throw new CandidateRegistryError(`登记簿路径不得是行情缓存: ${path}`);
    }
    if (!existsSync(path)) return;
    // Line-oriented check at LINE boundaries, never at byte offsets: a byte
    // cap (an earlier 4096-byte head slice) cut a long first record — a
    // `candidate` line embeds the whole manifest and runs to ~6KB — mid-way
    // and refused the registry's own file as "not JSONL". Read a bounded
    // chunk, truncate at the last complete line inside it, then require every
    // complete line there to be a JSON document.
    const fd = openSync(path, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(1 << 20);
      const n = readSync(fd, buf, 0, buf.length, 0);
      chunk = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0) {
      // Nothing line-oriented within 1 MiB: this file is not JSONL (our own
      // writer always terminates each record with '\n').
      throw new CandidateRegistryError(`${path} 已存在且不是 JSONL；登记簿不得与既有文件共存`);
    }
    for (const line of chunk.slice(0, lastNewline).split('\n')) {
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch {
        throw new CandidateRegistryError(`${path} 已存在且不是 JSONL；登记簿不得与既有文件共存`);
      }
    }
  }

  private key(candidateId: string, candidateVersion: string): string {
    return `${candidateId}@${candidateVersion}`;
  }

  private load(): void {
    if (this.loaded) return;
    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let record: RegistryRecord;
        try { record = JSON.parse(line) as RegistryRecord; } catch {
          throw new CandidateRegistryError(`${this.path}:${i + 1} 不是合法 JSON；登记簿不得被手工编辑`);
        }
        switch (record.kind) {
          case 'candidate':
            this.entries.set(this.key(record.candidate_id, record.candidate_version), record);
            break;
          case 'transition':
            this.transitions.push(record);
            break;
          case 'result':
            this.results.push(record);
            break;
          default:
            throw new CandidateRegistryError(`${this.path}:${i + 1} 未知记录类型 ${(record as { kind?: string }).kind}`);
        }
      }
    }
    this.loaded = true;
  }

  private append(record: RegistryRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // One write() of one canonical line: a partially written line would poison
    // every future load, because a truncated JSON line is indistinguishable
    // from a hand edit.
    appendFileSync(this.path, canonicalJson(record) + '\n', { encoding: 'utf8', flag: 'a' });
  }

  /** Register a candidate. Returns `{identity_hash, created}`.
   *
   * Idempotent: re-registering the same identity returns `created: false`,
   * not an error — repeating one fact is not an incident. The same
   * `candidate_id`+`candidate_version` with different content is refused:
   * that is not a repeat, it is an attempt to edit a frozen identity. */
  register(manifest: unknown): RegisterResult {
    this.load();
    const identity = validateManifest(manifest);
    const m = manifest as CandidateManifest;
    const k = this.key(m.candidate_id, m.candidate_version);
    const existing = this.entries.get(k);
    if (existing) {
      if (existing.identity_hash !== identity) {
        // Two different failures land here, and the wording must separate them:
        // a manifest whose content actually changed, versus a registry whose
        // stored hash was tampered with. One blended "no in-place edits" would
        // leave a reviewer unable to tell which side to investigate.
        throw new CandidateRegistryError(
          `候选 ${k} 的身份哈希不符：已登记为 ${existing.identity_hash.slice(0, 12)}…，`
          + `本次提交为 ${identity.slice(0, 12)}…。策略代码、输入或协议改变必须产生新的 candidate_version，不得原地修改`);
      }
      return { identity_hash: identity, created: false };
    }
    const now = new Date().toISOString();
    const record: CandidateRecord = {
      kind: 'candidate',
      candidate_id: m.candidate_id,
      candidate_version: m.candidate_version,
      identity_hash: identity,
      manifest_hash: manifestHash(manifest),
      registered_at: now,
      manifest: m,
    };
    this.append(record);
    this.entries.set(k, record);
    this.appendTransition({
      kind: 'transition',
      candidate_id: m.candidate_id,
      candidate_version: m.candidate_version,
      from_state: null,
      to_state: 'PROPOSED',
      at: now,
      reason: '候选登记',
      evidence: null,
    });
    return { identity_hash: identity, created: true };
  }

  /** The single place transitions are written. Called by `register` and
   * `advance` only: memory and disk must update together, so a candidate
   * registered in this process is visible to `state()` in this same process —
   * a registry that is only correct after a restart makes every caller think
   * it must reopen first. */
  private appendTransition(record: TransitionRecord): void {
    this.append(record);
    this.transitions.push(record);
  }

  /** Current state, derived from the transition history — never read from an
   * overwritable field. */
  state(candidateId: string, candidateVersion: string): CandidateState {
    this.load();
    const states = this.transitions
      .filter(t => t.candidate_id === candidateId && t.candidate_version === candidateVersion)
      .map(t => t.to_state);
    if (!states.length) throw new CandidateRegistryError(`候选 ${candidateId}@${candidateVersion} 未登记`);
    return states[states.length - 1];
  }

  /** Advance the state machine. Illegal advances are refused *and not recorded*.
   *
   * `reason` must be non-empty: a state change without a stated reason is,
   * three months later, indistinguishable from a mis-click. */
  advance(
    candidateId: string,
    candidateVersion: string,
    toState: CandidateState,
    reason: string,
    evidence?: string | null,
  ): CandidateState {
    this.load();
    const k = this.key(candidateId, candidateVersion);
    if (!this.entries.has(k)) throw new CandidateRegistryError(`候选 ${k} 未登记`);
    if (!ALL_STATES.includes(toState)) throw new CandidateRegistryError(`未知状态 ${toState}`);
    if (typeof reason !== 'string' || !reason.trim()) throw new CandidateRegistryError('状态推进必须给出 reason');
    const current = this.state(candidateId, candidateVersion);
    const allowed = ALLOWED_TRANSITIONS[current];
    // Legality first, evidence second: reversed, a skipped step would be
    // reported as "missing evidence", implying that supplying a hash enables
    // the jump — which it must not.
    if (!allowed.includes(toState)) {
      throw new CandidateRegistryError(
        `${current} → ${toState} 不是合法推进（允许: ${allowed.length ? [...allowed].join(', ') : '无'}）`);
    }
    if (EVIDENCE_REQUIRED_TRANSITIONS.has(toState) && !evidence) {
      throw new CandidateRegistryError(
        `${current} → ${toState} 必须附带 evidence（64 位十六进制证据指针）；没有证据指针的晋级无法被独立审查追溯`);
    }
    if (evidence != null && !HEX64.test(evidence)) {
      throw new CandidateRegistryError('evidence 必须是 64 位十六进制 sha256');
    }
    this.appendTransition({
      kind: 'transition',
      candidate_id: candidateId,
      candidate_version: candidateVersion,
      from_state: current,
      to_state: toState,
      at: new Date().toISOString(),
      reason: reason.trim(),
      evidence: evidence ?? null,
    });
    return toState;
  }

  /** Full transition history in append order, for independent review. */
  history(candidateId: string, candidateVersion: string): TransitionRecord[] {
    this.load();
    return this.transitions.filter(t => t.candidate_id === candidateId && t.candidate_version === candidateVersion);
  }

  /** Re-verify a supplied manifest against the registered identity: the
   * "has anyone tweaked this after freezing?" check. */
  verifyIdentity(manifest: unknown): string {
    this.load();
    if (!manifest || typeof manifest !== 'object') throw new CandidateRegistryError('manifest 必须是对象');
    const m = manifest as Record<string, unknown>;
    const k = this.key(String(m.candidate_id), String(m.candidate_version));
    const existing = this.entries.get(k);
    if (!existing) throw new CandidateRegistryError(`候选 ${k} 未登记，无法核对身份`);
    const identity = validateManifest(manifest);
    if (identity !== existing.identity_hash) {
      throw new CandidateRegistryError(`候选 ${k} 的身份哈希不符；内容在冻结后被改动`);
    }
    return identity;
  }

  /** Record an experiment result against a candidate.
   *
   * The record is a *claim with a spec*: `spec_hash` must equal the hash of the
   * pre-registered experiment spec (computed from the registered manifest), and
   * `outcome` must be one of the pre-registered decision outcomes. A result
   * whose spec does not hash to the registered candidate is refused outright —
   * that is precisely the "historical tuning leaking into a registered
   * candidate" path goal-1026 §6.2 forbids. Append-only; a rerun appends a new
   * line with a new `run_id`. */
  recordResult(input: {
    candidate_id: string;
    candidate_version: string;
    spec_hash: string;
    outcome: string;
    reason: string;
    evidence: string;
    run_id: string;
    as_of: string;
  }): ExperimentResultRecord {
    this.load();
    const k = this.key(input.candidate_id, input.candidate_version);
    const existing = this.entries.get(k);
    if (!existing) throw new CandidateRegistryError(`候选 ${k} 未登记`);
    if (!HEX64.test(input.spec_hash)) throw new CandidateRegistryError('spec_hash 必须是 64 位十六进制');
    const expected = experimentSpecHash(existing.manifest as unknown as Record<string, unknown>);
    if (input.spec_hash !== expected) {
      throw new CandidateRegistryError(
        `spec_hash 与登记候选不符：登记推导 ${expected.slice(0, 12)}…，提交 ${input.spec_hash.slice(0, 12)}…；`
        + '实验规格必须先于结果注册，事后改动的规格不属于该候选');
    }
    if (!input.outcome || !Object.prototype.hasOwnProperty.call(OUTCOME_ENUM, input.outcome)) {
      throw new CandidateRegistryError(
        `outcome 必须是预登记结论之一: ${Object.keys(OUTCOME_ENUM).join(', ')}（可读不懂的判据给 INVALID_RUN，而不是猜规则）`);
    }
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new CandidateRegistryError('result 必须给出 reason');
    if (!HEX64.test(input.evidence)) throw new CandidateRegistryError('evidence 必须是 64 位十六进制 sha256');
    if (!input.run_id || !input.as_of || !validDate(input.as_of)) throw new CandidateRegistryError('run_id 与 as_of(YYYYMMDD) 必填');
    const record: ExperimentResultRecord = {
      kind: 'result',
      candidate_id: input.candidate_id,
      candidate_version: input.candidate_version,
      spec_hash: input.spec_hash,
      outcome: input.outcome,
      reason: input.reason.trim(),
      evidence: input.evidence,
      run_id: input.run_id,
      as_of: input.as_of,
      recorded_at: new Date().toISOString(),
    };
    this.append(record);
    this.results.push(record);
    return record;
  }

  /** Derived view: one candidate's registered manifest, current state,
   * transitions and recorded experiment results. */
  describe(candidateId: string, candidateVersion: string): {
    candidate_id: string;
    candidate_version: string;
    state: CandidateState;
    identity_hash: string;
    registered_at: string;
    manifest: CandidateManifest;
    transitions: TransitionRecord[];
    results: ExperimentResultRecord[];
  } {
    this.load();
    const k = this.key(candidateId, candidateVersion);
    const record = this.entries.get(k);
    if (!record) throw new CandidateRegistryError(`候选 ${k} 未登记`);
    return {
      candidate_id: candidateId,
      candidate_version: candidateVersion,
      state: this.state(candidateId, candidateVersion),
      identity_hash: record.identity_hash,
      registered_at: record.registered_at,
      manifest: record.manifest,
      transitions: this.history(candidateId, candidateVersion),
      results: this.results.filter(r => r.candidate_id === candidateId && r.candidate_version === candidateVersion),
    };
  }

  /** All registered candidates (each in its latest registered version key). */
  list(): { candidate_id: string; candidate_version: string; registered_at: string; identity_hash: string }[] {
    this.load();
    return [...this.entries.values()]
      .map(r => ({ candidate_id: r.candidate_id, candidate_version: r.candidate_version, registered_at: r.registered_at, identity_hash: r.identity_hash }))
      .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id) || a.candidate_version.localeCompare(b.candidate_version));
  }
}

// ---------------------------------------------------------------- outcome enum

/** The decision outcomes a run may be adjudicated to. The split that matters:
 * `BLOCKED_BY_DATA` (the world did not supply enough observations) versus
 * `INVALID_RUN` (the run or its readable criteria are not trustworthy). They
 * are never conflated — "not enough data" must never launder a broken run,
 * and a broken run must never be reported as a finding about the strategy. */
export const OUTCOME_ENUM = {
  SUPPORTS_HYPOTHESIS: '预登记成功判据满足',
  DOES_NOT_SUPPORT_HYPOTHESIS: '预登记判据不满足',
  NO_SIGNIFICANT_DIFFERENCE: '与反事实对照无显著差异',
  INSUFFICIENT_DATA: '观察样本不足，无法判定',
  BLOCKED_BY_DATA: '数据缺口阻断，结论不可得',
  INVALID_RUN: '运行或判据不可读，结论作废',
} as const;
export type CandidateOutcome = keyof typeof OUTCOME_ENUM;

/** Pre-registered spec hash: derives from the identity manifest the way the
 * experiment framework derives its own spec, so registry and framework agree
 * byte-for-byte. Anything a run could change after registration (windows,
 * costs, criteria, code_sha, data snapshot) is inside the identity hash, so a
 * post-hoc tweak yields a different spec hash and is refused by `recordResult`. */
export function experimentSpecHash(manifest: Record<string, unknown>): string {
  return sha256({
    identity_hash: identityHash(manifest),
    // The fields an ExperimentSpec would additionally pin at registration
    // time, restated here so the hash covers exactly the same surface.
    evaluation_horizons: manifest.evaluation_horizons,
    benchmark_versions: manifest.benchmark_versions,
    cost_model_version: manifest.cost_model_version,
    execution_policy: manifest.execution_policy,
    formation_window: manifest.formation_window,
    historical_holdout_window: manifest.historical_holdout_window,
    forward_start: manifest.forward_start,
    success_criteria: manifest.success_criteria,
    failure_criteria: manifest.failure_criteria,
  });
}

// ---------------------------------------------------------------- outcome adjudication

export interface RunReading {
  id: string;
  /** Nullable: a missing reading is missing data, never a zero. */
  value: number | null;
  /** Optional per-reading weight; defaults to 1 when absent. */
  weight?: number;
}

export interface OutcomeCriterion { type: string; [k: string]: unknown }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Adjudicate a run against pre-registered criteria — READ-ONLY with respect
 * to the registered spec: this function never recomputes returns, never looks
 * at a sub-period, never picks a comparison group. It parses the criterion the
 * candidate was registered with, evaluates it on the readings the run
 * produced, and reports what the rule says.
 *
 * Order of decisions (each outcome is a distinct failure mode, never conflated):
 *   1. Unreadable criterion (not an object, unknown type, missing bounds) →
 *      `INVALID_RUN`. An unreadable gate is strictly worse than no gate: it
 *      *reads* as if it worked (the TactiCore experiment-B defect).
 *   2. No run at all (no readings) → `INSUFFICIENT_DATA`.
 *   3. The criterion's subject readings exist but none are present →
 *      `INSUFFICIENT_DATA` (the sample does not exist).
 *   4. Majority of subject readings missing → `BLOCKED_BY_DATA` (partial data
 *      outage; "not enough data" must never launder a broken run, and a
 *      broken run must never be reported as a finding).
 *   5. Otherwise evaluate the parsed rule on the present values.
 *
 * Supported pre-registered types:
 *   - `{type:'threshold', reading, max?|min?}`   max/min bound on the mean of named readings
 *   - `{type:'win_rate', min, baseline?}`        share of (value − baseline) > 0
 *   - `{type:'compare', a, b, max_abs_diff}`     mean |a − b| across paired readings
 */
export function outcomeFor(criterion: unknown, readings: RunReading[]): CandidateOutcome {
  if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return 'INVALID_RUN';
  const c = criterion as OutcomeCriterion;
  // Parse the pre-registered rule FIRST: unreadable ⇒ INVALID_RUN regardless
  // of what the data says. Data cannot rescue an unreadable spec.
  const readable = c.type === 'threshold'
    ? typeof c.reading === 'string' && (('max' in c && finite(c.max)) || ('min' in c && finite(c.min)))
    : c.type === 'win_rate'
      ? typeof c.reading === 'string' && finite(c.min)
      : c.type === 'compare'
        ? typeof c.a === 'string' && typeof c.b === 'string' && finite(c.max_abs_diff)
        : false;
  if (!readable) return 'INVALID_RUN';

  const select = (name: string): RunReading[] =>
    readings.filter(r => r.id === name || r.id.startsWith(`${name}:`));
  const target: RunReading[] = c.type === 'compare'
    ? [...select(c.a as string), ...select(c.b as string)]
    : select(c.reading as string);
  const present = target.filter(r => finite(r.value));
  if (!readings.length) return 'INSUFFICIENT_DATA';
  if (!target.length) return 'BLOCKED_BY_DATA'; // run produced data, but not this subject
  if (!present.length) return 'INSUFFICIENT_DATA'; // subject's sample does not exist
  if (present.length < Math.ceil(target.length / 2)) return 'BLOCKED_BY_DATA';

  const weightedMean = (rows: RunReading[]): number | null => {
    const usable = rows.filter(r => finite(r.value));
    if (!usable.length) return null;
    const w = usable.map(r => (finite(r.weight) && (r.weight as number) > 0 ? (r.weight as number) : 1));
    const total = w.reduce((s, x) => s + x, 0);
    return usable.reduce((s, r, i) => s + (r.value as number) * w[i], 0) / total;
  };
  switch (c.type) {
    case 'threshold': {
      const avg = weightedMean(present);
      if (avg === null) return 'BLOCKED_BY_DATA';
      if ('max' in c && finite(c.max) && avg > (c.max as number)) return 'DOES_NOT_SUPPORT_HYPOTHESIS';
      if ('min' in c && finite(c.min) && avg < (c.min as number)) return 'DOES_NOT_SUPPORT_HYPOTHESIS';
      return 'SUPPORTS_HYPOTHESIS';
    }
    case 'win_rate': {
      const baseline = finite(c.baseline) ? (c.baseline as number) : 0;
      const rate = present.filter(r => (r.value as number) > baseline).length / target.filter(r => finite(r.value)).length;
      return rate >= (c.min as number) ? 'SUPPORTS_HYPOTHESIS' : 'DOES_NOT_SUPPORT_HYPOTHESIS';
    }
    case 'compare': {
      const a = select(c.a as string).filter(r => finite(r.value));
      const b = select(c.b as string).filter(r => finite(r.value));
      const n = Math.min(a.length, b.length);
      if (!n) return 'BLOCKED_BY_DATA';
      let total = 0;
      for (let i = 0; i < n; i++) total += Math.abs((a[i].value as number) - (b[i].value as number));
      const diff = total / n;
      return diff <= (c.max_abs_diff as number) ? 'NO_SIGNIFICANT_DIFFERENCE' : 'DOES_NOT_SUPPORT_HYPOTHESIS';
    }
    default:
      /* unreachable: `readable` already rejected unknown types */
      return 'INVALID_RUN';
  }
}
