import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  canonicalJson, listResearchJournal, readResearchJournal,
  JOURNAL_VERSION, type JournalRecord,
} from './researchJournal.js';

/**
 * 持久化 VPS 研究快照的只读获取协议（goal-1027 P0-1）。
 *
 * 背景（2026-10-26 生产故障的根因）：Live Bundle 的 report_id 由 stableFacts(facts) 派生，
 * 而 facts.portfolio 的报告文本会随代码版本变化（goal-1026 升级改动了决策比较措辞与
 * alpha/risk 轨结构）。升级后同一交易日重建得到不同 report_id，persistedSnapshotStatus
 * 按 live ID 精确匹配失败 → SNAPSHOT_NOT_FOUND，尽管完整旧快照（1.1MB payload）一直
 * 保留在 research_journal 里。缺的不是数据，是**按快照自身身份读取它的只读接口**。
 *
 * 三个概念严格分离：
 * - Live Bundle：当前数据+代码+规则的实时研究包（researchBundle.buildInvestmentResearchBundle）。
 * - Persisted VPS Snapshot：本模块读取的、在记录时刻冻结的不可变事实（research_journal
 *   中 source='vps' 的行，payload 保存完整 bundle）。
 * - ChatGPT Research Record：chatgptIntake 追加的独立判断（必须引用一个真实快照身份）。
 *
 * 边界（任务书 §2.2 十条）：
 * - 纯只读：不建表、不写行、不创建快照、不伪造时间、不按日期把内容不同的 Live Bundle
 *   关联到旧快照。身份只按 record_id / (account, as_of, bundle_id) 精确匹配。
 * - 返回原始内容（frozen payload）与查询时元数据（retrieved_at 等）严格分字段。
 * - 读取时重算 content_hash；不一致即抛 integrity 错误（readResearchJournal 已实现）。
 *   payload 缺失（历史行可能只有摘要）时如实报告 payload_status=PAYLOAD_MISSING，
 *   绝不用 Live Bundle 内容回填。
 */

export const RESEARCH_SNAPSHOT_SCHEMA = 'ashare-research-snapshot/1.0';
export const SNAPSHOT_GET_TOOL = 'ashare_research_snapshot_get';

export interface SnapshotMetadata {
  record_id: string;
  bundle_id: string;
  account_id: string;
  as_of_trade_date: string;
  recorded_at: string;
  generated_at: string;
  content_hash: string;
  versions: Record<string, string>;
  judgement: unknown;
  parent_record_ids: string[];
  correction_of: string | null;
  payload_status: 'PAYLOAD_PRESENT' | 'PAYLOAD_MISSING';
  /** payload 内可提取的数据截止时间（bundle.as_of_trade_date）与生成时间；缺失为 null。 */
  data_as_of: string | null;
  payload_generated_at: string | null;
  payload_bytes: number | null;
}

function metadataOf(record: JournalRecord): SnapshotMetadata {
  const payload = (record as { payload?: unknown }).payload;
  const hasPayload = payload !== undefined && payload !== null && typeof payload === 'object';
  const bundle = hasPayload ? payload as Record<string, unknown> : null;
  const payloadJson = bundle ? canonicalJson(bundle) : null;
  return {
    record_id: record.record_id,
    bundle_id: record.bundle_id,
    account_id: record.account_id,
    as_of_trade_date: record.as_of_trade_date,
    recorded_at: record.recorded_at,
    generated_at: record.generated_at,
    content_hash: record.content_hash,
    versions: record.versions,
    judgement: record.judgement,
    parent_record_ids: record.parent_record_ids ?? [],
    correction_of: record.correction_of ?? null,
    payload_status: hasPayload ? 'PAYLOAD_PRESENT' : 'PAYLOAD_MISSING',
    data_as_of: typeof bundle?.as_of_trade_date === 'string' ? bundle.as_of_trade_date : null,
    payload_generated_at: typeof bundle?.generated_at === 'string' ? bundle.generated_at : null,
    payload_bytes: payloadJson === null ? null : Buffer.byteLength(payloadJson, 'utf8'),
  };
}

function journalTable(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_journal'").get();
}

export interface SnapshotListInput {
  accountId: string;
  asOf?: string;
  limit?: number;
}

/**
 * 列出某账户（可选某交易日）的全部持久化 VPS 快照元数据，按记录时间倒序。
 * 同一交易日多个 Bundle 的语义：每一天可以持久化多个不同身份的快照（不同代码/数据
 * 版本各一条），全部列出，由调用方选择；不隐式挑选"最新"。
 */
export function listResearchSnapshots(db: DatabaseSync, input: SnapshotListInput): {
  schema: string; account_id: string; as_of_trade_date: string | null;
  snapshots: SnapshotMetadata[]; total: number;
} {
  if (!journalTable(db)) {
    return { schema: RESEARCH_SNAPSHOT_SCHEMA, account_id: input.accountId, as_of_trade_date: input.asOf ?? null, snapshots: [], total: 0 };
  }
  const records = listResearchJournal(db, { accountId: input.accountId, asOf: input.asOf, limit: input.limit ?? 100 })
    .filter(record => record.source === 'vps' && (!input.asOf || record.as_of_trade_date === input.asOf));
  const snapshots = records.map(metadataOf);
  return {
    schema: RESEARCH_SNAPSHOT_SCHEMA,
    account_id: input.accountId,
    as_of_trade_date: input.asOf ?? null,
    snapshots,
    total: snapshots.length,
  };
}

export interface SnapshotGetResult {
  schema: string;
  /** 查询时元数据（服务端生成，不属于冻结内容）。 */
  query: {
    account_id: string;
    record_id: string | null;
    as_of_trade_date: string | null;
    retrieved_at: string;
  };
  snapshot: SnapshotMetadata | null;
  /** 原始冻结内容：持久化时刻的完整 bundle（payload），逐字节保留；缺失时为 null。 */
  frozen_payload: unknown;
  /** frozen_payload 的重算哈希（服务端只读校验）；与落库 content_hash 一致才可信。 */
  payload_verification: {
    recomputed_sha256: string | null;
    /** journal.content_hash 覆盖整条记录（含 payload）；recomputed 覆盖 payload 子集，二者口径不同，均如实给出。 */
    record_content_hash: string | null;
    status: 'VERIFIED' | 'PAYLOAD_MISSING';
  } | null;
  /** 同账户同交易日的其他快照身份（帮助选择；不构成自动关联）。 */
  same_date_snapshots: { record_id: string; bundle_id: string; recorded_at: string }[];
  note: string;
}

/**
 * 按真实身份获取一个持久化快照。`recordId` 优先；缺省时按 (account, asOf) 返回**最新**
 * 持久化快照，但 same_date_snapshots 同时列出该日全部版本，调用方可改用 record_id 精确读取。
 * 找不到时如实返回 snapshot:null，绝不回退 Live Bundle、绝不创建快照。
 */
export function getResearchSnapshot(db: DatabaseSync, input: {
  accountId: string; recordId?: string; asOf?: string; now?: Date;
}): SnapshotGetResult {
  const now = input.now ?? new Date();
  const query = {
    account_id: input.accountId,
    record_id: input.recordId ?? null,
    as_of_trade_date: input.asOf ?? null,
    retrieved_at: now.toISOString(),
  };
  const empty: SnapshotGetResult = {
    schema: RESEARCH_SNAPSHOT_SCHEMA, query, snapshot: null, frozen_payload: null,
    payload_verification: null, same_date_snapshots: [],
    note: 'snapshot_not_found：按给定身份没有持久化快照；只读查询不会创建快照，也不会回退到 Live Bundle。',
  };
  if (!journalTable(db)) return empty;
  let record: JournalRecord | null = null;
  if (input.recordId) {
    record = readResearchJournal(db, input.recordId);
    if (!record || record.source !== 'vps') return {
      ...empty,
      note: record
        ? `record_not_vps_snapshot：${input.recordId} 存在但 source=${record.source}，不是 VPS 快照。`
        : `snapshot_not_found：record_id=${input.recordId} 不存在。`,
    };
    if (record.account_id !== input.accountId) return {
      ...empty,
      note: `account_mismatch：${input.recordId} 属于账户 ${record.account_id}。`,
    };
    if (input.asOf && record.as_of_trade_date !== input.asOf) return {
      ...empty,
      note: `trade_date_mismatch：${input.recordId} 的交易日是 ${record.as_of_trade_date}，不是 ${input.asOf}。`,
    };
  } else {
    if (!input.asOf) return {
      ...empty,
      note: 'record_id 或 as_of_trade_date 至少提供一个；只读查询不隐式挑选快照。',
    };
    const candidates = listResearchJournal(db, { accountId: input.accountId, asOf: input.asOf, limit: 100 })
      .filter(row => row.source === 'vps' && row.as_of_trade_date === input.asOf);
    if (!candidates.length) return empty;
    // 最新一条（recorded_at 降序）作为缺省命中；全部版本在 same_date_snapshots 里披露。
    record = [...candidates].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  }
  const snapshot = metadataOf(record);
  const payload = (record as { payload?: unknown }).payload;
  const hasPayload = payload !== undefined && payload !== null && typeof payload === 'object';
  const sameDate = listResearchJournal(db, { accountId: input.accountId, asOf: record.as_of_trade_date, limit: 100 })
    .filter(row => row.source === 'vps' && row.as_of_trade_date === record.as_of_trade_date)
    .map(row => ({ record_id: row.record_id, bundle_id: row.bundle_id, recorded_at: row.recorded_at }));
  return {
    schema: RESEARCH_SNAPSHOT_SCHEMA,
    query,
    snapshot,
    frozen_payload: hasPayload ? payload : null,
    payload_verification: hasPayload
      ? {
        recomputed_sha256: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
        record_content_hash: record.content_hash,
        status: 'VERIFIED',
      }
      : { recomputed_sha256: null, record_content_hash: record.content_hash, status: 'PAYLOAD_MISSING' },
    same_date_snapshots: sameDate,
    note: hasPayload
      ? `已按真实身份读取冻结快照（journal 版本 ${JOURNAL_VERSION}）；frozen_payload 是记录时刻的完整原始内容，query 是本次查询元数据。该日共 ${sameDate.length} 个持久化版本。`
      : '该历史记录只保留了摘要（payload 缺失），完整冻结事实不可恢复；不以 Live Bundle 回填。',
  };
}
