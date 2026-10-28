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
  payload TEXT NOT NULL,
  content_hash TEXT,
  generated_at TEXT NOT NULL,
  coverage TEXT,
  PRIMARY KEY (as_of, config_version)
);
CREATE TABLE IF NOT EXISTS hotspot_candidate (
  as_of TEXT NOT NULL,
  ts_code TEXT NOT NULL,
  name TEXT, instrument_type TEXT,
  primary_sector TEXT, sectors TEXT,
  etf_sources TEXT, multi_etf INTEGER,
  leaderships TEXT, signals TEXT,
  trade_permission TEXT, trade_permission_reason TEXT,
  pool TEXT, inclusion_reason TEXT, exclusion_reason TEXT,
  priority INTEGER, priority_reason TEXT,
  data_quality TEXT, config_version TEXT,
  PRIMARY KEY (as_of, ts_code)
);
CREATE INDEX IF NOT EXISTS hotspot_candidate_ts ON hotspot_candidate(ts_code);
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
  'hotspot_candidate',
] as const;

/** Idempotent: safe to call at the top of every sync and every read path. */
export function ensureHotspotSchema(db: DatabaseSync): void {
  db.exec(HOTSPOT_SCHEMA);
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
