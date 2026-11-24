import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-hwm-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importSnapshot } = await import('../build/portfolio/account.js');
const { initBaseline, recordEvent } = await import('../build/portfolio/ledger.js');
const {
  evaluateStrategyRouter,
  persistRiskAnchor,
  readRiskAnchor,
} = await import('../build/portfolio/strategyRouter.js');

const DAY = { d0: '20260105', d1: '20260106', d2: '20260107', d3: '20260108' };
const ACCOUNT = 'real-main';

const regime = {
  schema: 'ashare-market-regime/1.0',
  as_of_trade_date: DAY.d0,
  available: true,
  regime: 'OFFENSIVE',
  raw_regime: 'OFFENSIVE',
  target_equity_bps: 8500,
  target_equity_pct: 85,
  hysteresis_held: false,
  crash_override: false,
  style: 'GROWTH_LEADING',
  style_spread_20d_pct: null,
  value_anchor: {},
  growth_anchor: {},
  breadth: {},
  history: [],
  regime_label_zh: '进攻',
  style_label_zh: '成长占优',
  summary_zh: '',
  notes: [],
};

let seq = 0;
/**
 * 建一个带基线快照与最小行情表的账户。
 * 行情只需 `daily(ts_code, trade_date, close)`：buildLedgerPriceTable 会读取它。
 * 不给市价变动时，NAV 变化只来自现金流 —— 正是单位净值法的判定场景。
 */
function setupAccount({ name, startDay, positions, cashCents, prices }) {
  seq += 1;
  const marketPath = join(dir, `${name}-${seq}-market.sqlite`);
  const marketDb = new DatabaseSync(marketPath);
  marketDb.exec('CREATE TABLE daily (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, close REAL NOT NULL)');
  const insert = marketDb.prepare('INSERT INTO daily (ts_code, trade_date, close) VALUES (?,?,?)');
  for (const [code, series] of Object.entries(prices ?? {})) {
    for (const [day, close] of Object.entries(series)) insert.run(code, day, close);
  }
  const portfolioDb = openPortfolioDb(join(dir, `${name}-${seq}-portfolio.sqlite`), { marketPath });
  const snapshotId = `snap-${name}-${seq}`;
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  importSnapshot(portfolioDb, {
    snapshot_id: snapshotId,
    as_of: startDay,
    source: 'test',
    note: name,
    warnings: [],
    is_current: false,
    positions,
    totals: {
      total_assets_cents: securities + cashCents,
      securities_mv_cents: securities,
      cash_cents: cashCents,
      wealth_cents: 0,
      unrealized_pnl_cents: 0,
    },
  });
  initBaseline(portfolioDb, ACCOUNT, { asOf: startDay, snapshotId });
  portfolioDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)')
    .run(`initial_principal_cents:${ACCOUNT}`, String(securities + cashCents));
  return { portfolioDb, marketDb };
}

let bareSeq = 0;
function bareDb() {
  bareSeq += 1;
  return openPortfolioDb(join(dir, `bare-${bareSeq}-portfolio.sqlite`), {
    marketPath: join(dir, `bare-${bareSeq}-market.sqlite`),
  });
}

function evaluate(portfolioDb, marketDb, { asOf, nav, deconcentrationActive = false }) {
  return evaluateStrategyRouter({
    portfolioDb,
    marketDb,
    accountId: ACCOUNT,
    asOf,
    currentNavCents: nav,
    fallbackBaselineNavCents: nav,
    marketRegime: regime,
    deconcentrationActive,
  });
}

function recordCash(portfolioDb, { id, type, day, cents }) {
  const result = recordEvent(portfolioDb, {
    event_id: id,
    account_id: ACCOUNT,
    event_type: type,
    occurred_on: day,
    cash_delta_cents: cents,
    source: 'broker_statement',
  });
  assert.equal(result.status, 'RECORDED');
}

function insertCashEvent(portfolioDb, { id, type, day, cents }) {
  portfolioDb.prepare(`
    INSERT INTO account_event
      (event_id, account_id, event_type, occurred_on, cash_delta_cents, source, note, recorded_at)
    VALUES (?,?,?,?,?, 'broker_statement', '', '2026-01-01T00:00:00.000Z')
  `).run(id, ACCOUNT, type, day, cents);
}

function position(code, quantity, priceMilli, name = '测试标的') {
  return {
    ts_code: code,
    name,
    quantity,
    ref_price_milli: priceMilli,
    ref_cost_milli: priceMilli,
    market_value_cents: Math.round(quantity * priceMilli / 10),
  };
}

test('P1-2 单位净值法：入金 90 把 NAV 90 抬到 180，回撤仍为 10%（不是加法的 5.26%）', () => {
  const { portfolioDb, marketDb } = setupAccount({
    name: 'deposit',
    startDay: DAY.d0,
    positions: [position('600519.SH', 100, 10_000)],
    cashCents: 0,
    prices: { '600519.SH': { [DAY.d0]: 10.0, [DAY.d1]: 9.0 } },
  });
  try {
    const atAnchor = evaluate(portfolioDb, marketDb, { asOf: DAY.d0, nav: 100_000 });
    assert.equal(persistRiskAnchor(portfolioDb, atAnchor), true);
    recordCash(portfolioDb, { id: 'dep-90k', type: 'CASH_DEPOSIT', day: DAY.d1, cents: 90_000 });

    const out = evaluate(portfolioDb, marketDb, { asOf: DAY.d1, nav: 180_000 });
    assert.equal(out.anchor_snapshot.hwm_nav_basis, 'UNIT_NAV');
    assert.ok(Math.abs(out.anchor_snapshot.hwm_unit_nav_ratio - 0.9) < 1e-6);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 200_000, '单位净值口径的等效高水位 = 180000 / 0.9');
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 1000, '入金不得摊薄真实 10% 回撤');
    assert.equal(out.anchor_snapshot.lifeline_nav_cents, 170_000);
    assert.equal(out.circuit_breaker_status, 'L1_WARN');
    assert.equal(out.should_advance_hwm, false);

    // 未创新高：持久锚点保持原值，下一轮重新按单位净值重算，不会叠加。
    assert.equal(persistRiskAnchor(portfolioDb, out), true);
    const anchor = readRiskAnchor(portfolioDb, ACCOUNT);
    assert.equal(anchor.hwm_nav_cents, 100_000);
    assert.equal(anchor.hwm_date, DAY.d0);
  } finally {
    marketDb.close();
    portfolioDb.close();
  }
});

test('P1-2 单位净值法：出金 45 把 NAV 90 降到 45，回撤仍为 10% 且不误触 L2', () => {
  const { portfolioDb, marketDb } = setupAccount({
    name: 'withdraw',
    startDay: DAY.d0,
    positions: [position('600519.SH', 1000, 1000)],
    cashCents: 0,
    prices: { '600519.SH': { [DAY.d0]: 1.0, [DAY.d1]: 0.9 } },
  });
  try {
    const atAnchor = evaluate(portfolioDb, marketDb, { asOf: DAY.d0, nav: 100_000 });
    assert.equal(persistRiskAnchor(portfolioDb, atAnchor), true);
    recordCash(portfolioDb, { id: 'wd-45k', type: 'CASH_WITHDRAW', day: DAY.d1, cents: -45_000 });

    const out = evaluate(portfolioDb, marketDb, { asOf: DAY.d1, nav: 45_000 });
    assert.equal(out.anchor_snapshot.hwm_nav_basis, 'UNIT_NAV');
    assert.ok(Math.abs(out.anchor_snapshot.hwm_unit_nav_ratio - 0.9) < 1e-6);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 50_000, '单位净值口径的等效高水位 = 45000 / 0.9');
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 1000);
    assert.equal(out.circuit_breaker_status, 'L1_WARN');
    assert.notEqual(out.circuit_breaker_status, 'L2_LOCKED', '出金不得被误判为 18.2% 回撤触发 L2');
  } finally {
    marketDb.close();
    portfolioDb.close();
  }
});

test('P1-2 单位净值法：真实单位净值新高必须落库，即使名义 NAV 低于旧高水位（70 -> 63）', () => {
  const { portfolioDb, marketDb } = setupAccount({
    name: 'unit-high',
    startDay: DAY.d0,
    positions: [position('600519.SH', 1000, 700)],
    cashCents: 0,
    prices: {
      '600519.SH': { [DAY.d0]: 0.70, [DAY.d1]: 0.77, [DAY.d2]: 0.77 },
    },
  });
  try {
    const atAnchor = evaluate(portfolioDb, marketDb, { asOf: DAY.d0, nav: 70_000 });
    assert.equal(persistRiskAnchor(portfolioDb, atAnchor), true);
    // 市值 +10% 后出金 14,000：名义净值 63,000 < 旧高水位 70,000，但单位净值 1.1 是真实新高。
    recordCash(portfolioDb, { id: 'wd-14k', type: 'CASH_WITHDRAW', day: DAY.d2, cents: -14_000 });

    const out = evaluate(portfolioDb, marketDb, { asOf: DAY.d2, nav: 63_000 });
    assert.equal(out.anchor_snapshot.hwm_nav_basis, 'UNIT_NAV');
    assert.ok(Math.abs(out.anchor_snapshot.hwm_unit_nav_ratio - 1.1) < 1e-6);
    assert.equal(out.should_advance_hwm, true);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 63_000);
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 0);

    assert.equal(persistRiskAnchor(portfolioDb, out), true);
    const anchor = readRiskAnchor(portfolioDb, ACCOUNT);
    assert.equal(anchor.hwm_nav_cents, 63_000, '单位净值新高必须写库，不能被名义净值下降挡住');
    assert.equal(anchor.hwm_date, DAY.d2);
  } finally {
    marketDb.close();
    portfolioDb.close();
  }
});

test('P1-2 单位净值法：连续多日运行不重复计算同一笔流水', () => {
  const { portfolioDb, marketDb } = setupAccount({
    name: 'repeat',
    startDay: DAY.d0,
    positions: [position('600519.SH', 100, 10_000)],
    cashCents: 0,
    prices: { '600519.SH': { [DAY.d0]: 10.0, [DAY.d1]: 9.0, [DAY.d2]: 9.0, [DAY.d3]: 9.0 } },
  });
  try {
    assert.equal(persistRiskAnchor(portfolioDb, evaluate(portfolioDb, marketDb, { asOf: DAY.d0, nav: 100_000 })), true);
    recordCash(portfolioDb, { id: 'dep-repeat', type: 'CASH_DEPOSIT', day: DAY.d1, cents: 90_000 });

    for (const asOf of [DAY.d1, DAY.d2, DAY.d3]) {
      const out = evaluate(portfolioDb, marketDb, { asOf, nav: 180_000 });
      assert.equal(out.anchor_snapshot.hwm_nav_basis, 'UNIT_NAV');
      assert.ok(Math.abs(out.anchor_snapshot.hwm_unit_nav_ratio - 0.9) < 1e-6, `${asOf} 单位净值比应恒为 0.9`);
      assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 1000, `${asOf} 不得因重复折算把回撤放大`);
      assert.equal(out.circuit_breaker_status, 'L1_WARN');
      persistRiskAnchor(portfolioDb, out);
      const anchor = readRiskAnchor(portfolioDb, ACCOUNT);
      assert.equal(anchor.hwm_nav_cents, 100_000);
      assert.equal(anchor.hwm_date, DAY.d0);
    }
  } finally {
    marketDb.close();
    portfolioDb.close();
  }
});

test('P1-2 生命线按当前生效的 L2 触发档位计算（前置 12% / 常态 15%）', () => {
  const { portfolioDb, marketDb } = setupAccount({
    name: 'lifeline',
    startDay: DAY.d0,
    positions: [position('600519.SH', 100, 10_000)],
    cashCents: 0,
    prices: { '600519.SH': { [DAY.d0]: 10.0, [DAY.d1]: 9.0 } },
  });
  try {
    assert.equal(persistRiskAnchor(portfolioDb, evaluate(portfolioDb, marketDb, { asOf: DAY.d0, nav: 100_000 })), true);
    recordCash(portfolioDb, { id: 'dep-life', type: 'CASH_DEPOSIT', day: DAY.d1, cents: 90_000 });

    const normal = evaluate(portfolioDb, marketDb, { asOf: DAY.d1, nav: 180_000, deconcentrationActive: false });
    assert.equal(normal.l2_trigger_drawdown_bps, 1500);
    assert.equal(normal.anchor_snapshot.lifeline_nav_cents, Math.round(200_000 * 0.85));

    const preemptive = evaluate(portfolioDb, marketDb, { asOf: DAY.d1, nav: 180_000, deconcentrationActive: true });
    assert.equal(preemptive.l2_trigger_drawdown_bps, 1200);
    assert.equal(preemptive.anchor_snapshot.lifeline_nav_cents, Math.round(200_000 * 0.88));
  } finally {
    marketDb.close();
    portfolioDb.close();
  }
});

test('P1-2 无账本基线时退化为名义净值比较（不适用加法折入）', () => {
  seq += 1;
  const portfolioDb = openPortfolioDb(join(dir, `no-baseline-${seq}-portfolio.sqlite`), {
    marketPath: join(dir, `no-baseline-${seq}-market.sqlite`),
  });
  try {
    portfolioDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${ACCOUNT}`, '100000');
    portfolioDb.prepare(`
      INSERT INTO account_risk_anchor
        (account_id, initial_principal_cents, hwm_nav_cents, hwm_date, circuit_breaker_status, locked_until_trade_date, updated_at)
      VALUES (?,?,?,?, 'NORMAL', NULL, ?)
    `).run(ACCOUNT, 100_000, 100_000, DAY.d0, DAY.d0);

    const out = evaluateStrategyRouter({
      portfolioDb,
      marketDb: null,
      accountId: ACCOUNT,
      asOf: DAY.d1,
      currentNavCents: 90_000,
      marketRegime: regime,
    });
    assert.equal(out.anchor_snapshot.hwm_nav_basis, 'RAW_NAV');
    assert.equal(out.anchor_snapshot.hwm_unit_nav_ratio, null);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 100_000);
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 1000);

    const noDb = evaluateStrategyRouter({
      portfolioDb: null,
      marketDb: null,
      accountId: ACCOUNT,
      asOf: DAY.d1,
      currentNavCents: 90_000,
      marketRegime: regime,
    });
    assert.equal(noDb.circuit_breaker_status, 'NORMAL');
    assert.equal(noDb.anchor_snapshot.hwm_nav_basis, 'RAW_NAV');
  } finally {
    portfolioDb.close();
  }
});

test('P1-2 同日流水：锚点日==目标日且无法单位化时，当日出金不得触发假 L2', () => {
  seq += 1;
  const portfolioDb = openPortfolioDb(join(dir, `same-day-withdraw-${seq}-portfolio.sqlite`), {
    marketPath: join(dir, `same-day-withdraw-${seq}-market.sqlite`),
  });
  try {
    portfolioDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${ACCOUNT}`, '100000');
    const atAnchor = evaluate(portfolioDb, null, { asOf: DAY.d0, nav: 100_000 });
    assert.equal(persistRiskAnchor(portfolioDb, atAnchor), true);
    insertCashEvent(portfolioDb, { id: 'same-day-wd', type: 'CASH_WITHDRAW', day: DAY.d0, cents: -90_000 });

    const out = evaluate(portfolioDb, null, { asOf: DAY.d0, nav: 10_000 });
    assert.equal(out.anchor_snapshot.hwm_nav_basis, 'RAW_NAV');
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 0, '同日出金必须按扣流前 NAV 比较');
    assert.equal(out.circuit_breaker_status, 'NORMAL');
    assert.equal(out.should_advance_hwm, false);
    const anchor = readRiskAnchor(portfolioDb, ACCOUNT);
    assert.equal(anchor.hwm_nav_cents, 100_000);
  } finally {
    portfolioDb.close();
  }
});

test('P1-2 同日流水：锚点日==目标日的当日入金不得被当成新高或回撤', () => {
  seq += 1;
  const portfolioDb = openPortfolioDb(join(dir, `same-day-deposit-${seq}-portfolio.sqlite`), {
    marketPath: join(dir, `same-day-deposit-${seq}-market.sqlite`),
  });
  try {
    portfolioDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${ACCOUNT}`, '100000');
    const atAnchor = evaluate(portfolioDb, null, { asOf: DAY.d0, nav: 100_000 });
    assert.equal(persistRiskAnchor(portfolioDb, atAnchor), true);
    insertCashEvent(portfolioDb, { id: 'same-day-dep', type: 'CASH_DEPOSIT', day: DAY.d0, cents: 90_000 });

    const out = evaluate(portfolioDb, null, { asOf: DAY.d0, nav: 190_000 });
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 0);
    assert.equal(out.circuit_breaker_status, 'NORMAL');
    assert.equal(out.should_advance_hwm, false, '同日入金不是真实单位净值新高');
    assert.equal(readRiskAnchor(portfolioDb, ACCOUNT).hwm_nav_cents, 100_000);
  } finally {
    portfolioDb.close();
  }
});

test('P1-2 同日重跑不重复扣流水：100→110→入金100 首次存 210，重跑仍 0 回撤', () => {
  const db = bareDb();
  try {
    db.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run('initial_principal_cents:real-main', '100000');
    db.prepare(`
      INSERT INTO account_risk_anchor
        (account_id, initial_principal_cents, hwm_nav_cents, hwm_date, circuit_breaker_status, locked_until_trade_date, updated_at)
      VALUES (?,?,?,?, 'NORMAL', NULL, ?)
    `).run('real-main', 100_000, 100_000, DAY.d0, DAY.d0);
    insertCashEvent(db, { id: 'in-100k', type: 'CASH_DEPOSIT', day: DAY.d1, cents: 100_000 });

    const first = evaluate(db, null, { asOf: DAY.d1, nav: 210_000 });
    assert.equal(first.anchor_snapshot.hwm_nav_cents, 210_000);
    assert.equal(first.should_advance_hwm, true);
    assert.equal(persistRiskAnchor(db, first), true);
    const row = readRiskAnchor(db, 'real-main');
    assert.equal(row.hwm_nav_cents, 210_000);
    assert.equal(row.hwm_date, DAY.d1);
    assert.equal(row.hwm_flows_applied_through, DAY.d1);
    assert.equal(row.hwm_applied_same_day_flow_cents, 100_000, '锚点必须记录已折入的当日流水');

    const rerun = evaluate(db, null, { asOf: DAY.d1, nav: 210_000 });
    assert.equal(rerun.anchor_snapshot.hwm_drawdown_bps, 0, '同日无变动重跑不得再扣一次流水');
    assert.equal(rerun.circuit_breaker_status, 'NORMAL');

    insertCashEvent(db, { id: 'in-50k', type: 'CASH_DEPOSIT', day: DAY.d1, cents: 50_000 });
    const withNewFlow = evaluate(db, null, { asOf: DAY.d1, nav: 260_000 });
    assert.equal(withNewFlow.anchor_snapshot.hwm_drawdown_bps, 0, '锚点之后的新增同日流水也不得被当成回撤');
    assert.equal(withNewFlow.circuit_breaker_status, 'NORMAL');
  } finally {
    db.close();
  }
});

test('P1-2 回本展示：风险 NAV 用可投资净值，本金盈亏用含理财总资产', () => {
  const db = bareDb();
  try {
    db.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run('initial_principal_cents:real-main', '100000');
    const out = evaluateStrategyRouter({
      portfolioDb: db,
      marketDb: null,
      accountId: 'real-main',
      asOf: DAY.d0,
      currentNavCents: 80_000,
      displayNavCents: 100_000,
      fallbackBaselineNavCents: 80_000,
      marketRegime: regime,
    });
    assert.equal(out.anchor_snapshot.hwm_comparison_nav_cents, 80_000, '风险口径=可投资净值');
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 80_000);
    assert.equal(out.anchor_snapshot.current_nav_cents, 100_000, '展示口径=含理财总资产');
    assert.equal(out.anchor_snapshot.cumulative_pnl_cents, 0, '无损益不得报成亏 2 万');
    assert.equal(out.anchor_snapshot.cumulative_return_pct, 0);
    assert.equal(out.anchor_snapshot.recovery_needed_pct, 0, '无损益不得要求上涨 25%');
  } finally {
    db.close();
  }
});

test('P1-2 旧库迁移：account_risk_anchor 自动补齐当日流水列', () => {
  bareSeq += 1;
  const path = join(dir, `legacy-anchor-${bareSeq}-portfolio.sqlite`);
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE account_risk_anchor (
      account_id TEXT PRIMARY KEY,
      initial_principal_cents INTEGER NOT NULL,
      hwm_nav_cents INTEGER NOT NULL,
      hwm_date TEXT NOT NULL,
      circuit_breaker_status TEXT NOT NULL DEFAULT 'NORMAL',
      locked_until_trade_date TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  raw.close();
  const db = openPortfolioDb(path, { marketPath: join(dir, `legacy-anchor-${bareSeq}-market.sqlite`) });
  try {
    const cols = new Set(
      db.prepare('PRAGMA table_info(account_risk_anchor)').all().map(row => row.name),
    );
    assert.ok(cols.has('hwm_flows_applied_through'), '迁移必须补齐 hwm_flows_applied_through');
    assert.ok(cols.has('hwm_applied_same_day_flow_cents'), '迁移必须补齐 hwm_applied_same_day_flow_cents');
  } finally {
    db.close();
  }
});
