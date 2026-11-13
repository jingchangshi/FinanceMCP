/**
 * 券商摊薄成本映射层（broker diluted cost）。
 *
 * 背景：账本（ledger.ts）用的是**平均成本法**——卖出时按份额比例扣减成本，
 * 剩余成本均价基本不变。本模块采用一种摊薄口径：卖出时把实际卖出所得（净额）
 * 从总成本里整体扣掉，因此卖出会显著改变剩余份额的成本均价。不同券商的展示口径可能不同。
 *
 * 本模块只做**只读映射**：
 * 用同一份 baseline + account_event 重放，额外算出一条摊薄成本曲线，与账本口径并列输出。
 *
 * 摊薄口径定义（与用户确认）：
 *   - 期初：total_cost = 基线数量 × 基线成本价
 *   - TRADE_BUY ：total_cost += gross + fee + tax；qty += quantity
 *   - TRADE_SELL：total_cost -= (gross − fee − tax)；qty -= quantity
 *   - SPLIT     ：qty 按比例调整；非零持仓时 total_cost 不变
 *   - 持仓数量归零时 total_cost 清零，下一次买入从新一轮成本开始
 *   - 摊薄成本均价 = total_cost / qty（qty > 0 时）
 *
 * 重要：本模块不写库、不改账本、不改变 replayAccount 的任何结论，只为展示与核对。
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadReplayEvents, readBaseline, replayAccount, splitQuantity } from './ledger.js';

export interface DilutedCostEvent {
  event_id: string;
  event_type: string;
  occurred_on: string;
  ts_code: string | null;
  quantity: number | null;
  price_milli: number | null;
  gross_cents: number | null;
  fee_cents: number;
  tax_cents: number;
  /** 本次事件对总成本的整数厘影响，包括清仓重置。 */
  cost_milli_delta: number;
  /** 事件发生后的份额。 */
  quantity_after: number;
  /** 事件发生后的摊薄成本总成本（整数厘）。 */
  total_cost_milli_after: number;
  /** 事件发生后的摊薄成本均价（元/份，6 位小数）。 */
  diluted_cost_after: number | null;
}

export interface DilutedCostRow {
  ts_code: string;
  name: string | null;
  quantity: number;
  /** 券商摊薄口径：总成本（分）。 */
  diluted_total_cost_cents: number;
  /** 券商摊薄口径：成本均价（元/份，6 位小数）；数量为 0 时为 null。 */
  diluted_cost_per_share: number | null;
  /** 账本平均成本法：总成本（分），来自 replayAccount，用于并列对照。 */
  ledger_total_cost_cents: number;
  /** 账本平均成本法：成本均价（元/份）。 */
  ledger_cost_per_share: number | null;
  /** 摊薄减去账本的差额（元/份）；两种口径一致的标的不为 0 只说明期间有过卖出。 */
  difference_per_share: number | null;
  /** 已实现盈亏（账本口径，分）。摊薄口径下"已实现"不适用，不做假算。 */
  ledger_realized_pnl_cents: number;
  events: DilutedCostEvent[];
}

export interface DilutedCostView {
  account_id: string;
  as_of: string | null;
  baseline: { as_of: string; snapshot_id: string | null; cash_cents: number };
  method: 'broker_diluted_cost';
  /** 与账本口径的差异说明，直接可放进报告脚注。 */
  method_note: string;
  positions: DilutedCostRow[];
  assumptions: string[];
  warnings: string[];
}

interface AccState {
  quantity: number;
  total_cost_milli: number;
  events: DilutedCostEvent[];
}

const METHOD_NOTE =
  '成本口径说明：本表为摊薄成本估算，按持仓周期计算，买入计入成本、卖出扣除净所得，份额归零时成本清零；'
  + '具体请以券商口径核对。账本另用平均成本法，卖出时按份额比例扣减成本。';

function milliToCents(milli: number): number {
  return Math.round(milli / 10);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 从 baseline + account_event 推演券商摊薄成本。
 * 只读；不修改任何表。
 */
export function buildDilutedCostView(
  db: DatabaseSync,
  accountId: string,
  options: { asOf?: string } = {},
): DilutedCostView {
  const baseline = readBaseline(db, accountId);
  if (!baseline) {
    throw new Error(`账户 ${accountId} 没有账本基线，无法计算摊薄成本；请先运行 portfolio-ledger-init`);
  }
  const asOf = options.asOf ?? null;

  // 基线快照里的持仓与成本价是摊薄口径的起点。
  const snapshotPositions = db
    .prepare('SELECT ts_code, name, quantity, ref_cost_milli FROM position WHERE snapshot_id = ?')
    .all(baseline.snapshot_id ?? '') as any[];

  const state = new Map<string, AccState>();
  const names = new Map<string, string | null>();
  for (const row of snapshotPositions) {
    const qty = Number(row.quantity ?? 0);
    if (qty === 0) continue;
    state.set(String(row.ts_code), {
      quantity: qty,
      total_cost_milli: Math.round(qty * Number(row.ref_cost_milli ?? 0)),
      events: [],
    });
    names.set(String(row.ts_code), row.name ?? null);
  }

  const events = loadReplayEvents(db, accountId, baseline.as_of, asOf ?? undefined);

  const warnings: string[] = [];
  const seenSymbols = new Set<string>();
  // 保存已经发生的事件及其摊薄成本影响；撤销只在撤销日生效。
  const effects = new Map<string, { code: string | null; quantity: number; cost: number; split: { num: number; den: number } | null }>();

  for (const event of events) {
    const target = event.event_type === 'REVERSE' ? effects.get(event.reverses_event_id ?? '') : undefined;
    const code = event.event_type === 'REVERSE' ? target?.code : event.ts_code;
    if (!code) {
      if (event.event_type !== 'REVERSE') effects.set(event.event_id, { code: null, quantity: 0, cost: 0, split: null });
      continue;
    }
    seenSymbols.add(code);
    if (!state.has(code)) {
      // 基线里没有的新标的：成本从 0 起算，这是正确行为（新建仓）。
      state.set(code, { quantity: 0, total_cost_milli: 0, events: [] });
      if (!names.has(code)) names.set(code, null);
    }
    const acc = state.get(code)!;
    const costBefore = acc.total_cost_milli;
    let delta = 0;
    let quantityDelta = 0;
    let split: { num: number; den: number } | null = null;

    switch (event.event_type) {
      case 'TRADE_BUY': {
        const qty = Number(event.quantity ?? 0);
        const gross = Number(event.gross_cents ?? 0);
        delta = (gross + event.fee_cents + event.tax_cents) * 10; // 分 → 厘
        quantityDelta = qty;
        acc.quantity += qty;
        acc.total_cost_milli += delta;
        break;
      }
      case 'TRADE_SELL': {
        const qty = Number(event.quantity ?? 0);
        const net = Number(event.gross_cents ?? 0) - event.fee_cents - event.tax_cents;
        delta = -net * 10;
        quantityDelta = -qty;
        acc.quantity -= qty;
        acc.total_cost_milli += delta;
        if (acc.quantity < 0) {
          warnings.push(`${code} 在 ${event.occurred_on} 卖出后份额为负（${acc.quantity}），请核对账本`);
        }
        break;
      }
      case 'SPLIT': {
        const num = Number(event.ratio_num ?? 1);
        const den = Number(event.ratio_den ?? 1);
        split = { num, den };
        acc.quantity = splitQuantity(acc.quantity, num, den);
        break;
      }
      case 'REVERSE': {
        // 与账本一致：只撤销已经重放过的目标；拆分按当前数量倒比例回退。
        if (target?.split) {
          acc.quantity = splitQuantity(acc.quantity, target.split.num, target.split.den, true);
          delta = -target.cost;
          acc.total_cost_milli += delta;
        } else if (target) {
          acc.quantity -= target.quantity;
          delta = -target.cost;
          acc.total_cost_milli += delta;
        }
        break;
      }
      case 'FEE': {
        // 独立费用是现金支出，账本不将它计入证券成本。
        break;
      }
      default:
        delta = 0;
        break;
    }

    // 无持仓时结束当前成本周期。记录实际变化，确保撤销原事件可恢复被清零的成本。
    if (acc.quantity === 0) acc.total_cost_milli = 0;
    delta = acc.total_cost_milli - costBefore;
    if (event.event_type !== 'REVERSE') {
      effects.set(event.event_id, { code, quantity: quantityDelta, cost: delta, split });
    }
    acc.events.push({
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_on: event.occurred_on,
      ts_code: code,
      quantity: event.quantity,
      price_milli: event.price_milli,
      gross_cents: event.gross_cents,
      fee_cents: event.fee_cents,
      tax_cents: event.tax_cents,
      cost_milli_delta: delta,
      quantity_after: acc.quantity,
      total_cost_milli_after: acc.total_cost_milli,
      diluted_cost_after: acc.quantity > 0 ? round6(acc.total_cost_milli / acc.quantity / 1000) : null,
    });
  }

  // 账本口径（平均成本法）做并列对照。
  const replay = replayAccount(db, accountId, { asOf: asOf ?? undefined });
  const ledgerByCode = new Map(replay.positions.map(p => [p.ts_code, p]));

  const codes = new Set<string>([...state.keys(), ...ledgerByCode.keys()]);
  const positions: DilutedCostRow[] = [...codes].sort().map(code => {
    const acc = state.get(code);
    const ledger = ledgerByCode.get(code);
    const quantity = acc?.quantity ?? ledger?.quantity ?? 0;
    const dilutedTotalMilli = acc?.total_cost_milli ?? 0;
    const dilutedPerShare = quantity > 0 ? round6(dilutedTotalMilli / quantity / 1000) : null;
    const ledgerPerShare = ledger ? round6(ledger.cost_milli_avg / 1000) : null;
    return {
      ts_code: code,
      name: names.get(code) ?? null,
      quantity,
      diluted_total_cost_cents: milliToCents(dilutedTotalMilli),
      diluted_cost_per_share: dilutedPerShare,
      ledger_total_cost_cents: milliToCents(ledger?.cost_milli_total ?? 0),
      ledger_cost_per_share: ledgerPerShare,
      difference_per_share: dilutedPerShare !== null && ledgerPerShare !== null
        ? round6(dilutedPerShare - ledgerPerShare) : null,
      ledger_realized_pnl_cents: ledger?.realized_pnl_cents ?? 0,
      events: acc?.events ?? [],
    };
  });

  // 有持仓但从未有过成交事件的标的：摊薄成本就是基线成本，说明一句避免误读。
  const baselineOnly = positions
    .filter(p => p.quantity !== 0 && p.events.length === 0)
    .map(p => p.ts_code);
  if (baselineOnly.length) {
    warnings.push(
      `以下标的自基线以来没有成交，摊薄成本等于基线成本：${baselineOnly.join('、')}`,
    );
  }
  if (seenSymbols.size === 0) {
    warnings.push('基线之后没有任何成交事件，摊薄成本与基线成本一致。');
  }

  return {
    account_id: accountId,
    as_of: asOf,
    baseline: {
      as_of: baseline.as_of,
      snapshot_id: baseline.snapshot_id ?? null,
      cash_cents: baseline.cash_cents,
    },
    method: 'broker_diluted_cost',
    method_note: METHOD_NOTE,
    positions,
    assumptions: [
      '摊薄口径：TRADE_SELL 把卖出净所得（成交额 − 费用 − 税）整体从总成本扣减，而非按份额比例扣减，因此卖出会改变剩余成本均价。',
      '买入成本包含佣金与税费；卖出净所得已扣除费用与税。',
      'SPLIT 按账本规则调整份额并向下取整；非零持仓时不改变总成本，撤销时按当时份额倒比例调整。',
      '持仓数量归零时摊薄总成本清零；后续买入开启新周期，撤销事件按其实际成本变化回退。',
      '这是本表采用的计算约定，不保证与所有券商展示口径一致。',
      '独立 FEE 只影响现金，不计入证券成本。',
      '撤销在其发生日回退已生效事件，之前的历史结果保留原事件。',
      '已实现盈亏只按账本平均成本法给出；摊薄口径下不另算「已实现」，避免两套数字互相污染。',
      '基线之前的事件已包含在基线成本中，不重复计入。',
    ],
    warnings,
  };
}
