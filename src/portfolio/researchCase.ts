import type { DatabaseSync } from 'node:sqlite';
import type { ResearchStockView } from '../ashare/technicalFrameworkV2.js';

export const RESEARCH_CASE_SCHEMA = 'ashare-research-case/1.0';

export type ResearchCaseEvidenceClass = 'verified_fact' | 'model_derived' | 'interpretation' | 'insufficient_evidence';
export type ResearchCaseRole = 'HOLDING' | 'CANDIDATE';

/** One current, as-of research record per instrument; dimensions remain sourced views. */
export interface ResearchCase {
  schema: typeof RESEARCH_CASE_SCHEMA;
  case_id: string;
  ts_code: string;
  name: string | null;
  role: ResearchCaseRole;
  as_of_trade_date: string | null;
  horizon: { primary: string; next_review: string | null };
  technical: { status: 'AVAILABLE' | 'UNAVAILABLE'; source: string; value: unknown };
  fundamentals: { status: 'AVAILABLE' | 'UNAVAILABLE'; source: string | null; value: unknown; gap: string | null };
  valuation: { status: 'AVAILABLE' | 'UNAVAILABLE'; source: string | null; value: unknown; gap: string | null };
  sentiment_and_flows: { status: 'AVAILABLE' | 'UNAVAILABLE'; source: string | null; value: unknown; gap: string | null };
  events: { status: 'AVAILABLE' | 'UNAVAILABLE'; source: string | null; value: unknown; gap: string | null };
  investment_thesis: string[];
  counter_thesis: string[];
  /** 缺失的证据单独成列；不得混入 counter_thesis 当作负面证据。 */
  evidence_gaps: string[];
  changes_today: string[];
  confirmation_conditions: string[];
  invalidation_conditions: string[];
  next_validation_point: string | null;
  evidence_class: ResearchCaseEvidenceClass;
  limitations: string[];
}

const missing = (gap: string) => ({ status: 'UNAVAILABLE' as const, source: null, value: null, gap });

function caseId(code: string, asOf: string | null): string {
  return `${code}@${asOf ?? 'UNKNOWN'}`;
}

function stockEvidence(db: DatabaseSync | null | undefined, code: string, asOf: string | null) {
  const emptyFundamentals = missing('公告日约束下无可用多期财务数据');
  const emptyValuation = missing('目标交易日无可用 daily_basic 估值数据');
  if (!db || !asOf) return { fundamentals: emptyFundamentals, valuation: emptyValuation };
  let fundamentals: any = emptyFundamentals;
  let valuation: any = emptyValuation;
  try {
    const rows = db.prepare(`SELECT end_date, ann_date, roe, netprofit_yoy, or_yoy, grossprofit_margin,
        debt_to_assets, ocf_to_profit, eps FROM (
        SELECT f.*, ROW_NUMBER() OVER (PARTITION BY end_date ORDER BY ann_date DESC) period_revision
        FROM fina_indicator f WHERE ts_code=? AND end_date<=? AND ann_date<=? AND ann_date>=end_date
      ) WHERE period_revision=1 ORDER BY end_date DESC LIMIT 4`).all(code, asOf, asOf) as any[];
    if (rows.length) fundamentals = {
      status: 'AVAILABLE', source: 'fina_indicator (ann_date <= as_of)',
      value: { latest: rows[0], prior_periods: rows.slice(1), periods_returned: rows.length }, gap: null,
    };
  } catch { /* Missing source/table remains an explicit gap. */ }
  try {
    const row = db.prepare(`SELECT trade_date, pe_ttm, pb, ps_ttm, dv_ttm, total_mv
      FROM daily_basic WHERE ts_code=? AND trade_date=?`).get(code, asOf) as any;
    if (row) valuation = { status: 'AVAILABLE', source: 'daily_basic (exact target trade date)', value: row, gap: null };
  } catch { /* Missing source/table remains an explicit gap. */ }
  return { fundamentals, valuation };
}

export function buildResearchCases(input: {
  asOf: string | null;
  marketDb?: DatabaseSync | null;
  holdings?: any[];
  highlights?: ResearchStockView[];
  watch?: ResearchStockView[];
  deteriorating?: ResearchStockView[];
  priorityCandidateCodes?: string[];
  limitCandidates?: number;
}): ResearchCase[] {
  const asOf = input.asOf ?? null;
  const cases: ResearchCase[] = [];
  const heldCodes = new Set<string>();
  for (const holding of input.holdings ?? []) {
    const code = String(holding.ts_code ?? '');
    if (!code) continue;
    heldCodes.add(code);
    const research = holding.research ?? null;
    const available = Boolean(research && Number(research.data?.bars_used ?? 0) > 0);
    const thesis = Array.isArray(research?.investment_thesis) ? research.investment_thesis : [];
    const counter = Array.isArray(research?.counter_thesis) ? research.counter_thesis : [];
    const conditions = Array.isArray(research?.conditions) ? research.conditions.flatMap((item: any) => item.when ?? []) : [];
    const unavailable = Array.isArray(research?.availability?.unavailable) ? research.availability.unavailable : ['未提供持仓研究切片'];
    const financial = stockEvidence(input.marketDb, code, asOf);
    cases.push({
      schema: RESEARCH_CASE_SCHEMA, case_id: caseId(code, asOf), ts_code: code,
      name: holding.name ?? null, role: 'HOLDING', as_of_trade_date: asOf,
      horizon: { primary: '短期观察：20 个交易日；风险窗口：60 个交易日', next_review: asOf },
      technical: { status: available ? 'AVAILABLE' : 'UNAVAILABLE', source: 'portfolio.dailyReport.holdings[].research', value: research },
      fundamentals: financial.fundamentals,
      valuation: financial.valuation,
      sentiment_and_flows: missing('未接入可审计的交易参与及投资者身份资金视图'),
      events: missing('未接入去重、实体关联并带发布时间的事件研究视图'),
      investment_thesis: thesis,
      counter_thesis: counter,
      evidence_gaps: [...new Set([
        ...unavailable.map((item: string) => String(item)),
        ...(!available ? ['未提供持仓研究切片'] : []),
        ...[financial.fundamentals, financial.valuation]
          .filter(dim => dim.status === 'UNAVAILABLE' && dim.gap)
          .map(dim => String(dim.gap)),
      ])],
      changes_today: available
        ? [`技术切片基于 ${research.data.bar_date ?? '未知'} 行情；新旧变化尚未由历史案例差分验证。`, ...(!research.data.fresh ? ['行情未与目标交易日对齐；视为陈旧证据。'] : [])]
        : ['当日技术切片不可用；不可将缺失解释为负面信号。'],
      confirmation_conditions: conditions,
      invalidation_conditions: research?.availability?.invalid_if ?? ['市场数据或持仓事实变化后重算。'],
      next_validation_point: research?.data?.fresh ? '下一交易日收盘后复核行情、基准对照与持仓事实' : '技术数据恢复并与目标交易日对齐后复核',
      evidence_class: available ? 'model_derived' : 'insufficient_evidence',
      limitations: ['研究案例不构成交易指令；账户可执行性由独立账户门控决定。'],
    });
  }

  const highlights = input.highlights ?? [];
  const watch = input.watch ?? [];
  const deteriorating = input.deteriorating ?? [];
  const priorityCodes = new Set(input.priorityCandidateCodes ?? []);
  const ordered = [...highlights, ...watch, ...deteriorating];
  const unique = new Map<string, ResearchStockView>();
  for (const item of ordered) {
    if (heldCodes.has(item.ts_code) || unique.has(item.ts_code)) continue;
    unique.set(item.ts_code, item);
  }
  const limit = Math.max(0, Math.min(10, input.limitCandidates ?? 5));
  const selected = [...unique.values()].sort((a, b) => Number(priorityCodes.has(b.ts_code)) - Number(priorityCodes.has(a.ts_code)))
    .slice(0, limit);
  for (const candidate of selected) {
    const financial = stockEvidence(input.marketDb, candidate.ts_code, asOf);
    const thesis = [`技术研究状态：${candidate.research_state}；当前分类来自已生成的热点技术快照。`];
    const counter = [...(candidate.counter_evidence ?? []), ...(candidate.conflicting_evidence ?? []), ...(candidate.trading_constraints ?? [])];
    cases.push({
      schema: RESEARCH_CASE_SCHEMA, case_id: caseId(candidate.ts_code, asOf), ts_code: candidate.ts_code,
      name: candidate.name ?? null, role: 'CANDIDATE', as_of_trade_date: asOf,
      horizon: { primary: '技术观察期限以快照状态规则为准', next_review: asOf },
      technical: { status: 'AVAILABLE', source: 'hotspot_research.technical_view_v2', value: candidate },
      fundamentals: financial.fundamentals,
      valuation: financial.valuation,
      sentiment_and_flows: missing('候选研究案例尚未接入可审计的资金参与视图'),
      events: missing('候选研究案例尚未接入去重且完成实体映射的事件视图'),
      investment_thesis: thesis,
      counter_thesis: counter.length ? counter : ['没有完整的基本面、估值、资金与事件反证；当前证据不足不能视为风险不存在。'],
      evidence_gaps: [...new Set([
        '候选研究案例尚未接入可审计的资金参与视图',
        '候选研究案例尚未接入去重且完成实体映射的事件视图',
        ...[financial.fundamentals, financial.valuation]
          .filter(dim => dim.status === 'UNAVAILABLE' && dim.gap)
          .map(dim => String(dim.gap)),
      ])],
      changes_today: [`来自 ${candidate.research_state} 技术快照；该快照不是收益验证或买入信号。`],
      confirmation_conditions: ['技术状态按既有 V2 框架在后续交易日复核；不复制或改写状态机。'],
      invalidation_conditions: ['技术快照转为 INVALIDATED/EXPIRED，或数据质量不再 READY 时重新评估。'],
      next_validation_point: '下一交易日更新技术快照，并补充账户相关性优先级所需的证据',
      evidence_class: 'model_derived',
      limitations: ['候选仅为研究对象；排序不代表预期收益、概率或账户适配性。','候选发现范围受当前热点快照研究宇宙限制，不能据此声称已覆盖全市场。'],
    });
  }
  return cases;
}
