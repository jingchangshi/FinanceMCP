/**
 * `research-entry` command: the append-only entry-layer freeze (goal-1031 §2.1).
 *
 * Dispatch lives in `cli.ts`, which is not one of `IMPLEMENTATION_MODULES`, and
 * this file is not either — so registering or inspecting an entry freeze does
 * not change the signal `implementation_hash` and cannot break the 21:10
 * `research-validation observe` step.
 *
 *   research-entry freeze --source PATH --research-db PATH --start YYYYMMDD
 *   research-entry status --source PATH --research-db PATH [--as-of YYYYMMDD]
 *
 * `freeze` is an irreversible append to the production research DB: the row is
 * protected by no-update / no-delete / no-replace triggers, exactly like
 * `validation_freeze`. `status` is strictly read-only and never creates a table.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { shanghaiToday } from './ingest.js';
import { assertSeparateFromLive } from './snapshot.js';
import { implementationHash } from './validation.js';
import { entryIdentity } from './entryIdentity.js';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validDate = (d: string) => /^\d{8}$/.test(d)
  && new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).toISOString()
    .slice(0, 10).replace(/-/g, '') === d;

interface EntryFreezeProtocol {
  start: string;
  frozen_at: string;
  entry_scheme: string;
  entry_modules: string[];
  entry_rules_version: string;
  ranking_rules_version: string;
  signal_lifecycle_version: string;
  entry_hash: string;
  signal_implementation_hash: string;
  horizons: number[];
  note: string;
}

const NOTE = 'Entry-layer identity only. It states which entry implementation produced a view; '
  + 'it grants no promotion, no execution and no probability claim.';

function openEntryLedger(path: string, source: string) {
  assertSeparateFromLive(path, source);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS entry_freeze(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,protocol TEXT NOT NULL,recorded_at TEXT);
    CREATE TRIGGER IF NOT EXISTS entry_freeze_no_update BEFORE UPDATE ON entry_freeze BEGIN SELECT RAISE(ABORT,'immutable entry freeze'); END;
    CREATE TRIGGER IF NOT EXISTS entry_freeze_no_delete BEFORE DELETE ON entry_freeze BEGIN SELECT RAISE(ABORT,'immutable entry freeze'); END;
    CREATE TRIGGER IF NOT EXISTS entry_freeze_no_replace BEFORE INSERT ON entry_freeze
      WHEN EXISTS(SELECT 1 FROM entry_freeze WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable entry freeze duplicate'); END;`);
  return db;
}

function registerEntryFreeze(db: DatabaseSync, protocol: EntryFreezeProtocol) {
  if (!validDate(protocol.start)) throw new Error('Invalid freeze start');
  if (!Number.isFinite(Date.parse(protocol.frozen_at))) throw new Error('Invalid frozen_at');
  if (!protocol.horizons.length || protocol.horizons.some(h => !Number.isInteger(h) || h < 2)) throw new Error('Invalid horizons');
  if (![protocol.entry_hash, protocol.signal_implementation_hash].every(h => /^[a-f0-9]{64}$/.test(h))) {
    throw new Error('Invalid entry protocol hash');
  }
  const id = `EFRZ-${digest(protocol).slice(0, 24)}`;
  const exact = db.prepare('SELECT protocol,recorded_at FROM entry_freeze WHERE id=?')
    .get(id) as { protocol: string; recorded_at: string | null } | undefined;
  if (exact) {
    if (exact.protocol !== JSON.stringify(protocol)) throw new Error('Entry freeze identity mismatch');
    return { id, ...protocol, recorded_at: exact.recorded_at, status: 'FROZEN_RESEARCH_ONLY', evidence_level: 'UNVERIFIED' };
  }
  const recordedAt = new Date().toISOString();
  const actualDay = new Date(Date.parse(recordedAt) + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  if (protocol.start <= actualDay) throw new Error('Entry freeze start must be a future trading day; it cannot be backdated');
  if (Math.abs(Date.parse(protocol.frozen_at) - Date.parse(recordedAt)) > 60_000) {
    throw new Error('Entry freeze requires the actual recording time');
  }
  db.prepare('INSERT INTO entry_freeze(id,created_at,protocol,recorded_at) VALUES(?,?,?,?)')
    .run(id, protocol.frozen_at, JSON.stringify(protocol), recordedAt);
  return { id, ...protocol, recorded_at: recordedAt, status: 'FROZEN_RESEARCH_ONLY', evidence_level: 'UNVERIFIED' };
}

export async function runEntryCommand(args: string[]): Promise<Record<string, unknown>> {
  const command = args[0] ?? 'status';
  const arg = (key: string, fallback?: string) => {
    const i = args.indexOf(`--${key}`);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
    return args[i + 1];
  };
  const required = (key: string) => { const v = arg(key); if (!v) throw new Error(`--${key} required`); return v; };
  const source = resolve(required('source'));
  const researchPath = resolve(required('research-db'));
  assertSeparateFromLive(researchPath, source);

  const identity = entryIdentity();
  const signal = implementationHash();

  if (command === 'freeze') {
    const start = required('start');
    // The ledger compares `start` lexicographically against an 8-digit day, so a
    // dashed date would slip through the ordering check as "in the past" and
    // report the wrong reason. Reject the format first.
    if (!/^\d{8}$/.test(start)) throw new Error('Invalid freeze start: expected YYYYMMDD');
    if (start <= shanghaiToday()) throw new Error('Forward start must be after the actual freeze day');
    mkdirSync(resolve(researchPath, '..'), { recursive: true });
    const db = openEntryLedger(researchPath, source);
    try {
      const protocol: EntryFreezeProtocol = {
        start,
        frozen_at: new Date().toISOString(),
        entry_scheme: identity.entry_scheme,
        entry_modules: identity.entry_modules,
        entry_rules_version: identity.entry_rules_version,
        ranking_rules_version: identity.ranking_rules_version,
        signal_lifecycle_version: identity.signal_lifecycle_version,
        entry_hash: identity.entry_hash,
        signal_implementation_hash: signal,
        horizons: [5, 10, 20],
        note: NOTE,
      };
      return registerEntryFreeze(db, protocol);
    } finally { db.close(); }
  }

  if (command !== 'status') throw new Error(`Unknown research-entry command: ${command}`);
  // Read-only: an inspection must never create the ledger or write a row.
  if (!existsSync(researchPath)) {
    return { status: 'NO_ENTRY_FREEZE', reason: 'research database not found', current: identity };
  }
  const db = new DatabaseSync(researchPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entry_freeze'").get();
    if (!table) return { status: 'NO_ENTRY_FREEZE', reason: 'entry_freeze table does not exist', current: identity };
    const rows = db.prepare('SELECT id,protocol,recorded_at FROM entry_freeze ORDER BY recorded_at DESC,id DESC')
      .all() as { id: string; protocol: string; recorded_at: string | null }[];
    const asOf = arg('as-of');
    const listed = rows.map(row => {
      const p = JSON.parse(row.protocol) as EntryFreezeProtocol;
      const identityOk = `EFRZ-${digest(p).slice(0, 24)}` === row.id;
      const beforeStart = row.recorded_at !== null
        && Date.parse(row.recorded_at) < Date.parse(`${p.start.slice(0, 4)}-${p.start.slice(4, 6)}-${p.start.slice(6, 8)}T00:00:00+08:00`);
      return {
        id: row.id, start: p.start, recorded_at: row.recorded_at,
        identity_ok: identityOk,
        recorded_before_start: beforeStart,
        active: identityOk && beforeStart && (!asOf || p.start <= asOf),
        entry_rules_version: p.entry_rules_version,
        ranking_rules_version: p.ranking_rules_version,
        entry_hash_matches_current: p.entry_hash === identity.entry_hash,
        signal_implementation_matches_current: p.signal_implementation_hash === signal,
      };
    });
    return {
      status: listed.length === 0 ? 'NO_ENTRY_FREEZE' : 'OK',
      current: identity,
      current_signal_implementation_hash: signal,
      freezes: listed,
      note: 'entry_hash_matches_current=false means the build differs from the frozen entry implementation: '
        + 'a research run under this build is NOT covered by that freeze and must not be attributed to it.',
    };
  } finally { db.close(); }
}
