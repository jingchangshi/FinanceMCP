import type { DatabaseSync } from 'node:sqlite';
import type { CoverageSummary } from './hotspotTypes.js';

/**
 * Additive schema for the hotspot-industry data layer (goal-1028,
 * architecture.md §4.1). Same conventions as db.ts: snake_case columns,
 * composite PRIMARY KEY + WITHOUT ROWID for bar/member tables, and
 * `CREATE TABLE IF NOT EXISTS` only — `openAshareDb` never sees this DDL, so
 * every hotspot module calls `ensureHotspotSchema(db)` before touching its
 * tables. Nothing here alters an existing production table.
 *
 * `etf_weight_snapshot` is deliberately absent: another module owns it.
 */
export const HOTSPOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS sw_classify (
  index_code TEXT PRIMARY KEY,
  level TEXT, name TEXT, industry_code TEXT, parent_code TEXT,
  src TEXT, is_pub TEXT,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sw_classify_level ON sw_classify(level);
CREATE TABLE IF NOT EXISTS sw_member (
  ts_code TEXT NOT NULL,
  l1_code TEXT NOT NULL, l2_code TEXT NOT NULL, l3_code TEXT NOT NULL,
  l1_name TEXT, l2_name TEXT, l3_name TEXT,
  name TEXT, in_date TEXT, out_date TEXT, is_new TEXT,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (ts_code, l1_code, l2_code, l3_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sw_member_in_date ON sw_member(in_date);
CREATE INDEX IF NOT EXISTS sw_member_l1 ON sw_member(l1_code);
CREATE TABLE IF NOT EXISTS sw_index_daily (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
  open REAL, low REAL, high REAL, close REAL,
  change REAL, pct_change REAL, vol REAL, amount REAL,
  pe REAL, pb REAL, float_mv REAL, total_mv REAL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ths_index (
  ts_code TEXT PRIMARY KEY,
  name TEXT, idx_type TEXT, count INTEGER, exchange TEXT, list_date TEXT,
  collected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ths_member (
  ts_code TEXT NOT NULL, con_code TEXT NOT NULL,
  con_name TEXT,
  quality_status TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (ts_code, con_code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ths_index_daily (
  ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, pre_close REAL, avg_price REAL,
  change REAL, pct_change REAL, vol REAL, turnover_rate REAL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (ts_code, trade_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hotspot_snapshot (
  as_of TEXT NOT NULL,
  config_version TEXT NOT NULL,
  strategy_set_version TEXT,
  payload TEXT,
  content_hash TEXT,
  generated_at TEXT NOT NULL,
  coverage TEXT,
  PRIMARY KEY (as_of, config_version)
);
-- The V1 'hotspot_candidate' mirror (priority / pool / inclusion_reason) is gone
-- from the active schema: V2 keeps one record per stock inside
-- technical_view.research_universe and never writes per-candidate rows. Existing
-- production tables still hold their V1 rows; they are left untouched as archive
-- and are no longer created, written, or reported as a data source.
-- goal-1032 §2.1: append-only history of every content that was ever published
-- for a day. The hotspot_snapshot table above stays the CURRENT POINTER
-- (unchanged primary key, unchanged readers); this table survives regeneration.
CREATE TABLE IF NOT EXISTS hotspot_snapshot_version (
  as_of TEXT NOT NULL,
  config_version TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  hash_basis TEXT NOT NULL DEFAULT 'v2',
  strategy_set_version TEXT,
  payload TEXT NOT NULL,
  payload_format TEXT NOT NULL DEFAULT 'json',
  coverage TEXT,
  generated_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PUBLISHED','SUPERSEDED','CORRECTION')),
  superseded_by INTEGER,
  correction_of INTEGER,
  readiness TEXT,
  data_state TEXT,
  first_cited_by TEXT,
  first_cited_at TEXT,
  PRIMARY KEY (as_of, config_version, version_no),
  UNIQUE (as_of, config_version, content_hash)
);
CREATE INDEX IF NOT EXISTS hotspot_snapshot_version_hash ON hotspot_snapshot_version(content_hash);
CREATE TRIGGER IF NOT EXISTS hotspot_snapshot_version_frozen BEFORE UPDATE ON hotspot_snapshot_version
WHEN NEW.payload IS NOT OLD.payload OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.as_of IS NOT OLD.as_of OR NEW.config_version IS NOT OLD.config_version
  OR NEW.version_no IS NOT OLD.version_no
BEGIN SELECT RAISE(ABORT,'hotspot_snapshot_version payload is immutable'); END;
CREATE TRIGGER IF NOT EXISTS hotspot_snapshot_version_no_delete BEFORE DELETE ON hotspot_snapshot_version
BEGIN SELECT RAISE(ABORT,'hotspot_snapshot_version is append-only'); END;
`;

/** Every table HOTSPOT_SCHEMA creates, in doc order. */
export const HOTSPOT_TABLES = [
  'sw_classify',
  'sw_member',
  'sw_index_daily',
  'ths_index',
  'ths_member',
  'ths_index_daily',
  'hotspot_snapshot',
  // NOTE: hotspot_snapshot_version is deliberately NOT listed here. This array
  // is the SOURCE-dataset catalogue that hotspotCoverage reports on; the ledger
  // is an output of the pipeline, not an input, and listing it would make the
  // coverage block claim a data source that never existed.
] as const;

/** Idempotent: safe to call at the top of every sync and every read path. */
export function ensureHotspotSchema(db: DatabaseSync): void {
  db.exec(HOTSPOT_SCHEMA);
  // goal-1106: new pointer rows carry NO payload (the full ~90MB body lives
  // only in the append-only ledger). Existing tables were created with
  // `payload TEXT NOT NULL`, and SQLite cannot drop NOT NULL without a
  // rebuild. The rebuild below is data-preserving (rename → create nullable
  // → copy all columns → drop the old copy), following the migrateAshareDb
  // precedent in db.ts; it fires once per database, only when the old
  // definition still says NOT NULL.
  const pointerDef = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hotspot_snapshot'")
    .get() as { sql?: string | null } | undefined;
  if (pointerDef?.sql && /payload\s+TEXT\s+NOT\s+NULL/i.test(pointerDef.sql)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE hotspot_snapshot RENAME TO hotspot_snapshot_legacy');
      const newCols = ['as_of', 'config_version', 'strategy_set_version', 'payload', 'content_hash', 'generated_at', 'coverage', 'version_no', 'state'];
      db.exec(`CREATE TABLE hotspot_snapshot (
        as_of TEXT NOT NULL, config_version TEXT NOT NULL, strategy_set_version TEXT,
        payload TEXT, content_hash TEXT, generated_at TEXT NOT NULL, coverage TEXT,
        version_no INTEGER, state TEXT, PRIMARY KEY (as_of, config_version))`);
      const legacyCols = new Set((db.prepare('PRAGMA table_info(hotspot_snapshot_legacy)').all() as Array<{ name: string }>).map(c => c.name));
      const common = newCols.filter(c => legacyCols.has(c));
      db.exec(`INSERT INTO hotspot_snapshot (${common.join(', ')}) SELECT ${common.join(', ')} FROM hotspot_snapshot_legacy`);
      db.exec('DROP TABLE hotspot_snapshot_legacy');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  // goal-1032: the pointer row gains the ledger position it points at. Guarded
  // by table_info — CREATE IF NOT EXISTS cannot add columns to an existing
  // table, and production already has a hotspot_snapshot.
  const snapCols = new Set((db.prepare('PRAGMA table_info(hotspot_snapshot)').all() as Array<{ name: string }>).map(c => c.name));
  if (!snapCols.has('version_no')) db.exec('ALTER TABLE hotspot_snapshot ADD COLUMN version_no INTEGER');
  if (!snapCols.has('state')) db.exec('ALTER TABLE hotspot_snapshot ADD COLUMN state TEXT');
  // goal-1106: ledger payload compression marker. 'json' is the legacy
  // uncompressed format; new rows are 'gzip+json'. Existing rows read as
  // 'json' (column default) and are never rewritten.
  const ledgerCols = new Set((db.prepare('PRAGMA table_info(hotspot_snapshot_version)').all() as Array<{ name: string }>).map(c => c.name));
  if (!ledgerCols.has('payload_format')) db.exec("ALTER TABLE hotspot_snapshot_version ADD COLUMN payload_format TEXT NOT NULL DEFAULT 'json'");
}

export function hotspotTableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Row counts per hotspot table with an honest quality mark:
 * absent table → UNAVAILABLE/table_missing; present but empty →
 * DEGRADED/no_rows; `ths_member` with rows is always NO_POINT_IN_TIME
 * (architecture.md §2.2: no publication time, never backfilled into history).
 * When `asOf` is given, tables that carry `as_of` are counted as of that date
 * (rows with as_of <= asOf); raw upstream tables have no as_of and are counted
 * in full.
 */
export function hotspotCoverage(db: DatabaseSync, asOf?: string): CoverageSummary[] {
  const out: CoverageSummary[] = [];
  for (const dataset of HOTSPOT_TABLES) {
    if (!hotspotTableExists(db, dataset)) {
      out.push({ dataset, rows: 0, quality: 'UNAVAILABLE', reason: 'table_missing' });
      continue;
    }
    const hasAsOf = (db.prepare(`PRAGMA table_info(${dataset})`).all() as Array<{ name: string }>)
      .some(c => c.name === 'as_of');
    const sql = hasAsOf && asOf
      ? `SELECT COUNT(*) n FROM ${dataset} WHERE as_of <= ?`
      : `SELECT COUNT(*) n FROM ${dataset}`;
    const rows = (hasAsOf && asOf ? db.prepare(sql).get(asOf) : db.prepare(sql).get()) as { n: number };
    if (dataset === 'ths_member' && rows.n > 0) {
      out.push({ dataset, rows: rows.n, quality: 'NO_POINT_IN_TIME', reason: 'no_point_in_time' });
    } else if (rows.n > 0) {
      out.push({ dataset, rows: rows.n, quality: 'OK' });
    } else {
      out.push({ dataset, rows: 0, quality: 'DEGRADED', reason: 'no_rows' });
    }
  }
  return out;
}
