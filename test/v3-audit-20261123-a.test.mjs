import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-audit-a-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { openPortfolioDb, ensurePortfolioV3Schema } = await import('../build/portfolio/db.js');
const { evaluateMarketRegime } = await import('../build/ashare/marketRegime.js');
const { screenStockSwingCandidates } = await import('../build/ashare/stockSwingScreener.js');
const { runActionEngine, syncAccountV3State } = await import('../build/portfolio/actionEngine.js');
const { inferBoard, tradabilityOf } = await import('../build/portfolio/rules.js');
const { feeRulesFor } = await import('../build/portfolio/fees.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const ACC = 'audit-a';

function seedDaily(db, tsCode, days, closes, adjFactors = null) {
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
    days.map((trade_date, i) => {
      const close = closes[i];
      const prev = i > 0 ? closes[i - 1] : close;
      return {
        ts_code: tsCode, trade_date, open: close, high: close * 1.01, low: close * 0.99, close,
        pre_close: prev, pct_chg: prev > 0 ? ((close / prev) - 1) * 100 : 0, vol: 1_000_000, amount: 200_000,
      };
    }));
  if (adjFactors) {
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map((trade_date, i) => ({ ts_code: tsCode, trade_date, adj_factor: adjFactors[i] })));
  }
}

function setTracker(pDb, row) {
  pDb.prepare(`
    INSERT OR REPLACE INTO position_stop_tracker (
      account_id, ts_code, entry_date, entry_price_milli, initial_stop_milli,
      current_stop_milli, trailing_ma20_armed, entry_adj_factor, status, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.account_id ?? ACC, row.ts_code, row.entry_date ?? '20260901', row.entry_price_milli,
    row.initial_stop_milli, row.current_stop_milli, row.trailing_ma20_armed ?? 0,
    row.entry_adj_factor === undefined ? null : row.entry_adj_factor, row.status ?? 'OPEN',
    row.updated_at ?? '20260901',
  );
}

function holding(code, priceMilli, refCostMilli, name = code) {
  return {
    ts_code: code, name, quantity: 1000, sellable_quantity: 1000, weight: 0.08,
    market_value_cents: Math.round(1000 * (priceMilli / 10)), price_milli: priceMilli,
    latest_bar_date: null, bar_quality: 'READY', ref_cost_milli: refCostMilli,
  };
}

function runEngine({ pDb, mDb, asOf, holdings }) {
  const out = runActionEngine({
    portfolioDb: pDb,
    marketDb: mDb,
    accountId: ACC,
    asOf,
    holdings,
    cashCents: 9_000_000,
    totalAssetsCents: 10_000_000,
    marketRegime: evaluateMarketRegime(mDb, asOf),
    stockSwingScreen: null,
  });
  syncAccountV3State(pDb, out);
  return out;
}

const sellsFor = (out, code) => out.actions.filter(p => p.legs.some(l => l.side === 'SELL' && l.ts_code === code));

function openDbPair(name) {
  const marketPath = join(dir, `${name}-market.sqlite`);
  const mDb = openAshareDb(marketPath);
  const pDb = openPortfolioDb(join(dir, `${name}-portfolio.sqlite`), { marketPath });
  return { mDb, pDb };
}

// ---------------------------------------------------------------- P0-1 止损跟踪

test('P0-1 migration: entry_adj_factor is added idempotently to a legacy tracker table', () => {
  const path = join(dir, 'legacy-tracker.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE position_stop_tracker (
      account_id TEXT NOT NULL, ts_code TEXT NOT NULL, entry_date TEXT NOT NULL,
      entry_price_milli INTEGER NOT NULL, initial_stop_milli INTEGER NOT NULL,
      current_stop_milli INTEGER NOT NULL, trailing_ma20_armed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN', updated_at TEXT NOT NULL, PRIMARY KEY (account_id, ts_code)
    );`);
    ensurePortfolioV3Schema(db);
    ensurePortfolioV3Schema(db);
    const cols = db.prepare('PRAGMA table_info(position_stop_tracker)').all().map(c => c.name);
    assert.ok(cols.includes('entry_adj_factor'), 'legacy 库必须补上 entry_adj_factor');
  } finally {
    db.close();
  }
});

test('P0-1 re-buy after CLOSED must not resurrect a ghost high stop', () => {
  const { mDb, pDb } = openDbPair('ghost');
  try {
    const days = weekdays('20260901', 12);
    const asOf = days[10];
    const next = days[11];
    seedDaily(mDb, '600036.SH', days, days.map(() => 29.0));
    // 旧仓位曾在 50.00 一带留下高 stop，随后 CLOSED；今日以 30.00 重新买入。
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 50000, initial_stop_milli: 46000,
      current_stop_milli: 50000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'CLOSED', entry_date: '20260801',
    });

    const first = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 30000, 30000)] });
    assert.deepEqual(sellsFor(first, '600036.SH'), [], '重新买入价 30.00 不得被旧的 50.00 幽灵止损触发');
    let row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.entry_price_milli, 30000);
    assert.equal(row.initial_stop_milli, 27600);
    assert.equal(row.current_stop_milli, 27600, 'CLOSED 行必须整体重置，而不是 MAX 保留 50000');
    assert.equal(row.trailing_ma20_armed, 0);
    assert.equal(row.entry_adj_factor, 1);

    const second = runEngine({ pDb, mDb, asOf: next, holdings: [holding('600036.SH', 30500, 30000)] });
    assert.deepEqual(sellsFor(second, '600036.SH'), [], '次日 30.50 仍远高于新止损 27.60');
    row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.current_stop_milli, 27600);
    assert.equal(row.status, 'OPEN');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 ex-right 2:1 split must not false-trigger the stored stop', () => {
  const { mDb, pDb } = openDbPair('split');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const splitIdx = days.length - 5;
    const closes = days.map((_, i) => (i < splitIdx ? 10.0 : i === days.length - 1 ? 5.2 : 5.3));
    const factors = days.map((_, i) => (i < splitIdx ? 1 : 2));
    seedDaily(mDb, '600036.SH', days, closes, factors);
    // 除权前买入：entry 10.00，浮盈 +15% 后武装，stop 上移至成本 10.00（entry 基准）。
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });
    const rawStopWouldTrigger = 5200 <= 10000;
    assert.ok(rawStopWouldTrigger, '场景前提：不换算时 5.20 会跌破旧 stop 10.00');

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 5200, 10000)] });
    assert.deepEqual(sellsFor(out, '600036.SH'), [], '2:1 拆股后 5.20 等价除权前 10.40，不得触发 10.00 止损');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.current_stop_milli, 10000, 'tracker 仍按 entry 基准存储，避免基准漂移');
    assert.equal(row.entry_adj_factor, 1, '已记录的 entry 基准不得每天改写');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 an ordinary open position still exits on the MA20 trail', () => {
  const { mDb, pDb } = openDbPair('trail');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const closes = days.map((_, i) => (i === days.length - 1 ? 10.1 : 10.2));
    seedDaily(mDb, '600036.SH', days, closes);
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 10100, 10000)] });
    const sells = sellsFor(out, '600036.SH');
    assert.equal(sells.length, 1, '正常持仓跌破 MA20 仍应止盈离场');
    assert.equal(sells[0].legs[0].reason, 'P1_TRAILING_MA20_STOP');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'CLOSED');
  } finally {
    pDb.close();
    mDb.close();
  }
});

// ---------------------------------------------------------------- P1-1 920 北交所板块

test('P1-1 920xxx.BJ is a restricted board, never executable', () => {
  assert.equal(inferBoard('920001.BJ'), '920');
  assert.equal(inferBoard('920001.SH'), '920');
  assert.equal(inferBoard('830799.BJ'), '920');
  assert.equal(inferBoard('600036.SH'), 'main');
  const t = tradabilityOf('920001.BJ', { kind: 'STOCK' });
  assert.equal(t.tradable, false);
  assert.equal(t.reason, 'permission_restricted');
  assert.equal(tradabilityOf('920001.BJ', { kind: 'ETF' }).tradable, true);
});

// ---------------------------------------------------------------- P1-7 费率与候选深度

test('P1-7 whitelisted super ETF codes auto-classify as SUPER_ETF; explicit profiles still win', () => {
  const ctx = { asOf: '20261113', accountId: 'a', profiles: [] };
  const superRules = feeRulesFor(ctx, '159052.SZ', 'ETF');
  assert.equal(superRules.fee_model.classification, 'SUPER_ETF');
  assert.equal(superRules.commission_rate, 0.00005);
  assert.equal(superRules.commission_min_cents, 0);
  assert.equal(superRules.fee_model.evidence.commission_rate.level, 'ASSUMED');
  assert.match(superRules.fee_model.evidence.commission_rate.source, /EASTMONEY_SUPER_ETF_CODES/);

  const normalRules = feeRulesFor(ctx, '159558.SZ', 'ETF');
  assert.equal(normalRules.fee_model.classification, 'NORMAL_ETF');
  assert.equal(normalRules.commission_rate, 0.00025);
  assert.equal(normalRules.commission_min_cents, 500);

  const override = feeRulesFor({
    ...ctx,
    profiles: [{ id: 'normalize', code: '159052.SZ', classification: 'NORMAL_ETF', effective_from: '20260101', values: {}, evidence: {} }],
  }, '159052.SZ', 'ETF');
  assert.equal(override.fee_model.classification, 'NORMAL_ETF', '显式 code profile 必须覆盖白名单自动分类');
  assert.equal(override.commission_rate, 0.00025);
  assert.equal(override.commission_min_cents, 500);
});

function seedDepthMarket(name) {
  const days = weekdays('20260401', 145);
  const asOf = days.at(-1);
  const db = openAshareDb(join(dir, `${name}-market.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));

  const stocks = [
    ...Array.from({ length: 40 }, (_, i) => ({ code: `603${String(i).padStart(3, '0')}.SH`, name: `背景${i}`, probe: null })),
    ...Array.from({ length: 10 }, (_, k) => ({ code: `605${String(k).padStart(3, '0')}.SH`, name: `回踩${k}`, probe: k })),
  ];
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'market', 'exchange', 'list_date', 'list_status'],
    stocks.map(s => ({
      ts_code: s.code, symbol: s.code.slice(0, 6), name: s.name, industry: '制造业',
      market: '主板', exchange: 'SSE', list_date: '20180101', list_status: 'L',
    })));

  const dailyRows = [];
  const adjRows = [];
  const limitRows = [];
  const basicRows = [];
  // 与 v3-phase3 BP1_PASS 探针完全一致的 K 线（open/high/low/vol 固定），
  // 只对 asOf 收盘做 0.1% 阶梯扰动，让 10 只回踩股的 RPS 排名不并列。
  const BP1_PATTERN = {
    137: [20.4, 20.1, 20.5, 20.0, 1.2e5, 2.4e5],
    138: [20.8, 20.4, 20.9, 20.3, 1.3e5, 2.6e5],
    139: [21.4, 20.85, 21.8, 20.8, 1.4e5, 3.0e5],
    140: [20.6, 21.0, 21.1, 20.3, 0.5e5, 1.5e5],
    141: [20.1, 20.4, 20.5, 19.95, 0.45e5, 1.5e5],
    142: [19.9, 20.0, 20.1, 19.8, 0.4e5, 1.5e5],
    143: [19.9, 19.95, 20.05, 19.82, 0.4e5, 1.5e5],
    144: [20.35, 19.92, 20.5, 19.88, 1.2e5, 2.4e5],
  };
  for (const s of stocks) {
    const closes = [];
    const bars = [];
    for (let i = 0; i < days.length; i += 1) {
      let close;
      let open;
      let high;
      let low;
      let vol;
      let amount;
      if (s.probe === null) {
        close = Math.round(10 * Math.pow(1.002, i) * 100) / 100;
        open = Math.round(close * 0.998 * 100) / 100;
        high = Math.round(close * 1.01 * 100) / 100;
        low = Math.round(open * 0.99 * 100) / 100;
        vol = 1e5;
        amount = 2e5;
      } else if (BP1_PATTERN[i]) {
        [close, open, high, low, vol, amount] = BP1_PATTERN[i];
        if (i === 144) close = Math.round(close * (1 - 0.001 * s.probe) * 100) / 100;
      } else {
        close = 10 + (10 * Math.min(i, 136)) / 136;
        open = close * 0.996;
        high = close * 1.01;
        low = open * 0.99;
        vol = 1e5;
        amount = 2e5;
      }
      closes.push(close);
      bars.push({ close, open, high, low, vol, amount });
    }
    for (let i = 0; i < days.length; i += 1) {
      const b = bars[i];
      const prev = i > 0 ? closes[i - 1] : b.close;
      dailyRows.push({
        ts_code: s.code, trade_date: days[i], open: b.open, high: b.high, low: b.low, close: b.close,
        pre_close: prev, pct_chg: prev > 0 ? (b.close / prev - 1) * 100 : 0, vol: b.vol, amount: b.amount,
      });
      adjRows.push({ ts_code: s.code, trade_date: days[i], adj_factor: 1 });
      limitRows.push({ ts_code: s.code, trade_date: days[i], up_limit: prev * 1.1, down_limit: prev * 0.9 });
      basicRows.push({ ts_code: s.code, trade_date: days[i], turnover_rate: 2, pe_ttm: 22, pb: 2.5, circ_mv: 1.2e6, total_mv: 1.5e6 });
    }
  }
  upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], dailyRows);
  upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'], adjRows);
  upsertRows(db, 'stk_limit', ['ts_code', 'trade_date', 'up_limit', 'down_limit'], limitRows);
  upsertRows(db, 'daily_basic', ['ts_code', 'trade_date', 'turnover_rate', 'pe_ttm', 'pb', 'circ_mv', 'total_mv'], basicRows);
  upsertRows(db, 'fina_indicator', ['ts_code', 'ann_date', 'end_date', 'roe', 'roe_dt', 'eps', 'ocfps', 'debt_to_assets', 'ocf_to_profit', 'or_yoy', 'netprofit_yoy', 'dt_netprofit_yoy', 'grossprofit_margin'],
    stocks.map(s => ({
      ts_code: s.code, ann_date: '20260820', end_date: '20260630',
      roe: 8.5, roe_dt: 8.2, eps: 0.95, ocfps: 1.1, debt_to_assets: 35, ocf_to_profit: 85,
      or_yoy: 18, netprofit_yoy: 22, dt_netprofit_yoy: 20, grossprofit_margin: 34,
    })));
  return { db, asOf };
}

test('P1-7 actionEngine asks for 10 deep candidates, not the 2-position cap', () => {
  const { db: mDb, asOf } = seedDepthMarket('depth');
  const pDb = openPortfolioDb(join(dir, 'depth-portfolio.sqlite'), { marketPath: join(dir, 'depth-market.sqlite') });
  try {
    const screened = screenStockSwingCandidates(mDb, asOf);
    assert.equal(screened.qualified_count, 10, `应筛出 10 只合格回踩股，实际=${screened.qualified_count}`);
    assert.equal(screened.candidates.length, 2, '直接调用默认仍按持仓上限截断');

    const out = runActionEngine({
      portfolioDb: pDb, marketDb: mDb, accountId: ACC, asOf,
      holdings: [], cashCents: 10_000_000, totalAssetsCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, asOf),
    });
    assert.equal(out.router.sub_strategies.s_stock_swing, 'ACTIVE');
    assert.equal(out.stock_swing_candidates.length, 10,
      'actionEngine 必须拉取 max(stock_max_positions, 10) 个候选，供前 2 名不可买时替补');
  } finally {
    pDb.close();
    mDb.close();
  }
});
