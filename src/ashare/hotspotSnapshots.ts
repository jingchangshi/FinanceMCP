import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { ensureHotspotSchema, hotspotTableExists } from './hotspotTables.js';
import type { HotspotSnapshot } from './hotspotTypes.js';

/**
 * Daily research snapshot persistence (goal-1028 §P2.3, rebuilt for V2).
 *
 * A snapshot is the whole day's research identity:
 *
 *     as_of + version_no + content_hash + implementation_fingerprint
 *
 * Rules (unchanged, and what makes the identity checkable):
 *   - the same inputs under the same compiled V2 modules produce the same
 *     `content_hash`; `generated_at` and `checked_at` are excluded,
 *   - a regeneration of the same day with the same content is UNCHANGED and
 *     writes nothing,
 *   - different content appends a NEW version to the append-only ledger and
 *     supersedes the previous pointer; history is never rewritten.
 *
 * What this module no longer does: it does not write per-candidate rows. The
 * per-stock record lives once inside `technical_view.research_universe`; the
 * old `hotspot_candidate` mirror is left as read-only archive.
 */

/**
 * Ledger payload storage formats (goal-1106). `content_hash` is ALWAYS computed
 * over the uncompressed stableJson; the marker only records how the body is
 * stored. New ledger rows are gzip-compressed (~12× smaller, ~0.9s per row);
 * legacy rows remain plain JSON and are never rewritten.
 */
export const PAYLOAD_FORMAT_JSON = 'json';
export const PAYLOAD_FORMAT_GZIP = 'gzip+json';

/** Compress a ledger body for storage. Returns the storable value + marker. */
export function encodeLedgerPayload(json: string): { payload: string | Uint8Array; payload_format: string } {
  return { payload: gzipSync(Buffer.from(json, 'utf8'), { level: 6 }), payload_format: PAYLOAD_FORMAT_GZIP };
}

/** Decode and parse a ledger body, honouring its storage marker. */
export function decodeLedgerPayload(payload: string | Uint8Array, format: string | null | undefined): HotspotSnapshot {
  const json = payload instanceof Uint8Array || format === PAYLOAD_FORMAT_GZIP
    ? gunzipSync(payload as Uint8Array).toString('utf8')
    : payload as string;
  return JSON.parse(json) as HotspotSnapshot;
}

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

export const SNAPSHOT_HASH_BASIS = 'v3' as const;

/**
 * Content hash over the reproducible payload only.
 *
 * Basis v3 (this rebuild) hashes: the as-of day, the framework identity
 * (`V2_ONLY` + framework version + compiled-module fingerprint), the config
 * version, the sector evaluation, the technical view (which contains the
 * per-stock research states), the coverage and the hashed data fingerprint.
 * `generated_at` / `checked_at` are excluded: two runs over the same data must
 * agree, and a regeneration that only changed wall-clock time is not a new
 * version.
 */
export function snapshotContentHash(
  snapshot: Omit<HotspotSnapshot, 'content_hash' | 'generated_at'>,
): string {
  const ds = snapshot.data_state;
  const body = {
    basis: SNAPSHOT_HASH_BASIS,
    as_of: snapshot.as_of,
    framework: snapshot.framework,
    framework_version: snapshot.framework_version,
    implementation_fingerprint: snapshot.implementation_fingerprint,
    config_version: snapshot.config_version,
    sectors: snapshot.sectors,
    technical_view: snapshot.technical_view,
    coverage: snapshot.coverage,
    data_state: ds ? { version: ds.version, as_of: ds.as_of, fingerprint: ds.fingerprint } : null,
  };
  return `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`;
}

export interface SaveResult {
  content_hash: string;
  replaced: boolean;
  /** Ledger position of the version this save produced (or matched). */
  version_no: number;
  state: 'INSERTED' | 'UNCHANGED' | 'PUBLISHED' | 'CORRECTION';
  superseded_version: number | null;
  hash_basis: string;
}

export interface SaveOptions {
  /** Explicit correction of a previously published version number. */
  correctionOf?: number;
}

interface VersionRow { version_no: number; content_hash: string; hash_basis: string }

/**
 * Persist a snapshot and append it to the version ledger.
 *
 * `hotspot_snapshot` keeps its "current pointer" meaning (same primary key,
 * same readers). Every distinct content is ALSO appended to
 * `hotspot_snapshot_version`, which is append-only and trigger-protected — a
 * regeneration can no longer destroy the previous version (goal-1031 D1).
 */
export function saveHotspotSnapshot(db: DatabaseSync, snapshot: HotspotSnapshot, opts: SaveOptions = {}): SaveResult {
  ensureHotspotSchema(db);
  const hash_basis = SNAPSHOT_HASH_BASIS;
  // The hash is a function of the content, never of what the caller passed in:
  // recomputing here is what makes "same inputs ⇒ same hash" true by construction.
  const content_hash = snapshotContentHash(snapshot);
  snapshot.content_hash = content_hash;

  const pointer = db.prepare('SELECT content_hash, version_no FROM hotspot_snapshot WHERE as_of = ? AND config_version = ?')
    .get(snapshot.as_of, snapshot.config_version) as { content_hash: string | null; version_no: number | null } | undefined;
  const last = db.prepare(`SELECT version_no, content_hash, hash_basis FROM hotspot_snapshot_version
    WHERE as_of = ? AND config_version = ? ORDER BY version_no DESC LIMIT 1`)
    .get(snapshot.as_of, snapshot.config_version) as VersionRow | undefined;

  if (last && last.content_hash === content_hash && last.hash_basis === hash_basis) {
    return {
      content_hash, replaced: true,
      version_no: last.version_no, state: 'UNCHANGED', superseded_version: null, hash_basis,
    };
  }
  if (!last && pointer && pointer.content_hash === content_hash) {
    return {
      content_hash, replaced: true,
      version_no: pointer.version_no ?? 0, state: 'UNCHANGED', superseded_version: null, hash_basis,
    };
  }

  const version_no = (last?.version_no ?? 0) + 1;
  const versioned: HotspotSnapshot = { ...snapshot, version_no, state: 'PUBLISHED' };
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
    // `strategy_set_version` is a legacy column name kept for schema
    // compatibility; it now carries the technical framework version that
    // actually produced the view.
    // The ledger stores the gzipped body under payload_format='gzip+json'
    // (hash stays over the UNCOMPRESSED stableJson). The pointer row stores
    // no payload at all — resolution goes through the ledger by content_hash.
    const encoded = encodeLedgerPayload(stableJson(versioned));
    db.prepare(`INSERT INTO hotspot_snapshot_version
      (as_of, config_version, version_no, content_hash, hash_basis, strategy_set_version,
       payload, payload_format, coverage,
       generated_at, recorded_at, state, superseded_by, correction_of, readiness, data_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(snapshot.as_of, snapshot.config_version, version_no, content_hash, hash_basis,
        snapshot.framework_version, encoded.payload, encoded.payload_format, stableJson(snapshot.coverage),
        snapshot.generated_at, new Date().toISOString(),
        opts.correctionOf ? 'CORRECTION' : 'PUBLISHED', opts.correctionOf ?? null,
        snapshot.data_state.readiness,
        stableJson(snapshot.data_state));
    db.prepare(`INSERT OR REPLACE INTO hotspot_snapshot
      (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage, version_no, state)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'PUBLISHED')`)
      .run(snapshot.as_of, snapshot.config_version, snapshot.framework_version,
        content_hash, snapshot.generated_at,
        stableJson(snapshot.coverage), version_no);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    content_hash, replaced: existed,
    version_no,
    state: opts.correctionOf ? 'CORRECTION' : (existed ? 'PUBLISHED' : 'INSERTED'),
    superseded_version: last?.version_no ?? null, hash_basis,
  };
}

/** Whether the ledger carries the payload_format marker (older tables predate it). */
function ledgerHasPayloadFormat(db: DatabaseSync): boolean {
  return (db.prepare('PRAGMA table_info(hotspot_snapshot_version)').all() as Array<{ name: string }>)
    .some(c => c.name === 'payload_format');
}

/** One historical version, read by position. */
export function loadHotspotVersion(db: DatabaseSync, asOf: string, configVersion: string, versionNo: number): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot_version')) return null;
  const fmt = ledgerHasPayloadFormat(db) ? ', payload_format' : '';
  const row = db.prepare(`SELECT payload${fmt}, version_no, state FROM hotspot_snapshot_version WHERE as_of = ? AND config_version = ? AND version_no = ?`)
    .get(asOf, configVersion, versionNo) as { payload: string | Uint8Array; payload_format?: string | null; version_no: number; state: 'PUBLISHED' | 'SUPERSEDED' | 'CORRECTION' } | undefined;
  return row ? stampPosition(decodeLedgerPayload(row.payload, row.payload_format ?? PAYLOAD_FORMAT_JSON), row.version_no, row.state) : null;
}

/** Whichever version carried this content hash (the hash is unique per (as_of, config)). */
export function loadHotspotVersionByHash(db: DatabaseSync, contentHash: string): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot_version')) return null;
  const fmt = ledgerHasPayloadFormat(db) ? ', payload_format' : '';
  const row = db.prepare(`SELECT payload${fmt}, version_no, state FROM hotspot_snapshot_version WHERE content_hash = ? LIMIT 1`)
    .get(contentHash) as { payload: string | Uint8Array; payload_format?: string | null; version_no: number; state: 'PUBLISHED' | 'SUPERSEDED' | 'CORRECTION' } | undefined;
  return row ? stampPosition(decodeLedgerPayload(row.payload, row.payload_format ?? PAYLOAD_FORMAT_JSON), row.version_no, row.state) : null;
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

/**
 * The current pointer for a day. A pre-V2 row is still returned as parsed JSON
 * — callers MUST check `framework === 'V2_ONLY'` and report an older row as
 * archive rather than pretending it is a current research view.
 */
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
  const sql = `SELECT payload, content_hash${pos} FROM hotspot_snapshot WHERE as_of = ?`;
  const row = configVersion
    ? db.prepare(`${sql} AND config_version = ?`).get(asOf, configVersion)
    : db.prepare(`${sql} ORDER BY config_version DESC LIMIT 1`).get(asOf);
  if (!row) return null;
  const typed = row as { payload: string | Uint8Array | null; content_hash?: string | null; version_no?: number | null; state?: HotspotSnapshot['state'] | null };
  // Legacy pointer rows still carry their payload inline; new pointer rows
  // store no payload (goal-1106) — resolve the body from the ledger instead.
  if (typed.payload !== null && typed.payload !== undefined && typed.payload !== '') {
    return stampPosition(JSON.parse(typed.payload as string) as HotspotSnapshot, typed.version_no ?? null, typed.state ?? null);
  }
  if (typed.content_hash) {
    const fromLedger = loadHotspotVersionByHash(db, typed.content_hash);
    if (fromLedger) {
      // Re-stamp from the pointer row so its own position metadata wins.
      if (typed.version_no !== null && typed.version_no !== undefined) fromLedger.version_no = typed.version_no;
      if (typed.state) fromLedger.state = typed.state;
      return fromLedger;
    }
  }
  // No hash on the pointer (very old row): fall back to the latest ledger
  // version for the same day rather than fabricating a body.
  if (hotspotTableExists(db, 'hotspot_snapshot_version')) {
    const fmt = ledgerHasPayloadFormat(db) ? ', payload_format' : '';
    const stmt = db.prepare(configVersion
      ? `SELECT payload${fmt}, version_no, state FROM hotspot_snapshot_version WHERE as_of = ? AND config_version = ? ORDER BY version_no DESC LIMIT 1`
      : `SELECT payload${fmt}, version_no, state FROM hotspot_snapshot_version WHERE as_of = ? ORDER BY config_version DESC, version_no DESC LIMIT 1`);
    const raw = configVersion ? stmt.get(asOf, configVersion) : stmt.get(asOf);
    const latest = raw as { payload: string | Uint8Array; payload_format?: string | null; version_no: number; state: HotspotSnapshot['state'] } | undefined;
    if (latest) return stampPosition(decodeLedgerPayload(latest.payload, latest.payload_format ?? PAYLOAD_FORMAT_JSON), latest.version_no, latest.state);
  }
  return null;
}

/**
 * True only for the V2 research shape this release writes and reads. The input
 * is typed `unknown` on purpose: archived rows parse into this module without
 * the V2 keys, so this is a runtime check, not a compile-time narrowing.
 */
export function isCurrentSnapshot(snapshot: unknown): boolean {
  const s = snapshot as Partial<HotspotSnapshot> | null | undefined;
  return !!s && s.framework === 'V2_ONLY' && !!s.technical_view;
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
