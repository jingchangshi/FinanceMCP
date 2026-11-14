import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Synthetic fixtures only. FINANCE_TEST_BUILD allows independent compilation
// without replacing the build shared by other agents or production tooling.
const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
const dir = mkdtempSync(join(tmpdir(), 'upgrade-report-'));
process.env.ASHARE_DATA_DIR = dir;
const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await load('portfolio/account.js');
const ledger = await load('portfolio/ledger.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');
const { renderDailyReport } = await load('portfolio/reportRenderer.js');
const { calculateFees, resolveFeeRules, saveFeeProfile } = await load('portfolio/fees.js');
const zeroFees = { commission_rate: 0, commission_min_cents: 0, transfer_fee_rate: 0, stamp_duty_rate: 0, slippage_rate_per_side: 0 };
const days = Array.from({ length: 61 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1 + i));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
});
const asOf = days.at(-1);
let count = 0;
function fixture({ quantity = 8000, cash = 200000, wealth = 0, missingFactor = false, badOhlc = false, indexOffset = false, bond = false } = {}) {
  const id = `fixture-${++count}`;
  const marketPath = join(dir, `${id}-market.sqlite`);
  const market = openAshareDb(marketPath);
  upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));
  const prices = { '159558.SZ': 1, '510300.SH': 4, '511010.SH': 100 };
  upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], Object.keys(prices).map(ts_code => ({
    ts_code, name: ts_code === '511010.SH' ? '合成国债ETF' : '合成沪深300ETF', fund_type: ts_code === '511010.SH' ? '债券型' : '股票型', invest_type: '被动指数型', benchmark: ts_code === '511010.SH' ? '国债指数' : '沪深300指数', status: 'L', market: 'E',
  })));
  for (const [code, close] of Object.entries(prices)) {
    upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], days.map((date, i) => ({
      ts_code: code, trade_date: date, open: close, high: badOhlc && code === '159558.SZ' && i === 45 ? close / 2 : close,
      low: close, close, pre_close: close, pct_chg: 0, vol: 1000000, amount: 100000,
    })));
    upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], days.filter((_, i) => !(missingFactor && code === '159558.SZ' && i === 45)).map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
    upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], days.map(trade_date => ({ ts_code: code, trade_date, fd_share: 100000 })));
  }
  upsertRows(market, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], days.filter((_, i) => !(indexOffset && i === days.length - 1)).map(trade_date => ({ ts_code: '000300.SH', trade_date, open: 100, high: 100, low: 100, close: 100, pre_close: 100, vol: 1000, amount: 1000 })));
  const reportId = `SYNTH-${id}`;
  const path = `reports/${id}.json`;
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify({ report_id: reportId, as_of_trade_date: asOf, status: 'READY', market: { regime: 'range', breadth: { up_ratio: .2, median_pct_chg: -1, amount_yi: 1000, amount_ma20_yi: 3000, pct_above_ma20: 10, pct_above_ma60: 10 }, indices: [] }, sectors: { all: [], top: [], bottom: [] } }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(reportId, asOf, 'READY', '2026-08-30T14:00:00Z', path, 'manual');
  const portfolio = openPortfolioDb(join(dir, `${id}-portfolio.sqlite`), { marketPath });
  const positions = [{ ts_code: '159558.SZ', name: '合成权益ETF', quantity, ref_price_milli: 1000, ref_cost_milli: 1000, market_value_cents: quantity * 100 }];
  if (bond) positions.push({ ts_code: '511010.SH', name: '合成国债ETF', quantity: 100, ref_price_milli: 100000, ref_cost_milli: 100000, market_value_cents: 1000000 });
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  account.importSnapshot(portfolio, { snapshot_id: id, as_of: asOf, source: 'synthetic-test', note: 'synthetic', warnings: [], is_current: false, positions, totals: { total_assets_cents: securities + cash + wealth, securities_mv_cents: securities, cash_cents: cash, wealth_cents: wealth, unrealized_pnl_cents: 0 } });
  ledger.initBaseline(portfolio, id, { asOf, snapshotId: id });
  account.markSnapshotCurrent(portfolio, id, { confirmedBy: 'synthetic-test' });
  ledger.confirmRealAccount(portfolio, id, { confirm: true, note: 'synthetic-test' });
  ledger.setAccountCompleteness(portfolio, id, { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: false }, { confirm: true, recordedBy: 'synthetic-test' });
  const build = (extra = {}) => buildDailyReport({ portfolioDb: portfolio, marketDb: market, accountId: id, snapshotId: id, asOfTradeDate: asOf, ...extra });
  return { build, market, portfolio, id, close: () => { market.close(); portfolio.close(); } };
}
const option = (report, action) => report.decision_comparison.options.find(row => row.action === action);
const rounded = n => Math.round(n * 1e6) / 1e6;

test('older reports without diluted cost fields remain renderable', () => {
  const f = fixture();
  try {
    const report = f.build();
    for (const holding of report.holdings) {
      delete holding.diluted_cost_per_share;
      delete holding.diluted_total_cost_cents;
    }
    assert.match(renderDailyReport(report).user, /本期无法计算摊薄成本/);
  } finally { f.close(); }
});

test('candidate screening uses the actual account holdings', () => {
  const f = fixture({ bond: true });
  try {
    const report = f.build();
    const rows = report.candidate_vs_cash.screening.candidates;
    assert.equal(rows.find(row => row.ts_code === '511010.SH')?.held, true);
    assert.equal(rows.find(row => row.ts_code === '159241.SZ')?.held, false);
  } finally { f.close(); }
});

test('candidate cash competition reuses screening eligibility and shows eligible rows first', () => {
  const f = fixture({ bond: true });
  try {
    const report = f.build();
    const entries = report.candidate_vs_cash.entries;
    const rows = report.candidate_vs_cash.screening.candidates;
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      const row = rows.find(item => item.ts_code === entry.ts_code);
      assert.ok(row, `${entry.ts_code} 必须来自同一份筛选结果`);
      assert.equal(entry.eligibility, row.eligibility, `${entry.ts_code} 应复用筛选资格，不重新筛选`);
    }
    // 展示顺序：eligible 优先，research_only 随后；组内保持筛选原始排名。
    const priority = { eligible: 0, research_only: 1, excluded: 2 };
    const order = entries.map(entry => priority[entry.eligibility]);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    // 该 fixture 中 510300.SH 证据齐全，应为 eligible；159558/511010 未声明可比基准，
    // 只能是研究观察。两者同分，原始排名按代码把 159558 排在 510300 之前。
    assert.equal(rows.find(row => row.ts_code === '510300.SH').eligibility, 'eligible');
    assert.ok(rows.findIndex(row => row.ts_code === '159558.SZ') < rows.findIndex(row => row.ts_code === '510300.SH'));
    assert.equal(entries[0].ts_code, '510300.SH', 'eligible 应优先于原始排名更高的 research_only');
    const observation = entries.find(entry => entry.ts_code === '159558.SZ');
    assert.equal(observation.eligibility, 'research_only');
    assert.match(observation.note, /仅研究观察/);
    // 资格标注不改变资金/费用计算：100 份 × 1 元 = 10000 分，另加买入费用。
    assert.equal(observation.one_lot_cents, 10000);
    assert.ok(observation.one_lot_total_cents > observation.one_lot_cents);
  } finally { f.close(); }
});

test('section F qualifies funding claims by screening eligibility', () => {
  const f = fixture({ bond: true });
  try {
    const report = f.build();
    const user = renderDailyReport(report, { now: '2026-08-30T15:00:00Z' }).user;
    const section = user.split('## F. 是否有更好的选择')[1].split('## G. 风险与情景')[0];
    assert.match(section, /1 项候选通过完整筛选资格/);
    // 资金比较只算 eligible；159558 的一手也买得起，但它是 research_only，不得计数。
    assert.match(section, /其中 1 项现金买得起一手/);
    assert.match(section, /仅有研究资格、只作研究观察/);
    assert.match(section, /均不参与资金比较/);
    assert.doesNotMatch(section, /候选高分项集中于债券\/货币类/);
    // 511010 是债券类但仅为研究观察，不能作为“完整资格防御候选”的资金门槛。
    assert.match(section, /本期没有完整资格的债券\/货币类候选/);
  } finally { f.close(); }
});

test('section F does not treat research-only candidates as funding candidates', () => {
  const f = fixture();
  try {
    const report = f.build();
    // 模拟没有任何候选通过完整资格：510300 退为研究观察。
    const onlyEligible = report.candidate_vs_cash.entries.find(entry => entry.eligibility === 'eligible');
    assert.ok(onlyEligible);
    onlyEligible.eligibility = 'research_only';
    const user = renderDailyReport(report, { now: '2026-08-30T15:00:00Z' }).user;
    const section = user.split('## F. 是否有更好的选择')[1].split('## G. 风险与情景')[0];
    assert.match(section, /本期没有通过完整筛选资格的 ETF 候选/);
    assert.match(section, /只作研究观察/);
    assert.doesNotMatch(section, /现金买得起一手/);
    assert.doesNotMatch(section, /完整资格候选中一手含费最低/);
  } finally { f.close(); }
});

test('older reports without candidate eligibility keep the legacy section F wording', () => {
  const f = fixture({ bond: true });
  try {
    const report = f.build();
    for (const entry of report.candidate_vs_cash.entries) delete entry.eligibility;
    const user = renderDailyReport(report, { now: '2026-08-30T15:00:00Z' }).user;
    const section = user.split('## F. 是否有更好的选择')[1].split('## G. 风险与情景')[0];
    assert.match(section, /候选高分项集中于债券\/货币类/);
    assert.doesNotMatch(section, /完整筛选资格/);
    assert.doesNotMatch(section, /研究观察/);
  } finally { f.close(); }
});

test('HOLD/NO_ACTION preserve securities-only HHI, including cash and wealth denominators', () => {
  for (const wealth of [0, 100000]) {
    const f = fixture({ wealth });
    try {
      const r = f.build();
      assert.equal(option(r, 'HOLD').concentration_after.hhi, r.concentration.hhi);
      assert.equal(option(r, 'NO_ACTION').concentration_after.hhi, r.concentration.hhi);
      assert.equal(option(r, 'HOLD').total_assets_after_cents, 1000000 + wealth);
    } finally { f.close(); }
  }
});

test('unverified concentration and score create NO_ACTION and no automatic 50% sale quantity', () => {
  const f = fixture();
  try {
    const r = f.build();
    assert.equal(r.status, 'NO_ACTION');
    assert.deepEqual(r.first_section.actions, []);
    assert.equal(option(r, 'REDUCE').sell_plan, null);
    assert.equal(option(r, 'ROTATE').rotation_plan, null);
    assert.equal(option(r, 'REDUCE').funding_status, 'QUANTITY_REQUIRED');
    assert.equal(r.gate.satisfied, true);
    assert.equal(r.data_quality.tiers.trade_plan_executability.status, 'NOT_EXECUTABLE');
  } finally { f.close(); }
});

test('explicit research sale and rotation conserve value after both fees, recomputing HHI and stress', () => {
  const f = fixture();
  try {
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 3000, buyCode: '510300.SH', buyQuantity: 100 } });
    const reduce = option(r, 'REDUCE'), rotate = option(r, 'ROTATE');
    const sellFee = calculateFees(300000, 'sell', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: '159558.SZ', kind: 'ETF' })).total_cents;
    const buyFee = calculateFees(40000, 'buy', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: '510300.SH', kind: 'ETF' })).total_cents;
    assert.equal(reduce.cash_after_cents, 500000 - sellFee);
    assert.equal(reduce.concentration_after.hhi, rounded((500000 / (1000000 - sellFee)) ** 2));
    assert.equal(rotate.fees_cents, sellFee + buyFee);
    assert.equal(rotate.cash_after_cents, 460000 - sellFee - buyFee);
    assert.equal(rotate.total_assets_after_cents, 1000000 - sellFee - buyFee);
    assert.equal(rotate.concentration_after.hhi, rounded((500000 / rotate.total_assets_after_cents) ** 2 + (40000 / rotate.total_assets_after_cents) ** 2));
    assert.equal(rotate.exposure_after.equity_weight, rounded(540000 / rotate.total_assets_after_cents));
    assert.equal(rotate.stress_after.loss_cents, -54000);
    assert.equal(rotate.rotation_plan.quantity, 100);
    assert.equal(rotate.sell_plan.quantity, 3000);
    assert.equal(rotate.executable, false);
  } finally { f.close(); }
});

test('research quantities are independent of execution gate; no ledger sellability is invented', () => {
  const f = fixture();
  try {
    ledger.setAccountCompleteness(f.portfolio, f.id, { as_of: asOf, reported_events_through: asOf, unreported_trade_risk: true }, { confirm: true, recordedBy: 'synthetic-test' });
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 3000 } });
    assert.equal(r.gate.satisfied, false);
    assert.equal(option(r, 'REDUCE').sell_plan.quantity, 3000);
    assert.equal(option(r, 'REDUCE').executable, false);
    assert.equal(r.actionable, false);
  } finally { f.close(); }
});

test('unaffordable whole lot never becomes fractional spend and leaves scenario at HOLD', () => {
  const f = fixture({ cash: 0 });
  try {
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 100, buyCode: '510300.SH', buyQuantity: 100 } });
    const rotate = option(r, 'ROTATE');
    assert.equal(rotate.funding_status, 'INSUFFICIENT_CASH');
    assert.equal(rotate.rotation_plan.spend_cents, null);
    assert.equal(rotate.cash_after_cents, 0);
    assert.deepEqual(rotate.concentration_after, option(r, 'HOLD').concentration_after);
    assert.equal(rotate.fees_cents, 0);
  } finally { f.close(); }
});

test('cash equal to gross but insufficient for buy fee cannot fund a whole lot', () => {
  const f = fixture({ cash: 30000 });
  try {
    const r = f.build({ fees: { ...zeroFees, commission_min_cents: 100 }, researchScenario: { sellCode: '159558.SZ', sellQuantity: 100, buyCode: '510300.SH', buyQuantity: 100 } });
    assert.equal(option(r, 'ROTATE').funding_status, 'INSUFFICIENT_CASH');
    assert.equal(option(r, 'ROTATE').rotation_plan.cash_sufficient_for_one_lot, false);
  } finally { f.close(); }
});

test('rejects non-lot research quantity and oversell without clamping a fabricated trade', () => {
  const f = fixture();
  try {
    for (const sellQuantity of [1, 8100, -100]) {
      const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity } });
      assert.equal(option(r, 'REDUCE').sell_plan, null);
      assert.equal(option(r, 'REDUCE').funding_status, 'INVALID_QUANTITY');
    }
  } finally { f.close(); }
});

test('defensive and bond rotation apply actual asset class shocks and publish exposure maps', () => {
  const f = fixture({ cash: 1000000, bond: true });
  try {
    const r = f.build({ fees: zeroFees, researchScenario: { sellCode: '159558.SZ', sellQuantity: 3000, buyCode: '511010.SH', buyQuantity: 100 } });
    const rotate = option(r, 'ROTATE');
    assert.equal(rotate.by_asset_class_after.find(row => row.asset_class === 'BOND').market_value_cents, 2000000);
    assert.equal(rotate.by_asset_class_after.find(row => row.asset_class === 'EQUITY').market_value_cents, 500000);
    assert.equal(rotate.stress_after.loss_cents, -70000);
    assert.ok(rotate.theme_exposure_after.some(row => row.key === 'semiconductor_equipment'));
    assert.ok(rotate.industry_exposure_after.some(row => row.key === '半导体'));
    assert.equal(option(r, 'DEFENSIVE').cash_after_cents, 1800000);
    assert.equal(option(r, 'DEFENSIVE').by_asset_class_after.find(row => row.asset_class === 'BOND').market_value_cents, 1000000);
    assert.equal(option(r, 'DEFENSIVE').stress_after.loss_cents, -10000);
    // Active rotation needs advantage evidence; risk control does not, but both stay non-executable here.
    assert.deepEqual(['HOLD', 'REDUCE', 'ROTATE', 'DEFENSIVE', 'NO_ACTION'].map(a => option(r, a).decision_basis),
      ['NO_TRADE', 'RISK_CONTROL', 'ACTIVE_ROTATION', 'RISK_CONTROL', 'NO_TRADE']);
    for (const o of r.decision_comparison.options) {
      assert.equal(o.risk_budget.status, 'NO_USER_CONFIRMED_PORTFOLIO_BUDGET');
      assert.equal(o.risk_budget.stress_loss_pct_of_total_assets, Math.round(o.stress_after.loss_cents / o.total_assets_after_cents * 1e8) / 1e6);
    }
  } finally { f.close(); }
});

test('per-code confirmed fee model is used in research comparison', () => {
  const f = fixture();
  try {
    saveFeeProfile(f.portfolio, f.id, { id: 'synthetic-low-minimum', code: '159558.SZ', effective_from: days[0], values: { commission_min_cents: 0, commission_rate: 0 }, evidence: { commission_min_cents: { level: 'CONFIRMED', source: 'synthetic' }, commission_rate: { level: 'CONFIRMED', source: 'synthetic' } } });
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 100 } });
    assert.equal(option(r, 'REDUCE').sell_plan.fees_cents, calculateFees(10000, 'sell', resolveFeeRules({ db: f.portfolio, accountId: f.id, asOf, code: '159558.SZ', kind: 'ETF' })).total_cents);
  } finally { f.close(); }
});

test('60 trading day return requires 61 bars; valid zero broad return is available', () => {
  const f = fixture();
  try {
    const research = f.build().holdings[0].research;
    assert.equal(research.trend.ret60_pct, 0);
    assert.equal(research.data.bars_used, 61);
    assert.equal(research.trend.excess_ret20_vs_broad_pct, 0);
    assert.ok(!research.availability.unavailable.some(line => line.includes('index_daily')));
  } finally { f.close(); }
});

test('missing adjustment factor never bridges raw and adjusted prices or compresses windows', () => {
  const f = fixture({ missingFactor: true });
  try {
    const research = f.build().holdings[0].research;
    assert.equal(research.trend.ret20_pct, null);
    assert.equal(research.trend.ret60_pct, null);
    assert.equal(research.trend.ma20_cny, null);
    assert.equal(research.trend.realized_vol_60d_pct, null);
    assert.ok(research.availability.unavailable.some(line => /因子|factor/.test(line)));
  } finally { f.close(); }
});

test('invalid historical OHLC blocks affected research windows', () => {
  const f = fixture({ badOhlc: true });
  try {
    const research = f.build().holdings[0].research;
    assert.equal(research.trend.ret20_pct, null);
    assert.ok(research.availability.unavailable.some(line => /OHLC/.test(line)));
  } finally { f.close(); }
});

test('relative return cannot compare mismatched benchmark dates', () => {
  const f = fixture({ indexOffset: true });
  try {
    assert.equal(f.build().holdings[0].research.trend.excess_ret20_vs_broad_pct, null);
  } finally { f.close(); }
});

test('missing ledger never invents sellable quantity or a defensive liquidation', () => {
  const f = fixture();
  try {
    f.portfolio.prepare('DELETE FROM account_baseline WHERE account_id=?').run(f.id);
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 100 } });
    assert.equal(option(r, 'REDUCE').funding_status, 'SELLABILITY_UNKNOWN');
    assert.equal(option(r, 'REDUCE').sell_plan, null);
    assert.equal(option(r, 'DEFENSIVE').funding_status, 'SELLABILITY_UNKNOWN');
    assert.equal(option(r, 'DEFENSIVE').cash_after_cents, 200000);
  } finally { f.close(); }
});

test('T+1 bought shares cannot be sold in research comparisons on the buy day', () => {
  const f = fixture({ cash: 1000000 });
  try {
    ledger.recordEvent(f.portfolio, { event_id: 'synthetic-same-day-buy', account_id: f.id, event_type: 'TRADE_BUY', occurred_on: asOf, ts_code: '159558.SZ', quantity: 1000, price_milli: 1000, fee_cents: 0, tax_cents: 0, source: 'synthetic' });
    const r = f.build({ researchScenario: { sellCode: '159558.SZ', sellQuantity: 9000 } });
    assert.equal(r.holdings[0].quantity, 9000, 'research summary must consume the reconstructed quantity');
    assert.equal(r.account_view.revalued_basis.cash_cents, 900000);
    assert.equal(r.account_view.revalued_basis.total_assets_cents, 1800000);
    assert.equal(option(r, 'REDUCE').funding_status, 'NOT_SELLABLE');
    assert.equal(option(r, 'REDUCE').sell_plan, null);
  } finally { f.close(); }
});

test('research windows retain missing trading day gaps rather than compressing periods', () => {
  const f = fixture();
  try {
    f.market.prepare('DELETE FROM fund_daily WHERE ts_code=? AND trade_date=?').run('159558.SZ', days.at(-10));
    const research = f.build().holdings[0].research;
    assert.equal(research.trend.ret20_pct, null);
    assert.equal(research.trend.ma20_cny, null);
    assert.equal(research.trend.ret60_pct, null);
  } finally { f.close(); }
});

test('candidate cash competition includes a buy fee and rejects stale affordability claims', () => {
  const f = fixture({ cash: 10000 });
  try {
    const entry = f.build().candidate_vs_cash.entries.find(row => row.ts_code === '159558.SZ');
    assert.ok(entry);
    assert.equal(entry.one_lot_cents, 10000);
    assert.ok(entry.one_lot_total_cents > 10000);
    assert.equal(entry.cash_sufficient_for_one_lot, false);
  } finally { f.close(); }
});

test('invalid generated timestamp and calendar dates fail explicitly', () => {
  const f = fixture();
  try {
    assert.throws(() => f.build({ generatedAt: 'invalid' }), /generatedAt/);
    assert.throws(() => f.build({ asOfTradeDate: '20260230' }), /有效日期/);
  } finally { f.close(); }
});

test('generated_at is valid and independent of report hash; changed fees change report hash', () => {
  const f = fixture();
  try {
    const scenario = { sellCode: '159558.SZ', sellQuantity: 3000 };
    const a = f.build({ researchScenario: scenario, generatedAt: '2026-08-30T14:00:00Z' });
    const b = f.build({ researchScenario: scenario, generatedAt: '2026-08-30T15:00:00Z' });
    const c = f.build({ researchScenario: scenario, fees: zeroFees });
    assert.equal(a.report_id, b.report_id);
    assert.notEqual(a.report_id, c.report_id);
    assert.ok(Number.isFinite(Date.parse(f.build().timestamps.generated_at)));
  } finally { f.close(); }
});
