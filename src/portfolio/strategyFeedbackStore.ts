import type { DatabaseSync } from 'node:sqlite';
import { contentHash, validateEvent } from './strategyFeedback.js';

type Event = {
  event_id: string; event_type: string; release_hash: string; snapshot_hash: string;
  occurred_at: string; recorded_at: string;
  coverage: { universe_id: string; period_start: string; period_end: string };
  payload: Record<string, string>;
};
type Row = { event_id: string; event_json: string; content_hash: string };

/** Initialize an isolated append-only feedback log. */
export function initFeedbackStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_feedback_events (
    seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL, content_hash TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS strategy_feedback_no_replace BEFORE INSERT ON strategy_feedback_events
    WHEN EXISTS (SELECT 1 FROM strategy_feedback_events WHERE event_id = NEW.event_id OR seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'feedback events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_feedback_no_update BEFORE UPDATE ON strategy_feedback_events
    BEGIN SELECT RAISE(ABORT, 'feedback events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS strategy_feedback_no_delete BEFORE DELETE ON strategy_feedback_events
    BEGIN SELECT RAISE(ABORT, 'feedback events are append-only'); END;`);
}

function load(db: DatabaseSync): Event[] {
  const rows = db.prepare('SELECT event_id, event_json, content_hash FROM strategy_feedback_events ORDER BY seq').all() as Row[];
  const seen = new Map<string, Event>();
  for (const row of rows) {
    const event: Event = JSON.parse(row.event_json);
    if (contentHash(event) !== row.content_hash || event.event_id !== row.event_id || seen.has(event.event_id)) throw new Error('corrupt feedback store');
    checkReference(event, seen);
    seen.set(event.event_id, event);
  }
  return [...seen.values()];
}

function checkReference(event: Event, seen: Map<string, Event>): void {
  const spec: Record<string, [string, string | null]> = {
    DECISION: ['signal_event_id', 'SIGNAL_EVALUATED'],
    OUTCOME: ['decision_event_id', 'DECISION'],
    CORRECTION: ['corrects_event_id', null],
  };
  const ref = spec[event.event_type];
  if (!ref) return;
  const parent = seen.get(event.payload[ref[0]]);
  if (!parent || (ref[1] && parent.event_type !== ref[1])) throw new Error('invalid feedback reference');
  if (parent.release_hash !== event.release_hash || parent.snapshot_hash !== event.snapshot_hash ||
      parent.coverage.universe_id !== event.coverage.universe_id ||
      parent.coverage.period_start !== event.coverage.period_start || parent.coverage.period_end !== event.coverage.period_end)
    throw new Error('feedback reference scope mismatch');
  if (parent.occurred_at > event.occurred_at || parent.recorded_at > event.recorded_at) throw new Error('feedback reference temporal order');
}

/** Returns validated, detached events in insertion order. */
export function listFeedbackEvents(db: DatabaseSync): unknown[] { return load(db); }

/** Append a batch atomically. Identical event IDs are idempotent. */
export function appendFeedbackEvents(db: DatabaseSync, values: unknown[]): { inserted: number; duplicates: number } {
  if (!Array.isArray(values)) throw new Error('feedback batch must be an array');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = load(db);
    const seen = new Map(existing.map(event => [event.event_id, event]));
    let inserted = 0, duplicates = 0;
    const insert = db.prepare('INSERT INTO strategy_feedback_events (event_id, event_json, content_hash) VALUES (?, ?, ?)');
    for (const value of values) {
      validateEvent(value);
      const event = value as Event;
      const hash = contentHash(event);
      const prior = seen.get(event.event_id);
      if (prior) {
        if (contentHash(prior) !== hash) throw new Error('conflicting event id');
        duplicates++;
        continue;
      }
      checkReference(event, seen);
      const json = JSON.stringify(event);
      insert.run(event.event_id, json, hash);
      seen.set(event.event_id, JSON.parse(json));
      inserted++;
    }
    db.exec('COMMIT');
    return { inserted, duplicates };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
