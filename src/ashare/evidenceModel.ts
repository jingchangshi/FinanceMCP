import { createHash } from 'node:crypto';

/**
 * 统一公开来源证据模型（任务书 §3.3）。
 *
 * 边界：
 * - 本模块是**纯函数 + 纯类型**：不建表、不写库、不发网络请求，不依赖任何冻结模块。
 *   它只定义 15 字段证据记录、登记/读取协议，以及 NEW / UPDATED / UNCHANGED / INVALIDATED
 *   变化状态的确定性推导。落库与接入由调用方决定（bundle 侧只做接入）。
 * - 不生成 ID、不补日期：evidence_id 必须来自调用方（内容哈希可用 `deriveEvidenceId`），
 *   published_at / effective_as_of 缺失时如实为 null 并降低可信度，绝不猜测。
 * - 重复检索旧新闻不得计为新证据：同一目标 + 同一发布日期 + 同一 claim 的登记是
 *   `duplicate`，`counts_as_new_evidence` 恒为 false。
 * - 无法核验来源、发布时间或正文事实的资料不得进入高可信集合
 *   （`highConfidenceSet` 只收 VERIFIED，且剔除来源/事实不可核验与发布时间晚于研究截止）。
 *
 * 与既有两套证据结构的关系（本模块不改动它们）：
 * - `portfolio/evidence.ts` 的 research_evidence：轮动优势门控表；
 * - `portfolio/chatgptIntake.ts` 的 evidence：journal 里的研究事实片段。
 *   两者的字段子集都可以经 `fromChatgptEvidence` / `fromResearchEvidenceProvenance` 映射进来。
 */

export const EVIDENCE_MODEL_SCHEMA = 'ashare-evidence-model/1.0';

// ---------------------------------------------------------------- 15 字段（任务书 §3.3 原文顺序）

export interface EvidenceRecordV1 {
  /** 稳定证据 ID；由调用方给出，或用 deriveEvidenceId 从身份键派生。 */
  evidence_id: string;
  /** 可被检验的主张（一句话；支持/反驳的锚点）。 */
  claim: string;
  /** 可访问来源链接；缺失时降低可信度。 */
  source_url: string | null;
  /** 发布者（媒体、交易所、公司公告渠道）。 */
  publisher: string | null;
  /** 发布时间（ISO 8601）。与 effective_as_of 分开：发布时间 ≠ 事实发生时间。 */
  published_at: string | null;
  /** 检索/取证时间（ISO 8601）。 */
  retrieved_at: string | null;
  /** 事实发生/生效的交易日（YYYYMMDD）。用于区分"什么时候说的"与"什么时候算数"。 */
  effective_as_of: string | null;
  /** 证据指向的对象（ETF/股票代码、账户、指数…）。 */
  target: string | null;
  /** 证据类型（见 EVIDENCE_TYPES；可扩展）。 */
  evidence_type: EvidenceType | (string & {});
  /** 方向：支持该 target、反对该 target，或仅背景材料。 */
  evidence_direction: EvidenceDirection;
  /** 来源质量（见 SOURCE_QUALITIES）。 */
  source_quality: SourceQuality;
  /** 核验状态（见 VERIFICATION_STATUSES）。 */
  verification_status: VerificationStatus;
  /** 原文摘录或定位信息（页码/章节/段落锚点）。 */
  source_excerpt: string | null;
  /** 本证据支持的主张 ID 列表。 */
  supports_claim_ids: string[];
  /** 本证据反驳的主张 ID 列表。 */
  contradicts_claim_ids: string[];
}

/** 证据类型：原始公告与二手新闻必须可分；行业背景与成分股证据必须可分。 */
export const EVIDENCE_TYPES = [
  'PRIMARY_FILING',      // 原始公告/财报/交易所披露
  'SECONDARY_NEWS',      // 二手新闻/转载/报道
  'PRIMARY_INTERVIEW',   // 一手访谈或管理层表态
  'DATASET_SNAPSHOT',    // 结构化数据集快照（成分权重、行情、财务库）
  'INDUSTRY_BACKGROUND', // 行业背景（不直接属于某个成分股）
  'MARKET_DATA',         // 市场行情事实
  'RESEARCH_INFERENCE',  // 研究推断（非外部事实，必须与 FACT 区分）
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_DIRECTIONS = ['SUPPORTS', 'CONTRADICTS', 'BACKGROUND'] as const;
export type EvidenceDirection = (typeof EVIDENCE_DIRECTIONS)[number];

/** 来源质量分档：无法核验来源的资料不进入 HIGH/MEDIUM。 */
export const SOURCE_QUALITIES = ['HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED'] as const;
export type SourceQuality = (typeof SOURCE_QUALITIES)[number];

export const VERIFICATION_STATUSES = ['VERIFIED', 'UNVERIFIED', 'REJECTED', 'REVOKED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// ---------------------------------------------------------------- 附加元数据（15 字段之外的可选扩展）

export interface EvidenceContext {
  /** 资料角色：新证据 / 历史背景。重复出现的旧闻是 BACKGROUND，不是 NEW。 */
  novelty: EvidenceNovelty;
  /** 研究使用角色：外部事实 vs 研究推断（推断必须标为假设，不可冒充事实）。 */
  claim_kind: EvidenceClaimKind;
  /** 证据归属：直接属于标的（如 ETF 成分股），还是行业/宏观背景。 */
  scope: EvidenceScope;
  /** 首次发现时间；重复引用不重置。 */
  first_seen_at: string | null;
  /** 被引用次数（登记协议维护）。 */
  citation_count: number;
  /** 关联的主张 ID（同一主题的 claim 归组，用于跨日状态推导）。 */
  claim_ids: string[];
}

export const EVIDENCE_NOVELTIES = ['NEW', 'BACKGROUND'] as const;
export type EvidenceNovelty = (typeof EVIDENCE_NOVELTIES)[number];
export const EVIDENCE_CLAIM_KINDS = ['FACT', 'INFERENCE'] as const;
export type EvidenceClaimKind = (typeof EVIDENCE_CLAIM_KINDS)[number];
export const EVIDENCE_SCOPES = ['INSTRUMENT', 'INDUSTRY', 'MACRO', 'ACCOUNT'] as const;
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];

export interface EvidenceEntry extends EvidenceRecordV1 {
  /** 内容指纹：由身份键以外的正文字段派生，用于跨日变化推导。 */
  content_hash: string;
  /** 正文修订次数：0 = 首次登记后从未变过（→ NEW），>0 = 曾被更正（→ UPDATED）。 */
  revision: number;
  /** 首次登记时间（ISO 8601）。 */
  first_registered_at: string;
  /** 最近一次登记时间（ISO 8601）。 */
  last_seen_at: string;
  /** 本条证据已失效（来源撤回、被更正、事实被推翻）。 */
  invalidation: EvidenceInvalidation | null;
  context: EvidenceContext;
}

export const EVIDENCE_INVALIDATIONS = ['RETRACTED', 'SUPERSEDED', 'FACT_DISPROVEN', 'SOURCE_REMOVED'] as const;
export type EvidenceInvalidation = (typeof EVIDENCE_INVALIDATIONS)[number];

// ---------------------------------------------------------------- 归一化与登记

const isIso = (value: string) => Number.isFinite(Date.parse(value)) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value);
const isYmd = (value: string) => /^\d{8}$/.test(value)
  && Number.isFinite(Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`))
  && new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`).toISOString().slice(0, 10).replace(/-/g, '') === value;

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function requireText(value: unknown, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new Error(`evidence.${field} is required`);
  return text;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  const text = textOrNull(value);
  if (text === null) return null;
  // chatgptIntake 允许"仅日期"的发布时间（YYYY-MM-DD）；按原样保留，日期切片仍可用。
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!isYmd(text.replace(/-/g, ''))) throw new Error(`evidence.${field} must be a valid date`);
    return text;
  }
  if (!isIso(text)) throw new Error(`evidence.${field} must be an ISO 8601 timestamp with timezone`);
  return text;
}

function optionalYmd(value: unknown, field: string): string | null {
  const text = textOrNull(value);
  if (text === null) return null;
  const compact = text.replace(/-/g, '');
  if (!isYmd(compact)) throw new Error(`evidence.${field} must be a YYYYMMDD date`);
  return compact;
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`evidence.${field} must be an array of IDs`);
  return value.map(item => requireText(item, field));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  const text = textOrNull(value);
  if (text === null) return fallback;
  if (!(allowed as readonly string[]).includes(text)) throw new Error(`evidence.${field} must be one of ${allowed.join('/')}`);
  return text as T;
}

/** 已知类型优先；否则接受大写 token 作为扩展类型（接口允许 `string & {}`）。 */
function evidenceTypeValue(value: unknown, fallback: EvidenceType): EvidenceType {
  const text = textOrNull(value);
  if (text === null) return fallback;
  if ((EVIDENCE_TYPES as readonly string[]).includes(text)) return text as EvidenceType;
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(text)) return text as EvidenceType;
  throw new Error(`evidence.evidence_type must be a known type or an UPPER_SNAKE token`);
}

/**
 * 身份键：与正文分开。变化状态只看正文，所以 claim 之外的原文变化不能把
 * 同一条证据伪装成"新证据"；重复登记同一身份是 duplicate，不是 NEW。
 */
export function evidenceIdentityKey(input: {
  target?: unknown; evidence_type?: unknown; published_at?: unknown; effective_as_of?: unknown; source_url?: unknown;
}): string {
  return JSON.stringify({
    target: textOrNull(input.target),
    evidence_type: textOrNull(input.evidence_type),
    published_at: textOrNull(input.published_at),
    effective_as_of: textOrNull(input.effective_as_of),
    source_url: textOrNull(input.source_url),
  });
}

export function deriveEvidenceId(input: {
  target?: unknown; evidence_type?: unknown; published_at?: unknown; effective_as_of?: unknown; source_url?: unknown;
}): string {
  const digest = createHash('sha256').update(evidenceIdentityKey(input)).digest('hex').slice(0, 20);
  return `EV-${digest}`;
}

/** 正文指纹：身份键之外、影响可信度与主张的字段。 */
function contentHash(body: object): string {
  const source = body as Record<string, unknown>;
  const stable = Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]]));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

/**
 * 输入 → 15 字段记录（严格校验，未知来源/坏时间戳直接拒绝，不做"未知即有效"的降级）。
 * `now` 只影响缺省的 retrieved_at 与 first/last 登记时间，可由调用方固定以便复现。
 */
export function normalizeEvidence(input: Record<string, unknown>, now: Date = new Date()): { record: EvidenceRecordV1; content_hash: string } {
  const retrievedAt = optionalTimestamp(input.retrieved_at ?? now.toISOString(), 'retrieved_at');
  const record: EvidenceRecordV1 = {
    evidence_id: requireText(input.evidence_id, 'evidence_id'),
    claim: requireText(input.claim, 'claim'),
    source_url: textOrNull(input.source_url),
    publisher: textOrNull(input.publisher),
    published_at: optionalTimestamp(input.published_at, 'published_at'),
    retrieved_at: retrievedAt,
    effective_as_of: optionalYmd(input.effective_as_of, 'effective_as_of'),
    target: textOrNull(input.target),
    evidence_type: evidenceTypeValue(input.evidence_type, 'SECONDARY_NEWS'),
    evidence_direction: enumValue(input.evidence_direction, EVIDENCE_DIRECTIONS, 'BACKGROUND', 'evidence_direction'),
    source_quality: enumValue(input.source_quality, SOURCE_QUALITIES, 'UNVERIFIED', 'source_quality'),
    verification_status: enumValue(input.verification_status, VERIFICATION_STATUSES, 'UNVERIFIED', 'verification_status'),
    source_excerpt: textOrNull(input.source_excerpt),
    supports_claim_ids: idList(input.supports_claim_ids, 'supports_claim_ids'),
    contradicts_claim_ids: idList(input.contradicts_claim_ids, 'contradicts_claim_ids'),
  };
  if (record.source_url !== null && !/^https?:\/\//i.test(record.source_url)) throw new Error('evidence.source_url must be an http(s) URL');
  if (record.published_at !== null && retrievedAt !== null && record.published_at > retrievedAt) {
    throw new Error('evidence.published_at must not be later than retrieved_at');
  }
  // 内容指纹只覆盖"说了什么、什么质量"：身份字段（evidence_id）与检索时间不参与，
  // 否则同一份资料第二天再检索一次就会被误判为内容更新（UPDATED）。
  const { evidence_id: _id, retrieved_at: _retrieved, ...body } = record;
  return { record, content_hash: contentHash(body) };
}

export type RegisterOutcome = 'NEW' | 'UPDATED' | 'UNCHANGED' | 'INVALIDATED' | 'DUPLICATE';

export interface EvidenceRegisterResult {
  outcome: RegisterOutcome;
  /** 是否计为新研究证据：重复引用旧资料恒为 false。 */
  counts_as_new_evidence: boolean;
  entry: EvidenceEntry;
}

export interface EvidenceRegisterOptions {
  now?: Date;
  /** 重复登记是否刷新 last_seen_at（默认 true）。 */
  touch?: boolean;
  /** 与既往证据同身份但被更正时的失效理由（配合 previous）。 */
  invalidation?: EvidenceInvalidation;
}

/**
 * 登记一条证据并给出变化状态。确定性：同一 (state, input) 必得同一结果。
 * - 身份未出现过 → NEW（若调用方声明为历史背景则仍为 NEW 登记，但 novelty=BACKGROUND，
 *   `counts_as_new_evidence=false`——旧闻重发不算新证据）。
 * - 身份已在册、正文一致 → UNCHANGED（duplicate，不计新证据）。
 * - 身份已在册、正文不同 → UPDATED（补了来源/更正了摘录），保留 first_seen。
 * - 既有证据已失效，或本次显式给出失效理由 → INVALIDATED。
 */
export function registerEvidence(
  state: ReadonlyMap<string, EvidenceEntry>,
  input: Record<string, unknown>,
  options: EvidenceRegisterOptions = {},
): EvidenceRegisterResult {
  const now = options.now ?? new Date();
  const { record, content_hash } = normalizeEvidence(input, now);
  const previous = state.get(record.evidence_id);
  const novelty = enumValue(input.context_novelty, EVIDENCE_NOVELTIES, 'NEW', 'context.novelty');
  const claimKind = enumValue(input.context_claim_kind, EVIDENCE_CLAIM_KINDS,
    record.evidence_type === 'RESEARCH_INFERENCE' ? 'INFERENCE' : 'FACT', 'context.claim_kind');
  const scope = enumValue(input.context_scope, EVIDENCE_SCOPES,
    record.target && /^\d{6}\.(SH|SZ|BJ)$/.test(record.target) ? 'INSTRUMENT' : 'INDUSTRY', 'context.scope');
  const invalidationRaw = textOrNull(input.invalidation ?? options.invalidation ?? null);
  if (invalidationRaw !== null && !(EVIDENCE_INVALIDATIONS as readonly string[]).includes(invalidationRaw)) {
    throw new Error(`evidence.invalidation must be one of ${EVIDENCE_INVALIDATIONS.join('/')}`);
  }
  const invalidation = invalidationRaw as EvidenceInvalidation | null;
  const touch = options.touch ?? true;
  const firstSeenRaw = textOrNull(input.context_first_seen);
  if (firstSeenRaw !== null && !isIso(firstSeenRaw)) throw new Error('evidence.context_first_seen must be an ISO 8601 timestamp with timezone');

  if (!previous) {
    const stamp = now.toISOString();
    const entry: EvidenceEntry = {
      ...record,
      content_hash,
      revision: 0,
      first_registered_at: stamp,
      last_seen_at: stamp,
      invalidation,
      context: {
        novelty,
        claim_kind: claimKind,
        scope,
        first_seen_at: firstSeenRaw ?? stamp,
        citation_count: 1,
        claim_ids: [...new Set([...record.supports_claim_ids, ...record.contradicts_claim_ids])].sort(),
      },
    };
    return {
      outcome: invalidation ? 'INVALIDATED' : 'NEW',
      counts_as_new_evidence: !invalidation && novelty === 'NEW',
      entry,
    };
  }

  const sameContent = previous.content_hash === content_hash;
  const merged: EvidenceEntry = {
    ...previous,
    ...record,
    content_hash: sameContent ? previous.content_hash : content_hash,
    revision: sameContent ? previous.revision : previous.revision + 1,
    last_seen_at: touch ? now.toISOString() : previous.last_seen_at,
    first_registered_at: previous.first_registered_at,
    invalidation: invalidation ?? previous.invalidation,
    context: {
      ...previous.context,
      novelty: novelty === 'BACKGROUND' || previous.context.novelty === 'BACKGROUND' ? 'BACKGROUND' : previous.context.novelty,
      scope,
      citation_count: previous.context.citation_count + (touch ? 1 : 0),
      claim_ids: [...new Set([...previous.context.claim_ids,
        ...record.supports_claim_ids, ...record.contradicts_claim_ids])].sort(),
    },
  };
  if (merged.invalidation) {
    return { outcome: 'INVALIDATED', counts_as_new_evidence: false, entry: merged };
  }
  if (sameContent) return { outcome: 'UNCHANGED', counts_as_new_evidence: false, entry: merged };
  return { outcome: 'UPDATED', counts_as_new_evidence: false, entry: merged };
}

/**
 * 显式撤销/推翻一条已登记证据（来源撤回、事实被更正）。只改失效标记与状态，
 * 不删除记录、不改正文——审计需要看到"曾经可信、何时失效"。
 */
export function invalidateEvidence(
  state: ReadonlyMap<string, EvidenceEntry>,
  evidenceId: string,
  reason: EvidenceInvalidation,
  now: Date = new Date(),
): EvidenceEntry | null {
  const previous = state.get(evidenceId);
  if (!previous) return null;
  if (!(EVIDENCE_INVALIDATIONS as readonly string[]).includes(reason)) {
    throw new Error(`invalidation reason must be one of ${EVIDENCE_INVALIDATIONS.join('/')}`);
  }
  return {
    ...previous,
    invalidation: reason,
    last_seen_at: now.toISOString(),
    context: { ...previous.context, citation_count: previous.context.citation_count },
  };
}

/** 按目标 + 读取日推导每个证据的变化状态（NEW / UPDATED / UNCHANGED / INVALIDATED）。 */
export function deriveEvidenceStatus(
  state: ReadonlyMap<string, EvidenceEntry>,
  asOf?: string,
): Map<string, EvidenceStatus> {
  const status = new Map<string, EvidenceStatus>();
  for (const [id, entry] of state) {
    status.set(id, deriveEvidenceStatusFor(entry, asOf));
  }
  return status;
}

export type EvidenceStatus = 'NEW' | 'UPDATED' | 'UNCHANGED' | 'INVALIDATED';

function deriveEvidenceStatusFor(entry: EvidenceEntry, asOf?: string): EvidenceStatus {
  if (entry.invalidation) return 'INVALIDATED';
  if (asOf) {
    // 事实生效日晚于研究截止：不能算作该研究日的已成立证据。
    if (entry.effective_as_of !== null && entry.effective_as_of > asOf) return 'INVALIDATED';
    if (entry.published_at !== null && entry.published_at.slice(0, 10).replace(/-/g, '') > asOf) return 'INVALIDATED';
  }
  if (entry.revision > 0) return 'UPDATED';
  // NEW 只给"研究截止日当天首次出现"的证据：更早出现的是历史背景（重复引用不算新证据）。
  const firstDay = entry.context.first_seen_at?.slice(0, 10).replace(/-/g, '') ?? null;
  if (asOf ? firstDay === asOf : entry.context.citation_count === 1) {
    return entry.context.novelty === 'NEW' ? 'NEW' : 'UNCHANGED';
  }
  return 'UNCHANGED';
}

// ---------------------------------------------------------------- 可信度与去重

export interface HighConfidenceExclusion {
  evidence_id: string;
  reason:
    | 'verification_not_verified'
    | 'source_unverifiable'
    | 'source_or_claim_unlocatable'
    | 'published_after_research_cutoff'
    | 'effective_after_research_cutoff'
    | 'no_source_url'
    | 'invalidated';
}

/**
 * 高可信证据集合：只收 VERIFIED、来源可核验（有 URL、质量非 UNVERIFIED/LOW）、
 * 有正文定位（摘录或发布者）、且发布时间/生效时间不晚于研究截止的证据。
 * 任何一条不满足都被剔除并给出理由——不把"无法核验"静默当成可信。
 */
export function highConfidenceSet(
  entries: Iterable<EvidenceEntry>,
  options: { asOf?: string } = {},
): { included: EvidenceEntry[]; excluded: HighConfidenceExclusion[] } {
  const included: EvidenceEntry[] = [];
  const excluded: HighConfidenceExclusion[] = [];
  for (const entry of entries) {
    const reason = highConfidenceExclusion(entry, options.asOf);
    if (reason) excluded.push({ evidence_id: entry.evidence_id, reason });
    else included.push(entry);
  }
  return { included, excluded };
}

export function highConfidenceExclusion(entry: EvidenceEntry, asOf?: string): HighConfidenceExclusion['reason'] | null {
  if (entry.invalidation) return 'invalidated';
  if (entry.verification_status !== 'VERIFIED') return 'verification_not_verified';
  if (entry.source_quality === 'UNVERIFIED' || entry.source_quality === 'LOW') return 'source_unverifiable';
  if (entry.source_url === null) return 'no_source_url';
  if (entry.source_excerpt === null && entry.publisher === null) return 'source_or_claim_unlocatable';
  if (asOf) {
    if (entry.published_at !== null && entry.published_at.slice(0, 10).replace(/-/g, '') > asOf) return 'published_after_research_cutoff';
    if (entry.effective_as_of !== null && entry.effective_as_of > asOf) return 'effective_after_research_cutoff';
  }
  return null;
}

export interface EvidenceDedupResult {
  unique: EvidenceEntry[];
  duplicates: { evidence_id: string; duplicate_of: string; reason: 'same_claim_same_source' | 'same_content' }[];
}

/**
 * 去重：同一发布日期 + 同一来源 + 同一 claim（或正文完全一致）视为同一份资料的重复引用。
 * 输出只保留一份，重复项不参与"新增证据"计数。
 */
export function dedupeEvidence(entries: Iterable<EvidenceEntry>): EvidenceDedupResult {
  const unique: EvidenceEntry[] = [];
  const duplicates: EvidenceDedupResult['duplicates'] = [];
  const byClaimSource = new Map<string, string>();
  const byContent = new Map<string, string>();
  for (const entry of entries) {
    const contentKey = entry.content_hash;
    if (byContent.has(contentKey)) {
      duplicates.push({ evidence_id: entry.evidence_id, duplicate_of: byContent.get(contentKey)!, reason: 'same_content' });
      continue;
    }
    const claimKey = JSON.stringify({
      published_day: entry.published_at?.slice(0, 10) ?? null,
      publisher: entry.publisher,
      claim: entry.claim,
    });
    if (byClaimSource.has(claimKey)) {
      duplicates.push({ evidence_id: entry.evidence_id, duplicate_of: byClaimSource.get(claimKey)!, reason: 'same_claim_same_source' });
      continue;
    }
    byContent.set(contentKey, entry.evidence_id);
    byClaimSource.set(claimKey, entry.evidence_id);
    unique.push(entry);
  }
  return { unique, duplicates };
}

// ---------------------------------------------------------------- 汇总

export interface EvidenceStateSummary {
  schema: string;
  as_of: string | null;
  /** 去重（同一正文只留一条）之后的证据条数。 */
  total: number;
  /** 被判定为同一份资料重复引用的条数（不计入 total，也不计新证据）。 */
  duplicate_count: number;
  by_status: Record<EvidenceStatus, number>;
  by_type: Record<string, number>;
  by_direction: Record<EvidenceDirection, number>;
  by_novelty: Record<EvidenceNovelty, number>;
  by_scope: Record<EvidenceScope, number>;
  /** 真正计为新研究证据的条数（重复引用旧闻不计）。 */
  new_evidence_count: number;
  invalidated_count: number;
  high_confidence: { included: number; excluded: HighConfidenceExclusion[] };
}

export function summarizeEvidenceState(
  state: ReadonlyMap<string, EvidenceEntry>,
  options: { asOf?: string } = {},
): EvidenceStateSummary {
  // 先按正文去重：同一份资料换个 ID 再登记一次，汇总层只算一条。
  const { unique, duplicates } = dedupeEvidence(state.values());
  const statuses = deriveEvidenceStatus(state, options.asOf);
  const byStatus: Record<EvidenceStatus, number> = { NEW: 0, UPDATED: 0, UNCHANGED: 0, INVALIDATED: 0 };
  const byType: Record<string, number> = {};
  const byDirection: Record<EvidenceDirection, number> = { SUPPORTS: 0, CONTRADICTS: 0, BACKGROUND: 0 };
  const byNovelty: Record<EvidenceNovelty, number> = { NEW: 0, BACKGROUND: 0 };
  const byScope: Record<EvidenceScope, number> = { INSTRUMENT: 0, INDUSTRY: 0, MACRO: 0, ACCOUNT: 0 };
  let newEvidenceCount = 0;
  for (const entry of unique) {
    byStatus[statuses.get(entry.evidence_id)!]++;
    byType[entry.evidence_type] = (byType[entry.evidence_type] ?? 0) + 1;
    byDirection[entry.evidence_direction]++;
    byNovelty[entry.context.novelty]++;
    byScope[entry.context.scope]++;
    if (statuses.get(entry.evidence_id) === 'NEW' && entry.context.novelty === 'NEW') newEvidenceCount++;
  }
  const { included, excluded } = highConfidenceSet(unique, options);
  return {
    schema: EVIDENCE_MODEL_SCHEMA,
    as_of: options.asOf ?? null,
    total: unique.length,
    duplicate_count: duplicates.length,
    by_status: byStatus,
    by_type: byType,
    by_direction: byDirection,
    by_novelty: byNovelty,
    by_scope: byScope,
    new_evidence_count: newEvidenceCount,
    invalidated_count: byStatus.INVALIDATED,
    high_confidence: { included: included.length, excluded },
  };
}

// ---------------------------------------------------------------- 既有结构的映射（接入点）

/**
 * ChatGPT 追加协议的 evidence 片段（chatgptIntake 只允许 claim/kind/source_url/published_at）。
 * 缺失字段一律 null，不补造：发布者、生效日、摘录留空并因此进不了高可信集合。
 */
export function fromChatgptEvidence(item: {
  claim?: unknown; kind?: unknown; source_url?: unknown; published_at?: unknown; role?: unknown;
  target?: unknown; as_of?: unknown;
}, options: { retrievedAt?: string; target?: string | null; effectiveAsOf?: string | null; novelty?: EvidenceNovelty } = {}): Record<string, unknown> {
  const kind = String(item.kind ?? 'other');
  const type: EvidenceType = kind === 'macro' || kind === 'industry'
    ? 'INDUSTRY_BACKGROUND' : 'SECONDARY_NEWS';
  const direction: EvidenceDirection = item.role === 'counter' ? 'CONTRADICTS' : 'SUPPORTS';
  const effectiveAsOf = options.effectiveAsOf
    ?? (typeof item.as_of === 'string' ? item.as_of.replace(/-/g, '') : null);
  const base = {
    claim: String(item.claim ?? ''),
    source_url: typeof item.source_url === 'string' && item.source_url ? item.source_url : null,
    publisher: null,
    published_at: typeof item.published_at === 'string' && item.published_at ? item.published_at : null,
    retrieved_at: options.retrievedAt ?? null,
    effective_as_of: effectiveAsOf,
    target: options.target ?? null,
    evidence_type: type,
    evidence_direction: direction,
    source_quality: 'UNVERIFIED',
    verification_status: 'UNVERIFIED',
    source_excerpt: null,
    supports_claim_ids: [],
    contradicts_claim_ids: [],
    // 追加协议不携带新颖性信息：默认按历史背景处理（保守方向，绝不把未知标成新证据），
    // 调用方可通过 options.novelty 显式声明该条为当日新证据。
    context_novelty: options.novelty ?? ('BACKGROUND' as EvidenceNovelty),
    context_claim_kind: 'FACT' as const,
    context_scope: kind === 'macro' ? 'MACRO' : kind === 'industry' ? 'INDUSTRY' : 'INSTRUMENT',
  };
  return { ...base, evidence_id: deriveEvidenceId(base) };
}

/**
 * portfolio/evidence.ts 的 research_evidence 记录（轮动优势门控）→ 统一证据模型。
 * 注意：其 provenance 里的 source 是内部来源标签，不是公开 URL，因此 source_url 留 null、
 * 质量标 UNVERIFIED——内部信号证据不得冒充公开来源高可信证据。
 */
export function fromResearchEvidenceProvenance(record: {
  evidence_id: string; provenance?: { source?: string; claim?: string; observation_type?: string } | null;
  as_of?: string; buy_code?: string; sell_code?: string; recorded_at?: string;
  status?: string;
}): Record<string, unknown> {
  const target = record.sell_code ? `${record.buy_code}->${record.sell_code}` : record.buy_code ?? null;
  const base = {
    claim: String(record.provenance?.claim ?? record.provenance?.source ?? record.evidence_id),
    source_url: null,
    publisher: record.provenance?.source ?? null,
    published_at: null,
    retrieved_at: record.recorded_at ?? null,
    effective_as_of: record.as_of ? String(record.as_of).replace(/-/g, '') : null,
    target,
    evidence_type: 'DATASET_SNAPSHOT' as EvidenceType,
    evidence_direction: 'SUPPORTS' as EvidenceDirection,
    source_quality: 'UNVERIFIED' as SourceQuality,
    verification_status: 'UNVERIFIED' as VerificationStatus,
    source_excerpt: null,
    supports_claim_ids: [],
    contradicts_claim_ids: [],
    context_novelty: 'BACKGROUND' as const,
    context_claim_kind: 'FACT' as const,
    context_scope: 'INSTRUMENT' as const,
    // 轮动门控里被撤回（REVOKED）的证据在统一模型里就是已失效。
    ...(record.status === 'REVOKED' ? { invalidation: 'RETRACTED' as EvidenceInvalidation } : {}),
  };
  return { ...base, evidence_id: deriveEvidenceId({ ...base, evidence_type: record.provenance?.observation_type ?? null }) };
}
