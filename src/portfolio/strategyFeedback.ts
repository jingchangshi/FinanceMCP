import { createHash } from 'node:crypto';

/** Offline feedback envelope; no account data or persistence. */
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?![\s\S])/;
const SHA = /^[0-9a-f]{64}(?![\s\S])/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const common = ['schema_version', 'event_id', 'event_type', 'release_hash', 'snapshot_hash', 'occurred_at', 'recorded_at', 'coverage', 'payload'];
const payloads: Record<string, { keys: string[]; results?: string[] }> = {
  SIGNAL_EVALUATED: { keys: ['signal_id', 'result'], results: ['TRIGGERED', 'NOT_TRIGGERED', 'UNAVAILABLE'] },
  DECISION: { keys: ['signal_event_id', 'result', 'reason_code'], results: ['ACCEPTED', 'REJECTED', 'NO_ACTION'] },
  OUTCOME: { keys: ['decision_event_id', 'result', 'reason_code'], results: ['PENDING', 'UNAVAILABLE', 'OBSERVED', 'ACTUAL_FILL'] },
  CORRECTION: { keys: ['corrects_event_id', 'reason_code'] },
};
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid feedback object');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error('invalid feedback object');
  return value as Record<string, any>;
}
function id(value: unknown): boolean { return typeof value === 'string' && ID.test(value); }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIME.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value.replace('Z', '.000Z');
}
function date(value: unknown): value is string { return typeof value === 'string' && DATE.test(value) && timestamp(`${value}T00:00:00Z`); }

export function validateEvent(value: unknown): void {
  const e = object(value, common);
  if (e.schema_version !== 'strategy-feedback-1' || typeof e.event_type !== 'string' || !Object.hasOwn(payloads, e.event_type) || !id(e.event_id)) throw new Error('invalid feedback identity');
  for (const key of ['release_hash', 'snapshot_hash']) if (typeof e[key] !== 'string' || !SHA.test(e[key])) throw new Error('invalid feedback hash');
  if (!timestamp(e.occurred_at) || !timestamp(e.recorded_at) || e.occurred_at > e.recorded_at) throw new Error('invalid timestamp');
  const c = object(e.coverage, ['universe_id', 'period_start', 'period_end']);
  if (!id(c.universe_id) || !date(c.period_start) || !date(c.period_end) || c.period_start > c.period_end) throw new Error('invalid coverage');
  const spec = payloads[e.event_type];
  const p = object(e.payload, spec.keys);
  for (const [key, entry] of Object.entries(p)) {
    if (key === 'result') {
      if (typeof entry !== 'string' || !spec.results?.includes(entry)) throw new Error('invalid result');
    } else if (!id(entry)) throw new Error('invalid identifier');
  }
  if (e.event_type === 'CORRECTION' && p.corrects_event_id === e.event_id) throw new Error('self correction');
}
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function contentHash(event: unknown): string {
  validateEvent(event);
  return createHash('sha256').update(canonical(event), 'utf8').digest('hex');
}
export function appendEvent(events: unknown[], event: unknown): unknown[] {
  const digest = contentHash(event);
  let duplicate = false;
  const seen = new Set<string>();
  for (const existing of events) {
    const old = contentHash(existing);
    const id = (existing as any).event_id as string;
    if (seen.has(id)) throw new Error('duplicate existing event id');
    seen.add(id);
    if (id === (event as any).event_id) {
      if (old !== digest) throw new Error('conflicting event id');
      duplicate = true;
    }
  }
  return JSON.parse(JSON.stringify(duplicate ? events : [...events, event]));
}
