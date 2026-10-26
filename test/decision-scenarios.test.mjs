import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// goal-1026 §5.1 双轨解耦 + §5.2 七情景引擎（B decision 的验收用例）。
//
// 全部为合成 fixture：不是用户真实账户，不读生产缓存，不运行任何真实下单。
// 断言分三组：
// 1. 双轨解耦：五方案 executable 恒为 false（研究比较≠下单授权），但 risk_track
//    只由账户/权限/费用/行情门控决定，不被 Alpha 证据缺失涂黑；alpha 状态只在轮动轨。
// 2. 七情景：七个具名情景 × 五方案 × 十列齐备，幅度带“声明式假设”口径注记；
//    情景 1 与既有 r1-asset-stress 逐方案等值（向后兼容锚点）。
// 3. 兼容性：既有 decision_comparison 字段（sell_plan/rotation_plan/decision_basis/
//    risk_budget/费用分列/可卖性）语义不变；研究数量不等于下单授权。
//
// 与既有套件一致：源码在 ../build/（主控统一构建）；FINANCE_TEST_BUILD 可指独立构建目录。
const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
const dir = mkdtempSync(join(tmpdir(), 'decision-scenarios-'));
process.env.ASHARE_DATA_DIR = dir;
const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await load('portfolio/account.js');
const ledger = await load('portfolio/ledger.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');
const { buildDecision } = await load('portfolio/decision.js');
const { SCENARIO_ROWS, SCENARIO_ENGINE_VERSION, buildScenarioMatrix } = await load('portfolio/scenarios.js');

const days = Array.from({ length: 61 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1 + i));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
});
const asOf = days.at(-1);
let seq = 0;

// ---------------------------------------------------------------- 合成市场与账户

const PRICES = {
  '159558.SZ': 1.0,   // 半导体设备（权益、行业=半导体）
  '159278.SZ': 0.8,   // 机器人（权益、成长主题）
  '516080.SH': 0.6,   // 创新药（权益、成长主题）
  '510300.SH': 4.0,   // 沪深300（权益、非半导体——宽基反弹代理）
  '511010.SH': 100.0, // 国债（债券）
};

function fixture({ confirmed = true, cash = 200000, positions = null } = {}) {
  const id = `scen-${++seq}`;
  const marketPath = join(dir, `${id}-market.sqlite`);
  const market = openAshareDb(marketPath);
  upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));
  upsertRows(market, 'fund_basic',
    ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    Object.keys(PRICES).map(ts_code => ({
      ts_code,
      name: ts_code === '511010.SH' ? '合成国债ETF' : `合成${ts_code}`,
      fund_type: ts_code === '511010.SH' ? '债券型' : '股票型',
      invest_type: '被动指数型',
      benchmark: ts_code === '511010.SH' ? '国债指数' : '合成指数',
      // 场内基金一律 market='E'（tushare 口径与 instrument.ts resolveInstrument 一致；
      // 按交易所后缀给 .SH 写 'S' 会让 510300/516080/511010 解析不出 ETF 身份）。
      status: 'L', market: 'E',
    })));
  for (const [code, close] of Object.entries(PRICES)) {
    upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      days.map(date => ({ ts_code: code, trade_date: date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e5 })));
    upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 1 })));
    upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], days.map(trade_date => ({ ts_code: code, trade_date, fd_share: 100000 })));
  }
  upsertRows(market, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
    days.map(trade_date => ({ ts_code: '000300.SH', trade_date, open: 100, high: 100, low: 100, close: 100, pre_close: 100, vol: 1000, amount: 1000 })));
  const reportId = `SCEN-${id}`;
  const path = `reports/${id}.json`;
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify({
    report_id: reportId, as_of_trade_date: asOf, status: 'READY',
    market: { regime: 'range', breadth: { up_ratio: .4, median_pct_chg: -0.5, amount_yi: 900, amount_ma20_yi: 1000, pct_above_ma20: 40, pct_above_ma60: 35 }, indices: [] },
    sectors: { all: [], top: [], bottom: [] },
  }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)')
    .run(reportId, asOf, 'READY', '2026-08-30T14:00:00Z', path, 'manual');

  const portfolio = openPortfolioDb(join(dir, `${id}-portfolio.sqlite`), { marketPath });
  const rows = positions ?? [
    { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 5000, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: 500000 },
    { ts_code: '159278.SZ', name: '机器人ETF', quantity: 5000, ref_price_milli: 800, ref_cost_milli: 800, market_value_cents: 400000 },
    { ts_code: '516080.SH', name: '创新药ETF', quantity: 1000, ref_price_milli: 600, ref_cost_milli: 600, market_value_cents: 60000 },
    { ts_code: '511010.SH', name: '国债ETF', quantity: 10, ref_price_milli: 100000, ref_cost_milli: 100000, market_value_cents: 100000 },
  ];
  const securities = rows.reduce((sum, p) => sum + p.market_value_cents, 0);
  account.importSnapshot(portfolio, {
    snapshot_id: id, as_of: asOf, source: 'synthetic-test', note: 'synthetic', warnings: [], is_current: false,
    positions: rows,
    totals: { total_assets_cents: securities + cash, securities_mv_cents: securities, cash_cents: cash, wealth_cents: 0, unrealized_pnl_cents: 0 },
  });
  ledger.initBaseline(portfolio, id, { asOf, snapshotId: id });
  account.markSnapshotCurrent(portfolio, id, { confirmedBy: 'synthetic-test' });
  if (confirmed) {
    ledger.confirmRealAccount(portfolio, id, { confirm: true, note: 'synthetic-test' });
    ledger.setAccountCompleteness(portfolio, id, { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false },
      { confirm: true, recordedBy: 'synthetic-test' });
  }
  const build = (extra = {}) => buildDailyReport({
    portfolioDb: portfolio, marketDb: market, accountId: id, snapshotId: id, asOfTradeDate: asOf, ...extra,
  });
  return { build, market, portfolio, id, close: () => { market.close(); portfolio.close(); } };
}

const option = (report, action) => report.decision_comparison.options.find(row => row.action === action);
const ALL = ['HOLD', 'REDUCE', 'ROTATE', 'DEFENSIVE', 'NO_ACTION'];

// ---------------------------------------------------------------- §5.1 双轨解耦

test('B1 五个方案 executable 恒为 false，但风险轨门控不被 Alpha 证据缺失涂黑', () => {
  const f = fixture();
  try {
    const r = f.build(); // 未接入任何轮动优势证据
    const comparison = r.decision_comparison;
    for (const action of ALL) {
      const o = option(r, action);
      assert.equal(o.executable, false, `${action} 研究比较不得可执行`);
      assert.ok(Array.isArray(o.not_actionable_because));
      // 风险轨：门控状态独立给出，绝不因 Alpha 证据缺失而 blocked_by_alpha。
      assert.equal(o.risk_track.blocked_by_alpha, false, `${action} 风险轨不得被 Alpha 阻塞`);
      assert.ok(Array.isArray(o.risk_track.blocked_by));
      assert.equal(typeof o.risk_track.gates_satisfied, 'boolean');
      assert.equal(typeof o.risk_track.has_execution_reference, 'boolean');
      // 门控满足时：任何方案的 risk_track.blocked_by 不得包含 Alpha 证据原因码。
      if (o.risk_track.gates_satisfied) {
        for (const code of o.risk_track.blocked_by) {
          assert.ok(!/advantage|evidence|UNVERIFIED/i.test(code), `${action} blocked_by 混入 Alpha 码：${code}`);
        }
      }
    }
    // 账户完整确认 + 同日快照 + 行情齐全 → 风险轨门控对全部方案成立，
    // 即便完全没有优势证据（这正是 5.1 要拆的耦合）。
    for (const action of ['HOLD', 'DEFENSIVE', 'NO_ACTION']) {
      assert.equal(option(r, action).risk_track.gates_satisfied, true,
        `${action} 风险轨在门控满足时不得被 Alpha 缺失阻塞`);
    }
    // 无研究数量时 REDUCE/ROTATE 资金状态是 QUANTITY_REQUIRED（研究参数缺失，属风险轨资金门控）。
    assert.equal(option(r, 'REDUCE').funding_status, 'QUANTITY_REQUIRED');
    assert.equal(option(r, 'REDUCE').risk_track.gates_satisfied, false);
    assert.ok(option(r, 'REDUCE').risk_track.blocked_by.some(code => code.startsWith('funding_status:')));
  } finally { f.close(); }
});

test('B2 Alpha 轨状态只出现在轮动轨字段，风险轨不携带 UNVERIFIED 结论', () => {
  const f = fixture();
  try {
    const r = f.build();
    // 轮动轨：ROTATE 携带证据状态（既有 D4 断言依赖 UNVERIFIED 词面）。
    const rotate = option(r, 'ROTATE');
    assert.equal(rotate.alpha_track.status, 'NOT_SUPPLIED');
    assert.equal(rotate.rotation_plan, null, '无研究数量不构造轮动计划');
    assert.equal(rotate.alpha_track.evidence_verified, false);
    // 非轮动方案：Alpha 轨不适用，风险轨说明里不得出现证据验证结论。
    for (const action of ['HOLD', 'REDUCE', 'DEFENSIVE', 'NO_ACTION']) {
      const o = option(r, action);
      assert.equal(o.alpha_track.status, 'NOT_APPLICABLE', `${action} 不应有轮动证据状态`);
      const riskText = [o.risk_track.note, ...o.risk_track.blocked_by].join(' ');
      assert.ok(!/UNVERIFIED|相对优势/.test(riskText), `${action} 风险轨不得引用 Alpha 证据结论`);
    }
    // not_actionable_because：门控行 + 研究授权声明，不再无条件塞“相对优势 UNVERIFIED”。
    const holdBecause = option(r, 'HOLD').not_actionable_because.join(' ');
    assert.ok(!/相对优势 UNVERIFIED/.test(holdBecause), 'HOLD 不得携带轮动证据结论');
    assert.match(holdBecause, /研究数量不是用户确认的策略约束或交易授权/);
    // ROTATE 保留轮动轨证据词面（D4-3 兼容）。
    assert.match(option(r, 'ROTATE').not_actionable_because.join(' '), /UNVERIFIED|未验证/);
    // 质量分层：可执行性理由不再引用证据缺失（耦合缺陷的第三处）。
    const tier = r.data_quality.tiers.trade_plan_executability;
    assert.equal(tier.status, 'NOT_EXECUTABLE'); // 日报不产生交易动作（兼容断言）
    assert.ok(!/优势证据|轮动优势|RESEARCH_VERIFIED/.test(tier.detail), `tier detail 仍引用证据：${tier.detail}`);
    assert.ok(/门控|不产生交易动作/.test(tier.detail), tier.detail);
  } finally { f.close(); }
});

test('B3 决策工具：RESEARCH_VERIFIED 缺失时风险轨决策结构仍完整且门控独立', () => {
  const f = fixture();
  try {
    // SELL_AND_BUY 且不提供证据 → 既有 executable=false / ILLUSTRATIVE 语义不变。
    const d = buildDecision({
      account_id: f.id, snapshot: account.accountSummary(account.readSnapshot(f.portfolio, f.id)),
      as_of_trade_date: asOf, market_db: f.market, portfolio_db: f.portfolio,
      action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 1000, buy_code: '510300.SH', buy_kind: 'ETF' },
    });
    assert.notEqual(d.status, 'ACTIONABLE');
    const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
    assert.equal(rotate.executable, false);
    // 新增 decision_tracks：风险轨与 Alpha 轨分列，风险轨 blocked_by 不含 Alpha 码。
    assert.ok(d.decision_tracks, 'buildDecision 必须输出 decision_tracks');
    assert.equal(d.decision_tracks.risk_track.blocked_by_alpha, false);
    for (const code of d.decision_tracks.risk_track.blocked_by) {
      assert.ok(!['rotation_advantage_unverified', 'no_demonstrated_advantage'].includes(code),
        `风险轨 blocked_by 混入 Alpha 码：${code}`);
    }
    assert.equal(d.decision_tracks.alpha_track.status, 'NOT_SUPPLIED');
    assert.equal(typeof d.decision_tracks.risk_track.gates_satisfied, 'boolean');
    // 账户已确认、行情齐全 → 风险轨门控满足（即使 Alpha 轨 NOT_SUPPLIED）。
    assert.equal(d.decision_tracks.risk_track.gates_satisfied, true, JSON.stringify(d.decision_tracks));

    // 对照：HOLD 请求本身不受 Alpha 影响，既有 executable 语义不变。
    const h = buildDecision({
      account_id: f.id, snapshot: account.accountSummary(account.readSnapshot(f.portfolio, f.id)),
      as_of_trade_date: asOf, market_db: f.market, portfolio_db: f.portfolio,
      action: { type: 'HOLD' },
    });
    for (const o of h.options) assert.equal(o.executable, false, `${o.action} 不得可执行`);
    assert.equal(h.decision_tracks.risk_track.gates_satisfied, true);
    assert.equal(h.decision_tracks.alpha_track.status, 'NOT_APPLICABLE');
  } finally { f.close(); }
});

test('B4 决策工具：账户门控失败时风险轨 blocked_by 如实列出（不是 Alpha 原因）', () => {
  const f = fixture({ confirmed: false });
  try {
    const d = buildDecision({
      account_id: f.id, snapshot: account.accountSummary(account.readSnapshot(f.portfolio, f.id)),
      as_of_trade_date: asOf, market_db: f.market, portfolio_db: f.portfolio,
      action: { type: 'HOLD' },
    });
    assert.notEqual(d.status, 'ACTIONABLE');
    assert.equal(d.decision_tracks.risk_track.gates_satisfied, false);
    assert.ok(d.decision_tracks.risk_track.blocked_by.some(code => code.startsWith('account_')),
      JSON.stringify(d.decision_tracks.risk_track.blocked_by));
    for (const code of d.decision_tracks.risk_track.blocked_by) {
      assert.ok(!/advantage|evidence/i.test(code), `不得混入 Alpha 码：${code}`);
    }
  } finally { f.close(); }
});

// ---------------------------------------------------------------- §5.2 七情景

test('B5 七个具名情景齐备，每个带“假设/预固定、不是预测”口径注记', () => {
  assert.equal(SCENARIO_ROWS.length, 7);
  const expected = [
    'market_equity_drawdown', 'semiconductor_crash', 'growth_valuation_compression',
    'cross_industry_correlation_up', 'etf_liquidity_slippage', 'semiconductor_rebound',
    'broad_rebound_semiconductor_lag',
  ];
  assert.deepEqual(SCENARIO_ROWS.map(r => r.id), expected);
  for (const row of SCENARIO_ROWS) {
    assert.equal(row.assumed, true, `${row.id} 必须标注 assumed`);
    assert.ok(row.magnitude_basis.includes('不是预测'), `${row.id} 缺少“不是预测”口径：${row.magnitude_basis}`);
    assert.ok(row.name.length > 0);
    assert.ok(row.assumption_note.length > 0);
    assert.ok(Array.isArray(row.declared_notes) && row.declared_notes.length > 0, `${row.id} 缺少声明注记`);
  }
  // 情景 1 与 r1-asset-stress 合并标记。
  const legacy = SCENARIO_ROWS.find(r => r.id === 'market_equity_drawdown');
  assert.equal(legacy.legacy_stress_merge, true);
});

test('B6 日报 scenario_matrix：七情景 × 五方案 × 十列齐备', () => {
  const f = fixture();
  try {
    const r = f.build();
    const matrix = r.decision_comparison.scenario_matrix;
    assert.ok(matrix, 'decision_comparison 必须带 scenario_matrix');
    assert.equal(matrix.engine_version, SCENARIO_ENGINE_VERSION);
    assert.match(matrix.magnitude_disclaimer, /不是预测/);
    assert.equal(matrix.scenarios.length, 7);
    for (const scen of matrix.scenarios) {
      assert.equal(scen.assumed, true);
      assert.ok(scen.magnitude_basis.includes('不是预测'), `${scen.scenario_id} 幅度口径缺“不是预测”`);
      for (const action of ALL) {
        const col = scen.options[action];
        assert.ok(col, `${scen.scenario_id} 缺方案 ${action}`);
        // 十列逐项存在且类型正确。
        assert.equal(typeof col.total_assets_and_cash.total_assets_cents, 'number');
        assert.equal(typeof col.total_assets_and_cash.cash_cents, 'number');
        assert.equal(typeof col.equity_exposure.equity_weight, 'number');
        assert.ok(Array.isArray(col.industry_concentration.by_industry));
        assert.equal(typeof col.hhi.value, 'number');
        assert.equal(typeof col.declared_stress_loss.loss_cents, 'number');
        assert.equal(typeof col.declared_stress_loss.loss_pct_of_total_assets, 'number');
        // 上涨参与度：有上涨分量时是数字，无上涨分量时为 null 并注明不适用（不再只是文字）。
        assert.ok(col.upside_participation.participation_pct === null
          || typeof col.upside_participation.participation_pct === 'number');
        if (col.upside_participation.participation_pct !== null) {
          assert.ok(col.upside_participation.participation_pct >= 0, '参与度不得为负');
        }
        assert.equal(typeof col.trading_fees.fees_cents, 'number');
        assert.equal(col.trading_fees.assumed, true);
        assert.equal(typeof col.trading_fees.slippage_estimate_cents, 'number');
        assert.equal(typeof col.trading_fees.actual_fee_estimate_cents, 'number');
        assert.ok(col.trading_fees.actual_fee_estimate_cents + col.trading_fees.slippage_estimate_cents === col.trading_fees.fees_cents,
          `${scen.scenario_id}/${action} 费用必须真实与滑点分列且相加等于总额`);
        assert.ok(typeof col.funding_availability.funding_status === 'string');
        assert.ok(Array.isArray(col.invalidation_conditions) && col.invalidation_conditions.length > 0);
        assert.ok(Array.isArray(col.unverified_information) && col.unverified_information.length > 0);
      }
    }
    // 五方案出现在每个情景下（逐列对照的前提）。
    for (const scen of matrix.scenarios) {
      assert.deepEqual(Object.keys(scen.options).sort(), [...ALL].sort());
    }
  } finally { f.close(); }
});

test('B7 情景 1 与既有 r1-asset-stress 逐方案等值（向后兼容锚点）', () => {
  const f = fixture();
  try {
    const r = f.build();
    const scen = r.decision_comparison.scenario_matrix.scenarios
      .find(s => s.scenario_id === 'market_equity_drawdown');
    assert.ok(scen.legacy_stress_merge);
    assert.equal(scen.declared_notes.some(n => /r1-asset-stress/.test(n)), true);
    for (const action of ALL) {
      const o = option(r, action);
      assert.ok(o.stress_after, `${action} 必须保留既有 stress_after`);
      assert.equal(scen.options[action].declared_stress_loss.loss_cents, o.stress_after.loss_cents,
        `${action} 情景1压力损失必须等于既有 stress_after.loss_cents（同口径合并）`);
    }
    // 情景 1 各行的冲击口径 = DEFAULT_ASSET_CLASS_STRESS（经引擎往返验证）。
    const holdCol = scen.options.HOLD;
    assert.ok(holdCol.declared_stress_loss.loss_cents <= 0);
    assert.equal(matrixLegacyVersion(r), 'r1-asset-stress-1.0.0');
  } finally { f.close(); }
});

function matrixLegacyVersion(report) {
  return report.decision_comparison.scenario_matrix.legacy_stress_version;
}

test('B8 上涨情景给出数值化的上涨参与度（不再是纯文字）', () => {
  const f = fixture();
  try {
    const r = f.build();
    const matrix = r.decision_comparison.scenario_matrix;
    const rebound = matrix.scenarios.find(s => s.scenario_id === 'semiconductor_rebound');
    const hold = rebound.options.HOLD;
    // 全部持仓不动 → 参与度 100%。
    assert.equal(hold.upside_participation.participation_pct, 1);
    assert.ok(hold.upside_participation.reference_upside_cents > 0);
    // DEFENSIVE 权益清零（本 fixture 可卖、FUNDED）→ 参与度 0，机会成本 = 全部上涨。
    const defensive = rebound.options.DEFENSIVE;
    assert.equal(defensive.funding_availability.funding_status, 'FUNDED', 'fixture 应支持权益清零对照');
    assert.equal(defensive.upside_participation.participation_pct, 0);
    assert.equal(defensive.upside_participation.missed_upside_cents, hold.upside_participation.reference_upside_cents);
    // 无上涨分量的情景（滑点恶化）：参与度 null 并注明不适用。
    const liquidity = matrix.scenarios.find(s => s.scenario_id === 'etf_liquidity_slippage');
    assert.equal(liquidity.options.HOLD.upside_participation.participation_pct, null);
    assert.match(liquidity.options.HOLD.upside_participation.note, /不适用/);
  } finally { f.close(); }
});

test('B9 滑点恶化情景只放大滑点列，费用真实项不变且分列相加恒等', () => {
  const f = fixture();
  try {
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 1000 } });
    const matrix = r.decision_comparison.scenario_matrix;
    const base = matrix.scenarios.find(s => s.scenario_id === 'market_equity_drawdown');
    const slip = matrix.scenarios.find(s => s.scenario_id === 'etf_liquidity_slippage');
    for (const action of ALL) {
      const b = base.options[action].trading_fees;
      const s = slip.options[action].trading_fees;
      assert.equal(s.slippage_multiplier, 3, `${action} 滑点倍数`);
      assert.equal(s.actual_fee_estimate_cents, b.actual_fee_estimate_cents, `${action} 滑点放大不得改变真实费用项`);
      assert.equal(s.slippage_estimate_cents, b.slippage_estimate_cents * 3, `${action} 滑点应按 3× 放大`);
      assert.equal(s.actual_fee_estimate_cents + s.slippage_estimate_cents, s.fees_cents);
    }
    // 滑点恶化使 REDUCE 现金减少（多付的滑点直接扣现金；默认费率为正时断言具体差额）。
    const reduceFee = option(r, 'REDUCE').fee_breakdowns[0]?.breakdown;
    if (reduceFee && reduceFee.slippage_estimate_cents > 0) {
      const b = base.options.REDUCE.trading_fees;
      assert.equal(slip.options.REDUCE.total_assets_and_cash.cash_cents,
        base.options.REDUCE.total_assets_and_cash.cash_cents - b.slippage_estimate_cents * 2);
    }
    // 滑点情景（情景 5）不含价格冲击（shockForRow 恒为 0），价格损失列必须为 0；
    // 不能与情景 1（行情下跌，损失非 0）对比——那两列本来就不同口径。
    for (const action of ALL) {
      assert.equal(slip.options[action].declared_stress_loss.loss_cents, 0,
        `${action} 滑点情景不改价格`);
    }
  } finally { f.close(); }
});

test('B10 相关性情景不伪造点损失数字：损失与情景 1 同口径，风险在注记里声明', () => {
  const f = fixture();
  try {
    const r = f.build();
    const matrix = r.decision_comparison.scenario_matrix;
    const market = matrix.scenarios.find(s => s.scenario_id === 'market_equity_drawdown');
    const corr = matrix.scenarios.find(s => s.scenario_id === 'cross_industry_correlation_up');
    for (const action of ALL) {
      assert.equal(corr.options[action].declared_stress_loss.loss_cents,
        market.options[action].declared_stress_loss.loss_cents,
        `${action} 相关性情景不得改变单情景点损失`);
    }
    assert.ok(corr.declared_notes.some(n => /分散化收益/.test(n)), '必须声明分散收益被高估的风险');
    assert.ok(corr.options.HOLD.unverified_information.some(i => /相关性|分散/.test(i)));
  } finally { f.close(); }
});

test('B11 半导体单边情景：主题定向冲击只落在半导体持仓上', () => {
  const f = fixture();
  try {
    const r = f.build();
    const matrix = r.decision_comparison.scenario_matrix;
    const crash = matrix.scenarios.find(s => s.scenario_id === 'semiconductor_crash');
    const hold = crash.options.HOLD;
    // 基准持仓：159558 半导体 500000 分、159278 机器人 400000、516080 60000、511010 国债 100000、现金 200000 → 总资产 1260000。
    // 半导体 −30% → 损失 150000 分；其他不变。
    assert.equal(hold.declared_stress_loss.loss_cents, -150000);
    // 反弹情景 +20% → +100000。
    const rebound = matrix.scenarios.find(s => s.scenario_id === 'semiconductor_rebound');
    assert.equal(rebound.options.HOLD.declared_stress_loss.loss_cents, 100000);
    // 宽基反弹代理：非半导体权益 +6%（400000×6% + 60000×6% = 27600）、半导体 −10%（−50000）→ 净 −22400。
    const broad = matrix.scenarios.find(s => s.scenario_id === 'broad_rebound_semiconductor_lag');
    assert.ok(broad.declared_notes.some(n => /代理/.test(n)), '宽基代理口径必须声明');
    assert.equal(broad.options.HOLD.declared_stress_loss.loss_cents, -22400);
    // 债券不随宽基权益反弹（代理只作用于权益）：口径声明里必须明确写出。
    assert.ok(/债券等非权益资产不变/.test(broad.declared_notes.join(' ')), '代理口径须声明非权益不变');
  } finally { f.close(); }
});

test('B12 成长压缩情景按声明式主题分组，未归组持仓不被误伤', () => {
  const f = fixture();
  try {
    const r = f.build();
    const scen = r.decision_comparison.scenario_matrix.scenarios
      .find(s => s.scenario_id === 'growth_valuation_compression');
    // 成长主题 = 159558(-30%?) 不：成长集合是 semiconductor/robotics/innovative_drug →
    // 500000×−15% + 400000×−15% + 60000×−15% = −144000；国债与现金不受影响。
    assert.equal(scen.options.HOLD.declared_stress_loss.loss_cents, -144000);
    assert.ok(scen.declared_notes.some(n => /口径假设|不是市场风格因子/.test(n)));
  } finally { f.close(); }
});

// ---------------------------------------------------------------- 兼容性

test('B13 既有 decision_comparison 字段语义不变（显式研究数量路径）', () => {
  const f = fixture();
  try {
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100 } });
    const reduce = option(r, 'REDUCE');
    const rotate = option(r, 'ROTATE');
    // 卖出/轮动计划（D4 断言镜像）。
    assert.equal(reduce.sell_plan.quantity, 1000);
    assert.equal(reduce.executable, false);
    assert.equal(reduce.quantity_basis, 'user_research_parameter');
    assert.equal(reduce.funding_status, 'FUNDED');
    assert.ok(reduce.sell_plan.quantity <= reduce.sell_plan.sellable_quantity);
    assert.equal(reduce.sell_plan.quantity % 100, 0);
    assert.ok(reduce.sell_plan.one_lot_cents > 0);
    assert.equal(reduce.sell_plan.cash_after_cents,
      r.account_view.revalued_basis.cash_cents + reduce.sell_plan.gross_cents - reduce.sell_plan.fees_cents);
    // 轮动计划：优势状态是轮动轨字段。
    assert.equal(rotate.rotation_plan.buy_code, '510300.SH');
    assert.equal(rotate.rotation_plan.quantity, 100);
    assert.equal(rotate.rotation_plan.advantage_status, 'UNVERIFIED');
    assert.equal(rotate.executable, false);
    assert.equal(rotate.alpha_track.status, 'NOT_SUPPLIED');
    // decision_basis 顺序与取值不变。
    assert.deepEqual(ALL.map(a => option(r, a).decision_basis),
      ['NO_TRADE', 'RISK_CONTROL', 'ACTIVE_ROTATION', 'RISK_CONTROL', 'NO_TRADE']);
    // HOLD/NO_ACTION 的 HHI 与报告口径一致。
    assert.equal(option(r, 'HOLD').concentration_after.hhi, r.concentration.hhi);
    assert.equal(option(r, 'NO_ACTION').concentration_after.hhi, r.concentration.hhi);
    // 报告不产生任何动作；研究数量≠下单授权。
    assert.deepEqual(r.first_section.actions, []);
    assert.equal(r.actionable, false);
    for (const action of ALL) {
      assert.ok(option(r, action).not_actionable_because.join(' ').includes('研究数量不是用户确认的策略约束或交易授权'),
        `${action} 必须保留“研究数量≠授权”声明`);
    }
    // 费用：真实项与滑点分列（既有 fee_breakdowns 结构不变）。
    const fee = reduce.fee_breakdowns[0].breakdown;
    assert.equal(typeof fee.commission_cents, 'number');
    assert.equal(typeof fee.slippage_estimate_cents, 'number');
    assert.ok(fee.total_cents >= fee.slippage_estimate_cents);
  } finally { f.close(); }
});

test('B14 未确认账户：门控失败如实进入 risk_track.blocked_by，可执行性仍 false', () => {
  const f = fixture({ confirmed: false });
  try {
    const r = f.build();
    assert.equal(r.gate.satisfied, false);
    const hold = option(r, 'HOLD');
    assert.equal(hold.risk_track.gates_satisfied, false);
    assert.ok(hold.risk_track.blocked_by.some(code => code.startsWith('account_')),
      JSON.stringify(hold.risk_track.blocked_by));
    assert.equal(hold.executable, false);
    // 质量分层如实列出门控码（不再引用证据词）。
    const tier = r.data_quality.tiers.trade_plan_executability;
    assert.equal(tier.status, 'NOT_EXECUTABLE');
    assert.ok(/account_/.test(tier.detail), tier.detail);
    // 七情景矩阵在门控失败时依然给出（研究比较不被阻塞）。
    assert.equal(r.decision_comparison.scenario_matrix.scenarios.length, 7);
  } finally { f.close(); }
});

test('B15 矩阵确定性与政策中立：相同输入两次构建逐字节一致', () => {
  const f = fixture();
  try {
    const scenario = { sellCode: '159558.SZ', sellQuantity: 1000 };
    const a = f.build({ researchScenario: scenario, generatedAt: '2026-08-30T14:00:00Z' });
    const b = f.build({ researchScenario: scenario, generatedAt: '2026-08-30T15:00:00Z' });
    assert.deepEqual(a.decision_comparison.scenario_matrix, b.decision_comparison.scenario_matrix,
      '矩阵不得依赖生成时间');
    // 情景 1 在任何方案下都不依赖风险政策（政策只进 risk_budget）。
    const mat = JSON.stringify(a.decision_comparison.scenario_matrix);
    assert.ok(!/portfolio-drawdown-policy|PORTFOLIO_RISK_POLICY/.test(mat), '矩阵不得携带政策数据');
  } finally { f.close(); }
});

test('B16 研究数量无效时矩阵仍完整，REDUCE 行如实标注资金状态', () => {
  const f = fixture();
  try {
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 1 } }); // 非整手
    const reduce = option(r, 'REDUCE');
    assert.equal(reduce.sell_plan, null);
    assert.equal(reduce.funding_status, 'INVALID_QUANTITY');
    assert.ok(reduce.not_actionable_because.join(' ').length > 0);
    // risk_track 因资金状态被阻塞，但不含 Alpha 码。
    assert.equal(reduce.risk_track.gates_satisfied, false);
    assert.ok(reduce.risk_track.blocked_by.includes('funding_status:INVALID_QUANTITY'));
    // 矩阵完整且 REDUCE 行资金列如实。
    const matrix = r.decision_comparison.scenario_matrix;
    assert.equal(matrix.scenarios.length, 7);
    for (const scen of matrix.scenarios) {
      assert.equal(scen.options.REDUCE.funding_availability.funding_status, 'INVALID_QUANTITY');
      // INVALID 时 post-trade 状态是研究假设：现金回落基准。
      assert.equal(scen.options.REDUCE.total_assets_and_cash.cash_cents,
        scen.options.HOLD.total_assets_and_cash.cash_cents);
    }
  } finally { f.close(); }
});

test('B17 buildScenarioMatrix 纯函数：不读库、输出只由输入与情景表决定', () => {
  const pos = [
    { ts_code: '159558.SZ', value: 500000, asset_class: 'EQUITY', theme: 'semiconductor_equipment', industry: '半导体' },
    { ts_code: '511010.SH', value: 100000, asset_class: 'BOND', theme: 'unknown', industry: 'unclassified' },
  ];
  const mkState = action => ({
    action, positions: pos, cash_cents: 200000, wealth_cents: 0,
    funding_status: action === 'HOLD' || action === 'NO_ACTION' ? 'NO_TRADE' : 'FUNDED',
    fee_breakdowns: [], cash_sufficient_for_one_lot: true,
    invalidation_conditions: ['基线失效条件'], unverified_information: ['基线未验证信息'],
  });
  const input = {
    as_of_trade_date: '20260831',
    baseline_positions: pos, baseline_cash_cents: 200000, wealth_cents: 0,
    options: ALL.map(mkState),
  };
  const m1 = buildScenarioMatrix(input);
  const m2 = buildScenarioMatrix(input);
  assert.deepEqual(m1, m2, '同一输入必须逐字节一致');
  assert.equal(m1.scenarios.length, 7);
  // 情景 1 损失 = 500000×−0.10（权益） + 100000×−0.01（债券） = −51000。
  const s1 = m1.scenarios.find(s => s.scenario_id === 'market_equity_drawdown');
  assert.equal(s1.options.HOLD.declared_stress_loss.loss_cents, -51000);
  // 十列在无费用输入下也完整。
  const col = s1.options.HOLD;
  assert.equal(col.trading_fees.fees_cents, 0);
  assert.equal(col.trading_fees.actual_fee_estimate_cents + col.trading_fees.slippage_estimate_cents, 0);
  assert.ok(col.unverified_information.some(i => i.includes('基线未验证信息')));
  assert.ok(col.invalidation_conditions.some(i => i.includes('基线失效条件')));
  // 政策中立：矩阵输出不携带政策记录数据（政策状态只经 risk_budget 披露）。
  assert.ok(!/PORTFOLIO_RISK_POLICY|portfolio-drawdown-policy/.test(JSON.stringify(m1)));
});
