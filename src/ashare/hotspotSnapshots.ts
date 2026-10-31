import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ensureHotspotSchema, hotspotTableExists } from './hotspotTables.js';
import type { HotspotSnapshot, HotspotCandidate } from './hotspotTypes.js';

/**
 * Daily hotspot snapshot persistence (goal-1028 §P2.3 / architecture.md §5.3).
 * Snapshots are reproducible research records: same inputs ⇒ same
 * `content_hash`. Rows are written per (as_of, config_version); a regeneration
 * of the SAME day with the SAME config replaces the row (crash-retry
 * idempotence), it never mutates a different day's snapshot. This table is
 * part of the NEW research surface — existing watchlist history and formal
 * research logs are never touched here.
 */

/** Stable JSON: object keys sorted recursively so hashes do not drift. */
export function stableJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Content hash over the REPRODUCIBLE payload only: sectors + candidates +
 * counts + coverage + versions. `generated_at` is excluded deliberately —
 * two runs of the same day over the same data must hash identically.
 *
 * Two bases coexist (goal-1032):
 *   - `v1` — the original six-key formula. Kept byte-identical so every hash
 *            written before 2026-10-31 still verifies; it silently ignored
 *            `entry_view` and knew nothing about the input data.
 *   - `v2` — default whenever the body carries `data_state`. Adds the entry
 *            view and the data fingerprint, so a changed data state can no
 *            longer hide behind an unchanged hash.
 * `checked_at` inside `data_state` is excluded from the hashed subset (see
 * hashDataState): the fingerprint describes the data, not when we looked.
 */
export function snapshotContentHash(
  snapshot: Omit<HotspotSnapshot, 'content_hash' | 'generated_at'>,
  opts: { basis?: 'v1' | 'v2' } = {},
): string {
  const basis: 'v1' | 'v2' = opts.basis ?? (snapshot.data_state ? 'v2' : 'v1');
  const body: Record<string, unknown> = {
    as_of: snapshot.as_of,
    config_version: snapshot.config_version,
    strategy_set_version: snapshot.strategy_set_version,
    sectors: snapshot.sectors,
    candidates: snapshot.candidates,
    counts: snapshot.counts,
    coverage: snapshot.coverage,
  };
  if (basis === 'v2') {
    body.entry_view = snapshot.entry_view ?? null;
    const ds = snapshot.data_state;
    body.data_state = ds
      ? { version: ds.version, as_of: ds.as_of, fingerprint: ds.fingerprint, entry_identity: ds.entry_identity }
      : null;
  }
  return `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`;
}

export interface SaveResult {
  content_hash: string;
  candidates_written: number;
  replaced: boolean;
  /** Ledger position of the version this save produced (or matched). */
  version_no: number;
  state: 'INSERTED' | 'UNCHANGED' | 'PUBLISHED' | 'CORRECTION';
  superseded_version: number | null;
  hash_basis: 'v1' | 'v2';
}

export interface SaveOptions {
  basis?: 'v1' | 'v2';
  /** Explicit correction of a previously published version number. */
  correctionOf?: number;
}

interface VersionRow { version_no: number; content_hash: string; hash_basis: 'v1' | 'v2' }

/**
 * Persist a snapshot and append it to the version ledger.
 *
 * `hotspot_snapshot` keeps its "current pointer" meaning (same primary key,
 * same readers). Every distinct content is ALSO appended to
 * `hotspot_snapshot_version`, which is append-only and trigger-protected — a
 * regeneration can no longer destroy the previous version (goal-1031 D1).
 *
 * Rules (spec §2.2):
 *   1. no ledger row yet + no pointer      → version 1, INSERTED
 *   2. same hash AND same basis as latest  → UNCHANGED, zero writes
 *   3. different content                   → append next version; the previous
 *                                            row becomes SUPERSEDED
 */
export function saveHotspotSnapshot(db: DatabaseSync, snapshot: HotspotSnapshot, opts: SaveOptions = {}): SaveResult {
  ensureHotspotSchema(db);
  const hash_basis: 'v1' | 'v2' = opts.basis ?? (snapshot.data_state ? 'v2' : 'v1');
  // The hash is a function of the content, never of what the caller passed in:
  // recomputing here is what makes "same inputs ⇒ same hash" true by
  // construction, and what stops a v2 body from being stored under a v1 hash.
  // `content_hash` already on the object is overwritten on purpose.
  const content_hash = snapshotContentHash(snapshot, { basis: hash_basis });
  snapshot.content_hash = content_hash;

  const pointer = db.prepare('SELECT content_hash, version_no FROM hotspot_snapshot WHERE as_of = ? AND config_version = ?')
    .get(snapshot.as_of, snapshot.config_version) as { content_hash: string | null; version_no: number | null } | undefined;
  const last = db.prepare(`SELECT version_no, content_hash, hash_basis FROM hotspot_snapshot_version
    WHERE as_of = ? AND config_version = ? ORDER BY version_no DESC LIMIT 1`)
    .get(snapshot.as_of, snapshot.config_version) as VersionRow | undefined;

  if (!last && pointer && pointer.content_hash === content_hash && hash_basis === 'v1') {
    // Pre-ledger row that still matches byte for byte: nothing to record.
    return {
      content_hash, candidates_written: snapshot.candidates.length, replaced: true,
      version_no: pointer.version_no ?? 0, state: 'UNCHANGED', superseded_version: null, hash_basis,
    };
  }
  if (last && last.content_hash === content_hash && last.hash_basis === hash_basis) {
    return {
      content_hash, candidates_written: snapshot.candidates.length, replaced: true,
      version_no: last.version_no, state: 'UNCHANGED', superseded_version: null, hash_basis,
    };
  }

  const version_no = (last?.version_no ?? 0) + 1;
  const versioned: HotspotSnapshot = {
    ...snapshot,
    version_no,
    state: 'PUBLISHED',
  };
  const existed = !!pointer;
  db.exec('BEGIN');
  try {
    if (last) {
      // Only the lifecycle columns move; the frozen trigger aborts any attempt
      // to edit a payload, a hash or a key.
      db.prepare(`UPDATE hotspot_snapshot_version SET state = 'SUPERSEDED', superseded_by = ?
        WHERE as_of = ? AND config_version = ? AND version_no = ?`)
        .run(version_no, snapshot.as_of, snapshot.config_version, last.version_no);
    }
    db.prepare(`INSERT INTO hotspot_snapshot_version
      (as_of, config_version, version_no, content_hash, hash_basis, strategy_set_version, payload, coverage,
       generated_at, recorded_at, state, superseded_by, correction_of, readiness, data_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(snapshot.as_of, snapshot.config_version, version_no, content_hash, hash_basis,
        snapshot.strategy_set_version, stableJson(versioned), stableJson(snapshot.coverage),
        snapshot.generated_at, new Date().toISOString(),
        opts.correctionOf ? 'CORRECTION' : 'PUBLISHED', opts.correctionOf ?? null,
        snapshot.data_state?.readiness ?? null,
        snapshot.data_state ? stableJson(snapshot.data_state) : null);
    db.prepare(`INSERT OR REPLACE INTO hotspot_snapshot
      (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage, version_no, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED')`)
      .run(snapshot.as_of, snapshot.config_version, snapshot.strategy_set_version,
        stableJson(versioned), content_hash, snapshot.generated_at,
        stableJson(snapshot.coverage), version_no);
    // Candidates: replace this day's rows for THIS config only. Deleting by
    // as_of alone would wipe a second config_version's mirror (goal-1031 D2).
    db.prepare('DELETE FROM hotspot_candidate WHERE as_of = ? AND config_version = ?')
      .run(snapshot.as_of, snapshot.config_version);
    const ins = db.prepare(`INSERT INTO hotspot_candidate
      (as_of, ts_code, name, instrument_type, primary_sector, sectors, etf_sources, multi_etf,
       leaderships, signals, risk_events, trade_permission, trade_permission_reason, pool,
       inclusion_reason, exclusion_reason, priority, priority_reason, data_quality, config_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of snapshot.candidates) {
      ins.run(c.as_of, c.ts_code, c.name, c.instrument_type, c.primary_sector,
        stableJson(c.sectors), stableJson(c.etf_sources), c.multi_etf ? 1 : 0,
        stableJson(c.leaderships), stableJson(c.signals), stableJson(c.risk_events ?? []),
        c.trade_permission, c.trade_permission_reason, c.pool,
        c.inclusion_reason, c.exclusion_reason ?? null, c.priority, c.priority_reason,
        c.data_quality, snapshot.config_version);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    content_hash, candidates_written: snapshot.candidates.length, replaced: existed,
    version_no,
    state: opts.correctionOf ? 'CORRECTION' : (existed ? 'PUBLISHED' : 'INSERTED'),
    superseded_version: last?.version_no ?? null, hash_basis,
  };
}

/** One historical version, read by position. */
export function loadHotspotVersion(db: DatabaseSync, asOf: string, configVersion: string, versionNo: number): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot_version')) return null;
  const row = db.prepare('SELECT payload, version_no, state FROM hotspot_snapshot_version WHERE as_of = ? AND config_version = ? AND version_no = ?')
    .get(asOf, configVersion, versionNo) as { payload: string; version_no: number; state: 'PUBLISHED' | 'SUPERSEDED' | 'CORRECTION' } | undefined;
  return row ? stampPosition(JSON.parse(row.payload) as HotspotSnapshot, row.version_no, row.state) : null;
}

/** Whichever version carried this content hash (the hash is unique per (as_of, config)). */
export function loadHotspotVersionByHash(db: DatabaseSync, contentHash: string): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot_version')) return null;
  const row = db.prepare('SELECT payload, version_no, state FROM hotspot_snapshot_version WHERE content_hash = ? LIMIT 1')
    .get(contentHash) as { payload: string; version_no: number; state: 'PUBLISHED' | 'SUPERSEDED' | 'CORRECTION' } | undefined;
  return row ? stampPosition(JSON.parse(row.payload) as HotspotSnapshot, row.version_no, row.state) : null;
}

/** Ledger rows for a day, newest first — the audit view of "what did we ever publish". */
export function listHotspotVersions(db: DatabaseSync, asOf: string): Array<{
  config_version: string; version_no: number; content_hash: string; hash_basis: string;
  state: string; superseded_by: number | null; correction_of: number | null;
  readiness: string | null; generated_at: string; recorded_at: string;
}> {
  if (!hotspotTableExists(db, 'hotspot_snapshot_version')) return [];
  return db.prepare(`SELECT config_version, version_no, content_hash, hash_basis, state, superseded_by,
      correction_of, readiness, generated_at, recorded_at
    FROM hotspot_snapshot_version WHERE as_of = ? ORDER BY config_version, version_no DESC`).all(asOf) as any[];
}

export function loadHotspotSnapshot(db: DatabaseSync, asOf: string, configVersion?: string): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot')) return null;
  // The ledger columns arrive through ensureHotspotSchema's guarded ALTER. A
  // database read BEFORE that migration (an MCP server restarting ahead of the
  // first post-upgrade CLI run) must still serve its snapshots, so probe the
  // columns instead of naming them unconditionally: asking for a missing column
  // raises, and that error would have been reported as a broken snapshot rather
  // than as "this row predates the ledger".
  const columns = new Set((db.prepare('PRAGMA table_info(hotspot_snapshot)').all() as Array<{ name: string }>)
    .map(c => c.name));
  const pos = columns.has('version_no') && columns.has('state') ? ', version_no, state' : '';
  const sql = `SELECT payload${pos} FROM hotspot_snapshot WHERE as_of = ?`;
  const row = configVersion
    ? db.prepare(`${sql} AND config_version = ?`).get(asOf, configVersion)
    : db.prepare(`${sql} ORDER BY config_version DESC LIMIT 1`).get(asOf);
  if (!row) return null;
  const typed = row as { payload: string; version_no?: number | null; state?: HotspotSnapshot['state'] | null };
  return stampPosition(JSON.parse(typed.payload) as HotspotSnapshot, typed.version_no ?? null, typed.state ?? null);
}

/**
 * The payload never contains its own ledger position — the position lives in
 * the row that stores it. Readers get it stamped on, so "which version is this"
 * is answered by the table, not by whatever the writer happened to serialize.
 * A pointer row written before goal-1032 has version_no = null, which is the
 * honest answer: it predates the ledger.
 */
function stampPosition(snapshot: HotspotSnapshot, versionNo: number | null, state: HotspotSnapshot['state'] | null): HotspotSnapshot {
  if (versionNo !== null && versionNo !== undefined) snapshot.version_no = versionNo;
  if (state) snapshot.state = state;
  return snapshot;
}

/** Candidate rows for one as-of day (flattened from the relational mirror). */
export function loadHotspotCandidates(db: DatabaseSync, asOf: string, pool?: 'FOCUS' | 'RAW'): HotspotCandidate[] {
  if (!hotspotTableExists(db, 'hotspot_candidate')) return [];
  const snap = loadHotspotSnapshot(db, asOf);
  if (!snap) return [];
  return pool ? snap.candidates.filter(c => c.pool === pool) : snap.candidates;
}
