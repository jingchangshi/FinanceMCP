import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolveResearchDate, type ResearchDateResolution } from '../ashare/researchDate.js';
import { latestReportMeta, loadReport } from '../ashare/report.js';
import { checkQuality } from '../ashare/ingest.js';
import { etfStatus } from '../ashare/etf.js';
import { screenEtfCandidates, ETF_UNIVERSE_VERSION } from '../ashare/etfUniverse.js';
import {
  collectEtfPenetrationInputs, buildEtfPenetrationSummary, type EtfPenetrationSummary,
} from '../ashare/etfPenetration.js';
import { buildBenchmarkComparison, BENCHMARK_DEFINITION_VERSION } from './benchmarks.js';
import { buildDailyReport } from './dailyReport.js';
import { resolveAccountId, resolveAccountSnapshot } from './accounts.js';
import { listResearchJournal, evaluateResearchJournal, journalFeeEstimator } from './researchJournal.js';
import { loadFeeContext, feeRulesFor, type FeeEvidence } from './fees.js';
import { resolveInstrument } from './instrument.js';
import { loadValidationSummary } from '../ashare/validation.js';
import { evaluateAccountStatus, type AccountStatusEvaluation } from './decision.js';
import { realAccountGate, readAccountCompleteness, type AccountCompleteness } from './ledger.js';
import {
  EVIDENCE_MODEL_SCHEMA, registerEvidence, summarizeEvidenceState, fromChatgptEvidence,
  fromResearchEvidenceProvenance, highConfidenceSet, type EvidenceEntry, type EvidenceRegisterResult,
} from '../ashare/evidenceModel.js';

export const RESEARCH_BUNDLE_SCHEMA = 'ashare-investment-research-bundle/1.0';
export interface ResearchBundleInput {
  portfolioDb: DatabaseSync;
  marketDb: DatabaseSync | null;
  accountId?: string;
  asOfTradeDate?: string;
  now?: Date;
  maxCandidates?: number;
}

// ---------------------------------------------------------------- 账户真实性与完整性分离（任务书 §3.2）
//
// 八项状态在 bundle 内全量保留为机器可读结构（account_verification.dimensions），
// 面向自然语言的转换由 accountNarrative() 提供给渲染层。所有维度只由源数据派生：
// 身份门控 realAccountGate、账本重建 evaluateAccountStatus、对账 ReconciliationResult、
// 费用档案 evidence 等级（fees.ts 只读 import）。绝不因市场数据可用而抬高账户维度状态。

export type VerificationStatus8 = 'VERIFIED' | 'UNVERIFIED' | 'UNCONFIRMED_RISK' | 'UNKNOWN';

export interface VerificationDimension {
  status: VerificationStatus8;
  /** 该维度可用的事实依据（时间戳/数量），没有依据时为 null。 */
  basis: string | null;
  detail: string;
}

export interface AccountVerificationState {
  schema: string;
  account_id: string;
  as_of: string;
  identity_status: 'REAL_ACCOUNT_VERIFIED' | 'REAL_ACCOUNT_PENDING';
  /** 汇总门控：全部八项 VERIFIED 才是 VERIFIED。 */
  summary_status: 'VERIFIED' | 'DEGRADED' | 'UNAVAILABLE';
  dimensions: {
    account_identity: VerificationDimension;
    ledger_complete: VerificationDimension;
    cash_verified: VerificationDimension;
    positions_verified: VerificationDimension;
    sellable_verified: VerificationDimension;
    fees_verified: VerificationDimension;
    unreported_trade_risk: VerificationDimension;
    nav_performance_eligible: VerificationDimension;
  };
  /** 自然语言摘要（技术附件用；用户版应经 accountNarrative 转换）。 */
  narrative: string;
}

function dim(status: VerificationStatus8, basis: string | null, detail: string): VerificationDimension {
  return { status, basis, detail };
}

/** ReconciliationResult.checks 的 field → 状态行；没有对账时整体 UNKNOWN。 */
function checksByField(checks: { field: string; status: string }[] | null | undefined) {
  const map = new Map<string, string>();
  for (const row of checks ?? []) if (!map.has(row.field)) map.set(row.field, row.status);
  return map;
}

/**
 * 费用核验状态：逐字段证据等级聚合。
 * - VERIFIED：所有关键费率字段均为 CONFIRMED（券商实际条款已核对）；
 * - UNVERIFIED：存在档案但字段停留在 ASSUMED/UNKNOWN（当前生产即此态）；
 * - UNKNOWN：连假设档案都没有。
 * 滑点永远是估算，不参与 VERIFIED 判定，但其 UNKNOWN 计入不完整。
 */
export function feeVerificationStatus(rules: {
  fee_model?: { evidence?: Partial<Record<string, { level: FeeEvidence }>> };
  commission_rate?: number; commission_min_cents?: number;
} | null): VerificationStatus8 {
  if (!rules || !rules.fee_model || !rules.fee_model.evidence) return 'UNKNOWN';
  const evidence = rules.fee_model.evidence;
  const critical = ['commission_rate', 'commission_min_cents', 'transfer_fee_rate', 'stamp_duty_rate'] as const;
  const levels = critical.map(field => evidence[field]?.level ?? 'UNKNOWN');
  if (levels.some(level => level === 'UNKNOWN')) return 'UNKNOWN';
  if (levels.every(level => level === 'CONFIRMED')) return 'VERIFIED';
  return 'UNVERIFIED';
}

export function buildAccountVerification(input: {
  db: DatabaseSync;
  accountId: string;
  asOf: string;
  snapshot: AccountStatusEvaluation | null;
  completeness: AccountCompleteness | null;
  feeRules: any;
}): AccountVerificationState {
  const identity = realAccountGate(input.db, input.accountId);
  const evaluation = input.snapshot;
  const checks = checksByField(evaluation?.reconciliation?.checks);
  const reconstruction = evaluation?.state_basis === 'ledger_reconstruction' || evaluation?.state_basis === 'same_day_snapshot';
  const reasons = (evaluation?.reasons ?? []).map(reason => reason.code).join(',');

  const accountIdentity = identity.verified
    ? dim('VERIFIED', identity.confirmed_at, `真实账户已确认（${identity.confirmed_at ?? '确认时间未记录'}）`)
    : dim('UNVERIFIED', null, `账户 ${input.accountId} 未确认为真实账户（REAL_ACCOUNT_PENDING）`);

  const ledgerComplete = !evaluation
    ? dim('UNKNOWN', null, '账户快照缺失，无法评估账本完整性')
    : reconstruction && !evaluation.future_events && evaluation.reconstruction_as_of !== null
      ? dim('VERIFIED', evaluation.reconstruction_as_of,
        `账本可按 ${evaluation.reconstruction_as_of} 重建；完整性声明覆盖 ${evaluation.completeness_as_of ?? '缺失'}，`
        + `用户已录入至 ${evaluation.reported_events_through ?? '未声明'}；无未来事件污染`)
      : dim('UNVERIFIED', null, `账本不可按 ${input.asOf} 唯一重建（${reasons || 'state_basis=none'}）`);

  const cashVerified = evaluation?.reconciliation
    ? (checks.get('cash_cents') === 'MATCH'
      ? dim('VERIFIED', evaluation.reconciliation.checked_at, '现金：快照与账本重放一致')
      : checks.get('cash_cents') === 'MISMATCH'
        ? dim('UNVERIFIED', evaluation.reconciliation.checked_at, '现金：快照与账本重放不一致，不能声称已对账')
        : dim('UNKNOWN', null, '现金：对账未覆盖'))
    : reconstruction
      ? dim('UNKNOWN', evaluation?.reconstruction_as_of ?? null,
        `现金由账本重建（${evaluation?.reconstruction_as_of ?? input.asOf}），未经快照双账对账核验`)
      : dim('UNKNOWN', null, '没有双账对账结果，现金是否核验未知');

  const positionMismatch = (evaluation?.reconciliation?.mismatches ?? []).some(row => row.field === 'quantity');
  const positionsVerified = evaluation?.reconciliation
    ? (positionMismatch
      ? dim('UNVERIFIED', evaluation.reconciliation.checked_at, '持仓数量：快照与账本重放存在差异')
      : dim('VERIFIED', evaluation.reconciliation.checked_at, '持仓数量：对账完成，逐代码与账本重放一致'))
    : reconstruction
      ? dim('UNKNOWN', evaluation?.reconstruction_as_of ?? null,
        `持仓数量由账本重建（${evaluation?.reconstruction_as_of ?? input.asOf}），未经快照双账对账核验`)
      : dim('UNKNOWN', null, '没有双账对账结果，持仓数量是否核验未知');

  const sellable = evaluation?.sellable ?? {};
  const sellableCodes = Object.keys(sellable);
  const sellableVerified = !evaluation
    ? dim('UNKNOWN', null, '账户快照缺失，可卖数量不可得')
    : sellableCodes.length === 0
      ? dim('UNKNOWN', null, '可卖数量不可得（账本未给出重建后的可卖口径）')
      : dim('VERIFIED', evaluation.reconstruction_as_of ?? input.asOf,
        `可卖数量由账本重建（T+0/T+1 交收规则）：${sellableCodes.length} 个代码`);

  const feesVerified = input.feeRules
    ? (feeVerificationStatus(input.feeRules) === 'VERIFIED'
      ? dim('VERIFIED', null, '成交费用字段全部为券商条款已核对（CONFIRMED）')
      : feeVerificationStatus(input.feeRules) === 'UNVERIFIED'
        ? dim('UNVERIFIED', null, '成交费用为公开参考/假设值，未与券商实际费率核对')
        : dim('UNKNOWN', null, '费用档案不可得，费用口径未知'))
    : dim('UNKNOWN', null, '未按目标日加载费用档案，费用核验未知');

  const unreportedRisk = input.completeness === null
    ? dim('UNCONFIRMED_RISK', null, '缺少覆盖目标日的完整性声明，按存在未上报交易风险处理')
    : (evaluation?.unreported_trade_risk ?? true)
      ? dim('UNCONFIRMED_RISK', input.completeness.as_of,
        `完整性声明存在但风险未清：声明 as_of=${input.completeness.as_of}，已录入至 ${input.completeness.reported_events_through ?? '未声明'}`)
      : dim('VERIFIED', input.completeness.reported_events_through,
        `用户声明无未上报交易（已录入至 ${input.completeness.reported_events_through}）`);

  const navEligible = identity.verified && (evaluation?.reconciliation?.ok ?? false) && !(evaluation?.unreported_trade_risk ?? true)
    && input.completeness !== null;
  const navPerformanceEligible = navEligible
    ? dim('VERIFIED', input.completeness?.as_of ?? null,
      '账本已确认、对账一致、无未上报交易风险：净值序列可用于正式绩效分析')
    : dim(identity.verified && (evaluation?.reconciliation?.ok ?? false) ? 'UNCONFIRMED_RISK' : 'UNVERIFIED',
      identity.confirmed_at,
      identity.verified
        ? '账本尚未完成最终对账或仍存在未上报交易风险：净值只作参考，不作正式绩效'
        : '账户未确认为真实账户：净值不得用于正式绩效分析');

  const dimensions = {
    account_identity: accountIdentity,
    ledger_complete: ledgerComplete,
    cash_verified: cashVerified,
    positions_verified: positionsVerified,
    sellable_verified: sellableVerified,
    fees_verified: feesVerified,
    unreported_trade_risk: unreportedRisk,
    nav_performance_eligible: navPerformanceEligible,
  };
  const statuses = Object.values(dimensions).map(row => row.status);
  const summary: AccountVerificationState['summary_status'] = statuses.every(status => status === 'VERIFIED')
    ? 'VERIFIED'
    : statuses.every(status => status === 'UNKNOWN') ? 'UNAVAILABLE' : 'DEGRADED';
  return {
    schema: 'ashare-account-verification/1.0',
    account_id: input.accountId,
    as_of: input.asOf,
    identity_status: identity.verified ? 'REAL_ACCOUNT_VERIFIED' : 'REAL_ACCOUNT_PENDING',
    summary_status: summary,
    dimensions,
    narrative: '',
  };
}

/**
 * 八项状态 → 自然语言（任务书 §3.2：正文禁止直接罗列内部状态码）。
 * 供渲染层（reportRenderer / 用户版日报）消费；技术附件保留原始 machine-readable 结构。
 */
export function accountNarrative(verification: AccountVerificationState): string {
  const d = verification.dimensions;
  const sentences: string[] = [];
  sentences.push(d.account_identity.status === 'VERIFIED'
    ? '账户身份已确认为真实账户。'
    : '账户尚未确认为真实账户，以下金额仅供研究参考。');
  if (d.cash_verified.status === 'VERIFIED' && d.positions_verified.status === 'VERIFIED'
    && d.sellable_verified.status === 'VERIFIED') {
    sentences.push('账户持仓和现金已与账本重放核对一致，可卖数量按交收规则可得。');
  } else if (d.ledger_complete.status === 'VERIFIED') {
    sentences.push('账户持仓和现金采用最新已记录交易重建，尚未完成与券商账户的最终核对，因此下文资产金额仅供研究参考。');
  } else {
    sentences.push('账户账本无法按目标交易日重建，资产金额仅为快照参考，不能作为可执行依据。');
  }
  if (d.unreported_trade_risk.status === 'UNCONFIRMED_RISK') {
    sentences.push('仍可能存在尚未录入的成交，本期不提供可直接使用的买卖数量。');
  }
  sentences.push(d.fees_verified.status === 'VERIFIED'
    ? '交易费用已按券商实际费率核对。'
    : '交易费用为参考或假设费率，未与券商实际费率核对。');
  sentences.push(d.nav_performance_eligible.status === 'VERIFIED'
    ? '账户净值可用于正式绩效分析。'
    : '账户净值尚不可用于正式绩效分析，只作研究参考。');
  return sentences.join('');
}

// ---------------------------------------------------------------- Session 六态（任务书 §3.1 严格区分）
//
// researchDate.ts 是冻结外但被生产回放依赖的核心，本 bundle 不改其行为，只做**补充标注**：
// 六态里"历史快照重放"与"当前行情与旧快照混用"在此显式判定。前三态（未收盘 /
// 收盘后数据未就绪 / 交易日 / 非交易日）沿用 session.phase/status 与 data_quality，
// 且 bundle 已保证收盘后目标日缺数据时不回退前一天（DATA_INSUFFICIENT 拒绝替代）。

export type SessionState8 =
  | 'pre_close'
  | 'after_close_data_not_ready'
  | 'trading_day'
  | 'non_trading_day'
  | 'historical_replay'
  | 'mixed_current_market_and_stale_snapshot'
  | 'calendar_unavailable'
  | 'session_not_ready';

export interface SessionStateInfo {
  state: SessionState8;
  /** 六态全部机器可读列出；true = 当前命中。 */
  matched: Record<string, boolean>;
  detail: string;
  /** 是否为历史快照重放（requested/shanghai 早于今天，或报告 run_mode=replay）。 */
  historical_replay: boolean;
  /** 是否存在当前行情与旧账户快照混用。 */
  mixed: boolean;
}

function shanghaiToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (kind: string) => parts.find(item => item.type === kind)!.value;
  return `${part('year')}${part('month')}${part('day')}`;
}

export function resolveSessionState(input: {
  clock: ResearchDateResolution;
  now: Date;
  coreReady: boolean;
  freshness: string | null;
  snapshotAsOf: string | null;
  runMode: string | null;
}): SessionStateInfo {
  const today = shanghaiToday(input.now);
  const asOf = input.clock.as_of_trade_date;
  const requested = input.clock.requested_trade_date;
  // "历史快照重放" = 显式请求了更早的交易日，或报告 run_mode=replay；
  // 周末/节假日"使用最近已收盘交易日"不算重放（那是正常非交易日报告）。
  const historical = (requested !== null && requested < today) || input.runMode === 'replay';
  const snapshotYmd = input.snapshotAsOf ? input.snapshotAsOf.replace(/-/g, '') : null;
  const mixed = !!asOf && !!snapshotYmd && snapshotYmd < asOf
    && (input.freshness === 'same_day' || input.runMode === 'live');
  let state: SessionState8;
  let detail: string;
  if (input.clock.phase === 'CALENDAR_UNAVAILABLE') {
    state = 'calendar_unavailable';
    detail = `交易日历不可用（${input.clock.reason ?? 'unavailable'}）`;
  } else if (input.clock.reason === 'requested_date_not_trading_day') {
    state = 'non_trading_day';
    detail = `请求日 ${requested} 不是交易日（周末/节假日）；不生成当日结论`;
  } else if (input.clock.status !== 'READY') {
    state = input.clock.phase === 'PRE_CLOSE' ? 'pre_close' : 'session_not_ready';
    detail = `会话未就绪：${input.clock.reason ?? 'not_ready'}`;
  } else if (historical) {
    state = 'historical_replay';
    detail = `历史快照重放：目标 ${asOf ?? '未知'} 早于上海日期 ${today}${input.runMode === 'replay' ? '（报告 run_mode=replay）' : ''}`
      + (input.coreReady ? '' : '；核心数据缺失，不回退其他日期数据冒充当日');
  } else if (input.clock.phase === 'NON_TRADING_DAY') {
    state = 'non_trading_day';
    detail = `${today} 非交易日；使用最近已收盘交易日 ${asOf}`;
  } else if (!input.coreReady) {
    state = 'after_close_data_not_ready';
    detail = `目标交易日 ${asOf} 收盘后核心数据未就绪；不回退前一交易日数据`;
  } else if (input.clock.phase === 'PRE_CLOSE') {
    state = 'pre_close';
    detail = `尚未收盘（上海 ${today}）；研究目标为最近已收盘交易日 ${asOf}`;
  } else if (mixed) {
    state = 'mixed_current_market_and_stale_snapshot';
    detail = `当日行情（${asOf}）与更旧账户快照（${input.snapshotAsOf}）混用：资产估值部分回退快照参考价`;
  } else {
    state = 'trading_day';
    detail = `正常交易日 ${asOf}（上海日期 ${today}）`;
  }
  // 六态各自独立为 true/false：即使主状态被更具体的一态占据（如历史重放），
  // 数据未就绪、混用等事实仍然被如实标出。
  const matched: Record<string, boolean> = {
    未收盘: input.clock.phase === 'PRE_CLOSE',
    收盘后数据未就绪: input.clock.status === 'READY' && !input.coreReady,
    正常交易日: state === 'trading_day',
    非交易日: state === 'non_trading_day' || input.clock.phase === 'NON_TRADING_DAY',
    历史快照重放: historical,
    当前行情与旧快照混用: mixed,
  };
  return { state, matched, detail, historical_replay: historical, mixed };
}

/** Compose facts from existing engines. This path is read-only and never fetches network data. */
export function buildInvestmentResearchBundle(input: ResearchBundleInput): any {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const account = resolveAccountId(input.portfolioDb, input.accountId);
  const snapshot = resolveAccountSnapshot(input.portfolioDb, account.account_id);
  const clock = resolveResearchDate(input.marketDb, input.asOfTradeDate, now);
  const asOf = clock.as_of_trade_date;
  const gaps: { module: string; reason: string; affected: string[] }[] = [];
  const safe = (module: string, fn: () => any): any => {
    try { return fn(); }
    catch (error: any) {
      gaps.push({ module, reason: String(error?.message ?? error), affected: [module] });
      return null;
    }
  };
  const market = input.marketDb;
  const requestedLimit = input.maxCandidates ?? 8;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20) throw new Error('max_candidates must be 1..20');
  let quality: any = null;
  let published: any = null;
  let meta: any = null;
  let portfolio: any = null;
  let screening: any = null;
  let benchmarks: any = null;
  let etf: any = null;
  if (clock.status === 'READY' && asOf && market) {
    quality = safe('market_quality', () => checkQuality(market, asOf, false));
    meta = safe('market_report', () => latestReportMeta(market, asOf));
    if (meta && meta.trade_date === asOf) {
      const candidate = safe('market_report', () => loadReport(meta));
      if (candidate?.as_of_trade_date === asOf && candidate.report_id === meta.report_id) published = candidate;
      else gaps.push({ module: 'market_report', reason: 'report_metadata_mismatch', affected: ['market', 'sectors', 'watchlist', 'signals'] });
    }
    if (!published) gaps.push({ module: 'market_report', reason: 'target_date_report_unavailable', affected: ['market', 'sectors', 'watchlist', 'signals'] });
    const coreReady = quality && quality.status !== 'NOT_READY' && published && published.status !== 'NOT_READY';
    portfolio = safe('portfolio', () => buildDailyReport({
      portfolioDb: input.portfolioDb, marketDb: market, accountId: account.account_id, accountIdSource: account.source,
      snapshotId: snapshot.snapshot_id, asOfTradeDate: asOf, generatedAt,
    }));
    // A missing current market report must not be replaced by prior-day judgement inside the composed report.
    if (portfolio && !coreReady) {
      portfolio = { ...portfolio, status: 'DATA_INSUFFICIENT', actionable: false,
        market_judgement: { available: false, as_of_trade_date: asOf, reason: 'target_market_data_unavailable' },
        first_section: { ...portfolio.first_section, count: 0, actions: [], no_action_reason: 'DATA_INSUFFICIENT: target market data unavailable' },
      };
    }
    screening = safe('etf_candidates', () => screenEtfCandidates(market, {
      asOf, limit: requestedLimit, heldCodes: (portfolio?.holdings ?? snapshot.snapshot.positions).map((holding: any) => holding.ts_code),
    }));
    etf = safe('etf_quality', () => etfStatus(market, { date: asOf }));
    const baselineDate = snapshot.snapshot.as_of.replace(/-/g, '');
    benchmarks = safe('benchmarks', () => buildBenchmarkComparison({ marketDb: market, start: baselineDate, end: asOf,
      fee_context: loadFeeContext(input.portfolioDb, account.account_id, asOf),
    }));
  } else {
    gaps.push({ module: 'session', reason: clock.reason ?? 'session_unavailable', affected: ['market', 'portfolio_valuation', 'candidates', 'benchmarks'] });
  }
  const coreReady = clock.status === 'READY' && quality && quality.status !== 'NOT_READY'
    && published && published.status !== 'NOT_READY';
  if (quality?.reasons?.length) gaps.push({ module: 'market_quality', reason: quality.reasons.join('; '), affected: ['market'] });
  const targetReport = coreReady ? published : null;
  const etfNotReady = portfolio?.data_quality?.quotes
    ? [...portfolio.data_quality.quotes.stale, ...portfolio.data_quality.quotes.not_ready, ...portfolio.data_quality.quotes.missing] : [];
  if (etfNotReady.length) gaps.push({ module: 'etf_price', reason: etfNotReady.join(','), affected: ['valuation', 'rotation'] });
  if (portfolio?.gate?.unreported_trade_risk) gaps.push({ module: 'account_completeness', reason: 'unreported_trade_risk', affected: ['executable_quantities'] });
  const versions = {
    bundle: RESEARCH_BUNDLE_SCHEMA, market: targetReport?.versions ?? null,
    etf_universe: ETF_UNIVERSE_VERSION, benchmark: BENCHMARK_DEFINITION_VERSION,
    benchmark_status: benchmarks?.basket_definition ? `${benchmarks.basket_definition.status}:${benchmarks.basket_definition.approved_on}:${benchmarks.basket_definition.comparison_basis}` : null,
    portfolio: portfolio?.schema ?? null,
  };
  const sync = market && asOf ? safe('sync_times', () => market.prepare(
    'SELECT dataset,key,status,synced_at FROM sync_log WHERE key <= ? ORDER BY synced_at DESC LIMIT 20',
  ).all(asOf)) : null;
  const historical = market && asOf ? safe('research_tracking', () => ({
    legacy_plans: readTracking(input.portfolioDb, account.account_id, asOf),
    records: listResearchJournal(input.portfolioDb, { accountId: account.account_id, asOf, limit: 5 })
      .map(({ payload, ...record }) => record),
    evaluations: evaluateResearchJournal({ portfolioDb: input.portfolioDb, marketDb: market, accountId: account.account_id, asOf, limit: 5,
      feeEstimator: journalFeeEstimator(input.portfolioDb, market, account.account_id),
    }),
  })) : null;
  const candidates = screening?.candidates ?? [];
  // Held instruments stay present even if missing or below any screen threshold.
  const held = candidates.filter((row: any) => row.held);
  const other = candidates.filter((row: any) => !row.held).slice(0, requestedLimit);
  const feeContext = asOf ? loadFeeContext(input.portfolioDb, account.account_id, asOf) : null;
  const feeSummary = feeContext ? (portfolio?.holdings ?? snapshot.snapshot.positions).map((holding: any) => {
    const kind = market ? resolveInstrument(market, holding.ts_code).kind : 'UNKNOWN';
    if (kind === 'UNKNOWN') return { ts_code: holding.ts_code, status: 'UNKNOWN', reason: 'instrument_identity_unavailable' };
    const rules = feeRulesFor(feeContext, holding.ts_code, kind);
    return { ts_code: holding.ts_code, values: { ...rules, fee_context: undefined }, provenance: rules.fee_model };
  }) : null;
  const validation = asOf ? loadValidationSummary({ dbPath: process.env.ASHARE_VALIDATION_DB_PATH, asOf }) : null;
  // ---- 账户真实性与完整性分离（§3.2）：八项机器可读状态 + 面向人的自然语言。
  const completeness: AccountCompleteness | null = asOf ? readAccountCompleteness(input.portfolioDb, account.account_id) : null;
  let verification: AccountVerificationState | null = null;
  if (asOf && snapshot) {
    let evaluation: AccountStatusEvaluation | null = null;
    try {
      evaluation = evaluateAccountStatus(input.portfolioDb, {
        snapshot_id: snapshot.snapshot_id,
        as_of: snapshot.snapshot.as_of,
        is_current: (snapshot.snapshot as any).is_current,
        positions: snapshot.snapshot.positions.map((p: any) => ({ ts_code: p.ts_code, quantity: p.quantity, ref_price_milli: p.ref_price_milli })),
        totals: { cash_cents: snapshot.snapshot.totals.cash_cents, securities_mv_cents: snapshot.snapshot.totals.securities_mv_cents },
      }, account.account_id, asOf);
    } catch (error: any) {
      gaps.push({ module: 'account_verification', reason: String(error?.message ?? error), affected: ['account_verification'] });
    }
    const feeRow = (feeSummary ?? []).find((row: any) => row && typeof row === 'object' && 'values' in row) ?? null;
    verification = safe('account_verification', () => buildAccountVerification({
      db: input.portfolioDb, accountId: account.account_id, asOf, snapshot: evaluation,
      completeness, feeRules: feeRow ? feeRow.values : null,
    }));
  } else if (asOf) {
    gaps.push({ module: 'account_verification', reason: 'account_snapshot_unavailable', affected: ['account_verification'] });
  }

  // ---- 统一证据登记（§3.3）：15 字段 + NEW/UPDATED/UNCHANGED/INVALIDATED。
  // 接入两条既有来源（ChatGPT 追加协议片段、research_evidence 轮动门控记录），去重后
  // 汇总状态；登记只读，不写任何库。重复引用旧闻 counts_as_new_evidence=false。
  // normalizeEvidence 是防御性校验：两条映射源的字段都由本仓构造，格式违规在这里
  // 会变成 data_quality.gaps（module=evidence_model）而不是静默丢弃或伪造。
  const evidenceState = new Map<string, EvidenceEntry>();
  const evidenceTally = new Map<string, EvidenceRegisterResult['outcome']>();
  const registerAll = (items: Record<string, unknown>[], source: string) => {
    for (const item of items) {
      try {
        const result = registerEvidence(evidenceState, item, { now });
        evidenceState.set(result.entry.evidence_id, result.entry);
        evidenceTally.set(result.entry.evidence_id, result.outcome);
      } catch (error: any) {
        gaps.push({ module: 'evidence_model', reason: `${source}: ${String(error?.message ?? error)}`, affected: ['evidence_register'] });
      }
    }
  };
  if (asOf && historical) {
    for (const record of historical.records as any[]) {
      if (Array.isArray(record.evidence)) {
        // 只登记真正的追加协议片段（带 claim）。VPS 记录的 evidence 是技术信号行
        // （market_summary 形状，无 claim），它们已在 technical_signals 里，不是公开来源证据。
        const fragments = record.evidence
          .filter((item: any) => item && typeof item.claim === 'string' && item.claim.trim() !== '')
          .map((item: any) => fromChatgptEvidence(item, { retrievedAt: record.recorded_at }));
        registerAll(fragments, 'chatgpt_intake');
      }
    }
  }
  registerAll(safe('evidence_model', () => {
    if (!input.portfolioDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_evidence'").get()) return [];
    return (input.portfolioDb.prepare('SELECT evidence_id, kind, buy_code, sell_code, strategy_id, as_of, valid_until, status, recorded_by, recorded_at, note, provenance_json FROM research_evidence ORDER BY evidence_id').all() as any[])
      .map(row => fromResearchEvidenceProvenance({
        evidence_id: row.evidence_id, as_of: row.as_of, buy_code: row.buy_code, sell_code: row.sell_code,
        recorded_at: row.recorded_at, status: row.status,
        provenance: row.provenance_json ? (() => { try { return JSON.parse(row.provenance_json); } catch { return null; } })() : null,
      }));
  }) ?? [], 'research_evidence');
  const evidenceSummary = summarizeEvidenceState(evidenceState, asOf ? { asOf } : {});

  // ---- ETF 穿透摘要（C-etf 两步管线接线）：collectEtfPenetrationInputs → buildEtfPenetrationSummary。
  // 输出挂顶层 etf_penetration（facts 之外，不入 report_id）。块内 gaps **刻意不**并入
  // facts.gaps：facts 参与身份哈希，而本地无成分权重缓存时每只持仓 ETF 都会 UNAVAILABLE，
  // 并入 facts 会改变 20261023 生产回放 ID（BUNDLE-20261023-89c7364f…）。机制同构
  // （{module, reason, affected}），作用域在块内。
  const etfPenetration = buildEtfPenetrationState({
    db: market, asOf,
    holdings: (portfolio?.holdings ?? snapshot.snapshot.positions).map((holding: any) => holding.ts_code),
  });

  const facts = {
    schema: RESEARCH_BUNDLE_SCHEMA, as_of_trade_date: asOf, account_id: account.account_id,
    market_report_id: targetReport?.report_id ?? null, market: targetReport,
    portfolio, benchmarks, validation, gaps,
    ...(portfolio?.portfolio_risk ? { portfolio_risk: portfolio.portfolio_risk } : {}),
    versions, quality: quality?.status ?? 'NOT_READY', fees: feeSummary,
    candidates: [...held, ...other], account_snapshot_id: snapshot.snapshot_id,
  };
  const reportId = `BUNDLE-${asOf ?? 'UNKNOWN'}-${createHash('sha256').update(stableFacts(facts)).digest('hex').slice(0, 20)}`;
  const status = !coreReady ? 'DATA_INSUFFICIENT' : gaps.length || !portfolio ? 'DEGRADED' : 'READY';
  // ---- §3.1 顶层数据血缘：全部在 facts（身份哈希）**之外**，只作只读披露，
  // 不改变既有 report_id（生产回放 20261023 的 BUNDLE-…-89c7364f50fe48a016dd 保持不变）。
  const sessionState = resolveSessionState({
    clock, now, coreReady,
    freshness: published?.as_of_trade_date === asOf ? 'same_day' : published ? 'prior_day' : 'missing',
    snapshotAsOf: snapshot?.snapshot?.as_of ?? null,
    runMode: (meta as any)?.run_mode ?? (targetReport as any)?.run_mode ?? null,
  });
  const datasetLastUpdated = Array.isArray(sync) && sync.length
    ? sync.reduce((latest: string | null, row: any) => (!latest || String(row.synced_at) > latest ? String(row.synced_at) : latest), null)
    : null;
  const lineage = {
    schema: 'ashare-data-lineage/1.0',
    target_trade_date: asOf,
    shanghai_date: clock.shanghai_date,
    requested_trade_date: clock.requested_trade_date,
    ledger_cutoff: verification ? {
      as_of: verification.as_of,
      reported_events_through: completeness?.reported_events_through ?? null,
      completeness_as_of: completeness?.as_of ?? null,
      last_user_reconciled_at: completeness?.last_user_reconciled_at ?? null,
      state_basis: (portfolio?.gate?.state_basis ?? 'none'),
      snapshot_id: snapshot.snapshot_id,
    } : null,
    dataset_last_updated_at: datasetLastUpdated,
    market_report_generated_at: (meta as any)?.generated_at ?? null,
    market_report_run_mode: (meta as any)?.run_mode ?? null,
    market_report_freshness: published?.as_of_trade_date === asOf ? 'same_day' : published ? 'prior_day' : 'missing',
    record_generated_at: generatedAt,
  };
  const conclusionRefs = buildConclusionRefs({ asOf, targetReport, validation, portfolio, benchmarks, feeSummary, screening });
  return {
    schema: RESEARCH_BUNDLE_SCHEMA, report_id: reportId, generated_at: generatedAt,
    // Declares whether this report_id is a persisted snapshot. Derived from stored state, so it is not part of identity.
    persisted_snapshot: persistedSnapshotStatus(input.portfolioDb, account.account_id, asOf, reportId),
    as_of_trade_date: asOf, session: clock, account_id: account.account_id, status,
    account_status: portfolio?.account_status ?? 'UNKNOWN', evidence_status: 'UNVERIFIED',
    // §3.1 六态显式标注（historical_replay 等）；machine-readable，不参与身份哈希。
    session_state: sessionState,
    // §3.1 顶层目标交易日 / 上海日期 / 账本截止 / 数据集更新时间 / 各结论数据版本。
    data_lineage: lineage,
    claim_versions: conclusionRefs,
    // §3.2 八项账户真实性与完整性分离状态（全量机器可读）+ 面向人的自然语言摘要。
    account_verification: verification,
    account_narrative: verification ? accountNarrative(verification) : null,
    // §3.3 统一证据模型登记与变化状态汇总（接入层，只读）。
    evidence_register: {
      schema: EVIDENCE_MODEL_SCHEMA,
      as_of_trade_date: asOf,
      entries: [...evidenceState.values()],
      outcomes: Object.fromEntries(evidenceTally),
      summary: evidenceSummary,
      high_confidence: highConfidenceSet(evidenceState.values(), asOf ? { asOf } : {}),
      status_derivation: 'NEW/UPDATED/UNCHANGED/INVALIDATED 按正文指纹、首次出现日与研究截止日推导；重复引用旧闻不计新证据（见 summary.duplicate_count）',
    },
    data_quality: {
      market: { status: quality?.status ?? 'NOT_READY', as_of_trade_date: asOf, reasons: quality?.reasons ?? [clock.reason ?? 'unavailable'] },
      account: portfolio?.data_quality?.tiers ?? { identity: 'UNKNOWN', completeness: 'UNKNOWN', executable: false },
      etf: etf ? { as_of_trade_date: etf.as_of_trade_date, quality: etf.quality, codes: etf.codes } : null,
      synchronized_at: sync,
    },
    market: targetReport?.market ?? { available: false, reason: 'target_market_data_unavailable' },
    sectors: targetReport?.sectors ? { top: targetReport.sectors.top, bottom: targetReport.sectors.bottom } : null,
    watchlist: targetReport?.watchlist ? {
      count: targetReport.watchlist.count, previous_date: targetReport.watchlist.previous_date,
      added: targetReport.watchlist.added, removed: targetReport.watchlist.removed,
      industry_distribution: targetReport.watchlist.industry_distribution,
      historical_effectiveness: targetReport.watchlist.track_record,
      focused_candidates: (targetReport.watchlist.members ?? []).slice(0, 5),
      full_list_tool: 'ashare_watchlist',
    } : null,
    research_validation: validation,
    technical_signals: targetReport?.signals ? {
      research_scope: 'IN_SAMPLE_UNVERIFIED', current: targetReport.signals.market_summary,
      limitation: 'Overlapping historical windows and heuristic rankings are not profit probabilities or validated rotation advantage.',
    } : null,
    etf_candidates: screening ? {
      as_of_trade_date: asOf, data_coverage: screening.data_coverage,
      universe_version: screening.universe_version ?? ETF_UNIVERSE_VERSION,
      candidates: [...held, ...other], total_candidates: candidates.length,
      truncated: other.length < candidates.filter((row: any) => !row.held).length,
      details_tool: 'ashare_etf_candidates', evidence_status: 'UNVERIFIED',
    } : null,
    // §4 ETF穿透摘要接线（只读本地缓存；成分权重无入库缓存时逐只 UNAVAILABLE，不伪造）。
    etf_penetration: etfPenetration,
    portfolio,
    transaction_fees: { as_of_trade_date: asOf, securities: feeSummary, accounting: 'actual booked fees remain immutable; slippage estimates are separate' },
    benchmarks,
    ...(portfolio?.portfolio_risk ? { portfolio_risk: portfolio.portfolio_risk } : {}),
    research_tracking: historical,
    evidence_gaps: gaps,
    rules: versions,
    markdown_summary: [
      `# 投资研究事实包 ${asOf ?? 'UNKNOWN'} (${status})`,
      `报告 ID: ${reportId}`,
      `市场: ${quality?.status ?? 'NOT_READY'}；账户身份: ${portfolio?.account_status ?? 'UNKNOWN'}；研究优势: UNVERIFIED`,
      `决策: ${portfolio?.status ?? 'DATA_INSUFFICIENT'}；股票池: ${targetReport?.watchlist?.count ?? '不可用'}；ETF持仓报价缺口: ${etfNotReady.join('、') || '无/未评估'}`,
      `基准: ${BENCHMARK_DEFINITION_VERSION} ${benchmarks?.basket_definition?.status ?? 'UNAVAILABLE'}；${benchmarks?.basket_definition?.comparison_label ?? '基准窗口不可用'}`,
      ...(portfolio?.portfolio_risk ? [`组合风险政策 ${portfolio.portfolio_risk.policy.rule_version}：预警 ${portfolio.portfolio_risk.warning.level}；${portfolio.portfolio_risk.drawdown_note}`] : []),
      ...gaps.map(gap => `- ${gap.module}: ${gap.reason}`),
    ].join('\n'),
    boundaries: { read_only: true, execution: 'manual_only', private_endpoint_required: true, external_research: 'NOT_ACQUIRED',
      costs: 'See per-leg fee engine provenance; actual ledger fees are not overwritten.',
      real_account_performance: 'UNKNOWN unless a complete, reconcilable ledger and historical prices exist.' },
  };
}

/**
 * Identity covers what the account and market are, not how the request named them.
 * `account_id_source` ("explicit" | "default") is request provenance: hashing its real value made the same state
 * yield two IDs, one for a scheduled read without account_id and one for ChatGPT's explicit account_id, so the
 * persisted snapshot could never be found by the ID a live read reported (2026-10-23 production failure).
 * It is pinned to "default" rather than dropped: every snapshot persisted so far was hashed with "default", so
 * pinning keeps those stored IDs reproducible without a migration or any rewrite of the journal.
 */
const IDENTITY_EXCLUDED_KEYS = new Set(['generated_at', 'checked_at', 'recorded_at', 'last_user_reconciled_at']);
const IDENTITY_PINNED_VALUES: Record<string, unknown> = { account_id_source: 'default' };

function stableFacts(value: unknown): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
      .filter(key => !IDENTITY_EXCLUDED_KEYS.has(key))
      .map(key => [key, key in IDENTITY_PINNED_VALUES ? IDENTITY_PINNED_VALUES[key] : normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}

/**
 * Whether this live bundle is the persisted VPS snapshot with the same identity. Read-only: it never creates
 * the journal table and never writes. Matching is by account + trade date + report_id together.
 */
export function persistedSnapshotStatus(db: DatabaseSync, accountId: string, asOf: string | null, reportId: string) {
  const none = { status: 'SNAPSHOT_NOT_FOUND', record_ids: [] as string[], content_hash: null as string | null, recorded_at: null as string | null };
  if (!asOf || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_journal'").get()) return none;
  const rows = db.prepare("SELECT record_id, content_hash, recorded_at FROM research_journal WHERE account_id=? AND source='vps' AND as_of_trade_date=? AND bundle_id=? ORDER BY record_id LIMIT 10")
    .all(accountId, asOf, reportId) as { record_id: string; content_hash: string; recorded_at: string }[];
  if (!rows.length) return none;
  return { status: 'PERSISTED', record_ids: rows.map(row => row.record_id), content_hash: rows[0].content_hash, recorded_at: rows[0].recorded_at };
}

function readTracking(db: DatabaseSync, accountId: string, asOf: string): any[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_tracking'").get()) return [];
  return db.prepare('SELECT plan_id,as_of_trade_date,status,action_code,expected_by,generated_at FROM plan_tracking WHERE account_id=? AND as_of_trade_date <= ? ORDER BY as_of_trade_date DESC LIMIT 5').all(accountId, asOf);
}

/**
 * 逐结论数据版本引用（任务书 §3.1 "各项结论所引用的数据版本"）。
 * 每个结论段（market / watchlist / signals / decision / benchmarks / candidates / fees / validation）
 * 显式给出它实际使用的数据版本与数据日期；缺失时如实 null，不冒充可用。
 * 该结构在 facts 之外，不参与 report_id 身份哈希。
 */
function buildConclusionRefs(input: {
  asOf: string | null;
  targetReport: any;
  validation: any;
  portfolio: any;
  benchmarks: any;
  feeSummary: any;
  screening: any;
}): Record<string, { data_as_of: string | null; versions: Record<string, unknown>; source: string; status: string }> {
  const { asOf, targetReport, validation, portfolio, benchmarks, feeSummary, screening } = input;
  const marketVersions = targetReport?.versions ?? {};
  const refs: Record<string, { data_as_of: string | null; versions: Record<string, unknown>; source: string; status: string }> = {};
  const ref = (dataAsOf: string | null, versions: Record<string, unknown>, source: string, status: string) =>
    ({ data_as_of: dataAsOf, versions, source, status });
  refs.market = ref(targetReport?.as_of_trade_date ?? asOf, marketVersions,
    'ashare.report', targetReport ? 'AVAILABLE' : 'UNAVAILABLE');
  refs.watchlist = ref(targetReport?.as_of_trade_date ?? asOf,
    { watchlist: marketVersions.watchlist ?? null, score: marketVersions.score ?? null, evidence: marketVersions.evidence ?? null },
    'ashare.report.watchlist', targetReport?.watchlist ? 'AVAILABLE' : 'UNAVAILABLE');
  refs.signals = ref(targetReport?.as_of_trade_date ?? asOf,
    { indicators: marketVersions.indicators ?? null, signals: marketVersions.signals ?? null },
    'ashare.report.signals', targetReport?.signals ? 'AVAILABLE' : 'UNAVAILABLE');
  refs.decision = ref(portfolio?.as_of_trade_date ?? asOf,
    { report: portfolio?.schema ?? null, gate: portfolio?.gate?.state_basis ?? null },
    'portfolio.dailyReport', portfolio ? (portfolio.status ?? 'AVAILABLE') : 'UNAVAILABLE');
  refs.benchmarks = ref(asOf,
    { benchmark: BENCHMARK_DEFINITION_VERSION, status: benchmarks?.basket_definition?.status ?? null },
    'portfolio.benchmarks', benchmarks ? 'AVAILABLE' : 'UNAVAILABLE');
  refs.candidates = ref(asOf,
    { etf_universe: screening?.universe_version ?? ETF_UNIVERSE_VERSION, coverage: screening?.data_coverage?.status ?? null },
    'ashare.etfUniverse', screening ? (screening.data_coverage?.status ?? 'AVAILABLE') : 'UNAVAILABLE');
  refs.fees = ref(asOf,
    { fee_rules: feeSummary?.[0]?.values?.fee_model?.version ?? null, provenance: feeSummary?.[0]?.provenance ?? null },
    'portfolio.fees', feeSummary ? 'AVAILABLE' : 'UNAVAILABLE');
  refs.validation = ref(validation?.as_of ?? null,
    { implementation_hash: validation?.implementation_hash ?? null, rule_hash: validation?.rule_hash ?? null, score_version: validation?.score_version ?? null, validation_id: validation?.id ?? null },
    'ashare.validation', validation?.status ?? 'UNAVAILABLE');
  return refs;
}

// ---------------------------------------------------------------- ETF 穿透摘要接线（goal-1026 §4）
//
// C 交付的两步管线：collectEtfPenetrationInputs（只读本地 sqlite 缓存，函数本身禁联网）
// → buildEtfPenetrationSummary（纯函数）。本层只负责挑选持仓中的基金代码、逐只调用、
// 失败降级；输出挂 bundle 顶层 etf_penetration（facts 之外，不入 report_id 身份哈希）。
//
// CollectOptions 的 weightRows/weightSource/indexCode/forecastRows/comparables/driverEvidence
// 均为调用方上游（联网）取得的数据；日报构建路径禁止联网，本地库也没有 index_weight /
// fund_portfolio 缓存表，因此这里只传三个必填参数。权重行缺失时**不**产出摘要：
// buildEtfPenetrationSummary 会把空权重标成 fund_portfolio 口径（误导性来源字符串），
// 宁可逐只 UNAVAILABLE 并记块内缺口。上游将来把权重入缓存后，只需在此传入
// weightRows/weightDate/weightSource，块结构不变。

export const ETF_PENETRATION_BUNDLE_SCHEMA = 'ashare-etf-penetration-bundle/1.0';
const PENETRATION_WINDOW_SESSIONS = 20;

/** 沪深基金代码：深市 1 开头、沪市 5 开头（A 股为 0/3/6 开头，不会误中）。 */
const FUND_CODE_RE = /^(?:1\d{5}\.SZ|5\d{5}\.SH)$/;

export interface EtfPenetrationEntry {
  status: 'OK' | 'UNAVAILABLE';
  /** UNAVAILABLE 时的机器可读原因；OK 时为 null。 */
  reason: string | null;
  summary: EtfPenetrationSummary | null;
}

export interface EtfPenetrationBundle {
  schema: string;
  as_of_trade_date: string | null;
  /** 块级可用性：market db / as_of 缺失才是 UNAVAILABLE；逐只状态在 etfs 内。 */
  status: 'OK' | 'UNAVAILABLE';
  reason: string | null;
  /** 逐只持仓 ETF一只一条摘要（键为 ts_code）。 */
  etfs: Record<string, EtfPenetrationEntry>;
  collected: number;
  unavailable: number;
  /** 与 facts.gaps 同构但作用域在此块内（身份冻结，绝不并入 facts.gaps）。 */
  gaps: { module: string; reason: string; affected: string[] }[];
}

export function buildEtfPenetrationState(input: {
  db: DatabaseSync | null;
  asOf: string | null;
  holdings: string[];
}): EtfPenetrationBundle {
  const gaps: EtfPenetrationBundle['gaps'] = [];
  const etfs: Record<string, EtfPenetrationEntry> = {};
  const base = { schema: ETF_PENETRATION_BUNDLE_SCHEMA, as_of_trade_date: input.asOf ?? null };
  if (!input.db || !input.asOf) {
    const reason = input.db ? 'as_of_unavailable' : 'market_db_unavailable';
    gaps.push({ module: 'etf_penetration', reason, affected: ['etf_penetration'] });
    return { ...base, status: 'UNAVAILABLE', reason, etfs, collected: 0, unavailable: 0, gaps };
  }
  const codes = [...new Set(input.holdings.filter(code => FUND_CODE_RE.test(code)))].sort();
  let collected = 0;
  let unavailable = 0;
  for (const code of codes) {
    try {
      const collectorInput = collectEtfPenetrationInputs(input.db, {
        as_of: input.asOf,
        etfCode: code,
        // 权重日期未知时传空串：weightFreshness('') → UNAVAILABLE（"禁止把任何权重称为最新权重"）。
        weightDate: '',
        window_sessions: PENETRATION_WINDOW_SESSIONS,
      });
      if (!collectorInput.weight.rows.length) {
        unavailable += 1;
        etfs[code] = { status: 'UNAVAILABLE', reason: 'no_local_constituent_weight_cache', summary: null };
        gaps.push({
          module: 'etf_penetration',
          reason: `${code}: no_local_constituent_weight_cache (index_weight/fund_portfolio 未入库；日报构建禁止联网采集)`,
          affected: ['etf_penetration'],
        });
        continue;
      }
      etfs[code] = { status: 'OK', reason: null, summary: buildEtfPenetrationSummary(collectorInput) };
      collected += 1;
    } catch (error: any) {
      unavailable += 1;
      const message = String(error?.message ?? error);
      etfs[code] = { status: 'UNAVAILABLE', reason: `collector_failed: ${message}`, summary: null };
      gaps.push({ module: 'etf_penetration', reason: `${code}: ${message}`, affected: ['etf_penetration'] });
    }
  }
  return { ...base, status: 'OK', reason: null, etfs, collected, unavailable, gaps };
}
