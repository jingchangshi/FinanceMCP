import type { DatabaseSync } from 'node:sqlite';
import type { MarketRegimeTier } from '../ashare/marketRegime.js';
import { ensurePortfolioV3Schema, inPortfolioTransaction, portfolioTableExists } from './db.js';

export type TrancheStatus = 'PENDING' | 'TRIGGERED' | 'EXECUTED' | 'SKIPPED';
export type TrancheTriggerReason =
  | 'MONTHLY_SCHEDULE'
  | 'REBOUND_8PCT'
  | 'BREAKDOWN_MA60'
  | 'BREAKDOWN_SUPPORT_FLOOR';

export interface DeconcentrationPlanRow {
  plan_id: string;
  account_id: string;
  ts_code: string;
  initial_shares: number;
  target_keep_bps: number;
  anchor_price_milli: number;
  support_floor_milli: number | null;
  last_exec_price_milli: number | null;
  last_exec_date: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  created_at: string;
}

export interface DeconcentrationTrancheRow {
  plan_id: string;
  tranche_no: number;
  planned_shares: number;
  status: TrancheStatus;
  trigger_date: string | null;
  trigger_reason: TrancheTriggerReason | null;
  executed_date: string | null;
  executed_price_milli: number | null;
}

export interface DeconcentrationEvaluation {
  schema: 'portfolio-deconcentration-plan/1.0';
  plan_present: boolean;
  account_id: string;
  ts_code: string;
  as_of_trade_date: string;
  plan_status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'UNINITIALIZED';
  initial_shares: number;
  current_shares: number;
  sellable_shares: number;
  target_keep_bps: number;
  target_keep_shares: number;
  reference_price_milli: number | null;
  reference_price_cny: number | null;
  rebound_trigger_milli: number | null;
  rebound_trigger_cny: number | null;
  support_floor_milli: number | null;
  support_floor_cny: number | null;
  ma60_cny: number | null;
  ma60_protect_milli: number | null;
  ma60_protect_cny: number | null;
  downside_protect_milli: number | null;
  downside_protect_cny: number | null;
  downside_protect_mode: 'MA60' | 'SUPPORT_FLOOR' | null;
  was_above_ma60_since_ref: boolean;
  breakdown_ma60_2d: boolean;
  next_monthly_trigger_date: string | null;
  trade_days_since_last: number | null;
  current_close_milli: number | null;
  recommended_sell_shares: number;
  active_trigger_reason: TrancheTriggerReason | null;
  tranches: DeconcentrationTrancheRow[];
  status_summary_zh: string;
  /** 仅供同日持久化写回的待更新批次。 */
  pending_mutations: {
    plan_updates: {
      plan_id: string;
      status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
      last_exec_price_milli: number | null;
      last_exec_date: string | null;
    } | null;
    tranche_updates: DeconcentrationTrancheRow[];
  };
}

export interface InitDeconcentrationPlanInput {
  plan_id?: string;
  account_id: string;
  ts_code: string;
  initial_shares: number;
  nav_cents: number;
  target_keep_bps?: number;
  anchor_price_milli: number;
  support_floor_milli?: number | null;
  total_tranches?: number;
  created_at: string;
}

const TRIGGER_REASON_ZH: Record<TrancheTriggerReason, string> = {
  MONTHLY_SCHEDULE: '月度时间保底窗口触发',
  REBOUND_8PCT: '自前次锚定价反弹满 +8% 加速兑现',
  BREAKDOWN_MA60: '空头防守期连续两日有效跌破60日均线保护减仓',
  BREAKDOWN_SUPPORT_FLOOR: '收盘跌破磨底箱体防守位保护减仓',
};

const TRANCHE_STATUS_ZH: Record<TrancheStatus, string> = {
  PENDING: '待触发',
  TRIGGERED: '已触发待执行',
  EXECUTED: '已执行',
  SKIPPED: '已跳过',
};

export function splitSharesIntoTranches(excessShares: number, totalTranches = 4): number[] {
  const safeLots = Math.max(0, Math.floor(excessShares / 100));
  const n = Math.max(1, totalTranches);
  const baseLots = Math.floor(safeLots / n);
  const remLots = safeLots % n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push((baseLots + (i < remLots ? 1 : 0)) * 100);
  }
  return out;
}

export function ensureDeconcentrationPlan(
  portfolioDb: DatabaseSync,
  input: InitDeconcentrationPlanInput,
): { created: boolean; plan: DeconcentrationPlanRow; tranches: DeconcentrationTrancheRow[] } {
  ensurePortfolioV3Schema(portfolioDb);
  const existing = portfolioDb.prepare(
    "SELECT * FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
  ).get(input.account_id, input.ts_code) as DeconcentrationPlanRow | undefined;

  if (existing) {
    const tranches = portfolioDb.prepare(
      'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
    ).all(existing.plan_id) as unknown as DeconcentrationTrancheRow[];
    return {
      created: false,
      plan: { ...existing, support_floor_milli: existing.support_floor_milli ?? null },
      tranches,
    };
  }

  const targetKeepBps = input.target_keep_bps ?? 1800;
  const totalTranches = input.total_tranches ?? 4;
  const priceCents = input.anchor_price_milli / 10;
  const targetKeepShares = priceCents > 0
    ? Math.floor(((input.nav_cents * (targetKeepBps / 10000)) / priceCents) / 100) * 100
    : 0;
  const excessShares = Math.max(0, Math.floor((input.initial_shares - targetKeepShares) / 100) * 100);
  const sharesPerTranche = splitSharesIntoTranches(excessShares, totalTranches);
  const planId = input.plan_id ?? `deconc-${input.account_id}-${input.ts_code.split('.')[0].toLowerCase()}-${input.created_at}`;

  const plan: DeconcentrationPlanRow = {
    plan_id: planId,
    account_id: input.account_id,
    ts_code: input.ts_code,
    initial_shares: input.initial_shares,
    target_keep_bps: targetKeepBps,
    anchor_price_milli: input.anchor_price_milli,
    support_floor_milli: input.support_floor_milli ?? null,
    last_exec_price_milli: null,
    last_exec_date: null,
    status: excessShares >= 100 ? 'ACTIVE' : 'COMPLETED',
    created_at: input.created_at,
  };
  const tranches: DeconcentrationTrancheRow[] = sharesPerTranche.map((qty, idx) => ({
    plan_id: planId,
    tranche_no: idx + 1,
    planned_shares: qty,
    status: qty >= 100 ? 'PENDING' : 'SKIPPED',
    trigger_date: null,
    trigger_reason: null,
    executed_date: null,
    executed_price_milli: null,
  }));

  inPortfolioTransaction(portfolioDb, () => {
    portfolioDb.prepare(`
      INSERT INTO deconcentration_plan (
        plan_id, account_id, ts_code, initial_shares, target_keep_bps,
        anchor_price_milli, support_floor_milli, last_exec_price_milli, last_exec_date, status, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      plan.plan_id, plan.account_id, plan.ts_code, plan.initial_shares, plan.target_keep_bps,
      plan.anchor_price_milli, plan.support_floor_milli, plan.last_exec_price_milli, plan.last_exec_date,
      plan.status, plan.created_at,
    );
    const ins = portfolioDb.prepare(`
      INSERT INTO deconcentration_tranche (
        plan_id, tranche_no, planned_shares, status, trigger_date,
        trigger_reason, executed_date, executed_price_milli
      ) VALUES (?,?,?,?,?,?,?,?)
    `);
    for (const t of tranches) {
      ins.run(t.plan_id, t.tranche_no, t.planned_shares, t.status, t.trigger_date, t.trigger_reason, t.executed_date, t.executed_price_milli);
    }
  });

  return { created: true, plan, tranches };
}

/** 人工校准减仓计划的磨底箱体防守位、基准锚定价或重置已触发未执行批次。 */
export function calibrateDeconcentrationPlan(
  portfolioDb: DatabaseSync,
  input: {
    account_id: string;
    ts_code?: string;
    support_floor_milli?: number | null;
    anchor_price_milli?: number;
    reset_triggered?: boolean;
  },
): {
  updated: boolean;
  plan_id: string;
  account_id: string;
  ts_code: string;
  support_floor_milli: number | null;
  anchor_price_milli: number;
  reset_tranche_nos: number[];
  tranches: DeconcentrationTrancheRow[];
} {
  ensurePortfolioV3Schema(portfolioDb);
  const tsCode = input.ts_code ?? '159558.SZ';
  const plan = portfolioDb.prepare(
    "SELECT * FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
  ).get(input.account_id, tsCode) as DeconcentrationPlanRow | undefined;
  if (!plan) {
    throw new Error(`未找到 ${input.account_id} / ${tsCode} 的有效四批换马减仓计划。`);
  }

  if (input.support_floor_milli !== undefined && input.support_floor_milli !== null) {
    if (!Number.isSafeInteger(input.support_floor_milli) || input.support_floor_milli <= 0) {
      throw new Error(`--support-floor-milli 需要正整数厘价或 null（收到 ${input.support_floor_milli}）`);
    }
  }
  if (input.anchor_price_milli !== undefined) {
    if (!Number.isSafeInteger(input.anchor_price_milli) || input.anchor_price_milli <= 0) {
      throw new Error(`--anchor-price-milli 需要正整数厘价（收到 ${input.anchor_price_milli}）`);
    }
  }

  const nextSupportFloor = input.support_floor_milli !== undefined
    ? input.support_floor_milli
    : (plan.support_floor_milli ?? null);
  const nextAnchorPrice = input.anchor_price_milli ?? plan.anchor_price_milli;
  const resetTrancheNos: number[] = [];

  inPortfolioTransaction(portfolioDb, () => {
    portfolioDb.prepare(`
      UPDATE deconcentration_plan
      SET support_floor_milli = ?, anchor_price_milli = ?
      WHERE plan_id = ?
    `).run(nextSupportFloor, nextAnchorPrice, plan.plan_id);

    if (input.reset_triggered !== false) {
      const triggeredRows = portfolioDb.prepare(
        "SELECT tranche_no FROM deconcentration_tranche WHERE plan_id = ? AND status = 'TRIGGERED' ORDER BY tranche_no ASC",
      ).all(plan.plan_id) as Array<{ tranche_no: number }>;
      for (const r of triggeredRows) resetTrancheNos.push(Number(r.tranche_no));
      if (resetTrancheNos.length > 0) {
        portfolioDb.prepare(`
          UPDATE deconcentration_tranche
          SET status = 'PENDING', trigger_date = NULL, trigger_reason = NULL
          WHERE plan_id = ? AND status = 'TRIGGERED'
        `).run(plan.plan_id);
      }
    }
  });

  const tranches = portfolioDb.prepare(
    'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
  ).all(plan.plan_id) as unknown as DeconcentrationTrancheRow[];

  return {
    updated: true,
    plan_id: plan.plan_id,
    account_id: plan.account_id,
    ts_code: plan.ts_code,
    support_floor_milli: nextSupportFloor,
    anchor_price_milli: nextAnchorPrice,
    reset_tranche_nos: resetTrancheNos,
    tranches,
  };
}

function computeEtfMa60Breakdown(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  refDate: string,
  asOf: string,
): { ma60Cny: number | null; ma60ProtectMilli: number | null; breakdown2d: boolean; wasAboveMa60SinceRef: boolean } {
  if (!marketDb || !portfolioTableExists(marketDb, 'fund_daily')) {
    return { ma60Cny: null, ma60ProtectMilli: null, breakdown2d: false, wasAboveMa60SinceRef: false };
  }
  const bars = (marketDb.prepare(
    'SELECT trade_date, close FROM fund_daily WHERE ts_code = ? AND trade_date <= ? AND close > 0 ORDER BY trade_date DESC LIMIT 140',
  ).all(tsCode, asOf) as { trade_date: string; close: number }[]).reverse();
  if (bars.length < 61) return { ma60Cny: null, ma60ProtectMilli: null, breakdown2d: false, wasAboveMa60SinceRef: false };

  const adjMap = new Map<string, number>();
  if (portfolioTableExists(marketDb, 'fund_adj')) {
    const startDate = bars[0].trade_date;
    const adjRows = marketDb.prepare(
      'SELECT trade_date, adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date ASC',
    ).all(tsCode, startDate, asOf) as { trade_date: string; adj_factor: number }[];
    for (const r of adjRows) {
      if (Number(r.adj_factor) > 0) adjMap.set(String(r.trade_date), Number(r.adj_factor));
    }
  }

  let carryAdj = 1;
  const adjs = bars.map(bar => {
    const found = adjMap.get(bar.trade_date);
    if (found && found > 0) carryAdj = found;
    return carryAdj;
  });
  const baseAdj = adjs[adjs.length - 1] || 1;
  const qfqCloses = bars.map((bar, i) => Number(bar.close) * (adjs[i] / baseAdj));

  const meanAt = (endIdx: number): number | null => {
    if (endIdx < 59) return null;
    let s = 0;
    for (let i = endIdx - 59; i <= endIdx; i += 1) s += qfqCloses[i];
    return s / 60;
  };

  const t = qfqCloses.length - 1;
  const ma60T = meanAt(t);
  const ma60Prev = meanAt(t - 1);
  if (ma60T === null || ma60Prev === null) {
    return { ma60Cny: null, ma60ProtectMilli: null, breakdown2d: false, wasAboveMa60SinceRef: false };
  }

  // 仅当自基准日（含当日）以来站上过 MA60*0.985 时，后续跌破才视为“高位新破位”。
  const idxAtOrAfter = bars.findIndex((b, idx) => idx >= 59 && b.trade_date >= refDate);
  const startCheckIdx = idxAtOrAfter === -1
    ? t
    : (idxAtOrAfter > 59 && bars[idxAtOrAfter].trade_date > refDate ? idxAtOrAfter - 1 : idxAtOrAfter);
  let wasAboveMa60SinceRef = false;
  for (let idx = startCheckIdx; idx <= t; idx += 1) {
    const m = meanAt(idx);
    if (m !== null && qfqCloses[idx] >= m * 0.985) {
      wasAboveMa60SinceRef = true;
      break;
    }
  }

  const breakdown2d = qfqCloses[t] < ma60T * 0.985 && qfqCloses[t - 1] < ma60Prev * 0.985;
  return {
    ma60Cny: Math.round(ma60T * 1000) / 1000,
    ma60ProtectMilli: Math.round(ma60T * 0.985 * 1000),
    breakdown2d,
    wasAboveMa60SinceRef,
  };
}

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const dt = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + deltaDays));
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

function resolveCalendarSchedule(
  marketDb: DatabaseSync | null | undefined,
  refDate: string,
  asOf: string,
): { isFirstTradeDayOfMonth: boolean; tradeDaysSinceLast: number; nextMonthlyTriggerDate: string | null } {
  if (!marketDb || !portfolioTableExists(marketDb, 'trade_cal')) {
    const gap = Math.max(0, Math.round(
      (Date.UTC(+asOf.slice(0, 4), +asOf.slice(4, 6) - 1, +asOf.slice(6, 8))
       - Date.UTC(+refDate.slice(0, 4), +refDate.slice(4, 6) - 1, +refDate.slice(6, 8))) / 86400_000,
    ));
    return {
      isFirstTradeDayOfMonth: asOf.slice(6, 8) === '01',
      tradeDaysSinceLast: Math.round(gap * 5 / 7),
      nextMonthlyTriggerDate: null,
    };
  }

  const calRows = marketDb.prepare(
    'SELECT cal_date FROM trade_cal WHERE is_open = 1 AND cal_date >= ? AND cal_date <= ? ORDER BY cal_date ASC',
  ).all(refDate.slice(0, 6) + '01', addCalendarDaysYmd(asOf, 90)) as { cal_date: string }[];

  const monthFirst = new Map<string, string>();
  for (const r of calRows) {
    const ym = r.cal_date.slice(0, 6);
    if (!monthFirst.has(ym)) monthFirst.set(ym, r.cal_date);
  }

  const isFirstTradeDayOfMonth = monthFirst.get(asOf.slice(0, 6)) === asOf;
  const tradeDaysSinceLast = calRows.filter(r => r.cal_date > refDate && r.cal_date <= asOf).length;

  let nextMonthlyTriggerDate: string | null = null;
  for (const [, firstDay] of [...monthFirst.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (firstDay <= asOf) continue;
    const dist = calRows.filter(r => r.cal_date > refDate && r.cal_date <= firstDay).length;
    if (dist >= 12) {
      nextMonthlyTriggerDate = firstDay;
      break;
    }
  }

  return { isFirstTradeDayOfMonth, tradeDaysSinceLast, nextMonthlyTriggerDate };
}

function fmtYmdZh(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{8}$/.test(ymd)) return '待日历顺延';
  return `${ymd.slice(0, 4)}年${Number(ymd.slice(4, 6))}月${Number(ymd.slice(6, 8))}日`;
}

function uninitializedEvaluation(
  accountId: string,
  tsCode: string,
  asOf: string,
  currentShares: number,
  sellableShares: number,
  currentCloseMilli: number | null,
): DeconcentrationEvaluation {
  return {
    schema: 'portfolio-deconcentration-plan/1.0',
    plan_present: false,
    account_id: accountId,
    ts_code: tsCode,
    as_of_trade_date: asOf,
    plan_status: 'UNINITIALIZED',
    initial_shares: currentShares,
    current_shares: currentShares,
    sellable_shares: sellableShares,
    target_keep_bps: 1800,
    target_keep_shares: 0,
    reference_price_milli: currentCloseMilli,
    reference_price_cny: currentCloseMilli !== null ? currentCloseMilli / 1000 : null,
    rebound_trigger_milli: currentCloseMilli !== null ? Math.round(currentCloseMilli * 1.08) : null,
    rebound_trigger_cny: currentCloseMilli !== null ? Math.round(currentCloseMilli * 1.08) / 1000 : null,
    support_floor_milli: null,
    support_floor_cny: null,
    ma60_cny: null,
    ma60_protect_milli: null,
    ma60_protect_cny: null,
    downside_protect_milli: null,
    downside_protect_cny: null,
    downside_protect_mode: null,
    was_above_ma60_since_ref: false,
    breakdown_ma60_2d: false,
    next_monthly_trigger_date: null,
    trade_days_since_last: null,
    current_close_milli: currentCloseMilli,
    recommended_sell_shares: 0,
    active_trigger_reason: null,
    tranches: [],
    status_summary_zh: `${tsCode} 尚未建立四批换马减仓计划。`,
    pending_mutations: { plan_updates: null, tranche_updates: [] },
  };
}

export function evaluateDeconcentrationPlan(input: {
  portfolioDb?: DatabaseSync | null;
  marketDb?: DatabaseSync | null;
  accountId: string;
  tsCode?: string;
  asOf: string;
  currentShares: number;
  sellableShares: number;
  currentCloseMilli: number | null;
  navCents?: number;
  marketRegime: MarketRegimeTier;
}): DeconcentrationEvaluation {
  const tsCode = input.tsCode ?? '159558.SZ';
  if (
    !input.portfolioDb
    || !portfolioTableExists(input.portfolioDb, 'deconcentration_plan')
    || !portfolioTableExists(input.portfolioDb, 'deconcentration_tranche')
  ) {
    return uninitializedEvaluation(
      input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
    );
  }

  const plan = input.portfolioDb.prepare(
    "SELECT * FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1",
  ).get(input.accountId, tsCode) as DeconcentrationPlanRow | undefined;

  if (!plan) {
    return uninitializedEvaluation(
      input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
    );
  }

  const rawTranches = input.portfolioDb.prepare(
    'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
  ).all(plan.plan_id) as unknown as DeconcentrationTrancheRow[];
  const tranches = rawTranches.map(row => ({ ...row }));
  const updatedTranches: DeconcentrationTrancheRow[] = [];

  let lastExecPriceMilli = plan.last_exec_price_milli;
  let lastExecDate = plan.last_exec_date;
  let planStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' = plan.status;
  let planMutated = false;

  // 1) 状态闭环核对：根据当前持仓份额与最近卖出流水，推进已完成的批次为 EXECUTED。
  const sellEvent = portfolioTableExists(input.portfolioDb, 'account_event')
    ? (input.portfolioDb.prepare(
      "SELECT occurred_on, price_milli FROM account_event WHERE account_id = ? AND ts_code = ? AND event_type IN ('TRADE_SELL', 'SELL') AND occurred_on >= ? AND occurred_on <= ? AND reversed_by IS NULL ORDER BY occurred_on DESC, rowid DESC LIMIT 1",
    ).get(input.accountId, tsCode, plan.created_at, input.asOf) as { occurred_on?: string; price_milli?: number } | undefined)
    : undefined;

  let cumulativePlanned = 0;
  for (const t of tranches) {
    if (t.status === 'SKIPPED') continue;
    cumulativePlanned += t.planned_shares;
    const expectedAfterTranche = Math.max(0, plan.initial_shares - cumulativePlanned);
    if ((t.status === 'PENDING' || t.status === 'TRIGGERED') && input.currentShares <= expectedAfterTranche) {
      t.status = 'EXECUTED';
      t.executed_date = sellEvent?.occurred_on ?? input.asOf;
      t.executed_price_milli = sellEvent?.price_milli ?? input.currentCloseMilli ?? t.executed_price_milli;
      updatedTranches.push({ ...t });
      if (!lastExecDate || (t.executed_date && t.executed_date >= lastExecDate)) {
        lastExecDate = t.executed_date;
        if (t.executed_price_milli !== null) lastExecPriceMilli = t.executed_price_milli;
        planMutated = true;
      }
    }
  }

  const totalPlannedSell = tranches.filter(t => t.status !== 'SKIPPED').reduce((s, t) => s + t.planned_shares, 0);
  const targetKeepShares = Math.max(0, plan.initial_shares - totalPlannedSell);
  const weightBps = input.navCents && input.navCents > 0 && input.currentCloseMilli !== null
    ? Math.round(((input.currentShares * (input.currentCloseMilli / 10)) / input.navCents) * 10000)
    : null;
  const allClosed = tranches.every(t => t.status === 'EXECUTED' || t.status === 'SKIPPED');
  if (allClosed || (weightBps !== null && weightBps <= plan.target_keep_bps && tranches.some(t => t.status === 'EXECUTED'))) {
    if (planStatus !== 'COMPLETED') {
      planStatus = 'COMPLETED';
      planMutated = true;
    }
  }

  const refDate = lastExecDate ?? plan.created_at;
  const refPriceMilli = lastExecPriceMilli ?? plan.anchor_price_milli;
  const reboundTriggerMilli = Math.round(refPriceMilli * 1.08);
  const supportFloorMilli = plan.support_floor_milli ?? null;
  const ma60Info = computeEtfMa60Breakdown(input.marketDb, tsCode, refDate, input.asOf);
  const schedule = resolveCalendarSchedule(input.marketDb, refDate, input.asOf);

  const downsideMode: 'MA60' | 'SUPPORT_FLOOR' | null =
    ma60Info.wasAboveMa60SinceRef && ma60Info.ma60ProtectMilli !== null
      ? 'MA60'
      : supportFloorMilli !== null
        ? 'SUPPORT_FLOOR'
        : null;
  const downsideProtectMilli = downsideMode === 'MA60'
    ? ma60Info.ma60ProtectMilli
    : downsideMode === 'SUPPORT_FLOOR'
      ? supportFloorMilli
      : null;

  // 2) 仅在 plan 处于 ACTIVE 时检查触发规则（C -> B -> A）。
  if (planStatus === 'ACTIVE') {
    const alreadyTriggered = tranches.filter(t => t.status === 'TRIGGERED');
    if (alreadyTriggered.length === 0) {
      const pending = tranches.filter(t => t.status === 'PENDING');
      if (pending.length > 0) {
        if (input.marketRegime === 'DEFENSIVE' && ma60Info.wasAboveMa60SinceRef && ma60Info.breakdown2d) {
          const protectCount = Math.max(1, Math.ceil(pending.length / 2));
          for (const item of pending.slice(0, protectCount)) {
            item.status = 'TRIGGERED';
            item.trigger_date = input.asOf;
            item.trigger_reason = 'BREAKDOWN_MA60';
            updatedTranches.push({ ...item });
          }
        } else if (
          !ma60Info.wasAboveMa60SinceRef
          && supportFloorMilli !== null
          && input.currentCloseMilli !== null
          && input.currentCloseMilli < supportFloorMilli
          && input.marketRegime !== 'OFFENSIVE'
        ) {
          const protectCount = Math.max(1, Math.ceil(pending.length / 2));
          for (const item of pending.slice(0, protectCount)) {
            item.status = 'TRIGGERED';
            item.trigger_date = input.asOf;
            item.trigger_reason = 'BREAKDOWN_SUPPORT_FLOOR';
            updatedTranches.push({ ...item });
          }
        } else if (input.currentCloseMilli !== null && input.currentCloseMilli >= reboundTriggerMilli) {
          const first = pending[0];
          first.status = 'TRIGGERED';
          first.trigger_date = input.asOf;
          first.trigger_reason = 'REBOUND_8PCT';
          updatedTranches.push({ ...first });
        } else if (schedule.isFirstTradeDayOfMonth && schedule.tradeDaysSinceLast >= 12) {
          const first = pending[0];
          first.status = 'TRIGGERED';
          first.trigger_date = input.asOf;
          first.trigger_reason = 'MONTHLY_SCHEDULE';
          updatedTranches.push({ ...first });
        }
      }
    }
  }

  const triggered = tranches.filter(t => t.status === 'TRIGGERED');
  const rawSellShares = triggered.reduce((sum, t) => sum + t.planned_shares, 0);
  const maxSellableLots = Math.floor(Math.max(0, input.sellableShares) / 100) * 100;
  const recommendedSellShares = Math.min(rawSellShares, maxSellableLots);
  const activeReason = triggered[0]?.trigger_reason ?? null;

  const execCount = tranches.filter(t => t.status === 'EXECUTED').length;
  const trigNos = triggered.map(t => `第${t.tranche_no}批`).join('、');
  const statusSummaryZh = planStatus === 'COMPLETED'
    ? `${tsCode} 四批换马减仓已全部达标完成（现持 ${input.currentShares} 份）。`
    : triggered.length > 0
      ? `${tsCode} 已触发${trigNos}减仓（${TRIGGER_REASON_ZH[activeReason ?? 'MONTHLY_SCHEDULE']}），建议卖出 ${recommendedSellShares} 份。`
      : downsideMode === 'SUPPORT_FLOOR' && downsideProtectMilli !== null
        ? `${tsCode} 四批换马已执行 ${execCount}/${tranches.length} 批（磨底观察中）；下一观察条件：反弹至 ${(reboundTriggerMilli / 1000).toFixed(3)} 元、跌破箱体防守位 ${(downsideProtectMilli / 1000).toFixed(3)} 元或月度窗口 ${fmtYmdZh(schedule.nextMonthlyTriggerDate)}。`
        : `${tsCode} 四批换马已执行 ${execCount}/${tranches.length} 批；下一观察条件：月度窗口 ${schedule.nextMonthlyTriggerDate ?? '待日历顺延'} 或反弹至 ${(reboundTriggerMilli / 1000).toFixed(3)} 元。`;

  return {
    schema: 'portfolio-deconcentration-plan/1.0',
    plan_present: true,
    account_id: input.accountId,
    ts_code: tsCode,
    as_of_trade_date: input.asOf,
    plan_status: planStatus,
    initial_shares: plan.initial_shares,
    current_shares: input.currentShares,
    sellable_shares: input.sellableShares,
    target_keep_bps: plan.target_keep_bps,
    target_keep_shares: targetKeepShares,
    reference_price_milli: refPriceMilli,
    reference_price_cny: refPriceMilli / 1000,
    rebound_trigger_milli: reboundTriggerMilli,
    rebound_trigger_cny: reboundTriggerMilli / 1000,
    support_floor_milli: supportFloorMilli,
    support_floor_cny: supportFloorMilli !== null ? supportFloorMilli / 1000 : null,
    ma60_cny: ma60Info.ma60Cny,
    ma60_protect_milli: ma60Info.ma60ProtectMilli,
    ma60_protect_cny: ma60Info.ma60ProtectMilli !== null ? ma60Info.ma60ProtectMilli / 1000 : null,
    downside_protect_milli: downsideProtectMilli,
    downside_protect_cny: downsideProtectMilli !== null ? downsideProtectMilli / 1000 : null,
    downside_protect_mode: downsideMode,
    was_above_ma60_since_ref: ma60Info.wasAboveMa60SinceRef,
    breakdown_ma60_2d: ma60Info.breakdown2d,
    next_monthly_trigger_date: schedule.nextMonthlyTriggerDate,
    trade_days_since_last: schedule.tradeDaysSinceLast,
    current_close_milli: input.currentCloseMilli,
    recommended_sell_shares: recommendedSellShares,
    active_trigger_reason: activeReason,
    tranches,
    status_summary_zh: statusSummaryZh,
    pending_mutations: {
      plan_updates: planMutated ? {
        plan_id: plan.plan_id,
        status: planStatus,
        last_exec_price_milli: lastExecPriceMilli,
        last_exec_date: lastExecDate,
      } : null,
      tranche_updates: updatedTranches,
    },
  };
}

export function persistDeconcentrationUpdates(
  portfolioDb: DatabaseSync | null | undefined,
  evaluation: DeconcentrationEvaluation,
): number {
  if (!portfolioDb || !evaluation.plan_present) return 0;
  const { plan_updates, tranche_updates } = evaluation.pending_mutations;
  if (!plan_updates && tranche_updates.length === 0) return 0;
  if (!portfolioTableExists(portfolioDb, 'deconcentration_plan') || !portfolioTableExists(portfolioDb, 'deconcentration_tranche')) {
    return 0;
  }
  try {
    let changed = 0;
    inPortfolioTransaction(portfolioDb, () => {
      if (plan_updates) {
        portfolioDb.prepare(`
          UPDATE deconcentration_plan
          SET status = ?, last_exec_price_milli = ?, last_exec_date = ?
          WHERE plan_id = ?
        `).run(plan_updates.status, plan_updates.last_exec_price_milli, plan_updates.last_exec_date, plan_updates.plan_id);
        changed += 1;
      }
      const stmt = portfolioDb.prepare(`
        UPDATE deconcentration_tranche
        SET status = ?, trigger_date = ?, trigger_reason = ?, executed_date = ?, executed_price_milli = ?
        WHERE plan_id = ? AND tranche_no = ?
      `);
      for (const t of tranche_updates) {
        stmt.run(t.status, t.trigger_date, t.trigger_reason, t.executed_date, t.executed_price_milli, t.plan_id, t.tranche_no);
        changed += 1;
      }
    });
    return changed;
  } catch (err: any) {
    if (String(err?.message ?? err).includes('readonly')) return 0;
    throw err;
  }
}

export function formatTrancheStatusZh(status: TrancheStatus): string {
  return TRANCHE_STATUS_ZH[status];
}
