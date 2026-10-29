import type { DatabaseSync } from 'node:sqlite';
import { fetchAll } from './fetch.js';
import { logSync, upsertRows } from './db.js';
import { ensureHotspotSchema } from './hotspotTables.js';

/**
 * Tushare sync functions for the hotspot-industry layer (goal-1028,
 * architecture.md §4.1). Explicit-CLI-triggered only — never part of the
 * daily offline pipeline.
 *
 * Conventions (mirrors ingest.ts): every function ensures the hotspot schema
 * first, stamps rows with one ISO `collected_at`/`synced_at`, upserts through
 * `upsertRows`, ends with `logSync`, and returns `{dataset, rows, status}`.
 * `status` is 'OK' only for a real upstream answer — including an honestly
 * empty one (rows 0 when the API answered and returned nothing); request
 * errors are NOT caught here and propagate exactly as fetch.ts throws them.
 * Rate limiting is entirely fetch.ts's min-interval; no extra sleeps.
 *
 * Everything here needs network at call time; the offline test suite exercises
 * the pure modules (hotspotTables / industryClassification) instead.
 */
export interface HotspotSyncResult {
  dataset: string;
  rows: number;
  status: 'OK';
}

function ok(dataset: string, rows: number): HotspotSyncResult {
  return { dataset, rows, status: 'OK' };
}

/** logSync status vocabulary (stored cache state, same words as ingest.ts). */
const cacheStatus = (n: number) => (n > 0 ? 'ok' : 'empty');

// ---------------------------------------------------------------- Shenwan 2021

const SW_CLASSIFY_FIELDS = 'index_code,industry_name,level,industry_code,is_pub,parent_code,src';
const SW_CLASSIFY_COLUMNS = ['index_code', 'level', 'name', 'industry_code', 'parent_code', 'src', 'is_pub', 'collected_at'];

/**
 * 申万 2021 classification (L1 31 / L2 134 / L3 full set). L3 is one
 * paginated fetchAll — large but a single dataset, fetched like the others.
 */
export async function syncSwClassify(
  db: DatabaseSync,
  opts: { src?: string } = {},
): Promise<HotspotSyncResult> {
  const { src = 'SW2021' } = opts;
  ensureHotspotSchema(db);
  const collectedAt = new Date().toISOString();
  const rows: Record<string, any>[] = [];
  for (const level of ['L1', 'L2', 'L3']) {
    const page = await fetchAll('index_classify', { src, level }, SW_CLASSIFY_FIELDS);
    for (const r of page) {
      rows.push({
        index_code: r.index_code, level: r.level, name: r.industry_name,
        industry_code: r.industry_code, parent_code: r.parent_code,
        src: r.src, is_pub: r.is_pub, collected_at: collectedAt,
      });
    }
  }
  const n = upsertRows(db, 'sw_classify', SW_CLASSIFY_COLUMNS, rows);
  logSync(db, 'sw_classify', src, n, cacheStatus(n), `levels L1-L3 ${collectedAt}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('sw_classify', n);
}

const SW_MEMBER_FIELDS = 'l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,ts_code,name,in_date,out_date,is_new';
const SW_MEMBER_COLUMNS = ['ts_code', 'l1_code', 'l2_code', 'l3_code', 'l1_name', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'collected_at'];

/**
 * Whole-market point-in-time members in ONE call (~5922 rows). The upstream
 * `index_code` parameter is effectively ignored by `index_member_all` — the
 * probe verified the same 5922 rows for 801010.SI and 801016.SI — so a
 * placeholder is sent only to satisfy required-param validation; never filter
 * by it. Observed reality in the current response: `out_date` is always NULL
 * and `is_new` always 'Y'; both columns are still stored so the PIT filter
 * has real data to evaluate the day upstream starts filling them.
 * pageSize 6000 covers the whole market in a single page even if the API
 * ignores limit/offset (a short first page stops fetchAll immediately).
 */
export async function syncSwMembers(db: DatabaseSync): Promise<HotspotSyncResult> {
  ensureHotspotSchema(db);
  const collectedAt = new Date().toISOString();
  const fetched = await fetchAll(
    'index_member_all',
    { index_code: '801010.SI', is_as_js: '0' },
    SW_MEMBER_FIELDS,
    6000,
  );
  const rows = fetched.map(r => ({
    ts_code: r.ts_code, l1_code: r.l1_code, l2_code: r.l2_code, l3_code: r.l3_code,
    l1_name: r.l1_name, l2_name: r.l2_name, l3_name: r.l3_name, name: r.name,
    in_date: r.in_date, out_date: r.out_date, is_new: r.is_new,
    collected_at: collectedAt,
  }));
  const n = upsertRows(db, 'sw_member', SW_MEMBER_COLUMNS, rows);
  logSync(db, 'sw_member', 'all', n, cacheStatus(n), `index_member_all ${collectedAt}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('sw_member', n);
}

const SW_DAILY_FIELDS = 'ts_code,trade_date,open,low,high,close,change,pct_change,vol,amount,pe,pb,float_mv,total_mv';
const SW_DAILY_COLUMNS = ['ts_code', 'trade_date', 'open', 'low', 'high', 'close', 'change', 'pct_change', 'vol', 'amount', 'pe', 'pb', 'float_mv', 'total_mv', 'synced_at'];

/** Default: every L1 code currently in sw_classify (syncSwClassify first). */
function defaultSwCodes(db: DatabaseSync): string[] {
  return (db.prepare("SELECT index_code FROM sw_classify WHERE level = 'L1' ORDER BY index_code").all() as Array<{ index_code: string }>)
    .map(r => r.index_code);
}

/**
 * 申万指数日线 per index (default: all L1 codes from sw_classify). History
 * starts around 2013 — earlier ranges answer empty, which is a legitimate
 * rows-0 OK, not a failure.
 */
export async function syncSwIndexDaily(
  db: DatabaseSync,
  opts: { start: string; end: string; codes?: string[] },
): Promise<HotspotSyncResult> {
  const { start, end, codes } = opts;
  ensureHotspotSchema(db);
  const resolved = codes ?? defaultSwCodes(db);
  if (resolved.length === 0) {
    throw new Error('sw_index_daily: no index codes — run syncSwClassify first or pass codes');
  }
  const syncedAt = new Date().toISOString();
  const rows: Record<string, any>[] = [];
  for (const code of resolved) {
    const page = await fetchAll('sw_daily', { ts_code: code, start_date: start, end_date: end }, SW_DAILY_FIELDS);
    for (const r of page) rows.push({ ...r, synced_at: syncedAt });
  }
  const n = upsertRows(db, 'sw_index_daily', SW_DAILY_COLUMNS, rows);
  logSync(db, 'sw_index_daily', `${start}-${end}`, n, cacheStatus(n),
    `${resolved.length} indices ${start}-${end}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('sw_index_daily', n);
}

// ---------------------------------------------------------------- Tonghuashun

const THS_INDEX_FIELDS = 'ts_code,name,count,exchange,list_date,type';
const THS_INDEX_COLUMNS = ['ts_code', 'name', 'idx_type', 'count', 'exchange', 'list_date', 'collected_at'];

/** THS index directory per type (N concept / I industry / S event / ST style). */
export async function syncThsIndex(
  db: DatabaseSync,
  types: string[] = ['N', 'I', 'S', 'ST'],
): Promise<HotspotSyncResult> {
  ensureHotspotSchema(db);
  const collectedAt = new Date().toISOString();
  const rows: Record<string, any>[] = [];
  for (const type of types) {
    const page = await fetchAll('ths_index', { type }, THS_INDEX_FIELDS);
    for (const r of page) {
      rows.push({
        ts_code: r.ts_code, name: r.name, idx_type: r.type, count: r.count,
        exchange: r.exchange, list_date: r.list_date, collected_at: collectedAt,
      });
    }
  }
  const n = upsertRows(db, 'ths_index', THS_INDEX_COLUMNS, rows);
  logSync(db, 'ths_index', types.join(','), n, cacheStatus(n), `types ${types.join(',')} ${collectedAt}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('ths_index', n);
}

/**
 * Top THS concept/industry codes by member count — the default set for
 * members + index-daily sync. Ensures the hotspot schema first so a fresh
 * database answers [] instead of throwing "no such table: ths_index"
 * (first production run of goal-1028 died exactly there). Call it AFTER
 * syncThsIndex so a first run has the freshly synced catalog to rank.
 */
export function discoverThsCodes(db: DatabaseSync, limit = 30): string[] {
  ensureHotspotSchema(db);
  return (db.prepare(
    "SELECT ts_code FROM ths_index WHERE idx_type IN ('N','I') ORDER BY count DESC LIMIT ?",
  ).all(limit) as Array<{ ts_code: string }>).map(r => r.ts_code);
}

const THS_MEMBER_FIELDS = 'ts_code,con_code,con_name';
const THS_MEMBER_COLUMNS = ['ts_code', 'con_code', 'con_name', 'quality_status', 'collected_at'];

/**
 * THS constituents per index. `ths_member` has NO time columns upstream and
 * none here: the table records `quality_status = 'NO_POINT_IN_TIME'` as a
 * constant per row (architecture.md §2.2). Historical replay must never
 * backfill from it — current membership is for same-day theme labelling only.
 */
export async function syncThsMembers(
  db: DatabaseSync,
  opts: { codes: string[] },
): Promise<HotspotSyncResult> {
  const { codes } = opts;
  ensureHotspotSchema(db);
  if (codes.length === 0) throw new Error('ths_member: codes must not be empty');
  const collectedAt = new Date().toISOString();
  const rows: Record<string, any>[] = [];
  for (const code of codes) {
    const page = await fetchAll('ths_member', { ts_code: code }, THS_MEMBER_FIELDS);
    for (const r of page) {
      rows.push({
        ts_code: r.ts_code, con_code: r.con_code, con_name: r.con_name,
        quality_status: 'NO_POINT_IN_TIME', collected_at: collectedAt,
      });
    }
  }
  const n = upsertRows(db, 'ths_member', THS_MEMBER_COLUMNS, rows);
  logSync(db, 'ths_member', `codes:${codes.length}`, n, cacheStatus(n),
    `${codes.length} indices ${collectedAt}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('ths_member', n);
}

const THS_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,avg_price,change,pct_change,vol,turnover_rate';
const THS_DAILY_COLUMNS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'avg_price', 'change', 'pct_change', 'vol', 'turnover_rate', 'synced_at'];

/** THS index daily bars per index code over [start, end] (YYYYMMDD). */
export async function syncThsIndexDaily(
  db: DatabaseSync,
  opts: { start: string; end: string; codes: string[] },
): Promise<HotspotSyncResult> {
  const { start, end, codes } = opts;
  ensureHotspotSchema(db);
  if (codes.length === 0) throw new Error('ths_index_daily: codes must not be empty');
  const syncedAt = new Date().toISOString();
  const rows: Record<string, any>[] = [];
  for (const code of codes) {
    const page = await fetchAll('ths_daily', { ts_code: code, start_date: start, end_date: end }, THS_DAILY_FIELDS);
    for (const r of page) rows.push({ ...r, synced_at: syncedAt });
  }
  const n = upsertRows(db, 'ths_index_daily', THS_DAILY_COLUMNS, rows);
  logSync(db, 'ths_index_daily', `${start}-${end}`, n, cacheStatus(n),
    `${codes.length} indices ${start}-${end}`,
    { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
  return ok('ths_index_daily', n);
}
