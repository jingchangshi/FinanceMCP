import type { DatabaseSync } from 'node:sqlite';
import { inTransaction, logSync } from './db.js';
import { roundTo } from './providers/types.js';

export interface XdxrDividendEvent {
  ts_code?: string;
  ex_date?: string;
  date?: string;
  category: number;
  /** Cash dividend per 10 shares (RMB) */
  fenhong?: number | null;
  /** Rights issue price (RMB/share) */
  peigujia?: number | null;
  /** Bonus + transfer shares per 10 shares */
  songzhuangu?: number | null;
  /** Rights issue shares per 10 shares */
  peigu?: number | null;
  /** Share contraction/expansion factor (category 11/12) */
  suogu?: number | null;
}

export function addYmdDays(ymd: string, delta: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function normalizeExDate(event: XdxrDividendEvent): string | null {
  const raw = event.ex_date ?? event.date;
  return typeof raw === 'string' && /^\d{8}$/.test(raw) ? raw : null;
}

function nonNegFinite(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pure Point-in-Time TTM dividend yield (`dv_ttm`, unit `%`, e.g. `4.52` = 4.52%).
 *
 * Uses strictly causal `category === 1` cash-dividend & split/bonus/rights events
 * inside `(tradeDate - 365d, tradeDate]` (`ex_date <= tradeDate` — zero lookahead).
 * TDX fields are per 10 shares (`fenhong` RMB / 10 shares, `songzhuangu` + `peigu`
 * shares / 10 shares). For chronological ex-dates, prior and same-date cash
 * dividends per pre-split share are diluted by `(1 + (songzhuangu + peigu) / 10)`
 * so the cumulative TTM dividend per share matches the unadjusted `close` on
 * `tradeDate`.
 */
export function computeDvTtmPit(
  close: number | null | undefined,
  tradeDate: string,
  events: readonly XdxrDividendEvent[],
): number | null {
  if (close == null || !Number.isFinite(close) || close <= 0) return null;
  if (!/^\d{8}$/.test(tradeDate)) return null;

  const windowStart = addYmdDays(tradeDate, -365);
  const byDate = new Map<string, { cashPer10: number; splitAddPer10: number }>();

  for (const event of events) {
    if (event.category !== 1) continue;
    const exDate = normalizeExDate(event);
    if (!exDate) continue;
    if (exDate <= windowStart || exDate > tradeDate) continue;

    const prev = byDate.get(exDate) ?? { cashPer10: 0, splitAddPer10: 0 };
    prev.cashPer10 += nonNegFinite(event.fenhong);
    prev.splitAddPer10 += nonNegFinite(event.songzhuangu) + nonNegFinite(event.peigu);
    byDate.set(exDate, prev);
  }

  let divPerShare = 0;
  for (const exDate of [...byDate.keys()].sort()) {
    const { cashPer10, splitAddPer10 } = byDate.get(exDate)!;
    divPerShare += cashPer10 / 10;
    const splitFactor = 1 + splitAddPer10 / 10;
    if (splitFactor > 0) divPerShare /= splitFactor;
  }

  return roundTo((divPerShare / close) * 100, 4);
}

export function hasXdxrTable(db: DatabaseSync | null): boolean {
  if (!db) return false;
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'xdxr'").get();
  } catch {
    return false;
  }
}

interface NormalizedXdxrRow {
  ts_code: string;
  ex_date: string;
  category: number;
  fenhong: number | null;
  peigujia: number | null;
  songzhuangu: number | null;
  peigu: number | null;
  suogu: number | null;
}

function collapseEventsByKey(tsCode: string, events: readonly XdxrDividendEvent[]): NormalizedXdxrRow[] {
  const byKey = new Map<string, NormalizedXdxrRow>();
  for (const event of events) {
    const exDate = normalizeExDate(event);
    if (!exDate || !Number.isInteger(event.category)) continue;
    const key = `${exDate}:${event.category}`;
    const prev = byKey.get(key);
    if (!prev || event.category !== 1) {
      byKey.set(key, {
        ts_code: tsCode,
        ex_date: exDate,
        category: event.category,
        fenhong: event.fenhong ?? null,
        peigujia: event.peigujia ?? null,
        songzhuangu: event.songzhuangu ?? null,
        peigu: event.peigu ?? null,
        suogu: event.suogu ?? null,
      });
    } else {
      prev.fenhong = (prev.fenhong ?? 0) + nonNegFinite(event.fenhong);
      prev.songzhuangu = (prev.songzhuangu ?? 0) + nonNegFinite(event.songzhuangu);
      prev.peigu = (prev.peigu ?? 0) + nonNegFinite(event.peigu);
      if (event.peigujia != null && event.peigujia > 0) prev.peigujia = event.peigujia;
    }
  }
  return [...byKey.values()];
}

/**
 * Persist TDX xdxr events for multiple stocks in one transaction and record
 * `xdxr_stock` completion in `sync_log` (so 0-event stocks are distinguished
 * from unsynced/unavailable ones).
 */
export function upsertXdxrBatch(
  db: DatabaseSync,
  eventsByCode: ReadonlyMap<string, readonly XdxrDividendEvent[]>,
  updatedAt = new Date().toISOString(),
): number {
  if (!eventsByCode.size || !hasXdxrTable(db)) return 0;
  const hasSyncLog = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_log'").get();
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO xdxr
      (ts_code, ex_date, category, fenhong, peigujia, songzhuangu, peigu, suogu, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let totalRows = 0;
  inTransaction(db, () => {
    for (const [tsCode, rawEvents] of eventsByCode.entries()) {
      const rows = collapseEventsByKey(tsCode, rawEvents);
      for (const r of rows) {
        upsertStmt.run(
          r.ts_code, r.ex_date, r.category,
          r.fenhong, r.peigujia, r.songzhuangu, r.peigu, r.suogu,
          updatedAt,
        );
        totalRows++;
      }
      if (hasSyncLog) {
        logSync(db, 'xdxr_stock', tsCode, rows.length, 'ok', '', {
          refresh_status: 'REFRESH_OK',
          write_mode: 'merged',
        });
      }
    }
  });
  return totalRows;
}

export function upsertXdxrEvents(
  db: DatabaseSync,
  tsCode: string,
  events: readonly XdxrDividendEvent[],
  updatedAt = new Date().toISOString(),
): number {
  return upsertXdxrBatch(db, new Map([[tsCode, events]]), updatedAt);
}

export interface XdxrKnowledge {
  /** PIT category-1 events inside `(tradeDate - 365d, tradeDate]` keyed by `ts_code`. */
  eventsByCode: Map<string, XdxrDividendEvent[]>;
  /** Stocks whose local xdxr state is known (have rows in `xdxr` or `xdxr_stock` ok in `sync_log`). */
  knownCodes: Set<string>;
}

/**
 * Load strictly causal `(tradeDate - 365d, tradeDate]` category-1 events and
 * known-synced stock codes from local SQLite `xdxr` / `sync_log`.
 */
export function loadXdxrKnowledge(db: DatabaseSync | null, tradeDate: string): XdxrKnowledge {
  const eventsByCode = new Map<string, XdxrDividendEvent[]>();
  const knownCodes = new Set<string>();
  if (!db || !/^\d{8}$/.test(tradeDate) || !hasXdxrTable(db)) {
    return { eventsByCode, knownCodes };
  }

  const windowStart = addYmdDays(tradeDate, -365);
  const rows = db.prepare(`
    SELECT ts_code, ex_date, category, fenhong, peigujia, songzhuangu, peigu, suogu
    FROM xdxr
    WHERE category = 1 AND ex_date > ? AND ex_date <= ?
    ORDER BY ts_code, ex_date
  `).all(windowStart, tradeDate) as Array<{
    ts_code: string;
    ex_date: string;
    category: number;
    fenhong: number | null;
    peigujia: number | null;
    songzhuangu: number | null;
    peigu: number | null;
    suogu: number | null;
  }>;

  for (const r of rows) {
    let list = eventsByCode.get(r.ts_code);
    if (!list) {
      list = [];
      eventsByCode.set(r.ts_code, list);
    }
    list.push(r);
    knownCodes.add(r.ts_code);
  }

  const distinctXdxr = db.prepare('SELECT DISTINCT ts_code FROM xdxr').all() as Array<{ ts_code: string }>;
  for (const r of distinctXdxr) knownCodes.add(r.ts_code);

  try {
    const synced = db.prepare("SELECT key FROM sync_log WHERE dataset = 'xdxr_stock' AND status = 'ok'").all() as Array<{ key: string }>;
    for (const r of synced) knownCodes.add(r.key);
  } catch { /* sync_log optional in minimal test fixtures */ }

  return { eventsByCode, knownCodes };
}

/**
 * Backfill `dv_ttm` on `daily_basic` rows where `dv_ttm == null` using
 * `extraXdxr` (freshly fetched TDX events) and local `xdxr` table.
 * Leaves `dv_ttm` as `null` when neither source has xdxr knowledge for that stock
 * or when `close` is missing/non-positive (anti-fabrication).
 */
export function backfillDailyBasicDvTtm(
  db: DatabaseSync | null,
  tradeDate: string,
  basicRows: Record<string, any>[],
  closeByCode: ReadonlyMap<string, number>,
  extraXdxr?: ReadonlyMap<string, readonly XdxrDividendEvent[]>,
): Record<string, any>[] {
  if (!basicRows.length) return basicRows;
  const needsFill = basicRows.some(r => r.dv_ttm == null);
  if (!needsFill) return basicRows;

  const { eventsByCode, knownCodes } = loadXdxrKnowledge(db, tradeDate);
  return basicRows.map(row => {
    if (row.dv_ttm != null) return row;
    const code = String(row.ts_code ?? '');
    const close = closeByCode.get(code);
    if (close == null || !(close > 0)) return row;

    const freshEvents = extraXdxr?.get(code);
    if (freshEvents !== undefined) {
      return { ...row, dv_ttm: computeDvTtmPit(close, tradeDate, freshEvents) };
    }
    if (!knownCodes.has(code)) return row;

    const storedEvents = eventsByCode.get(code) ?? [];
    return { ...row, dv_ttm: computeDvTtmPit(close, tradeDate, storedEvents) };
  });
}
