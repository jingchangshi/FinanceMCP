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
 */
export function snapshotContentHash(snapshot: Omit<HotspotSnapshot, 'content_hash' | 'generated_at'>): string {
  const body = stableJson({
    as_of: snapshot.as_of,
    config_version: snapshot.config_version,
    strategy_set_version: snapshot.strategy_set_version,
    sectors: snapshot.sectors,
    candidates: snapshot.candidates,
    counts: snapshot.counts,
    coverage: snapshot.coverage,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export interface SaveResult {
  content_hash: string;
  candidates_written: number;
  replaced: boolean;
}

/** Idempotently persist a snapshot + its candidate rows. */
export function saveHotspotSnapshot(db: DatabaseSync, snapshot: HotspotSnapshot): SaveResult {
  ensureHotspotSchema(db);
  const existed = !!(db.prepare('SELECT 1 FROM hotspot_snapshot WHERE as_of = ? AND config_version = ?')
    .get(snapshot.as_of, snapshot.config_version));
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT OR REPLACE INTO hotspot_snapshot
      (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.as_of, snapshot.config_version, snapshot.strategy_set_version,
        stableJson(snapshot), snapshot.content_hash, snapshot.generated_at,
        stableJson(snapshot.coverage));
    // Candidates: replace this day's rows wholesale so a regeneration cannot
    // leave orphans from a previous partial run.
    db.prepare('DELETE FROM hotspot_candidate WHERE as_of = ?').run(snapshot.as_of);
    const ins = db.prepare(`INSERT INTO hotspot_candidate
      (as_of, ts_code, name, instrument_type, primary_sector, sectors, etf_sources, multi_etf,
       leaderships, signals, trade_permission, trade_permission_reason, pool,
       inclusion_reason, exclusion_reason, priority, priority_reason, data_quality, config_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of snapshot.candidates) {
      ins.run(c.as_of, c.ts_code, c.name, c.instrument_type, c.primary_sector,
        stableJson(c.sectors), stableJson(c.etf_sources), c.multi_etf ? 1 : 0,
        stableJson(c.leaderships), stableJson(c.signals),
        c.trade_permission, c.trade_permission_reason, c.pool,
        c.inclusion_reason, c.exclusion_reason ?? null, c.priority, c.priority_reason,
        c.data_quality, snapshot.config_version);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { content_hash: snapshot.content_hash, candidates_written: snapshot.candidates.length, replaced: existed };
}

export function loadHotspotSnapshot(db: DatabaseSync, asOf: string, configVersion?: string): HotspotSnapshot | null {
  if (!hotspotTableExists(db, 'hotspot_snapshot')) return null;
  const row = configVersion
    ? db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ? AND config_version = ?').get(asOf, configVersion)
    : db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ? ORDER BY config_version DESC LIMIT 1').get(asOf);
  return row ? (JSON.parse((row as { payload: string }).payload) as HotspotSnapshot) : null;
}

/** Candidate rows for one as-of day (flattened from the relational mirror). */
export function loadHotspotCandidates(db: DatabaseSync, asOf: string, pool?: 'FOCUS' | 'RAW'): HotspotCandidate[] {
  if (!hotspotTableExists(db, 'hotspot_candidate')) return [];
  const snap = loadHotspotSnapshot(db, asOf);
  if (!snap) return [];
  return pool ? snap.candidates.filter(c => c.pool === pool) : snap.candidates;
}
