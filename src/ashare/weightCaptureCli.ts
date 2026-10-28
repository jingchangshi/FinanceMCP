/** `weightCaptureCli` — ETF 成分权重缓存采集（goal-1026 Wave 2，§4.1 权重口径）。
 *
 * 独立入口，**不**接入 `cli.ts`：日报生产路径必须保持禁联网，本脚本只供
 * 人工/定时在有网环境运行一次，把五只持仓 ETF 的最新可得成分权重落成
 * `$ASHARE_DATA_DIR/etf-weights/<code>.json` 数据文件缓存（不动 DB schema）。
 * 生产日报侧 `collectEtfPenetrationInputs` 只读该文件回放，永不联网。
 *
 * 口径（与 goal-1026 C-etf E2E 验证一致）：
 *   - 159558.SZ：中证 931743.CSI 月度成分权重（index_weight），weight_date=权重月度日；
 *   - 其余四只：基金季度持仓（fund_portfolio），weight_date=报告期末，天然滞后
 *     （STALE 由 weightFreshness 按 45 天阈值显式标注，绝不称为最新持仓）。
 *
 * 纪律：
 *   - Tushare 成功码 `code === 0`；token 只从环境 `TUSHARE_TOKEN` 读取，
 *     绝不打印、绝不写入任何文件或日志。
 *   - 只读采集；写文件走 临时文件 + rename，失败保留旧文件不覆盖；幂等可重复跑。
 *
 * 用法：
 *   TUSHARE_TOKEN=... ASHARE_DATA_DIR=... node build/ashare/weightCaptureCli.js \
 *     [--as-of YYYYMMDD] [--codes 159558.SZ,560390.SH,...] [--out DIR] [--throttle-ms 350]
 *
 * stdout：一个 JSON 文档（逐只状态）。stderr：人类进度。退出码：0 全部成功，
 * 2 用法/契约错误，1 部分或全部采集失败（旧缓存文件保留）。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ashareDataDir } from './db.js';
import { writeWeightSnapshot, type EtfWeightRow } from './etfWeightStore.js';

export const WEIGHT_CAPTURE_VERSION = 'etf-weight-cache-20261026-v1';

/** 默认五只持仓 ETF；可参数化覆盖。 */
export const DEFAULT_WEIGHT_CODES: readonly string[] = [
  '159558.SZ', '560390.SH', '516080.SH', '159278.SZ', '159241.SZ',
];

/** 159558 的跟踪指数（上轮 E2E 已核验：index_basic 唯一命中，CSI 官方发布）。 */
const INDEX_WEIGHT_SPECS: Record<string, { index_code: string; note: string }> = {
  '159558.SZ': {
    index_code: '931743.CSI',
    note: 'tushare index_weight（只读）：中证指数月度成分权重，931743.CSI=半导体材料设备；权重日为指数月度调仓日。',
  },
};

const PORTFOLIO_NOTE = 'tushare fund_portfolio（只读）：基金季度定期报告持仓，weight_date=报告期末；该口径天然滞后于当前时点，过期由 weightFreshness 显式标注（STALE），禁止称为最新持仓。';

export interface WeightCacheRow {
  ts_code: string;
  weight: number;
}

export interface WeightCaptureResult {
  code: string;
  status: 'WRITTEN' | 'FAILED';
  weight_date: string | null;
  weight_source: 'index_weight' | 'fund_portfolio' | null;
  publication_date: string | null;
  index_code: string | null;
  n: number;
  weight_sum_pct: number | null;
  path: string | null;
  error: string | null;
  /** fund_portfolio rows dropped from the PIT store for a missing ann_date. */
  snapshot_skipped_no_ann_date?: number;
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

function ymdOfTodayShanghai(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
}

function minusDays(ymd: string, days: number): string {
  const d = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - days * 86400000;
  return new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
}

export function weightCacheDir(dataDir = ashareDataDir()): string {
  return join(dataDir, 'etf-weights');
}

export function weightCachePath(code: string, dataDir = ashareDataDir()): string {
  return join(weightCacheDir(dataDir), `${code}.json`);
}

interface TushareApi {
  (apiName: string, params: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[] } | { err: string }>;
}

export function makeTushareApi(token: string, throttleMs = 350): TushareApi {
  return async (apiName, params) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('https://api.tushare.pro', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_name: apiName, token, params }),
          signal: AbortSignal.timeout(60000),
        });
        const json = await res.json() as { code?: number; msg?: string; data?: { fields?: string[]; items?: unknown[][] } };
        if (json.code === 0) {
          const fields = json.data?.fields ?? [];
          const rows = (json.data?.items ?? []).map(item =>
            Object.fromEntries(fields.map((f, i) => [f, (item as unknown[])[i]])));
          await sleep(throttleMs);
          return { rows };
        }
        const msg = String(json.msg ?? 'unknown error');
        if (/频率|limit|每分钟/.test(msg) && attempt < 2) { await sleep(2000); continue; }
        await sleep(throttleMs);
        return { err: msg.slice(0, 200) };
      } catch (e) {
        if (attempt === 2) return { err: String(e).slice(0, 200) };
        await sleep(1000);
      }
    }
    return { err: 'retries_exhausted' };
  };
}

async function captureOne(api: TushareApi, code: string, asOf: string, db?: DatabaseSync): Promise<WeightCaptureResult> {
  const spec = INDEX_WEIGHT_SPECS[code];
  let weightRows: WeightCacheRow[] = [];
  let weightDate: string | null = null;
  let weightSource: 'index_weight' | 'fund_portfolio' | null = null;
  let publicationDate: string | null = null;
  let indexCode: string | null = null;
  let sourceNote: string;
  // fund_portfolio rows carry their own ann_date (per-report disclosure);
  // index_weight rows take weightDate as the single publication date.
  let fundRows: Array<{ ts_code: string; weight: number; ann_date: string | null }> = [];
  let skippedNoAnnDate = 0;

  if (spec) {
    const res = await api('index_weight', {
      index_code: spec.index_code,
      start_date: minusDays(asOf, 90),
      end_date: asOf,
    });
    if ('err' in res) {
      return { code, status: 'FAILED', weight_date: null, weight_source: null, publication_date: null, index_code: null, n: 0, weight_sum_pct: null, path: null, error: `index_weight: ${res.err}` };
    }
    const dates = [...new Set(res.rows.map(r => String(r.trade_date)).filter(d => /^\d{8}$/.test(d) && d <= asOf))].sort();
    weightDate = dates.at(-1) ?? null;
    if (!weightDate) {
      return { code, status: 'FAILED', weight_date: null, weight_source: 'index_weight', publication_date: null, index_code: spec.index_code, n: 0, weight_sum_pct: null, path: null, error: 'index_weight: no weights on/before as_of' };
    }
    weightRows = res.rows
      .filter(r => String(r.trade_date) === weightDate)
      .map(r => ({ ts_code: String(r.con_code), weight: Number(r.weight) }))
      .filter(r => /^\d{6}\.(SH|SZ|BJ)$/.test(r.ts_code) && Number.isFinite(r.weight));
    weightSource = 'index_weight';
    indexCode = spec.index_code;
    sourceNote = spec.note;
  } else {
    const res = await api('fund_portfolio', { ts_code: code });
    if ('err' in res) {
      return { code, status: 'FAILED', weight_date: null, weight_source: null, publication_date: null, index_code: null, n: 0, weight_sum_pct: null, path: null, error: `fund_portfolio: ${res.err}` };
    }
    const periods = [...new Set(res.rows.map(r => String(r.end_date)).filter(d => /^\d{8}$/.test(d) && d <= asOf))].sort();
    weightDate = periods.at(-1) ?? null;
    if (!weightDate) {
      return { code, status: 'FAILED', weight_date: null, weight_source: 'fund_portfolio', publication_date: null, index_code: null, n: 0, weight_sum_pct: null, path: null, error: 'fund_portfolio: no report period on/before as_of' };
    }
    const periodRows = res.rows.filter(r => String(r.end_date) === weightDate);
    // Keep each row's own ann_date for the PIT store: a fund_portfolio row is
    // only visible from its disclosure date, and rows lacking one are dropped.
    fundRows = periodRows
      .map(r => ({
        ts_code: String(r.symbol), weight: Number(r.stk_mkv_ratio),
        ann_date: /^\d{8}$/.test(String(r.ann_date ?? '')) ? String(r.ann_date) : null,
      }))
      .filter(r => /^\d{6}\.(SH|SZ|BJ)$/.test(r.ts_code) && Number.isFinite(r.weight) && r.weight > 0);
    weightRows = fundRows.map(({ ts_code, weight }) => ({ ts_code, weight }));
    skippedNoAnnDate = fundRows.filter(r => r.ann_date === null).length;
    publicationDate = fundRows.map(r => r.ann_date ?? '').filter(d => d !== '').sort().at(-1) ?? null;
    weightSource = 'fund_portfolio';
    sourceNote = PORTFOLIO_NOTE;
  }

  if (!weightRows.length) {
    return { code, status: 'FAILED', weight_date: weightDate, weight_source: weightSource, publication_date: publicationDate, index_code: indexCode, n: 0, weight_sum_pct: null, path: null, error: 'no constituent rows parsed' };
  }

  const capturedAt = new Date().toISOString();
  const doc = {
    schema: WEIGHT_CAPTURE_VERSION,
    as_of: asOf,
    weight_date: weightDate,
    weight_source: weightSource,
    publication_date: publicationDate,
    index_code: indexCode,
    weightRows,
    captured_at: capturedAt,
    source_note: sourceNote,
  };
  const dir = weightCacheDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = weightCachePath(code);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(doc, null, 2));
  renameSync(tmpPath, finalPath); // 原子替换：失败保留旧文件
  // Mirror into the PIT store the hotspot pool reads. available_from is the
  // disclosure date an analyst could actually have known the weight: the
  // rebalance day for index_weight, the row's own ann_date for fund_portfolio.
  // Rows without a usable date are counted, never guessed.
  if (db) {
    const storeRows: EtfWeightRow[] = [];
    if (weightSource === 'index_weight') {
      for (const r of weightRows) {
        storeRows.push({
          etf_code: code, index_code: indexCode, stock_code: r.ts_code, weight: r.weight,
          source: 'index_weight', effective_date: weightDate!, published_at: weightDate!,
          available_from: weightDate!, collected_at: capturedAt, quality_status: 'OK',
        });
      }
    } else {
      for (const r of fundRows) {
        if (!r.ann_date) continue; // 披露日缺失 → 不入 PIT 库，不伪造时点
        storeRows.push({
          etf_code: code, index_code: null, stock_code: r.ts_code, weight: r.weight,
          source: 'fund_portfolio', effective_date: weightDate!, published_at: r.ann_date,
          available_from: r.ann_date, collected_at: capturedAt, quality_status: 'OK',
        });
      }
    }
    if (storeRows.length) writeWeightSnapshot(db, storeRows);
  }
  const sum = weightRows.reduce((s, r) => s + r.weight, 0);
  return {
    code, status: 'WRITTEN', weight_date: weightDate, weight_source: weightSource,
    publication_date: publicationDate, index_code: indexCode,
    n: weightRows.length, weight_sum_pct: Math.round(sum * 100) / 100, path: finalPath, error: null,
    ...(weightSource === 'fund_portfolio' && skippedNoAnnDate > 0
      ? { snapshot_skipped_no_ann_date: skippedNoAnnDate } : {}),
  };
}

export interface WeightCaptureOptions {
  as_of?: string;
  codes?: string[];
  out?: string;
  throttle_ms?: number;
  /**
   * When a live DB handle is passed, each successfully captured weight set is
   * also mirrored into `etf_weight_snapshot` (the PIT store the hotspot pool
   * reads). The JSON file cache stays authoritative for the daily report; the
   * DB store is additive and only written on success — a FAILED capture never
   * touches it.
   */
  db?: DatabaseSync;
}

export async function runWeightCapture(
  opts: WeightCaptureOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<{ status: string; as_of: string; out_dir: string; results: WeightCaptureResult[] }> {
  const token = env.TUSHARE_TOKEN?.trim();
  if (!token) throw new Error('TUSHARE_TOKEN 环境变量未设置（token 只从环境读取，绝不落盘）');
  const asOf = opts.as_of ?? ymdOfTodayShanghai();
  if (!/^\d{8}$/.test(asOf)) throw new Error(`--as-of 需要 YYYYMMDD：${asOf}`);
  const codes = (opts.codes?.length ? opts.codes : [...DEFAULT_WEIGHT_CODES])
    .filter(c => /^\d{6}\.(SH|SZ|BJ)$/.test(c));
  if (!codes.length) throw new Error('没有合法的 ETF 代码');
  if (opts.out) process.env.ASHARE_DATA_DIR = opts.out; // --out 覆盖数据根
  const api = makeTushareApi(token, opts.throttle_ms ?? 350);
  const results: WeightCaptureResult[] = [];
  for (const code of codes) {
    process.stderr.write(`[weight-capture] ${code} ...\n`);
    const result = await captureOne(api, code, asOf, opts.db);
    results.push(result);
    process.stderr.write(`[weight-capture] ${code} ${result.status}${result.error ? ` (${result.error})` : ''}\n`);
  }
  const failed = results.filter(r => r.status === 'FAILED');
  return {
    status: failed.length ? (failed.length === codes.length ? 'FAILED' : 'PARTIAL') : 'OK',
    as_of: asOf,
    out_dir: weightCacheDir(),
    results,
  };
}

/** 仅当本文件是进程入口时执行；被 import（测试/将来接线）时无副作用。 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const argOf = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // --db PATH: also mirror weights into that SQLite file's etf_weight_snapshot
  // (the PIT store the hotspot pool reads). Optional — without it the JSON
  // file cache contract is unchanged (goal-1026 readers keep working).
  const dbPath = argOf('db');
  const db = dbPath ? new DatabaseSync(dbPath) : undefined;
  runWeightCapture({
    as_of: argOf('as-of'),
    codes: argOf('codes')?.split(',').map(c => c.trim()).filter(Boolean),
    out: argOf('out'),
    throttle_ms: argOf('throttle-ms') ? Number(argOf('throttle-ms')) : undefined,
    db,
  })
    .then(summary => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      db?.close();
      process.exit(summary.status === 'FAILED' ? 1 : summary.status === 'PARTIAL' ? 1 : 0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`[weight-capture] ${(error as Error)?.stack || String(error)}\n`);
      db?.close();
      process.exit(2);
    });
}
