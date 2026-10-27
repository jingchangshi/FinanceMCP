import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  canonicalJson, evaluateResearchJournal, evaluateDirectionalWindow, listResearchJournal, readResearchJournal,
  JOURNAL_VERSION, type JournalEvaluation, type JournalFeeEstimator, type JournalRecord,
} from './researchJournal.js';
import {
  classifyRecord, MIN_NON_OVERLAPPING_WINDOWS, TRUE_FORWARD_START, type EvidenceClass,
} from './forwardReview.js';
import { buildBenchmarkComparison, FROZEN_FIVE_START_DATE, type BenchmarkResult } from './benchmarks.js';
import { inPortfolioTransaction } from './db.js';

/**
 * goal-1026 §7.2/§7.3：结构化研究判断单元 + 三层研究价值评价（只读）。
 *
 * 边界（§7.1 不可变记录约束）：
 * - **绝不** DELETE/UPDATE/RECLASSIFY 任何既有 VPS/ChatGPT 研究日志：本模块只新增独立表
 *   `research_thesis`（同样以触发器禁止 UPDATE/DELETE/REPLACE），旧记录读取路径
 *   （readResearchJournal/listResearchJournal）原样复用。`CHATGPT-20261023-0f5a44183869e077bae1`
 *   这类补录保持 RETROSPECTIVE_RECORD：判断单元继承父记录的补录属性，只能落在补录分层。
 * - append-only：判断单元只追加；更正通过新单元（corrects_thesis_id）表达，不改旧单元。
 * - 写入内容绝不含 token/凭证；入参严格白名单，未知字段整次拒绝（与 chatgptIntake 一致）。
 * - 评价函数纯只读：输入研究日志 + 行情缓存/费用估计器，输出三层×六指标结构；无成熟样本
 *   一律 PENDING，无真实记录不补造任何历史表现。
 *
 * 三层（§7.3）：vps / chatgpt / combined，按判断单元父记录的 source 分层。
 * 六指标：事实预测正确率、相对收益判断有效性、风险预测有效性、反事实组合收益、
 * 费用后风险调整收益、相对简单 HOLD/被动基准的增量价值。
 * 每个指标按证据分类分桶（TRUE_FORWARD / PRE_FORWARD_HISTORICAL / RETROSPECTIVE_RECORD），
 * 前瞻与补录**分开统计**，绝不合并。
 */

export const RESEARCH_THESIS_VERSION = 'research-thesis-20261026-v1';
export const RESEARCH_EVAL_SCHEMA = 'research-eval/1.0';
export const THESIS_APPEND_TOOL = 'ashare_research_thesis_append';
export const THESIS_EVAL_TOOL = 'ashare_research_eval';

export const EVAL_LAYERS = ['vps', 'chatgpt', 'combined'] as const;
export type EvalLayer = typeof EVAL_LAYERS[number];
export const THESIS_DIRECTIONS = ['bullish', 'bearish', 'neutral', 'conditional', 'evidence_insufficient'] as const;
export type ThesisDirection = typeof THESIS_DIRECTIONS[number];
export const THESIS_HORIZONS = ['scalp', 'intraday', 'swing', 'position', 'long_term', 'unspecified'] as const;
export type ThesisHorizon = typeof THESIS_HORIZONS[number];
/** 判断单元可否进入评价，由父记录的证据分类**服务端推导**，调用方不能声称（不能把补录改判为前瞻）。
 * 成熟度（not_matured/matured）是评价时点的动态状态，不写入单元。 */
export const THESIS_ELIGIBILITY = ['eligible', 'historical', 'excluded_retrospective'] as const;
export type ThesisEligibility = typeof THESIS_ELIGIBILITY[number];

/** One structured research judgment, appended beside the natural-language journal records.
 * confidence 是**未校准的主观量**，不是精确概率；中性 / 证据不足 / 条件性判断均合法。
 * account_id / created_at / evaluation_eligibility / parent_evidence_class / thesis_id
 * 全部由服务端生成，调用方传入即拒绝。 */
export interface ThesisInput {
  thesis_id: string;
  account_id: string;
  parent_record_id: string;
  target: string;
  direction: ThesisDirection;
  horizon: ThesisHorizon;
  benchmark: string | null;
  evidence_refs: string[];
  confidence: number | null;
  trigger: string | null;
  invalidation: string | null;
  baseline_assessment: string;
  revised_assessment: string | null;
  decision_impact: string | null;
  created_at: string;
  evaluation_eligibility: ThesisEligibility;
  parent_evidence_class: EvidenceClass;
  corrects_thesis_id: string | null;
}
export type ThesisRecord = ThesisInput & { account_id: string; content_hash: string; recorded_at: string };

// ---------------------------------------------------------------- 7.2 判断单元存储（append-only）

const THESIS_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_thesis (
 thesis_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, parent_record_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, content_json TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_thesis_account_date ON research_thesis(account_id, parent_record_id);
CREATE TRIGGER IF NOT EXISTS research_thesis_no_replace BEFORE INSERT ON research_thesis
 WHEN EXISTS (SELECT 1 FROM research_thesis WHERE thesis_id=NEW.thesis_id)
 BEGIN SELECT RAISE(ABORT,'research_thesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_thesis_no_update BEFORE UPDATE ON research_thesis BEGIN SELECT RAISE(ABORT,'research_thesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_thesis_no_delete BEFORE DELETE ON research_thesis BEGIN SELECT RAISE(ABORT,'research_thesis is immutable'); END;
`;

function thesisTable(db: DatabaseSync | null | undefined): boolean {
  return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_thesis'").get();
}

function thesisHash(record: ThesisRecord | ThesisInput): string {
  // canonicalJson drops undefined keys, so spreading and nulling the two storage columns
  // hashes exactly the content columns（含服务端 created_at，用于落库完整性校验）。
  return createHash('sha256').update(canonicalJson({ ...record, content_hash: undefined, recorded_at: undefined })).digest('hex');
}

/** 幂等键只对**客户端内容 + 服务端确定性推导字段**敏感：不含 created_at（不同时钟的重放
 * 必须幂等），也不含落库列 content_hash/recorded_at（ThesisRecord 上才有）——同键同内容 →
 * created:false，同键不同内容 → thesis_id_conflict。与 chatgptIntake 的 client_content_hash 口径一致。 */
function clientDigest(record: ThesisInput | ThesisRecord): string {
  return createHash('sha256').update(canonicalJson({
    ...record, created_at: undefined, content_hash: undefined, recorded_at: undefined,
  })).digest('hex');
}

function checkedThesisRow(row: any): ThesisRecord {
  const content = JSON.parse(row.content_json);
  if (thesisHash(content) !== row.content_hash || content.thesis_id !== row.thesis_id
    || content.account_id !== row.account_id || content.parent_record_id !== row.parent_record_id) {
    throw new Error(`thesis_integrity_error: ${row.thesis_id}`);
  }
  return { ...content, content_hash: row.content_hash, recorded_at: row.recorded_at };
}

export function readResearchThesis(db: DatabaseSync, id: string): ThesisRecord | null {
  if (!thesisTable(db)) return null;
  const row = db.prepare('SELECT * FROM research_thesis WHERE thesis_id=?').get(id) as any;
  return row ? checkedThesisRow(row) : null;
}

export function listResearchThesis(db: DatabaseSync, input: { accountId: string; parentRecordId?: string; limit?: number }): ThesisRecord[] {
  if (!thesisTable(db)) return [];
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 500)));
  const rows = input.parentRecordId
    ? db.prepare('SELECT * FROM research_thesis WHERE account_id=? AND parent_record_id=? ORDER BY recorded_at, thesis_id LIMIT ?').all(input.accountId, input.parentRecordId, limit)
    : db.prepare('SELECT * FROM research_thesis WHERE account_id=? ORDER BY recorded_at, thesis_id LIMIT ?').all(input.accountId, limit);
  return (rows as any[]).map(checkedThesisRow);
}

const ymdCheck = (value: string, name: string) => {
  if (!/^\d{8}$/.test(value)) throw new Error(`${name} requires YYYYMMDD`);
  const d = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10).replace(/-/g, '') !== value) throw new Error(`${name} is not a calendar date`);
};

/** Pure validation + normalisation of caller content; server clocks and account identity never come from the client. */
export function parseThesisArgs(args: Record<string, unknown>, accountHint?: string) {
  const input = (args ?? {}) as Record<string, unknown>;
  const allowed = new Set(['account_id', 'parent_record_id', 'target', 'direction', 'horizon', 'benchmark',
    'evidence_refs', 'confidence', 'trigger', 'invalidation', 'baseline_assessment', 'revised_assessment',
    'decision_impact', 'corrects_thesis_id', 'thesis_id']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`field "${key}" is not accepted (structured judgement only; no credentials, holdings or orders)`);
  }
  const text = (value: unknown, name: string, max: number, required = true): string | undefined => {
    if (value === undefined || value === null || value === '') {
      if (required) throw new Error(`${name} is required`);
      return undefined;
    }
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    const trimmed = value.trim();
    if (!trimmed && required) throw new Error(`${name} is required`);
    if (trimmed.length > max) throw new Error(`${name} exceeds ${max} characters`);
    return trimmed;
  };
  const parentRecordId = text(input.parent_record_id, 'parent_record_id', 200)!;
  const target = text(input.target, 'target', 120)!;
  const direction = text(input.direction, 'direction', 40)!;
  if (!(THESIS_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new Error(`direction must be one of ${THESIS_DIRECTIONS.join(', ')}（允许中性/证据不足/条件性判断，不强制看多看空）`);
  }
  const horizon = text(input.horizon, 'horizon', 40)!;
  if (!(THESIS_HORIZONS as readonly string[]).includes(horizon)) throw new Error(`horizon must be one of ${THESIS_HORIZONS.join(', ')}`);
  let confidence: number | undefined;
  if (input.confidence !== undefined && input.confidence !== null) {
    confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be a number in [0,1]（未校准主观量，不是精确概率）');
  }
  let evidenceRefs: string[] = [];
  if (input.evidence_refs !== undefined && input.evidence_refs !== null) {
    if (!Array.isArray(input.evidence_refs)) throw new Error('evidence_refs must be an array');
    if (input.evidence_refs.length > 40) throw new Error('evidence_refs exceeds 40 items');
    evidenceRefs = input.evidence_refs.map((ref, i) => text(ref, `evidence_refs[${i}]`, 200)!);
  }
  const thesisId = text(input.thesis_id, 'thesis_id', 200, false);
  if (thesisId !== undefined && !/^[A-Za-z0-9._:-]+$/.test(thesisId)) throw new Error('thesis_id allows only letters, digits and . _ : -');
  return {
    accountId: input.account_id === undefined ? accountHint : String(input.account_id),
    parentRecordId, target,
    direction: direction as ThesisDirection, horizon: horizon as ThesisHorizon,
    benchmark: text(input.benchmark, 'benchmark', 120, false),
    evidence_refs: evidenceRefs,
    confidence,
    trigger: text(input.trigger, 'trigger', 1000, false),
    invalidation: text(input.invalidation, 'invalidation', 1000, false),
    baseline_assessment: text(input.baseline_assessment, 'baseline_assessment', 4000)!,
    revised_assessment: text(input.revised_assessment, 'revised_assessment', 4000, false),
    decision_impact: text(input.decision_impact, 'decision_impact', 2000, false),
    correctsThesisId: text(input.corrects_thesis_id, 'corrects_thesis_id', 200, false),
    explicitThesisId: thesisId,
  };
}

export interface ThesisAppendResult {
  created: boolean;
  thesis_id: string;
  content_hash: string;
  parent_record_id: string;
  parent_evidence_class: EvidenceClass;
  evaluation_eligibility: ThesisEligibility;
}

/** 证据分类 → 评价资格的**唯一**推导点：补录（RETROSPECTIVE_RECORD）永不因为调用方声明而变成前瞻。 */
function eligibilityOf(parentClass: EvidenceClass): ThesisEligibility {
  return parentClass === 'TRUE_FORWARD' ? 'eligible' : parentClass === 'PRE_FORWARD_HISTORICAL' ? 'historical' : 'excluded_retrospective';
}

/**
 * Append one structured thesis unit (§7.2). 与 `appendChatgptResearchRecord` 同一边界：
 * 必须引用一条已存在的研究日志记录（三层任一 source），证据分类与评价资格从父记录推导，
 * 同 thesis_id 同内容幂等、同 id 不同内容拒绝；更正用新单元 + corrects_thesis_id。
 * `nowMs` 是服务端时钟（测试可注入），调用方无法提供 created_at。
 */
export function appendResearchThesis(db: DatabaseSync, accountId: string, args: Record<string, unknown>, nowMs = Date.now()): ThesisAppendResult {
  const parsed = parseThesisArgs(args, accountId);
  if (parsed.accountId !== accountId) throw new Error('account_id mismatch: thesis must belong to the resolved account');
  return inPortfolioTransaction(db, () => appendParsedThesis(db, accountId, parsed, nowMs));
}

function appendParsedThesis(db: DatabaseSync, accountId: string, parsed: ReturnType<typeof parseThesisArgs>, nowMs: number): ThesisAppendResult {
  db.exec(THESIS_SCHEMA);
  const parent = readResearchJournal(db, parsed.parentRecordId);
  if (!parent) throw new Error('parent_record_id must reference an existing research journal record');
  if (parent.account_id !== accountId) throw new Error('parent_record_id belongs to a different account');
  if (parsed.correctsThesisId) {
    const target = readResearchThesis(db, parsed.correctsThesisId);
    if (!target || target.account_id !== accountId) throw new Error('corrects_thesis_id must be an existing thesis of this account');
  }
  const parentClass = classifyRecord(parent);
  const eligibility = eligibilityOf(parentClass);
  const createdAt = new Date(nowMs).toISOString();
  const identity: ThesisInput = {
    thesis_id: parsed.explicitThesisId ?? '',
    account_id: accountId,
    parent_record_id: parsed.parentRecordId,
    target: parsed.target,
    direction: parsed.direction,
    horizon: parsed.horizon,
    benchmark: parsed.benchmark ?? null,
    evidence_refs: parsed.evidence_refs,
    confidence: parsed.confidence ?? null,
    trigger: parsed.trigger ?? null,
    invalidation: parsed.invalidation ?? null,
    baseline_assessment: parsed.baseline_assessment,
    revised_assessment: parsed.revised_assessment ?? null,
    decision_impact: parsed.decision_impact ?? null,
    created_at: createdAt,
    evaluation_eligibility: eligibility,
    parent_evidence_class: parentClass,
    corrects_thesis_id: parsed.correctsThesisId ?? null,
  };
  // thesis_id 缺省由**客户端内容**派生（排除服务端 created_at）：同一内容在任何时钟下
  // 重放都指向同一 id，从而幂等；显式 id 的冲突判定同样只看 clientDigest——同键同内容
  // → created:false（幂等重放），同键不同内容 → thesis_id_conflict。落库 content_hash
  // 仍由 thesisHash（含 created_at）计算，保证行内完整性。
  const derived = `THESIS-${parent.as_of_trade_date}-${clientDigest({ ...identity, thesis_id: '' }).slice(0, 20)}`;
  const thesisId = parsed.explicitThesisId || derived;
  const record: ThesisInput = { ...identity, thesis_id: thesisId };
  const digest = thesisHash(record);
  const existing = readResearchThesis(db, thesisId);
  if (existing) {
    if (clientDigest(existing) !== clientDigest(record)) throw new Error(`thesis_id_conflict: ${thesisId}; append a correction with a new thesis_id/corrects_thesis_id`);
    return { created: false, thesis_id: thesisId, content_hash: existing.content_hash, parent_record_id: parsed.parentRecordId, parent_evidence_class: parentClass, evaluation_eligibility: eligibility };
  }
  const recordedAt = new Date(nowMs).toISOString();
  db.prepare('INSERT INTO research_thesis VALUES (?,?,?,?,?,?)').run(thesisId, accountId, parsed.parentRecordId, digest, canonicalJson(record), recordedAt);
  return { created: true, thesis_id: thesisId, content_hash: digest, parent_record_id: parsed.parentRecordId, parent_evidence_class: parentClass, evaluation_eligibility: eligibility };
}

// ---------------------------------------------------------------- 7.3 三层×六指标评价（只读）

export const EVAL_METRIC_IDS = [
  'fact_prediction_accuracy',
  'relative_return_effectiveness',
  'risk_prediction_effectiveness',
  'counterfactual_portfolio_return',
  'after_fee_risk_adjusted_return',
  'incremental_value_vs_hold',
] as const;
export type EvalMetricId = typeof EVAL_METRIC_IDS[number];

export const METRIC_LABELS: Record<EvalMetricId, string> = {
  fact_prediction_accuracy: '事实预测正确率',
  relative_return_effectiveness: '相对收益判断有效性',
  risk_prediction_effectiveness: '风险预测有效性',
  counterfactual_portfolio_return: '反事实组合收益',
  after_fee_risk_adjusted_return: '费用后风险调整收益',
  incremental_value_vs_hold: '相对简单 HOLD / 被动基准的增量价值',
};

/** 每层×每指标一个桶：无真实记录 NO_RECORDS；有记录但无成熟样本 PENDING（附原因）；有成熟样本才 EVALUATED。
 * 统计值只来自 TRUE_FORWARD 分桶；补录（RETROSPECTIVE_RECORD）永远只有计数、没有表现值。 */
export interface MetricBucket {
  status: 'PENDING' | 'EVALUATED' | 'NO_RECORDS';
  sample_size: number;
  pending: number;
  unavailable: number;
  pending_reasons: Record<string, number>;
  unavailable_reasons: Record<string, number>;
  by_class: Record<EvidenceClass, { sample_size: number; excluded: number; pending: number; pending_reasons: Record<string, number> }>;
  note: string | null;
  value: unknown;
}

export type LayerMetrics = Record<EvalMetricId, MetricBucket>;

const NO_RECORDS_NOTE = '该层没有真实记录；不补造历史表现。';
const EMPTY_CLASS_BLOCK: MetricBucket['by_class'] = {
  TRUE_FORWARD: { sample_size: 0, excluded: 0, pending: 0, pending_reasons: {} },
  PRE_FORWARD_HISTORICAL: { sample_size: 0, excluded: 0, pending: 0, pending_reasons: {} },
  RETROSPECTIVE_RECORD: { sample_size: 0, excluded: 0, pending: 0, pending_reasons: {} },
};

function emptyByClass(): MetricBucket['by_class'] { return EMPTY_CLASS_BLOCK; }

function bucket(status: MetricBucket['status'], sampleSize: number, pending: number, unavailable: number, reasons: Record<string, number>, unavailableReasons: Record<string, number>, note: string | null, value: unknown, byClass: MetricBucket['by_class']): MetricBucket {
  return { status, sample_size: sampleSize, pending, unavailable, pending_reasons: reasons, unavailable_reasons: unavailableReasons, by_class: byClass, note, value };
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const mean = (v: number[]) => v.length ? round(v.reduce((s, x) => s + x, 0) / v.length) : null;
const stdev = (v: number[]) => {
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return round(Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)));
};
const rate = (hit: number, total: number) => (total ? round(hit / total) : null);

const BENCHMARK_IDS = ['csi300_etf_buy_hold', 'frozen_multi_asset_basket', 'initial_five_etf_basket'] as const;
type BenchmarkId = typeof BENCHMARK_IDS[number];

const DEFAULT_HORIZONS = [5, 10, 20, 60];

function noRecordBuckets(note: string): LayerMetrics {
  const out = {} as LayerMetrics;
  for (const id of EVAL_METRIC_IDS) out[id] = bucket('NO_RECORDS', 0, 0, 0, {}, {}, note, null, EMPTY_CLASS_BLOCK);
  return out;
}

const FORWARDED_ONLY_NOTE = '规则冻结前的记录只计数、不进入表现统计（与 forward_review 的前瞻规则一致）；补录记录单独分层，不与前瞻合并。';
const DIRECTIONAL_CAVEAT = '一次方向判断正确 ≠ 投资决策成功；命中率只描述已记录判断的事后对照，不构成交易绩效。';

/** True-forward 评价窗口（仅 TRUE_FORWARD 记录、分析期限已成熟的窗口）。 */
interface RecordWindow {
  record: JournalRecord;
  maturity: string;
  net: number;
  maxDrawdown: number;
  excess: Record<BenchmarkId, number | null>;
  benchVol: number | null;
  benchMdd: number | null;
  triggerDefined: number; triggerMet: number;
  invalidationDefined: number; invalidationBreached: number;
}

/** 判断单元在父记录（或同交易日 VPS 窗口）上的可评价视图。 */
interface UnitView {
  unit: ThesisRecord;
  layer: EvalLayer;
  bucketClass: EvidenceClass;
  window: RecordWindow | null;
  pendingReason: string | null;
  /** goal-1027 P0-2：父记录没有观测窗口时，用判断单元自身的结构化方向声明
   * （target=ts_code + direction=bullish/bearish + benchmark）派生的可评价窗口。
   * 与父窗口二选一：有父窗口时优先父窗口，不重复计数。 */
  thesisWindow?: {
    status: 'PENDING' | 'EVALUATED' | 'UNAVAILABLE';
    reason: string | null;
    window: RecordWindow | null;
  };
}

function bump(map: Record<string, number>, key: string) { map[key] = (map[key] ?? 0) + 1; }

function weighted(values: { v: number; w: number }[]): number {
  const total = values.reduce((s, x) => s + x.w, 0);
  return total ? round(values.reduce((s, x) => s + x.v * x.w, 0) / total) : 0;
}

/** 成熟度判定：把一条评价结果变成可计入统计的窗口，或给出 PENDING/UNAVAILABLE 原因。 */
function windowFromEvaluation(record: JournalRecord, e: JournalEvaluation, comparison: (start: string, end: string) => Map<string, BenchmarkResult>): { window: RecordWindow | null; pendingReason?: string; unavailableReason?: string } {
  if (e.status === 'PENDING') return { window: null, pendingReason: e.reason ?? 'observation_window_not_mature' };
  if (e.status !== 'EVALUATED') return { window: null, unavailableReason: e.reason ?? 'evaluation_unavailable' };
  const obs = e.observations.filter((o: any) => o.status === 'EVALUATED' && Number.isFinite(o.invested_cents) && o.invested_cents > 0);
  if (!obs.length || obs.length !== e.observations.length) {
    return { window: null, unavailableReason: (e.observations[0] as any)?.reason ?? 'observation_dependencies_unavailable' };
  }
  const w = (pick: (o: any) => number) => weighted(obs.map((o: any) => ({ v: pick(o), w: o.invested_cents as number })));
  const net = w(o => o.net_return_pct);
  const excess: Record<BenchmarkId, number | null> = { csi300_etf_buy_hold: w(o => o.excess_return_pct), frozen_multi_asset_basket: null, initial_five_etf_basket: null };
  const benches = comparison(record.as_of_trade_date, e.maturity_date!);
  const basket = benches.get('frozen_multi_asset_basket');
  excess.frozen_multi_asset_basket = basket && basket.status !== 'UNAVAILABLE' && basket.total_return_pct !== null ? round(net - basket.total_return_pct) : null;
  // 五只 ETF 自基线锚定的买入持有路径：取研究日与成熟日之间的市值比。
  const fiveAtStart = comparison(FROZEN_FIVE_START_DATE, record.as_of_trade_date).get('initial_five_etf_basket');
  const fiveAtEnd = comparison(FROZEN_FIVE_START_DATE, e.maturity_date!).get('initial_five_etf_basket');
  const fiveOk = (b?: BenchmarkResult) => !!b && b.status !== 'UNAVAILABLE' && b.end_value_cents !== null && b.end_value_cents > 0;
  excess.initial_five_etf_basket = fiveOk(fiveAtStart) && fiveOk(fiveAtEnd) ? round(net - (fiveAtEnd!.end_value_cents! / fiveAtStart!.end_value_cents! - 1) * 100) : null;
  const bench = benches.get('csi300_etf_buy_hold');
  return {
    window: {
      record, maturity: e.maturity_date!, net, maxDrawdown: w(o => o.max_drawdown_pct), excess,
      benchVol: bench && bench.status !== 'UNAVAILABLE' ? bench.annualized_vol_pct : null,
      benchMdd: bench && bench.status !== 'UNAVAILABLE' ? bench.max_drawdown_pct : null,
      triggerDefined: obs.filter((o: any) => o.trigger !== 'NOT_DEFINED').length,
      triggerMet: obs.filter((o: any) => o.trigger === 'TRIGGERED').length,
      invalidationDefined: obs.filter((o: any) => o.invalidation !== 'NOT_DEFINED').length,
      invalidationBreached: obs.filter((o: any) => o.invalidation === 'INVALIDATED').length,
    },
  };
}

/**
 * 三层×六指标研究评价（§7.3）。**纯只读**：不写任何表、不修改任何日志；同一份研究日志 +
 * 行情缓存 + asOf + horizon 给出确定性 JSON。
 *
 * 输入：研究日志（portfolioDb 里的 research_journal + research_thesis）与结果数据
 * （marketDb 行情缓存上的评价窗口；可注入 evaluations 覆盖缺省计算）。
 * 输出：`{ schema, as_of_trade_date, true_forward_start, horizon_trade_days, layers: { vps, chatgpt, combined }, records, theses, limitations, evaluation_id }`，
 * 每层六个指标桶（见 LayerMetrics）；分层/分指标的 PENDING 语义见各桶的
 * `pending`/`pending_reasons`/`by_class`。
 */
export function buildResearchEval(input: {
  portfolioDb: DatabaseSync;
  marketDb: DatabaseSync | null | undefined;
  accountId: string;
  asOf: string;
  horizon?: number;
  feeEstimator?: JournalFeeEstimator;
  evaluations?: JournalEvaluation[];
}): ResearchEvalResult {
  const asOf = input.asOf;
  ymdCheck(asOf, 'asOf');
  const horizon = input.horizon ?? DEFAULT_HORIZONS[0];
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 252) throw new Error('horizon requires 1..252 trading days');

  const records = listResearchJournal(input.portfolioDb, { accountId: input.accountId, asOf, limit: 1000 });
  const recordStats0 = records.map(record => ({ record, cls: classifyRecord(record) }));
  const theses = listResearchThesis(input.portfolioDb, { accountId: input.accountId, limit: 1000 });
  const evaluations = input.evaluations
    ?? evaluateResearchJournal({ portfolioDb: input.portfolioDb, marketDb: input.marketDb, accountId: input.accountId, asOf, horizons: [horizon], feeEstimator: input.feeEstimator });
  const evalByRecord = new Map<string, JournalEvaluation>();
  for (const e of evaluations) if (e.horizon_trade_days === horizon && !evalByRecord.has(e.record_id)) evalByRecord.set(e.record_id, e);

  const benchmarkCache = new Map<string, Map<string, BenchmarkResult>>();
  let benchmarkMeta: { definition_version: string | null; basket_weights_status: string | null } = { definition_version: null, basket_weights_status: null };
  const comparison = (start: string, end: string) => {
    const key = `${start}:${end}`;
    if (!benchmarkCache.has(key)) {
      const result = buildBenchmarkComparison({ marketDb: input.marketDb, start, end });
      benchmarkMeta = { definition_version: result.definition_version, basket_weights_status: result.benchmarks.find(b => b.id === 'frozen_multi_asset_basket')?.weights_status ?? null };
      benchmarkCache.set(key, new Map(result.benchmarks.map(b => [b.id, b])));
    }
    return benchmarkCache.get(key)!;
  };

  // 每条记录 → 一个分析期限窗口（或 PENDING/UNAVAILABLE 原因）。前瞻与补录分开计数。
  interface WindowStat { window: RecordWindow | null; pendingReason: string | null; unavailableReason: string | null }
  const windowOf = new Map<string, WindowStat>();
  for (const record of records) {
    const e = evalByRecord.get(record.record_id);
    if (!e) { windowOf.set(record.record_id, { window: null, pendingReason: 'evaluation_missing', unavailableReason: null }); continue; }
    const built = windowFromEvaluation(record, e, comparison);
    windowOf.set(record.record_id, {
      window: built.window,
      pendingReason: built.pendingReason ?? null,
      unavailableReason: built.unavailableReason ?? null,
    });
  }

  // 判断单元 → 分层（按父记录 source）+ 证据分类桶 + 可用窗口（父记录的评价窗口）。
  const recordsById = new Map(records.map(r => [r.record_id, r]));
  const unitViews: UnitView[] = [];
  for (const unit of theses) {
    const parent = recordsById.get(unit.parent_record_id) ?? readResearchJournal(input.portfolioDb, unit.parent_record_id);
    const layer = ((parent?.source ?? 'combined') as EvalLayer);
    const stat = parent ? windowOf.get(parent.record_id) : undefined;
    const view: UnitView = {
      unit, layer, bucketClass: unit.parent_evidence_class,
      window: stat?.window ?? null,
      pendingReason: stat ? (stat.pendingReason ?? (stat.window ? null : 'parent_window_unavailable')) : 'parent_record_unavailable',
    };
    // P0-2：父窗口缺失时（ChatGPT/Combined 记录 observations 恒空），从判断单元的
    // 结构化方向声明派生窗口。只对 bullish/bearish + 合法 ts_code target 尝试；
    // 中性/条件性/证据不足不进入方向统计（它们不是方向预测）。资格仍由
    // parent_evidence_class 决定——补录父记录的判断单元永远进不了前瞻统计。
    if (!view.window && parent
      && (unit.direction === 'bullish' || unit.direction === 'bearish')
      && /^\d{6}\.(SH|SZ|BJ)$/.test(unit.target)) {
      const computed = evaluateDirectionalWindow({
        marketDb: input.marketDb, asOf: parent.as_of_trade_date,
        evalCutoff: asOf,
        tsCode: unit.target, benchmarkCode: unit.benchmark ?? undefined,
        horizon, feeEstimator: input.feeEstimator,
      });
      view.thesisWindow = {
        status: computed.status, reason: computed.reason,
        window: computed.status === 'EVALUATED' ? {
          record: parent, maturity: computed.maturity_date!,
          net: computed.net_return_pct!, maxDrawdown: computed.max_drawdown_pct ?? 0,
          excess: { csi300_etf_buy_hold: computed.excess_return_pct, frozen_multi_asset_basket: null, initial_five_etf_basket: null },
          benchVol: null, benchMdd: null,
          triggerDefined: 0, triggerMet: 0, invalidationDefined: 0, invalidationBreached: 0,
        } : null,
      };
      if (view.thesisWindow.window) {
        view.window = view.thesisWindow.window;
        view.pendingReason = null;
      } else if (view.pendingReason === 'parent_window_unavailable') {
        view.pendingReason = `thesis_window_${computed.status.toLowerCase()}:${computed.reason ?? 'unspecified'}`;
      }
    }
    unitViews.push(view);
  }

  const recordStats = recordStats0.map(({ record, cls }) => ({ record, cls, stat: windowOf.get(record.record_id)! }));
  return assembleEval({ asOf, horizon, accountId: input.accountId, recordStats, unitViews, benchmarkMeta });
}

// ---------------------------------------------------------------- 输出组装

export interface ResearchEvalResult {
  schema: string;
  account_id: string;
  as_of_trade_date: string;
  true_forward_start: string;
  horizon_trade_days: number;
  versions: { journal: string; research_eval: string };
  records: { total: number; by_class: Record<EvidenceClass, number>; by_source: Record<string, number> };
  theses: {
    total: number;
    by_class: Record<EvidenceClass, number>;
    by_layer: Record<EvalLayer, number>;
    with_matured_window: number;
    pending: number;
    pending_reasons: Record<string, number>;
    confidence_note: string;
  };
  layers: Record<EvalLayer, LayerMetrics>;
  conclusion_by_layer: Record<EvalLayer, string>;
  statement: string;
  benchmarks: { ids: readonly string[]; definition_version: string | null; basket_weights_status: string | null };
  limitations: string[];
  evaluation_id: string;
}

function classCountInit(): Record<EvidenceClass, number> {
  return { TRUE_FORWARD: 0, PRE_FORWARD_HISTORICAL: 0, RETROSPECTIVE_RECORD: 0 };
}

interface RecStat { record: JournalRecord; cls: EvidenceClass; stat: { window: RecordWindow | null; pendingReason: string | null; unavailableReason: string | null } }

/** 一个层的六指标。统计值只来自 TRUE_FORWARD 成熟窗口；补录/历史按 by_class 单独计数（excluded），绝不并入。
 * 窗口来源两类：记录级（VPS observations）与判断单元级（P0-2 结构化方向窗口，父窗口缺失时）。
 * 同一父记录已有记录级窗口时，其判断单元不再叠加方向窗口，避免重复计数。 */
function computeLayerMetrics(recStats: RecStat[], views: UnitView[], horizon: number): { metrics: LayerMetrics; conclusion: string } {
  const byClass = classCountInit();
  const pendingReasons: Record<string, number> = {};
  const unavailableReasons: Record<string, number> = {};
  let tfCount = 0, tfPending = 0, tfUnavailable = 0;
  const matured: RecordWindow[] = [];
  const recordWindowParents = new Set(recStats.filter(r => r.stat.window).map(r => r.record.record_id));
  for (const { cls, stat } of recStats) {
    byClass[cls]++;
    if (cls !== 'TRUE_FORWARD') {
      // 前瞻之外的分类：只在 by_class 计数（excluded），永远不进入任何统计量，也不标 pending
      // ——按规则它们本就不参与前瞻统计，不是"还没成熟"。
      continue;
    }
    tfCount++;
    if (stat.window) matured.push(stat.window);
    else if (stat.pendingReason) { tfPending++; bump(pendingReasons, stat.pendingReason); }
    else if (stat.unavailableReason) { tfUnavailable++; bump(unavailableReasons, stat.unavailableReason); }
    else { tfPending++; bump(pendingReasons, 'evaluation_missing'); }
  }
  // P0-2：判断单元级方向窗口。仅 TRUE_FORWARD 资格、且父记录没有记录级窗口时计入；
  // 中性/条件性/证据不足没有方向窗口（不计 pending，它们不是方向预测）。
  for (const view of views) {
    if (view.bucketClass !== 'TRUE_FORWARD') continue;
    if (recordWindowParents.has(view.unit.parent_record_id)) continue;
    if (view.thesisWindow?.window) {
      matured.push(view.thesisWindow.window);
      tfCount++;
    } else if (view.thesisWindow && !view.window) {
      tfCount++;
      if (view.thesisWindow.status === 'PENDING') { tfPending++; bump(pendingReasons, view.thesisWindow.reason ?? 'thesis_window_pending'); }
      else { tfUnavailable++; bump(unavailableReasons, view.thesisWindow.reason ?? 'thesis_window_unavailable'); }
    }
  }
  const classBlock = (): MetricBucket['by_class'] => ({
    TRUE_FORWARD: { sample_size: matured.length, excluded: 0, pending: tfPending, pending_reasons: pendingReasons },
    PRE_FORWARD_HISTORICAL: { sample_size: 0, excluded: byClass.PRE_FORWARD_HISTORICAL, pending: 0, pending_reasons: {} },
    RETROSPECTIVE_RECORD: { sample_size: 0, excluded: byClass.RETROSPECTIVE_RECORD, pending: 0, pending_reasons: {} },
  });

  const make = (note: string): LayerMetrics => {
    const out = {} as LayerMetrics;
    for (const id of EVAL_METRIC_IDS) {
      if (!tfCount) out[id] = bucket('NO_RECORDS', 0, 0, 0, {}, {}, note, null, classBlock());
      else out[id] = bucket('PENDING', 0, tfPending || tfCount, tfUnavailable, pendingReasons, unavailableReasons, note, null, classBlock());
    }
    return out;
  };

  if (!tfCount) {
    const anyRecords = recStats.length + views.length;
    return {
      metrics: make(anyRecords ? FORWARDED_ONLY_NOTE : NO_RECORDS_NOTE),
      conclusion: anyRecords ? 'NO_TRUE_FORWARD_RECORDS' : 'NO_RECORDS',
    };
  }
  if (!matured.length) {
    return { metrics: make(`${FORWARDED_ONLY_NOTE} 分析期限窗口尚未成熟或数据不可用。`), conclusion: 'NO_MATURED_FORWARD_SAMPLE' };
  }

  const n = matured.length;
  const nets = matured.map(w => w.net);
  const excessByBench = Object.fromEntries(BENCHMARK_IDS.map(id => {
    const values = matured.map(w => w.excess[id]).filter((x): x is number => x !== null);
    return [id, { n: values.length, mean_excess_pct_points: mean(values),
      hit_rate: values.length ? rate(values.filter(x => x > 0).length, values.length) : null }];
  })) as Record<BenchmarkId, { n: number; mean_excess_pct_points: number | null; hit_rate: number | null }>;
  const facts = { windows: n, triggerDefined: 0, triggerMet: 0, invalidationDefined: 0, invalidationBreached: 0 };
  for (const w of matured) {
    facts.triggerDefined += w.triggerDefined; facts.triggerMet += w.triggerMet;
    facts.invalidationDefined += w.invalidationDefined; facts.invalidationBreached += w.invalidationBreached;
  }
  const factualChecks = facts.triggerDefined + facts.invalidationDefined;
  const factualHits = facts.triggerMet + facts.invalidationBreached;

  // 独立（非重叠）窗口：与 forward review 相同口径——窗口开始不早于上一个保留窗口的成熟日。
  const sorted = [...matured].sort((a, b) => a.record.as_of_trade_date.localeCompare(b.record.as_of_trade_date));
  let lastMaturity = '';
  const independent = sorted.filter(w => { if (w.record.as_of_trade_date < lastMaturity) return false; lastMaturity = w.maturity; return true; });

  const evalBucket = (value: unknown): MetricBucket =>
    bucket('EVALUATED', n, 0, tfUnavailable, pendingReasons, unavailableReasons, null, value, classBlock());

  const metrics = make(FORWARDED_ONLY_NOTE);
  metrics.fact_prediction_accuracy = factualChecks > 0
    ? evalBucket({ windows_evaluated: n, factual_checks: factualChecks, correct: factualHits, accuracy_rate: rate(factualHits, factualChecks), by_condition: {
      trigger: { defined: facts.triggerDefined, met: facts.triggerMet, met_rate: rate(facts.triggerMet, facts.triggerDefined) },
      invalidation: { defined: facts.invalidationDefined, breached: facts.invalidationBreached, breach_rate: rate(facts.invalidationBreached, facts.invalidationDefined) } },
      note: '仅统计研究日之后行情可检验的触发价/失效价事实；结构化判断单元中的自由文本条件不机器计分。' })
    : bucket('PENDING', 0, n, tfUnavailable, { no_machine_checkable_facts: n }, unavailableReasons, '有成熟窗口但没有可机器检验的触发/失效条件，事实预测正确率保持 PENDING。', null, classBlock());
  metrics.relative_return_effectiveness = evalBucket({ windows_evaluated: n, by_benchmark: excessByBench, caveat: DIRECTIONAL_CAVEAT });
  metrics.risk_prediction_effectiveness = factualChecks > 0
    ? evalBucket({ windows_evaluated: n, ...facts,
      breach_rate: rate(facts.invalidationBreached, facts.invalidationDefined),
      trigger_met_rate: rate(facts.triggerMet, facts.triggerDefined),
      unexpected_loss_rate: rate(facts.invalidationBreached, facts.invalidationDefined),
      note: '风险预测以事前登记的触发/失效价格条件是否被行情触及为准，不是对市场波动的事后描述。' })
    : bucket('PENDING', 0, n, tfUnavailable, { no_defined_risk_conditions: n }, unavailableReasons, '没有事前定义的触发/失效条件，风险预测有效性保持 PENDING。', null, classBlock());
  metrics.counterfactual_portfolio_return = evalBucket({ definition: '研究日收盘到成熟日收盘的纸面价格观察，含假设费用；不是实际成交回测', windows_evaluated: n,
    net_return_pct: { mean: mean(nets), median: sortedMedian(nets), stdev: stdev(nets), worst: nets.length ? Math.min(...nets) : null },
    excess_vs: excessByBench });
  const benchVols = matured.map(w => w.benchVol).filter((x): x is number => x !== null);
  metrics.after_fee_risk_adjusted_return = evalBucket({ windows_evaluated: n,
    after_fee_net_return_pct: { mean: mean(nets), median: sortedMedian(nets), stdev_across_windows: stdev(nets), worst: Math.min(...nets) },
    max_drawdown_pct: { mean: mean(matured.map(w => w.maxDrawdown)), worst: Math.min(...matured.map(w => w.maxDrawdown)) },
    benchmark: { mean_annualized_vol_pct: mean(benchVols), mean_max_drawdown_pct: mean(matured.map(w => w.benchMdd).filter((x): x is number => x !== null)) },
    risk_adjusted: riskAdjustedBlock(nets, benchVols, n, horizon) });
  metrics.incremental_value_vs_hold = evalBucket({ windows_evaluated: n, by_benchmark: excessByBench,
    independent_windows: independent.length, min_non_overlapping_windows: MIN_NON_OVERLAPPING_WINDOWS,
    decision_level_counterfactual: '未记录与 HOLD 决策同口径的事前登记组合，增量价值只以纸面观察相对冻结被动基准的超额呈现；不把它等同于决策成功。',
    caveat: DIRECTIONAL_CAVEAT });

  const conclusion = independent.length < MIN_NON_OVERLAPPING_WINDOWS ? 'INSUFFICIENT_SAMPLE'
    : BENCHMARK_IDS.every(id => excessByBench[id].n > 0 && (excessByBench[id].mean_excess_pct_points ?? 0) > 0) ? 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT' : 'NO_IMPROVEMENT';
  return { metrics, conclusion };
}

const sortedMedian = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

/** 费用后风险调整比率。样本或离散度不足时返回 null + 原因，绝不插值、不估算。 */
function riskAdjustedBlock(nets: number[], benchVols: number[], n: number, horizon: number) {
  const annualFactor = 252 / horizon;
  const meanNet = mean(nets);
  const annualizedMean = meanNet === null ? null : round(meanNet * annualFactor);
  const partial = { windows: n, annualized_factor_note: '按 252/horizon 年化的近似口径，仅描述纸面窗口。', mean_annualized_net_return_pct: annualizedMean };
  if (n < 2) return { ...partial, sharpe_ratio: null, calmar_ratio: null, reason: 'insufficient_matured_windows' };
  const sd = stdev(nets);
  if (sd === null || sd === 0) return { ...partial, sharpe_ratio: null, calmar_ratio: null, reason: 'net_return_dispersion_unavailable' };
  const annualVol = sd * Math.sqrt(annualFactor);
  const worst = Math.min(...nets);
  return {
    ...partial,
    portfolio_annualized_vol_pct: round(annualVol),
    benchmark_mean_annualized_vol_pct: mean(benchVols),
    sharpe_ratio: annualizedMean === null ? null : round(annualizedMean / annualVol),
    calmar_ratio: annualizedMean === null || worst >= 0 ? null : round(annualizedMean / Math.abs(worst * annualFactor)),
    reason: null,
  };
}

function assembleEval(input: {
  asOf: string; horizon: number; accountId: string;
  recordStats: RecStat[]; unitViews: UnitView[];
  benchmarkMeta: { definition_version: string | null; basket_weights_status: string | null };
}): ResearchEvalResult {
  const byClass = classCountInit();
  const bySource: Record<string, number> = {};
  for (const { record, cls } of input.recordStats) { byClass[cls]++; bySource[record.source] = (bySource[record.source] ?? 0) + 1; }
  const thesisByClass = classCountInit();
  const thesisByLayer: Record<EvalLayer, number> = { vps: 0, chatgpt: 0, combined: 0 };
  const thesisPendingReasons: Record<string, number> = {};
  let thesisWithWindow = 0;
  for (const view of input.unitViews) {
    thesisByClass[view.bucketClass]++;
    thesisByLayer[view.layer] = (thesisByLayer[view.layer] ?? 0) + 1;
    if (view.window) thesisWithWindow++;
    else bump(thesisPendingReasons, view.pendingReason ?? 'unspecified');
  }

  const layers = {} as Record<EvalLayer, LayerMetrics>;
  const conclusionByLayer = {} as Record<EvalLayer, string>;
  for (const layer of EVAL_LAYERS) {
    const recStats = input.recordStats.filter(r => r.record.source === layer);
    const views = input.unitViews.filter(v => v.layer === layer);
    const { metrics, conclusion } = computeLayerMetrics(recStats, views, input.horizon);
    layers[layer] = metrics;
    conclusionByLayer[layer] = conclusion;
  }

  const tfRecords = input.recordStats.filter(r => r.cls === 'TRUE_FORWARD');
  const tfMatured = tfRecords.filter(r => r.stat.window);
  const statements: Record<string, string> = {
    NO_RECORDS: '没有任何研究记录，无从评价；不补造历史表现。',
    NO_TRUE_FORWARD_RECORDS: '只有补录或规则冻结前的记录，前瞻层没有真实样本；补录不与前瞻合并统计。',
    NO_MATURED_FORWARD_SAMPLE: '前瞻窗口尚未成熟，六项指标全部 PENDING；这既不说明研究有效，也不说明研究无效。',
    SEE_PER_LAYER: '各层结论见 conclusion_by_layer；任何单次方向判断正确都不等于投资决策成功。',
  };
  const overall = !input.recordStats.length && !input.unitViews.length ? 'NO_RECORDS'
    : !tfRecords.length ? 'NO_TRUE_FORWARD_RECORDS'
    : !tfMatured.length ? 'NO_MATURED_FORWARD_SAMPLE'
    : 'SEE_PER_LAYER';
  const result: Omit<ResearchEvalResult, 'evaluation_id'> = {
    schema: RESEARCH_EVAL_SCHEMA,
    account_id: input.accountId,
    as_of_trade_date: input.asOf,
    true_forward_start: TRUE_FORWARD_START,
    horizon_trade_days: input.horizon,
    versions: { journal: JOURNAL_VERSION, research_eval: RESEARCH_EVAL_SCHEMA },
    records: { total: input.recordStats.length, by_class: byClass, by_source: bySource },
    theses: {
      total: input.unitViews.length, by_class: thesisByClass, by_layer: thesisByLayer,
      with_matured_window: thesisWithWindow,
      pending: input.unitViews.length - thesisWithWindow,
      pending_reasons: thesisPendingReasons,
      confidence_note: 'confidence 是未校准的主观量，禁止当作精确概率解释或跨记录比较校准度。',
    },
    layers,
    conclusion_by_layer: conclusionByLayer,
    statement: statements[overall],
    benchmarks: { ids: BENCHMARK_IDS, definition_version: input.benchmarkMeta.definition_version, basket_weights_status: input.benchmarkMeta.basket_weights_status },
    limitations: [
      '前瞻与补录分开统计：统计值只来自 TRUE_FORWARD 成熟窗口；RETROSPECTIVE_RECORD 与 PRE_FORWARD_HISTORICAL 只在 by_class 中计数。',
      '观察是研究日收盘至成熟日收盘的纸面价格观察，不是实际成交，不含分红现金流。',
      '费用后风险调整比率仅在样本成熟且离散度可算时给出；否则保留 null 与原因，不插值、不估算。',
      '没有真实记录时输出 NO_RECORDS/PENDING，绝不补造历史表现。',
      '一次方向判断正确 ≠ 投资决策成功；增量价值为相对冻结被动基准的纸面超额，非决策级反事实。',
    ],
  };
  const evaluationId = createHash('sha256').update(canonicalJson(result)).digest('hex').slice(0, 24);
  return { ...result, evaluation_id: `RE-${evaluationId}` };
}
