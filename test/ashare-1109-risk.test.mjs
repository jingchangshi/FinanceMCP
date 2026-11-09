import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// goal-1109 data/risk acceptance: A01-A06 (+A13 clean-text, A17, A18).
// Synthetic fixture style mirrors test/ashare-1109-bundle.test.mjs: deterministic
// market + portfolio DB; fund_daily closes are controlled per test.

const dir = mkdtempSync(join(tmpdir(), 'ashare-1109-risk-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { DEMO_SNAPSHOT, importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount } = await import('../build/portfolio/ledger.js');
const { buildDailyReport, tickPrice } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport } = await import('../build/portfolio/reportRenderer.js');
const { marketBreadth } = await import('../build/ashare/market.js');

const ACCOUNT = 'synthetic-1109-risk';
let seq = 0;

// 159558 close series: 25 trading days ending 20261106. Min = 0.686 at position 22
// (20261103-style dip), as-of close = 0.817. Mirrors the task-book 159558 case.
const CLOSES = [
  0.801, 0.810, 0.795, 0.822, 0.830, 0.815, 0.808, 0.819, 0.825, 0.812,
  0.799, 0.790, 0.805, 0.828, 0.831, 0.820, 0.814, 0.822, 0.811, 0.806,
  0.798, 0.686, 0.701, 0.790, 0.817,
];

function fixture() {
  seq += 1;
  const marketPath = join(dir, `market-${seq}.sqlite`);
  const market = openAshareDb(marketPath);
  const dates = weekdays('20261001', 27); // 20261001..20261106
  assert.equal(dates.at(-1), '20261106');
  seedMarket(market, dates);
  // trade_cal: every date in `dates` is open (weekdays only);
  // add 20261109 as the next open day, 20261107/08 as closed weekend.
  for (const [d, o] of [['20261107', 0], ['20261108', 0], ['20261109', 1]]) {
    market.prepare('INSERT OR REPLACE INTO trade_cal(cal_date,is_open) VALUES(?,?)').run(d, o);
  }
  const semi = DEMO_SNAPSHOT.positions.find(p => p.ts_code === '159558.SZ');
  upsertRows(market, 'fund_basic', ['ts_code', 'name', 'market', 'status', 'fund_type', 'invest_type'],
    [{ ts_code: '159558.SZ', name: '半导体设备ETF', market: 'E', status: 'L', fund_type: '股票型', invest_type: '被动指数型' }]);
  dates.slice(-25).forEach((date, i) => {
    const close = CLOSES[i];
    upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      [{ ts_code: '159558.SZ', trade_date: date, open: close, high: close, low: close, close, pre_close: i ? CLOSES[i - 1] : close, pct_chg: 0, vol: 1000, amount: 10000 }]);
    upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: '159558.SZ', trade_date: date, adj_factor: 1 }]);
    upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], [{ ts_code: '159558.SZ', trade_date: date, fd_share: 100000 }]);
  });
  for (const position of DEMO_SNAPSHOT.positions.filter(p => p.ts_code !== '159558.SZ')) {
    upsertRows(market, 'fund_basic', ['ts_code', 'name', 'market', 'status', 'fund_type', 'invest_type'],
      [{ ts_code: position.ts_code, name: 'Synthetic ETF', market: 'E', status: 'L', fund_type: '股票型', invest_type: '被动指数型' }]);
    for (const date of dates) {
      upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
        [{ ts_code: position.ts_code, trade_date: date, open: 1, high: 1, low: 1, close: 1, pre_close: 1, pct_chg: 0, vol: 1000, amount: 10000 }]);
      upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: position.ts_code, trade_date: date, adj_factor: 1 }]);
      upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], [{ ts_code: position.ts_code, trade_date: date, fd_share: 100000 }]);
    }
  }
  const portfolioPath = join(dir, `portfolio-${seq}.sqlite`);
  const p = openPortfolioDb(portfolioPath, { marketPath: join(dir, `unrelated-${seq}.sqlite`) });
  const id = `synthetic-risk-${seq}`;
  importSnapshot(p, { ...DEMO_SNAPSHOT, snapshot_id: id, as_of: '2026-10-16', source: 'synthetic-test' });
  initBaseline(p, ACCOUNT, { asOf: '20261016', snapshotId: id });
  markSnapshotCurrent(p, id, { confirmedBy: 'fixture' });
  confirmRealAccount(p, ACCOUNT, { confirm: true });
  const reportPath = join(dir, `report-${seq}.json`);
  writeFileSync(reportPath, JSON.stringify({ report_id: `synthetic-market-report-${seq}`, as_of_trade_date: '20261106', status: 'READY', versions: { score: 'frozen-test' },
    market: { regime: 'range', regime_label: 'synthetic', breadth: {}, indices: [], judgement: [] }, sectors: { top: [], bottom: [], all: [] },
    watchlist: { count: 40, members: [], added: [], removed: [], track_record: { mean_excess_pct: -1.68, hit_rate: 0.217 } }, signals: { market_summary: [] } }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)').run(`synthetic-market-report-${seq}`, '20261106', 'READY', '2026-11-06T13:10:00Z', reportPath, 'live');
  return { market, p };
}

function build(f) {
  return buildDailyReport({ portfolioDb: f.p, marketDb: f.market, accountId: ACCOUNT, asOfTradeDate: '20261106' });
}

test('A01: 159558 20-day reference low is the prior-window min, not same-day close', () => {
  const f = fixture();
  const report = build(f);
  const holding = report.holdings.find(h => h.ts_code === '159558.SZ');
  assert.ok(holding, '159558 holding present');
  const watch = holding.research.conditions.find(c => c.stance === 'WATCH');
  assert.ok(watch, 'WATCH condition present');
  const text = watch.when.join(' ');
  // Prior-20 completed bars ending at as-of: min is the 0.686 dip, not 0.817 close.
  assert.match(text, /0\.686/, 'threshold renders the 20-day min');
  assert.doesNotMatch(text, /0\.817/, 'threshold never equals same-day close');
  assert.match(text, /前复权/, 'price basis disclosed');
  // Tick precision: no 4-decimal padding.
  assert.doesNotMatch(text, /0\.\d{4}/, 'no 4-decimal padding');
});

test('A01b: tickPrice formats ETF and stock prices at tick precision', () => {
  assert.equal(tickPrice(0.686), '0.686');
  assert.equal(tickPrice(0.817), '0.817');
  assert.equal(tickPrice(12.3456), '12.35');
});

test('A02: window purity - a missing bar in the 20-day window yields no threshold', () => {
  const f = fixture();
  // Remove one fund_daily bar inside the 20-bar window for 159558.
  const victim = f.market.prepare("SELECT trade_date FROM fund_daily WHERE ts_code='159558.SZ' ORDER BY trade_date DESC LIMIT 15,1").get().trade_date;
  f.market.prepare("DELETE FROM fund_daily WHERE ts_code='159558.SZ' AND trade_date=?").run(victim);
  const report = build(f);
  const holding = report.holdings.find(h => h.ts_code === '159558.SZ');
  const watch = holding.research.conditions.find(c => c.stance === 'WATCH');
  const text = watch.when.join(' ');
  // Missing bar must not be silently filled: window invalid -> threshold unavailable.
  assert.match(text, /不可用/, 'missing bar -> threshold unavailable, never filled');
});

test('A03: account arithmetic identity holds and wealth line is rendered', () => {
  const f = fixture();
  const report = build(f);
  const basis = report.account_view.revalued_basis;
  // Demo snapshot: 7,436,250 + 141,370 + 33 = 7,577,653 cents (0.33 wealth).
  assert.equal(basis.total_assets_cents,
    basis.securities_mv_cents + basis.cash_cents + basis.wealth_cents,
    'total == securities + cash + wealth (cents)');
  assert.equal(basis.wealth_cents, 33, 'wealth component present in revalued basis');
  const rendered = renderDailyReport(report);
  assert.match(rendered.user, /理财\/其他资产 0\.33 元/, 'wealth line rendered (P0-2 fix)');
  assert.match(rendered.user, /总资产 = 证券市值 \+ 现金 \+ 理财\/其他资产/, 'three-component identity stated');
});

test('A04: drawdown labels are frozen and window-max is never labeled history-max', () => {
  const f = fixture();
  const report = build(f);
  // Render-level: inject risk state the same shape buildDailyReport produces
  // (current 8.95% under L1 10%, window max 20.25%).
  report.portfolio_risk = {
    drawdown: {
      status: 'AVAILABLE', current_drawdown_bps: 895, current_drawdown_pct: 8.95,
      max_drawdown_pct: 20.25, window: { start: '20261016', end: '20261106' }, points_used: 15,
    },
    policy: { tiers: [{ level: 'L1', drawdown_pct: 10, review: '复核仓位与风险来源' }], approved_on: '2026-10-22' },
    warning: { level: 'L1', triggered: false },
    stress: null,
  };
  const rendered = renderDailyReport(report);
  assert.match(rendered.user, /自基线高水位/, 'current drawdown carries baseline-high label');
  assert.match(rendered.user, /观察窗口内最大/, 'window max labeled as window max');
  assert.match(rendered.user, /非全历史/, 'window max explicitly not full-history');
  // The forbidden labeling: a number directly called 历史最大回撤.
  const m = rendered.user.match(/历史最大回撤\s*([\d.]+)%/);
  assert.equal(m, null, 'no window-max labeled as history-max');
  // Warning pairing: 未触发 must carry L1 distance when drawdown exists.
  assert.match(rendered.user, /风险政策预警\*\*：未触发/, 'warning untriggered rendered');
  assert.match(rendered.user, /距 L1 档/, 'untriggered pairs with L1 distance');
  assert.match(rendered.user, /1\.05 个百分点/, 'L1 distance is a number, not an adjective');
});

test('A05: volume claims always carry their basis', () => {
  const f = fixture();
  const breadth = marketBreadth(f.market, '20261106');
  assert.equal(typeof breadth.amount_chg_pct, 'number', 'day-over-day amount pct computed');
  const rendered = renderDailyReport(build(f));
  // When a volume adjective appears, its basis must be on the same line.
  for (const line of rendered.user.split('\n')) {
    if (/放量|缩量/.test(line)) {
      assert.match(line, /20 日均值|环比/, `volume claim carries basis: ${line}`);
    }
  }
});

test('A06: next trade date comes from the trade calendar and is consistent', () => {
  const f = fixture();
  const report = build(f);
  assert.equal(report.expected_next_trade_date, '20261109', 'next open day after 20261106');
  const rendered = renderDailyReport(report);
  assert.match(rendered.user, /2026年11月9日/, 'footer next trade date rendered');
  assert.doesNotMatch(rendered.user, /09月\s*9日|09 月 9 日/, 'no 09月9日 slip');
  assert.doesNotMatch(rendered.user, /9月9日/, 'no 9月9日 slip');
});

test('A13: rendered user report has no forbidden internal vocabulary', () => {
  const f = fixture();
  const rendered = renderDailyReport(build(f));
  for (const bad of ['DEGRADED', 'NOT_READY', 'NO_ACTION', 'snapshot_get', 'report_id', 'MCP', 'HHI']) {
    assert.doesNotMatch(rendered.user, new RegExp(bad), `user report must not contain ${bad}`);
  }
});

test('A17/A18: non-ready market cannot produce a successful daily report', () => {
  const f = fixture();
  // After the baseline but with no market bars on that date (never seeded):
  // the build must not claim READY.
  const late = buildDailyReport({ portfolioDb: f.p, marketDb: f.market, accountId: ACCOUNT, asOfTradeDate: '20261110' });
  assert.notEqual(late.status, 'READY', 'a date with no market bars cannot be READY');
});

test('A18: freshness gate - a DATA_INSUFFICIENT report never contains trade quantities', () => {
  const f = fixture();
  const report = build(f);
  // Execution gate: no executable quantities unless account verified AND quotes ready.
  // The rendered user text must never contain "卖出 X 股" style imperative quantities.
  const rendered = renderDailyReport(report);
  assert.doesNotMatch(rendered.user, /卖出\s*\d+\s*股|买入\s*\d+\s*股/, 'no imperative trade quantities in user report');
});
