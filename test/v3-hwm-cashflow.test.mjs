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
const {
  evaluateStrategyRouter,
  persistRiskAnchor,
  readRiskAnchor,
  readNetExternalCashFlowCents,
} = await import('../build/portfolio/strategyRouter.js');

const DAY = {
  anchor: '20260105',
  d2: '20260106',
  d3: '20260107',
  d4: '20260108',
};

const regime = {
  schema: 'ashare-market-regime/1.0',
  as_of_trade_date: DAY.d2,
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

let dbSeq = 0;
function freshDb() {
  dbSeq += 1;
  const name = `hwm-${dbSeq}-portfolio.sqlite`;
  return openPortfolioDb(join(dir, name), { marketPath: join(dir, `hwm-${dbSeq}-market.sqlite`) });
}

function setPrincipal(db, accountId, cents) {
  db.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)')
    .run(`initial_principal_cents:${accountId}`, String(cents));
}

function setAnchor(db, accountId, cents, date) {
  db.prepare(`
    INSERT OR REPLACE INTO account_risk_anchor
      (account_id, initial_principal_cents, hwm_nav_cents, hwm_date, circuit_breaker_status, locked_until_trade_date, updated_at)
    VALUES (?,?,?,?, 'NORMAL', NULL, ?)
  `).run(accountId, 10_000_000, cents, date, date);
}

function addCashFlow(db, { id, accountId = 'real-main', type = 'CASH_WITHDRAW', day, cents }) {
  db.prepare(`
    INSERT INTO account_event
      (event_id, account_id, event_type, occurred_on, cash_delta_cents, source, note, recorded_at)
    VALUES (?,?,?,?,?, 'synthetic', '', '2026-01-01T00:00:00.000Z')
  `).run(id, accountId, type, day, cents);
}

function evaluate(db, { asOf, nav, accountId = 'real-main', deconcentrationActive = false }) {
  return evaluateStrategyRouter({
    portfolioDb: db,
    marketDb: null,
    accountId,
    asOf,
    currentNavCents: nav,
    fallbackBaselineNavCents: 10_000_000,
    marketRegime: regime,
    deconcentrationActive,
  });
}

test('P1-2: 出金不触发 L2 熔断，且回撤按流水调整后的高水位计算', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);
    addCashFlow(db, { id: 'out-1', day: DAY.d2, cents: -2_000_000 });

    assert.equal(readNetExternalCashFlowCents(db, 'real-main', DAY.anchor, DAY.d2), -2_000_000);

    const out = evaluate(db, { asOf: DAY.d2, nav: 8_000_000 });
    assert.equal(out.anchor_snapshot.hwm_cash_flow_adjustment_cents, -2_000_000);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 8_000_000);
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 0);
    assert.equal(out.circuit_breaker_status, 'NORMAL', '单纯出金不得被当成净值回撤');
    assert.equal(out.should_advance_hwm, false);

    // 持久锚点不得被现金流调整值改写（否则下一轮会重复扣减同一笔流水）。
    assert.equal(persistRiskAnchor(db, out), true);
    const anchor = readRiskAnchor(db, 'real-main');
    assert.equal(anchor.hwm_nav_cents, 10_000_000);
    assert.equal(anchor.hwm_date, DAY.anchor);

    // 同日重跑：仍为 0 回撤（不重复扣减）。
    const rerun = evaluate(db, { asOf: DAY.d2, nav: 8_000_000 });
    assert.equal(rerun.anchor_snapshot.hwm_nav_cents, 8_000_000);
    assert.equal(rerun.anchor_snapshot.hwm_drawdown_bps, 0);
    assert.equal(rerun.circuit_breaker_status, 'NORMAL');
  } finally {
    db.close();
  }
});

test('P1-2: 入金抬高比较基准，市值被亏损抵消后仍按真实回撤进入 L1', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);
    // 入金 +15,000 元，同期市值亏损 15,000 元：总资产仍为 10 万元。
    addCashFlow(db, { id: 'in-1', type: 'CASH_DEPOSIT', day: DAY.d2, cents: 1_500_000 });

    const out = evaluate(db, { asOf: DAY.d2, nav: 10_000_000 });
    assert.equal(out.anchor_snapshot.hwm_cash_flow_adjustment_cents, 1_500_000);
    assert.equal(out.anchor_snapshot.hwm_nav_cents, 11_500_000);
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 1304, '回撤应相对入金调整后的 11.5 万元计算');
    assert.equal(out.anchor_snapshot.lifeline_nav_cents, Math.round(11_500_000 * 0.85));
    assert.equal(out.circuit_breaker_status, 'L1_WARN');
    assert.equal(out.should_advance_hwm, false);
  } finally {
    db.close();
  }
});

test('P1-2: 连续多日运行不重复计算同一笔入金', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);
    addCashFlow(db, { id: 'in-daily', type: 'CASH_DEPOSIT', day: DAY.d2, cents: 1_200_000 });

    for (const asOf of [DAY.d2, DAY.d3, DAY.d4]) {
      const out = evaluate(db, { asOf, nav: 11_200_000 });
      assert.equal(out.anchor_snapshot.hwm_cash_flow_adjustment_cents, 1_200_000, `${asOf} 只能计一次流水`);
      assert.equal(out.anchor_snapshot.hwm_nav_cents, 11_200_000);
      assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 0);
      assert.equal(out.circuit_breaker_status, 'NORMAL', `${asOf} 不得因重复扣减流水而误触熔断`);
      persistRiskAnchor(db, out);
      const anchor = readRiskAnchor(db, 'real-main');
      assert.equal(anchor.hwm_nav_cents, 10_000_000, '未创新高时不得改写持久高水位');
      assert.equal(anchor.hwm_date, DAY.anchor);
    }
  } finally {
    db.close();
  }
});

test('P1-2: 流水之后创出真新高才推进锚点，后续回撤从新锚点起算', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);
    addCashFlow(db, { id: 'in-new-high', type: 'CASH_DEPOSIT', day: DAY.d2, cents: 1_000_000 });

    const newHigh = evaluate(db, { asOf: DAY.d2, nav: 12_000_000 });
    assert.equal(newHigh.anchor_snapshot.hwm_cash_flow_adjustment_cents, 1_000_000);
    assert.equal(newHigh.anchor_snapshot.hwm_nav_cents, 12_000_000);
    assert.equal(newHigh.anchor_snapshot.hwm_drawdown_bps, 0);
    assert.equal(newHigh.should_advance_hwm, true);
    assert.equal(persistRiskAnchor(db, newHigh), true);
    const anchor = readRiskAnchor(db, 'real-main');
    assert.equal(anchor.hwm_nav_cents, 12_000_000);
    assert.equal(anchor.hwm_date, DAY.d2);

    const next = evaluate(db, { asOf: DAY.d3, nav: 11_400_000 });
    assert.equal(next.anchor_snapshot.hwm_cash_flow_adjustment_cents, 0, '新锚点日之后的流水区间为空');
    assert.equal(next.anchor_snapshot.hwm_nav_cents, 12_000_000);
    assert.equal(next.anchor_snapshot.hwm_drawdown_bps, 500);
  } finally {
    db.close();
  }
});

test('P1-2: 已撤销的出入金流水不计入高水位调整', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);
    addCashFlow(db, { id: 'out-reversed', day: DAY.d2, cents: -2_000_000 });
    db.prepare("UPDATE account_event SET reversed_by = 'reverse-1' WHERE event_id = 'out-reversed'").run();

    assert.equal(readNetExternalCashFlowCents(db, 'real-main', DAY.anchor, DAY.d2), 0);
    const out = evaluate(db, { asOf: DAY.d2, nav: 8_000_000 });
    assert.equal(out.anchor_snapshot.hwm_cash_flow_adjustment_cents, 0);
    assert.equal(out.anchor_snapshot.hwm_drawdown_bps, 2000);
  } finally {
    db.close();
  }
});

test('P1-2: 生命线按当前生效的 L2 触发档位计算（前置 12% / 常态 15%）', () => {
  const db = freshDb();
  try {
    setPrincipal(db, 'real-main', 10_000_000);
    setAnchor(db, 'real-main', 10_000_000, DAY.anchor);

    const normal = evaluate(db, { asOf: DAY.d2, nav: 10_000_000, deconcentrationActive: false });
    assert.equal(normal.l2_trigger_drawdown_bps, 1500);
    assert.equal(normal.anchor_snapshot.lifeline_nav_cents, 8_500_000);
    assert.match(normal.circuit_breaker_label_zh, /15% 熔断生命线/);

    const preemptive = evaluate(db, { asOf: DAY.d2, nav: 10_000_000, deconcentrationActive: true });
    assert.equal(preemptive.l2_trigger_drawdown_bps, 1200);
    assert.equal(preemptive.anchor_snapshot.lifeline_nav_cents, 8_800_000);
    assert.match(preemptive.circuit_breaker_label_zh, /12%/);
  } finally {
    db.close();
  }
});

test('P1-2: 账本/锚点表缺失时容忍为 0 且不抛错', () => {
  const empty = new DatabaseSync(':memory:');
  try {
    assert.equal(readNetExternalCashFlowCents(empty, 'real-main', DAY.anchor, DAY.d2), 0);
    const out = evaluateStrategyRouter({
      portfolioDb: empty,
      marketDb: null,
      accountId: 'real-main',
      asOf: DAY.d2,
      currentNavCents: 10_000_000,
      fallbackBaselineNavCents: 10_000_000,
      marketRegime: regime,
    });
    assert.equal(out.circuit_breaker_status, 'NORMAL');
    assert.equal(out.anchor_snapshot.hwm_cash_flow_adjustment_cents, 0);

    const nullDb = evaluateStrategyRouter({
      portfolioDb: null,
      marketDb: null,
      accountId: 'real-main',
      asOf: DAY.d2,
      currentNavCents: 10_000_000,
      marketRegime: regime,
    });
    assert.equal(nullDb.circuit_breaker_status, 'NORMAL');
  } finally {
    empty.close();
  }
});
