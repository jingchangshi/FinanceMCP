/**
 * etfWeightStore: ETF 权重/成分点时快照存储（goal-1028，architecture.md §4.1 / §2.2）。
 *
 * 表 `etf_weight_snapshot` 由本模块拥有（db.ts 与 hotspotTables.ts 均不含此表）。
 * 主键 (etf_code, snapshot_version, stock_code)；snapshot_version 由
 * (etf_code, effective_date, source) 确定性派生。这是键控快照而不是追加日志：
 * 同键重采样时 delete-then-insert 整组替换，旧成分不残留。
 *
 * 点时规则（§2.2）：
 *   - index_weight：effective_date = published_at = available_from = trade_date。
 *   - fund_portfolio：effective_date = end_date（报告期），published_at = available_from = ann_date。
 *     ann_date 缺失的行不得入库（available_from NOT NULL），由采集端跳过并计数。
 *   - 读取只看 available_from <= asOf 且 published_at 非空的行，取其中 effective_date 最新一期。
 *     published_at 缺失的行默认排除，并在 reason 中计数（DEGRADED / published_at_missing）；
 *     仅 {allowUnpublished: true} 时才返回。
 *   - etf_sh_cons / etf_sz_cons 的 qty 是申赎篮子数量，不是投资权重，永不写入本表。
 *
 * 日期统一为 YYYYMMDD 字符串（字典序即时序），与 weightFreshness 及权重 JSON 缓存一致。
 * 读路径不建表：表不存在时按无快照降级，避免只读连接（getAshareDb）因 CREATE 失败。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CoverageSummary, DataQuality } from './hotspotTypes.js';

export type EtfWeightSource = 'index_weight' | 'fund_portfolio';
export type EtfWeightQuality = 'OK' | 'DEGRADED' | 'UNAVAILABLE' | 'NO_POINT_IN_TIME';

export const ETF_WEIGHT_SCHEMA = `
CREATE TABLE IF NOT EXISTS etf_weight_snapshot (
  etf_code TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  index_code TEXT,
  weight REAL,
  source TEXT NOT NULL CHECK (source IN ('index_weight','fund_portfolio')),
  effective_date TEXT NOT NULL,
  published_at TEXT,
  available_from TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  quality_status TEXT NOT NULL CHECK (quality_status IN ('OK','DEGRADED','UNAVAILABLE','NO_POINT_IN_TIME')),
  PRIMARY KEY (etf_code, snapshot_version, stock_code)
);
CREATE INDEX IF NOT EXISTS etf_weight_snapshot_effective_date ON etf_weight_snapshot(effective_date);
CREATE INDEX IF NOT EXISTS etf_weight_snapshot_available_from ON etf_weight_snapshot(available_from);
`;

const SOURCES: readonly string[] = ['index_weight', 'fund_portfolio'];
const QUALITIES: readonly string[] = ['OK', 'DEGRADED', 'UNAVAILABLE', 'NO_POINT_IN_TIME'];
const PUBLISHED_SQL = `published_at IS NOT NULL AND TRIM(published_at) <> ''`;

export interface EtfWeightRow {
  etf_code: string;
  index_code: string | null;
  stock_code: string;
  weight: number | null;
  source: EtfWeightSource;
  effective_date: string;
  published_at: string | null;
  available_from: string;
  collected_at: string;
  quality_status: EtfWeightQuality;
}

export interface WeightsAvailable {
  rows: EtfWeightRow[];
  quality: DataQuality;
  reason?: string;
}

/** 幂等建表（CREATE ... IF NOT EXISTS）。 */
export function ensureEtfWeightSchema(db: DatabaseSync): void {
  db.exec(ETF_WEIGHT_SCHEMA);
}

/** 确定性快照版本：同一 (etf, effective_date, source) 映射到同一键。 */
export function snapshotVersionFor(etf_code: string, effective_date: string, source: string): string {
  return `${etf_code}-${effective_date}-${source}`;
}

function hasSnapshotTable(db: DatabaseSync): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'etf_weight_snapshot'`).get();
}

function isPublished(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function mapRow(raw: any): EtfWeightRow {
  return {
    etf_code: String(raw.etf_code),
    index_code: raw.index_code == null ? null : String(raw.index_code),
    stock_code: String(raw.stock_code),
    weight: raw.weight == null ? null : Number(raw.weight),
    source: String(raw.source) as EtfWeightSource,
    effective_date: String(raw.effective_date),
    published_at: raw.published_at == null ? null : String(raw.published_at),
    available_from: String(raw.available_from),
    collected_at: String(raw.collected_at),
    quality_status: String(raw.quality_status) as EtfWeightQuality,
  };
}

function validateRow(row: EtfWeightRow, index: number): void {
  const where = `第 ${index} 行 etf=${row.etf_code} stock=${row.stock_code}`;
  if (!SOURCES.includes(row.source)) {
    throw new Error(`etf_weight_snapshot: 非法 source '${String(row.source)}'（${where}）；只允许 index_weight / fund_portfolio，申赎篮子 qty 不是权重`);
  }
  if (!QUALITIES.includes(row.quality_status)) {
    throw new Error(`etf_weight_snapshot: 非法 quality_status '${String(row.quality_status)}'（${where}）`);
  }
  for (const field of ['etf_code', 'stock_code', 'effective_date', 'collected_at', 'available_from'] as const) {
    const value = row[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`etf_weight_snapshot: ${field} 不能为空（${where}）`);
    }
  }
  if (row.weight === null && row.quality_status === 'OK') {
    throw new Error(`etf_weight_snapshot: weight 为 null 时 quality_status 不能是 OK（${where}）`);
  }
  if (row.weight !== null && !Number.isFinite(row.weight)) {
    throw new Error(`etf_weight_snapshot: weight 必须是有限数字（${where}）`);
  }
}

/**
 * 写入一组快照行。先整体校验（任一行非法则不写任何数据），再按
 * (etf_code, snapshot_version) 分组做 delete-then-insert，整体在一个 savepoint 内完成。
 * 返回写入的行数。
 */
export function writeWeightSnapshot(db: DatabaseSync, rows: EtfWeightRow[]): number {
  ensureEtfWeightSchema(db);
  rows.forEach((row, index) => validateRow(row, index));
  if (!rows.length) return 0;

  const groups = new Map<string, { etf_code: string; version: string; rows: EtfWeightRow[] }>();
  for (const row of rows) {
    const version = snapshotVersionFor(row.etf_code, row.effective_date, row.source);
    const key = `${row.etf_code}|${version}`;
    const group = groups.get(key) ?? { etf_code: row.etf_code, version, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  db.exec('SAVEPOINT etf_weight_write');
  try {
    const del = db.prepare('DELETE FROM etf_weight_snapshot WHERE etf_code = ? AND snapshot_version = ?');
    const ins = db.prepare(`
      INSERT INTO etf_weight_snapshot
        (etf_code, snapshot_version, stock_code, index_code, weight, source, effective_date, published_at, available_from, collected_at, quality_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const group of groups.values()) {
      del.run(group.etf_code, group.version);
      for (const row of group.rows) {
        ins.run(
          row.etf_code, group.version, row.stock_code, row.index_code ?? null, row.weight ?? null,
          row.source, row.effective_date, row.published_at ?? null, row.available_from,
          row.collected_at, row.quality_status,
        );
      }
    }
    db.exec('RELEASE etf_weight_write');
  } catch (error) {
    db.exec('ROLLBACK TO etf_weight_write');
    db.exec('RELEASE etf_weight_write');
    throw error;
  }
  return rows.length;
}

/**
 * 点时查询：只取 available_from <= asOf 且 published_at 非空的行，
 * 在其中取 effective_date 最新一期，按权重降序返回。
 * 无任何可用快照 → UNAVAILABLE / no_snapshot_available_at。
 * 默认排除的未发布行 → DEGRADED / published_at_missing(excluded=N)。
 */
export function weightsAvailableAt(
  db: DatabaseSync,
  etf_code: string,
  asOf: string,
  opts?: { allowUnpublished?: boolean },
): WeightsAvailable {
  if (!hasSnapshotTable(db)) return { rows: [], quality: 'UNAVAILABLE', reason: 'no_snapshot_available_at' };
  const candidates = db.prepare(`
    SELECT * FROM etf_weight_snapshot
    WHERE etf_code = ? AND available_from <= ? AND effective_date <= ?
    ORDER BY effective_date DESC, weight DESC, stock_code ASC
  `).all(etf_code, asOf, asOf) as any[];
  if (!candidates.length) return { rows: [], quality: 'UNAVAILABLE', reason: 'no_snapshot_available_at' };

  const unpublished = candidates.filter(r => !isPublished(r.published_at));
  const pool = opts?.allowUnpublished ? candidates : candidates.filter(r => isPublished(r.published_at));
  const latest = pool.length ? String(pool[0].effective_date) : null;
  const rows = latest === null ? [] : pool.filter(r => String(r.effective_date) === latest).map(mapRow);
  const returnedUnpublished = rows.filter(r => !isPublished(r.published_at)).length;

  let quality: DataQuality = 'OK';
  let reason: string | undefined;
  if (!opts?.allowUnpublished && unpublished.length > 0) {
    quality = 'DEGRADED';
    reason = `published_at_missing(excluded=${unpublished.length})`;
  } else if (returnedUnpublished > 0) {
    quality = 'DEGRADED';
    reason = `published_at_missing(included=${returnedUnpublished})`;
  } else if (rows.some(r => r.quality_status === 'NO_POINT_IN_TIME')) {
    quality = 'NO_POINT_IN_TIME';
    reason = 'no_point_in_time';
  } else if (rows.some(r => r.quality_status !== 'OK')) {
    quality = 'DEGRADED';
    reason = 'row_quality_degraded';
  }
  return reason === undefined ? { rows, quality } : { rows, quality, reason };
}

/** asOf 时点的前 n 大成分（按权重降序）。 */
export function topConstituents(db: DatabaseSync, etf_code: string, asOf: string, n = 10): EtfWeightRow[] {
  return weightsAvailableAt(db, etf_code, asOf).rows.slice(0, Math.max(0, Math.trunc(n)));
}

/**
 * asOf 时点哪些 ETF 持有该股（用于 multi_etf 标记）。
 * 每只 ETF 只看其在 asOf 可见的最新已发布一期；该期内含此股才计入。
 */
export function reverseLookupEtf(db: DatabaseSync, stock_code: string, asOf: string): EtfWeightRow[] {
  if (!hasSnapshotTable(db)) return [];
  const latestRows = db.prepare(`
    SELECT etf_code, MAX(effective_date) AS eff FROM etf_weight_snapshot
    WHERE available_from <= ? AND effective_date <= ? AND ${PUBLISHED_SQL}
    GROUP BY etf_code
  `).all(asOf, asOf) as any[];
  const latest = new Map<string, string>();
  for (const r of latestRows) latest.set(String(r.etf_code), String(r.eff));

  const holdings = db.prepare(`
    SELECT * FROM etf_weight_snapshot
    WHERE stock_code = ? AND available_from <= ? AND effective_date <= ? AND ${PUBLISHED_SQL}
    ORDER BY etf_code ASC, weight DESC
  `).all(stock_code, asOf, asOf) as any[];
  const seen = new Set<string>();
  const out: EtfWeightRow[] = [];
  for (const raw of holdings) {
    const etf = String(raw.etf_code);
    if (seen.has(etf) || latest.get(etf) !== String(raw.effective_date)) continue;
    seen.add(etf);
    out.push(mapRow(raw));
  }
  return out;
}

/**
 * 申赎篮子数量（etf_sh_cons / etf_sz_cons 的 qty）不是投资权重。
 * 本表 source CHECK 只允许 index_weight / fund_portfolio；调用方把任何 qty 引入权重路径前
 * 应先经过此守卫，它总是抛出。
 */
export function basketNotWeightGuard(qty: unknown): never {
  void qty;
  throw new Error('申赎篮子数量不能作为投资权重');
}

/** 每只 ETF 的权重覆盖摘要（rows / quality / reason），dataset 形如 etf_weight:<code>。 */
export function weightCoverage(db: DatabaseSync, etf_codes: readonly string[], asOf: string): CoverageSummary[] {
  return etf_codes.map(code => {
    const res = weightsAvailableAt(db, code, asOf);
    const summary: CoverageSummary = { dataset: `etf_weight:${code}`, rows: res.rows.length, quality: res.quality };
    if (res.reason !== undefined) summary.reason = res.reason;
    return summary;
  });
}
