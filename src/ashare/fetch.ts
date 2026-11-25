import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { fetchFreeDataset } from './providers/freeProviderRouter.js';
import { resolveDataProviderMode } from './providers/types.js';

/**
 * Batch-oriented market-data access for the A-share daily pipeline.
 *
 * Uses the free multi-source router (TDX TCP + Tencent + Eastmoney) as the
 * sole upstream data path.
 */

const MAX_RETRIES = Number(process.env.ASHARE_FETCH_MAX_RETRIES ?? 4);

const syncDbContext = new AsyncLocalStorage<DatabaseSync>();

export function withSyncDb<T>(db: DatabaseSync, fn: () => Promise<T>): Promise<T> {
  if (syncDbContext.getStore() === db) return fn();
  return syncDbContext.run(db, fn);
}

export function currentSyncDb(): DatabaseSync | null {
  return syncDbContext.getStore() ?? null;
}

export const fetchStats = { calls: 0, retries: 0, rows: 0 };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isRateLimit(message: string): boolean {
  // "rate" 必须整词匹配：旧正则会把 "generate"/"accurate" 当成限流，白睡 61s 重试。
  return /每分钟|频次|频率|限流|调用次数|too many|rate[\s_-]?limit|\brate\b/i.test(message);
}

function isPermanent(message: string): boolean {
  // Missing permission or an invalid parameter will not succeed on retry.
  return /权限|积分|参数|token不对|无效|不存在|已退役移除/.test(message) && !isRateLimit(message);
}

function projectFields(rows: Record<string, any>[], fields?: string): { data: Record<string, any>[]; fields: string[] } {
  if (!fields) {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return { data: rows, fields: cols };
  }
  const cols = fields.split(',').map(s => s.trim()).filter(Boolean);
  const projected = rows.map(row => {
    const out: Record<string, any> = {};
    for (const col of cols) out[col] = row[col] ?? null;
    return out;
  });
  return { data: projected, fields: cols };
}

async function callOnce(api: string, params: Record<string, any>, fields?: string) {
  resolveDataProviderMode();
  fetchStats.calls++;
  const rawRows = await fetchFreeDataset(api, params, currentSyncDb());
  const offset = Number(params.offset ?? 0);
  const limit = params.limit != null ? Number(params.limit) : undefined;
  const sliced = offset > 0 || limit != null
    ? rawRows.slice(offset, limit != null ? offset + limit : undefined)
    : rawRows;
  return projectFields(sliced, fields);
}

export async function callWithRetry(api: string, params: Record<string, any>, fields?: string) {
  let attempt = 0;
  for (;;) {
    try {
      return await callOnce(api, params, fields);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (/未返回数据/.test(message)) return { data: [], fields: [] };
      if (attempt >= MAX_RETRIES || isPermanent(message)) throw error;
      attempt++;
      fetchStats.retries++;
      const delay = isRateLimit(message) ? 61_000 : 1500 * 2 ** (attempt - 1);
      console.warn(`[ashare] ${api} 第${attempt}次重试，${delay}ms 后重试: ${message.slice(0, 120)}`);
      await sleep(delay);
    }
  }
}

/**
 * Fetch a dataset query via the free multi-source router (returns complete batches).
 */
export async function fetchAll(
  api: string,
  params: Record<string, any>,
  fields?: string,
  _pageSize = 5000,
): Promise<Record<string, any>[]> {
  const page = await callWithRetry(api, params, fields);
  fetchStats.rows += page.data.length;
  return page.data;
}
