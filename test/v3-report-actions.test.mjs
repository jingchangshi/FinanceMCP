import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 真实 buildDailyReport 入口回归：验证 2 个股 + 成长/价值/蓄水池腿不被 3 动作上限截断，
// 以及“理财 wealth 不计入单位化 NAV”时入金不会触发假 L2。

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-report-actions-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { CORE_INDICES } = await import('../build/ashare/ingest.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const {
  initBaseline, confirmRealAccount, setAccountCompleteness, recordEvent,
} = await import('../build/portfolio/ledger.js');
const { ensureDeconcentrationPlan } = await import('../build/portfolio/deconcentrationPlan.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { buildInvestmentResearchBundle } = await import('../build/portfolio/researchBundle.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const DAYS = weekdays('20260401', 145);
const D0 = DAYS.at(-2);
const D1 = DAYS.at(-1);

function writeMarketReport(db, day) {
  const reportId = `ASR-${day}-REPORT-ACTIONS`;
  const payload = {
    report_id: reportId,
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: day,
    generated_at: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T21:40:00+08:00`,
    status: 'READY',
    run_mode: 'manual',
    market: {
      regime: 'bull',
      regime_label: '偏强',
      tone: 'positive',
      judgement: ['合成测试行情'],
      indices: [{ ts_code: '000300.SH', name: '沪深300', close: 3932, pct_chg: 0.4, ret5: 1.5, ret20: 4.5, amount_yi: 15000, above_ma20: true, above_ma60: true }],
      breadth: {
        stocks: 5000, up: 3500, down: 1400, flat: 100, limit_up: 70, limit_down: 5,
        up_ratio: 0.7, median_pct_chg: 0.9, amount_yi: 15000, amount_ma20_yi: 12000,
        pct_above_ma20: 70, pct_above_ma60: 65,
      },
    },
    sectors: { method: 'synthetic', top: [{ industry: '强行业', rank: 1, strength: 0.9, ret5_median_pct: 2, ret20_median_pct: 9, pct_above_ma20: 85 }], bottom: [], all: [] },
    disclaimer: '合成测试日报，不是投资建议。',
  };
  const reportDir = join(dir, 'reports', day);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${reportId}.json`), JSON.stringify(payload, null, 2));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(reportId, day, 'READY', payload.generated_at, `reports/${day}/${reportId}.json`, 'manual');
}

function seedMarket(name) {
  const db = openAshareDb(join(dir, `${name}-market.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    ...DAYS.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: DAYS[i - 1] ?? null })),
    { cal_date: weekdays(D1, 2)[1], is_open: 1, pretrade_date: D1 },
  ]);

  const background = [
    ...Array.from({ length: 20 }, (_, i) => ({ ts_code: `${601100 + i}.SH`, symbol: String(601100 + i), name: `强股${i}`, industry: '强行业', drift: 0.0025 })),
    ...Array.from({ length: 20 }, (_, i) => ({ ts_code: `${601200 + i}.SH`, symbol: String(601200 + i), name: `中股${i}`, industry: '中行业', drift: 0 })),
    ...Array.from({ length: 20 }, (_, i) => ({ ts_code: `${601300 + i}.SH`, symbol: String(601300 + i), name: `弱股${i}`, industry: '弱行业', drift: -0.002 })),
  ];
  const probes = [
    { ts_code: '601001.SH', symbol: '601001', name: '优质回踩A', industry: '强行业', scale: 1 },
    { ts_code: '601007.SH', symbol: '601007', name: '优质回踩B', industry: '强行业', scale: 1.2 },
  ];
  const stopStock = { ts_code: '600519.SH', symbol: '600519', name: '止损测试股', industry: '弱行业' };
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'list_date', 'list_status'], [
    ...background.map(s => ({ ts_code: s.ts_code, symbol: s.symbol, name: s.name, industry: s.industry, list_date: '20180101', list_status: 'L' })),
    ...probes.map(s => ({ ts_code: s.ts_code, symbol: s.symbol, name: s.name, industry: s.industry, list_date: '20180101', list_status: 'L' })),
    { ...stopStock, list_date: '20180101', list_status: 'L' },
  ]);

  const dailyRows = [];
  const adjRows = [];
  const limitRows = [];
  const basicRows = [];
  const finaRows = [];
  for (const s of background) {
    let prev = 10;
    for (let i = 0; i < DAYS.length; i += 1) {
      const close = Math.round(10 * Math.pow(1 + s.drift, i) * 100) / 100;
      dailyRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], open: close * 0.998, close, pre_close: prev, high: close * 1.01, low: close * 0.99, pct_chg: 0.2, vol: 1e5, amount: 2e5 });
      adjRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], adj_factor: 1 });
      limitRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], up_limit: prev * 1.1, down_limit: prev * 0.9 });
      basicRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], turnover_rate: 1.5, pe_ttm: 20, pb: 2, circ_mv: 1e6, total_mv: 1.2e6 });
      prev = close;
    }
  }
  for (const s of probes) {
    let prev = 10 * s.scale;
    for (let i = 0; i < DAYS.length; i += 1) {
      let close = 10 + (10 * Math.min(i, 136)) / 136;
      let open = close * 0.996;
      let high = close * 1.01;
      let low = open * 0.99;
      let vol = 1e5;
      let amount = 2e5;
      if (i === 137) { close = 20.4; open = 20.1; high = 20.5; low = 20.0; vol = 1.2e5; amount = 2.4e5; }
      else if (i === 138) { close = 20.8; open = 20.4; high = 20.9; low = 20.3; vol = 1.3e5; amount = 2.6e5; }
      else if (i === 139) { close = 21.4; open = 20.85; high = 21.8; low = 20.8; vol = 1.4e5; amount = 3.0e5; }
      else if (i === 140) { close = 20.6; open = 21.0; high = 21.1; low = 20.3; vol = 0.5e5; amount = 1.5e5; }
      else if (i === 141) { close = 20.1; open = 20.4; high = 20.5; low = 19.95; vol = 0.45e5; amount = 1.5e5; }
      else if (i === 142) { close = 19.9; open = 20.0; high = 20.1; low = 19.8; vol = 0.4e5; amount = 1.5e5; }
      else if (i === 143) { close = 19.9; open = 19.95; high = 20.05; low = 19.82; vol = 0.4e5; amount = 1.5e5; }
      else if (i === 144) { close = 20.35; open = 19.92; high = 20.5; low = 19.88; vol = 1.2e5; amount = 2.4e5; }
      close = Math.round(close * s.scale * 100) / 100;
      dailyRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], open: open * s.scale, close, pre_close: prev, high: high * s.scale, low: low * s.scale, pct_chg: 0.2, vol, amount });
      adjRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], adj_factor: 1 });
      limitRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], up_limit: prev * 1.1, down_limit: prev * 0.9 });
      basicRows.push({ ts_code: s.ts_code, trade_date: DAYS[i], turnover_rate: 2, pe_ttm: 22, pb: 2.5, circ_mv: 1.2e6, total_mv: 1.5e6 });
      prev = close;
    }
    finaRows.push({
      ts_code: s.ts_code, ann_date: '20260820', end_date: '20260630',
      roe: 8.5, roe_dt: 8.2, eps: 0.95, ocfps: 1.1, debt_to_assets: 35, ocf_to_profit: 85,
      or_yoy: 18, netprofit_yoy: 22, dt_netprofit_yoy: 20, grossprofit_margin: 34,
    });
  }
  // 600519.SH：D0 10.00，D1 9.00 → 触发 P1 -8% 硬止损，用于验证执行清单不被一页摘要截断。
  for (const day of DAYS) {
    const close = day === D1 ? 9.0 : 10.0;
    const preClose = 10.0;
    dailyRows.push({ ts_code: stopStock.ts_code, trade_date: day, open: close, high: close * 1.01, low: close * 0.99, close, pre_close: preClose, pct_chg: ((close / preClose) - 1) * 100, vol: 1e5, amount: 2e5 });
    adjRows.push({ ts_code: stopStock.ts_code, trade_date: day, adj_factor: 1 });
    limitRows.push({ ts_code: stopStock.ts_code, trade_date: day, up_limit: 11, down_limit: 9 });
    basicRows.push({ ts_code: stopStock.ts_code, trade_date: day, turnover_rate: 1.5, pe_ttm: 20, pb: 2, circ_mv: 1e6, total_mv: 1.2e6 });
  }
  // 个股持仓取价需要 suspend_d 当日同步证明；无停牌记录时也要有 status=ok 的同步行。
  upsertRows(db, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'], [
    { dataset: 'suspend_d', key: D0, rows: 0, status: 'ok', message: null, synced_at: `${D0.slice(0, 4)}-${D0.slice(4, 6)}-${D0.slice(6, 8)}T15:00:00+08:00` },
    { dataset: 'suspend_d', key: D1, rows: 0, status: 'ok', message: null, synced_at: `${D1.slice(0, 4)}-${D1.slice(4, 6)}-${D1.slice(6, 8)}T15:00:00+08:00` },
  ]);
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], dailyRows);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], adjRows);
  upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], limitRows);
  upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'], basicRows);
  upsertRows(db, 'fina_indicator', ['ts_code', 'ann_date', 'end_date', 'roe', 'roe_dt', 'eps', 'ocfps', 'debt_to_assets', 'ocf_to_profit', 'or_yoy', 'netprofit_yoy', 'dt_netprofit_yoy', 'grossprofit_margin'], finaRows);

  const idxRows = [];
  for (const code of Object.keys(CORE_INDICES)) {
    for (let i = 0; i < DAYS.length; i += 1) {
      const close = code === '399006.SZ' ? 2000 + i * 5 : 3500 + i * 3;
      const prev = i > 0 ? (code === '399006.SZ' ? 2000 + (i - 1) * 5 : 3500 + (i - 1) * 3) : close;
      idxRows.push({ ts_code: code, trade_date: DAYS[i], open: close, high: close * 1.005, low: close * 0.995, close, pre_close: prev, pct_chg: 0.3, vol: 1e8, amount: 1e8 });
    }
  }
  upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], idxRows);

  const funds = [
    { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', base: 0.90, day1: 0.81 },
    { ts_code: '159205.SZ', name: '东财创业板ETF', fund_type: '股票型', base: 1.00 },
    { ts_code: '159337.SZ', name: '东财中证500ETF', fund_type: '股票型', base: 2.00 },
    { ts_code: '589850.SH', name: '东财科创50ETF', fund_type: '股票型', base: 1.00 },
    { ts_code: '159290.SZ', name: '东财创业板综合ETF', fund_type: '股票型', base: 1.00 },
    { ts_code: '159330.SZ', name: '东财沪深300ETF', fund_type: '股票型', base: 4.00 },
    { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', base: 100.00 },
  ];
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    funds.map(f => ({ ts_code: f.ts_code, name: f.name, fund_type: f.fund_type, invest_type: '被动指数型', benchmark: f.name, status: 'L', market: 'E' })));
  for (const f of funds) {
    const price = (day) => (f.day1 !== undefined && day === D1 ? f.day1 : f.base);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      DAYS.map(day => {
        const close = price(day);
        return { ts_code: f.ts_code, trade_date: day, open: close, high: close * 1.005, low: close * 0.995, close, pre_close: close, pct_chg: 0, vol: 1e6, amount: 1e6 };
      }));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], DAYS.map(day => ({ ts_code: f.ts_code, trade_date: day, adj_factor: 1 })));
    upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      DAYS.map(day => ({ ts_code: f.ts_code, trade_date: day, fd_share: 1e8, fund_type: f.fund_type, market: 'E' })));
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
      DAYS.map(day => ({ ts_code: f.ts_code, ann_date: day, nav_date: day, unit_nav: price(day), accum_nav: price(day), adj_nav: price(day) })));
  }

  writeMarketReport(db, D0);
  writeMarketReport(db, D1);
  return db;
}

function snapshotData({ id, asOf, positions, cashCents, wealthCents = 0 }) {
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  return {
    snapshot_id: id,
    as_of: asOf,
    source: 'test',
    note: 'v3 report actions',
    warnings: [],
    is_current: false,
    positions,
    totals: {
      total_assets_cents: securities + cashCents + wealthCents,
      securities_mv_cents: securities,
      cash_cents: cashCents,
      wealth_cents: wealthCents,
      unrealized_pnl_cents: 0,
    },
  };
}

test('日报输出：2 个个股买单 + 成长/价值/国债蓄水池腿不被 3 动作上限截断', () => {
  const mDb = seedMarket('cap');
  const pDb = openPortfolioDb(join(dir, 'cap-portfolio.sqlite'), { marketPath: join(dir, 'cap-market.sqlite') });
  const acc = 'real-report';
  try {
    const pos = [
      { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20_000, ref_price_milli: 900, ref_cost_milli: 900, market_value_cents: 1_800_000 },
      { ts_code: '600519.SH', name: '止损测试股', quantity: 100, ref_price_milli: 10_000, ref_cost_milli: 10_000, market_value_cents: 100_000 },
    ];
    importSnapshot(pDb, snapshotData({ id: 'snap-cap-d0', asOf: D0, positions: pos, cashCents: 8_100_000 }));
    initBaseline(pDb, acc, { asOf: D0, snapshotId: 'snap-cap-d0' });
    markSnapshotCurrent(pDb, 'snap-cap-d0', { confirmedBy: 'test' });
    confirmRealAccount(pDb, acc, { confirm: true, note: 'test' });
    setAccountCompleteness(pDb, acc, {
      as_of: D1, reported_events_through: D1, unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'test' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${acc}`, '10000000');

    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: acc,
      snapshotId: 'snap-cap-d0',
      asOfTradeDate: D1,
    });
    assert.equal(report.first_section.actions.length, 3, '一页摘要仍只列最多 3 个动作');
    assert.ok(report.execution_plan.count >= 4, `执行清单必须保留全部动作，实际 ${report.execution_plan.count}`);
    const summaryCodes = new Set(report.first_section.actions.flatMap(action => action.legs).map(leg => leg.ts_code));
    const execCodes = new Set(report.execution_plan.actions.flatMap(action => action.legs).map(leg => leg.ts_code));
    assert.ok(summaryCodes.has('600519.SH'), 'P1 止损应进入一页摘要');
    assert.ok(summaryCodes.has('601001.SH'), '应有第一只个股买单');
    assert.ok(summaryCodes.has('601007.SH'), '应有第二只个股买单');
    assert.ok(execCodes.has('159205.SZ'), '成长桶腿不得被执行清单截断');
    assert.ok(execCodes.has('159337.SZ'), '成长桶第二腿不得被截断');
    assert.ok(execCodes.has('589850.SH'), '成长桶第三腿不得被截断');
    assert.ok(execCodes.has('159330.SZ'), '价值桶腿不得被截断');
    assert.ok(execCodes.has('511010.SH'), '国债蓄水池腿不得被截断');
    assert.equal(execCodes.has('159290.SZ'), false, '成长桶只取 EXP-01 前 3 只');
    assert.equal(report.execution_plan.actions.filter(action => action.code === 'P3-SUPER-ETF-REBALANCE').length, 1, '成长/价值/蓄水池必须合并为一个 action');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('日报输出：wealth 不计入单位化 NAV，入金 90% 不会触发假 L2', () => {
  const mDb = seedMarket('wealth');
  const pDb = openPortfolioDb(join(dir, 'wealth-portfolio.sqlite'), { marketPath: join(dir, 'wealth-market.sqlite') });
  const acc = 'real-wealth';
  try {
    importSnapshot(pDb, snapshotData({
      id: 'snap-wealth-d0', asOf: D0,
      positions: [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 100_000, ref_price_milli: 900, ref_cost_milli: 900, market_value_cents: 9_000_000 }],
      cashCents: 0,
      wealthCents: 1_000_000,
    }));
    initBaseline(pDb, acc, { asOf: D0, snapshotId: 'snap-wealth-d0' });
    markSnapshotCurrent(pDb, 'snap-wealth-d0', { confirmedBy: 'test' });
    confirmRealAccount(pDb, acc, { confirm: true, note: 'test' });
    setAccountCompleteness(pDb, acc, { as_of: D0, reported_events_through: D0, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${acc}`, '10000000');
    ensureDeconcentrationPlan(pDb, {
      account_id: acc, ts_code: '159558.SZ', initial_shares: 100_000, nav_cents: 10_000_000,
      target_keep_bps: 1800, anchor_price_milli: 900, total_tranches: 4, created_at: D0,
    });

    // 先在 D0 建锚点（可投资净值 9,000,000；理财 1,000,000 不计入）。
    const day0 = buildDailyReport({ portfolioDb: pDb, marketDb: mDb, accountId: acc, snapshotId: 'snap-wealth-d0', asOfTradeDate: D0 });
    assert.ok(day0.v3_cockpit, 'D0 应挂载 cockpit 以创建锚点');
    const anchor = pDb.prepare('SELECT hwm_nav_cents FROM account_risk_anchor WHERE account_id = ?').get(acc);
    assert.equal(anchor.hwm_nav_cents, 9_000_000, '锚点只记录可投资净值');

    // D1：市场 -10% 后入金 90,000 元；单位化只覆盖现金+证券，理财保持 10,000 元。
    recordEvent(pDb, {
      event_id: 'wealth-deposit', account_id: acc, event_type: 'CASH_DEPOSIT', occurred_on: D1,
      cash_delta_cents: 9_000_000, source: 'broker_statement',
    });
    setAccountCompleteness(pDb, acc, { as_of: D1, reported_events_through: D1, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });

    const day1 = buildDailyReport({ portfolioDb: pDb, marketDb: mDb, accountId: acc, snapshotId: 'snap-wealth-d0', asOfTradeDate: D1 });
    assert.equal(day1.v3_cockpit.router.hwm_drawdown_pct, 10, '真实回撤应保持在 10%');
    assert.notEqual(day1.v3_cockpit.router.circuit_breaker_status, 'L2_LOCKED', '入金不得触发假 L2');
    assert.equal(day1.v3_cockpit.router.hwm_nav_cents, 19_000_000, '单位化等效高水位 = 17,100,000 / 0.9');
    assert.equal(day1.v3_cockpit.principal.current_nav_cents, 18_100_000, '本金盈亏展示必须使用含理财总资产');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('日报门控：已确认账户+当前快照但从未声明完整性只进 warnings，不阻断可执行腿与 V3 持久化', () => {
  const mDb = seedMarket('undeclared');
  const pDb = openPortfolioDb(join(dir, 'undeclared-portfolio.sqlite'), { marketPath: join(dir, 'undeclared-market.sqlite') });
  const acc = 'real-undeclared';
  try {
    const pos = [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20_000, ref_price_milli: 900, ref_cost_milli: 900, market_value_cents: 1_800_000 }];
    importSnapshot(pDb, snapshotData({ id: 'snap-undeclared-d0', asOf: D0, positions: pos, cashCents: 8_200_000 }));
    initBaseline(pDb, acc, { asOf: D0, snapshotId: 'snap-undeclared-d0' });
    markSnapshotCurrent(pDb, 'snap-undeclared-d0', { confirmedBy: 'test' });
    confirmRealAccount(pDb, acc, { confirm: true, note: 'test' });
    // 刻意不调用 setAccountCompleteness：从未声明 reported_events_through。
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${acc}`, '10000000');

    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: acc,
      snapshotId: 'snap-undeclared-d0',
      asOfTradeDate: D1,
    });
    assert.equal(report.gate.satisfied, true, `缺少完整性声明不得阻断可执行：${JSON.stringify(report.gate)}`);
    assert.ok(report.gate.warnings.some(w => w.code === 'account_completeness_undeclared'), '缺少声明应进入 warnings');
    assert.ok(report.gate.warnings.some(w => w.code === 'unreported_trade_lag_warning'), '未报成交风险提示必须保留');
    // 原始风险与执行阻塞位分离：日报与 decision.ts 使用同一有效处置。
    assert.equal(report.gate.unreported_trade_risk, true);
    assert.equal(report.gate.declaration.unreported_trade_risk, true);
    assert.equal(report.gate.declaration.risk_basis, 'undeclared');
    assert.equal(report.gate.declaration.blocks_execution, false);
    assert.equal(report.gate.declaration.execution_basis, 'ledger_reconstruction');
    assert.equal(report.status, 'ACTIONABLE');
    assert.ok(
      report.first_section.actions.some(action => action.legs.some(leg => leg.executable === true)),
      '至少一条执行腿必须可执行',
    );
    // 风险轨不得因原始风险披露而列入 blocked_by。
    for (const option of report.decision_comparison.options) {
      assert.equal(option.risk_track.blocked_by.includes('unreported_trade_risk'), false,
        `${option.action} 风险轨不得因原始风险阻塞：${JSON.stringify(option.risk_track.blocked_by)}`);
    }
    const anchor = pDb.prepare('SELECT hwm_nav_cents FROM account_risk_anchor WHERE account_id = ?').get(acc);
    assert.ok(anchor, 'V3 高水位锚点必须持久化');
    assert.ok(anchor.hwm_nav_cents > 0);
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('日报门控：完整性声明滞后到基线日（asOf 前一交易日）只作 warnings，执行腿保持可执行', () => {
  const mDb = seedMarket('declared-lag');
  const pDb = openPortfolioDb(join(dir, 'declared-lag-portfolio.sqlite'), { marketPath: join(dir, 'declared-lag-market.sqlite') });
  const acc = 'real-declared-lag';
  try {
    const pos = [{ ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20_000, ref_price_milli: 900, ref_cost_milli: 900, market_value_cents: 1_800_000 }];
    importSnapshot(pDb, snapshotData({ id: 'snap-declared-lag-d0', asOf: D0, positions: pos, cashCents: 8_200_000 }));
    initBaseline(pDb, acc, { asOf: D0, snapshotId: 'snap-declared-lag-d0' });
    markSnapshotCurrent(pDb, 'snap-declared-lag-d0', { confirmedBy: 'test' });
    confirmRealAccount(pDb, acc, { confirm: true, note: 'test' });
    // 同日推断滞后：声明存在且用户声明无未上报风险，但只覆盖到 D0，目标日 D1 未被核对。
    setAccountCompleteness(pDb, acc, {
      as_of: D0, reported_events_through: D0, unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'test' });
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${acc}`, '10000000');

    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: acc,
      snapshotId: 'snap-declared-lag-d0',
      asOfTradeDate: D1,
    });
    assert.equal(report.gate.satisfied, true, `声明滞后不得硬阻塞：${JSON.stringify(report.gate)}`);
    assert.equal(report.gate.unreported_trade_risk, true, '原始披露保留');
    assert.equal(report.gate.declaration.risk_basis, 'expired');
    assert.equal(report.gate.declaration.blocks_execution, false);
    assert.equal(report.gate.declaration.execution_basis, 'ledger_reconstruction');
    assert.ok(report.gate.warnings.some(w => w.code === 'unreported_trade_lag_warning'));
    assert.equal(report.gate.warnings.some(w => w.code === 'account_completeness_undeclared'), false,
      '已有声明时不得冒充“未声明”');
    assert.equal(report.gate.reasons.some(r => r.code === 'unreported_trade_risk'), false,
      JSON.stringify(report.gate.reasons));
    assert.equal(report.status, 'ACTIONABLE');
    assert.ok(report.first_section.actions.some(action => action.legs.some(leg => leg.executable === true)),
      '可执行依据成立时执行腿必须可执行');
    for (const option of report.decision_comparison.options) {
      assert.equal(option.risk_track.blocked_by.includes('unreported_trade_risk'), false,
        `${option.action} 风险轨不得因声明滞后阻塞：${JSON.stringify(option.risk_track.blocked_by)}`);
    }
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('研究事实包：目标日报告缺失时 execution_plan 与最终状态同源不可执行（保留数量）', () => {
  const mDb = seedMarket('bundle-missing');
  const pDb = openPortfolioDb(join(dir, 'bundle-missing-portfolio.sqlite'), { marketPath: join(dir, 'bundle-missing-market.sqlite') });
  const acc = 'real-bundle';
  try {
    const pos = [
      { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 20_000, ref_price_milli: 900, ref_cost_milli: 900, market_value_cents: 1_800_000 },
      { ts_code: '600519.SH', name: '止损测试股', quantity: 100, ref_price_milli: 10_000, ref_cost_milli: 10_000, market_value_cents: 100_000 },
    ];
    importSnapshot(pDb, snapshotData({ id: 'snap-bundle-d0', asOf: D0, positions: pos, cashCents: 8_100_000 }));
    initBaseline(pDb, acc, { asOf: D0, snapshotId: 'snap-bundle-d0' });
    markSnapshotCurrent(pDb, 'snap-bundle-d0', { confirmedBy: 'test' });
    confirmRealAccount(pDb, acc, { confirm: true, note: 'test' });
    setAccountCompleteness(pDb, acc, { as_of: D1, reported_events_through: D1, unreported_trade_risk: false }, { confirm: true, recordedBy: 'test' });

    const buildBundle = () => buildInvestmentResearchBundle({
      portfolioDb: pDb, marketDb: mDb, accountId: acc, asOfTradeDate: D1,
      now: new Date('2026-10-21T01:00:00Z'),
    });
    const before = buildBundle();
    assert.ok(before.portfolio?.execution_plan?.count >= 4, `前置事实包应有完整执行清单，实际 ${before.portfolio?.execution_plan?.count}`);
    assert.ok(
      before.portfolio.execution_plan.actions.some(action => action.legs.some(leg => leg.executable === true)),
      '前置事实包应至少有一条可执行腿',
    );
    const beforeCount = before.portfolio.execution_plan.count;
    const beforeQuantity = before.portfolio.execution_plan.actions
      .flatMap(action => action.legs)
      .reduce((sum, leg) => sum + (leg.quantity ?? 0), 0);

    // 删除目标日市场报告 → coreReady=false，最终状态 DATA_INSUFFICIENT。
    mDb.prepare('DELETE FROM report WHERE trade_date = ?').run(D1);
    const missing = buildBundle();
    assert.equal(missing.status, 'DATA_INSUFFICIENT');
    assert.equal(missing.portfolio.status, 'DATA_INSUFFICIENT');
    assert.equal(missing.portfolio.actionable, false);
    assert.equal(missing.portfolio.first_section.actions.length, 0);
    assert.equal(missing.portfolio.execution_plan.count, beforeCount, '执行清单数量应保留供参考');
    assert.ok(
      missing.portfolio.execution_plan.actions.every(action => action.legs.every(leg => leg.executable === false)),
      '最终状态不可执行时 execution_plan 的腿必须全部不可执行',
    );
    assert.equal(missing.portfolio.execution_plan.count, missing.portfolio.execution_plan.actions.length);
    const afterQuantity = missing.portfolio.execution_plan.actions
      .flatMap(action => action.legs)
      .reduce((sum, leg) => sum + (leg.quantity ?? 0), 0);
    assert.ok(afterQuantity > 0, '数量应保留供参考');
    assert.ok(beforeQuantity > 0);
  } finally {
    pDb.close();
    mDb.close();
  }
});
