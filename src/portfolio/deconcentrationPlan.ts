import type { DatabaseSync } from 'node:sqlite';
import type { MarketRegimeTier } from '../ashare/marketRegime.js';
import { ensurePortfolioV3Schema, inPortfolioTransaction, portfolioTableExists } from './db.js';

export type TrancheStatus = 'PENDING' | 'TRIGGERED' | 'EXECUTED' | 'SKIPPED';
export type DeconcentrationPlanMode = 'STANDARD' | 'BOTTOM_GRIND_25';
export type TrancheTriggerReason =
  | 'MONTHLY_SCHEDULE'
  | 'REBOUND_8PCT'
  | 'BREAKDOWN_MA60'
  | 'BREAKDOWN_SUPPORT_FLOOR'
  | 'GRIND_OVERSOLD_RELOAD'
  | 'GRIND_TACTICAL_TAKE_PROFIT'
  | 'GRIND_OVERWEIGHT_DRIFT_HARVEST';

export interface DeconcentrationPlanRow {
  plan_id: string;
  account_id: string;
  ts_code: string;
  initial_shares: number;
  target_keep_bps: number;
  anchor_price_milli: number;
  /** 原始锚定价对应的价格基准交易日（YYYYMMDD）；NULL 表示历史计划未记录，绝不从 created_at 回填。 */
  anchor_trade_date: string | null;
  support_floor_milli: number | null;
  last_exec_price_milli: number | null;
  last_exec_date: string | null;
  plan_mode: DeconcentrationPlanMode;
  tactical_slot_bps: number;
  tactical_shares: number;
  tactical_entry_price_milli: number | null;
  tactical_entry_date: string | null;
  completed_swing_count: number;
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

export interface GrindGuardsEvaluation {
  ma60_slope10_pct: number | null;
  ma60_flat_ready: boolean;
  discount_mode: 'LAST_SELL_7PCT' | 'HIGH60_15PCT';
  reload_target_milli: number | null;
  reload_target_cny: number | null;
  discount_ready: boolean;
  rsi14: number | null;
  rsi14_min3: number | null;
  bias20_pct: number | null;
  bias20_min3_pct: number | null;
  oversold_3d_ready: boolean;
  ma5_cny: number | null;
  ma20_cny: number | null;
  right_side_turn_ready: boolean;
  cooldown_ready: boolean;
  in_bull_trend: boolean;
  support_breakdown_2d: boolean;
  all_reload_guards_ready: boolean;
}

export interface DeconcentrationEvaluation {
  schema: 'portfolio-deconcentration-plan/1.0';
  plan_present: boolean;
  account_id: string;
  ts_code: string;
  as_of_trade_date: string;
  plan_status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'UNINITIALIZED';
  plan_mode: DeconcentrationPlanMode;
  initial_shares: number;
  current_shares: number;
  sellable_shares: number;
  target_keep_bps: number;
  target_keep_pct: number;
  target_keep_shares: number;
  tactical_slot_bps: number;
  tactical_slot_pct: number;
  max_grind_weight_pct: number;
  drift_harvest_trigger_pct: number;
  preemptive_weight_threshold_pct: number;
  normal_lifeline_pct: number;
  reload_discount_pct: number;
  take_profit_pct: number;
  rebound_pct: number;
  tactical_shares: number;
  tactical_entry_price_cny: number | null;
  tactical_entry_date: string | null;
  tactical_take_profit_cny: number | null;
  completed_swing_count: number;
  live_weight_pct: number | null;
  reference_price_milli: number | null;
  reference_price_cny: number | null;
  /** 计划记录的价格基准交易日（原样返回，供审计；NULL 表示历史计划未记录）。 */
  anchor_trade_date: string | null;
  /** 锚定价无法按复权因子换算时的本地化披露（保留原始价，不阻断报告）；否则为 null。 */
  anchor_basis_note_zh: string | null;
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
  recommended_buy_shares: number;
  active_trigger_reason: TrancheTriggerReason | null;
  tranches: DeconcentrationTrancheRow[];
  grind_guards: GrindGuardsEvaluation | null;
  status_summary_zh: string;
  /** 仅供同日持久化写回的待更新批次。 */
  pending_mutations: {
    plan_updates: {
      plan_id: string;
      status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
      last_exec_price_milli: number | null;
      last_exec_date: string | null;
      tactical_shares: number;
      tactical_entry_price_milli: number | null;
      tactical_entry_date: string | null;
      completed_swing_count: number;
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
  plan_mode?: DeconcentrationPlanMode;
  tactical_slot_bps?: number;
  anchor_price_milli: number;
  /** 原始锚定价对应的价格基准交易日（YYYYMMDD）。显式给出时与新计划一同落库；缺省保持 NULL。 */
  anchor_trade_date?: string;
  support_floor_milli?: number | null;
  total_tranches?: number;
  created_at: string;
}

const TRIGGER_REASON_ZH: Record<TrancheTriggerReason, string> = {
  MONTHLY_SCHEDULE: '月度时间保底窗口触发',
  REBOUND_8PCT: '自前次锚定价反弹满 +8% 加速兑现',
  BREAKDOWN_MA60: '空头防守期连续两日有效跌破60日均线保护减仓',
  BREAKDOWN_SUPPORT_FLOOR: '收盘跌破磨底箱体防守位保护减仓',
  GRIND_OVERSOLD_RELOAD: '25%底仓磨底回补条件满足：60日均线走平+深折价超卖+右侧止稳；系统附加护栏（距上次执行≥3个交易日、仓位<30%，非EXP-V3-04签发条件）亦满足，触发10%降本回补',
  GRIND_TACTICAL_TAKE_PROFIT: '磨底降本机动槽达到止盈兑现条件，高抛降本回归25%核心底仓',
  GRIND_OVERWEIGHT_DRIFT_HARVEST: '持仓占比被动漂移达34%以上且短线滞涨，获利兑现超额部分回归25%底仓',
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

/** 严格校验 YYYYMMDD 交易日文本（含真实日历日），用于锚定价的价格基准日。 */
export function isValidTradeDateYmd(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
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
      plan: normalizePlanRow(existing),
      tranches,
    };
  }

  const planMode: DeconcentrationPlanMode = input.plan_mode ?? 'STANDARD';
  const targetKeepBps = input.target_keep_bps ?? (planMode === 'BOTTOM_GRIND_25' ? 2500 : 1800);
  const tacticalSlotBps = input.tactical_slot_bps ?? 1000;
  if (input.anchor_trade_date !== undefined && !isValidTradeDateYmd(input.anchor_trade_date)) {
    throw new Error(`anchor_trade_date 需要有效的 YYYYMMDD 交易日（收到 ${input.anchor_trade_date}）`);
  }
  const anchorTradeDate = input.anchor_trade_date ?? null;
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
    anchor_trade_date: anchorTradeDate,
    support_floor_milli: input.support_floor_milli ?? null,
    last_exec_price_milli: null,
    last_exec_date: null,
    plan_mode: planMode,
    tactical_slot_bps: tacticalSlotBps,
    tactical_shares: 0,
    tactical_entry_price_milli: null,
    tactical_entry_date: null,
    completed_swing_count: 0,
    status: planMode === 'BOTTOM_GRIND_25' ? 'ACTIVE' : (excessShares >= 100 ? 'ACTIVE' : 'COMPLETED'),
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
        anchor_price_milli, anchor_trade_date, support_floor_milli, last_exec_price_milli, last_exec_date,
        plan_mode, tactical_slot_bps, tactical_shares, tactical_entry_price_milli,
        tactical_entry_date, completed_swing_count, status, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      plan.plan_id, plan.account_id, plan.ts_code, plan.initial_shares, plan.target_keep_bps,
      plan.anchor_price_milli, plan.anchor_trade_date, plan.support_floor_milli, plan.last_exec_price_milli, plan.last_exec_date,
      plan.plan_mode, plan.tactical_slot_bps, plan.tactical_shares, plan.tactical_entry_price_milli,
      plan.tactical_entry_date, plan.completed_swing_count, plan.status, plan.created_at,
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

function normalizePlanRow(row: Partial<DeconcentrationPlanRow> & Pick<DeconcentrationPlanRow, 'plan_id' | 'account_id' | 'ts_code' | 'initial_shares' | 'target_keep_bps' | 'anchor_price_milli' | 'status' | 'created_at'>): DeconcentrationPlanRow {
  return {
    plan_id: row.plan_id,
    account_id: row.account_id,
    ts_code: row.ts_code,
    initial_shares: Number(row.initial_shares),
    target_keep_bps: Number(row.target_keep_bps),
    anchor_price_milli: Number(row.anchor_price_milli),
    // 旧库/旧行没有该列或值为 NULL：保持 NULL，绝不从 created_at 推断。
    anchor_trade_date: isValidTradeDateYmd(row.anchor_trade_date ?? null) ? row.anchor_trade_date! : null,
    support_floor_milli: row.support_floor_milli ?? null,
    last_exec_price_milli: row.last_exec_price_milli ?? null,
    last_exec_date: row.last_exec_date ?? null,
    plan_mode: row.plan_mode === 'BOTTOM_GRIND_25' ? 'BOTTOM_GRIND_25' : 'STANDARD',
    tactical_slot_bps: Number.isFinite(Number(row.tactical_slot_bps)) ? Number(row.tactical_slot_bps) : 1000,
    tactical_shares: Number.isFinite(Number(row.tactical_shares)) ? Number(row.tactical_shares) : 0,
    tactical_entry_price_milli: row.tactical_entry_price_milli ?? null,
    tactical_entry_date: row.tactical_entry_date ?? null,
    completed_swing_count: Number.isFinite(Number(row.completed_swing_count)) ? Number(row.completed_swing_count) : 0,
    status: row.status,
    created_at: row.created_at,
  };
}

/** 人工校准减仓计划的模式、目标底仓比例、磨底箱体防守位、基准锚定价或重置已触发未执行批次。 */
export function calibrateDeconcentrationPlan(
  portfolioDb: DatabaseSync,
  input: {
    account_id: string;
    ts_code?: string;
    plan_mode?: DeconcentrationPlanMode;
    target_keep_bps?: number;
    tactical_slot_bps?: number;
    current_shares?: number;
    current_price_milli?: number;
    nav_cents?: number;
    support_floor_milli?: number | null;
    anchor_price_milli?: number;
    /** 原始锚定价对应的价格基准交易日（YYYYMMDD）。修改锚定价时必须显式给出。 */
    anchor_trade_date?: string;
    reset_triggered?: boolean;
  },
): {
  updated: boolean;
  plan_id: string;
  account_id: string;
  ts_code: string;
  plan_mode: DeconcentrationPlanMode;
  target_keep_bps: number;
  tactical_slot_bps: number;
  target_keep_shares: number | null;
  remaining_excess_shares: number | null;
  support_floor_milli: number | null;
  anchor_price_milli: number;
  anchor_trade_date: string | null;
  reset_tranche_nos: number[];
  tranches: DeconcentrationTrancheRow[];
} {
  ensurePortfolioV3Schema(portfolioDb);
  const tsCode = input.ts_code ?? '159558.SZ';
  const rawPlan = portfolioDb.prepare(
    "SELECT * FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1",
  ).get(input.account_id, tsCode) as DeconcentrationPlanRow | undefined;
  if (!rawPlan) {
    throw new Error(`未找到 ${input.account_id} / ${tsCode} 的有效四批换马减仓计划。`);
  }
  const plan = normalizePlanRow(rawPlan);

  if (input.support_floor_milli !== undefined && input.support_floor_milli !== null) {
    if (!Number.isSafeInteger(input.support_floor_milli) || input.support_floor_milli <= 0) {
      throw new Error(`--support-floor-milli 需要正整数厘价或 null（收到 ${input.support_floor_milli}）`);
    }
  }
  if (input.anchor_price_milli !== undefined) {
    if (!Number.isSafeInteger(input.anchor_price_milli) || input.anchor_price_milli <= 0) {
      throw new Error(`--anchor-price-milli 需要正整数厘价（收到 ${input.anchor_price_milli}）`);
    }
    if (input.anchor_trade_date === undefined) {
      throw new Error('修改锚定价必须同时给出显式的价格基准交易日 --anchor-trade-date YYYYMMDD；不得用计划创建日冒充');
    }
  }
  if (input.anchor_trade_date !== undefined && !isValidTradeDateYmd(input.anchor_trade_date)) {
    throw new Error(`--anchor-trade-date 需要有效的 YYYYMMDD 交易日（收到 ${input.anchor_trade_date}）`);
  }
  if (input.target_keep_bps !== undefined) {
    if (!Number.isSafeInteger(input.target_keep_bps) || input.target_keep_bps <= 0 || input.target_keep_bps > 10000) {
      throw new Error(`--target-keep-bps 需要 1..10000 的整数 bps（收到 ${input.target_keep_bps}）`);
    }
  }
  if (input.tactical_slot_bps !== undefined) {
    if (!Number.isSafeInteger(input.tactical_slot_bps) || input.tactical_slot_bps <= 0 || input.tactical_slot_bps > 5000) {
      throw new Error(`--tactical-slot-bps 需要 1..5000 的整数 bps（收到 ${input.tactical_slot_bps}）`);
    }
  }

  const nextPlanMode: DeconcentrationPlanMode = input.plan_mode ?? plan.plan_mode;
  const nextTargetKeepBps = input.target_keep_bps
    ?? (nextPlanMode === 'BOTTOM_GRIND_25' && plan.plan_mode !== 'BOTTOM_GRIND_25' ? 2500 : plan.target_keep_bps);
  const nextTacticalSlotBps = input.tactical_slot_bps ?? plan.tactical_slot_bps;
  const nextSupportFloor = input.support_floor_milli !== undefined
    ? input.support_floor_milli
    : (plan.support_floor_milli ?? null);
  const nextAnchorPrice = input.anchor_price_milli ?? plan.anchor_price_milli;
  // 未触及锚定价/基准日的校准（如只改目标底仓比例）必须原样保留两者。
  const nextAnchorTradeDate = input.anchor_trade_date ?? plan.anchor_trade_date;
  const resetTrancheNos: number[] = [];
  let computedTargetKeepShares: number | null = null;
  let computedRemainingExcess: number | null = null;

  inPortfolioTransaction(portfolioDb, () => {
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

    let nextInitialShares = plan.initial_shares;
    let nextStatus = nextPlanMode === 'BOTTOM_GRIND_25' ? 'ACTIVE' : plan.status;

    const shouldRebalance =
      input.current_shares !== undefined
      && input.current_price_milli !== undefined
      && input.current_price_milli > 0
      && input.nav_cents !== undefined
      && input.nav_cents > 0;
    if (shouldRebalance) {
      const priceCents = input.current_price_milli! / 10;
      const targetKeepShares = Math.floor(((input.nav_cents! * (nextTargetKeepBps / 10000)) / priceCents) / 100) * 100;
      const remainingExcess = Math.max(0, Math.floor((input.current_shares! - targetKeepShares) / 100) * 100);
      computedTargetKeepShares = targetKeepShares;
      computedRemainingExcess = remainingExcess;

      const existingTranches = portfolioDb.prepare(
        'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
      ).all(plan.plan_id) as unknown as DeconcentrationTrancheRow[];
      const execSum = existingTranches
        .filter(t => t.status === 'EXECUTED')
        .reduce((s, t) => s + t.planned_shares, 0);
      const openTranches = existingTranches.filter(t => t.status !== 'EXECUTED');

      if (openTranches.length > 0) {
        const split = splitSharesIntoTranches(remainingExcess, openTranches.length);
        const upd = portfolioDb.prepare(`
          UPDATE deconcentration_tranche
          SET planned_shares = ?, status = ?, trigger_date = NULL, trigger_reason = NULL, executed_date = NULL, executed_price_milli = NULL
          WHERE plan_id = ? AND tranche_no = ?
        `);
        openTranches.forEach((tr, idx) => {
          const qty = split[idx] ?? 0;
          upd.run(qty, qty >= 100 ? 'PENDING' : 'SKIPPED', plan.plan_id, tr.tranche_no);
        });
      } else if (remainingExcess >= 100) {
        const nextNo = existingTranches.reduce((m, t) => Math.max(m, Number(t.tranche_no)), 0) + 1;
        portfolioDb.prepare(`
          INSERT INTO deconcentration_tranche (
            plan_id, tranche_no, planned_shares, status, trigger_date, trigger_reason, executed_date, executed_price_milli
          ) VALUES (?,?,?,?,NULL,NULL,NULL,NULL)
        `).run(plan.plan_id, nextNo, remainingExcess, 'PENDING');
      }

      nextInitialShares = execSum + remainingExcess + targetKeepShares;
      if (nextPlanMode !== 'BOTTOM_GRIND_25') {
        nextStatus = remainingExcess >= 100 ? 'ACTIVE' : 'COMPLETED';
      }
    }

    portfolioDb.prepare(`
      UPDATE deconcentration_plan
      SET support_floor_milli = ?, anchor_price_milli = ?, anchor_trade_date = ?, plan_mode = ?,
          target_keep_bps = ?, tactical_slot_bps = ?, initial_shares = ?, status = ?
      WHERE plan_id = ?
    `).run(
      nextSupportFloor,
      nextAnchorPrice,
      nextAnchorTradeDate,
      nextPlanMode,
      nextTargetKeepBps,
      nextTacticalSlotBps,
      nextInitialShares,
      nextStatus,
      plan.plan_id,
    );
  });

  const tranches = portfolioDb.prepare(
    'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
  ).all(plan.plan_id) as unknown as DeconcentrationTrancheRow[];

  return {
    updated: true,
    plan_id: plan.plan_id,
    account_id: plan.account_id,
    ts_code: plan.ts_code,
    plan_mode: nextPlanMode,
    target_keep_bps: nextTargetKeepBps,
    tactical_slot_bps: nextTacticalSlotBps,
    target_keep_shares: computedTargetKeepShares,
    remaining_excess_shares: computedRemainingExcess,
    support_floor_milli: nextSupportFloor,
    anchor_price_milli: nextAnchorPrice,
    anchor_trade_date: nextAnchorTradeDate,
    reset_tranche_nos: resetTrancheNos,
    tranches,
  };
}

/**
 * 显式取消存量重仓降浓计划：将 ACTIVE 行安全更新为 CANCELLED（保留历史行与批次记录，绝不删除）。
 */
export function cancelDeconcentrationPlan(
  portfolioDb: DatabaseSync,
  accountId: string,
  tsCode = '159558.SZ',
  reason = 'cancelled_by_operator',
): {
  cancelled: boolean;
  updated_count: number;
  plan_ids: string[];
  account_id: string;
  ts_code: string;
  reason: string;
  status: 'CANCELLED';
} {
  ensurePortfolioV3Schema(portfolioDb);
  const activeRows = portfolioDb.prepare(
    "SELECT plan_id FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status = 'ACTIVE' ORDER BY created_at DESC",
  ).all(accountId, tsCode) as Array<{ plan_id: string }>;
  const planIds = activeRows.map(r => String(r.plan_id));
  if (planIds.length > 0) {
    const cancelledAt = new Date().toISOString();
    inPortfolioTransaction(portfolioDb, () => {
      portfolioDb.prepare(
        "UPDATE deconcentration_plan SET status = 'CANCELLED' WHERE account_id = ? AND ts_code = ? AND status = 'ACTIVE'",
      ).run(accountId, tsCode);
      if (portfolioTableExists(portfolioDb, 'account_meta')) {
        portfolioDb.prepare(
          'INSERT INTO account_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(
          `v3_deconc_cancelled:${accountId}:${tsCode}`,
          JSON.stringify({ plan_ids: planIds, reason, cancelled_at: cancelledAt }),
        );
      }
    });
  }
  return {
    cancelled: planIds.length > 0,
    updated_count: planIds.length,
    plan_ids: planIds,
    account_id: accountId,
    ts_code: tsCode,
    reason,
    status: 'CANCELLED',
  };
}

function loadEtfQfqCloses(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
  limit = 180,
): { dates: string[]; closes: number[] } | null {
  if (!marketDb || !portfolioTableExists(marketDb, 'fund_daily')) return null;
  const bars = (marketDb.prepare(
    'SELECT trade_date, close FROM fund_daily WHERE ts_code = ? AND trade_date <= ? AND close > 0 ORDER BY trade_date DESC LIMIT ?',
  ).all(tsCode, asOf, limit) as { trade_date: string; close: number }[]).reverse();
  if (bars.length === 0) return null;

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
  return {
    dates: bars.map(b => b.trade_date),
    closes: bars.map((bar, i) => Number(bar.close) * (adjs[i] / baseAdj)),
  };
}

/**
 * 复权基准换算：把事件日的原始成交价折算到 asOf 的 qfq 基准。
 * 基准与 `loadEtfQfqCloses` / `stockMa20Milli` 一致：事件日与 asOf 各取 <= 该日的最新
 * `fund_adj.adj_factor`（carry-forward），返回 price × adj(事件日) / adj(asOf)，四舍五入到整数厘。
 * 任一日缺可用复权因子时原样返回成交价（保持旧行为，不臆造因子）。
 */
function createAdjPriceConverter(
  marketDb: DatabaseSync | null | undefined,
  tsCode: string,
  asOf: string,
): {
  factorAt: (date: string) => number | null;
  adjustPrice: (priceMilli: number, fromDate: string | null | undefined) => number;
} | null {
  if (!marketDb || !portfolioTableExists(marketDb, 'fund_adj')) return null;
  const db = marketDb;
  const factors = new Map<string, number | null>();
  const factorAt = (date: string): number | null => {
    if (factors.has(date)) return factors.get(date)!;
    const row = db.prepare(
      'SELECT adj_factor FROM fund_adj WHERE ts_code = ? AND trade_date <= ? AND adj_factor > 0 ORDER BY trade_date DESC LIMIT 1',
    ).get(tsCode, date) as { adj_factor?: number } | undefined;
    const factor = Number(row?.adj_factor);
    const value = Number.isFinite(factor) && factor > 0 ? factor : null;
    factors.set(date, value);
    return value;
  };
  const adjustPrice = (priceMilli: number, fromDate: string | null | undefined): number => {
    if (!fromDate || !Number.isFinite(priceMilli) || priceMilli <= 0) return priceMilli;
    const from = factorAt(fromDate);
    const to = factorAt(asOf);
    if (from === null || to === null || from === to) return priceMilli;
    return Math.round(priceMilli * (from / to));
  };
  return { factorAt, adjustPrice };
}

/**
 * 锚定价基准换算（仅在无 later last-exec 价格时使用）：
 * 对数据库中的**原始**锚定价做一次性只读换算 `round(raw × adj(基准日) / adj(asOf))`，
 * 绝不把换算结果写回数据库（避免跨日重复复权）。基准日或因子缺失时保留原始价，
 * 返回本地化披露文本，报告继续输出（不阻断）。
 */
function convertAnchorPriceToAsOf(input: {
  anchorPriceMilli: number;
  basisDate: string | null;
  asOf: string;
  factorAt: ((date: string) => number | null) | null;
}): { priceMilli: number; noteZh: string | null } {
  const raw = input.anchorPriceMilli;
  const rawCny = (raw / 1000).toFixed(3);
  if (!input.basisDate) {
    return {
      priceMilli: raw,
      noteZh: `锚定价未记录价格基准日，按原始价 ${rawCny} 元计算反弹线，未做除权换算。`,
    };
  }
  if (input.basisDate > input.asOf) {
    return {
      priceMilli: raw,
      noteZh: `锚定价基准日 ${input.basisDate} 晚于评估日 ${input.asOf}，按原始价 ${rawCny} 元计算反弹线。`,
    };
  }
  const from = input.factorAt ? input.factorAt(input.basisDate) : null;
  const to = input.factorAt ? input.factorAt(input.asOf) : null;
  if (from === null || to === null) {
    return {
      priceMilli: raw,
      noteZh: `锚定价基准日 ${input.basisDate} 或评估日缺少可用复权因子，按原始价 ${rawCny} 元计算反弹线，未做除权换算。`,
    };
  }
  if (from === to) return { priceMilli: raw, noteZh: null };
  return { priceMilli: Math.round(raw * (from / to)), noteZh: null };
}

function rollingMeanAt(series: number[], endIdx: number, window: number): number | null {
  if (endIdx < window - 1 || endIdx >= series.length) return null;
  let sum = 0;
  for (let i = endIdx - window + 1; i <= endIdx; i += 1) sum += series[i];
  return sum / window;
}

function computeEtfMa60Breakdown(
  qfq: { dates: string[]; closes: number[] } | null,
  refDate: string,
): { ma60Cny: number | null; ma60ProtectMilli: number | null; breakdown2d: boolean; wasAboveMa60SinceRef: boolean } {
  if (!qfq || qfq.closes.length < 61) {
    return { ma60Cny: null, ma60ProtectMilli: null, breakdown2d: false, wasAboveMa60SinceRef: false };
  }
  const { dates, closes } = qfq;
  const t = closes.length - 1;
  const ma60T = rollingMeanAt(closes, t, 60);
  const ma60Prev = rollingMeanAt(closes, t - 1, 60);
  if (ma60T === null || ma60Prev === null) {
    return { ma60Cny: null, ma60ProtectMilli: null, breakdown2d: false, wasAboveMa60SinceRef: false };
  }

  // 仅当自基准日（含当日）以来站上过 MA60*0.985 时，后续跌破才视为“高位新破位”。
  const idxAtOrAfter = dates.findIndex((d, idx) => idx >= 59 && d >= refDate);
  const startCheckIdx = idxAtOrAfter === -1
    ? t
    : (idxAtOrAfter > 59 && dates[idxAtOrAfter] > refDate ? idxAtOrAfter - 1 : idxAtOrAfter);
  let wasAboveMa60SinceRef = false;
  for (let idx = startCheckIdx; idx <= t; idx += 1) {
    const m = rollingMeanAt(closes, idx, 60);
    if (m !== null && closes[idx] >= m * 0.985) {
      wasAboveMa60SinceRef = true;
      break;
    }
  }

  const breakdown2d = closes[t] < ma60T * 0.985 && closes[t - 1] < ma60Prev * 0.985;
  return {
    ma60Cny: Math.round(ma60T * 1000) / 1000,
    ma60ProtectMilli: Math.round(ma60T * 0.985 * 1000),
    breakdown2d,
    wasAboveMa60SinceRef,
  };
}

export function computeEtfGrindIndicators(input: {
  qfq: { dates: string[]; closes: number[] } | null;
  asOf: string;
  currentCloseMilli: number | null;
  supportFloorMilli: number | null;
  lastExecPriceMilli: number | null;
  lastExecDate: string | null;
  tradeDaysSinceLast: number;
  marketRegime: MarketRegimeTier;
}): {
  ma5Milli: number | null;
  ma20Milli: number | null;
  ma60Milli: number | null;
  prevCloseMilli: number | null;
  guards: GrindGuardsEvaluation;
} {
  const { qfq, currentCloseMilli, supportFloorMilli, lastExecPriceMilli, lastExecDate, tradeDaysSinceLast, marketRegime } = input;
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;

  if (!qfq || qfq.closes.length < 2) {
    const useLastSell = lastExecPriceMilli !== null && lastExecDate !== null && tradeDaysSinceLast <= 90;
    const reloadTargetMilli = useLastSell ? Math.round(lastExecPriceMilli! * 0.93) : null;
    const deepCrash = supportFloorMilli !== null && currentCloseMilli !== null
      && currentCloseMilli < Math.round(supportFloorMilli * 0.96);
    return {
      ma5Milli: null,
      ma20Milli: null,
      ma60Milli: null,
      prevCloseMilli: null,
      guards: {
        ma60_slope10_pct: null,
        ma60_flat_ready: false,
        discount_mode: useLastSell ? 'LAST_SELL_7PCT' : 'HIGH60_15PCT',
        reload_target_milli: reloadTargetMilli,
        reload_target_cny: reloadTargetMilli !== null ? reloadTargetMilli / 1000 : null,
        discount_ready: reloadTargetMilli !== null && currentCloseMilli !== null && currentCloseMilli <= reloadTargetMilli,
        rsi14: null,
        rsi14_min3: null,
        bias20_pct: null,
        bias20_min3_pct: null,
        oversold_3d_ready: false,
        ma5_cny: null,
        ma20_cny: null,
        right_side_turn_ready: false,
        cooldown_ready: !lastExecDate || tradeDaysSinceLast >= 3,
        in_bull_trend: false,
        support_breakdown_2d: deepCrash,
        all_reload_guards_ready: false,
      },
    };
  }

  const { dates, closes } = qfq;
  const t = closes.length - 1;
  const prevIdx = dates[t] === input.asOf ? t - 1 : t;
  const prevCloseMilli = prevIdx >= 0 ? Math.round(closes[prevIdx] * 1000) : null;
  const cMilli = currentCloseMilli ?? Math.round(closes[t] * 1000);
  const cVal = cMilli / 1000;

  const ma5T = rollingMeanAt(closes, t, 5);
  const ma20T = rollingMeanAt(closes, t, 20);
  const ma60T = rollingMeanAt(closes, t, 60);
  const ma60Prev10 = t >= 69 ? rollingMeanAt(closes, t - 10, 60) : null;
  const ma60Slope10 = ma60T !== null && ma60Prev10 !== null && ma60Prev10 > 0
    ? ((ma60T / ma60Prev10) - 1) * 100
    : null;
  // EXP-V3-04 rule: when marketRegime === 'DEFENSIVE' slope must be >= 0; in STRUCTURAL/OFFENSIVE also >= 0 in v3.2.0
  const ma60FlatReady = ma60Slope10 !== null && ma60Slope10 >= (marketRegime === 'DEFENSIVE' ? 0 : 0);

  let avgUp: number | null = null;
  let avgDown: number | null = null;
  const rsiSeries: Array<number | null> = new Array(closes.length).fill(null);
  const alpha = 1 / 14;
  for (let i = 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const up = Math.max(0, delta);
    const down = Math.max(0, -delta);
    if (avgUp === null || avgDown === null) {
      avgUp = up;
      avgDown = down;
    } else {
      avgUp = alpha * up + (1 - alpha) * avgUp;
      avgDown = alpha * down + (1 - alpha) * avgDown;
    }
    if (i >= 14) {
      rsiSeries[i] = avgDown === 0 ? (avgUp > 0 ? 100 : 50) : 100 - 100 / (1 + avgUp / avgDown);
    }
  }
  const r14T = rsiSeries[t];
  const r14Recent = [t - 2, t - 1, t].filter(i => i >= 0).map(i => rsiSeries[i]).filter((v): v is number => v !== null);
  const r14Min3 = r14Recent.length > 0 ? Math.min(...r14Recent) : null;

  const bias20Recent: number[] = [];
  for (let i = Math.max(0, t - 2); i <= t; i += 1) {
    const m20 = rollingMeanAt(closes, i, 20);
    if (m20 !== null && m20 > 0) bias20Recent.push(((closes[i] - m20) / m20) * 100);
  }
  const bias20T = ma20T !== null && ma20T > 0 ? ((cVal - ma20T) / ma20T) * 100 : null;
  const bias20Min3 = bias20Recent.length > 0 ? Math.min(...bias20Recent) : null;
  const oversold3dReady = (r14Min3 !== null && r14Min3 <= 36) || (bias20Min3 !== null && bias20Min3 <= -6.5);

  const high60Slice = t >= 19 ? closes.slice(Math.max(0, t - 59), t + 1) : [];
  const high60Milli = high60Slice.length > 0 ? Math.round(Math.max(...high60Slice) * 1000) : null;
  const useLastSell = lastExecPriceMilli !== null && lastExecDate !== null && tradeDaysSinceLast <= 90;
  const reloadTargetMilli = useLastSell
    ? Math.round(lastExecPriceMilli! * 0.93)
    : (high60Milli !== null ? Math.round(high60Milli * 0.85) : null);
  const discountReady = reloadTargetMilli !== null && cMilli <= reloadTargetMilli;

  const ma5Milli = ma5T !== null ? Math.round(ma5T * 1000) : null;
  const ma20Milli = ma20T !== null ? Math.round(ma20T * 1000) : null;
  const ma60Milli = ma60T !== null ? Math.round(ma60T * 1000) : null;
  // 右侧止稳（第四护栏的实际公式）：当日收阳，且收盘不低于 MA5 的 99.5%——
  // 是 c > prevClose && c >= MA5*0.995，不是严格的 close > MA5。
  const rightSideTurnReady = prevCloseMilli !== null && ma5Milli !== null
    && cMilli > prevCloseMilli && cVal >= ma5T! * 0.995;
  // 冷却期（系统附加护栏，非 EXP-V3-04 签发条件）：距上次卖出/战术执行至少 3 个交易日。
  const cooldownReady = !lastExecDate || tradeDaysSinceLast >= 3;
  const inBullTrend = ma60T !== null && ma20T !== null && cVal > ma60T && ma20T > ma60T;
  const supportBreakdown2d = supportFloorMilli !== null && (
    cMilli < Math.round(supportFloorMilli * 0.96)
    || (prevCloseMilli !== null && cMilli < supportFloorMilli && prevCloseMilli < supportFloorMilli)
  );
  const allReloadGuardsReady =
    cooldownReady && ma60FlatReady && discountReady && oversold3dReady && rightSideTurnReady;

  return {
    ma5Milli,
    ma20Milli,
    ma60Milli,
    prevCloseMilli,
    guards: {
      ma60_slope10_pct: ma60Slope10 !== null ? r2(ma60Slope10) : null,
      ma60_flat_ready: ma60FlatReady,
      discount_mode: useLastSell ? 'LAST_SELL_7PCT' : 'HIGH60_15PCT',
      reload_target_milli: reloadTargetMilli,
      reload_target_cny: reloadTargetMilli !== null ? reloadTargetMilli / 1000 : null,
      discount_ready: discountReady,
      rsi14: r14T !== null ? r2(r14T) : null,
      rsi14_min3: r14Min3 !== null ? r2(r14Min3) : null,
      bias20_pct: bias20T !== null ? r2(bias20T) : null,
      bias20_min3_pct: bias20Min3 !== null ? r2(bias20Min3) : null,
      oversold_3d_ready: oversold3dReady,
      ma5_cny: ma5T !== null ? r3(ma5T) : null,
      ma20_cny: ma20T !== null ? r3(ma20T) : null,
      right_side_turn_ready: rightSideTurnReady,
      cooldown_ready: cooldownReady,
      in_bull_trend: inBullTrend,
      support_breakdown_2d: supportBreakdown2d,
      all_reload_guards_ready: allReloadGuardsReady,
    },
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
    plan_mode: 'STANDARD',
    initial_shares: currentShares,
    current_shares: currentShares,
    sellable_shares: sellableShares,
    target_keep_bps: 1800,
    target_keep_pct: 18,
    target_keep_shares: 0,
    tactical_slot_bps: 1000,
    tactical_slot_pct: 10,
    max_grind_weight_pct: 28,
    drift_harvest_trigger_pct: 34,
    preemptive_weight_threshold_pct: 30,
    normal_lifeline_pct: 15,
    reload_discount_pct: 7,
    take_profit_pct: 7.5,
    rebound_pct: 8,
    tactical_shares: 0,
    tactical_entry_price_cny: null,
    tactical_entry_date: null,
    tactical_take_profit_cny: null,
    completed_swing_count: 0,
    live_weight_pct: null,
    reference_price_milli: currentCloseMilli,
    reference_price_cny: currentCloseMilli !== null ? currentCloseMilli / 1000 : null,
    anchor_trade_date: null,
    anchor_basis_note_zh: null,
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
    recommended_buy_shares: 0,
    active_trigger_reason: null,
    tranches: [],
    grind_guards: null,
    status_summary_zh: `${tsCode} 尚未建立四批换马减仓计划。`,
    pending_mutations: { plan_updates: null, tranche_updates: [] },
  };
}

function cancelledEvaluation(
  accountId: string,
  tsCode: string,
  asOf: string,
  currentShares: number,
  sellableShares: number,
  currentCloseMilli: number | null,
): DeconcentrationEvaluation {
  return {
    ...uninitializedEvaluation(accountId, tsCode, asOf, currentShares, sellableShares, currentCloseMilli),
    plan_status: 'CANCELLED',
    status_summary_zh: `${tsCode} 存量降浓计划已取消，改由组合双向目标对齐统一调仓。`,
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
  availableCashCents?: number;
  circuitBreakerStatus?: 'NORMAL' | 'L1_WARN' | 'L2_LOCKED';
  marketRegime: MarketRegimeTier;
  planEnabled?: boolean;
}): DeconcentrationEvaluation {
  const tsCode = input.tsCode ?? '159558.SZ';
  if (input.planEnabled === false) {
    return cancelledEvaluation(
      input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
    );
  }
  if (
    !input.portfolioDb
    || !portfolioTableExists(input.portfolioDb, 'deconcentration_plan')
    || !portfolioTableExists(input.portfolioDb, 'deconcentration_tranche')
  ) {
    return uninitializedEvaluation(
      input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
    );
  }

  const rawPlan = input.portfolioDb.prepare(
    "SELECT * FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1",
  ).get(input.accountId, tsCode) as DeconcentrationPlanRow | undefined;

  if (!rawPlan) {
    const cancelledRow = input.portfolioDb.prepare(
      "SELECT 1 FROM deconcentration_plan WHERE account_id = ? AND ts_code = ? AND status = 'CANCELLED' LIMIT 1",
    ).get(input.accountId, tsCode);
    if (cancelledRow) {
      return cancelledEvaluation(
        input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
      );
    }
    return uninitializedEvaluation(
      input.accountId, tsCode, input.asOf, input.currentShares, input.sellableShares, input.currentCloseMilli,
    );
  }
  const plan = normalizePlanRow(rawPlan);
  const planMode = plan.plan_mode;
  // 决策/输出统一使用 asOf 复权基准；数据库仍保存事件日原始价（raw），避免跨日重复复权。
  const adjConverter = createAdjPriceConverter(input.marketDb, tsCode, input.asOf);
  const adjustPrice = adjConverter?.adjustPrice
    ?? ((priceMilli: number, _fromDate?: string | null): number => priceMilli);

  const rawTranches = input.portfolioDb.prepare(
    'SELECT * FROM deconcentration_tranche WHERE plan_id = ? ORDER BY tranche_no ASC',
  ).all(plan.plan_id) as unknown as DeconcentrationTrancheRow[];
  const tranches = rawTranches.map(row => ({ ...row }));
  const updatedTranches: DeconcentrationTrancheRow[] = [];

  let lastExecPriceRaw = plan.last_exec_price_milli;
  let lastExecDate = plan.last_exec_date;
  let lastExecPriceMilli = lastExecPriceRaw !== null ? adjustPrice(lastExecPriceRaw, lastExecDate) : null;
  let planStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' = plan.status;
  let tacticalShares = plan.tactical_shares;
  let tacticalEntryPriceRaw = plan.tactical_entry_price_milli;
  let tacticalEntryDate = plan.tactical_entry_date;
  let tacticalEntryPriceMilli = tacticalEntryPriceRaw !== null ? adjustPrice(tacticalEntryPriceRaw, tacticalEntryDate) : null;
  let completedSwingCount = plan.completed_swing_count;
  let planMutated = false;

  // 1) 状态闭环核对：根据当前持仓份额与最近卖出流水，推进已完成的超额批次为 EXECUTED。
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
      // 批次成交价保留事件日原始价归档；参考价在比较前折算到 asOf 复权基准。
      t.executed_price_milli = sellEvent?.price_milli ?? input.currentCloseMilli ?? t.executed_price_milli;
      updatedTranches.push({ ...t });
      if (!lastExecDate || (t.executed_date && t.executed_date >= lastExecDate)) {
        lastExecDate = t.executed_date;
        if (t.executed_price_milli !== null) {
          lastExecPriceRaw = t.executed_price_milli;
          lastExecPriceMilli = adjustPrice(t.executed_price_milli, t.executed_date);
        }
        planMutated = true;
      }
    }
  }

  const totalPlannedSell = tranches.filter(t => t.status !== 'SKIPPED').reduce((s, t) => s + t.planned_shares, 0);
  const planKeepShares = Math.max(0, plan.initial_shares - totalPlannedSell);
  const dynamicKeepShares = input.navCents && input.navCents > 0 && input.currentCloseMilli !== null && input.currentCloseMilli > 0
    ? Math.floor(((input.navCents * (plan.target_keep_bps / 10000)) / (input.currentCloseMilli / 10)) / 100) * 100
    : planKeepShares;
  const weightBps = input.navCents && input.navCents > 0 && input.currentCloseMilli !== null
    ? Math.round(((input.currentShares * (input.currentCloseMilli / 10)) / input.navCents) * 10000)
    : null;
  const hasOpenExcess = tranches.some(t => t.status === 'PENDING' || t.status === 'TRIGGERED');
  const allClosed = !hasOpenExcess;
  const targetKeepShares = hasOpenExcess ? planKeepShares : dynamicKeepShares;

  if (planMode === 'STANDARD') {
    if (allClosed || (weightBps !== null && weightBps <= plan.target_keep_bps && tranches.some(t => t.status === 'EXECUTED'))) {
      if (planStatus !== 'COMPLETED') {
        planStatus = 'COMPLETED';
        planMutated = true;
      }
    }
  } else if (planStatus !== 'ACTIVE') {
    // BOTTOM_GRIND_25 keeps ACTIVE status continuously after excess shares complete
    planStatus = 'ACTIVE';
    planMutated = true;
  }

  // 2) BOTTOM_GRIND_25 战术回补/止盈闭环对账（超额批次清零后生效）
  if (planMode === 'BOTTOM_GRIND_25') {
    if (hasOpenExcess) {
      if (tacticalShares !== 0 || tacticalEntryPriceRaw !== null || tacticalEntryDate !== null) {
        tacticalShares = 0;
        tacticalEntryPriceRaw = null;
        tacticalEntryPriceMilli = null;
        tacticalEntryDate = null;
        planMutated = true;
      }
    } else if (portfolioTableExists(input.portfolioDb, 'account_event')) {
      const execDates = tranches
        .filter(t => t.status === 'EXECUTED' && t.executed_date)
        .map(t => t.executed_date!)
        .sort();
      const hasExecutedExcess = execDates.length > 0;
      const excessEndDate = execDates.at(-1) ?? plan.created_at;
      const events = input.portfolioDb.prepare(
        "SELECT event_type, occurred_on, quantity, price_milli FROM account_event WHERE account_id = ? AND ts_code = ? AND event_type IN ('TRADE_BUY','BUY','TRADE_SELL','SELL') AND occurred_on >= ? AND occurred_on <= ? AND reversed_by IS NULL ORDER BY occurred_on ASC, rowid ASC",
      ).all(input.accountId, tsCode, hasExecutedExcess ? excessEndDate : plan.created_at, input.asOf) as Array<{
        event_type: string;
        occurred_on: string;
        quantity: number;
        price_milli: number;
      }>;
      const hasTacticalActivity = events.some(e => {
        const isBuy = e.event_type === 'TRADE_BUY' || e.event_type === 'BUY';
        return isBuy || !hasExecutedExcess || e.occurred_on > excessEndDate;
      });
      if (hasTacticalActivity) {
        let tacQty = 0;
        // 原始均价用于回写（事件日基准）；复权均价用于止盈/参考价比较（asOf 基准）。
        let tacEntryPxRaw: number | null = null;
        let tacEntryPxAdj: number | null = null;
        let tacEntryDt: string | null = null;
        let swings = 0;
        let replayLastSellPxRaw = lastExecPriceRaw;
        let replayLastSellPx = lastExecPriceMilli;
        let replayLastSellDt = lastExecDate;
        for (const ev of events) {
          const isBuy = ev.event_type === 'TRADE_BUY' || ev.event_type === 'BUY';
          const qty = Math.max(0, Math.round(Number(ev.quantity) || 0));
          const px = Math.round(Number(ev.price_milli) || 0);
          if (qty <= 0 || px <= 0) continue;
          const pxAdj = adjustPrice(px, ev.occurred_on);
          if (isBuy) {
            if (hasExecutedExcess && ev.occurred_on < excessEndDate) continue;
            const totalCostRaw: number = tacQty * (tacEntryPxRaw ?? px) + qty * px;
            const totalCostAdj: number = tacQty * (tacEntryPxAdj ?? pxAdj) + qty * pxAdj;
            tacQty += qty;
            tacEntryPxRaw = tacQty > 0 ? Math.round(totalCostRaw / tacQty) : px;
            tacEntryPxAdj = tacQty > 0 ? Math.round(totalCostAdj / tacQty) : pxAdj;
            if (!tacEntryDt) tacEntryDt = ev.occurred_on;
          } else if (tacQty > 0) {
            if (qty >= tacQty) {
              tacQty = 0;
              tacEntryPxRaw = null;
              tacEntryPxAdj = null;
              tacEntryDt = null;
              swings += 1;
            } else {
              tacQty -= qty;
            }
            if (!replayLastSellDt || ev.occurred_on >= replayLastSellDt) {
              replayLastSellDt = ev.occurred_on;
              replayLastSellPxRaw = px;
              replayLastSellPx = pxAdj;
            }
          } else if (!hasExecutedExcess || ev.occurred_on > excessEndDate) {
            if (!replayLastSellDt || ev.occurred_on >= replayLastSellDt) {
              replayLastSellDt = ev.occurred_on;
              replayLastSellPxRaw = px;
              replayLastSellPx = pxAdj;
            }
          }
        }
        if (input.currentShares < tacQty) {
          tacQty = Math.floor(Math.max(0, input.currentShares) / 100) * 100;
          if (tacQty === 0) {
            tacEntryPxRaw = null;
            tacEntryPxAdj = null;
            tacEntryDt = null;
          }
        }
        if (
          tacQty !== tacticalShares
          || tacEntryPxRaw !== tacticalEntryPriceRaw
          || tacEntryDt !== tacticalEntryDate
          || swings !== completedSwingCount
          || replayLastSellPxRaw !== lastExecPriceRaw
          || replayLastSellDt !== lastExecDate
        ) {
          tacticalShares = tacQty;
          tacticalEntryPriceRaw = tacEntryPxRaw;
          tacticalEntryDate = tacEntryDt;
          completedSwingCount = swings;
          lastExecPriceRaw = replayLastSellPxRaw;
          lastExecDate = replayLastSellDt;
          planMutated = true;
        }
        // 决策口径每轮都采用同一 asOf 基准的 replay 加权均价：多笔跨除权买入时，
        // 它与「原始加权均价按首笔日期一次性折算」不同；落库仍只保存事件日原始价。
        tacticalEntryPriceMilli = tacEntryPxAdj;
        lastExecPriceMilli = replayLastSellPx;
      }
    }
    if (input.currentShares === 0 && tacticalShares > 0) {
      tacticalShares = 0;
      tacticalEntryPriceRaw = null;
      tacticalEntryPriceMilli = null;
      tacticalEntryDate = null;
      planMutated = true;
    }
  }

  const refDate = lastExecDate ?? plan.created_at;
  // 锚定价仅在无 later last-exec 价格时参与参考价：从数据库原始价一次性换算到 asOf 基准，
  // 结果只用于本次评估、绝不写回；基准日或因子缺失时保留原始价并在报告中本地化披露。
  const anchorConversion = lastExecPriceMilli === null
    ? convertAnchorPriceToAsOf({
      anchorPriceMilli: plan.anchor_price_milli,
      basisDate: plan.anchor_trade_date,
      asOf: input.asOf,
      factorAt: adjConverter?.factorAt ?? null,
    })
    : null;
  const anchorBasisNoteZh = anchorConversion?.noteZh ?? null;
  const refPriceMilli = lastExecPriceMilli ?? anchorConversion?.priceMilli ?? plan.anchor_price_milli;
  const reboundTriggerMilli = Math.round(refPriceMilli * 1.08);
  const supportFloorMilli = plan.support_floor_milli ?? null;
  const qfq = loadEtfQfqCloses(input.marketDb, tsCode, input.asOf, 180);
  const ma60Info = computeEtfMa60Breakdown(qfq, refDate);
  const rawSchedule = resolveCalendarSchedule(input.marketDb, refDate, input.asOf);
  const schedule = planMode === 'BOTTOM_GRIND_25'
    ? { ...rawSchedule, isFirstTradeDayOfMonth: false, nextMonthlyTriggerDate: null }
    : rawSchedule;

  const grindInfo = planMode === 'BOTTOM_GRIND_25'
    ? computeEtfGrindIndicators({
      qfq,
      asOf: input.asOf,
      currentCloseMilli: input.currentCloseMilli,
      supportFloorMilli,
      lastExecPriceMilli,
      lastExecDate,
      tradeDaysSinceLast: rawSchedule.tradeDaysSinceLast,
      marketRegime: input.marketRegime,
    })
    : null;

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

  const maxSellableLots = Math.floor(Math.max(0, input.sellableShares) / 100) * 100;
  let recommendedSellShares = 0;
  let recommendedBuyShares = 0;
  let activeReason: TrancheTriggerReason | null = null;

  // 3) 仅在 plan 处于 ACTIVE 时检查触发规则。
  if (planStatus === 'ACTIVE') {
    const alreadyTriggered = tranches.filter(t => t.status === 'TRIGGERED');
    const pending = tranches.filter(t => t.status === 'PENDING');
    if (alreadyTriggered.length === 0 && pending.length > 0) {
      const supportFloorHit = planMode === 'BOTTOM_GRIND_25'
        ? Boolean(grindInfo?.guards.support_breakdown_2d)
        : (input.currentCloseMilli !== null && supportFloorMilli !== null && input.currentCloseMilli < supportFloorMilli);
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
        && supportFloorHit
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
      } else if (planMode === 'STANDARD' && schedule.isFirstTradeDayOfMonth && schedule.tradeDaysSinceLast >= 12) {
        const first = pending[0];
        first.status = 'TRIGGERED';
        first.trigger_date = input.asOf;
        first.trigger_reason = 'MONTHLY_SCHEDULE';
        updatedTranches.push({ ...first });
      }
    }

    const triggeredAfter = tranches.filter(t => t.status === 'TRIGGERED');
    if (triggeredAfter.length > 0) {
      const rawSellShares = triggeredAfter.reduce((sum, t) => sum + t.planned_shares, 0);
      recommendedSellShares = Math.min(rawSellShares, maxSellableLots);
      activeReason = triggeredAfter[0]?.trigger_reason ?? null;
    } else if (planMode === 'BOTTOM_GRIND_25' && grindInfo && input.currentCloseMilli !== null && input.currentCloseMilli > 0) {
      const cMilli = input.currentCloseMilli;
      const guards = grindInfo.guards;
      if (tacticalShares >= 100 && tacticalEntryPriceMilli !== null) {
        const tpGrindHit = !guards.in_bull_trend && cMilli >= Math.round(tacticalEntryPriceMilli * 1.075);
        const tpBullHit = guards.in_bull_trend && (
          (cMilli >= Math.round(tacticalEntryPriceMilli * 1.15) && grindInfo.ma5Milli !== null && cMilli < grindInfo.ma5Milli)
          || (cMilli >= Math.round(tacticalEntryPriceMilli * 1.04) && grindInfo.ma20Milli !== null && cMilli < grindInfo.ma20Milli)
        );
        if (tpGrindHit || tpBullHit) {
          const qty = Math.min(Math.floor(tacticalShares / 100) * 100, maxSellableLots);
          if (qty >= 100) {
            recommendedSellShares = qty;
            activeReason = 'GRIND_TACTICAL_TAKE_PROFIT';
          }
        }
      } else if (
        weightBps !== null
        && weightBps >= 3400
        && (
          (guards.rsi14 !== null && guards.rsi14 >= 68 && grindInfo.ma5Milli !== null && cMilli < grindInfo.ma5Milli)
          || (grindInfo.ma20Milli !== null && grindInfo.prevCloseMilli !== null && cMilli >= Math.round(grindInfo.ma20Milli * 1.10) && cMilli < grindInfo.prevCloseMilli)
        )
      ) {
        const driftExcess = Math.max(0, Math.floor((input.currentShares - dynamicKeepShares) / 100) * 100);
        const qty = Math.min(driftExcess, maxSellableLots);
        if (qty >= 100) {
          recommendedSellShares = qty;
          activeReason = 'GRIND_OVERWEIGHT_DRIFT_HARVEST';
        }
      } else if (
        tacticalShares === 0
        && pending.length === 0
        && (input.circuitBreakerStatus ?? 'NORMAL') === 'NORMAL'
        // EXP-V3-04 回补条件（MA60 走平、折价、超卖、右侧止稳）之外，系统附加两道 TS 护栏：
        // 实时仓位必须 <30%（weightBps < 3000）且距上次执行 >=3 个交易日（含在
        // all_reload_guards_ready 内）。二者都不是 EXP-V3-04/MASTER 的签发条件，是否保留由所有者决策。
        && (weightBps === null || weightBps < 3000)
        && guards.all_reload_guards_ready
        && input.navCents
        && input.navCents > 0
      ) {
        const priceCents = cMilli / 10;
        const slotBudgetCents = Math.round(input.navCents * (plan.tactical_slot_bps / 10000));
        const maxTotalValCents = Math.round(input.navCents * ((plan.target_keep_bps + plan.tactical_slot_bps) / 10000));
        const currentValCents = input.currentShares * priceCents;
        const headroomCents = Math.max(0, maxTotalValCents - currentValCents);
        const cashUsableCents = input.availableCashCents !== undefined
          ? Math.max(0, input.availableCashCents - 10_000)
          : headroomCents;
        const deployBudget = Math.min(slotBudgetCents, headroomCents, cashUsableCents);
        const buyLots = Math.floor(((Math.max(0, deployBudget - 500)) / priceCents) / 100) * 100;
        if (buyLots >= 100 && buyLots * priceCents >= 100_000) {
          recommendedBuyShares = buyLots;
          activeReason = 'GRIND_OVERSOLD_RELOAD';
        }
      }
    }
  }

  const triggered = tranches.filter(t => t.status === 'TRIGGERED');
  const execCount = tranches.filter(t => t.status === 'EXECUTED').length;
  const trigNos = triggered.map(t => `第${t.tranche_no}批`).join('、');
  const liveWeightPct = weightBps !== null ? Math.round((weightBps / 100) * 100) / 100 : null;
  const targetKeepPct = Math.round((plan.target_keep_bps / 100) * 100) / 100;
  const tacticalSlotPct = Math.round((plan.tactical_slot_bps / 100) * 100) / 100;
  const maxGrindWeightPct = Math.round(((plan.target_keep_bps + plan.tactical_slot_bps) / 100) * 100) / 100;
  const tacTpCny = tacticalEntryPriceMilli !== null ? Math.round(tacticalEntryPriceMilli * 1.075) / 1000 : null;

  let statusSummaryZh: string;
  if (planMode === 'BOTTOM_GRIND_25') {
    if (recommendedBuyShares >= 100 && activeReason === 'GRIND_OVERSOLD_RELOAD') {
      statusSummaryZh = `${tsCode} 通过25%底仓磨底降本 EXP-V3-04 回补条件（MA60走平、折价超卖、右侧止稳），并满足系统附加护栏（冷却≥3个交易日、仓位<30%，非 EXP-V3-04 签发条件），建议战术回补 ${recommendedBuyShares} 份（目标仓位封顶 ${maxGrindWeightPct.toFixed(0)}%，回补后按 +7.5% 或牛市均线追踪止盈）。`;
    } else if (recommendedSellShares >= 100 && (activeReason === 'GRIND_TACTICAL_TAKE_PROFIT' || activeReason === 'GRIND_OVERWEIGHT_DRIFT_HARVEST')) {
      statusSummaryZh = `${tsCode} 已触发${TRIGGER_REASON_ZH[activeReason]}，建议卖出 ${recommendedSellShares} 份回归 ${targetKeepPct.toFixed(0)}% 核心底仓。`;
    } else if (triggered.length > 0 && recommendedSellShares >= 100) {
      statusSummaryZh = `${tsCode}（25%底仓模式）已触发${trigNos}超额减仓（${TRIGGER_REASON_ZH[activeReason ?? 'REBOUND_8PCT']}），建议卖出 ${recommendedSellShares} 份。`;
    } else if (hasOpenExcess) {
      const floorText = downsideMode === 'SUPPORT_FLOOR' && downsideProtectMilli !== null
        ? `，或连续2日跌破磨底防守位 ${(downsideProtectMilli / 1000).toFixed(3)} 元（已取消低位月度强卖）`
        : '（已取消低位月度强卖）';
      statusSummaryZh = `${tsCode} 已切换25%底仓磨底降本模式：目标保留 ${targetKeepShares} 份，已执行 ${execCount}/${tranches.length} 批超额减仓；下一高抛条件为反弹 +8% 至 ${(reboundTriggerMilli / 1000).toFixed(3)} 元${floorText}。`;
    } else if (tacticalShares >= 100 && tacTpCny !== null) {
      statusSummaryZh = `${tsCode} 处于25%核心底仓（${targetKeepShares} 份）+ ${tacticalShares} 份机动降本持仓中；基础止盈 +7.5% 目标价 ${tacTpCny.toFixed(3)} 元（不设窄止损，由账户熔断兜底）。`;
    } else {
      const g = grindInfo?.guards;
      const slopeDesc = g?.ma60_slope10_pct !== null && g?.ma60_slope10_pct !== undefined
        ? (g.ma60_flat_ready
          ? `60日均线10日斜率已走平（${g.ma60_slope10_pct >= 0 ? '+' : ''}${g.ma60_slope10_pct.toFixed(2)}%）`
          : `60日均线10日斜率仍下行（${g.ma60_slope10_pct.toFixed(2)}%，禁止左侧接飞刀）`)
        : '60日均线斜率计算中';
      const reloadDesc = g?.reload_target_cny !== null && g?.reload_target_cny !== undefined
        ? `折价7%回补目标价 ${g.reload_target_cny.toFixed(3)} 元`
        : '深折价回补条件观察中';
      statusSummaryZh = `${tsCode} 维持 ${targetKeepPct.toFixed(0)}% 战略底仓震荡磨底观察中（待命中 ${tacticalSlotPct.toFixed(0)}% 战术降本槽）；${slopeDesc}，${reloadDesc}。`;
    }
  } else {
    statusSummaryZh = planStatus === 'COMPLETED'
      ? `${tsCode} 四批换马减仓已全部达标完成（现持 ${input.currentShares} 份）。`
      : triggered.length > 0
        ? `${tsCode} 已触发${trigNos}减仓（${TRIGGER_REASON_ZH[activeReason ?? 'MONTHLY_SCHEDULE']}），建议卖出 ${recommendedSellShares} 份。`
        : downsideMode === 'SUPPORT_FLOOR' && downsideProtectMilli !== null
          ? `${tsCode} 四批换马已执行 ${execCount}/${tranches.length} 批（磨底观察中）；下一观察条件：反弹至 ${(reboundTriggerMilli / 1000).toFixed(3)} 元、跌破箱体防守位 ${(downsideProtectMilli / 1000).toFixed(3)} 元或月度窗口 ${fmtYmdZh(schedule.nextMonthlyTriggerDate)}。`
          : `${tsCode} 四批换马已执行 ${execCount}/${tranches.length} 批；下一观察条件：月度窗口 ${schedule.nextMonthlyTriggerDate ?? '待日历顺延'} 或反弹至 ${(reboundTriggerMilli / 1000).toFixed(3)} 元。`;
  }
  // 锚定价基准/复权因子缺失时把本地化披露附在状态摘要末尾；不改变任何建议或阻断报告。
  if (anchorBasisNoteZh) statusSummaryZh = `${statusSummaryZh} ${anchorBasisNoteZh}`;

  return {
    schema: 'portfolio-deconcentration-plan/1.0',
    plan_present: true,
    account_id: input.accountId,
    ts_code: tsCode,
    as_of_trade_date: input.asOf,
    plan_status: planStatus,
    plan_mode: planMode,
    initial_shares: plan.initial_shares,
    current_shares: input.currentShares,
    sellable_shares: input.sellableShares,
    target_keep_bps: plan.target_keep_bps,
    target_keep_pct: targetKeepPct,
    target_keep_shares: targetKeepShares,
    tactical_slot_bps: plan.tactical_slot_bps,
    tactical_slot_pct: tacticalSlotPct,
    max_grind_weight_pct: maxGrindWeightPct,
    drift_harvest_trigger_pct: 34,
    preemptive_weight_threshold_pct: 30,
    normal_lifeline_pct: 15,
    reload_discount_pct: 7,
    take_profit_pct: 7.5,
    rebound_pct: 8,
    tactical_shares: tacticalShares,
    tactical_entry_price_cny: tacticalEntryPriceMilli !== null ? tacticalEntryPriceMilli / 1000 : null,
    tactical_entry_date: tacticalEntryDate,
    tactical_take_profit_cny: tacTpCny,
    completed_swing_count: completedSwingCount,
    live_weight_pct: liveWeightPct,
    reference_price_milli: refPriceMilli,
    reference_price_cny: refPriceMilli / 1000,
    anchor_trade_date: plan.anchor_trade_date,
    anchor_basis_note_zh: anchorBasisNoteZh,
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
    recommended_buy_shares: recommendedBuyShares,
    active_trigger_reason: activeReason,
    tranches,
    grind_guards: grindInfo?.guards ?? null,
    status_summary_zh: statusSummaryZh,
    pending_mutations: {
      plan_updates: planMutated ? {
        plan_id: plan.plan_id,
        status: planStatus,
        // 回写事件日原始价：复权换算只在读取/比较时进行，避免跨日重复复权。
        last_exec_price_milli: lastExecPriceRaw,
        last_exec_date: lastExecDate,
        tactical_shares: tacticalShares,
        tactical_entry_price_milli: tacticalEntryPriceRaw,
        tactical_entry_date: tacticalEntryDate,
        completed_swing_count: completedSwingCount,
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
          SET status = ?, last_exec_price_milli = ?, last_exec_date = ?,
              tactical_shares = ?, tactical_entry_price_milli = ?, tactical_entry_date = ?,
              completed_swing_count = ?
          WHERE plan_id = ?
        `).run(
          plan_updates.status,
          plan_updates.last_exec_price_milli,
          plan_updates.last_exec_date,
          plan_updates.tactical_shares,
          plan_updates.tactical_entry_price_milli,
          plan_updates.tactical_entry_date,
          plan_updates.completed_swing_count,
          plan_updates.plan_id,
        );
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
