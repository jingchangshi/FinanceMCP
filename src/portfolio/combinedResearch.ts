import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  canonicalJson, JOURNAL_VERSION, listResearchJournal, readResearchJournal,
  recordResearchJournal, type JournalRecord,
} from './researchJournal.js';
import { classifyRecord, type EvidenceClass } from './forwardReview.js';
import { inPortfolioTransaction } from './db.js';

/**
 * Combined 研究判断的生成、冻结与存储（goal-1027 P0-3）。
 *
 * 任务书禁止把 VPS 与 ChatGPT 两套历史收益平均成 Combined。这里的 Combined 是：
 * **同一研究时点**，以同一交易日的一条真实 VPS 快照记录和一条真实 ChatGPT 研究记录
 * 为输入，按事先冻结的联合规则（COMBINED_RULE_VERSION）生成的一份联合研究决策记录
 * （research_journal.source='combined'），在未来结果出现前持久化，之后由评价器与其他
 * 两层同口径比较。
 *
 * 联合规则（r1，冻结于 20261027，版本 combined-research-20261027-r1）：
 * 1. 输入：同账户、同 as_of_trade_date 的一条 VPS 记录 + 一条 ChatGPT 记录（父记录）。
 *    任一侧缺失即拒绝，不虚构联合判断。同日多条时各取 recorded_at 最新的一条，且
 *    把该日全部候选身份记录进 payload.input_candidates，保证组合选择可审计、不重复
 *    生成（record_id 由输入身份派生，同输入幂等）。
 * 2. 方向提取：从 ChatGPT 记录 payload 的 final_conclusion / independent_judgement 中
 *    **不**做自由文本行情解析。方向语义由 ChatGPT 侧的结构化判断单元（research_thesis，
 *    若存在）给出；无判断单元时 combined 方向为 UNSPECIFIED，联合决策退化为
 *    "沿用 VPS 原判断 + 披露 ChatGPT 未提供结构化方向"。
 * 3. 冲突处理：VPS 判定（记录 judgement，通常是日报 status：NO_ACTION/ACTIONABLE/…）
 *    与 ChatGPT 结构化方向一致（如 VPS=NO_ACTION 且 ChatGPT=neutral/no-action）→
 *    combined_decision 沿用 VPS；ChatGPT 方向与 VPS 动作冲突（如 VPS=NO_ACTION 但
 *    ChatGPT=bullish 且 decision_impact 声称应交易）→ combined_decision =
 *    FOLLOW_VPS_WITH_DIVERGENCE_NOTED，保留双方意见，绝不凭 ChatGPT 的 confidence
 *    覆盖 VPS。无结构化方向 → FOLLOW_VPS（默认沿用 VPS）。
 * 4. NO_ACTION 合法：VPS=NO_ACTION 且 ChatGPT=neutral → combined=NO_ACTION，这是一份
 *    真实联合决策，不是缺失。
 * 5. 规则版本、父记录 content_hash、生成时刻（服务端时钟）全部写入 payload；记录一旦
 *    写入不可变（research_journal 触发器）；结果已知后不得追加该时点的 combined 记录
 *    （服务端按 recorded/generated 时钟与 as_of 的关系判定，晚于交易日的生成自动降为
 *    补录，评价器按 RETROSPECTIVE_RECORD 排除）。
 * 6. 本模块只写研究判断合并，不产生任何换仓执行；纸面组合评价在 researchEval，
 *    不构成下单授权。
 */

export const COMBINED_RULE_VERSION = 'combined-research-20261027-r1';
export const COMBINED_APPEND_TOOL = 'ashare_research_combined_append';

export type CombinedDecision =
  | 'FOLLOW_VPS'
  | 'FOLLOW_VPS_WITH_DIVERGENCE_NOTED'
  | 'NO_ACTION'
  | 'UNSPECIFIED_INPUTS';

export interface CombinedAppendInput {
  accountId: string;
  asOf: string;
  /** 可选：显式指定父记录；缺省自动选取该日各层最新记录。 */
  vpsRecordId?: string;
  chatgptRecordId?: string;
  nowMs?: number;
}

export interface CombinedAppendResult {
  created: boolean;
  record_id: string;
  content_hash: string;
  decision: CombinedDecision;
  vps_record_id: string;
  chatgpt_record_id: string;
  evidence_class: EvidenceClass;
  rule_version: string;
  divergences: string[];
  note: string;
}

const ymdCheck = (value: string, name: string) => {
  if (!/^\d{8}$/.test(value)) throw new Error(`${name} requires YYYYMMDD`);
  const d = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10).replace(/-/g, '') !== value) throw new Error(`${name} is not a calendar date`);
};

interface ThesisDirectionView {
  thesis_id: string;
  target: string;
  direction: string;
  decision_impact: string | null;
  confidence: number | null;
}

/** 该父记录下全部判断单元的方向视图（读 research_thesis；表不存在时为空）。 */
function thesisDirections(db: DatabaseSync, parentRecordId: string): ThesisDirectionView[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_thesis'").get()) return [];
  const rows = db.prepare('SELECT thesis_id, content_json FROM research_thesis WHERE parent_record_id=? ORDER BY thesis_id').all(parentRecordId) as { thesis_id: string; content_json: string }[];
  return rows.map(row => {
    const content = JSON.parse(row.content_json);
    return {
      thesis_id: content.thesis_id, target: content.target, direction: content.direction,
      decision_impact: content.decision_impact ?? null, confidence: content.confidence ?? null,
    };
  });
}

/** ChatGPT 侧是否存在明确的方向性/行动性主张（仅基于结构化判断单元，不解析自然语言）。 */
function chatgptStance(theses: ThesisDirectionView[]): {
  directional: boolean;
  wantsAction: boolean;
  directions: string[];
} {
  const actionable = theses.filter(t =>
    (t.direction === 'bullish' || t.direction === 'bearish')
    && t.decision_impact !== null && /buy|sell|卖出|买入|换仓|减仓|加仓|action/i.test(t.decision_impact));
  const directional = theses.some(t => t.direction === 'bullish' || t.direction === 'bearish');
  return { directional, wantsAction: actionable.length > 0, directions: [...new Set(theses.map(t => t.direction))] };
}

/** VPS 判定语义：日报 status 或 judgement 文本。 */
function vpsStance(record: JournalRecord): { status: string; wantsNoAction: boolean } {
  const status = typeof record.judgement === 'string' ? record.judgement : 'UNKNOWN';
  return { status, wantsNoAction: status === 'NO_ACTION' || status === 'DATA_INSUFFICIENT' };
}

/**
 * 按冻结规则生成并持久化一条 Combined 联合判断记录。幂等：record_id 由
 * (account, as_of, vps_record_id, chatgpt_record_id, rule_version) 派生；同输入重放
 * 返回 created:false；不同输入（如换父记录）产生新记录，不覆盖旧记录。
 */
export function appendCombinedResearch(db: DatabaseSync, input: CombinedAppendInput): CombinedAppendResult {
  const nowMs = input.nowMs ?? Date.now();
  ymdCheck(input.asOf, 'as_of_trade_date');
  return inPortfolioTransaction(db, () => appendCombinedParsed(db, input, nowMs));
}

function appendCombinedParsed(db: DatabaseSync, input: CombinedAppendInput, nowMs: number): CombinedAppendResult {
  const dayRecords = listResearchJournal(db, { accountId: input.accountId, asOf: input.asOf, limit: 1000 })
    .filter(r => r.as_of_trade_date === input.asOf);
  const vpsCandidates = dayRecords.filter(r => r.source === 'vps');
  const chatgptCandidates = dayRecords.filter(r => r.source === 'chatgpt');
  const pick = (rows: JournalRecord[], explicitId: string | undefined, label: string) => {
    if (explicitId) {
      const found = rows.find(r => r.record_id === explicitId);
      if (!found) throw new Error(`${label}_record_not_found: ${explicitId} is not a ${label === 'vps' ? 'VPS' : 'ChatGPT'} record of account ${input.accountId} on ${input.asOf}`);
      return found;
    }
    if (!rows.length) return null;
    return [...rows].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  };
  const vps = pick(vpsCandidates, input.vpsRecordId, 'vps');
  const chatgpt = pick(chatgptCandidates, input.chatgptRecordId, 'chatgpt');
  // 1. 任一侧缺失即拒绝，不虚构联合判断。
  if (!vps || !chatgpt) {
    const missing = [!vps ? 'vps' : null, !chatgpt ? 'chatgpt' : null].filter(Boolean).join('+');
    throw new Error(`combined_inputs_incomplete: missing ${missing} record for ${input.accountId} on ${input.asOf}; combined research is only generated from two real parent records`);
  }
  const identity = createHash('sha256').update(canonicalJson({
    account: input.accountId, as_of: input.asOf, vps: vps.record_id, chatgpt: chatgpt.record_id, rule: COMBINED_RULE_VERSION,
  })).digest('hex').slice(0, 20);
  const recordId = `COMBINED-${input.asOf}-${identity}`;
  const existing = readResearchJournal(db, recordId);
  if (existing) {
    const payload = existing.payload as any;
    return {
      created: false, record_id: recordId, content_hash: existing.content_hash,
      decision: payload?.combined_decision ?? 'UNSPECIFIED_INPUTS',
      vps_record_id: vps.record_id, chatgpt_record_id: chatgpt.record_id,
      evidence_class: classifyRecord(existing), rule_version: COMBINED_RULE_VERSION,
      divergences: payload?.divergences ?? [],
      note: '同一输入的联合判断已存在（幂等）：不覆盖、不追写。',
    };
  }
  const theses = thesisDirections(db, chatgpt.record_id);
  const chatgptView = chatgptStance(theses);
  const vpsView = vpsStance(vps);
  const divergences: string[] = [];
  let decision: CombinedDecision;
  if (!chatgptView.directional) {
    // 2/3. 无结构化方向 → VPS 判定无动作为 NO_ACTION（合法联合决策，规则 4），
    // 否则沿用 VPS 原判断；两种情况都披露 ChatGPT 未提供可联合的方向性输入。
    if (vpsView.wantsNoAction) {
      decision = 'NO_ACTION';
      if (!chatgptView.directions.length) divergences.push('chatgpt_no_structured_thesis: VPS 判定无动作，联合决策为 NO_ACTION；ChatGPT 记录没有结构化判断单元，不从自由文本推断方向。');
      else divergences.push(`chatgpt_no_directional_thesis: ChatGPT 判断单元方向为 ${chatgptView.directions.join('/')}，不构成方向性联合输入；VPS 判定无动作，联合决策为 NO_ACTION。`);
    } else {
      decision = 'FOLLOW_VPS';
      if (!chatgptView.directions.length) divergences.push('chatgpt_no_structured_thesis: 联合决策沿用 VPS 原判断；ChatGPT 记录没有结构化判断单元，不从自由文本推断方向。');
      else divergences.push(`chatgpt_no_directional_thesis: ChatGPT 判断单元方向为 ${chatgptView.directions.join('/')}，不构成方向性联合输入；沿用 VPS。`);
    }
  } else if (chatgptView.wantsAction && vpsView.wantsNoAction) {
    // 冲突：ChatGPT 结构化方向 + 行动性 decision_impact，但 VPS 判定无动作。
    decision = 'FOLLOW_VPS_WITH_DIVERGENCE_NOTED';
    divergences.push(`action_divergence: VPS judgement=${vpsView.status}（无动作），ChatGPT 结构化方向=${chatgptView.directions.join('/')} 且 decision_impact 含行动性主张；按规则沿用 VPS，分歧保留在记录中，不凭 ChatGPT 置信度覆盖。`);
  } else if (vpsView.wantsNoAction && (chatgptView.directions.every(d => d === 'neutral' || d === 'evidence_insufficient' || d === 'conditional'))) {
    decision = 'NO_ACTION';
  } else {
    decision = 'FOLLOW_VPS';
    if (chatgptView.directional) divergences.push(`directional_input_noted: ChatGPT 结构化方向=${chatgptView.directions.join('/')} 已并入联合记录；决策主体沿用 VPS（r1 规则：冲突或仅有单侧行动性时以 VPS 为准）。`);
  }
  const generatedAt = new Date(nowMs).toISOString();
  const result = recordResearchJournal(db, {
    record_id: recordId,
    account_id: input.accountId,
    source: 'combined',
    as_of_trade_date: input.asOf,
    bundle_id: vps.bundle_id,
    generated_at: generatedAt,
    versions: { journal: JOURNAL_VERSION, combined_rule: COMBINED_RULE_VERSION },
    judgement: decision,
    candidates: [],
    observations: [],
    evidence: [],
    parent_record_ids: [vps.record_id, chatgpt.record_id],
    provenance: { author: 'combined-rules', source_reference: `rule:${COMBINED_RULE_VERSION}`, obtained_at: generatedAt },
    payload: {
      kind: 'combined-research-decision/1',
      combined_decision: decision,
      rule_version: COMBINED_RULE_VERSION,
      vps_parent: { record_id: vps.record_id, bundle_id: vps.bundle_id, content_hash: vps.content_hash, judgement: vps.judgement },
      chatgpt_parent: { record_id: chatgpt.record_id, content_hash: chatgpt.content_hash, final_conclusion_digest: createHash('sha256').update(canonicalJson((chatgpt.payload as any)?.final_conclusion ?? null)).digest('hex').slice(0, 16) },
      chatgpt_theses: theses,
      divergences,
      input_candidates: {
        vps: vpsCandidates.map(r => ({ record_id: r.record_id, recorded_at: r.recorded_at })),
        chatgpt: chatgptCandidates.map(r => ({ record_id: r.record_id, recorded_at: r.recorded_at })),
      },
      frozen_before_outcome: true,
      execution: 'none: research judgement merge only; no rebalancing, no order, no account write',
    },
  });
  return {
    created: result.created, record_id: recordId, content_hash: result.record.content_hash,
    decision, vps_record_id: vps.record_id, chatgpt_record_id: chatgpt.record_id,
    evidence_class: classifyRecord(result.record), rule_version: COMBINED_RULE_VERSION,
    divergences,
    note: result.created
      ? '已按冻结规则生成并持久化联合判断（研究判断合并，不是换仓执行）。'
      : '同一输入的联合判断已存在（幂等）。',
  };
}
