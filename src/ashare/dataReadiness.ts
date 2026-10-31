import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkQuality, previousTradeDay, type QualityStatus } from './ingest.js';

/**
 * Data readiness and the data fingerprint that goes INTO the snapshot hash
 * (goal-1031 §2.6, spec: docs/goal-1031/SNAPSHOT_VERSIONING_AND_READINESS.md §3).
 *
 * Two separate questions, deliberately answered by two separate functions:
 *
 *   - `checkDataReadiness` — may we publish a snapshot for this day at all?
 *   - `dataState`           — what data did the published snapshot actually
 *                             read? The answer is hashed into `content_hash`
 *                             (basis v2), so "the data changed" and "the
 *                             formula changed" can never be confused again.
 *
 * Read-only: every statement here is a SELECT. The quality status is
 * RECOMPUTED from the stored bars, never read back from `quality_check` — that
 * table is rewritten in place (INSERT OR REPLACE) and therefore cannot answer
 * "was this day READY when the snapshot was taken?".
 * See docs/goal-1031/DATA_READINESS_AND_SCHEDULE.md §2.
 */

export const READINESS_VERSION = 'data-readiness-1.0.0';
export const FINGERPRINT_SCHEME = 'data-fingerprint-v1';

export interface DataFingerprint {
  scheme: string;
  as_of: string;
  bars: {
    daily: number;
    daily_basic: number;
    adj_factor: number;
    stk_limit: number;
    /** Rows present on the previous trading day; a same-day only bar cache shows up here. */
    prev_daily: number;
    /**
     * Securities listed per stock_basic. DISCLOSED, never gated on: a real day
     * always has a handful of names without a bar (2026-10-30: 5571 vs 5577).
     */
    listed: number;
    /** sha256 over `ts_code|close|vol` in ts_code order — value changes, not just counts. */
    digest: string;
  };
  financials: {
    table: string | null;
    /** Latest reporting periods with their row counts (2026-10-30: 20260930 6236 → 6678 at 21:12). */
    periods: Array<{ end_date: string; rows: number }>;
    digest: string | null;
  };
  quality: { status: QualityStatus; cache_status: QualityStatus };
}

export interface DataState {
  version: string;
  as_of: string;
  readiness: QualityStatus;
  readiness_reason: string | null;
  checks: {
    bars_present: boolean;
    quality_ready: boolean;
    financials_synced_today: boolean;
  };
  fingerprint: DataFingerprint;
  fingerprint_hash: string;
  /** Which entry implementation produced the entry view; null when the caller did not supply it. */
  entry_identity: { scheme: string; entry_hash: string } | null;
  /** Wall-clock observation time. EXCLUDED from every hash — two runs over the same data must agree. */
  checked_at: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

function countOn(db: DatabaseSync, table: string, date: string): number {
  if (!tableExists(db, table)) return 0;
  try {
    return Number((db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE trade_date = ?`).get(date) as { c: number }).c);
  } catch { return 0; }
}

/** Ordered bar digest: same day + same values ⇒ same hash, on any machine. */
function barDigest(db: DatabaseSync, asOf: string): string {
  if (!tableExists(db, 'daily')) return 'sha256:' + createHash('sha256').update('no-daily-table').digest('hex');
  const h = createHash('sha256');
  const rows = db.prepare('SELECT ts_code, close, vol FROM daily WHERE trade_date = ? ORDER BY ts_code').all(asOf) as Array<{
    ts_code: string; close: number | null; vol: number | null;
  }>;
  for (const r of rows) h.update(`${r.ts_code}|${r.close ?? ''}|${r.vol ?? ''}\n`);
  return `sha256:${h.digest('hex')}`;
}

function financialDigest(db: DatabaseSync): { table: string | null; periods: Array<{ end_date: string; rows: number }>; digest: string | null } {
  // Whole-table state, not as-of state: the 2026-10-30 18:42 vs 21:12 difference was
  // 442 financial rows arriving AFTER the 19:40 snapshot, and that difference must be
  // visible in the fingerprint even though `financialsAsOf` later filters by ann_date.
  for (const table of ['fina_indicator']) {
    if (!tableExists(db, table)) continue;
    let periods: Array<{ end_date: string; rows: number }> = [];
    try {
      periods = db.prepare(`SELECT end_date, COUNT(*) rows FROM ${table} GROUP BY end_date ORDER BY end_date DESC LIMIT 8`)
        .all() as Array<{ end_date: string; rows: number }>;
    } catch { periods = []; }
    const h = createHash('sha256');
    for (const p of periods) h.update(`${p.end_date}|${p.rows}\n`);
    return { table, periods, digest: `sha256:${h.digest('hex')}` };
  }
  return { table: null, periods: [], digest: null };
}

/** Start of the as-of day in Asia/Shanghai, as an ISO instant (UTC). */
function asOfDayStart(asOf: string): string {
  return new Date(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}T00:00:00+08:00`).toISOString();
}

function financialsSyncedToday(db: DatabaseSync, asOf: string): boolean {
  if (!tableExists(db, 'sync_history')) return false;
  const since = asOfDayStart(asOf);
  const row = db.prepare(
    "SELECT 1 FROM sync_history WHERE dataset = 'fina_indicator' AND status = 'ok' AND synced_at >= ? LIMIT 1"
  ).get(since);
  return !!row;
}

export interface ReadinessResult {
  status: QualityStatus;
  checks: DataState['checks'];
  reason: string | null;
}

/**
 * May a hotspot snapshot be published for this day?
 *
 * The gate blocks on the data the pipeline actually reads — the bar datasets
 * the pool is ranked from. Everything else the market quality report can
 * complain about (missing benchmark indices, a failed suspension refresh) is
 * DISCLOSED in `readiness` but does not block: the hotspot never reads those
 * series, and refusing to publish for them would stop the snapshot for a
 * reason it does not depend on. That distinction is deliberate and is written
 * down in docs/goal-1032, not left implicit.
 */
export function checkDataReadiness(db: DatabaseSync, asOf: string): ReadinessResult {
  const daily = countOn(db, 'daily', asOf);
  const bars_present = daily > 0;
  // Missing bars short-circuits: with no bars the quality check has nothing to
  // say, and on a database that has no trade_cal it would throw instead of
  // reporting the reason. No bars is already the strongest NOT_READY.
  if (!bars_present) {
    return {
      status: 'NOT_READY',
      checks: { bars_present, quality_ready: false, financials_synced_today: false },
      reason: `no daily bars for ${asOf}`,
    };
  }
  const quality = checkQuality(db, asOf, false);
  const quality_ready = quality.status === 'READY';
  const financials_synced_today = financialsSyncedToday(db, asOf);

  // The pool is ranked from these four datasets, and they are keyed per stock:
  // if one of them covers fewer names than `daily`, the ranking inputs are
  // partial even though the day exists. `listed` is deliberately NOT the
  // yardstick — on real production data it is 5577 while `daily` is 5571
  // (halts, new listings), so gating on it would refuse every real day.
  const counts = {
    daily, daily_basic: quality.counts.daily_basic ?? 0,
    adj_factor: quality.counts.adj_factor ?? 0, stk_limit: quality.counts.stk_limit ?? 0,
  };
  const short = Object.entries(counts).filter(([k, n]) => k !== 'daily' && n < daily).map(([k, n]) => `${k}=${n}`);
  if (short.length) {
    return {
      status: 'NOT_READY',
      checks: { bars_present, quality_ready, financials_synced_today },
      reason: `bar datasets incomplete for ${asOf} (daily=${daily}): ${short.join(', ')}`,
    };
  }

  const disclosed: string[] = [];
  if (quality.status !== 'READY') {
    disclosed.push(`market quality ${quality.status}: ${quality.reasons.slice(0, 3).join('; ') || 'see checkQuality'}`);
  }
  if (!financials_synced_today) disclosed.push('financials (fina_indicator) not synced on this trade date yet');
  if (disclosed.length) {
    return { status: 'DEGRADED', checks: { bars_present, quality_ready, financials_synced_today }, reason: disclosed.join('; ') };
  }
  return { status: 'READY', checks: { bars_present, quality_ready, financials_synced_today }, reason: null };
}

export function dataFingerprint(db: DatabaseSync, asOf: string): DataFingerprint {
  const quality = checkQuality(db, asOf, false);
  const prev = previousTradeDay(db, asOf) ?? null;
  return {
    scheme: FINGERPRINT_SCHEME,
    as_of: asOf,
    bars: {
      daily: countOn(db, 'daily', asOf),
      daily_basic: countOn(db, 'daily_basic', asOf),
      adj_factor: countOn(db, 'adj_factor', asOf),
      stk_limit: countOn(db, 'stk_limit', asOf),
      prev_daily: prev ? countOn(db, 'daily', prev) : 0,
      listed: quality.counts.listed ?? 0,
      digest: barDigest(db, asOf),
    },
    financials: financialDigest(db),
    quality: { status: quality.status, cache_status: quality.cache_status },
  };
}

/**
 * The hashed subset. `checked_at` is excluded on purpose: the fingerprint is a
 * statement about the data, not about when we looked at it.
 */
export function hashDataState(state: Pick<DataState, 'as_of' | 'fingerprint' | 'entry_identity'>): string {
  const body = JSON.stringify({
    scheme: FINGERPRINT_SCHEME,
    as_of: state.as_of,
    fingerprint: state.fingerprint,
    entry_identity: state.entry_identity,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function dataState(
  db: DatabaseSync,
  asOf: string,
  opts: { entryIdentity?: { scheme: string; entry_hash: string } | null } = {},
): DataState {
  const readiness = checkDataReadiness(db, asOf);
  const fingerprint = dataFingerprint(db, asOf);
  const entry_identity = opts.entryIdentity ?? null;
  return {
    version: READINESS_VERSION,
    as_of: asOf,
    readiness: readiness.status,
    readiness_reason: readiness.reason,
    checks: readiness.checks,
    fingerprint,
    fingerprint_hash: hashDataState({ as_of: asOf, fingerprint, entry_identity }),
    entry_identity,
    checked_at: new Date().toISOString(),
  };
}
