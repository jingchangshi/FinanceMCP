import { createHash } from 'node:crypto';

/** Offline interchange only; no production admission or execution authority. */
export type StrategyRelease = {
  schema_version: 'strategy-release-1';
  research_status: 'DRAFT' | 'RESEARCH_PUBLISHED' | 'FROZEN' | 'PROSPECTIVE_SHADOW_ACTIVE' | 'REJECTED';
  production_admission: 'NOT_APPROVED';
  strategy: { id: string; version: string; implementation_sha256: string };
  applicability: { market: string; environment: string };
  execution_assumptions: { signal_timing: string; earliest_execution: string; exit: string; fees: string; lot_size: string };
  inputs: { source: string; snapshot: string; start_date: string; end_date: string; assets: string[] };
  rules: string[];
  parameters: Record<string, string>;
  evidence: { reference: string; sha256: string }[];
  content_hash: string;
};

const SHA = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const statuses = new Set(['DRAFT', 'RESEARCH_PUBLISHED', 'FROZEN', 'PROSPECTIVE_SHADOW_ACTIVE', 'REJECTED']);
const fail = (): never => { throw new Error('invalid_strategy_release'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return fail();
  return record;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || /^[ \t\r\n]*$/.test(value) || /[\uD800-\uDFFF]/u.test(value)) fail();
}
function date(value: unknown): asserts value is string {
  text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail();
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length) return fail();
  return value;
}
/** Canonical JSON: UTF-8, sorted ASCII object keys, compact, no numeric values. */
function canonical(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

/** Validate the entire contract and return its verified content hash. */
export function validateStrategyRelease(value: unknown): string {
  const root = object(value, ['schema_version', 'research_status', 'production_admission', 'strategy', 'applicability', 'execution_assumptions', 'inputs', 'rules', 'parameters', 'evidence', 'content_hash']);
  if (root.schema_version !== 'strategy-release-1' || typeof root.research_status !== 'string' || !statuses.has(root.research_status) || root.production_admission !== 'NOT_APPROVED') fail();
  const strategy = object(root.strategy, ['id', 'version', 'implementation_sha256']);
  text(strategy.id); text(strategy.version); text(strategy.implementation_sha256);
  if (strategy.implementation_sha256 !== 'UNKNOWN' && !SHA.test(strategy.implementation_sha256)) fail();
  const applicability = object(root.applicability, ['market', 'environment']);
  text(applicability.market); text(applicability.environment);
  const execution = object(root.execution_assumptions, ['signal_timing', 'earliest_execution', 'exit', 'fees', 'lot_size']);
  for (const value of Object.values(execution)) text(value);
  const inputs = object(root.inputs, ['source', 'snapshot', 'start_date', 'end_date', 'assets']);
  text(inputs.source); text(inputs.snapshot); date(inputs.start_date); date(inputs.end_date);
  if ((inputs.start_date as string) > (inputs.end_date as string)) fail();
  const assets = list(inputs.assets); assets.forEach(text);
  if (new Set(assets).size !== assets.length) fail();
  list(root.rules).forEach(text);
  if (!root.parameters || typeof root.parameters !== 'object' || Array.isArray(root.parameters)) fail();
  const parameters = root.parameters as Record<string, unknown>;
  if (!Object.keys(parameters).length) fail();
  for (const [key, val] of Object.entries(parameters)) { if (!KEY.test(key)) fail(); text(val); }
  for (const item of list(root.evidence)) {
    const evidence = object(item, ['reference', 'sha256']);
    text(evidence.reference); text(evidence.sha256);
    if (!SHA.test(evidence.sha256)) fail();
  }
  text(root.content_hash);
  if (!SHA.test(root.content_hash)) fail();
  const { content_hash, ...payload } = root;
  const hash = createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
  if (hash !== content_hash) fail();
  return hash;
}
