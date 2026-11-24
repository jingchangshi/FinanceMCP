import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  calibrateDeconcentrationPlan,
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

// 标准四批换马计划：锚定价 2000 厘 → 目标保留 9000 份，超额 16000 份拆成 4×4000。
function newAnchorPlan(portfolioDb, {
  anchorPriceMilli,
  anchorTradeDate = DAYS[0],
  initialShares = 25000,
  navCents = 10_000_000,
  targetKeepBps = 1800,
  created_at = DAYS[0],
} = {}) {
  return ensureDeconcentrationPlan(portfolioDb, {
    account_id: 'acc',
    ts_code: CODE,
    initial_shares: initialShares,
    nav_cents: navCents,
    target_keep_bps: targetKeepBps,
    anchor_price_milli: anchorPriceMilli,
    ...(anchorTradeDate === null ? {} : { anchor_trade_date: anchorTradeDate }),
    total_tranches: 4,
    created_at,
  });
}

function evaluateStandard(portfolioDb, marketDb, asOf, closeMilli, { shares = 25000, navCents = 10_000_000 } = {}) {
  return evaluateDeconcentrationPlan({
    portfolioDb,
    marketDb,
    accountId: 'acc',
    asOf,
    currentShares: shares,
    sellableShares: shares,
    currentCloseMilli: closeMilli,
    navCents,
    marketRegime: 'STRUCTURAL',
  });
}

/** 构造缺少 anchor_trade_date 列的历史账户库（旧 schema + 一条 legacy 行）。 */
function makeLegacyPortfolio(name, { anchorMilli = 2000, createdAt = DAYS[0] } = {}) {
  seq += 1;
  const marketPath = join(dir, `${name}-${seq}-market.sqlite`);
  const portfolioPath = join(dir, `${name}-${seq}-portfolio.sqlite`);
  const marketDb = openAshareDb(marketPath);
  const portfolioDb = openPortfolioDb(portfolioPath, { marketPath });
  portfolioDb.exec('PRAGMA journal_mode = DELETE;');
  portfolioDb.exec('ALTER TABLE deconcentration_plan DROP COLUMN anchor_trade_date;');
  portfolioDb.prepare(`
    INSERT INTO deconcentration_plan (
      plan_id, account_id, ts_code, initial_shares, target_keep_bps, anchor_price_milli,
      support_floor_milli, last_exec_price_milli, last_exec_date, plan_mode, tactical_slot_bps,
      tactical_shares, tactical_entry_price_milli, tactical_entry_date, completed_swing_count,
      status, created_at
    ) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,'STANDARD',1000,0,NULL,NULL,0,'ACTIVE',?)
  `).run(`legacy-${name}`, 'acc', CODE, 25000, 1800, anchorMilli, createdAt);
  portfolioDb.close();
  return { marketPath, portfolioPath, marketDb };
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

test('P2-2: 多笔跨除权回补每轮都用 asOf 基准 replay 加权均价（不退回 3.75 元假止盈）', () => {
  const { marketDb, portfolioDb } = makeDbs('multi-fill');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newGrindPlan(portfolioDb);
    // 两笔同 raw 7.500 元：拆股前（factor 1）买 10,000 份，拆股后（factor 2）买 5,000 份。
    seedBuyEvent(portfolioDb, 'acc', { eventId: 'tac-buy-a', occurredOn: DAYS[2], quantity: 10000, priceMilli: 7500 });
    seedBuyEvent(portfolioDb, 'acc', { eventId: 'tac-buy-b', occurredOn: DAYS[5], quantity: 5000, priceMilli: 7500 });

    // 正确加权复权均价 = (10000×7500×1/2 + 5000×7500×2/2) / 15000 = 5000 厘（5.000 元）。
    // 若按首笔日期对原始加权均价一次性折算，会得到 7500×1/2 = 3750 厘（3.750 元）。
    const round1 = evaluate(portfolioDb, marketDb, DAYS[6], 4100);
    assert.equal(round1.tactical_entry_price_cny, 5);
    assert.equal(round1.tactical_take_profit_cny, 5.375);
    assert.equal(round1.recommended_sell_shares, 0, '4.100 元不得按 3.750 元口径误触发止盈');
    persistDeconcentrationUpdates(portfolioDb, round1);
    assert.equal(planRow(portfolioDb).tactical_entry_price_milli, 7500, '落库保存事件日原始加权价');

    const round2 = evaluate(portfolioDb, marketDb, DAYS[6], 4100);
    assert.equal(round2.tactical_entry_price_cny, 5, 'raw 字段未变的第二轮仍必须采用 replay 加权复权均价');
    assert.equal(round2.tactical_take_profit_cny, 5.375);
    assert.equal(round2.recommended_sell_shares, 0, '不得退回 3.750 元口径产生假止盈');

    const takeProfit = evaluate(portfolioDb, marketDb, DAYS[6], 5400);
    assert.equal(takeProfit.active_trigger_reason, 'GRIND_TACTICAL_TAKE_PROFIT');
    assert.equal(takeProfit.recommended_sell_shares, 15000);
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

// ---------------------------------------------------------------- 系统附加护栏 / MA5 公式

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

test('P2-2: 3 个交易日冷却期是系统附加护栏（非 EXP-V3-04 签发条件；2 日不满足，3 日满足）', () => {
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
  assert.equal(two.guards.all_reload_guards_ready, false, '系统附加冷却护栏未满时不得回补');

  const three = computeEtfGrindIndicators({ ...base, tradeDaysSinceLast: 3 });
  assert.equal(three.guards.cooldown_ready, true);
  assert.equal(three.guards.all_reload_guards_ready, true);
});

test('P2-2: 实时仓位 30% 是系统附加护栏（非 EXP-V3-04 签发条件），冷却期按交易日历精确计算', () => {
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
    assert.ok(cooldownOk.recommended_buy_shares >= 100, '系统附加护栏与 EXP-V3-04 条件均满足时应回补');

    // 系统附加仓位护栏：30.55% ≥ 30% 时禁止回补（非 EXP-V3-04 签发条件）。
    const overweight = evalAt(41000);
    assert.equal(overweight.live_weight_pct, 30.55);
    assert.equal(overweight.recommended_buy_shares, 0, '实时仓位 >=30%（系统附加护栏）不得回补');
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

// ---------------------------------------------------------------- 锚定价价格基准日（除权重基准）

test('anchor: 2:1 拆股后按基准日复权一次性换算，只有真实 +8% 反弹才触发，且不回写原始锚定价', () => {
  const { marketDb, portfolioDb } = makeDbs('anchor-split');
  try {
    // 前复权因子 1.0 → 2.0：DAYS[4] 起 2:1 拆股，原始价 2.000 → 1.000。
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newAnchorPlan(portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2000, '新计划原子记录原始锚定价');
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[0], '新计划原子记录价格基准交易日');

    const preSplit = evaluateStandard(portfolioDb, marketDb, DAYS[3], 1900);
    assert.equal(preSplit.reference_price_milli, 2000);
    assert.equal(preSplit.rebound_trigger_milli, 2160);
    assert.equal(preSplit.recommended_sell_shares, 0);
    assert.equal(preSplit.anchor_basis_note_zh, null, '因子完整时无需披露');

    // 拆股后 1.070 元相对拆股前基准 2.000 元仍是下跌，不能触发 +8%。
    const falseRebound = evaluateStandard(portfolioDb, marketDb, DAYS[6], 1070);
    assert.equal(falseRebound.reference_price_milli, 1000, '2000 × adj(基准日 1.0)/adj(asOf 2.0) = 1000');
    assert.equal(falseRebound.rebound_trigger_milli, 1080);
    assert.equal(falseRebound.recommended_sell_shares, 0, '1.070 < 1.080 不得误触发反弹减仓');
    assert.equal(falseRebound.anchor_trade_date, DAYS[0]);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2000, '评估不得把复权价写回数据库');
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[0]);

    const trueRebound = evaluateStandard(portfolioDb, marketDb, DAYS[6], 1080);
    assert.equal(trueRebound.active_trigger_reason, 'REBOUND_8PCT');
    assert.equal(trueRebound.recommended_sell_shares, 4000, '真实反弹 +8% 才卖出第一批');
    assert.match(trueRebound.status_summary_zh, /反弹满 \+8%/);
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('anchor: 现金分红（复权因子 1.02）同样按基准日折算锚定价与 +8% 反弹线', () => {
  const { marketDb, portfolioDb } = makeDbs('anchor-dividend');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0], { factorFrom: 4, factor: 1.02 });
    newAnchorPlan(portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });

    const noTrigger = evaluateStandard(portfolioDb, marketDb, DAYS[6], 2110);
    assert.equal(noTrigger.reference_price_milli, 1961, '2000 / 1.02 四舍五入到整数厘');
    assert.equal(noTrigger.rebound_trigger_milli, 2118);
    assert.equal(noTrigger.recommended_sell_shares, 0, '2.110 < 2.118 不触发');

    const trigger = evaluateStandard(portfolioDb, marketDb, DAYS[6], 2118);
    assert.equal(trigger.active_trigger_reason, 'REBOUND_8PCT');
    assert.equal(trigger.recommended_sell_shares, 4000);
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('anchor: 人工改锚定价必须显式给出有效基准日并原子写入；无关校准原样保留两者', () => {
  const { marketDb, portfolioDb } = makeDbs('anchor-calibrate');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newAnchorPlan(portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });

    const changed = calibrateDeconcentrationPlan(portfolioDb, {
      account_id: 'acc',
      ts_code: CODE,
      anchor_price_milli: 2100,
      anchor_trade_date: DAYS[2],
      reset_triggered: false,
    });
    assert.equal(changed.anchor_price_milli, 2100);
    assert.equal(changed.anchor_trade_date, DAYS[2]);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2100);
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[2], '价格与基准日必须同一条 UPDATE 落库');

    // 无关校准（只改目标底仓比例）不得清空或改写锚定价/基准日。
    const unrelated = calibrateDeconcentrationPlan(portfolioDb, {
      account_id: 'acc',
      ts_code: CODE,
      target_keep_bps: 2000,
      reset_triggered: false,
    });
    assert.equal(unrelated.anchor_price_milli, 2100);
    assert.equal(unrelated.anchor_trade_date, DAYS[2]);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2100);
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[2]);

    // 缺基准日 / 非法基准日必须拒绝，且不得产生半写。
    assert.throws(() => calibrateDeconcentrationPlan(portfolioDb, {
      account_id: 'acc', ts_code: CODE, anchor_price_milli: 2200, reset_triggered: false,
    }), /anchor-trade-date/);
    assert.throws(() => calibrateDeconcentrationPlan(portfolioDb, {
      account_id: 'acc', ts_code: CODE, anchor_price_milli: 2200, anchor_trade_date: '20260231', reset_triggered: false,
    }), /有效的 YYYYMMDD/);
    assert.throws(() => calibrateDeconcentrationPlan(portfolioDb, {
      account_id: 'acc', ts_code: CODE, anchor_price_milli: 2200, anchor_trade_date: '2026-01-05', reset_triggered: false,
    }), /有效的 YYYYMMDD/);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2100);
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[2], '拒绝的校准不得部分落库');
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('anchor: later last-exec 价格优先于锚定价，且不因锚定基准缺失而披露', () => {
  const { marketDb, portfolioDb } = makeDbs('anchor-last-exec');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    // 若用锚定价 2000 → 拆股后 1000；last-exec 1800 → 900，必须取后者。
    newAnchorPlan(portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });
    portfolioDb.prepare('UPDATE deconcentration_plan SET last_exec_price_milli = 1800, last_exec_date = ? WHERE account_id = ?')
      .run(DAYS[2], 'acc');

    const out = evaluateStandard(portfolioDb, marketDb, DAYS[6], 1000);
    assert.equal(out.reference_price_milli, 900, '1800 × adj(执行日 1.0)/adj(asOf 2.0) = 900');
    assert.equal(out.rebound_trigger_milli, 972);
    assert.equal(out.anchor_basis_note_zh, null, '锚定价未被使用时不产生披露');
    assert.equal(out.anchor_trade_date, DAYS[0], '仍原样暴露计划记录的基准日供审计');
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('anchor: legacy NULL 基准日或缺复权因子时保留原始价、输出本地化披露且不阻断报告', () => {
  const legacy = makeDbs('anchor-legacy-null');
  try {
    seedEtfBars(legacy.marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newAnchorPlan(legacy.portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: null });
    assert.equal(planRow(legacy.portfolioDb).anchor_trade_date, null, '未显式给基准日时保持 NULL，不从 created_at 回填');

    const out = evaluateStandard(legacy.portfolioDb, legacy.marketDb, DAYS[6], 1030);
    assert.equal(out.plan_present, true, '不得阻断报告');
    assert.equal(out.reference_price_milli, 2000, '缺基准日时保留原始价');
    assert.equal(out.anchor_trade_date, null);
    assert.match(out.anchor_basis_note_zh, /未记录价格基准日/);
    assert.ok(out.status_summary_zh.includes(out.anchor_basis_note_zh), '本地化披露必须随状态摘要输出');
  } finally {
    legacy.portfolioDb.close();
    legacy.marketDb.close();
  }

  const noAdj = makeDbs('anchor-no-factor');
  try {
    // 只有行情，没有 fund_adj 记录：基准日存在但因子缺失。
    upsertRows(noAdj.marketDb, 'fund_daily', ['ts_code', 'trade_date', 'close'],
      DAYS.map((trade_date, i) => ({ ts_code: CODE, trade_date, close: [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06][i] })));
    newAnchorPlan(noAdj.portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });

    const out = evaluateStandard(noAdj.portfolioDb, noAdj.marketDb, DAYS[6], 2000);
    assert.equal(out.plan_present, true);
    assert.equal(out.reference_price_milli, 2000, '因子缺失时不得臆造换算');
    assert.match(out.anchor_basis_note_zh, /缺少可用复权因子/);
    assert.ok(out.status_summary_zh.includes(out.anchor_basis_note_zh));
  } finally {
    noAdj.portfolioDb.close();
    noAdj.marketDb.close();
  }
});

test('anchor: 同日重跑每轮都从原始锚定价换算，结果幂等且数据库不被改写', () => {
  const { marketDb, portfolioDb } = makeDbs('anchor-rerun');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    newAnchorPlan(portfolioDb, { anchorPriceMilli: 2000, anchorTradeDate: DAYS[0] });

    const first = evaluateStandard(portfolioDb, marketDb, DAYS[6], 1080);
    assert.equal(first.reference_price_milli, 1000);
    assert.equal(first.rebound_trigger_milli, 1080);
    assert.equal(first.active_trigger_reason, 'REBOUND_8PCT');

    persistDeconcentrationUpdates(portfolioDb, first);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2000, '同日写回不得保存复权后的锚定价');
    assert.equal(planRow(portfolioDb).anchor_trade_date, DAYS[0]);

    const second = evaluateStandard(portfolioDb, marketDb, DAYS[6], 1080);
    assert.equal(second.reference_price_milli, 1000, '重复评估不得对已换算价再次缩放');
    assert.equal(second.rebound_trigger_milli, 1080);
    assert.equal(second.recommended_sell_shares, 4000);
    assert.equal(planRow(portfolioDb).anchor_price_milli, 2000);
  } finally {
    portfolioDb.close();
    marketDb.close();
  }
});

test('anchor: 旧库缺列时幂等迁移，legacy 行保持 NULL 且绝不从 created_at 回填', () => {
  const { marketPath, portfolioPath, marketDb } = makeLegacyPortfolio('legacy-migrate');
  try {
    const db1 = openPortfolioDb(portfolioPath, { marketPath });
    try {
      const cols = db1.prepare('PRAGMA table_info(deconcentration_plan)').all();
      assert.equal(cols.filter(c => c.name === 'anchor_trade_date').length, 1, '迁移后恰好一列');
      const row = db1.prepare('SELECT * FROM deconcentration_plan WHERE account_id = ?').get('acc');
      assert.equal(row.anchor_trade_date, null, 'legacy 行不得用 created_at 回填');
      assert.equal(row.created_at, DAYS[0]);
    } finally {
      db1.close();
    }

    const db2 = openPortfolioDb(portfolioPath, { marketPath });
    try {
      const cols = db2.prepare('PRAGMA table_info(deconcentration_plan)').all();
      assert.equal(cols.filter(c => c.name === 'anchor_trade_date').length, 1, '重复打开保持幂等');
      const row = db2.prepare('SELECT * FROM deconcentration_plan WHERE account_id = ?').get('acc');
      assert.equal(row.anchor_trade_date, null);
      assert.equal(row.anchor_price_milli, 2000);
    } finally {
      db2.close();
    }
  } finally {
    marketDb.close();
  }
});

test('anchor: 只读库缺列可正常评估且不写库（持久化安全返回 0）', () => {
  const { marketPath, portfolioPath, marketDb } = makeLegacyPortfolio('legacy-readonly');
  try {
    seedEtfBars(marketDb, [2.0, 2.0, 2.0, 2.0, 1.0, 1.03, 1.06], { factorFrom: 4, factor: 2 });
    const shaBefore = fileSha256(portfolioPath);
    const sizeBefore = statSync(portfolioPath).size;

    const readOnlyDb = openPortfolioDb(portfolioPath, { writable: false, marketPath });
    try {
      const out = evaluateStandard(readOnlyDb, marketDb, DAYS[6], 1030);
      assert.equal(out.plan_present, true, '只读旧库缺列也必须能评估');
      assert.equal(out.reference_price_milli, 2000);
      assert.match(out.anchor_basis_note_zh, /未记录价格基准日/);
      const changed = persistDeconcentrationUpdates(readOnlyDb, out);
      assert.equal(changed, 0, '只读库持久化必须安全返回 0');
    } finally {
      readOnlyDb.close();
    }

    assert.equal(fileSha256(portfolioPath), shaBefore, '只读评估不得改变数据库文件');
    assert.equal(statSync(portfolioPath).size, sizeBefore);
  } finally {
    marketDb.close();
  }
});
