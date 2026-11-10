/**
 * 唯一投资者报告模型（WP5）。
 *
 * 所有展示出口（Markdown 摘要、飞书六节正文、本地预览）都从这个对象取结论，
 * 不再各自决定“今天该说什么”。模型只引用引擎已经算出的字段，不重新算数字：
 * 首选/备选来自 decision_plans，持仓判断来自 research_cases 与 holdings，
 * 基准差异来自 benchmarks，缺口与限制来自 evidence_gaps 与账户核对状态。
 *
 * 研究倾向、执行可行性、策略证据等级是三个独立字段，任何出口都不得合并它们。
 */

export const REPORT_MODEL_SCHEMA = 'ashare-investor-report-model/1.0';

export interface InvestorReportSection {
  key: string;
  title: string;
  conclusion: string;
  reasons: string[];
  missing: string[];
}

export interface InvestorReportModel {
  schema: typeof REPORT_MODEL_SCHEMA;
  as_of_trade_date: string | null;
  /** 报告中所有事实的最晚可用时点（行情/账本/快照中最晚者）。 */
  knowledge_cutoff: string | null;
  account_version: {
    account_id: string;
    snapshot_id: string | null;
    status: string;
    reported_events_through: string | null;
    last_user_reconciled_at: string | null;
    reconciliation_note: string;
  };
  /** 一锤定音的结论句；所有渲染出口逐字使用，不再自行拼接。 */
  conclusion: string;
  preferred: { action: string; label: string; lean: string; strongest_counter: string } | null;
  backup: { action: string; label: string; lean: string; strongest_counter: string } | null;
  /** 逐持仓判断，供飞书/预览表格直接渲染；不再由展示层从理由文本反推。 */
  holdings_rows: Array<{
    ts_code: string; name: string | null; weight: number | null; stance: string; basis: string;
    technical_status: string; fundamentals_status: string;
  }>;
  sections: InvestorReportSection[];
  evidence_refs: string[];
  limitations: string[];
}

export function buildInvestorReportModel(input: {
  asOf: string | null;
  generatedAt: string;
  verification: {
    account_id?: string | null; snapshot_id?: string | null; summary_status?: string | null;
    reported_events_through?: string | null; last_user_reconciled_at?: string | null;
  } | null;
  portfolio: any;
  benchmarks: any;
  researchCases: Array<{ ts_code: string; role: string; technical: { status: string }; fundamentals: { status: string }; investment_thesis: string[]; counter_thesis: string[] }>;
  gaps: Array<{ module: string; reason: string; affected?: string[] }>;
  marketAsOf: string | null;
  hotspotAsOf?: string | null;
}): InvestorReportModel {
  const decision = input.portfolio?.decision_comparison ?? null;
  const plans: any[] = decision?.decision_plans ?? [];
  const preferred = plans.find(plan => plan.role === 'PREFERRED') ?? null;
  const backup = plans.find(plan => plan.role === 'BACKUP') ?? null;
  const holdings: any[] = input.portfolio?.holdings ?? [];
  // 券商对账以账户验证汇总为准。`last_user_reconciled_at` 只是用户手工核对时间，
  // 单独用它会把 DEGRADED 账户误写成“已对账”。
  const verified = input.verification?.summary_status === 'VERIFIED';
  const userCheckedAt = input.verification?.last_user_reconciled_at ?? null;
  const marketLines: string[] = Array.isArray(input.portfolio?.market_judgement?.judgement)
    ? input.portfolio.market_judgement.judgement.map(String) : [];

  const conclusion = preferred
    ? `本期研究首选：${preferred.label}。${preferred.research_lean}最强反证：${preferred.strongest_counter}`
      + (verified ? '' : '账户尚未完成券商对账，方案只作研究比较，不提供可直接使用的数量。')
    : '本期没有可比较的方案：账户或行情证据不足；这不等于现有持仓已被证明最优。';

  const holdingsRows = holdings.map((holding: any) => {
    const researchCase = input.researchCases.find(item => item.ts_code === holding.ts_code && item.role === 'HOLDING');
    const stanceZh: Record<string, string> = { HOLD: '继续观察', WATCH: '重点观察', REDUCE: '可研究降低风险', ROTATE: '可研究轮动（未验证）', WAIT: '等待行情' };
    return {
      ts_code: String(holding.ts_code), name: holding.name ?? null, weight: holding.weight ?? null,
      stance: stanceZh[String(holding.stance)] ?? '证据不足以确定调整',
      basis: [...(holding.reasons ?? []).slice(0, 1), ...(holding.counter_evidence ?? []).slice(0, 1)].map(String).join('；') || '数据不足以单独评述风险。',
      technical_status: researchCase?.technical.status ?? 'UNAVAILABLE',
      fundamentals_status: researchCase?.fundamentals.status ?? 'UNAVAILABLE',
    };
  });

  const optionRows = (decision?.options ?? []).map((option: any) => ({
    action: option.action, label: option.label, funding_status: option.funding_status,
    fees_cents: option.fees_cents, cash_after_cents: option.cash_after_cents,
    executable: false,
  }));
  const cashPlan = decision?.cash_plan ?? null;

  const benchmark = input.benchmarks ?? null;
  const benchmarkConclusion = benchmark?.basket_definition?.comparison_label
    ?? (benchmark?.data_quality?.status ? `基准对照数据状态：${benchmark.data_quality.status}` : '本次没有可用的基准对照窗口。');
  // benchmark 模块把各条基准放在 `benchmarks` 数组里（不是 `rows`）；这里只做展示，
  // 不重算收益，缺失的基准保持缺失而不是补零。
  const benchmarkRows: any[] = Array.isArray(benchmark?.benchmarks) ? benchmark.benchmarks
    : Array.isArray(benchmark?.rows) ? benchmark.rows : [];
  const benchmarkReasons = benchmarkRows.slice(0, 6).map((row: any) => {
    if (typeof row === 'string') return row;
    const label = String(row?.label ?? row?.name ?? row?.id ?? '基准');
    const ret = row?.total_return_pct;
    if (typeof ret === 'number' && Number.isFinite(ret)) {
      const dd = row?.max_drawdown_pct;
      return typeof dd === 'number' && Number.isFinite(dd)
        ? `${label}：区间收益 ${ret}%，最大回撤 ${dd}%`
        : `${label}：区间收益 ${ret}%`;
    }
    return `${label}：${row?.status ?? '收益不可得'}`;
  });

  const nextConditions = [
    ...(input.portfolio?.first_section?.observation_triggers ?? []),
    ...(decision?.decision_plans ?? []).flatMap((plan: any) => plan.role === 'PREFERRED' ? (plan.conditions ?? []) : []),
  ].map(String);

  const missing: string[] = [];
  if (!verified) missing.push('券商实际对账（用户完整性声明不等于券商对账）');
  const technicalMissing = input.researchCases.filter(item => item.technical.status === 'UNAVAILABLE').length;
  const fundamentalMissing = input.researchCases.filter(item => item.fundamentals.status === 'UNAVAILABLE').length;
  if (technicalMissing) missing.push(`${technicalMissing} 个研究案例缺少当日可校验技术切片`);
  if (fundamentalMissing) missing.push(`${fundamentalMissing} 个研究案例缺少公告日约束下的财务数据`);
  if (!cashPlan || cashPlan.funding_status === 'NOT_PROVIDED') missing.push('现金建仓候选（未指定买入标的）');
  missing.push('事件与资金参与证据（尚未接入可审计来源，缺失不等于没有事件）');

  const knowledgeCutoff = [input.marketAsOf, input.hotspotAsOf, input.verification?.reported_events_through]
    .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;

  return {
    schema: REPORT_MODEL_SCHEMA,
    as_of_trade_date: input.asOf,
    knowledge_cutoff: knowledgeCutoff,
    account_version: {
      account_id: input.verification?.account_id ?? 'UNKNOWN',
      snapshot_id: input.verification?.snapshot_id ?? null,
      status: input.verification?.summary_status ?? 'UNKNOWN',
      reported_events_through: input.verification?.reported_events_through ?? null,
      last_user_reconciled_at: input.verification?.last_user_reconciled_at ?? null,
      reconciliation_note: verified
        ? '账户验证汇总为 VERIFIED；覆盖范围以该次核验为准。'
        : `账户验证汇总为 ${input.verification?.summary_status ?? 'UNKNOWN'}；`
          + (userCheckedAt ? `用户手工核对时间 ${userCheckedAt}，` : '当前未记录用户手工核对时间，')
          + '券商实际对账尚未确认，用户交易完整性声明与券商对账分开保存。',
    },
    conclusion,
    preferred: preferred ? { action: preferred.action, label: preferred.label, lean: preferred.research_lean, strongest_counter: preferred.strongest_counter } : null,
    backup: backup ? { action: backup.action, label: backup.label, lean: backup.research_lean, strongest_counter: backup.strongest_counter } : null,
    holdings_rows: holdingsRows,
    sections: [
      {
        key: 'today_judgement', title: '今日判断', conclusion,
        reasons: preferred ? [preferred.research_lean, ...marketLines.slice(0, 2)] : marketLines.slice(0, 3),
        missing: verified ? [] : ['券商对账状态'],
      },
      {
        key: 'holdings', title: '持仓与变化',
        conclusion: `当前 ${holdingsRows.length} 项持仓；每项研究案例的技术与财务状态分别披露。`,
        reasons: holdingsRows.map((row: any) => `${row.ts_code}：${row.stance}；${row.basis}`),
        missing: missing.filter(text => text.includes('研究案例')),
      },
      {
        key: 'decision_comparison', title: '方案对照',
        conclusion: preferred ? `首选 ${preferred.action}，备选 ${backup?.action ?? '无'}；所有方案 executable=false。` : '没有可比较的方案。',
        reasons: [...optionRows.map((row: any) => `${row.action}：${row.label}（${row.funding_status}）`),
          ...(cashPlan ? [`现金方案：${cashPlan.code ?? '未指定'}，可买 ${cashPlan.affordable_lots ?? '不可得'} 手，费用占比 ${cashPlan.fee_pct_of_spend ?? '不可得'}%。`] : [])],
        missing: cashPlan && cashPlan.funding_status !== 'FUNDED' && cashPlan.funding_status !== 'NOT_PROVIDED' ? [`现金方案状态：${cashPlan.funding_status}`] : [],
      },
      {
        key: 'benchmark', title: '基准差异', conclusion: benchmarkConclusion,
        reasons: benchmarkReasons,
        missing: benchmarkRows.length ? [] : ['基准对照'],
      },
      {
        key: 'next_session_conditions', title: '下一交易日条件',
        conclusion: nextConditions[0] ?? '下一交易日复核行情、持仓事实与账户核对状态。',
        reasons: nextConditions.slice(0, 5), missing: [],
      },
      {
        key: 'evidence_and_limits', title: '证据与限制',
        conclusion: '研究结论来自本地只读缓存与账本重建；策略有效性未经验证，缺失证据不等于负面证据。',
        reasons: input.gaps.slice(0, 5).map(gap => `${gap.module}: ${gap.reason}`),
        missing,
      },
    ],
    evidence_refs: input.gaps.flatMap(gap => gap.affected ?? []).filter((value, index, all) => all.indexOf(value) === index),
    limitations: [
      '研究倾向、执行可行性与策略有效性是三件不同的事：本报告不提供下单授权。',
      '未执行部署、推送、调度修改或飞书写入；预览与回读状态以交付说明为准。',
      '没有经过前瞻验证的收益证据，不承诺盈利，也不把检测数量当作业绩。',
    ],
  };
}
