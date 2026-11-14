import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveResearchDate } from './researchDate.js';
import { assertSeparateFromLive, openLiveReadOnly } from './snapshot.js';

/**
 * FinanceMCP → TactiCore 只读研究数据导出（research-export）。
 *
 * 边界（与 research-snapshot 一致）：
 * - 生产库**只读**打开（`openLiveReadOnly()`），不建表、不迁移、不写任何数据库；
 * - 日期列按 as-of 截断；请求日期晚于 `data_cutoff` 时默认失败，显式允许缺行情可降级导出；
 * - 输出是内容寻址的冻结快照目录 + `manifest.json`；相同输入产生相同 `snapshot_id` 与
 *   相同 `content_hashes`；
 * - 未知值保持 `null`，**不转为 0**；缺失的公告时点、行业成分、财务状态显式标注缺失；
 * - 原始价格与复权因子**分列**，不混合，也不用今天的分类冒充历史当时已知信息。
 */

export const RESEARCH_EXPORT_SCHEMA_VERSION = 'research-export-1.0.0';

/** 导出的数据集清单。键是 manifest 里的 dataset 名，值是生产库表名。 */
export const EXPORT_DATASETS = Object.freeze({
  trade_calendar: 'trade_cal',
  stock_basic: 'stock_basic',
  fund_basic: 'fund_basic',
  daily_bars: 'daily',
  fund_daily_bars: 'fund_daily',
  adj_factor: 'adj_factor',
  fund_adj_factor: 'fund_adj',
  fund_share: 'fund_share',
  suspend: 'suspend_d',
  price_limit: 'stk_limit',
  financial_indicator: 'fina_indicator',
  gap_check: 'gap_check',
  data_audit: 'data_audit',
  quality_check: 'quality_check',
} as const);

export type ExportDatasetName = keyof typeof EXPORT_DATASETS;

/** 每个数据集的时间列与 as-of 过滤方式。 */
const DATASET_TIME_COLUMN: Record<ExportDatasetName, string | null> = Object.freeze({
  trade_calendar: 'cal_date',
  stock_basic: null, // 身份表：按 list_date/delist_date 另行标注，不按 as-of 截断
  fund_basic: null,
  daily_bars: 'trade_date',
  fund_daily_bars: 'trade_date',
  adj_factor: 'trade_date',
  fund_adj_factor: 'trade_date',
  fund_share: 'trade_date',
  suspend: 'trade_date',
  price_limit: 'trade_date',
  financial_indicator: 'ann_date',
  gap_check: 'trade_date',
  // data_audit 没有 trade_date：它记录的是**一次审计运行**
  // （audit_id/created_at/start_date/end_date/status/summary/path）。
  // 按 end_date 过滤只限制审计窗口，不代表审计在 as-of 日已经产生；见非 PIT 标记。
  data_audit: 'end_date',
  quality_check: 'trade_date',
});

/**
 * as-of 过滤列的语义说明。非"价格类按交易日"的过滤方式必须显式写出，
 * 读取方不得自行假设时间列含义。写进 manifest 的 `as_of_filter_note`。
 */
const AS_OF_FILTER_NOTE: Partial<Record<ExportDatasetName, string>> = Object.freeze({
  trade_calendar: 'cal_date is the session itself, not an observation time',
  financial_indicator: 'filtered on ann_date (announcement day); a row announced after as-of is not exported',
  data_audit: 'filtered on end_date only; created_at may be after as-of, so this dataset is NOT PIT-qualified',
});

/**
 * 可得性语义：区分"真实 available_at"与"按规则估计的时间"。
 *
 * 规则（写入 manifest 的 availability_semantics，读取方必须遵守）：
 * - 价格等按交易日过滤，交易日不证明实际发布或供应商可得时间；
 * - 财务指标按公告日过滤，不证明盘中可得时间或供应商修订历史；未知日期不得猜测；
 * - 身份表（stock_basic / fund_basic）：`list_date` / `delist_date` 是真实事件日，
 *   但 `fund_type` / `market` / `status` 等分类字段是**当前快照值**，没有历史 vintage，
 *   因此标注为 `CURRENT_SNAPSHOT_NOT_PIT`。读取方不得用今天的分类回填历史；
 * - 行业成分：本导出**不包含**历史行业成分，标注为 `NOT_EXPORTED_MISSING`。
 */
export const AVAILABILITY_SEMANTICS = Object.freeze({
  price_like: 'trade_date filtering does not establish actual publication or vendor availability time; revisions are unknown',
  financial_indicator: 'ann_date is a day-level source date; empty ann_date means UNKNOWN and is not PIT-qualified; intraday availability and vendor revisions are unknown',
  data_audit: 'NOT_PIT: end_date filters the audit window, not created_at; the audit may not have existed at as-of',
  identity_classification: 'CURRENT_SNAPSHOT_NOT_PIT: fund_type/market/status have no historical vintage and must not be backfilled',
  industry_membership: 'NOT_EXPORTED_MISSING: no historical industry composition is exported',
  unknown_values: 'unknown stays null and is never coerced to zero',
} as const);

export interface ResearchExportOptions {
  /** 目标 as-of 交易日 YYYYMMDD。省略时取最近已收盘交易日。 */
  asOfTradeDate?: string;
  /** 输出目录。 */
  outputDir: string;
  /** 只导出这些数据集；省略导出全部。 */
  datasets?: readonly string[];
  /** 是否允许 as-of 日没有行情（快照将标为 DEGRADED，包括晚于 data_cutoff 时）。 */
  allowMissingBars?: boolean;
  /** legacy 保持历史导出；announcement-date-v1 仅保留有效且顺序合理的财务日期。 */
  financialAvailability?: 'legacy' | 'announcement-date-v1';
  /** 注入时钟，便于测试。 */
  now?: Date;
}

export interface DatasetExport {
  dataset: ExportDatasetName;
  table: string;
  file: string;
  rows: number;
  sha256: string;
  columns: string[];
  time_column: string | null;
  /** as-of 过滤是否真的生效（身份表为 false）。 */
  as_of_filtered: boolean;
  /** as-of 过滤列的语义：价格类是 trade_date，财务是 ann_date，审计是 end_date。 */
  as_of_filter_note: string;
  /** 该数据集的可得性语义键。 */
  availability: keyof typeof AVAILABILITY_SEMANTICS;
  /** 显式缺失说明（例如行业成分未导出）。 */
  missing_note?: string;
}

export interface ResearchExportManifest {
  snapshot_id: string;
  snapshot_id_algorithm: 'dataset-manifest-v2';
  schema_version: string;
  as_of_trade_date: string;
  created_at: string;
  source_db_fingerprint: string;
  dataset_manifest: DatasetExport[];
  data_quality: {
    status: 'READY' | 'DEGRADED';
    missing_datasets: string[];
    reasons: string[];
    as_of_requested: string | null;
    as_of_resolved: string;
    data_cutoff: string | null;
  };
  availability_semantics: Record<keyof typeof AVAILABILITY_SEMANTICS, string>;
  code_mapping_version: string;
  adjustment_policy: {
    policy: 'raw_and_adjustment_factor_exported_separately';
    note: string;
  };
  content_hashes: Record<string, string>;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const tableExists = (db: DatabaseSync, table: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(row => String(row.name));

/** 生产库指纹：不泄露内容，只用于在 manifest 中绑定来源身份。 */
function sourceFingerprint(db: DatabaseSync, asOf: string): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[])
    .map(row => String(row.name));
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      counts[table] = Number((db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get() as any)?.n ?? 0);
    } catch {
      counts[table] = -1;
    }
  }
  return hash({ as_of: asOf, tables, counts });
}

/**
 * 以 CSV 写出数据集。空值写为空字符串（读取方必须把空串解释为 null，不得解释为 0）。
 * 行序固定为时间列升序 + 主键，保证相同输入产生相同字节。
 */
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function writeDatasetCsv(
  db: DatabaseSync,
  dataset: ExportDatasetName,
  table: string,
  asOf: string,
  outDir: string,
  financialAvailability: 'legacy' | 'announcement-date-v1',
): { file: string; rows: number; sha256: string; columns: string[] } {
  const columns = columnsOf(db, table);
  const timeColumn = DATASET_TIME_COLUMN[dataset];
  const quoted = columns.map(name => `"${name}"`).join(', ');
  // 仅限制所声明的日期列，不证明数据当时已经发布或未被事后修订。
  const where = timeColumn ? ` WHERE "${timeColumn}" <= ?` : '';
  const params = timeColumn ? [asOf] : [];
  // The manifest publishes a sha256 per dataset, so the row order has to be a property of
  // the query and not of the storage engine. Ordering by the time column alone is not
  // enough: every table here has many rows per date, and a sort over ties is ordered by
  // nothing the caller chose. Once the row count is large enough the planner stops using
  // an index scan and switches to `USE TEMP B-TREE FOR ORDER BY`, at which point two
  // databases holding identical logical content export different bytes.
  //
  // So the tie-break is the table's declared primary key. It is read from the schema
  // (`PRAGMA table_info`, `pk` > 0) rather than hard-coded per dataset, because a dataset
  // mapped to a new table must not silently fall back to an unspecified order.
  const pkColumns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[])
    .filter(col => col.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(col => `"${col.name}"`);
  if (pkColumns.length === 0) throw new Error(`Export requires a primary key to fix row order: ${table}`);
  // The time column leads when it is not already the primary key's first column, so the
  // as-of grouping stays visible in the file. Deduplicated, because `fina_indicator`'s key
  // is (ts_code, end_date, ann_date) and its time column *is* `ann_date` — without the
  // filter the ORDER BY would name the same column twice.
  const lead = timeColumn && !pkColumns.includes(`"${timeColumn}"`) ? `"${timeColumn}"` : null;
  const orderKeys = lead ? [lead, ...pkColumns] : pkColumns;
  const order = ` ORDER BY ${orderKeys.join(', ')}`;
  const selected = db.prepare(`SELECT ${quoted} FROM "${table}"${where}${order}`).all(...params) as any[];
  const rows = dataset === 'financial_indicator' && financialAvailability === 'announcement-date-v1'
    ? selected.filter(row => validDate(row.end_date) && validDate(row.ann_date)
      && row.end_date <= row.ann_date && row.ann_date <= asOf)
    : selected;
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(name => escape(row[name])).join(','));
  const body = lines.join('\n') + '\n';
  const file = join(outDir, `${dataset}.csv`);
  writeFileSync(file, body, 'utf8');
  return {
    file: `${dataset}.csv`,
    rows: rows.length,
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    columns,
  };
}

/** Return the existing manifest only when the entire published snapshot matches. */
function matchingSnapshot(outputDir: string, expected: ResearchExportManifest): ResearchExportManifest | null {
  try {
    const output = lstatSync(outputDir);
    if (output.isSymbolicLink()) {
      const target = readlinkSync(outputDir);
      if (basename(target) !== target || !target.startsWith(`.${basename(outputDir)}.research-export-`)) return null;
      const version = lstatSync(join(dirname(outputDir), target));
      if (!version.isDirectory() || version.uid !== process.geteuid?.() || (version.mode & 0o077) !== 0) return null;
    } else if (!output.isDirectory()) return null;
    const manifestPath = join(outputDir, 'manifest.json');
    if (!lstatSync(manifestPath).isFile()) return null;
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResearchExportManifest;
    const { created_at: _oldCreated, ...oldContent } = existing;
    const { created_at: _newCreated, ...newContent } = expected;
    if (JSON.stringify(oldContent) !== JSON.stringify(newContent)) return null;
    const files = Object.keys(expected.content_hashes);
    if (JSON.stringify(readdirSync(outputDir).sort()) !== JSON.stringify([...files, 'manifest.json'].sort())) return null;
    for (const file of files) {
      const path = join(outputDir, file);
      if (!lstatSync(path).isFile()
          || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected.content_hashes[file]) return null;
    }
    return existing;
  } catch {
    return null;
  }
}

/** Resolve the parent through trusted ancestors before creating any missing directories. */
function secureExportParent(path: string): string {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error('research_export_unsafe_parent: user identity unavailable');
  const missing: string[] = [];
  let current = path;
  while (true) {
    try { lstatSync(current); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  const existing = realpathSync(current);
  let ancestor = existing;
  while (true) {
    const info = statSync(ancestor);
    const trustedOwner = info.uid === uid || info.uid === 0;
    const writableByOthers = (info.mode & 0o022) !== 0;
    const protectedBySticky = (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || !trustedOwner || (writableByOthers && !protectedBySticky)) {
      throw new Error(`research_export_unsafe_parent: ${ancestor}`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const info = statSync(existing);
  if (info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new Error(`research_export_unsafe_parent: ${existing}`);
  }
  const parent = join(existing, ...missing);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return parent;
}

/** Execute against one read transaction and publish only a complete directory. */
export function runResearchExport(
  liveDb: DatabaseSync,
  options: ResearchExportOptions,
): ResearchExportManifest {
  try {
    liveDb.exec('BEGIN');
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot start a transaction within a transaction')) {
      throw new Error('research_export_existing_transaction: commit or roll back the caller transaction before export');
    }
    throw error;
  }
  let ownsTransaction = true;
  let stagingDir: string | undefined;
  let published = false;
  try {
    const requestedOutput = resolve(options.outputDir);
    assertSeparateFromLive(requestedOutput, (liveDb as any).name ?? '');
    const parent = secureExportParent(dirname(requestedOutput));
    const outputDir = join(parent, basename(requestedOutput));
    assertSeparateFromLive(outputDir, (liveDb as any).name ?? '');
    stagingDir = mkdtempSync(join(parent, `.${basename(outputDir)}.research-export-`));
    const result = runResearchExportInTransaction(liveDb, options, stagingDir);
    liveDb.exec('COMMIT');
    ownsTransaction = false;
    try {
      // Creating the link is atomic and fails if any entry already has this name.
      // The private sibling becomes the immutable version backing the link.
      symlinkSync(basename(stagingDir), outputDir, 'dir');
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = matchingSnapshot(outputDir, result);
      if (existing) return existing;
      throw new Error(`research_export_output_exists: ${outputDir}; choose a new directory`);
    }
    return result;
  } catch (error) {
    if (ownsTransaction) {
      try { liveDb.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    if (stagingDir && !published) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function runResearchExportInTransaction(
  liveDb: DatabaseSync,
  options: ResearchExportOptions,
  stagingDir: string,
): ResearchExportManifest {
  const now = options.now ?? new Date();
  const outputDir = resolve(options.outputDir);
  const requested = options.asOfTradeDate;
  const financialAvailability = options.financialAvailability ?? 'legacy';
  if (financialAvailability !== 'legacy' && financialAvailability !== 'announcement-date-v1') {
    throw new Error(`research_export_invalid_financial_availability: ${financialAvailability}`);
  }

  const session = resolveResearchDate(liveDb, requested, now);
  if (session.status !== 'READY' || !session.as_of_trade_date) {
    throw new Error(
      `research_export_as_of_not_ready: requested=${requested ?? 'latest'} phase=${session.phase} `
      + `reason=${session.reason ?? 'unknown'}; refusing to export without a closed as-of session`,
    );
  }
  const asOf = session.as_of_trade_date;
  const wanted = new Set<string>(options.datasets ?? Object.keys(EXPORT_DATASETS));
  const unknown = [...wanted].filter(name => !(name in EXPORT_DATASETS));
  if (unknown.length) throw new Error(`research_export_unknown_datasets: ${unknown.join(', ')}`);
  const priceDatasets = (['daily_bars', 'fund_daily_bars'] as const).filter(name => wanted.has(name));

  // data_cutoff 是生产库价格的最新交易日。as-of 晚于它即拒绝，而不是静默导出一个
  // 不包含请求日的快照——那会让下游以为自己拿到了当天的数据。
  // 注意：UNION ALL 之后再 LIMIT 1 只会取到第一条语句的结果，股票与 ETF 的最新日
  // 必须用 MAX 取并集，否则 ETF 已更新而股票未更新时 cutoff 会被低估。
  const cutoff = Number(
    (liveDb.prepare(
      "SELECT MAX(d) d FROM ("
      + "SELECT MAX(trade_date) d FROM daily "
      + "UNION ALL SELECT MAX(trade_date) d FROM fund_daily)",
    ).get() as any)?.d ?? 0,
  );
  const dataCutoff = cutoff ? String(cutoff) : null;
  if (priceDatasets.length && dataCutoff && asOf > dataCutoff && !options.allowMissingBars) {
    throw new Error(
      `research_export_as_of_after_data_cutoff: as_of=${asOf} data_cutoff=${cutoff}; `
      + 'refusing to export a snapshot that does not contain the requested date',
    );
  }

  // A different asset class cannot establish that this exported dataset has prices.
  // A missing table is recorded separately in missing_datasets below.
  const missingAsOfBars = priceDatasets.filter(name => {
    const table = EXPORT_DATASETS[name];
    return tableExists(liveDb, table)
      && !liveDb.prepare(`SELECT 1 FROM "${table}" WHERE trade_date = ? AND close IS NOT NULL LIMIT 1`).get(asOf);
  });
  if (priceDatasets.length && missingAsOfBars.length === priceDatasets.length && !options.allowMissingBars) {
    throw new Error(`research_export_as_of_missing_bars: as_of=${asOf} datasets=${missingAsOfBars.join(',')}; refusing to export without prices on the requested date`);
  }

  assertSeparateFromLive(outputDir, (liveDb as any).name ?? '');

  // A dataset whose declared time column does not exist in the live table must be
  // reported, not allowed to crash the export mid-run: the manifest would otherwise
  // name a file that was never written.
  const missingTimeColumn: string[] = [];
  for (const name of wanted) {
    const table = EXPORT_DATASETS[name as ExportDatasetName];
    const column = DATASET_TIME_COLUMN[name as ExportDatasetName];
    if (!table || !column || !tableExists(liveDb, table)) continue;
    if (!columnsOf(liveDb, table).includes(column)) {
      missingTimeColumn.push(`${name}.${column}`);
    }
  }
  if (financialAvailability === 'announcement-date-v1' && wanted.has('financial_indicator')
      && tableExists(liveDb, EXPORT_DATASETS.financial_indicator)
      && !columnsOf(liveDb, EXPORT_DATASETS.financial_indicator).includes('end_date')) {
    missingTimeColumn.push('financial_indicator.end_date');
  }
  if (missingTimeColumn.length) {
    throw new Error(
      `research_export_time_column_missing: ${missingTimeColumn.join(', ')}; `
      + 'the live schema does not match this export version',
    );
  }

  const datasetManifest: DatasetExport[] = [];
  const contentHashes: Record<string, string> = {};
  const missingDatasets: string[] = [];
  const reasons: string[] = [];

  for (const name of Object.keys(EXPORT_DATASETS) as ExportDatasetName[]) {
    if (!wanted.has(name)) continue;
    const table = EXPORT_DATASETS[name];
    if (!tableExists(liveDb, table)) {
      missingDatasets.push(name);
      reasons.push(`table_missing:${table}`);
      continue;
    }
    const written = writeDatasetCsv(liveDb, name, table, asOf, stagingDir, financialAvailability);
    const availability: keyof typeof AVAILABILITY_SEMANTICS =
      name === 'financial_indicator' ? 'financial_indicator'
        : name === 'data_audit' ? 'data_audit'
        : name === 'stock_basic' || name === 'fund_basic' ? 'identity_classification'
        : 'price_like';
    datasetManifest.push({
      dataset: name,
      table,
      file: written.file,
      rows: written.rows,
      sha256: written.sha256,
      columns: written.columns,
      time_column: DATASET_TIME_COLUMN[name],
      as_of_filtered: DATASET_TIME_COLUMN[name] !== null,
      as_of_filter_note: DATASET_TIME_COLUMN[name] === null
        ? 'NOT filtered by as-of: identity tables carry list_date/delist_date and no historical vintage'
        : name === 'financial_indicator' && financialAvailability === 'announcement-date-v1'
          ? 'announcement-date-v1: valid YYYYMMDD end_date <= ann_date <= as-of; day granularity only, vendor revisions unknown'
          : AS_OF_FILTER_NOTE[name] ?? 'filtered on trade_date <= as_of_trade_date',
      availability,
    });
    contentHashes[written.file] = written.sha256;
  }

  // 行业成分未导出：显式记为缺失，而不是留一个空文件让下游误以为"当时没有行业"。
  if (wanted.has('financial_indicator') && !missingDatasets.includes('financial_indicator')) {
    reasons.push('industry_membership_not_exported: no historical industry composition in the production schema');
  }
  // 显式允许 as-of 缺行是**降级**：调用方必须自己承担"这天没有行情"的后果，
  // 并且这个决定必须出现在 manifest 里，不能只在命令行参数里。
  for (const name of missingAsOfBars) {
    reasons.push(`missing_as_of_bars:${name}: as_of=${asOf} has no close price`);
  }
  if (missingAsOfBars.length && options.allowMissingBars) {
    reasons.push(`allow_missing_bars: as_of=${asOf}; data_cutoff=${dataCutoff ?? 'unknown'}`);
  }

  const source = sourceFingerprint(liveDb, asOf);
  const sortedHashes = Object.fromEntries(Object.entries(contentHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const quality: ResearchExportManifest['data_quality'] = {
    status: missingDatasets.length || missingAsOfBars.length ? 'DEGRADED' : 'READY',
    missing_datasets: [...missingDatasets].sort(),
    reasons: [...reasons].sort(),
    as_of_requested: requested ?? null,
    as_of_resolved: asOf,
    data_cutoff: dataCutoff,
  };
  const datasets = [...datasetManifest].sort((a, b) => a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0)
    .map(d => [d.dataset, d.table, d.file, d.sha256, d.rows, d.columns, d.time_column,
      d.as_of_filtered, d.availability, d.as_of_filter_note, d.missing_note ?? null]);
  const adjustmentPolicy: ResearchExportManifest['adjustment_policy'] = {
    policy: 'raw_and_adjustment_factor_exported_separately',
    note: 'Raw OHLCV and adjustment factors are separate datasets. A missing factor series must be '
      + 'disclosed as raw_close_no_adj_factor and never silently mixed with adjusted prices.',
  };
  const semanticFields = (value: Record<string, string>) => Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // Encode the versioned mode in an existing v2 identity field, including when the
  // financial dataset is absent. Consumers can continue to verify the v2 algorithm.
  const availabilitySemantics = {
    ...AVAILABILITY_SEMANTICS,
    financial_indicator: `${AVAILABILITY_SEMANTICS.financial_indicator}; financial_availability=${financialAvailability}`,
  };
  const manifest: ResearchExportManifest = {
    snapshot_id: hash({ schema_version: RESEARCH_EXPORT_SCHEMA_VERSION, as_of: asOf, source,
      content_hashes: sortedHashes, datasets, quality, code_mapping_version: 'ts-code-v1',
      adjustment_policy: semanticFields(adjustmentPolicy), availability_semantics: semanticFields(availabilitySemantics) }),
    snapshot_id_algorithm: 'dataset-manifest-v2',
    schema_version: RESEARCH_EXPORT_SCHEMA_VERSION,
    as_of_trade_date: asOf,
    created_at: now.toISOString(),
    source_db_fingerprint: source,
    dataset_manifest: datasetManifest,
    data_quality: quality,
    availability_semantics: availabilitySemantics,
    code_mapping_version: 'ts-code-v1',
    adjustment_policy: adjustmentPolicy,
    content_hashes: contentHashes,
  };

  writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

/** CLI 入口：只读打开生产库，导出，打印 manifest。 */
export async function runResearchExportCommand(args: string[]): Promise<ResearchExportManifest> {
  const arg = (key: string, fallback?: string) => {
    const i = args.indexOf(`--${key}`);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
    return args[i + 1];
  };
  const output = arg('output');
  if (!output) throw new Error('--output required');
  const asOf = arg('as-of', arg('date'));
  const datasets = arg('datasets')?.split(',').map(item => item.trim()).filter(Boolean);
  const db = openLiveReadOnly();
  try {
    return runResearchExport(db, {
      asOfTradeDate: asOf,
      outputDir: output,
      datasets,
      allowMissingBars: args.includes('--allow-missing-bars'),
      financialAvailability: arg('financial-availability') as ResearchExportOptions['financialAvailability'],
    });
  } finally {
    db.close();
  }
}
