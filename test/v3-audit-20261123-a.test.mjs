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

function seedDaily(db, tsCode, days, closes, adjFactors = null, priceTable = 'daily') {
  upsertRows(db, priceTable, ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
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
    assert.equal(row.entry_adj_factor, null, '无真实 as-of 因子时不得写入 1 冒充');
    assert.equal(row.entry_price_milli, 30000);
    assert.equal(row.initial_stop_milli, 27600);
    assert.equal(row.current_stop_milli, 27600, 'CLOSED 行必须整体重置，而不是 MAX 保留 50000');
    assert.equal(row.trailing_ma20_armed, 0);

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

test('P0-1 tracker lifecycle follows actual holdings, not sell recommendations', () => {
  const { mDb, pDb } = openDbPair('lifecycle');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days[10];
    const next = days[11];
    const afterSell = days[12];
    const reBuy = days[13];
    seedDaily(mDb, '600036.SH', days, days.map(() => 9.5));
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    // 1) 触发止损并建议卖出，但仍持有 -> OPEN，保本线保留
    const first = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 9900, 10000)] });
    assert.equal(sellsFor(first, '600036.SH').length, 1);
    let row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.current_stop_milli, 10000);
    assert.equal(row.trailing_ma20_armed, 1);

    // 2) 忽略卖出建议，下一轮仍持有 -> 仍 OPEN，保本线不丢
    const second = runEngine({ pDb, mDb, asOf: next, holdings: [holding('600036.SH', 9800, 10000)] });
    assert.equal(sellsFor(second, '600036.SH').length, 1, '跌破保本线继续给出卖出建议');
    row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.current_stop_milli, 10000, '忽略建议后保本线不得丢失');
    assert.equal(row.trailing_ma20_armed, 1);

    // 3) 实际卖出后持仓消失 -> CLOSED
    runEngine({ pDb, mDb, asOf: afterSell, holdings: [] });
    row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'CLOSED');
    assert.equal(row.current_stop_milli, 10000, 'CLOSED 保留历史字段供审计');

    // 4) 再次买入 -> 按 ref_cost 重置 entry/stop/armed
    runEngine({ pDb, mDb, asOf: reBuy, holdings: [holding('600036.SH', 12000, 12000)] });
    row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
    assert.equal(row.entry_date, reBuy);
    assert.equal(row.entry_price_milli, 12000);
    assert.equal(row.initial_stop_milli, 11040);
    assert.equal(row.current_stop_milli, 11040);
    assert.equal(row.trailing_ma20_armed, 0);
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 legacy OPEN row resolves its entry basis from entry_date adj_factor', () => {
  const { mDb, pDb } = openDbPair('legacy-entry-factor');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const splitIdx = days.length - 5;
    const closes = days.map((_, i) => (i < splitIdx ? 10.0 : i === days.length - 1 ? 5.2 : 5.3));
    const factors = days.map((_, i) => (i < splitIdx ? 1 : 2));
    seedDaily(mDb, '600036.SH', days, closes, factors);
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: null,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 5200, 10000)] });
    assert.deepEqual(sellsFor(out, '600036.SH'), [], '按 entry_date 因子 1 换算后 5.20 不得触发 10.00 止损');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.entry_adj_factor, 1, '必须回查 entry_date 的真实因子，而不是写 currentAdj=2');
    assert.equal(row.current_stop_milli, 10000);
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 stock entry-factor lookup miss stays unscaled and keeps entry_adj_factor NULL', () => {
  const { mDb, pDb } = openDbPair('legacy-miss');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const closes = days.map((_, i) => (i < 20 ? 10.0 : i === days.length - 1 ? 5.2 : 5.3));
    // entry_date 之前没有任何复权因子；仅在除权日后出现因子 2。
    const factors = days.map((_, i) => (i < 20 ? null : 2));
    seedDaily(mDb, '600036.SH', days, closes, factors);
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: null,
      status: 'OPEN', entry_date: days[5],
    });

    runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 5200, 10000)] });
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.entry_adj_factor, null, '查不到 entry 因子时不得写 currentAdj 冒充');
    assert.equal(row.current_stop_milli, 10000, '不缩放');
    assert.equal(row.status, 'OPEN');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 ETF legacy tracker uses fund_adj, never the stock adj_factor table', () => {
  const { mDb, pDb } = openDbPair('etf-entry-factor');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const splitIdx = days.length - 5;
    // 股票因子表故意全为 1：若误用会得到 currentAdj=1 并错误触发止损。
    upsertRows(mDb, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: '159558.SZ', trade_date, adj_factor: 1 })));
    upsertRows(mDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      days.map((trade_date, i) => ({ ts_code: '159558.SZ', trade_date, adj_factor: i < splitIdx ? 1 : 2 })));
    setTracker(pDb, {
      ts_code: '159558.SZ', entry_price_milli: 1000, initial_stop_milli: 920,
      current_stop_milli: 1000, trailing_ma20_armed: 1, entry_adj_factor: null,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('159558.SZ', 520, 1000, '半导体设备ETF')] });
    assert.deepEqual(sellsFor(out, '159558.SZ'), [], 'ETF 必须用 fund_adj 换算（2:1 拆股后 0.52 不触发 1.00 止损）');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '159558.SZ');
    assert.equal(row.entry_adj_factor, 1, 'ETF entry 因子取自 fund_adj 的 entry_date 值');
    assert.equal(row.current_stop_milli, 1000);
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 new tracker without a real as-of factor keeps NULL and does not scale', () => {
  const { mDb, pDb } = openDbPair('no-factor-new');
  try {
    const days = weekdays('20260901', 12);
    const asOf = days[10];
    seedDaily(mDb, '600036.SH', days, days.map(() => 10.0)); // 无 adj_factor 行
    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 10000, 10000)] });
    assert.deepEqual(sellsFor(out, '600036.SH'), []);
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.entry_adj_factor, null, '无真实因子时不得写入 1');
    assert.equal(row.entry_price_milli, 10000);
    assert.equal(row.current_stop_milli, 9200, '无因子时按原始价建仓，止损 8%');
    assert.equal(row.status, 'OPEN');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 new tracker records a real as-of factor instead of defaulting to 1', () => {
  const { mDb, pDb } = openDbPair('real-factor-new');
  try {
    const days = weekdays('20260901', 12);
    const asOf = days[10];
    seedDaily(mDb, '600036.SH', days, days.map(() => 10.0), days.map(() => 2));
    runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 10000, 10000)] });
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.entry_adj_factor, 2, '必须记录真实的 as-of 因子 2');
    assert.equal(row.current_stop_milli, 9200);
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-1 missing current factor skips scaling even with a stored entry factor', () => {
  const { mDb, pDb } = openDbPair('no-current-factor');
  try {
    const days = weekdays('20260901', 12);
    const asOf = days[10];
    seedDaily(mDb, '600036.SH', days, days.map(() => 9.9)); // 无 adj_factor 行
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 10000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });
    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 9900, 10000)] });
    assert.equal(sellsFor(out, '600036.SH').length, 1, '缺少 current 因子时按 entry 基准原始价比较');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.entry_adj_factor, 1, '已记录的真实 entry 因子保持不变');
    assert.equal(row.current_stop_milli, 10000);
    assert.equal(row.status, 'OPEN');
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
    assert.equal(row.status, 'OPEN', '仅发出卖出建议不等于已清仓，tracker 由真实持仓驱动');
  } finally {
    pDb.close();
    mDb.close();
  }
});

// ---------------------------------------------------------------- P0-2 个股 MA20 无条件离场

test('P0-2 stock exits below MA20 without +15% arming (EXP-V3-02 parity)', () => {
  const { mDb, pDb } = openDbPair('ma20-stock');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const closes = days.map((_, i) => (i === days.length - 1 ? 9.9 : 10.0));
    seedDaily(mDb, '600036.SH', days, closes);
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 9200, trailing_ma20_armed: 0, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 9900, 10000)] });
    const sells = sellsFor(out, '600036.SH');
    assert.equal(sells.length, 1, '未武装的个股收盘跌破 MA20 也必须离场');
    assert.equal(sells[0].legs[0].reason, 'P1_MA20_EXIT');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN', '仍持有时不得因卖出建议把 tracker 置 CLOSED');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-2 stock above MA20 holds without arming', () => {
  const { mDb, pDb } = openDbPair('ma20-hold');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const closes = days.map((_, i) => (i === days.length - 1 ? 10.3 : 10.0));
    seedDaily(mDb, '600036.SH', days, closes);
    setTracker(pDb, {
      ts_code: '600036.SH', entry_price_milli: 10000, initial_stop_milli: 9200,
      current_stop_milli: 9200, trailing_ma20_armed: 0, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('600036.SH', 10300, 10000)] });
    assert.deepEqual(sellsFor(out, '600036.SH'), [], 'MA20 上方持仓不得离场');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '600036.SH');
    assert.equal(row.status, 'OPEN');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-2 ETF MA20 uses fund_adj/fund_daily: a dividend must not create a false breakdown', () => {
  const { mDb, pDb } = openDbPair('etf-ma20-div');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    const divIdx = 20;
    // 除息前 1.00；除息后 0.97，末日 0.975（真实 fund_daily 行情）。
    const closes = days.map((_, i) => (i < divIdx ? 1.0 : i === days.length - 1 ? 0.975 : 0.97));
    seedDaily(mDb, '159558.SZ', days, closes, null, 'fund_daily');
    // 对照陷阱：若误用股票 daily 或 adj_factor，未复权 MA20 会把 0.975 判为跌破。
    seedDaily(mDb, '159558.SZ', days, days.map(() => 1.0));
    upsertRows(mDb, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: '159558.SZ', trade_date, adj_factor: 1 })));
    // 分红复权：除息日起 fund_adj = 前收/除息价 = 1/0.97。
    upsertRows(mDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      days.map((trade_date, i) => ({ ts_code: '159558.SZ', trade_date, adj_factor: i < divIdx ? 1 : 1 / 0.97 })));
    setTracker(pDb, {
      ts_code: '159558.SZ', entry_price_milli: 1000, initial_stop_milli: 920,
      current_stop_milli: 1000, trailing_ma20_armed: 1, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    const out = runEngine({ pDb, mDb, asOf, holdings: [holding('159558.SZ', 975, 1000, '半导体设备ETF')] });
    assert.deepEqual(sellsFor(out, '159558.SZ'), [], 'ETF 分红后原始价 0.975 不得被未复权 MA20 假跌破');
    const row = pDb.prepare('SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = ?').get(ACC, '159558.SZ');
    assert.equal(row.status, 'OPEN');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-2 ETF tracker rows keep the armed-only MA20 semantics', () => {
  const { mDb, pDb } = openDbPair('ma20-etf');
  try {
    const days = weekdays('20260901', 25);
    const asOf = days.at(-1);
    seedDaily(mDb, '159558.SZ', days, days.map(() => 0.85), null, 'fund_daily');
    setTracker(pDb, {
      ts_code: '159558.SZ', entry_price_milli: 850, initial_stop_milli: 782,
      current_stop_milli: 782, trailing_ma20_armed: 0, entry_adj_factor: 1,
      status: 'OPEN', entry_date: days[0],
    });

    const unarmed = runEngine({ pDb, mDb, asOf, holdings: [holding('159558.SZ', 800, 850, '半导体设备ETF')] });
    assert.deepEqual(sellsFor(unarmed, '159558.SZ'), [], '未武装的 ETF 跌破 MA20 不得离场');

    pDb.prepare('UPDATE position_stop_tracker SET trailing_ma20_armed = 1 WHERE account_id = ? AND ts_code = ?').run(ACC, '159558.SZ');
    const armed = runEngine({ pDb, mDb, asOf, holdings: [holding('159558.SZ', 800, 850, '半导体设备ETF')] });
    const sells = sellsFor(armed, '159558.SZ');
    assert.equal(sells.length, 1, '武装后的 ETF 跌破 MA20 仍应移动止盈');
    assert.equal(sells[0].legs[0].reason, 'P1_TRAILING_MA20_STOP');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P0-2 requireIndustryTop30 defaults to false (EXP-V3-02) and stays explicitly opt-in', () => {
  const { db: mDb, asOf } = seedDepthMarket('ind30');
  try {
    const dflt = screenStockSwingCandidates(mDb, asOf, { maxCandidates: 10 });
    assert.equal(dflt.qualified_count, 10, '默认不得按行业前 30% 过滤');
    assert.equal(dflt.candidates.length, 10);
    assert.ok(dflt.candidates.some(c => c.industry === '弱行业'), '行业排名靠后的合格回踩股默认应入围');

    const gated = screenStockSwingCandidates(mDb, asOf, { maxCandidates: 10, requireIndustryTop30: true });
    assert.ok(gated.qualified_count > 0);
    assert.ok(gated.candidates.every(c => c.industry === '强行业'), '显式开启行业过滤后仅前 30% 行业入围');
    assert.ok(!gated.candidates.some(c => c.industry === '弱行业'));
  } finally {
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

  const eastmoney = feeRulesFor({ ...ctx, brokerId: 'eastmoney' }, '159052.SZ', 'ETF');
  assert.equal(eastmoney.fee_model.classification, 'SUPER_ETF', '显式东财 broker 仍套用白名单');
  const eastmoneyZh = feeRulesFor({ ...ctx, brokerId: '东方财富' }, '159052.SZ', 'ETF');
  assert.equal(eastmoneyZh.fee_model.classification, 'SUPER_ETF');
  const otherBroker = feeRulesFor({ ...ctx, brokerId: 'other-broker' }, '159052.SZ', 'ETF');
  assert.equal(otherBroker.fee_model.classification, 'NORMAL_ETF', '显式其他 broker 不得套用东财白名单');
  assert.equal(otherBroker.commission_rate, 0.00025);
  assert.equal(otherBroker.commission_min_cents, 500);
});

function seedDepthMarket(name) {
  const days = weekdays('20260401', 145);
  const asOf = days.at(-1);
  const db = openAshareDb(join(dir, `${name}-market.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));

  // 两个行业各 25 只（≥5 才有行业排名）：强行业缓慢上行、弱行业阴跌，
  // 让弱行业的 5 只 BP1 回踩股成为“行业排名不在前 30%”的对照组。
  const stocks = [
    ...Array.from({ length: 40 }, (_, i) => ({
      code: `603${String(i).padStart(3, '0')}.SH`,
      name: `背景${i}`,
      industry: i < 20 ? '强行业' : '弱行业',
      drift: i < 20 ? 0.0025 : -0.002,
      probe: null,
    })),
    ...Array.from({ length: 10 }, (_, k) => ({
      code: `605${String(k).padStart(3, '0')}.SH`,
      name: `回踩${k}`,
      industry: k < 5 ? '强行业' : '弱行业',
      drift: 0,
      probe: k,
    })),
  ];
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'market', 'exchange', 'list_date', 'list_status'],
    stocks.map(s => ({
      ts_code: s.code, symbol: s.code.slice(0, 6), name: s.name, industry: s.industry,
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
        close = Math.round(10 * Math.pow(1 + s.drift, i) * 100) / 100;
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

test('P1-7 actionEngine scans 10 deep internally but discloses only Top2', () => {
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
    const top10 = screenStockSwingCandidates(mDb, asOf, { maxCandidates: 10 }).candidates;
    assert.equal(out.stock_swing_candidates.length, 2, '对外只披露 policy.stock_max_positions 个候选');
    assert.deepEqual(
      out.stock_swing_candidates.map(c => c.ts_code),
      top10.slice(0, 2).map(c => c.ts_code),
      '披露的必须是 Top2，而不是任意 2 个',
    );
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('P1-7 the position loop falls through to deeper candidates while disclosure stays Top2', () => {
  const { mDb, pDb } = openDbPair('deep-loop');
  try {
    const asOf = '20260911';
    const cand = (code, entry, stop) => ({
      ts_code: code, name: code, industry: '制造业', trade_date: asOf, setup: 'BP1_PULLBACK',
      setup_label_zh: '回踩', close_cny: 10, entry_ref_price_cny: entry / 1000,
      entry_ref_price_milli: entry, max_chase_price_cny: 10.2, hard_stop_price_cny: stop / 1000,
      hard_stop_price_milli: stop, stop_loss_pct: -8, ma20_cny: 10, low_5d_cny: 9.8,
      rps60: 90, rps120: 90, rps_best: 90, industry_rank: 1, industry_total: 1,
      amount20_yi: 2, circ_mv_yi: 100, roe_annualized_pct: 10, eps: 1, ocf_to_profit_pct: 80,
      composite_score: 90, reasons_zh: ['test'], trailing_exit_rule_zh: 'test',
    });
    const screen = {
      candidates: [
        cand('601901.SH', 0, 9200),     // 无效价格 -> 跳过
        cand('601902.SH', 10000, 0),    // 无效止损 -> 跳过
        cand('601903.SH', 10000, 9200), // 第 3 名可买
      ],
    };
    const out = runActionEngine({
      portfolioDb: pDb, marketDb: mDb, accountId: ACC, asOf,
      holdings: [], cashCents: 10_000_000, totalAssetsCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, asOf),
      stockSwingScreen: screen,
    });
    assert.equal(out.stock_swing_candidates.length, 2, '外部披露仍只给 Top2');
    assert.deepEqual(out.stock_swing_candidates.map(c => c.ts_code), ['601901.SH', '601902.SH']);
    assert.ok(out.actions.some(a => a.code === 'P3-STOCK-SWING-BUY-601903.SH'),
      '仓位循环必须能落到 Top2 之外的深层候选');
  } finally {
    pDb.close();
    mDb.close();
  }
});
