/**
 * 七情景 × 五方案比较引擎（goal-1026 §5.2）。
 *
 * 设计边界（任务书 §5.2 / §2.3）：
 * - **情景幅度全部是假设或预先固定的声明式口径，不是预测，也不是历史回撤**：
 *   每个情景都带 `magnitude_basis`（来源口径）与 `assumed: true`，输出里逐情景注明。
 * - 同一组情景下对比 HOLD / REDUCE / ROTATE / DEFENSIVE / NO_ACTION，每个方案给出
 *   任务书规定的十列：总资产与现金、权益风险敞口、行业集中度、HHI、声明式压力损失、
 *   上涨参与度、交易费用、资金可用性、失效条件、尚未验证的信息。
 * - 情景 1（全市场权益下跌）与既有 `r1-asset-stress-1.0.0` 资产类别压力**同口径合并**：
 *   行冲击完全复用 `DEFAULT_ASSET_CLASS_STRESS.shocks`，因此情景 1 的声明式压力损失
 *   必须逐方案等于既有 `stress_after.loss_cents`（`decision-scenarios.test.mjs` 断言兼容）。
 * - 情景 4（行业间相关性上升）不改变单情景的点损失：相关性影响的是方差与分散化收益，
 *   本引擎不建模协方差矩阵，只在失效条件/未验证信息两列显式声明"分散收益被高估"的风险，
 *   不伪造一个"相关性损失"数字。
 * - 情景 5（流动性与滑点恶化）只放大**已计费用里的滑点估计部分**（声明倍数），
 *   佣金/印花税等真实费用项不变；滑点永远是估计值，不是已确认费用。
 * - 研究数量只来自调用方显式参数；本模块只做研究比较，**不产生任何交易动作**，
 *   也不引入任何未经用户确认的机械减仓阈值。
 *
 * 与 dailyReport.ts 的分工：post-trade 状态（方案各自的持仓/现金）由 dailyReport
 * 计算后传入，本模块只做情景冲击与逐列汇总，保持纯函数、确定性、不读库。
 */

import { DEFAULT_ASSET_CLASS_STRESS, ASSET_CLASS_STRESS_VERSION, INDUSTRY_BY_CODE, type AssetClass } from './decision.js';
import { THEME_BY_CODE } from './account.js';
import type { FeeBreakdown } from './fees.js';

export const SCENARIO_ENGINE_VERSION = 'r2-seven-scenario-1.0.0';

/** 情景行 ID；与任务书 §5.2 的七个具名情景一一对应。 */
export type ScenarioId =
  | 'market_equity_drawdown'
  | 'semiconductor_crash'
  | 'growth_valuation_compression'
  | 'cross_industry_correlation_up'
  | 'etf_liquidity_slippage'
  | 'semiconductor_rebound'
  | 'broad_rebound_semiconductor_lag';

export type ScenarioOption = 'HOLD' | 'REDUCE' | 'ROTATE' | 'DEFENSIVE' | 'NO_ACTION';

/** 持仓行（post-trade）：与 dailyReport 的 Position 结构同形，避免循环依赖。 */
export interface ScenarioPosition {
  ts_code: string;
  value: number;
  asset_class: AssetClass;
  theme: string;
  industry: string;
}

/** funding_status 取值与 DecisionComparison 一致（结构上重复声明，避免模块循环引用）。 */
export type ScenarioFundingStatus =
  | 'NO_TRADE' | 'QUANTITY_REQUIRED' | 'INVALID_QUANTITY' | 'PRICE_UNAVAILABLE'
  | 'SELLABILITY_UNKNOWN' | 'NOT_SELLABLE' | 'INSUFFICIENT_CASH' | 'FUNDED';

/**
 * 情景行：幅度为**声明式假设/预固定口径**，`assumed` 恒为 true。
 * `legacy_stress_merge` 标记情景 1 与 r1-asset-stress 的合并关系。
 */
export interface ScenarioRow {
  id: ScenarioId;
  /** 中文情景名（与任务书 §5.2 措辞一致）。 */
  name: string;
  assumption_note: string;
  assumed: true;
  /**
   * 行冲击（按持仓行生效）：
   * - `asset_class_shocks`：按资产类别冲击（情景 1 = r1-asset-stress 原值）；
   * - `code_shocks`：按代码的额外冲击，覆盖资产类别值（情景 2/3/6/7 的主题定向冲击）；
   * - 未被冲击覆盖的持仓 = 0（价格不变）。
   */
  asset_class_shocks: Record<AssetClass, number> | null;
  code_shocks: Record<string, number> | null;
  /** 参与"成长股"主题集合的情景（情景 3）；声明式主题映射，不是风格因子模型。 */
  growth_themes: string[] | null;
  /** 滑点放大倍数（情景 5）；只作用于滑点估计，不作用于佣金/印花税。 */
  slippage_multiplier: number | null;
  /** 情景特有说明（相关性口径、宽基代理口径等）。 */
  declared_notes: string[];
  /** 幅度来源口径：假设 vs 预固定统计，逐条注明"不是预测"。 */
  magnitude_basis: string;
  /** 情景 1 标记：行冲击 === r1-asset-stress，逐方案声明式压力损失与旧字段一致。 */
  legacy_stress_merge: boolean;
}

/** 成长风格主题的声明式集合（情景 3 的分组口径）。 */
export const GROWTH_THEMES: string[] = ['semiconductor_equipment', 'robotics', 'innovative_drug'];

/** 情景 7 的宽基代理：组合内除半导体设备主题外的持仓按宽基反弹口径处理（组合未直接持有宽基指数）。 */
const BROAD_REBOUND_PROXY = 0.06;

/**
 * 七个具名情景（任务书 §5.2）。所有幅度均为声明式假设，不是预测。
 * 顺序与任务书列举一致，便于逐条对照验收。
 */
export const SCENARIO_ROWS: ScenarioRow[] = [
  {
    id: 'market_equity_drawdown',
    name: '全市场权益下跌',
    assumption_note: '全市场权益普跌的声明式压力对照；沿用 r1-asset-stress 资产类别冲击口径。',
    assumed: true,
    asset_class_shocks: { ...DEFAULT_ASSET_CLASS_STRESS.shocks },
    code_shocks: null,
    growth_themes: null,
    slippage_multiplier: null,
    declared_notes: [
      `资产类别冲击直接复用 ${ASSET_CLASS_STRESS_VERSION}：权益−10%、债券−1%、黄金−5%、跨境−12%、未知−10%；现金与理财不计冲击。`,
      '本情景与既有 stress_after（r1-asset-stress）同口径合并：两者的声明式压力损失逐方案相等。',
    ],
    magnitude_basis: `预固定声明式口径（${ASSET_CLASS_STRESS_VERSION}），不是预测，也不是历史回撤统计。`,
    legacy_stress_merge: true,
  },
  {
    id: 'semiconductor_crash',
    name: '半导体设备单独大跌',
    assumption_note: '仅半导体设备主题持仓承受单行业深跌，其他资产价格不变的声明式对照。',
    assumed: true,
    asset_class_shocks: null,
    code_shocks: null, // 运行时按主题生成（见 scenarioShocksFor）
    growth_themes: null,
    slippage_multiplier: null,
    declared_notes: [
      '单行业事件压力按半导体设备主题 −30% 假设；只冲击该主题持仓，不外溢到其他行业——现实中的外溢程度未建模。',
    ],
    magnitude_basis: '声明式假设幅度（单行业压力 −30%），用于比较集中持仓的尾部损失；不是预测，也没有对应的单一历史统计。',
    legacy_stress_merge: false,
  },
  {
    id: 'growth_valuation_compression',
    name: '成长股整体估值压缩',
    assumption_note: '成长风格主题持仓统一估值压缩，价值/债券等资产不变的声明式对照。',
    assumed: true,
    asset_class_shocks: null,
    code_shocks: null,
    growth_themes: GROWTH_THEMES,
    slippage_multiplier: null,
    declared_notes: [
      '成长股代理 = 声明式主题集合（半导体设备/机器人/创新药）；航空航天与电网设备在本口径下不计入成长股——分组是口径假设，不是市场风格因子模型。',
      '估值压缩 −15% 是声明式假设幅度，不是预测；未对利率、盈利预期差等驱动因素建模。',
    ],
    magnitude_basis: '声明式假设幅度（成长主题 −15%）；分组与幅度均为预固定口径，不是预测。',
    legacy_stress_merge: false,
  },
  {
    id: 'cross_industry_correlation_up',
    name: '行业间相关性上升',
    assumption_note: '行业间相关性上升削弱分散化收益；单情景点损失不变（相关性影响方差，不是加总损失）。',
    assumed: true,
    asset_class_shocks: { ...DEFAULT_ASSET_CLASS_STRESS.shocks },
    code_shocks: null,
    growth_themes: null,
    slippage_multiplier: null,
    declared_notes: [
      '本引擎不建模协方差：相关性上升不改变单情景的声明式点损失，因此损失列与情景 1 同口径。',
      '相关性上升的现实含义是"按独立成分估计的分散化收益被高估"——风险轨的减仓/换仓方案对分散收益的改善幅度需要按更差的相关性复核，该复核本身尚未完成（见各方案未验证信息列）。',
      '相关性水平（如从分散假设趋向同步下跌）是声明式定性口径，没有给出伪造的数值相关系数。',
    ],
    magnitude_basis: '声明式定性口径：相关性上升只声明方向（分散收益下降），不给出数值相关系数；损失幅度沿用 r1-asset-stress 预固定口径——整体不是预测。',
    legacy_stress_merge: false,
  },
  {
    id: 'etf_liquidity_slippage',
    name: 'ETF流动性与滑点恶化',
    assumption_note: '成交价差走阔的声明式对照：只放大滑点估计，价格与仓位不变。',
    assumed: true,
    asset_class_shocks: null,
    code_shocks: null,
    growth_themes: null,
    slippage_multiplier: 3,
    declared_notes: [
      '滑点按 3× 声明式倍数放大，只作用于费用中的 slippage_estimate（估计值），佣金/印花税/过户费等实际费用项不变。',
      '冲击本身不改变持仓价格（情景关注的是执行成本，不是市场方向）；滑点恶化对不交易方案（HOLD/NO_ACTION）无费用影响。',
      '真实滑点取决于下单时点的盘口深度，未建模；3× 是假设倍数，不是历史统计。',
    ],
    magnitude_basis: '声明式假设倍数（滑点 ×3）；不是预测，也不是预固定的盘口统计。',
    legacy_stress_merge: false,
  },
  {
    id: 'semiconductor_rebound',
    name: '半导体设备快速反弹',
    assumption_note: '仅半导体设备主题快速上涨，其他资产价格不变的声明式对照。',
    assumed: true,
    asset_class_shocks: null,
    code_shocks: null,
    growth_themes: null,
    slippage_multiplier: null,
    declared_notes: [
      '半导体设备主题按 +20% 声明式反弹幅度冲击；其他持仓不变。反弹幅度是假设，不是预测。',
      '本情景用于度量"减仓/换仓/清零对照放弃了多少上涨参与度"（机会成本列的量化来源）。',
    ],
    magnitude_basis: '声明式假设幅度（单主题反弹 +20%）；不是预测，也没有对应的单一历史统计。',
    legacy_stress_merge: false,
  },
  {
    id: 'broad_rebound_semiconductor_lag',
    name: '宽基反弹而半导体设备继续落后',
    assumption_note: '宽基上涨、半导体设备主题续跌的声明式对照；宽基用组合内非半导体持仓代理。',
    assumed: true,
    asset_class_shocks: null,
    code_shocks: null,
    growth_themes: null,
    slippage_multiplier: null,
    declared_notes: [
      '组合未直接持有宽基指数：宽基反弹以"非半导体权益持仓 +6%"代理（声明式代理口径，债券等非权益资产不变），半导体设备主题 −10%。',
      '宽基 +6% / 半导体 −10% 均为声明式假设幅度，不是预测；代理口径意味着"宽基反弹"的度量含混，换仓候选的相对优势必须用真实宽基行情另行验证。',
    ],
    magnitude_basis: '声明式假设幅度（非半导体权益代理 +6%、半导体设备 −10%）；代理分组与幅度均为预固定口径，不是预测。',
    legacy_stress_merge: false,
  },
];

/** 单行业/主题冲击幅度（声明式假设，供情景 2/3/6/7 复用）。 */
const SEMICONDUCTOR_CRASH_SHOCK = -0.30;
const GROWTH_COMPRESSION_SHOCK = -0.15;
const SEMICONDUCTOR_REBOUND_SHOCK = 0.20;
const SEMICONDUCTOR_LAG_SHOCK = -0.10;

/** 情景行对单个持仓行的冲击（0 表示价格不变）。 */
export function shockForRow(row: ScenarioRow, position: ScenarioPosition): number {
  if (row.code_shocks && row.code_shocks[position.ts_code] !== undefined) return row.code_shocks[position.ts_code];
  if (row.growth_themes && row.growth_themes.includes(position.theme)) return GROWTH_COMPRESSION_SHOCK;
  switch (row.id) {
    case 'semiconductor_crash':
      return position.theme === 'semiconductor_equipment' ? SEMICONDUCTOR_CRASH_SHOCK : 0;
    case 'semiconductor_rebound':
      return position.theme === 'semiconductor_equipment' ? SEMICONDUCTOR_REBOUND_SHOCK : 0;
    case 'broad_rebound_semiconductor_lag':
      // 宽基代理只作用于非半导体的**权益**持仓：债券/黄金等不随宽基权益反弹。
      if (position.theme === 'semiconductor_equipment') return SEMICONDUCTOR_LAG_SHOCK;
      return position.asset_class === 'EQUITY' ? BROAD_REBOUND_PROXY : 0;
    case 'etf_liquidity_slippage':
      return 0; // 只影响费用，不影响价格
    default:
      return row.asset_class_shocks ? (row.asset_class_shocks[position.asset_class] ?? 0) : 0;
  }
}

// ---------------------------------------------------------------- 逐方案状态输入

export interface ScenarioOptionState {
  action: ScenarioOption;
  /** 该方案成交后的持仓行（金额为 as-of 收盘重估后的分值）。 */
  positions: ScenarioPosition[];
  cash_cents: number;
  wealth_cents: number;
  funding_status: ScenarioFundingStatus;
  /** 各代码费用明细（真实费用与滑点分列；引擎按情景 5 放大滑点）。 */
  fee_breakdowns: { ts_code: string; side: 'BUY' | 'SELL'; breakdown: FeeBreakdown }[];
  /** 卖出后是否仍有一手现金能力（HOLD/NO_ACTION 直接沿用现金列）。 */
  cash_sufficient_for_one_lot: boolean | null;
  invalidation_conditions: string[];
  /** 方案级失效条件补充（交易未执行时，方案内的 post-trade 状态本身是研究假设）。 */
  unverified_information: string[];
}

export interface ScenarioMatrixInput {
  as_of_trade_date: string;
  /** 研究起点（未交易前）的持仓，用于"上涨参与度"的参照分母（持有全部=100%）。 */
  baseline_positions: ScenarioPosition[];
  baseline_cash_cents: number;
  wealth_cents: number;
  options: ScenarioOptionState[];
}

// ---------------------------------------------------------------- 十列

export interface ScenarioColumn {
  /** 1. 总资产与现金。 */
  total_assets_and_cash: {
    total_assets_cents: number | null;
    cash_cents: number | null;
    note: string;
  };
  /** 2. 权益风险敞口。 */
  equity_exposure: {
    equity_weight: number | null;
    equity_market_value_cents: number | null;
    note: string;
  };
  /** 3. 行业集中度（按声明式行业映射，未归类单列）。 */
  industry_concentration: {
    top_industry: string | null;
    top_industry_weight: number | null;
    by_industry: { industry: string; market_value_cents: number; weight: number }[];
    note: string;
  };
  /** 4. HHI（口径与日报一致：分母含现金与理财，现金不进分子）。 */
  hhi: { value: number | null; effective_positions: number | null; note: string };
  /** 5. 声明式压力损失（本情景冲击下的损失；负数=损失）。 */
  declared_stress_loss: {
    loss_cents: number | null;
    loss_pct_of_total_assets: number | null;
    shock_scope: string;
    note: string;
  };
  /** 6. 上涨参与度（仅上涨情景有意义；无上涨时为 null 并注明）。 */
  upside_participation: {
    held_upside_cents: number;
    reference_upside_cents: number;
    participation_pct: number | null;
    missed_upside_cents: number;
    note: string;
  };
  /** 7. 交易费用（真实费用估计与滑点估计分列；滑点永远是估计值）。 */
  trading_fees: {
    fees_cents: number;
    slippage_estimate_cents: number;
    actual_fee_estimate_cents: number;
    assumed: true;
    slippage_multiplier: number;
    breakdowns: { ts_code: string; side: 'BUY' | 'SELL'; commission_cents: number; transfer_fee_cents: number; stamp_duty_cents: number; slippage_estimate_cents: number; total_cents: number }[];
    note: string;
  };
  /** 8. 资金可用性。 */
  funding_availability: {
    funding_status: ScenarioFundingStatus;
    cash_after_cents: number | null;
    cash_sufficient_for_one_lot: boolean | null;
    note: string;
  };
  /** 9. 失效条件。 */
  invalidation_conditions: string[];
  /** 10. 尚未验证的信息。 */
  unverified_information: string[];
}

export interface ScenarioComparisonRow {
  scenario_id: ScenarioId;
  scenario_name: string;
  assumed: true;
  magnitude_basis: string;
  assumption_note: string;
  declared_notes: string[];
  legacy_stress_merge: boolean;
  options: Record<ScenarioOption, ScenarioColumn>;
}

export interface ScenarioMatrix {
  engine_version: string;
  as_of_trade_date: string;
  /** 逐情景声明：幅度是假设/预固定口径，不是预测（任务书 §5.2 验收点）。 */
  magnitude_disclaimer: string;
  /** 情景 1 与既有 r1-asset-stress 的合并声明（兼容性锚点）。 */
  legacy_stress_version: string;
  scenarios: ScenarioComparisonRow[];
  note: string;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function groupByIndustry(positions: ScenarioPosition[], total: number) {
  const groups = new Map<string, number>();
  for (const p of positions) {
    const industry = p.industry && p.industry !== 'unclassified' ? p.industry : 'unclassified';
    groups.set(industry, (groups.get(industry) ?? 0) + p.value);
  }
  return [...groups.entries()]
    .map(([industry, value]) => ({ industry, market_value_cents: value, weight: total > 0 ? r6(value / total) : 0 }))
    .sort((a, b) => b.market_value_cents - a.market_value_cents);
}

/** 按情景重估持仓行：返回冲击后的金额与本情景损失（负数=损失，0=无冲击）。 */
function revalue(positions: ScenarioPosition[], row: ScenarioRow) {
  const shocked: ScenarioPosition[] = positions.map(p => {
    const shock = shockForRow(row, p);
    return { ...p, value: p.value + Math.round(p.value * shock) };
  });
  // 损失口径与 metrics()/stressOf 一致：逐行 Math.round(value × shock) 后求和；
  // 上涨行贡献为正，"损失"列允许为正（情景本身是上涨时）。
  let lossCents = 0;
  for (const p of positions) lossCents += Math.round(p.value * shockForRow(row, p));
  return { shocked, priceDeltaCents: lossCents };
}

function feesOf(state: ScenarioOptionState, multiplier: number) {
  let fees = 0;
  let slippage = 0;
  const breakdowns: ScenarioColumn['trading_fees']['breakdowns'] = [];
  for (const row of state.fee_breakdowns) {
    const b = row.breakdown;
    const baseSlippage = b.slippage_estimate_cents ?? 0;
    const scaledSlippage = Math.round(baseSlippage * multiplier);
    const actual = b.actual_fee_estimate_cents ?? Math.max(0, b.total_cents - baseSlippage);
    const total = actual + scaledSlippage;
    fees += total;
    slippage += scaledSlippage;
    breakdowns.push({
      ts_code: row.ts_code, side: row.side,
      commission_cents: b.commission_cents, transfer_fee_cents: b.transfer_fee_cents,
      stamp_duty_cents: b.stamp_duty_cents,
      slippage_estimate_cents: scaledSlippage, total_cents: total,
    });
  }
  return { fees, slippage, actual: fees - slippage, breakdowns };
}

/**
 * 构建七情景 × 五方案矩阵（纯函数、确定性、与风险政策无关）。
 *
 * 注意：矩阵只依赖传入的 post-trade 状态与声明式情景表，不读数据库、不读风险政策，
 * 因此政策记录的有无不改变本结构（upgrade-risk-policy 的 strip() 深比较依赖此性质）。
 */
export function buildScenarioMatrix(input: ScenarioMatrixInput): ScenarioMatrix {
  const { baseline_positions, baseline_cash_cents, wealth_cents, options } = input;

  const scenarioComparisonRows: ScenarioComparisonRow[] = SCENARIO_ROWS.map(row => {
    const rowColumns = {} as Record<ScenarioOption, ScenarioColumn>;

    for (const state of options) {
      const multiplier = row.slippage_multiplier ?? 1;
      const feeView = feesOf(state, multiplier);
      const { shocked, priceDeltaCents } = revalue(state.positions, row);

      // 情景 5：滑点放大改变现金（成交费用多付的部分直接减少现金与总资产）。
      const baseFeeView = multiplier === 1 ? feeView : feesOf(state, 1);
      const feeDeltaCents = feeView.fees - baseFeeView.fees;
      const cashAfter = state.cash_cents - feeDeltaCents;

      const securities = shocked.reduce((sum, p) => sum + p.value, 0);
      const total = securities + cashAfter + wealth_cents;

      const byIndustry = groupByIndustry(shocked, total);
      const hhi = total > 0 ? r6(shocked.reduce((sum, p) => sum + (p.value / total) ** 2, 0)) : null;
      const equityValue = shocked.filter(p => p.asset_class === 'EQUITY').reduce((sum, p) => sum + p.value, 0);

      // 上涨参与度参照 = 研究起点（未交易）持仓在本情景下的总上涨金额。
      // 两侧都用**冲击前**的 as-of 金额乘以本情景冲击率；heldUpside 若改用 shocked
      // （已重估）金额会二次施加冲击（HOLD 反弹情景参与度 1.2 而非 1）。
      const referenceUpside = baseline_positions.reduce((sum, p) => sum + Math.max(0, Math.round(p.value * shockForRow(row, p))), 0);
      const heldUpside = state.positions.reduce((sum, p) => sum + Math.max(0, Math.round(p.value * shockForRow(row, p))), 0);
      const upsideApplicable = referenceUpside > 0;
      const participation = upsideApplicable ? r6(heldUpside / referenceUpside) : null;
      const missed = upsideApplicable ? referenceUpside - heldUpside : 0;

      const lossPct = total > 0 ? r6(priceDeltaCents / total * 100) : null;

      rowColumns[state.action] = {
        total_assets_and_cash: {
          total_assets_cents: total,
          cash_cents: cashAfter,
          note: `情景冲击后总资产 = 重估证券 + 现金 ${cashAfter} 分 + 理财 ${wealth_cents} 分`
            + (feeDeltaCents !== 0 ? `（滑点 ×${multiplier} 使费用增加 ${feeDeltaCents} 分）` : ''),
        },
        equity_exposure: {
          equity_weight: total > 0 ? r6(equityValue / total) : null,
          equity_market_value_cents: equityValue,
          note: '权益敞口按情景重估后的权益类市值 / 总资产；资产类别判定来自 fund_basic 声明式分类。',
        },
        industry_concentration: {
          top_industry: byIndustry[0]?.industry ?? null,
          top_industry_weight: byIndustry[0]?.weight ?? null,
          by_industry: byIndustry,
          note: '行业分组来自 r1-industry-map-1.0.0 声明式映射；未列出的代码归入 unclassified，不做关键词猜测。',
        },
        hhi: {
          value: hhi,
          effective_positions: hhi && hhi > 0 ? r6(1 / hhi) : null,
          note: 'HHI = Σ(持仓市值/总资产)²；分母含现金与理财，现金不作为证券进分子（与日报 concentration 口径一致）。',
        },
        declared_stress_loss: {
          loss_cents: priceDeltaCents,
          loss_pct_of_total_assets: lossPct,
          shock_scope: row.id,
          note: `声明式情景冲击的逐行 round(市值×幅度) 之和；负数=损失。${row.magnitude_basis}`
            + (row.legacy_stress_merge ? ` 本情景与 ${ASSET_CLASS_STRESS_VERSION} 同口径，逐方案等于既有 stress_after.loss_cents。` : ''),
        },
        upside_participation: {
          held_upside_cents: heldUpside,
          reference_upside_cents: referenceUpside,
          participation_pct: participation,
          missed_upside_cents: missed,
          note: upsideApplicable
            ? '参与度 = 本方案持仓捕获的上涨 / 研究起点全部持仓捕获的上涨（参照=持有不动 100%）。上涨幅度为声明式假设，不是预测。'
            : '本情景没有上涨分量（或未持有任何受冲击上涨的资产），上涨参与度不适用。',
        },
        trading_fees: {
          fees_cents: feeView.fees,
          slippage_estimate_cents: feeView.slippage,
          actual_fee_estimate_cents: feeView.actual,
          assumed: true,
          slippage_multiplier: multiplier,
          breakdowns: feeView.breakdowns,
          note: multiplier > 1
            ? `情景假设滑点 ×${multiplier}：只放大 slippage_estimate（估计值），佣金/印花税/过户费等实际费用项不变；未获得券商真实费率前全部为假设值。`
            : '费用按账户/代码费率模型计算（假设值）；滑点单列为估计，真实费用与估算滑点分列，滑点不是已确认费用。',
        },
        funding_availability: {
          funding_status: state.funding_status,
          cash_after_cents: cashAfter,
          cash_sufficient_for_one_lot: state.cash_sufficient_for_one_lot,
          note: state.funding_status === 'FUNDED' || state.funding_status === 'NO_TRADE'
            ? '资金状态来自当日可卖数量与费用校验；研究数量是显式研究参数，不是下单授权。'
            : `资金状态 ${state.funding_status}：方案内交易未成立，post-trade 数字是研究假设。`,
        },
        invalidation_conditions: [
          ...state.invalidation_conditions,
          `情景幅度（${row.name}）是声明式假设：该幅度本身不成立或需要更新时，本行全部数字失效并重算。`,
          '持仓、现金、费用模型、行情或可卖数量变化后重算。',
          // 政策中立引用：矩阵不携带政策数据（记录政策前后必须逐字节一致），
          // 已批准组合风险政策的实际状态由对应方案的 risk_budget 披露。
          '若存在已批准的组合风险政策（状态见对应方案 risk_budget），该政策批准、变更或撤销后本行对照需重算。',
        ],
        unverified_information: [
          ...state.unverified_information,
          ...row.declared_notes.map(note => `情景口径未验证：${note}`),
          `情景幅度未验证：${row.magnitude_basis}`,
        ],
      };
    }

    return {
      scenario_id: row.id,
      scenario_name: row.name,
      assumed: true,
      magnitude_basis: row.magnitude_basis,
      assumption_note: row.assumption_note,
      declared_notes: row.declared_notes,
      legacy_stress_merge: row.legacy_stress_merge,
      options: rowColumns,
    };
  });

  return {
    engine_version: SCENARIO_ENGINE_VERSION,
    as_of_trade_date: input.as_of_trade_date,
    magnitude_disclaimer: '七个情景的幅度全部属于假设或预先固定的声明式口径，不是预测，也不是历史回撤统计；'
      + '逐列数字是研究比较，不构成交易授权，也不引入任何未经用户确认的机械减仓阈值。',
    legacy_stress_version: ASSET_CLASS_STRESS_VERSION,
    scenarios: scenarioComparisonRows,
    note: '情景 1（全市场权益下跌）与既有 r1-asset-stress 资产类别冲击同口径合并，既有 stress_after 字段保持不变；'
      + '五方案在七个情景下逐列对照（总资产与现金、权益敞口、行业集中度、HHI、声明式压力损失、上涨参与度、'
      + '交易费用、资金可用性、失效条件、尚未验证的信息）。研究数量仅来自显式研究参数或明确授权的风险计算规则，'
      + '研究数量不等于下单授权。',
  };
}

/** 供 dailyReport 计算 post-trade 行情时复用的行业/主题映射（与 decision.ts 同源导出）。 */
export { INDUSTRY_BY_CODE, THEME_BY_CODE };
