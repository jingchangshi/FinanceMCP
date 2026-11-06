/**
 * Technical methodology V2 — stock-level research aggregation (goal-1102 §四.2).
 *
 * The five families each answer "what price behaviour is visible?". This
 * module answers the only question a daily report may ask per stock: *what is
 * this stock's single research state today, and why?*
 *
 * Determinism: the state is decided by the ordered rules below, never by an
 * LLM and never by a cross-family score. Every stock that has at least one
 * signal gets exactly one record; the same input always produces the same
 * output and the same order.
 *
 * Order of decisions:
 *   1. BLOCKED        — same-day trading/data facts make a normal reading
 *                       impossible (suspended, no as-of bar, stale bar,
 *                       one-price limit-down, unknown limit).
 *   2. INVALIDATED    — every signal episode is dead (FAILED / EXPIRED).
 *   3. DETERIORATING  — NEW negative evidence of the SAME family is dated
 *                       AFTER the latest live confirmation. A failure or an
 *                       expiry that predates the live setup is history: it
 *                       stays in `signals` for audit but never negates the
 *                       live reading. EXPIRED never triggers DETERIORATING.
 *   4. EXTENDED       — the setup holds but price has run: RAPID_RUNUP or a
 *                       live signal's `price_extension` (close >= MA20 + 3 ATR14).
 *   5. FOCUS          — a live, research-ready confirmation and normal trading.
 *   6. WATCH          — forming only, or a live setup the account cannot
 *                       execute at normal prices (limit-up / non-mainboard).
 *
 * What this module deliberately does NOT do: no probability, no target price,
 * no position size, no implied order. `FOCUS` means "worth reading first".
 */
import {
  FAMILY_LABELS, RESEARCH_STATE_LABELS, RESEARCH_STATE_ORDER,
  type PatternObservation, type PriceVolumeContext, type ResearchSignalView,
  type ResearchState, type ResearchStockView, type ResearchUniverseV2,
  type TechnicalCandidateV2, type TechnicalStage, type TechnicalViewV2,
} from './technicalFrameworkV2.js';
import { tradePermissionOf } from './hotspotTypes.js';

const LIVE_STAGES: TechnicalStage[] = ['CONFIRMED', 'FOLLOW_THROUGH'];

/** Stage rank used only to select the primary signal (confirmed first). */
const SIGNAL_ORDER: Record<TechnicalStage, number> = {
  CONFIRMED: 0, FOLLOW_THROUGH: 1, FORMING: 2, FAILED: 3, EXPIRED: 4,
};

const isLive = (s: TechnicalCandidateV2): boolean => LIVE_STAGES.includes(s.stage);

function toSignalView(s: TechnicalCandidateV2): ResearchSignalView {
  return {
    strategy_id: s.strategy_id,
    family: s.family,
    family_label: FAMILY_LABELS[s.family],
    stage: s.stage,
    stage_detail: s.stage_detail,
    pattern_event_date: s.pattern_event_date,
    first_observed_date: s.first_observed_date,
    confirmed_on: s.confirmed_on,
    invalidated_at: s.invalidated_at,
    expires_at: s.expires_at,
    confirmation_conditions: s.confirmation_conditions,
    invalidation_conditions: s.invalidation_conditions,
    key_levels: s.key_levels,
    evidence: s.evidence,
    counter_evidence: s.counter_evidence,
    price_position: s.price_position,
  };
}

function signalLabel(s: Pick<PatternObservation, 'family' | 'strategy_id' | 'stage_detail'>): string {
  return `${FAMILY_LABELS[s.family]}·${s.stage_detail}`;
}

/** Facts that argue against the reading, drawn from the shared price/volume layer. */
function contextCounterEvidence(ctx: PriceVolumeContext): string[] {
  const out: string[] = [];
  if (ctx.price_volume_tags.includes('LONG_UPPER_SHADOW')) out.push('长上影：上方存在抛压');
  if (ctx.price_volume_tags.includes('VOLUME_CONTRACTION')) out.push('成交量低于 20 日均量的 0.6 倍：量能萎缩');
  if (ctx.price_volume_tags.includes('RAPID_RUNUP')) out.push('近 5 日涨幅 ≥15%：短期急涨，位置风险上升');
  if (ctx.price_volume_tags.includes('SHARP_REVERSAL')) out.push('近一日急涨/急跌与 5 日方向相反：波动放大');
  if (ctx.market_regime === 'downtrend') out.push('市场环境为下跌：个股形态需按逆势环境解读');
  return out;
}

interface Decision {
  state: ResearchState;
  decisive: string[];
  conflicting: string[];
  constraints: string[];
}

/**
 * The ordered state machine. Inputs are already dated facts; this function
 * only applies the documented precedence.
 */
function decideState(
  ctx: PriceVolumeContext,
  signals: TechnicalCandidateV2[],
  permission: 'EXECUTABLE' | 'RESEARCH_ONLY',
): Decision {
  const live = signals.filter(isLive);
  const forming = signals.filter(s => s.stage === 'FORMING');
  const failed = signals.filter(s => s.stage === 'FAILED');
  const expired = signals.filter(s => s.stage === 'EXPIRED');
  const constraints: string[] = [];
  const decisive: string[] = [];
  const conflicting: string[] = [];

  // 1. Same-day trading/data limits. These are facts, never offset by a pattern.
  const status = ctx.trading_status;
  if (status === 'SUSPENDED') {
    return { state: 'BLOCKED', decisive: ['as-of 日停牌：没有当日可交易价格'], conflicting: [], constraints: ['SUSPENDED'] };
  }
  if (status === 'NO_BAR') {
    return { state: 'BLOCKED', decisive: ['as-of 日无 K 线且无停牌记录：按缺数处理'], conflicting: [], constraints: ['NO_BAR'] };
  }
  if (ctx.bars_behind_as_of > 0) {
    return {
      state: 'BLOCKED',
      decisive: [`最后一根 K 线为 ${ctx.bars_behind_as_of} 个交易日前，不能充作 as-of 当日`],
      conflicting: [], constraints: ['STALE_BAR'],
    };
  }
  if (status === 'ONE_PRICE_LIMIT_DOWN') {
    return {
      state: 'BLOCKED',
      decisive: ['as-of 日一字跌停：价格风险优先于形态距离，历史形态保留但不进入当日研究重点'],
      conflicting: [], constraints: ['ONE_PRICE_LIMIT_DOWN'],
    };
  }
  if (status === 'LIMIT_UNKNOWN') {
    return { state: 'BLOCKED', decisive: ['一字 K 线但缺少涨跌停价：交易约束未知'], conflicting: [], constraints: ['LIMIT_UNKNOWN'] };
  }
  if (status === 'ONE_PRICE_LIMIT_UP') constraints.push('ONE_PRICE_LIMIT_UP');
  if (permission === 'RESEARCH_ONLY') constraints.push('RESEARCH_ONLY');

  // 2. Dead episodes.
  if (live.length === 0 && forming.length === 0) {
    const last = [...failed, ...expired].sort((a, b) =>
      (b.invalidated_at ?? b.expires_at ?? '').localeCompare(a.invalidated_at ?? a.expires_at ?? ''))[0];
    if (failed.length > 0) {
      return {
        state: 'INVALIDATED',
        decisive: failed.map(s => `${signalLabel(s)} 于 ${s.invalidated_at ?? '未标注日期'} 失效：${s.invalidation?.reason ?? '触发失效条件'}`),
        conflicting: [], constraints,
      };
    }
    return {
      state: 'INVALIDATED',
      decisive: [`全部形态观察已过期（最近一次 ${last?.expires_at ?? '未标注日期'}），不再构成当前研究依据`],
      conflicting: [], constraints,
    };
  }

  // 3. ONLY current negative evidence can contradict a live setup: a FAILED
  //    instance of the SAME family dated strictly after the latest live
  //    confirmation. Earlier failures are history (the live setup already
  //    superseded them) and an EXPIRED window is observation-window end, not
  //    current negative evidence. Both stay in `signals` for audit.
  if (live.length > 0) {
    // Compare inside the family: a REVERSAL failure is evidence about the
    // REVERSAL setup, not about a later confirmation from another family.
    const familyLiveConfirm = (family: string): string => live.reduce(
      (m, s) => (s.family === family && s.confirmed_on && s.confirmed_on > m ? s.confirmed_on : m), '',
    );
    const currentFailures = failed.filter((f) => {
      const liveConfirm = familyLiveConfirm(f.family);
      return f.invalidated_at !== null && liveConfirm !== '' && f.invalidated_at > liveConfirm;
    });
    if (currentFailures.length > 0) {
      for (const s of live) {
        decisive.push(`${signalLabel(s)}（${s.strategy_id}）于 ${s.confirmed_on ?? '未标注日期'} 确认`);
      }
      for (const f of currentFailures) {
        conflicting.push(`${signalLabel(f)}（${f.strategy_id}）于 ${f.invalidated_at} 失效，`
          + `晚于同族当前有效形态确认日 ${familyLiveConfirm(f.family)}：`
          + `${f.invalidation?.reason ?? '触发失效条件'}`);
      }
      return { state: 'DETERIORATING', decisive, conflicting, constraints };
    }
  }

  // 4. Position risk: the setup holds, but the price has already run.
  if (live.length > 0) {
    const extended = live.filter(s => s.price_position?.price_extension === true);
    if (extended.length > 0 || ctx.price_volume_tags.includes('RAPID_RUNUP')) {
      for (const s of live) {
        decisive.push(`${signalLabel(s)}（${s.strategy_id}）于 ${s.confirmed_on ?? '未标注日期'} 确认`);
      }
      for (const s of extended) {
        const atr = s.price_position?.close_vs_ma20_atr;
        const close = s.price_position?.close;
        const ma20 = s.price_position?.ma20;
        decisive.push(`价格延伸：${signalLabel(s)} 收盘 ${close} 距 MA20 ${ma20} 为 ${atr} 倍 ATR14`
          + '（固定研究假设阈值 3.0，未经验证收益优势）');
      }
      if (ctx.price_volume_tags.includes('RAPID_RUNUP')) {
        decisive.push('近 5 日涨幅 ≥15%：短期急涨，位置风险上升');
      }
      return { state: 'EXTENDED', decisive, conflicting, constraints };
    }
  }

  // 5/6. FOCUS needs a live confirmation, a tradable day and an executable name.
  if (live.length > 0) {
    for (const s of live) decisive.push(`${signalLabel(s)} 于 ${s.confirmed_on ?? '未标注日期'} 确认`);
    if (status === 'ONE_PRICE_LIMIT_UP') {
      return {
        state: 'WATCH',
        decisive: [...decisive, '一字涨停：无法按常规价格成交，不按无风险高优先级处理'],
        conflicting, constraints,
      };
    }
    if (permission === 'RESEARCH_ONLY') {
      return {
        state: 'WATCH',
        decisive: [...decisive, '非主板标的：研究可用，账户范围不可成交'],
        conflicting, constraints,
      };
    }
    return { state: 'FOCUS', decisive, conflicting, constraints };
  }

  // Forming only: an unconfirmed observation is never FOCUS.
  for (const s of forming) decisive.push(`${signalLabel(s)} 仍在形成，尚无确认价格行为`);
  return { state: 'WATCH', decisive, conflicting, constraints };
}

function watchConditions(state: ResearchState, signals: TechnicalCandidateV2[]): string[] {
  const primary = [...signals].sort((a, b) =>
    (SIGNAL_ORDER[a.stage] - SIGNAL_ORDER[b.stage]) || a.strategy_id.localeCompare(b.strategy_id))[0];
  if (!primary) return [];
  if (state === 'WATCH' || state === 'BLOCKED') {
    return primary.confirmation_conditions.length ? primary.confirmation_conditions : primary.invalidation_conditions;
  }
  return primary.invalidation_conditions;
}

function buildStock(
  ctx: PriceVolumeContext,
  signals: TechnicalCandidateV2[],
  sectors: string[],
): ResearchStockView {
  const sorted = [...signals].sort((a, b) =>
    (SIGNAL_ORDER[a.stage] - SIGNAL_ORDER[b.stage])
    || a.family.localeCompare(b.family)
    || a.strategy_id.localeCompare(b.strategy_id));
  const perm = tradePermissionOf(ctx.ts_code);
  const decision = decideState(ctx, sorted, perm.perm);
  const primary = sorted[0] ?? null;

  const counter = [...new Set([
    ...sorted.flatMap(s => s.counter_evidence),
    ...contextCounterEvidence(ctx),
  ])];

  return {
    ts_code: ctx.ts_code,
    name: ctx.name,
    as_of_trade_date: ctx.as_of,
    trade_date: ctx.trade_date,
    bars_behind_as_of: ctx.bars_behind_as_of,
    research_state: decision.state,
    research_state_label: RESEARCH_STATE_LABELS[decision.state],
    primary_family: primary?.family ?? null,
    primary_pattern: primary?.stage_detail ?? null,
    price_position: primary?.price_position ?? null,
    signals: sorted.map(toSignalView),
    decisive_reasons: decision.decisive,
    conflicting_evidence: decision.conflicting,
    counter_evidence: counter,
    watch_conditions: watchConditions(decision.state, sorted),
    trading_constraints: decision.constraints,
    trading_status: ctx.trading_status,
    price_volume_tags: ctx.price_volume_tags,
    sectors,
    market_regime: ctx.market_regime,
    rps120: ctx.rps120,
    research_ready: decision.state === 'FOCUS',
    evidence_level: 'UNVERIFIED',
    trade_permission: perm.perm,
    trade_permission_reason: perm.reason,
  };
}

const HIGHLIGHT_CAP = 5;

/**
 * Aggregate every signal into one record per stock. Stocks appear once even
 * when all five families list them; the signals array keeps every episode.
 */
export function buildResearchUniverse(
  view: Pick<TechnicalViewV2, 'as_of' | 'contexts' | 'families'>,
  sectorByCode: Map<string, string[]> = new Map(),
): ResearchUniverseV2 {
  const byCode = new Map<string, TechnicalCandidateV2[]>();
  for (const family of view.families) {
    for (const c of family.candidates) {
      const list = byCode.get(c.ts_code);
      if (list) list.push(c);
      else byCode.set(c.ts_code, [c]);
    }
  }
  const ctxByCode = new Map(view.contexts.map(c => [c.ts_code, c]));

  const stocks: ResearchStockView[] = [];
  for (const [code, signals] of byCode) {
    const ctx = ctxByCode.get(code);
    if (!ctx) continue; // every candidate has a context by construction
    stocks.push(buildStock(ctx, signals, sectorByCode.get(code) ?? []));
  }
  stocks.sort((a, b) =>
    (RESEARCH_STATE_ORDER[a.research_state] - RESEARCH_STATE_ORDER[b.research_state])
    || (b.signals[0]?.confirmed_on ?? '').localeCompare(a.signals[0]?.confirmed_on ?? '')
    || a.ts_code.localeCompare(b.ts_code));

  const counts = { FOCUS: 0, WATCH: 0, EXTENDED: 0, DETERIORATING: 0, BLOCKED: 0, INVALIDATED: 0, total: stocks.length };
  for (const s of stocks) counts[s.research_state]++;

  // Highlights: FOCUS first, then WATCH; at most five, never padded.
  const highlights = [
    ...stocks.filter(s => s.research_state === 'FOCUS'),
    ...stocks.filter(s => s.research_state === 'WATCH'),
  ].slice(0, HIGHLIGHT_CAP).map(s => s.ts_code);

  return { as_of: view.as_of, counts, stocks, daily_highlights: highlights };
}

/** The stock a human report should read first, or null when nothing qualifies. */
export function highlightStocks(universe: ResearchUniverseV2): ResearchStockView[] {
  const byCode = new Map(universe.stocks.map(s => [s.ts_code, s]));
  return universe.daily_highlights.map(code => byCode.get(code)).filter((s): s is ResearchStockView => !!s);
}
