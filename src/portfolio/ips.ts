/**
 * IPS v1（投资政策书）与调仓提案：纯函数、整数运算、只读、不下单。
 *
 * 状态：v0 原型，未接入日报/决策管线。用户已确认的前提（2026-11-11）：
 * - 回撤 20% 可接受，但**不因此立即卖出 159558**；降仓由风险触发，而非日历触发。
 * - 以后没有入金/出金。
 * - 费率：ETF/个股佣金万 2.5（用户确认）；最低 5 元仍为假设；159558/560390 为万 0.5 免五。
 * - 债券 ETF 每手约 1 万元，债券格只能是"0 或 1 手"；海外 QDII 溢价过高时不买。
 *
 * 金额一律用分（cents），价格用毫元（1/1000 元），避免浮点。
 */

export type AssetClass = 'equity_core' | 'bond' | 'gold' | 'overseas' | 'cash' | 'satellite';

export interface ClassTarget { target_bps: number; band_bps: number }

export interface DrawdownStep {
  /** 账户回撤达到该基点时触发 */
  at_bps: number;
  /** 触发后的动作；只产生"降风险提案"，不自动交易 */
  action: 'REVIEW' | 'REDUCE_SATELLITE';
  /** REDUCE_SATELLITE：卖出卫星层市值的比例（基点，10000=100%） */
  satellite_sell_fraction_bps?: number;
}

export interface IpsV1 {
  version: string;
  targets: Record<AssetClass, ClassTarget>;
  satellite_cap_bps: number;
  single_etf_cap_bps: number;
  single_stock_cap_bps: number;
  /** 回撤阶梯（升序）；20% 为已接受的容忍度，不是触发线 */
  drawdown_steps: DrawdownStep[];
  accepted_drawdown_bps: number;
  /** 海外 QDII 买入的最大可接受溢价（基点） */
  overseas_max_premium_bps: number;
  /** 非免五品种的最小单笔成交额（分），低于此不建议交易 */
  min_trade_cents: number;
  lot_size: number;
}

export const IPS_V1: IpsV1 = {
  version: 'ips-v1.0.0-draft',
  targets: {
    equity_core: { target_bps: 2500, band_bps: 500 },
    bond: { target_bps: 2000, band_bps: 1700 },   // 一手约 16.6%，只能 0 或 1 手
    gold: { target_bps: 1000, band_bps: 300 },
    overseas: { target_bps: 1000, band_bps: 300 },
    cash: { target_bps: 500, band_bps: 500 },
    satellite: { target_bps: 3000, band_bps: 0 }, // 上限而非目标
  },
  satellite_cap_bps: 3000,
  single_etf_cap_bps: 1500,
  single_stock_cap_bps: 500,
  drawdown_steps: [
    { at_bps: 1000, action: 'REVIEW' },
    { at_bps: 1500, action: 'REDUCE_SATELLITE', satellite_sell_fraction_bps: 3333 },
    { at_bps: 1800, action: 'REDUCE_SATELLITE', satellite_sell_fraction_bps: 5000 },
  ],
  accepted_drawdown_bps: 2000,
  overseas_max_premium_bps: 200,
  min_trade_cents: 500_000,
  lot_size: 100,
};

export interface PositionInput {
  code: string;
  name?: string;
  asset_class: AssetClass;
  shares: number;
  sellable_shares: number;
  price_milli: number;
  /** 费率：免五品种 commission_min_cents = 0 */
  commission_rate: number;
  commission_min_cents: number;
}

export interface BuyCandidate {
  code: string;
  asset_class: Exclude<AssetClass, 'cash' | 'satellite'>;
  price_milli: number;
  commission_rate: number;
  commission_min_cents: number;
  /** 海外品种的场内溢价（基点）；缺失视为未知 → 不买 */
  premium_bps?: number | null;
}

export interface ProposalInput {
  ips: IpsV1;
  cash_cents: number;
  positions: PositionInput[];
  buy_candidates: BuyCandidate[];
  /** 当前账户回撤（基点），自高水位 */
  drawdown_bps: number;
}

export interface ProposedOrder {
  side: 'SELL' | 'BUY';
  code: string;
  shares: number;
  est_amount_cents: number;
  est_commission_cents: number;
  reason: string;
}

export interface Proposal {
  ips_version: string;
  nav_cents: number;
  weights_bps: Record<AssetClass, number>;
  drift: { asset_class: AssetClass; target_bps: number; current_bps: number; status: 'IN_BAND' | 'OVER' | 'UNDER' | 'CAP_BREACH' }[];
  triggered_steps: DrawdownStep[];
  orders: ProposedOrder[];
  notes: string[];
}

const valueCents = (shares: number, priceMilli: number): number => Math.round((shares * priceMilli) / 10);
export const commissionCents = (grossCents: number, rate: number, minCents: number): number =>
  grossCents <= 0 ? 0 : Math.max(Math.round(grossCents * rate), minCents);
const bps = (part: number, whole: number): number => (whole > 0 ? Math.round((part * 10000) / whole) : 0);

export function proposeRebalance(input: ProposalInput): Proposal {
  const { ips } = input;
  const notes: string[] = [];
  const classValue: Record<AssetClass, number> = { equity_core: 0, bond: 0, gold: 0, overseas: 0, cash: input.cash_cents, satellite: 0 };
  for (const p of input.positions) classValue[p.asset_class] += valueCents(p.shares, p.price_milli);
  const nav = Object.values(classValue).reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(Object.entries(classValue).map(([k, v]) => [k, bps(v, nav)])) as Record<AssetClass, number>;

  const drift: Proposal['drift'] = (Object.keys(ips.targets) as AssetClass[]).map(asset_class => {
    const t = ips.targets[asset_class];
    const current = weights[asset_class];
    let status: Proposal['drift'][number]['status'] = 'IN_BAND';
    if (asset_class === 'satellite') status = current > ips.satellite_cap_bps ? 'CAP_BREACH' : 'IN_BAND';
    else if (current > t.target_bps + t.band_bps) status = 'OVER';
    else if (current < t.target_bps - t.band_bps) status = 'UNDER';
    return { asset_class, target_bps: t.target_bps, current_bps: current, status };
  });

  const triggered = ips.drawdown_steps.filter(s => input.drawdown_bps >= s.at_bps);
  const orders: ProposedOrder[] = [];
  const reduce = triggered.filter(s => s.action === 'REDUCE_SATELLITE').at(-1);
  let proceeds = 0;

  if (reduce) {
    const sellBudget = Math.floor((classValue.satellite * (reduce.satellite_sell_fraction_bps ?? 0)) / 10000);
    let remaining = sellBudget;
    const sats = input.positions.filter(p => p.asset_class === 'satellite').sort((a, b) => valueCents(b.shares, b.price_milli) - valueCents(a.shares, a.price_milli));
    for (const p of sats) {
      if (remaining <= 0) break;
      const lotCents = valueCents(ips.lot_size, p.price_milli);
      const lots = Math.min(Math.floor(p.sellable_shares / ips.lot_size), Math.max(1, Math.round(remaining / lotCents)));
      if (lots <= 0) { notes.push(`${p.code} 无可卖整手（T+1 或不足一手）`); continue; }
      const shares = lots * ips.lot_size;
      const amount = valueCents(shares, p.price_milli);
      const fee = commissionCents(amount, p.commission_rate, p.commission_min_cents);
      orders.push({ side: 'SELL', code: p.code, shares, est_amount_cents: amount, est_commission_cents: fee, reason: `回撤 ${(input.drawdown_bps / 100).toFixed(2)}% 触发降风险档（卫星层卖出约 ${(reduce.satellite_sell_fraction_bps ?? 0) / 100}%）` });
      remaining -= amount;
      proceeds += amount - fee;
    }
  } else {
    notes.push(input.drawdown_bps >= ips.drawdown_steps[0].at_bps
      ? '已进入复核档：冻结卫星加仓；未到降仓档，继续持有（用户已接受至 20% 的回撤）。'
      : '未触发任何回撤档：继续持有，不因集中度本身而卖出（用户决策）。');
  }

  // 买入：只用现金超出现金目标的部分 + 降仓回款；永不为买入而卖出核心品种。
  const cashTargetCents = Math.floor((nav * ips.targets.cash.target_bps) / 10000);
  let spendable = Math.max(0, input.cash_cents + proceeds - cashTargetCents);
  const gaps = drift.filter(d => d.asset_class !== 'satellite' && d.asset_class !== 'cash' && d.status === 'UNDER');
  for (const gap of gaps) {
    const cand = input.buy_candidates.find(c => c.asset_class === gap.asset_class);
    if (!cand) { notes.push(`${gap.asset_class}：没有候选品种`); continue; }
    if (gap.asset_class === 'overseas' && !(typeof cand.premium_bps === 'number' && cand.premium_bps <= ips.overseas_max_premium_bps)) {
      notes.push(`${cand.code}：溢价${typeof cand.premium_bps === 'number' ? (cand.premium_bps / 100).toFixed(2) + '%' : '未知'}，高于 ${(ips.overseas_max_premium_bps / 100).toFixed(2)}% 上限，不买（海外格保持空置）`);
      continue;
    }
    const wantCents = Math.floor((nav * (gap.target_bps - gap.current_bps)) / 10000);
    const budget = Math.min(wantCents, spendable);
    const lotCents = valueCents(ips.lot_size, cand.price_milli);
    const lots = Math.floor(budget / lotCents);
    if (lots <= 0) { notes.push(`${cand.code}：预算 ${(budget / 100).toFixed(2)} 元不足一手（${(lotCents / 100).toFixed(2)} 元）`); continue; }
    const amount = lots * lotCents;
    const fee = commissionCents(amount, cand.commission_rate, cand.commission_min_cents);
    if (amount < ips.min_trade_cents && cand.commission_min_cents > 0) { notes.push(`${cand.code}：单笔 ${(amount / 100).toFixed(2)} 元低于最小成交额，费用占比过高，跳过`); continue; }
    orders.push({ side: 'BUY', code: cand.code, shares: lots * ips.lot_size, est_amount_cents: amount, est_commission_cents: fee, reason: `${gap.asset_class} 低于目标 ${(gap.target_bps / 100).toFixed(1)}%（当前 ${(gap.current_bps / 100).toFixed(1)}%）` });
    spendable -= amount + fee;
  }

  if (weights.satellite > ips.satellite_cap_bps) notes.push(`卫星层 ${(weights.satellite / 100).toFixed(2)}% 超过上限 ${(ips.satellite_cap_bps / 100).toFixed(0)}%：由回撤触发或反弹分档降低，不在无证据时一次性卖出。`);
  return { ips_version: ips.version, nav_cents: nav, weights_bps: weights, drift, triggered_steps: triggered, orders, notes };
}
