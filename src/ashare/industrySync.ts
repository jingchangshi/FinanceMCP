import type { DatabaseSync } from 'node:sqlite';
import { fetchAll, withSyncDb } from './fetch.js';
import { logSync, upsertRows } from './db.js';
import { ensureHotspotSchema } from './hotspotTables.js';
import {
  fetchSwClassifyFromLegulegu,
  fetchSwMembersFromLegulegu,
  fetchThsIndustryIndexFrom10jqka,
} from './providers/hotspotFreeClient.js';

/**
 * 热点行业同步层（V3 免费多源化）：
 * - 申万 2021 分类与最新成分（sw_classify / sw_member）：通过乐咕乐股免费公开页面同步，
 *   失败时 fail-closed 保留既有本地缓存并显式返回 `CATALOG_UNAVAILABLE`；
 * - 同花顺行业指数目录（ths_index idx_type='I'）：通过 10jqka 行业主页同步，保留既有个股数/概念行；
 * - 同花顺成分分页翻页受限于反爬鉴权（HTTP 401），诚实返回 `CATALOG_UNAVAILABLE` 并保留历史缓存；
 * - 指数日线（sw_daily / ths_daily）通过免费多源（hotspotFreeClient）同步。
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

function catalogUnavailable(db: DatabaseSync, dataset: string, reason = 'free_catalog_source_unavailable'): HotspotSyncResult {
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

const SW_CLASSIFY_COLUMNS = ['index_code', 'level', 'name', 'industry_code', 'parent_code', 'src', 'is_pub', 'collected_at'];
const SW_MEMBER_COLUMNS = ['ts_code', 'l1_code', 'l2_code', 'l3_code', 'l1_name', 'l2_name', 'l3_name', 'name', 'in_date', 'out_date', 'is_new', 'collected_at'];

/**
 * 申万 2021 分类目录（免费公开源 legulegu）；失败时保留既有缓存并显式返回 CATALOG_UNAVAILABLE。
 */
export async function syncSwClassify(
  db: DatabaseSync,
  opts: { src?: string; minL1?: number; minL2?: number; minL3?: number } = {},
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => {
    ensureHotspotSchema(db);
    try {
      const rows = await fetchSwClassifyFromLegulegu(opts);
      const n = upsertRows(db, 'sw_classify', SW_CLASSIFY_COLUMNS, rows);
      logSync(db, 'sw_classify', 'legulegu', n, cacheStatus(n), `SW2021 ${n} rows`,
        { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
      return ok('sw_classify', n);
    } catch (error: any) {
      return catalogUnavailable(db, 'sw_classify', String(error?.message ?? error));
    }
  });
}

/**
 * 申万 2021 成分（免费公开源 legulegu L3 成分表，按唯一主键增量合并并保留既有历史退市/转出档案）；
 * 拉取不足阈值或失败时保留既有缓存并返回 CATALOG_UNAVAILABLE。
 */
export async function syncSwMembers(
  db: DatabaseSync,
  opts: { concurrency?: number; timeoutMs?: number; minUniqueStocks?: number; maxFailureRatio?: number } = {},
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => {
    ensureHotspotSchema(db);
    const classifyRows = db.prepare(
      'SELECT index_code, level, name, parent_code FROM sw_classify ORDER BY level, index_code',
    ).all() as Array<{ index_code: string; level: string | null; name: string | null; parent_code: string | null }>;
    if (!classifyRows.some(r => r.level === 'L3')) {
      return catalogUnavailable(db, 'sw_member', 'no_sw_classify_l3_codes');
    }
    try {
      const rows = await fetchSwMembersFromLegulegu(classifyRows, opts);
      const n = upsertRows(db, 'sw_member', SW_MEMBER_COLUMNS, rows);
      logSync(db, 'sw_member', 'legulegu', n, cacheStatus(n), `SW2021 ${n} member rows`,
        { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: n });
      return ok('sw_member', n);
    } catch (error: any) {
      return catalogUnavailable(db, 'sw_member', String(error?.message ?? error));
    }
  });
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

/** THS 行业指数目录：通过 10jqka 行业主页免费刷新（`idx_type='I'`），保留既有概念/风格与 count/list_date。 */
export async function syncThsIndex(
  db: DatabaseSync,
  opts: { minCount?: number; timeoutMs?: number } | string[] = {},
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => {
    ensureHotspotSchema(db);
    const parsedOpts = Array.isArray(opts) ? {} : opts;
    try {
      const rows = await fetchThsIndustryIndexFrom10jqka(parsedOpts);
      const stmt = db.prepare(
        `INSERT INTO ths_index (ts_code, name, idx_type, exchange, collected_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ts_code) DO UPDATE SET
           name = excluded.name,
           idx_type = excluded.idx_type,
           exchange = COALESCE(NULLIF(ths_index.exchange, ''), excluded.exchange),
           collected_at = excluded.collected_at`,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of rows) {
          stmt.run(r.ts_code, r.name, r.idx_type, r.exchange, r.collected_at);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      logSync(db, 'ths_index', '10jqka_thshy', rows.length, cacheStatus(rows.length), `THS industry ${rows.length} rows`,
        { refresh_status: 'REFRESH_OK', write_mode: 'merged', after_rows: rows.length });
      return ok('ths_index', rows.length);
    } catch (error: any) {
      return catalogUnavailable(db, 'ths_index', String(error?.message ?? error));
    }
  });
}

/**
 * Top THS concept/industry codes by member count from local frozen catalog.
 * Ensures the hotspot schema first so a fresh database answers [].
 */
export function discoverThsCodes(db: DatabaseSync, limit = 30): string[] {
  ensureHotspotSchema(db);
  return (db.prepare(
    "SELECT ts_code FROM ths_index WHERE idx_type IN ('N','I') ORDER BY COALESCE(count, 0) DESC, ts_code LIMIT ?",
  ).all(limit) as Array<{ ts_code: string }>).map(r => r.ts_code);
}

/**
 * THS 概念/行业成分：同花顺第 2 页起需要前端鉴权（HTTP 401），不绕过权限控制，保留既有缓存并显式返回 CATALOG_UNAVAILABLE。
 */
export async function syncThsMembers(
  db: DatabaseSync,
  _opts: { codes: string[] },
): Promise<HotspotSyncResult> {
  return withSyncDb(db, async () => catalogUnavailable(db, 'ths_member', 'ths_member_pagination_gated_401_preserved_cache'));
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
