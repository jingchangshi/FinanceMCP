import type { DatabaseSync } from 'node:sqlite';
import { fetchAll, withSyncDb } from './fetch.js';
import { logSync, upsertRows } from './db.js';
import { ensureHotspotSchema } from './hotspotTables.js';

/**
 * 热点行业同步层（goal-1028 / V3 免费多源化）：
 * - 目录与成分（sw_classify / sw_member / ths_index / ths_member）原依赖 Tushare；
 *   Tushare 移除后这些函数不再联网或覆写既有的冻结本地表，而是显式返回
 *   `CATALOG_UNAVAILABLE` 并保留缓存；
 * - 指数日线（sw_daily / ths_daily）继续通过免费源（hotspotFreeClient）同步。
 */
export interface HotspotSyncResult {
  dataset: string;
  rows: number;
  status: 'OK' | 'CATALOG_UNAVAILABLE';
  cached_rows?: number;
  reason?: string;
}

function ok(dataset: string, rows: number): HotspotSyncResult {
  return { dataset, rows, status: 'OK' };
}

function catalogUnavailable(db: DatabaseSync, dataset: string, reason = 'tushare_removed_no_free_catalog_source'): HotspotSyncResult {
  ensureHotspotSchema(db);
  const cachedRows = Number((db.prepare(`SELECT COUNT(*) n FROM ${dataset}`).get() as any)?.n ?? 0);
  logSync(db, dataset, 'catalog_unavailable', 0, cachedRows > 0 ? 'ok' : 'empty',
    `CATALOG_UNAVAILABLE (${reason}): 保留冻结缓存 ${cachedRows} 行`,
    { refresh_status: 'REFRESH_FAILED', before_rows: cachedRows, after_rows: cachedRows, write_mode: 'none' });
  return { dataset, rows: 0, cached_rows: cachedRows, status: 'CATALOG_UNAVAILABLE', reason };
}

/** logSync status vocabulary (stored cache state, same words as ingest.ts). */
const cacheStatus = (n: number) => (n > 0 ? 'ok' : 'empty');

// ---------------------------------------------------------------- Shenwan 2021

/**
 * 申万 2021 分类目录：Tushare 移除后无在线免费全量目录源，保留本地冻结表并显式返回 CATALOG_UNAVAILABLE。
 */
export async function syncSwClassify(
  db: DatabaseSync,
  _opts: { src?: string } = {},
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => catalogUnavailable(db, 'sw_classify'));
}

/**
 * 申万 2021 成分：Tushare 移除后无在线免费 PIT 成分源，保留本地冻结表并显式返回 CATALOG_UNAVAILABLE。
 */
export async function syncSwMembers(db: DatabaseSync): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => catalogUnavailable(db, 'sw_member'));
}

const SW_DAILY_FIELDS = 'ts_code,trade_date,open,low,high,close,change,pct_change,vol,amount,pe,pb,float_mv,total_mv';
const SW_DAILY_COLUMNS = ['ts_code', 'trade_date', 'open', 'low', 'high', 'close', 'change', 'pct_change', 'vol', 'amount', 'pe', 'pb', 'float_mv', 'total_mv', 'synced_at'];

/** Default: every L1 code currently in sw_classify (syncSwClassify first). */
function defaultSwCodes(db: DatabaseSync): string[] {
  return (db.prepare("SELECT index_code FROM sw_classify WHERE level = 'L1' ORDER BY index_code").all() as Array<{ index_code: string }>)
    .map(r => r.index_code);
}

/**
 * 申万指数日线 per index (default: all L1 codes from sw_classify).
 * 若本地冻结目录尚无任何 L1 代码，返回 CATALOG_UNAVAILABLE 而不崩溃。
 */
export async function syncSwIndexDaily(
  db: DatabaseSync,
  opts: { start: string; end: string; codes?: string[] },
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => {
  const { start, end, codes } = opts;
  ensureHotspotSchema(db);
  const resolved = codes ?? defaultSwCodes(db);
  if (resolved.length === 0) {
    return catalogUnavailable(db, 'sw_index_daily', 'no_sw_classify_codes');
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
  });
}

// ---------------------------------------------------------------- Tonghuashun

/** THS 概念/行业目录：Tushare 移除后无在线免费目录源，保留本地冻结表并显式返回 CATALOG_UNAVAILABLE。 */
export async function syncThsIndex(
  db: DatabaseSync,
  _types: string[] = ['N', 'I', 'S', 'ST'],
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => catalogUnavailable(db, 'ths_index'));
}

/**
 * Top THS concept/industry codes by member count from local frozen catalog.
 * Ensures the hotspot schema first so a fresh database answers [].
 */
export function discoverThsCodes(db: DatabaseSync, limit = 30): string[] {
  ensureHotspotSchema(db);
  return (db.prepare(
    "SELECT ts_code FROM ths_index WHERE idx_type IN ('N','I') ORDER BY count DESC LIMIT ?",
  ).all(limit) as Array<{ ts_code: string }>).map(r => r.ts_code);
}

/**
 * THS 概念成分：Tushare 移除后无在线免费成分源，保留本地冻结表并显式返回 CATALOG_UNAVAILABLE。
 */
export async function syncThsMembers(
  db: DatabaseSync,
  _opts: { codes: string[] },
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => catalogUnavailable(db, 'ths_member'));
}

const THS_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,avg_price,change,pct_change,vol,turnover_rate';
const THS_DAILY_COLUMNS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'avg_price', 'change', 'pct_change', 'vol', 'turnover_rate', 'synced_at'];

/** THS 概念/行业指数日线：按代码走免费源同步，无代码时返回 CATALOG_UNAVAILABLE。 */
export async function syncThsIndexDaily(
  db: DatabaseSync,
  opts: { start: string; end: string; codes: string[] },
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => {
  const { start, end, codes } = opts;
  ensureHotspotSchema(db);
  if (codes.length === 0) {
    return catalogUnavailable(db, 'ths_index_daily', 'no_ths_index_codes');
  }
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
  });
}
