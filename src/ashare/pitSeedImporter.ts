import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as SqliteDb } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inTransaction, logSync, openAshareDb } from './db.js';

export function defaultV34PitCacheDir(): string {
  return resolve(
    process.env.ASHARE_V34_PIT_CACHE_DIR?.trim()
      || join(homedir(), '.local', 'share', 'ashare-private', 'v34_pit_cache'),
  );
}

export interface ImportV34PitSeedOptions {
  cacheDir?: string;
  targetDbPath?: string;
}

export interface ImportV34PitSeedResult {
  cache_dir: string;
  target_db: string;
  fina_rows_imported: number;
  fina_quarters_logged: number;
  macro_yield_rows_imported: number;
  market_fundamental_rows_imported: number;
}

function numOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseCsvObjects(path: string): Record<string, string>[] {
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (cols[j] ?? '').trim();
    }
    out.push(row);
  }
  return out;
}

/**
 * 幂等导入 v3.4.0 阶段 2 预热底座（40 季 PIT 财报、2018-2026 中债曲线、2018-2026 日频基本面表）。
 * 可重复执行，绝不触发全市场重拉，且为已导入季度登记 sync_log='ok' 避免日频增量重复回拉历史 40 季。
 */
export function importV34PitSeedIntoDb(
  db: DatabaseSync,
  options: { cacheDir?: string } = {},
): Omit<ImportV34PitSeedResult, 'target_db'> {
  const cacheDir = resolve(options.cacheDir ?? defaultV34PitCacheDir());
  const finaSqlitePath = join(cacheDir, 'fina_40q_pit.sqlite');
  const macroCsvPath = join(cacheDir, 'macro_yield_curve_2018_2026.csv');
  const dailyCsvPath = join(cacheDir, 'market_fundamental_daily_2018_2026.csv');

  for (const p of [finaSqlitePath, macroCsvPath, dailyCsvPath]) {
    if (!existsSync(p)) {
      throw new Error(`v34_pit_seed_missing_file: ${p}`);
    }
  }

  let finaImported = 0;
  const quarterCounts = new Map<string, number>();

  const srcDb = new SqliteDb(finaSqlitePath, { readOnly: true });
  try {
    const srcCols = new Set(
      (srcDb.prepare('PRAGMA table_info(fina_pit)').all() as Array<{ name?: string }>)
        .map(c => c.name)
        .filter((n): n is string => Boolean(n)),
    );
    const optCol = (name: string) => (srcCols.has(name) ? name : `NULL AS ${name}`);
    const epsCol = srcCols.has('basic_eps') ? 'basic_eps AS eps' : optCol('eps');
    const selectStmt = srcDb.prepare(`
      SELECT ts_code, end_date, ann_date,
             ${optCol('roe')}, ${optCol('roe_dt')}, ${optCol('netprofit_yoy')}, ${optCol('dt_netprofit_yoy')},
             ${optCol('or_yoy')}, ${optCol('grossprofit_margin')}, ${optCol('debt_to_assets')},
             ${optCol('ocf_to_profit')}, ${optCol('ocfps')}, ${epsCol}, ${optCol('bps')}
      FROM fina_pit
      WHERE ts_code IS NOT NULL AND end_date IS NOT NULL AND ann_date IS NOT NULL
    `);

    const dstCols = new Set(
      (db.prepare('PRAGMA table_info(fina_indicator)').all() as Array<{ name?: string }>)
        .map(c => c.name)
        .filter((n): n is string => Boolean(n)),
    );
    const candidateCols = [
      'ts_code', 'end_date', 'ann_date', 'roe', 'roe_dt', 'netprofit_yoy', 'dt_netprofit_yoy',
      'or_yoy', 'grossprofit_margin', 'debt_to_assets', 'ocf_to_profit', 'ocfps', 'eps', 'bps',
    ] as const;
    const insertCols = candidateCols.filter(c => dstCols.has(c));
    const insertFina = db.prepare(`
      INSERT OR REPLACE INTO fina_indicator (${insertCols.join(', ')})
      VALUES (${insertCols.map(() => '?').join(',')})
    `);

    const batch: any[][] = [];
    const flush = () => {
      if (batch.length === 0) return;
      inTransaction(db, () => {
        for (const params of batch) insertFina.run(...params);
      });
      batch.length = 0;
    };

    for (const row of selectStmt.iterate() as Iterable<Record<string, any>>) {
      const tsCode = String(row.ts_code ?? '').trim().toUpperCase();
      const endDate = String(row.end_date ?? '').trim();
      const annDate = String(row.ann_date ?? '').trim();
      if (!tsCode || !/^\d{8}$/.test(endDate) || !/^\d{8}$/.test(annDate)) continue;
      const valByCol: Record<string, any> = {
        ts_code: tsCode,
        end_date: endDate,
        ann_date: annDate,
        roe: numOrNull(row.roe),
        roe_dt: numOrNull(row.roe_dt),
        netprofit_yoy: numOrNull(row.netprofit_yoy),
        dt_netprofit_yoy: numOrNull(row.dt_netprofit_yoy),
        or_yoy: numOrNull(row.or_yoy),
        grossprofit_margin: numOrNull(row.grossprofit_margin),
        debt_to_assets: numOrNull(row.debt_to_assets),
        ocf_to_profit: numOrNull(row.ocf_to_profit),
        ocfps: numOrNull(row.ocfps),
        eps: numOrNull(row.eps),
        bps: numOrNull(row.bps),
      };
      batch.push(insertCols.map(c => valByCol[c]));
      finaImported += 1;
      quarterCounts.set(endDate, (quarterCounts.get(endDate) ?? 0) + 1);
      if (batch.length >= 2000) flush();
    }
    flush();
  } finally {
    srcDb.close();
  }

  // 为导入的完整季度写入 sync_log='ok'，防止日频 syncFinaIndicator 重复联网重拉 40 季。
  inTransaction(db, () => {
    for (const [period, count] of quarterCounts.entries()) {
      logSync(db, 'fina_indicator', period, count, 'ok', 'v34_pit_seed_imported', {
        refresh_status: 'REFRESH_OK',
        write_mode: 'merged',
      });
    }
  });

  const macroRows = parseCsvObjects(macroCsvPath);
  const insertMacro = db.prepare(`
    INSERT OR REPLACE INTO macro_yield_curve (
      trade_date, cgb_1y_bps, cgb_10y_bps, term_spread_bps, source
    ) VALUES (?,?,?,?,?)
  `);
  let macroImported = 0;
  inTransaction(db, () => {
    for (const r of macroRows) {
      const td = r.trade_date;
      if (!/^\d{8}$/.test(td)) continue;
      const y1 = numOrNull(r.cgb_1y_bps) ?? (numOrNull(r.cgb_1y_pct) !== null ? numOrNull(r.cgb_1y_pct)! * 100 : null);
      const y10 = numOrNull(r.cgb_10y_bps) ?? (numOrNull(r.cgb_10y_pct) !== null ? numOrNull(r.cgb_10y_pct)! * 100 : null);
      const spread = numOrNull(r.term_spread_bps)
        ?? numOrNull(r.term_spread_10y_1y_bps)
        ?? (y1 !== null && y10 !== null ? Math.round((y10 - y1) * 10000) / 10000 : null);
      insertMacro.run(td, y1, y10, spread, r.source || 'v34_pit_seed');
      macroImported += 1;
    }
  });

  const dailyRows = parseCsvObjects(dailyCsvPath);
  const insertDaily = db.prepare(`
    INSERT OR REPLACE INTO market_fundamental_daily (
      trade_date, ep_median_bps, bp_median_bps, dv_lowvol_bps, erp_bps, erp_pct_756, bp_pct_756, edi_bps
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  let dailyImported = 0;
  inTransaction(db, () => {
    for (const r of dailyRows) {
      const td = r.trade_date;
      if (!/^\d{8}$/.test(td)) continue;
      insertDaily.run(
        td,
        numOrNull(r.ep_median_bps),
        numOrNull(r.bp_median_bps),
        numOrNull(r.dv_lowvol_bps) ?? numOrNull(r.dv_ttm_lowvol_bps),
        numOrNull(r.erp_bps),
        numOrNull(r.erp_pct_756),
        numOrNull(r.bp_pct_756),
        numOrNull(r.edi_bps),
      );
      dailyImported += 1;
    }
  });

  return {
    cache_dir: cacheDir,
    fina_rows_imported: finaImported,
    fina_quarters_logged: quarterCounts.size,
    macro_yield_rows_imported: macroImported,
    market_fundamental_rows_imported: dailyImported,
  };
}

export function runImportV34PitSeed(options: ImportV34PitSeedOptions = {}): ImportV34PitSeedResult {
  const db = openAshareDb(options.targetDbPath);
  try {
    const res = importV34PitSeedIntoDb(db, { cacheDir: options.cacheDir });
    return {
      ...res,
      target_db: options.targetDbPath ?? ((db as any).name || ''),
    };
  } finally {
    db.close();
  }
}
