import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson, JOURNAL_VERSION, readResearchJournal, recordResearchJournal, resolveHotspotBinding } from './researchJournal.js';
import { classifyRecord, type EvidenceClass } from './forwardReview.js';
import { inPortfolioTransaction } from './db.js';

/**
 * ChatGPT 研究记录写回（最小授权，只追加）。
 *
 * 唯一的 MCP 写入口，边界：
 * - 只写不可变表 `research_journal`（触发器禁止 UPDATE/DELETE/REPLACE）；不碰账本、持仓、
 *   完整性声明、风险配置、费用、订单。入参是严格白名单，出现任何其它字段（含 source、
 *   created_at、record_id、哈希、持仓、订单）一律拒绝，而不是悄悄忽略。
 * - `source`（goal-1106：'chatgpt' 缺省或 'hermes'，其余拒绝）、生成/取得/写入时间全部由服务端取当前时钟；调用方无法提供其它时间戳。
 * - 必须关联一份**已存在**的 VPS 研究快照（同账户、同 report_id、同交易日），不伪造关联。
 * - record_id 由 账户+交易日+report_id+(idempotency_key 或内容哈希) 派生：同键同内容幂等，
 *   同键不同内容拒绝；修正只能以新键写新记录（corrects_record_id → correction_of）。
 * - 不写 observations（数量属于账户语义），因此不会产生任何持仓/成交含义。
 */

export const CHATGPT_INTAKE_VERSION = 'chatgpt-intake-20261022-v1';
export const CHATGPT_INTAKE_TOOL = 'ashare_chatgpt_research_record_append';
export const INTAKE_LIMITS = {
  textChars: 4000, claimChars: 1000, urlChars: 500,
  evidenceItems: 20, counterItems: 10, totalBytes: 32 * 1024, keyChars: 64,
  dailyRecords: 20,
} as const;

const TOP_KEYS = new Set(['account_id', 'report_id', 'as_of_trade_date', 'idempotency_key', 'corrects_record_id',
  'independent_judgement', 'additional_evidence', 'counter_evidence', 'final_conclusion', 'source']);
const EVIDENCE_KEYS = new Set(['claim', 'kind', 'source_url', 'published_at']);
const KINDS = new Set(['macro', 'industry', 'other']);

export interface ChatgptIntakeResult {
  created: boolean;
  record_id: string;
  content_hash: string;
  evidence_class: EvidenceClass;
}

const shanghaiDate = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

function plain(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(obj: Record<string, unknown>, allowed: Set<string>, name: string): void {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new Error(`${name}: field "${key}" is not accepted (only research text and sourced evidence can be appended)`);
}
function str(value: unknown, name: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new Error(`${name} is required`);
  if (trimmed.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return trimmed;
}
function evidenceList(value: unknown, name: string, max: number, sourceRequired: boolean, nowMs: number) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > max) throw new Error(`${name} exceeds ${max} items`);
  return value.map((raw, index) => {
    const label = `${name}[${index}]`;
    const item = plain(raw, label);
    onlyKeys(item, EVIDENCE_KEYS, label);
    const claim = str(item.claim, `${label}.claim`, INTAKE_LIMITS.claimChars)!;
    const urlText = str(item.source_url, `${label}.source_url`, INTAKE_LIMITS.urlChars, sourceRequired);
    const published = str(item.published_at, `${label}.published_at`, 40, sourceRequired);
    let source_url: string | undefined;
    if (urlText) {
      let url: URL;
      try { url = new URL(urlText); } catch { throw new Error(`${label}.source_url is not a URL`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}.source_url must be a plain http(s) URL`);
      source_url = url.toString();
    }
    let published_at: string | undefined;
    if (published) {
      // Date-only or ISO with timezone; a publication time after "now" would be fabricated.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(published);
      if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(published)) throw new Error(`${label}.published_at requires YYYY-MM-DD or an ISO timestamp with timezone`);
      const ms = Date.parse(dateOnly ? `${published}T00:00:00Z` : published);
      if (!Number.isFinite(ms)) throw new Error(`${label}.published_at is not a valid time`);
      if (ms > nowMs + 5 * 60000) throw new Error(`${label}.published_at is in the future`);
      published_at = published;
    }
    const kind = item.kind === undefined ? 'other' : String(item.kind);
    if (!KINDS.has(kind)) throw new Error(`${label}.kind must be macro, industry or other`);
    return { claim, kind, ...(source_url ? { source_url } : {}), ...(published_at ? { published_at } : {}) };
  });
}

/** Pure validation + normalisation of the client-controlled content (no server fields). */
export function parseIntakeArgs(args: Record<string, unknown>, nowMs: number) {
  const input = plain(args ?? {}, 'arguments');
  onlyKeys(input, TOP_KEYS, 'arguments');
  const asOf = str(input.as_of_trade_date, 'as_of_trade_date', 8)!;
  if (!/^\d{8}$/.test(asOf)) throw new Error('as_of_trade_date requires YYYYMMDD');
  const calendar = new Date(`${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6)}T00:00:00Z`);
  if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10).replace(/-/g, '') !== asOf) throw new Error('as_of_trade_date is not a calendar date');
  if (asOf > shanghaiDate(nowMs)) throw new Error('as_of_trade_date cannot be later than today (Asia/Shanghai)');
  const idempotencyKey = str(input.idempotency_key, 'idempotency_key', INTAKE_LIMITS.keyChars, false);
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new Error('idempotency_key allows only letters, digits and . _ : -');
  const content = {
    independent_judgement: str(input.independent_judgement, 'independent_judgement', INTAKE_LIMITS.textChars)!,
    final_conclusion: str(input.final_conclusion, 'final_conclusion', INTAKE_LIMITS.textChars)!,
    additional_evidence: evidenceList(input.additional_evidence, 'additional_evidence', INTAKE_LIMITS.evidenceItems, true, nowMs),
    counter_evidence: evidenceList(input.counter_evidence, 'counter_evidence', INTAKE_LIMITS.counterItems, false, nowMs),
  };
  if (Buffer.byteLength(canonicalJson(content), 'utf8') > INTAKE_LIMITS.totalBytes) throw new Error(`research content exceeds ${INTAKE_LIMITS.totalBytes} bytes`);
  // goal-1106: the intake tool serves two external-LLM sources. `source`
  // defaults to 'chatgpt' (historical tool name); Hermes callers pass
  // source='hermes'. It is part of the client-request whitelist — everything
  // else about authorship stays server-derived.
  const source = input.source === undefined || input.source === null || input.source === '' ? 'chatgpt' : String(input.source);
  if (source !== 'chatgpt' && source !== 'hermes') throw new Error('source must be chatgpt or hermes');
  return {
    accountId: input.account_id === undefined ? undefined : String(input.account_id),
    reportId: str(input.report_id, 'report_id', 200)!, asOf, idempotencyKey,
    correctsRecordId: str(input.corrects_record_id, 'corrects_record_id', 200, false),
    content,
    source,
  };
}

/**
 * Why no VPS snapshot matched (account + trade date + report_id). Only the exact match links; every other case is
 * refused with a distinct class and nothing is re-bound. Reasons are stable prefixes the caller can branch on.
 */
function missingBundleReason(db: DatabaseSync, accountId: string, reportId: string, asOf: string): string {
  const sameReport = db.prepare("SELECT account_id, as_of_trade_date FROM research_journal WHERE source='vps' AND bundle_id=? LIMIT 10")
    .all(reportId) as { account_id: string; as_of_trade_date: string }[];
  if (sameReport.some(row => row.account_id === accountId)) {
    const date = sameReport.find(row => row.account_id === accountId)!.as_of_trade_date;
    return `trade_date_mismatch: report_id=${reportId} is persisted for ${date}, not as_of_trade_date=${asOf}`;
  }
  if (sameReport.length) return `account_mismatch: report_id=${reportId} is persisted for a different account`;
  const sameDate = db.prepare("SELECT DISTINCT bundle_id FROM research_journal WHERE source='vps' AND account_id=? AND as_of_trade_date=? ORDER BY bundle_id LIMIT 10")
    .all(accountId, asOf) as { bundle_id: string }[];
  if (sameDate.length) {
    return `bundle_identity_mismatch: report_id=${reportId} is not a persisted snapshot; this account's persisted snapshot(s) for ${asOf} are ${sameDate.map(row => row.bundle_id).join(', ')}. Re-read the bundle; its persisted_snapshot field shows whether it matches.`;
  }
  return `bundle_not_found: no VPS research snapshot for report_id=${reportId} as_of_trade_date=${asOf} in this account`;
}

/**
 * Append one ChatGPT research record. `accountId` must already be resolved by the caller;
 * `nowMs` is the server clock (injectable for tests only, never from the client).
 */
export function appendChatgptResearchRecord(db: DatabaseSync, accountId: string, args: Record<string, unknown>, nowMs = Date.now(), dailyLimit: number = INTAKE_LIMITS.dailyRecords,
  options: { market?: DatabaseSync | null; source?: 'chatgpt' | 'hermes' } = {}): ChatgptIntakeResult {
  const parsed = parseIntakeArgs(args, nowMs);
  // options.source (internal callers) overrides the request's source field.
  const source = options.source ?? parsed.source;
  // The existence check, the daily cap and the insert run in one write transaction. Without it, two writers of the
  // same idempotency key both pass the check and the loser hits the journal's no-replace trigger, which reports a
  // retry as an error. With it the loser waits for the lock and then replays the stored row (created:false).
  return inPortfolioTransaction(db, () => appendParsedRecord(db, accountId, { ...parsed, source }, nowMs, dailyLimit, options.market ?? null));
}

function appendParsedRecord(db: DatabaseSync, accountId: string, parsed: ReturnType<typeof parseIntakeArgs>, nowMs: number, dailyLimit: number, market: DatabaseSync | null): ChatgptIntakeResult {
  const source = parsed.source;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_journal'").get()) throw new Error(`bundle_not_found: the research journal has no VPS snapshots yet`);
  const bundles = db.prepare("SELECT record_id FROM research_journal WHERE account_id=? AND source='vps' AND bundle_id=? AND as_of_trade_date=? ORDER BY record_id LIMIT 10")
    .all(accountId, parsed.reportId, parsed.asOf) as { record_id: string }[];
  if (!bundles.length) throw new Error(missingBundleReason(db, accountId, parsed.reportId, parsed.asOf));
  if (parsed.correctsRecordId) {
    const target = readResearchJournal(db, parsed.correctsRecordId);
    // goal-1106: a correction may target either external source — correcting
    // external-LLM research is the same operation regardless of which LLM
    // wrote the original. (Message kept for compatibility.)
    if (!target || target.account_id !== accountId || (target.source !== 'chatgpt' && target.source !== 'hermes')) throw new Error('corrects_record_id must be an existing ChatGPT record of this account');
  }
  const clientHash = createHash('sha256').update(canonicalJson({ ...parsed.content, report_id: parsed.reportId, as_of: parsed.asOf, corrects: parsed.correctsRecordId ?? null })).digest('hex');
  const identity = createHash('sha256').update(canonicalJson({ account: accountId, as_of: parsed.asOf, report: parsed.reportId, key: parsed.idempotencyKey ?? clientHash })).digest('hex').slice(0, 20);
  const recordId = `${source === 'hermes' ? 'HERMES' : 'CHATGPT'}-${parsed.asOf}-${identity}`;
  const existing = readResearchJournal(db, recordId);
  if (existing) {
    if ((existing.payload as any)?.client_content_hash !== clientHash) throw new Error(`journal_id_conflict: ${recordId}; append a correction with a new idempotency_key`);
    return { created: false, record_id: recordId, content_hash: existing.content_hash, evidence_class: classifyRecord(existing) };
  }
  // Daily intake cap counts only new rows, by server receipt time. Both
  // external sources share ONE external-research cap of 20/day (goal-1106):
  // the cap guards write amplification, and per-source sub-caps would only
  // double the budget without changing what the cap protects.
  const dayStart = new Date(Date.parse(`${shanghaiDate(nowMs).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}T00:00:00+08:00`)).toISOString();
  const today = (db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source IN ('chatgpt','hermes') AND recorded_at>=?").get(dayStart) as any).n as number;
  if (today >= dailyLimit) throw new Error(`rate_limited: at most ${dailyLimit} external (chatgpt/hermes) research records per day`);
  const received = new Date(nowMs).toISOString();
  const { content } = parsed;
  // goal-1032 follow-up: the independent research record is bound to the same
  // snapshot version it cites, exactly like the VPS bundle that anchors it.
  // Unbound when no snapshot exists — never guessed.
  const hotspot = resolveHotspotBinding(market, parsed.asOf);
  const result = recordResearchJournal(db, {
    record_id: recordId, account_id: accountId, source: source as 'chatgpt' | 'hermes', as_of_trade_date: parsed.asOf,
    bundle_id: parsed.reportId, generated_at: received,
    versions: { journal: JOURNAL_VERSION, chatgpt_intake: CHATGPT_INTAKE_VERSION },
    judgement: { independent_judgement: content.independent_judgement, final_conclusion: content.final_conclusion },
    candidates: [], observations: [],
    evidence: [
      ...content.additional_evidence.map(item => ({ role: 'additional', ...item })),
      ...content.counter_evidence.map(item => ({ role: 'counter', ...item })),
    ],
    parent_record_ids: bundles.map(row => row.record_id),
    correction_of: parsed.correctsRecordId ?? null,
    // CHATGPT_INTAKE_TOOL names the MCP tool, not the author: the tool name
    // is historical and now serves hermes too, so authorship rides in
    // provenance.author (= source) while source_reference keeps the tool name.
    provenance: { author: source, source_reference: `mcp:${CHATGPT_INTAKE_TOOL}:${parsed.reportId}`, obtained_at: received },
    payload: { kind: 'chatgpt-research-record/1', client_content_hash: clientHash, idempotency_key: parsed.idempotencyKey ?? null, report_id: parsed.reportId, ...content },
  }, hotspot);
  return { created: result.created, record_id: recordId, content_hash: result.record.content_hash, evidence_class: classifyRecord(result.record) };
}
