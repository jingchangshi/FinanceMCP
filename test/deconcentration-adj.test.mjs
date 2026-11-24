import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { weekdays } from './ashare-fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ashare-deconc-adj-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const {
  ensureDeconcentrationPlan,
  evaluateDeconcentrationPlan,
  persistDeconcentrationUpdates,
  computeEtfGrindIndicators,
} = await import('../build/portfolio/deconcentrationPlan.js');

after(() => rmSync(dir, { recursive: true, force: true }));

const CODE = '159558.SZ';
const DAYS = ['20260105', '20260106', '20260107', '20260108', '20260109', '20260112', '20260113'];

let seq = 0;
function makeDbs(name) {
  seq += 1;
  const marketPath = join(dir, `${name}-${seq}-market.sqlite`);
  const portfolioPath = join(dir, `${name}-${seq}-portfolio.sqlite`);
  const marketDb = openAshareDb(marketPath);
  const portfolioDb = openPortfolioDb(portfolioPath, { marketPath });
  return { marketDb, portfolioDb };
}

function seedEtfBars(marketDb, closes, { factorFrom = Infinity, factor = 1 } = {}) {
  upsertRows(marketDb, 'fund_daily', ['ts_code', 'trade_date', 'close'],
    DAYS.map((trade_date, i) => ({ ts_code: CODE, trade_date, close: closes[i] })));
  upsertRows(marketDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
    DAYS.map((trade_date, i) => ({ ts_code: CODE, trade_date, adj_factor: i >= factorFrom ? factor : 1 })));
}

function seedBuyEvent(portfolioDb, accountId, { eventId, occurredOn, quantity, priceMilli }) {
  portfolioDb.prepare(`
    INSERT INTO account_event (
      event_id, account_id, event_type, occurred_on, ts_code, quantity, price_milli,
      fee_cents, tax_cents, cash_delta_cents, note, source, recorded_at
    ) VALUES (?,?,?,?,?,?,?,0,0,?, '', 'synthetic', '2026-01-07T00:00:00Z')
  `).run(
    eventId, accountId, 'TRADE_BUY', occurredOn, CODE, quantity, priceMilli,
    -Math.round((quantity * priceMilli) / 10),
  );
}

function newGrindPlan(portfolioDb) {
  ensureDeconcentrationPlan(portfolioDb, {
    account_id: 'acc',
    ts_code: CODE,
    initial_shares: 25000,
    nav_cents: 10_000_000,
    target_keep_bps: 2500,
    plan_mode: 'BOTTOM_GRIND_25',
    tactical_slot_bps: 1000,
    anchor_price_milli: 1000,
    support_floor_milli: 780,
    total_tranches: 4,
    created_at: DAYS[0],
  });
}

function evaluate(portfolioDb, marketDb, asOf, closeMilli, shares = 35000) {
  return evaluateDeconcentrationPlan({
    portfolioDb,
    marketDb,
    accountId: 'acc',
    asOf,
    currentShares: shares,
    sellableShares: shares,
    currentCloseMilli: closeMilli,
    navCents: 10_000_000,
    marketRegime: 'STRUCTURAL',
  });
}

function planRow(portfolioDb) {
  return portfolioDb.prepare('SELECT * FROM deconcentration_plan WHERE account_id = ?').get('acc');
}

test('P2-2: 战术买入后拆股，重放时按 asOf 复权基准折算，不误触发止盈且可跨次评估幂等', () => {
  const { marketDb, portfolioDb } = makeDbs('split');
  try {
    // 前复权因子 1.0 → 2.0：D4 起发生 2:1 拆股，原始价 2.000 → 1.000。
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newGrindPlan(portfolioDb);
    seedBuyEvent(portfolioDb, 'acc', { eventId: 'tac-buy', occurredOn: DAYS[2], quantity: 10000, priceMilli: 2000 });

    const before = evaluate(portfolioDb, marketDb, DAYS[3], 1900);
    assert.equal(before.tactical_shares, 10000);
    assert.equal(before.tactical_entry_price_cny, 2, '拆股前应按原始价记录');
    assert.equal(before.recommended_sell_shares, 0);
    persistDeconcentrationUpdates(portfolioDb, before);
    assert.equal(planRow(portfolioDb).tactical_entry_price_milli, 2000, '数据库保存事件日原始价');

    const afterSplit = evaluate(portfolioDb, marketDb, DAYS[6], 1030);
    assert.equal(afterSplit.tactical_entry_price_cny, 1, '2000 × adj(买入日)/adj(asOf) = 2000 × 1/2');
    assert.equal(afterSplit.tactical_take_profit_cny, 1.075);
    assert.equal(afterSplit.recommended_sell_shares, 0, '折后 +3% 不应被当成 +7.5% 止盈');
    persistDeconcentrationUpdates(portfolioDb, afterSplit);
    assert.equal(planRow(portfolioDb).tactical_entry_price_milli, 2000, '回写仍是原始价，不能把复权价存回数据库');

    const again = evaluate(portfolioDb, marketDb, DAYS[6], 1030);
    assert.equal(again.tactical_entry_price_cny, 1, '重复评估不得对已折算价再次折算');
    assert.equal(again.recommended_sell_shares, 0);

    const takeProfit = evaluate(portfolioDb, marketDb, DAYS[6], 1080);
    assert.equal(takeProfit.active_trigger_reason, 'GRIND_TACTICAL_TAKE_PROFIT');
    assert.equal(takeProfit.recommended_sell_shares, 10000, '复权后 1.080 >= 1.075 应正确止盈');
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('P2-2: 现金分红（复权因子 1.02）同样折算战术入场价', () => {
  const { marketDb, portfolioDb } = makeDbs('dividend');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0], { factorFrom: 4, factor: 1.02 });
    newGrindPlan(portfolioDb);
    seedBuyEvent(portfolioDb, 'acc', { eventId: 'tac-buy-div', occurredOn: DAYS[2], quantity: 10000, priceMilli: 2000 });

    const noTp = evaluate(portfolioDb, marketDb, DAYS[6], 2090);
    assert.equal(noTp.tactical_entry_price_cny, 1.961, '2000 / 1.02 四舍五入到整数厘');
    assert.equal(noTp.tactical_take_profit_cny, 2.108);
    assert.equal(noTp.recommended_sell_shares, 0, '2.090 < 2.108 不触发止盈');

    const tp = evaluate(portfolioDb, marketDb, DAYS[6], 2110);
    assert.equal(tp.active_trigger_reason, 'GRIND_TACTICAL_TAKE_PROFIT');
    assert.equal(tp.recommended_sell_shares, 10000);
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('P2-2: 历史 last_exec 价格按 asOf 复权基准折算，驱动 +8% 反弹线与折价目标', () => {
  const { marketDb, portfolioDb } = makeDbs('last-exec');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newGrindPlan(portfolioDb);
    portfolioDb.prepare('UPDATE deconcentration_plan SET last_exec_price_milli = 2000, last_exec_date = ? WHERE account_id = ?')
      .run(DAYS[2], 'acc');

    const preSplit = evaluate(portfolioDb, marketDb, DAYS[3], 1900);
    assert.equal(preSplit.reference_price_milli, 2000);
    assert.equal(preSplit.rebound_trigger_milli, 2160);

    const postSplit = evaluate(portfolioDb, marketDb, DAYS[6], 1060);
    assert.equal(postSplit.reference_price_milli, 1000, '2.000 元的卖出参考价折算到拆股后 = 1.000 元');
    assert.equal(postSplit.rebound_trigger_milli, 1080, '+8% 反弹线必须建立在复权后的参考价上');
    assert.equal(postSplit.grind_guards.reload_target_milli, 930, '折价 7% 回补目标同样使用复权价');
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('P2-2: 缺少 adj_factor 时保持旧行为（原始价，不臆造因子）', () => {
  const { marketDb, portfolioDb } = makeDbs('no-adj');
  try {
    // 只有行情，没有 fund_adj 记录。
    upsertRows(marketDb, 'fund_daily', ['ts_code', 'trade_date', 'close'],
      DAYS.map((trade_date, i) => ({ ts_code: CODE, trade_date, close: [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06][i] })));
    newGrindPlan(portfolioDb);
    seedBuyEvent(portfolioDb, 'acc', { eventId: 'tac-buy-no-adj', occurredOn: DAYS[2], quantity: 10000, priceMilli: 2000 });
    portfolioDb.prepare('UPDATE deconcentration_plan SET last_exec_price_milli = 2000, last_exec_date = ? WHERE account_id = ?')
      .run(DAYS[2], 'acc');

    const out = evaluate(portfolioDb, marketDb, DAYS[6], 1080);
    assert.equal(out.tactical_entry_price_cny, 2, '无复权因子时不得改写入场价');
    assert.equal(out.tactical_take_profit_cny, 2.15);
    assert.equal(out.recommended_sell_shares, 0);
    assert.equal(out.reference_price_milli, 2000);
    assert.equal(out.rebound_trigger_milli, 2160);
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

// ---------------------------------------------------------------- 冷却期 / 仓位护栏 / MA5 公式

function grindSeries(n = 80) {
  const endIdx = n - 1;
  const closes = [];
  for (let i = 0; i < n; i += 1) {
    if (i < endIdx - 50) closes.push(0.65);
    else if (i < endIdx - 12) closes.push(0.92);
    else if (i < endIdx - 3) closes.push(0.80);
    else if (i === endIdx - 3) closes.push(0.740);
    else if (i === endIdx - 2) closes.push(0.710);
    else if (i === endIdx - 1) closes.push(0.705);
    else closes.push(0.745);
  }
  return closes;
}

test('P2-2: 3 个交易日冷却期是回补的硬护栏（2 日不满足，3 日满足）', () => {
  const days = weekdays('20260105', 80);
  const qfq = { dates: days, closes: grindSeries(80) };
  const base = {
    qfq,
    asOf: days.at(-1),
    currentCloseMilli: 745,
    supportFloorMilli: 780,
    lastExecPriceMilli: 900,
    lastExecDate: days[70],
    marketRegime: 'STRUCTURAL',
  };
  const two = computeEtfGrindIndicators({ ...base, tradeDaysSinceLast: 2 });
  assert.equal(two.guards.ma60_flat_ready, true);
  assert.equal(two.guards.discount_ready, true);
  assert.equal(two.guards.oversold_3d_ready, true);
  assert.equal(two.guards.right_side_turn_ready, true);
  assert.equal(two.guards.cooldown_ready, false);
  assert.equal(two.guards.all_reload_guards_ready, false, '冷却期未满时不得回补');

  const three = computeEtfGrindIndicators({ ...base, tradeDaysSinceLast: 3 });
  assert.equal(three.guards.cooldown_ready, true);
  assert.equal(three.guards.all_reload_guards_ready, true);
});

test('P2-2: 实时仓位 30% 是回补的硬上限，冷却期按交易日历精确计算', () => {
  const { marketDb, portfolioDb } = makeDbs('gates');
  try {
    const days = weekdays('20260105', 80);
    const closes = grindSeries(80);
    upsertRows(marketDb, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
      days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));
    upsertRows(marketDb, 'fund_daily', ['ts_code', 'trade_date', 'close'],
      days.map((trade_date, i) => ({ ts_code: CODE, trade_date, close: closes[i] })));
    upsertRows(marketDb, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: CODE, trade_date, adj_factor: 1 })));

    ensureDeconcentrationPlan(portfolioDb, {
      account_id: 'acc',
      ts_code: CODE,
      initial_shares: 25000,
      nav_cents: 10_000_000,
      target_keep_bps: 2500,
      plan_mode: 'BOTTOM_GRIND_25',
      tactical_slot_bps: 1000,
      anchor_price_milli: 1000,
      support_floor_milli: 780,
      total_tranches: 4,
      created_at: days[0],
    });
    const setLastExec = (date) => portfolioDb.prepare(
      'UPDATE deconcentration_plan SET last_exec_price_milli = 900, last_exec_date = ? WHERE account_id = ?',
    ).run(date, 'acc');
    const evalAt = (shares) => evaluateDeconcentrationPlan({
      portfolioDb,
      marketDb,
      accountId: 'acc',
      asOf: days.at(-1),
      currentShares: shares,
      sellableShares: shares,
      currentCloseMilli: 745,
      navCents: 10_000_000,
      marketRegime: 'STRUCTURAL',
    });

    // 冷却期边界：倒数第 2 个交易日执行 → 仅 2 个交易日，不满足 3 日冷却。
    setLastExec(days.at(-3));
    const cooldownBlocked = evalAt(25000);
    assert.equal(cooldownBlocked.trade_days_since_last, 2);
    assert.equal(cooldownBlocked.grind_guards?.cooldown_ready, false);
    assert.equal(cooldownBlocked.recommended_buy_shares, 0);

    setLastExec(days.at(-4));
    const cooldownOk = evalAt(25000);
    assert.equal(cooldownOk.trade_days_since_last, 3);
    assert.equal(cooldownOk.grind_guards?.cooldown_ready, true);
    assert.ok(cooldownOk.recommended_buy_shares >= 100, '冷却期与其余护栏均满足时应回补');

    // 仓位护栏：30.55% ≥ 30% 时禁止回补。
    const overweight = evalAt(41000);
    assert.equal(overweight.live_weight_pct, 30.55);
    assert.equal(overweight.recommended_buy_shares, 0, '实时仓位 >=30% 不得回补');
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('P2-2: 右侧止稳按实际公式 c > prevClose 且 c >= MA5×0.995（非严格站上 MA5）', () => {
  const dates = ['20260112', '20260113', '20260114', '20260115', '20260116'];
  const qfq = { dates, closes: [0.752, 0.752, 0.752, 0.752, 0.730] };
  const base = {
    qfq,
    asOf: '20260119',
    supportFloorMilli: null,
    lastExecPriceMilli: null,
    lastExecDate: null,
    tradeDaysSinceLast: 10,
    marketRegime: 'STRUCTURAL',
  };
  // MA5 = 0.7476；收盘 0.745 低于 MA5 但高于 MA5×0.995 = 0.74386，且收阳 → 视为右侧止稳。
  const near = computeEtfGrindIndicators({ ...base, currentCloseMilli: 745 });
  assert.equal(near.guards.ma5_cny, 0.748);
  assert.equal(near.guards.right_side_turn_ready, true);
  // 收盘 0.742 已跌破 0.995 容差 → 不满足。
  const below = computeEtfGrindIndicators({ ...base, currentCloseMilli: 742 });
  assert.equal(below.guards.right_side_turn_ready, false);
});
