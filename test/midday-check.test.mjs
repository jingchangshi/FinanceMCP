import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openAshareDb } from '../build/ashare/db.js';
import { PORTFOLIO_TOOL_NAMES, WRITE_SCOPE_TOOL_NAMES } from '../build/ashare/definitions.js';
import { openPortfolioDb } from '../build/portfolio/db.js';
import { initBaseline } from '../build/portfolio/ledger.js';
import { buildIntradayMiddayCheck, MIDDAY_CHECK_SCHEMA, MIDDAY_CHECK_TOOL } from '../build/portfolio/middayCheck.js';
import { writeDailyBrief, DAILY_BRIEF_SCHEMA } from '../build/portfolio/dailyBrief.js';
import { dispatchTool, getAvailableToolList, getPrivateToolList } from '../build/dispatch.js';

function quoteRow(over) {
  const symbol = over.ts_code.split('.')[0];
  return {
    ts_code: over.ts_code,
    symbol,
    name: over.name ?? over.ts_code,
    trade_date: over.trade_date ?? '20261126',
    quote_time: over.quote_time ?? '11:30:00',
    open: over.open ?? over.close,
    high: over.high ?? over.close,
    low: over.low ?? over.close,
    close: over.close,
    pre_close: over.pre_close ?? over.close,
    change: over.change ?? 0,
    pct_chg: over.pct_chg ?? 0,
    vol: over.vol ?? 10000,
    amount: over.amount ?? 50000,
    turnover_rate: 1.2,
    pe_ttm: null,
    pb: null,
    volume_ratio: 1.0,
    circ_mv: null,
    total_mv: null,
    up_limit: null,
    down_limit: null,
  };
}

function setupFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-midday-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marketDbPath = join(dir, 'market.sqlite');
  const portfolioDbPath = join(dir, 'portfolio.sqlite');
  const briefDir = join(dir, 'daily-briefs');

  const marketDb = openAshareDb(marketDbPath);
  t.after(() => marketDb.close());
  marketDb.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, ?)').run('20261126', 1);
  marketDb.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, ?)').run('20261127', 0);
  marketDb.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, ?)').run('20261128', 0);
  marketDb.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open) VALUES (?, ?)').run('20261129', 1);

  const portfolioDb = openPortfolioDb(portfolioDbPath, { writable: true, marketPath: marketDbPath });
  t.after(() => portfolioDb.close());

  portfolioDb.prepare(`
    INSERT INTO account_snapshot (
      snapshot_id, as_of, source, note, warnings, is_current,
      total_assets_cents, securities_mv_cents, cash_cents, wealth_cents, unrealized_pnl_cents, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('snap-1', '20261125', 'test', 'test', '[]', 1, 7_000_000, 6_000_000, 900_000, 100_000, 0, '2026-11-25T12:00:00Z');
  const posStmt = portfolioDb.prepare(
    'INSERT INTO position (snapshot_id, ts_code, name, quantity, ref_price_milli, ref_cost_milli, market_value_cents) VALUES (?,?,?,?,?,?,?)',
  );
  // 159558.SZ: 36,900 shares; 600001.SH stock position: 2,000 shares @ ref cost 10.00 -> -8% stop = 9.20
  posStmt.run('snap-1', '159558.SZ', '半导体设备ETF', 36900, 740, 1200, 2_730_600);
  posStmt.run('snap-1', '600001.SH', '样本主板股', 2000, 1000, 1000, 2_000_000);
  initBaseline(portfolioDb, 'acc-midday', { snapshotId: 'snap-1', asOf: '20261125' });

  portfolioDb.prepare(`
    INSERT INTO account_risk_anchor (
      account_id, initial_principal_cents, hwm_nav_cents, hwm_date,
      hwm_flows_applied_through, hwm_applied_same_day_flow_cents, hwm_nav_scope,
      circuit_breaker_status, locked_until_trade_date, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('acc-midday', 10_000_000, 6_000_000, '20261113', null, 0, 'INVESTABLE', 'NORMAL', null, '20261125');

  portfolioDb.prepare(`
    INSERT INTO deconcentration_plan (
      plan_id, account_id, ts_code, initial_shares, target_keep_bps,
      anchor_price_milli, anchor_trade_date, support_floor_milli,
      last_exec_price_milli, last_exec_date, plan_mode, tactical_slot_bps,
      tactical_shares, tactical_entry_price_milli, tactical_entry_date,
      completed_swing_count, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('plan-1', 'acc-midday', '159558.SZ', 58900, 2500, 819, '20261113', 780, 828, '20261118', 'BOTTOM_GRIND_25', 1000, 0, null, null, 0, 'ACTIVE', '20261113');

  portfolioDb.prepare(`
    INSERT INTO deconcentration_tranche (plan_id, tranche_no, planned_shares, status, trigger_date, trigger_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('plan-1', 3, 8200, 'TRIGGERED', '20261125', 'BREAKDOWN_SUPPORT_FLOOR');

  portfolioDb.prepare(`
    INSERT INTO position_stop_tracker (account_id, ts_code, entry_date, entry_price_milli, initial_stop_milli, current_stop_milli, trailing_ma20_armed, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('acc-midday', '600001.SH', '20261118', 10000, 9200, 9200, 0, 'OPEN', '20261125');

  // Seed 20d bars for MA20 on 600001.SH (close=10.0) & index anchors & fund_nav
  const barStmt = marketDb.prepare(
    'INSERT INTO daily (ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const idxStmt = marketDb.prepare(
    'INSERT INTO index_daily (ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  for (let d = 1; d <= 20; d++) {
    const dt = `202611${String(d).padStart(2, '0')}`;
    barStmt.run('600001.SH', dt, 10, 10.2, 9.8, 10.0, 10.0, 0, 10000, 100000);
    idxStmt.run('000300.SH', dt, 3900, 3920, 3880, 3900, 3900, 0, 100000, 50000000);
    idxStmt.run('000905.SH', dt, 5900, 5920, 5880, 5900, 5900, 0, 100000, 40000000);
    idxStmt.run('399006.SZ', dt, 2200, 2220, 2180, 2200, 2200, 0, 100000, 30000000);
  }
  marketDb.prepare('INSERT INTO fund_nav (ts_code, ann_date, nav_date, unit_nav, accum_nav, adj_nav) VALUES (?,?,?,?,?,?)')
    .run('159920.SZ', '20261125', '20261125', 1.25, 1.25, 1.25);
  marketDb.prepare('INSERT INTO fund_nav (ts_code, ann_date, nav_date, unit_nav, accum_nav, adj_nav) VALUES (?,?,?,?,?,?)')
    .run('510300.SH', '20261125', '20261125', 4.08, 4.08, 4.08);

  writeDailyBrief(join(briefDir, '20261125.json'), {
    schema: DAILY_BRIEF_SCHEMA,
    report_id: 'BRIEF-20261125',
    as_of_trade_date: '20261125',
    expected_next_trade_date: '20261126',
    status: 'ACTIONABLE',
    actionable: true,
    first_section: {
      actions: [
        {
          priority: 'P2',
          code: 'P2-DECONCENTRATE-159558',
          kind: 'REDUCE',
          title: '卖出 159558.SZ 8200 份',
          legs: [{ side: 'SELL', ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 8200, price_milli: 738 }],
        },
        {
          priority: 'P3',
          code: 'P3-BUY-CHASE',
          kind: 'ROTATE',
          title: '买入 510300.SH',
          legs: [{ side: 'BUY', ts_code: '510300.SH', name: '沪深300ETF', quantity: 1000, price_milli: 4000 }],
        },
        {
          priority: 'P3',
          code: 'P3-BUY-QDII',
          kind: 'ROTATE',
          title: '买入 159920.SZ',
          legs: [{ side: 'BUY', ts_code: '159920.SZ', name: '恒生ETF', quantity: 1000, price_milli: 1260 }],
        },
      ],
    },
    v3_cockpit: {
      market_regime: { regime: 'DEFENSIVE', regime_label_zh: '空头防守档' },
      cross_border_monitor: [{ ts_code: '159920.SZ', name: '恒生ETF' }],
      stock_swing_candidates: [],
    },
    holdings: [
      { ts_code: '159558.SZ', diluted_cost_per_share: 1.2 },
      { ts_code: '600001.SH', diluted_cost_per_share: 10.0 },
    ],
  });

  return { marketDb, portfolioDb, briefDir };
}

test('NON_TRADING_DAY returns closed immediately without calling quote API', async t => {
  const { marketDb, portfolioDb, briefDir } = setupFixture(t);
  let called = 0;
  // 2026-11-27 11:45 Asia/Shanghai == 2026-11-27T03:45:00Z
  const nowMs = Date.parse('2026-11-27T03:45:00Z');
  const res = await buildIntradayMiddayCheck({
    portfolioDb,
    marketDb,
    accountId: 'acc-midday',
    briefDir,
    nowMs,
    fetchQuotes: async () => {
      called++;
      return new Map();
    },
  });
  assert.equal(res.status, 'NON_TRADING_DAY');
  assert.equal(res.is_trade_day, false);
  assert.equal(res.session_phase, 'CLOSED_HOLIDAY');
  assert.equal(res.next_trade_day, '20261129');
  assert.equal(called, 0);
});

test('MIDDAY_BREAK evaluates INVESTABLE HWM drawdown, +2% chase, +2.5% QDII premium, stop/MA20, and 159558 floor', async t => {
  const { marketDb, portfolioDb, briefDir } = setupFixture(t);
  // 2026-11-26 11:45 Asia/Shanghai == 2026-11-26T03:45:00Z
  const nowMs = Date.parse('2026-11-26T03:45:00Z');
  const quotes = new Map([
    ['000300.SH', quoteRow({ ts_code: '000300.SH', name: '沪深300', close: 3750, pct_chg: -3.85, amount: 30000000 })],
    ['000905.SH', quoteRow({ ts_code: '000905.SH', name: '中证500', close: 5680, pct_chg: -3.73, amount: 24000000 })],
    ['399006.SZ', quoteRow({ ts_code: '399006.SZ', name: '创业板指', close: 2150, pct_chg: -2.27, amount: 18000000 })],
    // 159558.SZ deep break <= 0.749 (0.720 * 36900 = 26568.00 = 2,656,800 cents)
    ['159558.SZ', quoteRow({ ts_code: '159558.SZ', name: '半导体设备ETF', close: 0.720, pct_chg: -2.44 })],
    // 600001.SH breached -8% stop (9.20) & MA20 (10.0) => 9.10 * 2000 = 18200.00 = 1,820,000 cents
    ['600001.SH', quoteRow({ ts_code: '600001.SH', name: '样本主板股', close: 9.10, pct_chg: -9.0 })],
    // 510300.SH +3% vs ref 4.00 -> SKIP_CHASE_ABOVE_2PCT
    ['510300.SH', quoteRow({ ts_code: '510300.SH', name: '沪深300ETF', close: 4.12, pct_chg: 3.0 })],
    // 159920.SZ 1.30 vs nav 1.25 (+4.0% premium > 2.5%) -> BLOCKED_ETF_PREMIUM_OR_STALE_NAV
    ['159920.SZ', quoteRow({ ts_code: '159920.SZ', name: '恒生ETF', close: 1.30, pct_chg: 3.17 })],
    // extra watch
    ['511010.SH', quoteRow({ ts_code: '511010.SH', name: '国债ETF', close: 141.35, pct_chg: -0.05 })],
  ]);

  const res = await buildIntradayMiddayCheck({
    portfolioDb,
    marketDb,
    accountId: 'acc-midday',
    extraCodes: ['511010.SH', 'INVALID', '511010.SH'],
    briefDir,
    nowMs,
    fetchQuotes: async () => quotes,
  });

  assert.equal(res.schema, MIDDAY_CHECK_SCHEMA);
  assert.equal(res.status, 'OK');
  assert.equal(res.read_only, true);
  assert.equal(res.session_phase, 'MIDDAY_BREAK');
  assert.equal(res.extreme_crash_warning, true);

  // Investable NAV = cash 900,000 + holdings (2,656,800 + 1,820,000) = 5,376,800 cents; HWM = 6,000,000 => DD = 10.39%
  assert.equal(res.live_account.hwm_nav_scope, 'INVESTABLE');
  assert.equal(res.live_account.live_investable_nav_cents, 5_376_800);
  assert.equal(res.live_account.live_total_assets_cents, 5_476_800); // wealth 100k included in total, excluded in investable HWM
  assert.equal(res.live_account.live_hwm_drawdown_pct, 10.39);
  assert.equal(res.live_account.deconcentration_preemptive_active, true);
  assert.equal(res.live_account.l2_trigger_pct, 12);
  assert.equal(res.live_account.live_breaker_alert, 'NEAR_L2');

  const buy300 = res.planned_actions_check[1].legs[0];
  assert.equal(buy300.execution_check, 'SKIP_CHASE_ABOVE_2PCT');
  assert.equal(buy300.gap_from_ref_pct, 3);

  const buyQdii = res.planned_actions_check[2].legs[0];
  assert.equal(buyQdii.execution_check, 'BLOCKED_ETF_PREMIUM_OR_STALE_NAV');
  assert.equal(buyQdii.premium_blocked, true);

  const h159558 = res.holdings_check.find(h => h.ts_code === '159558.SZ');
  assert.ok(h159558.intraday_flags.includes('DEEP_BELOW_SUPPORT_FLOOR'));
  assert.ok(h159558.intraday_flags.includes('OVERWEIGHT_DRIFT_34PCT'));

  const hStock = res.holdings_check.find(h => h.ts_code === '600001.SH');
  assert.ok(hStock.intraday_flags.includes('STOP_BREACHED_INTRADAY_WATCH_CLOSE'));
  assert.ok(hStock.intraday_flags.includes('BELOW_MA20_WATCH_CLOSE'));

  assert.equal(res.extra_watch.length, 1);
  assert.equal(res.extra_watch[0].ts_code, '511010.SH');
});

test('QUOTE_UNAVAILABLE fails closed without fabricating intraday quotes', async t => {
  const { marketDb, portfolioDb, briefDir } = setupFixture(t);
  const res = await buildIntradayMiddayCheck({
    portfolioDb,
    marketDb,
    accountId: 'acc-midday',
    briefDir,
    nowMs: Date.parse('2026-11-26T03:45:00Z'),
    fetchQuotes: async () => {
      throw new Error('Tencent HTTP 503');
    },
  });
  assert.equal(res.status, 'QUOTE_UNAVAILABLE');
  assert.match(res.error, /Tencent HTTP 503/);
});

test('endpoint isolation: private-only, readOnlyHint=true, no write scope', async () => {
  assert.ok(PORTFOLIO_TOOL_NAMES.has(MIDDAY_CHECK_TOOL));
  assert.equal(WRITE_SCOPE_TOOL_NAMES.has(MIDDAY_CHECK_TOOL), false);
  const pubNames = getAvailableToolList().map(t => t.name);
  assert.equal(pubNames.includes(MIDDAY_CHECK_TOOL), false);
  const privTool = getPrivateToolList().find(t => t.name === MIDDAY_CHECK_TOOL);
  assert.ok(privTool);
  assert.equal(privTool.annotations.readOnlyHint, true);
  assert.deepEqual(privTool.securitySchemes, [{ type: 'oauth2', scopes: ['portfolio:read'] }]);
  await assert.rejects(() => dispatchTool(MIDDAY_CHECK_TOOL, {}), /private_endpoint_required/);
});
