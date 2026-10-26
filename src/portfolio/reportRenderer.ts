import type { DailyReportResult } from './dailyReport.js';

/**
 * 中文日报双层渲染器（goal-1026 第六部分 8.1–8.5）。
 *
 * 架构硬约束（8.3）：用户版（A–H 中文 markdown）与技术审计附件由
 * **同一份不可变的 DailyReportResult 一次性渲染**——只做展示层的取数、翻译
 * 与显式标注的口径折算，不引入第二套计算逻辑，不做任何 I/O。
 *
 * - 所有投资结论的数字都来自 result 字段；展示层的派生数字（如"集中度对照"）
 *   只做 result 字段间的四则运算，并在附件 §12 披露算式，保证两层可对账。
 * - 用户版正文经过禁词断言（assertUserReportClean）后才返回；内部状态码在
 *   附件中原样保留（8.1：隐藏技术术语 ≠ 隐藏风险，风险全部翻译成自然语言）。
 * - 本模块只 import 类型（type-only），不在运行时依赖 dailyReport.ts，
 *   便于对同一份 JSON 快照（如 20261023 回放）离线渲染与测试。
 */

export interface RenderOptions {
  /** 渲染时刻，用于周末标题判定与"运行日≠数据日"识别。缺省取当前时间；golden test 应显式传入以保证可复现。 */
  now?: string | Date;
  /** 渲染层版本号，只进附件；缺省 render-1.0.0。 */
  rendererVersion?: string;
}

export interface DailyReportRendered {
  /** 用户版：A–H 固定结构的中文 markdown（8.1/8.2/8.4/8.5）。 */
  user: string;
  /** 技术审计附件：机器可读 markdown（标题 + 内嵌 JSON 块，8.3 选型）。 */
  technical: string;
  /**
   * 附件的结构化形式（各节同源对象，含原始日报 JSON 与用户版内嵌数字表）。
   * golden test 用它做"正文数字 ↔ 附件一致/可追溯"的递归数值断言。
   */
  attachment: Record<string, unknown>;
}

// ---------------------------------------------------------------- 禁词（8.1）

/**
 * 用户版正文禁止出现的词。前三组逐字来自任务书 8.1；"内部状态码 / 数据库表名 /
 * 内部模块名 / 规则版本号"按当前日报产物归纳为可断言的字面量集合。
 * 只断言大小写敏感的字面子串（中文语义改写由 sanitize 负责，不做泛化误伤）。
 */
export const USER_REPORT_FORBIDDEN: readonly string[] = [
  // 任务书 8.1 逐字列出的工程术语。
  'DEGRADED', 'UNVERIFIED', 'NOT_EXECUTABLE', 'REAL_ACCOUNT_VERIFIED', 'persisted_snapshot',
  'evidence_status', 'report_id', 'schema', 'OAuth', 'API', 'idempotency_key', 'content_hash',
  // 8.1 类目一：内部状态码 / 状态枚举（含日报 status、质量分层、证据等级）。
  'READY', 'STALE', 'NOT_READY', 'MISSING', 'INSUFFICIENT', 'ACTIONABLE', 'ILLUSTRATIVE',
  'NO_ACTION', 'DATA_INSUFFICIENT', 'RESEARCH_VERIFIED', 'UNCONFIRMED_RISK',
  'CONFIRMED_THROUGH_TARGET_DATE', 'REAL_ACCOUNT_PENDING', 'VERIFIED', 'UNAVAILABLE',
  'PRE_CLOSE', 'AFTER_CLOSE', 'NON_TRADING_DAY', 'NOT_CONFIRMED',
  // 8.1 类目二：内部字段名 / 结构名（snake_case，正文不得出现）。
  'server_cache_close', 'snapshot_reference_price', 'same_day_snapshot', 'ledger_reconstruction',
  'market_judgement', 'account_trade_completeness', 'trade_plan_executability', 'research_evidence',
  'fact_meta', 'fact_register', 'plan_tracking', 'portfolio_risk', 'decision_comparison',
  'account_view', 'first_section', 'observation_triggers', 'as_of_trade_date',
  // 8.1 类目三：数据库表名与内部模块名（当前产物归纳）。
  'fund_daily', 'fund_adj', 'fund_basic', 'index_daily', 'trade_cal', 'fund_sync_log',
  'portfolio.sqlite', 'market.sqlite', 'sqlite_master', 'dailyReport', 'daily_report',
  'researchBundle', 'researchTools', 'etfUniverse', 'riskPolicy', 'chatgptIntake',
  // 8.1 类目四：规则版本号与运行标识前缀。
  '-1.0.0', '-1.1.0', '-1.2.0', 'portfolio-drawdown-policy', 'r1-asset-stress',
  'BUNDLE-', 'ASR-', 'ASHARE_',
];

/** 返回正文中命中的禁词列表（去重、保持声明顺序）；空数组表示通过。 */
export function forbiddenHits(text: string): string[] {
  const hits: string[] = [];
  for (const word of USER_REPORT_FORBIDDEN) {
    if (text.includes(word) && !hits.includes(word)) hits.push(word);
  }
  return hits;
}

/**
 * 用户版正文的禁词断言：渲染管线的最后一道闸。任何继承自 JSON 的字符串
 * （行情质量措辞、观察触发、持仓条件等）都要经过这里，命中即抛错而不是静默删除，
 * 以便 golden test 与渲染调用方立刻定位泄漏来源。
 */
export function assertUserReportClean(text: string): void {
  const hits = forbiddenHits(text);
  if (hits.length) throw new Error(`用户版日报正文包含禁词：${hits.join('、')}`);
}

/**
 * 继承字符串的中文改写表：把上游为机器读者写的句子翻译成自然语言。
 * 顺序敏感——具体短语在前，泛化替换在后。改写后仍需通过 assertUserReportClean。
 */
const TEXT_REWRITES: readonly [RegExp, string][] = [
  [/研究性主张标记为 UNVERIFIED，未经前瞻检验。/g, '研究性主张尚未经过前瞻性检验。'],
  [/没有 RESEARCH_VERIFIED 级别的轮动证据/g, '没有经过检验的轮动证据'],
  [/在行情 READY 之前/g, '在当日行情齐备之前'],
  [/行情 READY 之前/g, '行情齐备之前'],
  [/行情 READY/g, '行情齐备'],
  [/从 READY 降为 STALE\/NOT_READY/g, '从就绪变为过期或缺失'],
  [/相对优势 UNVERIFIED；?/g, '相对优势尚未经过检验；'],
  [/没有经过前瞻检验的 RESEARCH_VERIFIED 证据/g, '没有经过前瞻检验的轮动证据'],
  [/RESEARCH_VERIFIED/g, '经过检验的轮动证据'],
  [/UNVERIFIED/g, '尚未经过检验'],
  [/NOT_EXECUTABLE/g, '不可执行'],
  [/REAL_ACCOUNT_VERIFIED/g, '真实账户已确认'],
  [/UNCONFIRMED_RISK/g, '尚未完成核对'],
  [/DEGRADED/g, '数据降级'],
  [/server_cache_close/g, '当日收盘价'],
  [/snapshot_reference_price/g, '快照参考价'],
  [/market_judgement\.counter_evidence/g, '市场反证清单'],
  [/（规则：[^）]*）/g, '（按既定均线规则判定）'],
  [/\bREADY\b/g, '齐备'],
  [/\bSTALE\b/g, '过期'],
  [/\bNOT_READY\b/g, '缺失'],
  [/\bMISSING\b/g, '缺失'],
];

/** 对继承自 result 的句子做中文改写（不改变数字与事实方向）。 */
function zh(value: string): string {
  let text = value;
  for (const [pattern, replacement] of TEXT_REWRITES) text = text.replace(pattern, replacement);
  return text;
}

// ---------------------------------------------------------------- 格式化小工具

/** 千分位分组（不依赖 locale，保证输出可复现）。 */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 分 → 元字符串（如 7085153 → "70,851.53"）；null/undefined → "—"。 */
function yuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
}

/** 保留两位小数的百分数文本；null → "—"。 */
function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** 权重（0–1 小数）→ 百分比文本。 */
function weightPct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(2)}%`;
}

/** 20261023 → 2026年10月23日；空值返回占位。 */
function ymd(value: string | null | undefined): string {
  if (!value || !/^\d{8}$/.test(value)) return '—';
  return `${value.slice(0, 4)}年${Number(value.slice(4, 6))}月${Number(value.slice(6, 8))}日`;
}

/** 20261023 → 10月23日（标题用）。 */
function monthDay(value: string): string {
  return `${Number(value.slice(4, 6))}月${Number(value.slice(6, 8))}日`;
}

/** "2026-10-16" / "20261016" / ISO 时间 → 2026年10月16日。 */
function isoDate(value: string | null | undefined): string {
  if (!value) return '—';
  if (/^\d{8}$/.test(value)) return ymd(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value;
}

/** 数字 → 百分比点位文本（入参已是百分数单位，如 6.4994 → "6.50%"）。 */
function pctPoint(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

function toShanghaiDate(now: string | Date): Date {
  return typeof now === 'string' ? new Date(now) : now;
}

/**
 * 周末报告判定：运行日（上海时区）晚于数据日且运行日为周六/周日。
 * 周一补跑周五数据不算周末报告（title 仍标数据日，不伪装）。
 */
export function isWeekendRun(asOfTradeDate: string, now?: string | Date): boolean {
  const date = toShanghaiDate(now ?? new Date());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // en-CA → YYYY-MM-DD
  const runDay = parts.replace(/-/g, '');
  if (runDay <= asOfTradeDate) return false;
  const weekday = new Date(`${parts}T12:00:00+08:00`).getDay();
  return weekday === 0 || weekday === 6;
}

// ---------------------------------------------------------------- 聚合视图

/**
 * 从 DailyReportResult 派生渲染所需的引用集合。只读取字段引用，不做重算；
 * 标注 *Derived 的成员是 result 字段间的显式四则运算，算式随附件 §12 披露。
 */
interface RenderView {
  asOf: string;
  total: number;
  cash: number;
  securities: number;
  focus: DailyReportResult['decision_comparison']['focus'];
  hhi: number | null;
  effective: number | null;
  equityWeight: number | null;
  cashRatio: number | null;
  drawdown: { current: number | null; max: number | null; start: string | null; end: string | null; points: number | null } | null;
  warning: { level: string; triggered: boolean } | null;
  policyApprovedOn: string | null;
  l1DrawdownPct: number | null;
  holdStressCents: number | null;
  defensiveOption: DailyReportResult['decision_comparison']['options'][number] | null;
  reduceOption: DailyReportResult['decision_comparison']['options'][number] | null;
  /** Derived：聚焦持仓清零后的权益市值（卖出不改变总资产口径，费用在参数未提供时为 0）。 */
  focusValue: number;
  /** Derived：压力损失随权益市值线性变化的对照（同一资产类别冲击假设）。 */
  reduceStressCents: number | null;
  /** Derived：清仓聚焦持仓后的集中度/权益占比对照。 */
  reduceHhi: number | null;
  reduceEquityWeight: number | null;
  hasPreviousDayDelta: boolean;
}

function buildView(r: DailyReportResult): RenderView {
  const options = r.decision_comparison.options ?? [];
  const find = (action: string) => options.find(option => option.action === action) ?? null;
  const holdOption = find('HOLD');
  const focus = r.decision_comparison.focus ?? null;
  const focusValue = focus?.market_value_cents ?? 0;
  const holdStress = holdOption?.stress_after?.loss_cents
    ?? r.portfolio_risk?.stress?.loss_cents ?? null;
  const drawdownWindow = r.drawdown.observation_window ?? null;
  const riskDrawdown = r.portfolio_risk?.drawdown ?? null;
  const tiers = r.portfolio_risk?.policy?.tiers ?? null;
  const l1 = Array.isArray(tiers) ? tiers.find((tier: any) => tier?.level === 'L1') : null;
  const hhi = r.concentration.hhi;
  const focusWeight = focus?.weight ?? 0;
  const total = r.account_view.revalued_basis.total_assets_cents;
  const securities = r.account_view.revalued_basis.securities_mv_cents;
  // 卖出聚焦持仓：现金 +1 份市值，总资产口径不变；分子去掉聚焦持仓的权重平方。
  const reduceHhi = hhi !== null && focus ? r6(hhi - focusWeight ** 2) : null;
  // 聚焦持仓的资产类别未随 result 暴露；只有全部证券都是权益类时，聚焦持仓才必然
  // 是权益、其市值才能按权益冲击线性扣除。混合资产时对照不可得，宁缺毋滥（F/G 有回退文案）。
  const allEquity = Boolean(holdOption
    && holdOption.by_asset_class_after.every(row => row.weight === 0 || row.asset_class === 'EQUITY'));
  const equityShock = holdOption?.stress_after?.equity_shock_pct ?? null;
  const reduceStressCents = holdStress !== null && focus && allEquity && equityShock !== null
    ? Math.round(holdStress - focusValue * equityShock)
    : null;
  const reduceEquityWeight = focus && allEquity
    ? r6(Math.max(0, (securities - focusValue)) / Math.max(1, total) * 100)
    : null;
  return {
    asOf: r.as_of_trade_date,
    total: r.account_view.revalued_basis.total_assets_cents,
    cash: r.account_view.revalued_basis.cash_cents,
    securities: r.account_view.revalued_basis.securities_mv_cents,
    focus,
    hhi,
    effective: r.concentration.effective_positions,
    equityWeight: r.concentration.equity_weight,
    cashRatio: r.concentration.cash_ratio,
    drawdown: riskDrawdown
      ? {
        current: riskDrawdown.current_drawdown_pct ?? null,
        max: riskDrawdown.max_drawdown_pct ?? null,
        start: riskDrawdown.window?.start ?? null,
        end: riskDrawdown.window?.end ?? null,
        points: riskDrawdown.points_used ?? null,
      }
      : drawdownWindow
        ? {
          current: drawdownWindow.current_drawdown_pct,
          max: drawdownWindow.max_drawdown_pct_in_window,
          start: drawdownWindow.window?.start ?? null,
          end: drawdownWindow.window?.end ?? null,
          points: drawdownWindow.points_used,
        }
        : null,
    warning: r.portfolio_risk?.warning
      ? { level: r.portfolio_risk.warning.level, triggered: Boolean(r.portfolio_risk.warning.triggered) }
      : null,
    policyApprovedOn: r.portfolio_risk?.policy?.approved_on ?? null,
    l1DrawdownPct: l1?.drawdown_pct ?? null,
    holdStressCents: holdStress,
    defensiveOption: find('DEFENSIVE'),
    reduceOption: find('REDUCE'),
    focusValue,
    reduceStressCents,
    reduceHhi,
    reduceEquityWeight,
    // DailyReportResult 目前不含前一交易日对照字段；B 合流新增后此开关可翻转（可选读取）。
    hasPreviousDayDelta: Boolean((r as any).previous_day_comparison),
  };
}

function r6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------- bundle 第二参（证据来源标注）

/**
 * 研究事实包的最小结构面：只声明渲染器实际消费的顶层键（A-facts 的
 * evidence_register、C-etf 的 etf_penetration）。golden test 与未来 MCP 层
 * 直接把 buildInvestmentResearchBundle() 的结果传进来即可，无需适配。
 */
export interface ResearchBundleLike {
  evidence_register?: {
    schema?: string;
    as_of_trade_date?: string | null;
    entries?: unknown[];
    outcomes?: Record<string, string>;
    summary?: Record<string, unknown> | null;
    high_confidence?: { included?: unknown[]; excluded?: unknown[] } | null;
    status_derivation?: string;
  } | null;
  etf_penetration?: unknown;
}

/** 用户版 E/F 行内来源标注（8.5：只带发布者与发布日期；URL/检索时间只进附件）。 */
interface EvidenceAnnotation {
  evidence_id: string;
  claim: string;
  publisher: string;
  /** 如 2026年8月26日。 */
  dateLabel: string;
  outcome: string;
  direction: string;
}

type AnnotationIndex = Map<string, EvidenceAnnotation[]>;

interface AnnotationAudit {
  selection_rule: string;
  entries_considered: number;
  targets_indexed: number;
  annotations_in_user_layer: number;
  skipped: Array<{ evidence_id: string; reason: string }>;
}

function emptyAnnotationAudit(): AnnotationAudit {
  return {
    selection_rule: 'target 精确匹配本期持仓代码 + published_at 可解析 + 未失效；content_hash 去重；NEW→UPDATED→UNCHANGED、高质量优先、新发布优先；每只持仓最多 2 条进正文（展开块/其余持仓注记/F 聚焦来源）；禁词/空文本条目丢弃并记录',
    entries_considered: 0,
    targets_indexed: 0,
    annotations_in_user_layer: 0,
    skipped: [],
  };
}

function isBundleLike(value: unknown): value is ResearchBundleLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj.evidence_register !== undefined
    || obj.etf_penetration !== undefined
    || (typeof obj.report_id === 'string' && obj.report_id.startsWith('BUNDLE-'));
}

/**
 * 第二参多态解析：
 * - 缺省 / null → 旧行为（无 bundle，无标注，输出逐字节不变）；
 * - RenderOptions（now/rendererVersion；可带嵌套 bundle 键——golden test 的调用形状
 *   `fn(report, { now, bundle })`）；
 * - bundle 本体（顶层含 evidence_register / etf_penetration，或 BUNDLE- 前缀 report_id）。
 * 非 bundle 形状一律按旧语义处理，保证 20261023 走查路径向后兼容。
 */
function resolveSecondArg(second: unknown): { options: RenderOptions; bundle: ResearchBundleLike | null } {
  if (second === null || second === undefined || typeof second !== 'object' || Array.isArray(second)) {
    return { options: {}, bundle: null };
  }
  if (isBundleLike(second)) return { options: {}, bundle: second };
  const obj = second as Record<string, unknown>;
  const options: RenderOptions = {};
  if (typeof obj.now === 'string' || obj.now instanceof Date) options.now = obj.now as string | Date;
  if (typeof obj.rendererVersion === 'string') options.rendererVersion = obj.rendererVersion;
  const bundle = isBundleLike(obj.bundle) ? obj.bundle : null;
  return { options, bundle };
}

const OUTCOME_RANK: Record<string, number> = { NEW: 0, UPDATED: 1, UNCHANGED: 2 };
const QUALITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, UNVERIFIED: 3 };

/** 标注文本消毒：改写、去 markdown 痕迹、截断；正文永不携带换行/表格管道符。 */
function sanitizeAnnotationText(value: string): string {
  return zh(value)
    .replace(/\s+/g, ' ')
    .replace(/[|`*_<>]/g, '')
    .replace(/[；;。.、]+$/g, '')
    .trim()
    .slice(0, 80);
}

/**
 * 从 bundle.evidence_register 构建「持仓代码 → 来源标注」索引（E/F 行内用）。
 * 选取规则（同时以 selection_rule 原文披露进附件 §14.5）：
 *  1. 只取 target 与持仓代码精确匹配、published_at 可解析、未失效（outcome 与
 *     invalidation 双检）的条目；published_at 缺失的条目无法构成 8.5 标注，只留附件；
 *  2. 同一 content_hash 去重（重复引用旧闻不算第二条来源）；
 *  3. 排序：NEW→UPDATED→UNCHANGED，质量 HIGH→UNVERIFIED，发布时间新→旧；
 *  4. 每只持仓最多 2 条进入正文（E 展开块与 F 各自最多引用 2 条）；
 *  5. 标注文本改写后仍含禁词或为空的条目被丢弃并记入附件 skipped——
 *     用户层宁可少一条来源，也不允许渲染抛错或泄漏工程术语。
 */
function buildAnnotationIndex(bundle: ResearchBundleLike | null, holdingCodes: ReadonlySet<string>): { index: AnnotationIndex; audit: AnnotationAudit } {
  const audit = emptyAnnotationAudit();
  const index: AnnotationIndex = new Map();
  const register = bundle?.evidence_register;
  const entries = Array.isArray(register?.entries) ? register!.entries! : [];
  audit.entries_considered = entries.length;
  if (!entries.length) return { index, audit };
  const outcomes = register!.outcomes ?? {};
  const seenHashes = new Set<string>();
  const grouped = new Map<string, Array<{ entry: Record<string, unknown>; outcome: string; quality: string; published: string }>>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const evidenceId = typeof entry.evidence_id === 'string' ? entry.evidence_id : null;
    const target = typeof entry.target === 'string' ? entry.target : null;
    const published = typeof entry.published_at === 'string' ? entry.published_at : null;
    const outcome = evidenceId && outcomes[evidenceId] ? outcomes[evidenceId] : 'UNCHANGED';
    if (!evidenceId || !target || !published || Number.isNaN(Date.parse(published))) {
      if (evidenceId) audit.skipped.push({ evidence_id: evidenceId, reason: !target ? 'no_target' : !published ? 'no_published_date' : 'unparsable_published_date' });
      continue;
    }
    // 只索引本期持仓的目标：非持仓 target 的证据留在附件 §14.5，不进正文候选。
    if (!holdingCodes.has(target)) {
      audit.skipped.push({ evidence_id: evidenceId, reason: 'target_not_a_holding' });
      continue;
    }
    if (outcome === 'INVALIDATED' || entry.invalidation) {
      audit.skipped.push({ evidence_id: evidenceId, reason: 'invalidated' });
      continue;
    }
    const hash = typeof entry.content_hash === 'string' ? entry.content_hash : null;
    if (hash) {
      if (seenHashes.has(hash)) {
        audit.skipped.push({ evidence_id: evidenceId, reason: 'duplicate_content' });
        continue;
      }
      seenHashes.add(hash);
    }
    const list = grouped.get(target) ?? [];
    list.push({ entry, outcome, quality: typeof entry.source_quality === 'string' ? entry.source_quality : 'UNVERIFIED', published });
    grouped.set(target, list);
  }
  for (const [target, list] of grouped) {
    list.sort((a, b) => {
      const byOutcome = (OUTCOME_RANK[a.outcome] ?? 9) - (OUTCOME_RANK[b.outcome] ?? 9);
      if (byOutcome) return byOutcome;
      const byQuality = (QUALITY_RANK[a.quality] ?? 9) - (QUALITY_RANK[b.quality] ?? 9);
      if (byQuality) return byQuality;
      return b.published.localeCompare(a.published);
    });
    const annotations: EvidenceAnnotation[] = [];
    for (const { entry, outcome } of list) {
      if (annotations.length >= 2) {
        // 每持仓 2 条上限：截断的条目照样记入 skipped，audit 数目才对得上账。
        audit.skipped.push({ evidence_id: String(entry.evidence_id), reason: 'per_holding_cap_reached' });
        continue;
      }
      const claim = sanitizeAnnotationText(String(entry.claim ?? ''));
      const publisher = sanitizeAnnotationText(String(entry.publisher ?? '')) || '公开来源';
      const dateLabel = isoDate(String(entry.published_at));
      const probe = `${claim}（${publisher}，${dateLabel}）`;
      if (!claim || forbiddenHits(probe).length) {
        audit.skipped.push({ evidence_id: String(entry.evidence_id), reason: !claim ? 'empty_claim_after_sanitize' : 'forbidden_term_in_annotation' });
        continue;
      }
      annotations.push({
        evidence_id: String(entry.evidence_id),
        claim,
        publisher,
        dateLabel,
        outcome,
        direction: typeof entry.evidence_direction === 'string' ? entry.evidence_direction : 'BACKGROUND',
      });
    }
    if (annotations.length) {
      index.set(target, annotations);
      audit.annotations_in_user_layer += annotations.length;
    }
  }
  audit.targets_indexed = index.size;
  return { index, audit };
}

/** 格式化一条标注为 8.5 行内来源：「claim（publisher，日期）」。 */
function formatAnnotation(annotation: EvidenceAnnotation): string {
  return `${annotation.claim}（${annotation.publisher}，${annotation.dateLabel}）`;
}

/**
 * 标注引用进正文的 claim 里出现的带单位数字（golden 的可追溯断言按数值递归附件，
 * claim 字符串本身不算数值——这里把 15%/2.3亿元 等显式登记进 §15 供其找到出处）。
 */
function citedClaimNumbers(index: AnnotationIndex): number[] {
  const out: number[] = [];
  for (const list of index.values()) {
    for (const annotation of list) {
      for (const match of annotation.claim.matchAll(/(\d[\d,]*(?:\.\d+)?)(万元|亿元|元|%|％)/g)) {
        const raw = Number(match[1].replace(/,/g, ''));
        if (!Number.isFinite(raw)) continue;
        out.push(match[2] === '万元' ? raw * 1e4 : match[2] === '亿元' ? raw * 1e8 : raw);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ bundle → 附件 §14.5

/** 证据条目 → 附件表格行（15 字段 + 变化状态；URL/检索时间只在这里出现）。 */
function evidenceRow(raw: unknown, outcomes: Record<string, string>): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.evidence_id === 'string' ? entry.evidence_id : null;
  if (!id) return null;
  const context = entry.context && typeof entry.context === 'object' ? entry.context as Record<string, unknown> : {};
  return {
    evidence_id: id,
    claim: entry.claim ?? null,
    target: entry.target ?? null,
    publisher: entry.publisher ?? null,
    published_at: entry.published_at ?? null,
    retrieved_at: entry.retrieved_at ?? null,
    effective_as_of: entry.effective_as_of ?? null,
    source_url: entry.source_url ?? null,
    evidence_type: entry.evidence_type ?? null,
    evidence_direction: entry.evidence_direction ?? null,
    source_quality: entry.source_quality ?? null,
    verification_status: entry.verification_status ?? null,
    change_status: outcomes[id] ?? 'UNCHANGED',
    invalidation: entry.invalidation ?? null,
    revision: typeof entry.revision === 'number' ? entry.revision : null,
    novelty: context.novelty ?? null,
    claim_kind: context.claim_kind ?? null,
    scope: context.scope ?? null,
    excerpt: entry.source_excerpt ?? null,
  };
}

/**
 * 单条穿透值 → summary 行，或采集失败的降级标记。
 * 采集信封（researchBundle EtfPenetrationEntry：{status, reason, summary}）在此解包：
 * status==='OK' 且 summary 可用才取 .summary；否则生成降级标记（code/status/reason
 * 一并带出），非 OK 信封不得静默丢弃——附件层必须看得见采集失败，不许空表假干净。
 */
function penetrationCell(code: unknown, value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ('summary' in row && 'status' in row) {
    const summary = row.summary;
    if (row.status === 'OK' && summary !== null && typeof summary === 'object' && !Array.isArray(summary)) {
      // 映射键兜底：summary 缺 etf.ts_code 时用外层代码回填行标识。
      const inner = summary as Record<string, unknown>;
      const etf = (inner.etf ?? null) as Record<string, unknown> | null;
      if (code !== undefined && code !== null && (!etf || etf.ts_code === undefined || etf.ts_code === null)) {
        return { ...inner, etf: { ...(etf ?? {}), ts_code: code } };
      }
      return inner;
    }
    return {
      __penetration_unavailable: true,
      __code: code ?? null,
      __status: row.status ?? null,
      __reason: row.reason ?? null,
    };
  }
  if (row.etf || row.constituents) return row;
  return null;
}

function collectPenetrationCells(entries: Array<readonly [unknown, unknown]>): Array<Record<string, unknown>> {
  const cells: Array<Record<string, unknown>> = [];
  for (const [code, value] of entries) {
    const cell = penetrationCell(code, value);
    if (cell) cells.push(cell);
  }
  return cells;
}

/**
 * 归一 etf_penetration：兼容单对象 / 数组 / {summaries|etfs} 容器 / 按代码映射，
 * 以及真实回放的信封形态——容器 {etfs: {ts_code: {status, reason, summary}}}。
 * 容器键既接受数组也接受逐代码映射（collect 产物的真实形状）。
 */
function penetrationList(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return collectPenetrationCells(value.map(row => [undefined, row] as const));
  const obj = value as Record<string, unknown>;
  // 顶层单信封 {status, reason, summary}。
  if ('summary' in obj && 'status' in obj) return collectPenetrationCells([[undefined, obj]]);
  for (const key of ['summaries', 'etfs', 'entries', 'items']) {
    const inner = obj[key];
    if (Array.isArray(inner)) return collectPenetrationCells(inner.map(row => [undefined, row] as const));
    if (inner && typeof inner === 'object') {
      const cells = collectPenetrationCells(Object.entries(inner as Record<string, unknown>));
      if (cells.length) return cells;
    }
  }
  if (obj.etf || obj.constituents) return collectPenetrationCells([[undefined, obj]]);
  // 裸映射 {code: summary|envelope}：对象值须全部可识别（保持旧形态的 all-or-nothing 语义）。
  const values = Object.values(obj).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  if (values.length && values.every(row => row.etf || row.constituents || ('summary' in row && 'status' in row))) {
    return collectPenetrationCells(values.map(row => [undefined, row] as const));
  }
  return [];
}

/** 单只 ETF 穿透摘要 → 附件行（权重日期/新鲜度/覆盖率/关键缺口/来源）；采集失败条目 → 降级行。 */
function penetrationRow(row: Record<string, unknown>): Record<string, unknown> {
  if (row.__penetration_unavailable === true) {
    // 降级行：采集失败条目在附件中占位披露（code + status + reason），不冒充已采集行。
    return {
      degraded: true,
      ts_code: row.__code ?? null,
      name: null,
      benchmark: null,
      collection_status: row.__status ?? null,
      collection_reason: row.__reason ?? null,
      weight_date: null,
      publication_date: null,
      weight_freshness: { status: null, age_days: null, max_weight_age_days: null, note: null },
      constituent_count: null,
      weight_sum_pct: null,
      coverage: [],
      key_gaps: [],
      sources: [],
    };
  }
  const summary = row;
  const etf = (summary.etf ?? {}) as Record<string, unknown>;
  const constituents = (summary.constituents ?? {}) as Record<string, unknown>;
  const freshness = (constituents.freshness ?? {}) as Record<string, unknown>;
  const coverage = (summary.coverage ?? {}) as Record<string, unknown>;
  const components = Array.isArray(coverage.components) ? coverage.components : [];
  const gaps = Array.isArray(summary.gaps) ? summary.gaps : [];
  const sources = Array.isArray(summary.sources) ? summary.sources : [];
  return {
    degraded: false,
    ts_code: etf.ts_code ?? null,
    name: etf.name ?? null,
    benchmark: etf.benchmark ?? null,
    weight_date: constituents.weight_date ?? null,
    publication_date: constituents.publication_date ?? null,
    weight_freshness: {
      status: freshness.status ?? null,
      age_days: freshness.age_days ?? null,
      max_weight_age_days: freshness.max_weight_age_days ?? null,
      note: freshness.note ?? null,
    },
    constituent_count: typeof constituents.count === 'number' ? constituents.count : null,
    weight_sum_pct: typeof constituents.weight_sum_pct === 'number' ? constituents.weight_sum_pct : null,
    coverage: components.map((row) => {
      const component = (row ?? {}) as Record<string, unknown>;
      return {
        component: component.component ?? null,
        covered: component.covered ?? null,
        total: component.total ?? null,
        weight_covered_pct: component.weight_covered_pct ?? null,
        status: component.status ?? null,
      };
    }),
    key_gaps: gaps.slice(0, 10).map((row) => {
      const gap = (row ?? {}) as Record<string, unknown>;
      return { code: gap.code ?? null, field: gap.field ?? null, description: gap.description ?? null };
    }),
    sources: sources.slice(0, 10),
  };
}

/**
 * 附件 §14.5：证据登记表 + ETF 穿透摘要（工程术语只允许出现在本层）。
 * bundle 两键均可独立缺失：缺 evidence_register 只渲染穿透段，反之亦然。
 */
function buildBundleSection(bundle: ResearchBundleLike, audit: AnnotationAudit): Record<string, unknown> {
  const register = bundle.evidence_register;
  const outcomes = register?.outcomes ?? {};
  const rows = Array.isArray(register?.entries)
    ? register!.entries!.map(entry => evidenceRow(entry, outcomes)).filter((row): row is Record<string, unknown> => row !== null)
    : [];
  const summary = register?.summary ?? null;
  const highConfidence = register?.high_confidence
    ? {
      included_count: Array.isArray(register.high_confidence.included) ? register.high_confidence.included.length : null,
      excluded_count: Array.isArray(register.high_confidence.excluded) ? register.high_confidence.excluded.length : null,
      excluded: register.high_confidence.excluded ?? null,
    }
    : null;
  const penetration = penetrationList(bundle.etf_penetration).map(penetrationRow);
  const degradedCount = penetration.filter(row => row.degraded === true).length;
  const penMeta = bundle.etf_penetration !== null && typeof bundle.etf_penetration === 'object' && !Array.isArray(bundle.etf_penetration)
    ? bundle.etf_penetration as Record<string, unknown>
    : null;
  return {
    ...(register ? {
      evidence_register: {
        schema: register.schema ?? null,
        as_of_trade_date: register.as_of_trade_date ?? null,
        entries: rows,
        change_status_tally: Object.values(outcomes).reduce<Record<string, number>>((tally, status) => {
          tally[status] = (tally[status] ?? 0) + 1;
          return tally;
        }, {}),
        summary,
        high_confidence: highConfidence,
        status_derivation: register.status_derivation ?? null,
        user_layer_annotations: audit,
      },
    } : {}),
    ...(bundle.etf_penetration !== undefined && bundle.etf_penetration !== null
      ? {
        etf_penetration: {
          // 块级采集状态（信封 bundle 顶层）：块级 UNAVAILABLE/空表也必须在附件可见，不许假干净。
          ...(penMeta && 'status' in penMeta
            ? {
              status: penMeta.status ?? null,
              reason: penMeta.reason ?? null,
              ...(typeof penMeta.collected === 'number' ? { collected: penMeta.collected } : {}),
              ...(typeof penMeta.unavailable === 'number' ? { unavailable: penMeta.unavailable } : {}),
            }
            : {}),
          etfs: penetration,
          etf_count: penetration.length,
          ok_count: penetration.length - degradedCount,
          degraded_count: degradedCount,
        },
      }
      : {}),
  };
}

// ---------------------------------------------------------------- 用户版 A–H

function renderTitle(r: DailyReportResult, weekend: boolean): string {
  const label = monthDay(r.as_of_trade_date);
  return weekend
    ? `A股账户周末研究｜基于${label}收盘`
    : `A股账户研究日报｜${label}收盘`;
}

/** A. 今日结论：四问（最大变化/账户影响/是否行动/最重要风险），正文 ≤200 字。 */
function renderSectionA(r: DailyReportResult, view: RenderView): string {
  const market = r.market_judgement;
  const breadth = market.available
    ? market.judgement.map(line => zh(line)).find(line => line.includes('上涨占比')) ?? ''
    : '';
  const regime = market.available ? (market.regime_label ?? '') : '数据未就绪';
  const change = r.status === 'DATA_INSUFFICIENT' || !market.available
    ? '本期市场数据未就绪，不以旧数据替代当日结论。'
    : breadth
      ? `${regime}下当日多数个股上涨：${breadth.slice(0, breadth.indexOf('）') + 1 || undefined)}`
      : `${regime}，行情日期 ${monthDay(r.as_of_trade_date)}。`;
  const focusHolding = view.focus
    ? r.holdings.find(row => row.ts_code === view.focus!.ts_code)
    : undefined;
  const excess = focusHolding?.research.trend.excess_ret20_vs_broad_pct ?? null;
  const distance = focusHolding?.research.trend.distance_to_20d_low_pct ?? null;
  const focusBits: string[] = view.focus
    ? [`${view.focus.name ?? view.focus.ts_code}占 ${weightPct(view.focus.weight)}`]
    : ['持仓分散'];
  const trendClause = [
    excess !== null ? `近20日相对宽基${excess >= 0 ? '领先' : '落后'} ${pct(Math.abs(excess))}pp` : null,
    distance !== null ? `距20日低点 ${pctPoint(distance)}` : null,
  ].filter(Boolean).join('，');
  const accountOf = (withTrend: boolean): string =>
    `总资产 ${yuan(view.total)} 元（${monthDay(r.as_of_trade_date)}收盘重估），`
    + `${focusBits.join('，')}${withTrend && trendClause ? `，${trendClause}` : ''}。`;
  const action = r.status === 'DATA_INSUFFICIENT'
    ? '数据补齐前不给交易结论。'
    : r.actionable && r.first_section.count > 0
      ? `给出 ${r.first_section.count} 项下一交易日动作，须你确认后手动执行。`
      : '本期没有足够证据支持新的交易，建议暂不操作。';
  const unconfirmed = r.gate.unreported_trade_risk
    || r.data_quality.tiers.account_trade_completeness.status !== 'CONFIRMED_THROUGH_TARGET_DATE';
  const riskWithAmount = view.focus
    ? `最大风险是高集中下行：权益整体跌 10% 的压力情景约 ${yuan(Math.abs(view.holdStressCents ?? 0))} 元${unconfirmed ? '；成交核对未完成，暂不提供买卖数量' : ''}。`
    : `最大风险是市场继续下行${unconfirmed ? '；成交核对未完成，暂不提供买卖数量' : ''}。`;
  const riskPlain = view.focus
    ? `最大风险是高集中下行${unconfirmed ? '；成交核对未完成，暂不提供买卖数量' : ''}。`
    : `最大风险是市场继续下行${unconfirmed ? '；成交核对未完成，暂不提供买卖数量' : ''}。`;
  const count = (text: string): number => [...text].filter(char => !/\s/.test(char)).length;
  // 篇幅预算（8.4）：先给足信息量，超出 200 字依次丢弃趋势细节、压力金额，最后才报错。
  const joiner = /[。！？；：.]$/.test(change) ? '' : '；';
  const candidates = [
    `${change}${joiner}${accountOf(true)}${action}${riskWithAmount}`,
    `${change}${joiner}${accountOf(false)}${action}${riskWithAmount}`,
    `${change}${joiner}${accountOf(false)}${action}${riskPlain}`,
  ];
  const body = candidates.find(text => count(text) <= 200);
  if (!body) throw new Error(`A 节正文无法压入 200 字（最短 ${count(candidates[2])} 字）：${candidates[2]}`);
  return body;
}

/** B. 下一交易日关注重点：0–3 项，区分可交易决策 / 待研究候选 / 待核事实。 */
function renderSectionB(r: DailyReportResult): string {
  const items: string[] = [];
  if (r.status === 'DATA_INSUFFICIENT') {
    items.push('【需要核实的事实】当日市场数据未就绪；补齐收盘数据后重跑本期研究，期间不沿用旧数据下结论。');
  } else if (r.actionable && r.first_section.actions.length > 0) {
    for (const action of r.first_section.actions.slice(0, 2)) {
      items.push(`【可考虑的交易决策】${zh(action.title)}：${action.reasons.slice(0, 2).map(zh).join('；')}。`);
    }
  } else {
    items.push('【可考虑的交易决策】本期没有足够证据支持新的交易，建议暂不操作。（没有经过检验的优势证据支持新的买卖）');
  }
  const unreported = r.gate.unreported_trade_risk
    || r.data_quality.tiers.account_trade_completeness.status !== 'CONFIRMED_THROUGH_TARGET_DATE';
  if (unreported) {
    items.push('【需要核实的事实】账本事件只记录到 '
      + `${ymd(r.gate.reported_events_through)}，其后的券商成交尚未录入；`
      + '补齐并完成核对前，本报告不提供可直接使用的买卖数量。');
  }
  const watch = r.holdings
    .map(holding => ({ holding, condition: holding.research.conditions.find(cond => cond.stance === 'WATCH')?.when?.[0] }))
    .filter(row => row.condition && row.holding.weight >= 0.05)
    .sort((a, b) => b.holding.weight - a.holding.weight)[0];
  const cashCandidates = r.candidate_vs_cash.entries.filter(entry => entry.category === 'bond' || entry.category === 'cash');
  const cheapest = cashCandidates.length
    ? Math.min(...cashCandidates.map(entry => entry.one_lot_total_cents ?? Number.POSITIVE_INFINITY))
    : Number.POSITIVE_INFINITY;
  const researchItems: string[] = [];
  if (watch) {
    researchItems.push(`【需要继续研究的候选】${watch.holding.name}（${watch.holding.ts_code}）：${zh(watch.condition!)}`
      + `当前权重 ${weightPct(watch.holding.weight)}，是减仓研究的观察触发位。`);
  }
  if (Number.isFinite(cheapest)) {
    researchItems.push(`【需要继续研究的候选】防御性配置（债券/货币类）：现金 ${yuan(r.candidate_vs_cash.cash_cents ?? 0)} 元低于`
      + `最便宜一手含费约 ${yuan(cheapest)} 元，资金竞争需先卖出持仓，属独立决策。`);
  }
  for (const item of researchItems) {
    if (items.length >= 3) break;
    items.push(item);
  }
  if (!items.length) {
    items.push('本期没有足够证据支持新的交易，建议暂不操作。');
  }
  return items.slice(0, 3).map(item => `- ${item}`).join('\n');
}

/** C. 我的账户：总资产/区间变化/现金/五只权重/集中风险/观察窗口回撤/对账状态。 */
function renderSectionC(r: DailyReportResult, view: RenderView): string {
  const lines: string[] = [];
  const priceSource = r.account_view.revalued_basis.price_source;
  const basisNote = priceSource === 'server_cache_close'
    ? '当日收盘重估'
    : priceSource === 'snapshot_reference_price' ? '快照参考价重估' : '混合价格重估';
  lines.push(`- **总资产**：${yuan(view.total)} 元（${ymd(r.as_of_trade_date)}，${basisNote}；参考快照日期 ${isoDate(r.account_view.snapshot_as_of)}，证券数量与快照${r.account_view.quantity_consistent ? '一致' : '不一致，差异见核对说明'}）。`);
  lines.push(`- **现金**：${yuan(view.cash)} 元，占总资产 ${weightPct(view.cashRatio)}；证券市值 ${yuan(view.securities)} 元。`);
  const snapshotTotal = r.account_view.snapshot_basis.total_assets_cents;
  const delta = view.total - snapshotTotal;
  lines.push(`- **区间变化**：与参考快照（${isoDate(r.account_view.snapshot_as_of)}）相比总资产${delta >= 0 ? '增加' : '减少'} ${yuan(Math.abs(delta))} 元——差异来自快照之后已记录的账户事件与价格重估，不是当日盈亏的精确计量。`);
  const holdingRows = [...r.holdings].sort((a, b) => b.weight - a.weight)
    .map(holding => `${holding.name}（${holding.ts_code}）${weightPct(holding.weight)}`);
  lines.push(`- **五只持仓权重**：${holdingRows.join('；')}。`);
  lines.push(`- **集中风险**：第一大持仓 ${weightPct(view.focus?.weight ?? null)}，HHI ${pct(view.hhi, 4)}，有效持仓数 ${pct(view.effective)}——显著集中，是账户的第一风险来源；集中度是风险披露，不是卖出指令。`);
  if (view.drawdown) {
    lines.push(`- **观察窗口回撤**：当前 ${pctPoint(view.drawdown.current)}（窗口 ${ymd(view.drawdown.start)}至${ymd(view.drawdown.end)}，${view.drawdown.points ?? '—'} 个净值点，窗口内最大 ${pctPoint(view.drawdown.max)}）；账户全历史最大回撤数据不足，不计算。`);
  } else {
    lines.push('- **观察窗口回撤**：数据不足，未计算。');
  }
  const reconciled = !r.gate.unreported_trade_risk
    && r.data_quality.tiers.account_trade_completeness.status === 'CONFIRMED_THROUGH_TARGET_DATE';
  lines.push(reconciled
    ? `- **账户核对**：已完成——完整性声明覆盖目标交易日（最后人工核对 ${isoDate(r.gate.last_user_reconciled_at)}）。`
    : `- **账户核对**：未完成——账本事件记录至 ${ymd(r.gate.reported_events_through)}，最后人工核对 ${isoDate(r.gate.last_user_reconciled_at)}；存在未录入的成交风险，因此本期不提供可直接使用的买卖数量，上述金额是研究参考而非对账结果。`);
  return lines.join('\n');
}

/** D. 市场发生了什么：状态/广度量能风格/主要驱动/反证；不罗列全部宽基 20 日收益。 */
function renderSectionD(r: DailyReportResult, view: RenderView): string {
  const market = r.market_judgement;
  if (!market.available || r.status === 'DATA_INSUFFICIENT') {
    return '- 本期市场数据未就绪：不以任何旧日期数据替代当日行情，市场判断暂停一期。';
  }
  const lines: string[] = [];
  lines.push(`- **整体状态**：${market.regime_label ?? '未分类'}（${market.tone === 'neutral' ? '情绪中性' : market.tone === 'bearish' ? '情绪偏弱' : market.tone === 'bullish' ? '情绪偏强' : '情绪未标注'}），行情日期 ${ymd(market.fact_meta.as_of)}。`);
  const metrics = market.judgement
    .map(line => zh(line))
    .filter(line => /上涨|成交额|站上|相对/.test(line))
    .slice(0, 4);
  for (const metric of metrics) lines.push(`- ${metric}。`);
  const support = market.support_evidence.filter(item => /上涨家数|成交额|中位数/.test(item.statement)).slice(0, 2);
  const counter = market.counter_evidence.filter(item => /站上|近 20 日|近 5 日/.test(item.statement)).slice(0, 3);
  if (support.length) {
    lines.push(`- **主要支撑**：${support.map(item => `${zh(item.statement)}（${ymd(item.as_of)}）`).join('；')}。`);
  }
  if (counter.length) {
    lines.push(`- **不支持当前判断的证据**：${counter.map(item => `${zh(item.statement)}（${ymd(item.as_of)}）`).join('；')}——反证项共 ${market.counter_evidence.length} 条、支撑项 ${market.support_evidence.length} 条，反证明显占优。`);
  }
  if (!view.hasPreviousDayDelta) {
    lines.push('- **与前一日对比**：本报告按单一交易日事实生成，未内嵌昨日对照；判断层面最需要盯的是上述反证/支撑数量差。');
  }
  return lines.join('\n');
}

/** E. 我的五只持仓：紧凑表 + 最多 1–2 只展开。annotations 缺省时行为与旧版一致。 */
function renderSectionE(r: DailyReportResult, annotations: AnnotationIndex = new Map()): string {
  if (!r.holdings.length) return '- 本期没有可展示的持仓。';
  const rows = [...r.holdings].sort((a, b) => b.weight - a.weight);
  const header = '| 持仓 | 收盘价(元) | 当日涨跌 | 权重 | 20日相对宽基 | 研究结论 |\n|---|---|---|---|---|---|';
  const table = rows.map((holding) => {
    const quote = holding.research.quote;
    const trend = holding.research.trend;
    const stance = holding.stance === 'HOLD' ? '持有' : holding.stance === 'REDUCE' ? '减仓(研究)'
      : holding.stance === 'ROTATE' ? '轮动(研究)' : '等待';
    const fresh = holding.research.data.fresh && holding.bar_quality === 'READY';
    const conclusion = fresh ? `${stance}，判断未变` : `${stance}，行情待补`;
    const close = quote.close_cny === null ? '—' : quote.close_cny.toFixed(3);
    const chg = quote.pct_chg === null ? '—' : `${quote.pct_chg >= 0 ? '+' : ''}${quote.pct_chg.toFixed(2)}%`;
    const excess = trend.excess_ret20_vs_broad_pct === null ? '—'
      : `${trend.excess_ret20_vs_broad_pct >= 0 ? '+' : ''}${trend.excess_ret20_vs_broad_pct.toFixed(2)}pp`;
    return `| ${holding.name}(${holding.ts_code}) | ${close} | ${chg} | ${weightPct(holding.weight)} | ${excess} | ${conclusion} |`;
  }).join('\n');
  // 展开优先级：权重高且（相对表现分叉大或贴近观察触发位）的持仓，最多两只。
  const expandable = rows.filter((holding) => {
    const trend = holding.research.trend;
    const excess = trend.excess_ret20_vs_broad_pct;
    const distance = trend.distance_to_20d_low_pct;
    return holding.weight >= 0.05 && (
      (excess !== null && Math.abs(excess) >= 5)
      || (distance !== null && distance <= 5));
  }).slice(0, 2);
  const blocks = expandable.map((holding) => {
    const research = holding.research;
    const trend = research.trend;
    const quote = research.quote;
    const parts: string[] = [];
    parts.push(`**${holding.name}（${holding.ts_code}）——展开**`);
    if (quote.close_cny !== null && quote.pct_chg !== null) {
      parts.push(`- 当日：收盘 ${quote.close_cny.toFixed(3)} 元（${quote.pct_chg >= 0 ? '+' : ''}${quote.pct_chg.toFixed(2)}%），成交额 ${quote.amount_cny === null ? '—' : `${(quote.amount_cny / 1e8).toFixed(2)} 亿元`}。`);
    } else {
      parts.push('- 当日：行情缺失，以下判断以最近可得数据为准。');
    }
    const relative: string[] = [];
    if (trend.ret5_pct !== null) relative.push(`近 5 日 ${trend.ret5_pct.toFixed(2)}%`);
    if (trend.ret20_pct !== null) relative.push(`近 20 日 ${trend.ret20_pct.toFixed(2)}%`);
    if (trend.ret60_pct !== null) relative.push(`近 60 日 ${trend.ret60_pct.toFixed(2)}%`);
    if (trend.excess_ret20_vs_broad_pct !== null) relative.push(`20 日相对宽基 ${trend.excess_ret20_vs_broad_pct >= 0 ? '+' : ''}${trend.excess_ret20_vs_broad_pct.toFixed(2)} 个百分点`);
    if (trend.excess_ret20_vs_theme_pct !== null) relative.push(`相对行业中位 ${trend.excess_ret20_vs_theme_pct >= 0 ? '+' : ''}${trend.excess_ret20_vs_theme_pct.toFixed(2)} 个百分点`);
    if (relative.length) parts.push(`- 相对表现：${relative.join('，')}。`);
    const position: string[] = [`权重 ${weightPct(holding.weight)}`];
    if (trend.above_ma20 !== null) position.push(trend.above_ma20 ? '收盘站上 20 日均价' : '收盘低于 20 日均价');
    if (trend.above_ma60 !== null && !trend.above_ma60) position.push('低于 60 日均价（中期趋势未修复）');
    if (trend.distance_to_20d_low_pct !== null) position.push(`距 20 日最低收盘 ${pctPoint(trend.distance_to_20d_low_pct)}`);
    parts.push(`- 位置：${position.join('；')}。`);
    // 8.5 行内来源：target 与持仓代码匹配的证据以「claim（publisher，日期）」形式标注。
    // NEW/UPDATED 计入"新证据"行；UNCHANGED 只以"在册来源"标注——旧闻不冒充本期新证据
    // （G7 纪律：证据登记表里的重复旧闻按其自身发布日期呈现，不升级结论）。无匹配保持原句。
    const sources = annotations.get(holding.ts_code) ?? [];
    const fresh = sources.filter(annotation => annotation.outcome !== 'UNCHANGED');
    const inRegister = sources.filter(annotation => annotation.outcome === 'UNCHANGED');
    if (fresh.length || inRegister.length) {
      const bits: string[] = [];
      if (fresh.length) bits.push(`最主要新证据：${fresh.map(formatAnnotation).join('；')}`);
      else bits.push('本期没有新增产业证据');
      if (inRegister.length) bits.push(`在册来源（非本期新增）：${inRegister.map(formatAnnotation).join('；')}`);
      parts.push(`- ${bits.join('；')}。`);
    } else {
      parts.push('- 最主要新证据：本期没有新增产业证据；账户层面的主导事实是其权重与相对表现（如上）。');
    }
    const counters = research.counter_thesis
      .map(text => zh(text).replace(/[；;。.]+$/g, ''))
      .filter(text => !text.includes('阈值'))
      .slice(0, 3);
    if (counters.length) parts.push(`- 风险与反证：${counters.join('；')}。`);
    const watch = research.conditions.find(cond => cond.stance === 'WATCH');
    if (watch) {
      const triggers = watch.when.map(text => zh(text).replace(/[；;。.]+$/g, ''));
      parts.push(`- 研究结论：持有、观察。触发位：${triggers.join('；')}。`);
    }
    return parts.join('\n');
  });
  const restNote = rows.length > expandable.length
    ? `- 其余 ${rows.length - expandable.length} 只持仓本期无重要变化，判断未变（见上表）。`
    : '';
  // 未进入展开块但有匹配证据的持仓：在其余持仓注记后逐条给出 8.5 行内来源，
  // 保证每条入选标注都至少在正文出现一次（否则 audit 计数会虚高）。
  const restEvidenceNotes = rows
    .filter(holding => !expandable.includes(holding) && (annotations.get(holding.ts_code)?.length ?? 0) > 0)
    .map(holding => `- ${holding.name}来源：${annotations.get(holding.ts_code)!.map(formatAnnotation).join('；')}。`);
  // 表头与表体之间不能有空行（markdown 表格会被截断），因此合并为一个块。
  return [[header, table].join('\n'), restNote, ...restEvidenceNotes, ...blocks].filter(Boolean).join('\n\n');
}

/** F. 是否有更好的选择：六条路的机会成本与资金竞争，不强行推荐。 */
function renderSectionF(r: DailyReportResult, view: RenderView, annotations: AnnotationIndex = new Map()): string {
  const lines: string[] = [];
  lines.push('按机会成本比较六条路（所有数字为研究口径，不是交易指令）：');
  lines.push('');
  lines.push(`1. **继续持有现有五只 ETF**：当前基准方案。代价是承担集中与继续下行的风险；好处是不放弃任何反弹、不产生费用。`);
  const focus = view.focus;
  if (focus && view.reduceStressCents !== null && view.reduceEquityWeight !== null) {
    lines.push(`2. **适度降低集中暴露（对 ${focus.ts_code}）**：同一压力假设下，压力损失从约 ${yuan(Math.abs(view.holdStressCents ?? 0))} 元降到约 ${yuan(Math.abs(view.reduceStressCents))} 元，权益占比从 ${weightPct(view.equityWeight)} 降到约 ${view.reduceEquityWeight.toFixed(2)}%，HHI 从 ${pct(view.hhi, 4)} 降到约 ${pct(view.reduceHhi, 4)}；代价是若该 ETF 反弹，按 ${weightPct(focus.weight)} 的权重将放弃其上涨的约 ${(focus.weight * 100).toFixed(0)}%，且卖出产生预估费用。`);
    lines.push(`   （该对照不生成数量：卖出多少必须由你给出研究数量或由已确认的风险政策触发，系统不按任何固定阈值自动计算。）`);
    // 8.5 行内来源：聚焦持仓的证据标注；无匹配时不加注（保持原句）。
    const focusSources = annotations.get(focus.ts_code) ?? [];
    if (focusSources.length) {
      lines.push(`   （聚焦持仓来源：${focusSources.map(formatAnnotation).join('；')}。）`);
    }
  } else {
    lines.push('2. **适度降低集中暴露**：本期缺少集中持仓或压力参数，无法给出量化对照。');
  }
  const cash = r.candidate_vs_cash.cash_cents ?? 0;
  const candidates = r.candidate_vs_cash.entries;
  const affordable = candidates.filter(entry => entry.cash_sufficient_for_one_lot === true);
  const cheapest = candidates.length
    ? Math.min(...candidates.map(entry => entry.one_lot_total_cents ?? Number.POSITIVE_INFINITY))
    : Number.POSITIVE_INFINITY;
  lines.push(`3. **换入其他 ETF**：候选高分项集中于债券/货币类${affordable.length ? `，其中 ${affordable.length} 项现金买得起一手` : Number.isFinite(cheapest) ? `，但一手含费最低约 ${yuan(cheapest)} 元、高于现金 ${yuan(cash)} 元` : '，本期缺少可比报价'}；换入需要先卖出，构成两步决策，目前没有经过检验的优势证据支持换入。候选数据带有降级标记（基准指数未声明），只作资金门槛参考。`);
  lines.push('4. **沪深主板个股**：本期候选池只覆盖 ETF，没有个股比较数据——这是覆盖缺口，不等于"没有更好的股票"。');
  lines.push(`5. **保留现金**：现金仅占 ${weightPct(view.cashRatio)}，一手门槛普遍高于现金；"多留现金"实际意味着卖出持仓，回到方案 2 的决策。`);
  lines.push(Number.isFinite(cheapest)
    ? `6. **债券、货币等防御工具**：最便宜一手含费约 ${yuan(cheapest)} 元，现金缺口约 ${yuan(Math.max(0, cheapest - cash))} 元；防御的现实路径是卖出部分持仓换取，而不是用现有现金买入。`
    : '6. **债券、货币等防御工具**：本期缺少可比报价，无法量化资金门槛；防御配置的现实路径是卖出部分持仓换取。');
  lines.push('');
  lines.push('**结论**：没有可靠优势支持换仓或新增交易；唯一有数据支撑的比较是"集中度 vs 反弹参与度"，它属于风险管理决策，依据是你的风险政策，而不是新的行情信息。');
  return lines.join('\n');
}

/** G. 风险与情景：下行担心/持有损失/降风险改善/失去反弹/风险政策预警。 */
function renderSectionG(r: DailyReportResult, view: RenderView): string {
  const lines: string[] = [];
  const focus = view.focus;
  lines.push(`- **最担心的下行情景**：${focus ? `${focus.name ?? focus.ts_code}（权重 ${weightPct(focus.weight)}）在行业景气回落下继续走低，叠加账户现金只有 ${yuan(view.cash)} 元、无缓冲` : '市场整体继续走低'}。`);
  if (view.holdStressCents !== null) {
    const stressPct = r.decision_comparison.options.find(option => option.action === 'HOLD')?.risk_budget?.stress_loss_pct_of_total_assets;
    lines.push(`- **继续持有可能损失多少**：按声明式压力假设（权益类整体 -10%），证券市值约 ${yuan(Math.abs(view.holdStressCents))} 元的冲击${stressPct !== null && stressPct !== undefined ? `，约占总资产 ${pct(Math.abs(stressPct))}%` : ''}——这是压力情景口径，不是预测，也不是历史回撤。`);
  }
  if (view.reduceStressCents !== null) {
    lines.push(`- **降低风险改善什么**：若把聚焦持仓的权重降下来（同一压力假设），压力损失可降到约 ${yuan(Math.abs(view.reduceStressCents))} 元，权益占比降到约 ${view.reduceEquityWeight?.toFixed(2) ?? '—'}%；代价是失去对应的反弹参与度——按 ${weightPct(focus?.weight ?? null)} 权重，放弃该 ETF 反弹的约 ${focus ? (focus.weight * 100).toFixed(0) : '—'}%。`);
  }
  if (view.warning) {
    if (view.warning.triggered) {
      const review = r.portfolio_risk?.policy?.tiers?.find?.((tier: any) => tier?.level === view.warning!.level)?.review ?? '复核仓位与风险来源';
      lines.push(`- **风险政策预警**：已触发（${view.warning.level} 档，${r.portfolio_risk?.warning?.required_review ?? review}）——预警只触发研究复核，不自动减仓或清仓，实际交易由你手动决定。`);
    } else {
      const l1 = view.l1DrawdownPct;
      const gap = l1 !== null && view.drawdown?.current !== null && view.drawdown?.current !== undefined && l1 !== undefined
        ? `，距 L1 档（回撤 ${l1}% 触发复核）还有 ${pct(l1 - view.drawdown.current)} 个百分点`
        : '';
      lines.push(`- **风险政策预警**：未触发（观察窗口回撤 ${pctPoint(view.drawdown?.current)}${gap}；政策 ${isoDate(view.policyApprovedOn)} 确认，预警只触发研究复核，不自动减仓）。`);
    }
  } else {
    lines.push('- **风险政策预警**：本期没有可展示的组合风险政策状态。');
  }
  lines.push('- **口径提醒**：以上压力数字是预设情景不是收益预测；账户全历史最大回撤数据不足，不以观察窗口回撤冒充。');
  return lines.join('\n');
}

/** H. 接下来验证什么：≤3 项，具体、可验证、有期限或事件条件。 */
function renderSectionH(r: DailyReportResult): string {
  const items: string[] = [];
  const watch = [...r.holdings].sort((a, b) => b.weight - a.weight)
    .map(holding => ({ holding, condition: holding.research.conditions.find(cond => cond.stance === 'WATCH')?.when?.[0] }))
    .find(row => row.condition);
  if (watch) {
    items.push(`${watch.holding.name}：${zh(watch.condition!)}（事件条件成立后的下一个交易日重新评估减仓研究）。`);
  }
  const trigger = r.first_section.observation_triggers
    .map(zh)
    .find(text => text.includes('反证'));
  if (trigger) {
    items.push(`下一交易日收盘后核对：${trigger}——若成立，重估持有依据。`);
  }
  if (r.gate.unreported_trade_risk) {
    items.push(`补录 ${ymd(r.gate.reported_events_through)} 之后的券商成交并完成现金/持仓核对——在未录入成交风险解除前，不提供可直接使用的买卖数量。`);
  } else if (!r.plan_tracking.available) {
    items.push('历史预案跟踪数据补齐后，回看观察触发条件是否被触发（当前无法核对）。');
  }
  return items.slice(0, 3).map(item => `- ${item}`).join('\n');
}

function renderUser(r: DailyReportResult, weekend: boolean, annotations: AnnotationIndex = new Map()): string {
  const view = buildView(r);
  const title = renderTitle(r, weekend);
  const sections = [
    `## A. 今日结论\n\n${renderSectionA(r, view)}`,
    `## B. 下一交易日关注重点\n\n${renderSectionB(r)}`,
    `## C. 我的账户\n\n${renderSectionC(r, view)}`,
    `## D. 市场发生了什么\n\n${renderSectionD(r, view)}`,
    `## E. 我的五只持仓\n\n${renderSectionE(r, annotations)}`,
    `## F. 是否有更好的选择\n\n${renderSectionF(r, view, annotations)}`,
    `## G. 风险与情景\n\n${renderSectionG(r, view)}`,
    `## H. 接下来验证什么\n\n${renderSectionH(r)}`,
  ];
  const footer = [
    `数据日期 ${ymd(r.as_of_trade_date)}，下一交易日 ${ymd(r.expected_next_trade_date)}。`,
    zh(r.disclaimer).replace('研究性主张标记为 尚未经过检验。', '研究性主张尚未经过前瞻性检验。'),
  ].join(' ');
  const text = [`# ${title}`, ...sections, '---', `*${footer}*`].join('\n\n');
  assertUserReportClean(text);
  return text;
}

// ---------------------------------------------------------------- 技术审计附件（8.3）

/** 8.3 要求的取数映射：H 的 golden test 与一致性断言按此表核对。 */
export const SECTION_FIELD_MAP = {
  A: ['status', 'actionable', 'first_section.count', 'market_judgement.regime_label/judgement', 'account_view.revalued_basis.total_assets_cents', 'decision_comparison.focus.weight', 'holdings[].research.trend.excess_ret20_vs_broad_pct', 'decision_comparison.options[HOLD].stress_after.loss_cents', 'data_quality.tiers.account_trade_completeness.status', 'gate.unreported_trade_risk'],
  B: ['status', 'first_section.actions', 'first_section.no_action_reason', 'gate.reported_events_through', 'holdings[].research.conditions[WATCH]', 'candidate_vs_cash.entries[].one_lot_total_cents'],
  C: ['account_view.*', 'concentration.*', 'drawdown.observation_window', 'portfolio_risk.drawdown', 'gate.*', 'data_quality.tiers.account_trade_completeness.status'],
  D: ['market_judgement.available/regime_label/tone/judgement', 'market_judgement.support_evidence', 'market_judgement.counter_evidence', 'has_previous_day_delta(缺失时显式说明)'],
  E: ['holdings[].ts_code/name/weight/stance', 'holdings[].research.quote.*', 'holdings[].research.trend.*', 'holdings[].research.counter_thesis', 'holdings[].research.conditions[WATCH]'],
  F: ['decision_comparison.focus', 'decision_comparison.options[].opportunity_cost', 'candidate_vs_cash.entries[]', 'candidate_vs_cash.cash_cents', 'concentration.*', 'decision_comparison.options[HOLD/DEFENSIVE].stress_after.loss_cents'],
  G: ['decision_comparison.options[].stress_after', 'decision_comparison.options[].risk_budget', 'portfolio_risk.warning/policy.tiers/drawdown', 'drawdown.*'],
  H: ['holdings[].research.conditions[WATCH]', 'first_section.observation_triggers', 'gate.unreported_trade_risk', 'plan_tracking.available'],
} as const;

/**
 * 递归收集 result 中所有状态类字段（status/gate/basis/quality/level/... 的标量值），
 * 作为附件 §1 的"原始状态码全集"，保证任何状态码都不会因为展示层翻译而丢失。
 */
function collectStatusFields(value: unknown, path: string, out: Record<string, unknown>, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    // 数组最多采样 10 项：逐条行的重复状态由 §4 整体状态覆盖，完整原始数据以 --format json 为准。
    value.slice(0, 10).forEach((item, index) => collectStatusFields(item, `${path}[${index}]`, out, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'candidates') continue; // 候选筛选逐行状态由 §4 screening 整体覆盖，避免 220+ 行淹没附件。
      const next = path ? `${path}.${key}` : key;
      if (child !== null && typeof child !== 'object') {
        if (/status|gate|state|basis|quality|level|phase|reason|executable|verified|fresh|ready|assumed|available|consistent|triggered|unreported/i.test(key)) {
          out[next] = child;
        }
      } else {
        collectStatusFields(child, next, out, depth + 1);
      }
    }
  }
}

function jsonBlock(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

function buildTechnicalSections(
  r: DailyReportResult,
  view: RenderView,
  rendererVersion: string,
  now: string | null,
  bundle: ResearchBundleLike | null = null,
  annotationIndex: AnnotationIndex = new Map(),
  annotationAudit: AnnotationAudit | null = null,
): Record<string, unknown> {
  const statusFields: Record<string, unknown> = {};
  collectStatusFields(r, '', statusFields);
  const options = r.decision_comparison.options ?? [];
  const focusHolding = view.focus
    ? r.holdings.find(row => row.ts_code === view.focus!.ts_code)
    : undefined;
  // 用户版正文中以 "%" 粘连打印的数字（golden 的可追溯断言按这些值核对）。
  const percentValues: number[] = [];
  const collectPercents = (text: string): void => {
    for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)%/g)) percentValues.push(Number(match[1]));
  };
  if (r.market_judgement.available) {
    r.market_judgement.judgement.forEach(collectPercents);
    r.market_judgement.support_evidence.forEach(item => collectPercents(item.statement));
    r.market_judgement.counter_evidence.forEach(item => collectPercents(item.statement));
  }
  // 观察触发位价格（用户版 H/B 以 "0.8350 元" 形式引用）。
  const watchPrices: number[] = [];
  for (const holding of r.holdings) {
    for (const condition of holding.research.conditions) {
      if (condition.stance !== 'WATCH') continue;
      for (const text of condition.when) {
        for (const match of text.matchAll(/（([\d.]+) 元）/g)) watchPrices.push(Number(match[1]));
      }
    }
  }
  const snapshotTotal = r.account_view.snapshot_basis.total_assets_cents;
  const shockPct = options.find(option => option.action === 'HOLD')?.stress_after?.equity_shock_pct ?? null;
  const holdStressPct = options.find(option => option.action === 'HOLD')?.risk_budget?.stress_loss_pct_of_total_assets ?? null;
  const l1GapPct = view.l1DrawdownPct !== null && view.drawdown?.current !== null && view.drawdown?.current !== undefined
    ? r6(view.l1DrawdownPct - view.drawdown.current)
    : null;
  const embeddedNumbers = {
    focus_weight_pct: view.focus ? r6(view.focus.weight * 100) : null,
    focus_excess_20d_pp: focusHolding?.research.trend.excess_ret20_vs_broad_pct ?? null,
    focus_distance_to_20d_low_pct: focusHolding?.research.trend.distance_to_20d_low_pct ?? null,
    total_assets_cents: view.total,
    cash_cents: view.cash,
    securities_mv_cents: view.securities,
    snapshot_total_assets_cents: snapshotTotal,
    delta_total_assets_cents: view.total - snapshotTotal,
    delta_total_assets_abs_cents: Math.abs(view.total - snapshotTotal),
    equity_weight_pct: view.equityWeight === null ? null : r6(view.equityWeight * 100),
    cash_weight_pct: view.cashRatio === null ? null : r6(view.cashRatio * 100),
    drawdown_current_pct: view.drawdown?.current ?? null,
    drawdown_max_pct: view.drawdown?.max ?? null,
    drawdown_points: view.drawdown?.points ?? null,
    l1_threshold_pct: view.l1DrawdownPct,
    l1_gap_pct: l1GapPct,
    hold_stress_pct_of_total: holdStressPct,
    hold_stress_abs_pct_of_total: holdStressPct === null ? null : Math.abs(holdStressPct),
    hold_stress_abs_cents: view.holdStressCents === null ? null : Math.abs(view.holdStressCents),
    equity_shock_pct: shockPct === null ? null : r6(shockPct * 100),
    equity_shock_magnitude_pct: shockPct === null ? null : Math.abs(r6(shockPct * 100)),
    reduce_stress_cents: view.reduceStressCents,
    reduce_stress_abs_cents: view.reduceStressCents === null ? null : Math.abs(view.reduceStressCents),
    reduce_equity_weight_pct: view.reduceEquityWeight,
    reduce_hhi: view.reduceHhi,
    focus_value_cents: view.focusValue,
    cheapest_one_lot_total_cents: r.candidate_vs_cash.entries.length
      ? Math.min(...r.candidate_vs_cash.entries.map(entry => entry.one_lot_total_cents ?? Number.POSITIVE_INFINITY))
      : null,
    one_lot_cash_gap_cents: r.candidate_vs_cash.entries.length
      ? (() => {
        const cheapest = Math.min(...r.candidate_vs_cash.entries.map(entry => entry.one_lot_total_cents ?? Number.POSITIVE_INFINITY));
        return Number.isFinite(cheapest) ? Math.max(0, cheapest - (r.candidate_vs_cash.cash_cents ?? 0)) : null;
      })()
      : null,
    etf_quote_ready_count: r.data_quality.tiers.etf_price.ready.length,
    etf_quote_stale_count: r.data_quality.tiers.etf_price.not_ready.length,
    watch_trigger_prices_cny: watchPrices,
    market_percent_values: percentValues,
    etf_amount_cny: r.holdings.map(holding => holding.research.quote.amount_cny),
    etf_close_cny: r.holdings.map(holding => holding.research.quote.close_cny),
    etf_pct_chg: r.holdings.map(holding => holding.research.quote.pct_chg),
  };
  return {
    '0. 报告头': {
      schema: r.schema,
      report_id: r.report_id,
      status: r.status,
      actionable: r.actionable,
      as_of_trade_date: r.as_of_trade_date,
      expected_next_trade_date: r.expected_next_trade_date,
      account_id: r.account_id,
      account_id_source: r.account_id_source,
      account_status: r.account_status,
      timestamps: r.timestamps,
      renderer_version: rendererVersion,
      rendered_at: now,
    },
    '1. 全部原始状态码': statusFields,
    '2. 数据源与版本': {
      market_report: r.data_quality.market_report,
      quote_updated_at: r.timestamps.quote_updated_at,
      account_confirmed_at: r.timestamps.account_confirmed_at,
      price_source: r.account_view.revalued_basis.price_source,
      snapshot_id: r.account_view.snapshot_id,
      snapshot_as_of: r.account_view.snapshot_as_of,
      screening: { status: r.data_quality.screening.status, missing_tables: r.data_quality.screening.missing_tables },
      fact_sources: r.fact_register.map(row => ({ id: row.id, source: row.source, as_of: row.as_of, quality: row.quality })),
    },
    '3. 研究快照': {
      report_id: r.report_id,
      fact_register: r.fact_register,
      plan_tracking: r.plan_tracking,
    },
    '4. 数据质量': r.data_quality,
    '5. 研究证据': {
      research_status: r.market_judgement.research_status,
      fact_meta: r.market_judgement.fact_meta,
      judgement: r.market_judgement.judgement,
      support_evidence: r.market_judgement.support_evidence,
      counter_evidence: r.market_judgement.counter_evidence,
      first_section_no_action_reason: r.first_section.no_action_reason,
      observation_triggers: r.first_section.observation_triggers,
    },
    '6. 账户完整性': {
      account_status: r.account_status,
      gate: r.gate,
      account_view: r.account_view,
      tiers: {
        account_identity: r.data_quality.tiers.account_identity,
        account_trade_completeness: r.data_quality.tiers.account_trade_completeness,
      },
      holdings_bar_quality: r.holdings.map(holding => ({
        ts_code: holding.ts_code, bar_quality: holding.bar_quality,
        latest_bar_date: holding.latest_bar_date, price_source: holding.price_source,
        fresh: holding.research.data.fresh, price_basis: holding.research.data.price_basis,
        unavailable: holding.research.availability.unavailable,
      })),
    },
    '7. 费用字段分类': r.assumptions,
    '8. 研究评价资格': {
      plan_tracking: r.plan_tracking,
      not_covered: r.not_covered,
      option_decision_basis: options.map(option => ({
        action: option.action, decision_basis: option.decision_basis, executable: option.executable,
        quantity_basis: option.quantity_basis, funding_status: option.funding_status,
      })),
      market_research_status: r.market_judgement.research_status,
    },
    '9. 技术风险': {
      portfolio_risk: r.portfolio_risk ?? null,
      drawdown: r.drawdown,
      concentration: r.concentration,
      risk_budgets: options.map(option => ({
        action: option.action, risk_budget: option.risk_budget, stress_after: option.stress_after,
        opportunity_cost: option.opportunity_cost, invalidation_conditions: option.invalidation_conditions,
      })),
    },
    '10. 接口调用摘要': {
      entry: 'portfolio-daily-report / ashare_portfolio_daily_report',
      account_id: r.account_id,
      account_id_source: r.account_id_source,
      as_of_trade_date: r.as_of_trade_date,
      snapshot_id: r.account_view.snapshot_id,
      rendered_layers: ['user', 'technical'],
      input_shape: 'DailyReportResult',
    },
    '11. 数据缺口': {
      missing_fields: r.data_quality.missing_fields,
      data_quality_notes: r.data_quality.notes,
      not_covered: r.not_covered,
      plan_tracking_reason: r.plan_tracking.reason,
      holdings_unavailable: r.holdings
        .filter(holding => holding.research.availability.unavailable.length > 0)
        .map(holding => ({ ts_code: holding.ts_code, unavailable: holding.research.availability.unavailable })),
      previous_day_comparison_present: view.hasPreviousDayDelta,
    },
    '12. 关键计算过程及参数': {
      concentration: {
        formula: 'HHI = Σ(持仓市值/总资产)^2；有效持仓数 = 1/HHI；分母含现金与理财，现金不计入分子。',
        disclosure: r.concentration.disclosure,
        values: { hhi: view.hhi, effective_positions: view.effective, equity_weight: view.equityWeight, cash_ratio: view.cashRatio },
      },
      stress: {
        formula: '压力损失 = Σ(资产类别市值 × 声明式冲击)；权益 -10%，非预测非历史回撤。',
        hold_loss_cents: view.holdStressCents,
      },
      concentration_contrast_derived: {
        note: '展示层派生数字：仅用本 result 字段做四则运算，供 F/G 使用；如与 B 合流后的 scenario 结果冲突，以 scenario 字段为准。',
        focus: view.focus,
        focus_value_cents: view.focusValue,
        reduce_stress_cents: view.reduceStressCents,
        reduce_stress_formula: 'hold_stress_loss + focus_mv × equity_shock（权益冲击线性扣除聚焦持仓；仅当五只持仓全部为权益类时可用，否则为 null）',
        reduce_hhi: view.reduceHhi,
        reduce_hhi_formula: 'hhi - focus_weight^2（卖出聚焦持仓后分子去掉其权重平方，分母按总资产不变口径、未计费用）',
        reduce_equity_weight_pct: view.reduceEquityWeight,
        reduce_equity_weight_formula: '(securities_mv - focus_mv) / total_assets × 100（仅当全部证券为权益类时可用）',
      },
      account_reconciliation: r.account_view.reconciliation,
      decision_comparison_note: r.decision_comparison.note,
      assumptions: r.assumptions.note,
    },
    '13. 用户版取数映射': SECTION_FIELD_MAP,
    '14. 双层一致性': {
      input_report_id: r.report_id,
      input_status: r.status,
      single_pass: true,
      user_version_forbidden_check: 'assertUserReportClean(user) 已在渲染内执行',
      numbers_recomputed_in_renderer: ['reduce_stress_cents', 'reduce_hhi', 'reduce_equity_weight_pct'],
      // 仅在第二参为 bundle 形状时追加（无 bundle 时本节与旧输出逐字节一致）。
      ...(bundle ? {
        bundle_supplied: true,
        user_layer_bundle_annotations: annotationAudit?.annotations_in_user_layer ?? 0,
      } : {}),
    },
    // §14.5 bundle 绑定（第二参为 bundle 形状时才存在）：证据登记表（含 URL/检索时间/
    // 四态变化状态——工程术语只允许出现在本层）+ ETF 穿透摘要（权重日期/新鲜度/覆盖率/缺口）。
    ...(bundle && (bundle.evidence_register || bundle.etf_penetration !== undefined)
      ? { '14.5. 证据登记与ETF穿透': buildBundleSection(bundle, annotationAudit ?? emptyAnnotationAudit()) }
      : {}),
    // 用户版正文中以数值形式打印、且可能未在原始 JSON 里以独立数值出现的派生量。
    // golden test 的"正文数字 ↔ 附件一致"断言按此表 + §16 原始 JSON 递归核对。
    '15. 用户版内嵌数字': {
      ...embeddedNumbers,
      // E/F 引用进正文的 claim 中的带单位数字（bundle 标注路径专属；无 bundle 时该键不出现）。
      ...(annotationAudit && annotationAudit.annotations_in_user_layer > 0
        ? { cited_claim_unit_numbers: citedClaimNumbers(annotationIndex) }
        : {}),
    },
    // 原始 DailyReportResult 全量 JSON（8.3：数据源与版本/研究快照等的完整可追溯底档）。
    '16. 原始日报 JSON': r,
  };
}

function renderTechnical(
  r: DailyReportResult,
  view: RenderView,
  rendererVersion: string,
  now: string | null,
  bundle: ResearchBundleLike | null = null,
  annotationIndex: AnnotationIndex = new Map(),
  annotationAudit: AnnotationAudit | null = null,
): { text: string; sections: Record<string, unknown> } {
  const sections = buildTechnicalSections(r, view, rendererVersion, now, bundle, annotationIndex, annotationAudit);
  const header = [
    `# 技术审计附件｜A股账户日报 ${r.as_of_trade_date}`,
    '',
    `- schema: ${r.schema}`,
    `- report_id: ${r.report_id}`,
    `- status: ${r.status} / actionable: ${r.actionable}`,
    `- account: ${r.account_id} (${r.account_status})`,
    `- renderer: ${rendererVersion}`,
    '',
    '本附件与用户版来自同一份 DailyReportResult 一次性渲染；完整原始 JSON 亦内嵌于 §16。',
  ].join('\n');
  const body = Object.entries(sections).map(([title, value]) => `## ${title}\n\n${jsonBlock(value)}`).join('\n\n');
  return { text: `${header}\n\n${body}\n`, sections };
}

// ---------------------------------------------------------------- 入口

/**
 * 双层渲染入口：同一份不可变事实 → { user, technical, attachment }。
 *
 * - user：A–H 中文 markdown，渲染内已执行禁词断言；
 * - technical：机器可读附件（markdown + 内嵌 JSON 块，8.3 选型见文件头注释）；
 * - attachment：附件的结构化对象，供 golden test 递归做"正文数字 ↔ 附件一致"断言。
 *
 * 第二参多态（调用方兼容）：
 * - `renderDailyReport(report)` / `renderDailyReport(report, { now })`：旧行为，
 *   无 bundle——输出与未接入 bundle 时逐字节一致（20261023 走查路径）；
 * - `renderDailyReport(report, bundleResult)`：bundle 形状（顶层含 evidence_register
 *   或 etf_penetration），E/F 节按 target 匹配追加 8.5 行内来源，附件增 §14.5；
 * - `renderDailyReport(report, { now, bundle })`：golden test 的探测形状，两种能力叠加。
 * 非 bundle、非 RenderOptions 的第二参按旧语义安全忽略。
 */
export function renderDailyReport(
  result: DailyReportResult,
  second?: RenderOptions | ResearchBundleLike | null,
): DailyReportRendered {
  const { options, bundle } = resolveSecondArg(second);
  const rendererVersion = options.rendererVersion ?? 'render-1.0.0';
  const now = options.now ?? new Date();
  const weekend = isWeekendRun(result.as_of_trade_date, now);
  const view = buildView(result);
  const nowIso = options.now
    ? (typeof options.now === 'string' ? options.now : options.now.toISOString())
    : null;
  const { index: annotations, audit } = buildAnnotationIndex(bundle, new Set(result.holdings.map(row => row.ts_code)));
  const user = renderUser(result, weekend, annotations);
  const { text: technical, sections } = renderTechnical(result, view, rendererVersion, nowIso, bundle, annotations, audit);
  return { user, technical, attachment: sections };
}
