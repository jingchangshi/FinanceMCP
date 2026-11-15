import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-phase1-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { resolveFundNavPremium } = await import('../build/ashare/etf.js');
const { screenEtfCandidates } = await import('../build/ashare/etfUniverse.js');
const { EASTMONEY_SUPER_ETF_CODES } = await import('../build/ashare/etfDeclarations.js');
const { evaluateMarketRegime } = await import('../build/ashare/marketRegime.js');
const { isEtfCode, initBaseline, confirmRealAccount, setAccountCompleteness } = await import('../build/portfolio/ledger.js');
const { importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { calculateFees, resolveFeeRules, saveFeeProfile } = await import('../build/portfolio/fees.js');
const {
  splitSharesIntoTranches,
  ensureDeconcentrationPlan,
  evaluateDeconcentrationPlan,
  persistDeconcentrationUpdates,
} = await import('../build/portfolio/deconcentrationPlan.js');
const {
  sizeStockSwingOrder,
  runActionEngine,
  syncAccountV3State,
} = await import('../build/portfolio/actionEngine.js');
const { persistRiskAnchor, evaluateStrategyRouter } = await import('../build/portfolio/strategyRouter.js');
const { buildDailyReport } = await import('../build/portfolio/dailyReport.js');
const { renderDailyReport } = await import('../build/portfolio/reportRenderer.js');
const { weekdays } = await import('./ashare-fixture.mjs');

const ev = (level, source = 'Eastmoney V3 test') => ({ level, source });

function setupMarketDb(name, days, priceOverrides = {}) {
  const path = join(dir, `${name}-market.sqlite`);
  const db = openAshareDb(path);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    days.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: days[i - 1] ?? null })));

  const codes = [
    { ts_code: '159558.SZ', name: '半导体设备ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '半导体设备', base: 0.819 },
    { ts_code: '159241.SZ', name: '航空航天ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '航空航天', base: 1.0 },
    { ts_code: '159278.SZ', name: '机器人ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '机器人', base: 1.0 },
    { ts_code: '513100.SH', name: '纳指ETF', fund_type: '股票型', invest_type: '国际(QDII)', benchmark: '纳斯达克100', base: 1.5 },
    { ts_code: '513500.SH', name: '标普500ETF', fund_type: '股票型', invest_type: '国际(QDII)', benchmark: '标普500', base: 1.5 },
    { ts_code: '513050.SH', name: '中概互联网ETF', fund_type: '股票型', invest_type: '国际(QDII)', benchmark: '中国互联网50', base: 1.2 },
    { ts_code: '159920.SZ', name: '恒生ETF', fund_type: '股票型', invest_type: '国际(QDII)', benchmark: '恒生指数', base: 1.3 },
    { ts_code: '510300.SH', name: '沪深300ETF', fund_type: '股票型', invest_type: '被动指数型', benchmark: '沪深300', base: 4.0 },
    { ts_code: '511010.SH', name: '国债ETF', fund_type: '债券型', invest_type: '被动指数型', benchmark: '国债', base: 100.0 },
  ];

  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    codes.map(c => ({ ts_code: c.ts_code, name: c.name, fund_type: c.fund_type, invest_type: c.invest_type, benchmark: c.benchmark, status: 'L', market: 'E' })));

  for (const c of codes) {
    const customSeries = priceOverrides[c.ts_code];
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map((trade_date, i) => {
        const close = typeof customSeries === 'function' ? customSeries(i, trade_date, c.base) : c.base;
        const prev = i > 0 && typeof customSeries === 'function' ? customSeries(i - 1, days[i - 1], c.base) : close;
        return {
          ts_code: c.ts_code,
          trade_date,
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          pre_close: prev,
          pct_chg: prev > 0 ? ((close / prev) - 1) * 100 : 0,
          vol: 1_000_000,
          amount: 100_000, // 100,000 千元 = 1亿元
        };
      }));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: c.ts_code, trade_date, adj_factor: 1 })));
    upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share'],
      days.map(trade_date => ({ ts_code: c.ts_code, trade_date, fd_share: 100_000 })));
  }

  return { db, path };
}

function seedStocks(db, days, stockDefs) {
  upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'industry', 'market', 'exchange', 'list_date', 'list_status'],
    stockDefs.map(s => ({
      ts_code: s.ts_code,
      symbol: s.ts_code.slice(0, 6),
      name: s.name,
      industry: '制造业',
      market: '主板',
      exchange: s.ts_code.endsWith('.SH') ? 'SSE' : 'SZSE',
      list_date: '20180101',
      list_status: 'L',
    })));
  for (const s of stockDefs) {
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map((trade_date, i) => {
        const close = s.series(i, trade_date);
        const prev = i > 0 ? s.series(i - 1, days[i - 1]) : close;
        return {
          ts_code: s.ts_code,
          trade_date,
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          pre_close: prev,
          pct_chg: prev > 0 ? ((close / prev) - 1) * 100 : 0,
          vol: 500_000,
          amount: 100_000,
        };
      }));
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      days.map(trade_date => ({ ts_code: s.ts_code, trade_date, adj_factor: 1 })));
  }
  upsertRows(db, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'],
    days.map(trade_date => ({
      dataset: 'suspend_d',
      key: trade_date,
      rows: 0,
      status: 'ok',
      message: 'synthetic',
      synced_at: '2026-11-15T00:00:00Z',
    })));
}

function seedIndexAndReports(db, days, {
  valueSeries,
  csi500Series,
  chinextSeries,
  amountRatioByDate = {},
  limitDownByDate = {},
}) {
  const pushIndex = (tsCode, fn) => {
    upsertRows(db, 'index_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
      days.map((trade_date, i) => {
        const close = fn(i, trade_date);
        const prev = i > 0 ? fn(i - 1, days[i - 1]) : close;
        return {
          ts_code: tsCode,
          trade_date,
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          pre_close: prev,
          pct_chg: prev > 0 ? ((close / prev) - 1) * 100 : 0,
          vol: 1_000_000,
          amount: 1_000_000,
        };
      }));
  };
  pushIndex('000300.SH', valueSeries);
  pushIndex('000905.SH', csi500Series);
  pushIndex('399006.SZ', chinextSeries);

  mkdirSync(join(dir, 'reports'), { recursive: true });
  const stmt = db.prepare('INSERT OR REPLACE INTO report(report_id, trade_date, status, generated_at, path, run_mode) VALUES(?,?,?,?,?,?)');
  for (const d of days.slice(-10)) {
    const ratio = amountRatioByDate[d] ?? 1.0;
    const limitDown = limitDownByDate[d] ?? 5;
    const relPath = `reports/mr-${d}-${Math.random().toString(36).slice(2, 7)}.json`;
    writeFileSync(join(dir, relPath), JSON.stringify({
      report_id: `MR-${d}`,
      as_of_trade_date: d,
      status: 'READY',
      market: {
        regime: 'range',
        breadth: {
          amount_yi: 10000 * ratio,
          amount_ma20_yi: 10000,
          up: 2500,
          down: 2200,
          limit_down: limitDown,
        },
      },
    }));
    stmt.run(`MR-${d}-${relPath}`, d, 'READY', '2026-11-15T00:00:00Z', relPath, 'manual');
  }
}

test('V3-1 跨境 ETF 净值折溢价与滞后拦截 + 取消持仓免检特权', () => {
  const days = weekdays('20260803', 65);
  const asOf = days.at(-1);
  const { db } = setupMarketDb('xb', days);
  try {
    // 非跨境正常填充
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'],
      days.map(d => ({ ts_code: '159241.SZ', ann_date: d, nav_date: d, unit_nav: 1.0, accum_nav: 1.0, adj_nav: 1.0 })));
    // 513100.SH: close=1.50, unit_nav=1.456 -> +302 bps > 250 bps -> 禁买
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'], [
      { ts_code: '513100.SH', ann_date: asOf, nav_date: asOf, unit_nav: 1.456, accum_nav: 1.456, adj_nav: 1.456 },
    ]);
    // 513500.SH: unit_nav 滞后 5 个交易日 (> 3) -> nav_stale 禁买
    const staleDate = days.at(-6);
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'], [
      { ts_code: '513500.SH', ann_date: staleDate, nav_date: staleDate, unit_nav: 1.5, accum_nav: 1.5, adj_nav: 1.5 },
    ]);
    // 513050.SH: 无 fund_nav 记录 -> nav_stale 禁买
    // 159920.SZ: close=1.30, unit_nav=1.275 -> +196 bps <= 250 bps, 滞后 1 个交易日 -> 允许通过
    const okDate = days.at(-2);
    upsertRows(db, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'], [
      { ts_code: '159920.SZ', ann_date: okDate, nav_date: okDate, unit_nav: 1.275, accum_nav: 1.275, adj_nav: 1.275 },
    ]);

    const pHigh = resolveFundNavPremium(db, '513100.SH', 1.5, asOf, 'cross_border');
    assert.equal(pHigh.buy_blocked, true);
    assert.equal(pHigh.block_reason, 'cross_border_premium_above_250bps');
    assert.ok(pHigh.premium_bps > 250);

    const pStale = resolveFundNavPremium(db, '513500.SH', 1.5, asOf, 'cross_border');
    assert.equal(pStale.buy_blocked, true);
    assert.equal(pStale.nav_stale, true);
    assert.equal(pStale.block_reason, 'cross_border_nav_stale');

    const pMissing = resolveFundNavPremium(db, '513050.SH', 1.2, asOf, 'cross_border');
    assert.equal(pMissing.buy_blocked, true);
    assert.equal(pMissing.block_reason, 'cross_border_nav_stale');

    const pOk = resolveFundNavPremium(db, '159920.SZ', 1.3, asOf, 'cross_border');
    assert.equal(pOk.buy_blocked, false);
    assert.equal(pOk.block_reason, null);
    assert.ok(pOk.premium_bps <= 250);

    // 取消持仓免检特权：即使 513100.SH 在 heldCodes 里，溢价 > 250bps 时 included 必须为 false
    const screen = screenEtfCandidates(db, { asOf, heldCodes: ['513100.SH', '159920.SZ'], limit: 80 });
    assert.equal(screen.universe_version, 'v3-etf-candidates-2.0.0');
    const heldBlocked = screen.candidates.find(c => c.ts_code === '513100.SH');
    assert.equal(heldBlocked.held, true);
    assert.equal(heldBlocked.included, false);
    assert.equal(heldBlocked.score, null);
    assert.equal(heldBlocked.filters.premium_discount.buy_blocked, true);
    assert.ok(heldBlocked.exclusions.some(e => e.reason === 'cross_border_premium_above_250bps'));

    const allowedXb = screen.candidates.find(c => c.ts_code === '159920.SZ');
    assert.equal(allowedXb.included, true);
    assert.equal(allowedXb.filters.premium_discount.buy_blocked, false);
  } finally {
    db.close();
  }
});

test('V3-2 ETF 识别(含530050)、33只超级ETF白名单与东财三类实测费率计算', () => {
  assert.equal(EASTMONEY_SUPER_ETF_CODES.length, 33);
  assert.equal(new Set(EASTMONEY_SUPER_ETF_CODES).size, 33);
  assert.equal(isEtfCode('530050.SH'), true);
  assert.equal(isEtfCode('589850.SH'), true);
  assert.equal(isEtfCode('159558.SZ'), true);
  assert.equal(isEtfCode('600519.SH'), false);

  const pDb = openPortfolioDb(join(dir, 'fees-portfolio.sqlite'));
  try {
    saveFeeProfile(pDb, 'acc', {
      id: 'normal-etf',
      classification: 'NORMAL_ETF',
      effective_from: '20261111',
      values: { commission_rate: 0.00025, commission_min_cents: 500 },
      evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') },
    });
    saveFeeProfile(pDb, 'acc', {
      id: 'stock-rule',
      classification: 'STOCK',
      effective_from: '20261111',
      values: { commission_rate: 0.00025, commission_min_cents: 500 },
      evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') },
    });
    saveFeeProfile(pDb, 'acc', {
      id: 'super-159241',
      code: '159241.SZ',
      classification: 'SUPER_ETF',
      minimum_billing_unit: 'NONE',
      effective_from: '20261111',
      values: { commission_rate: 0.00005, commission_min_cents: 0 },
      evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') },
    });
    saveFeeProfile(pDb, 'acc', {
      id: 'override-159558',
      code: '159558.SZ',
      classification: 'NORMAL_ETF',
      minimum_billing_unit: 'NONE',
      effective_from: '20261111',
      values: { commission_rate: 0.00025, commission_min_cents: 500 },
      evidence: { commission_rate: ev('CONFIRMED'), commission_min_cents: ev('CONFIRMED') },
    });

    const superRules = resolveFeeRules({ db: pDb, accountId: 'acc', asOf: '20261113', code: '159241.SZ', kind: 'ETF' });
    const superFee = calculateFees(100_000, 'buy', superRules); // 1000元 * 万0.5 = 0.05元 = 5分
    assert.equal(superFee.commission_cents, 5);
    assert.equal(superRules.fee_model.minimum_billing_unit, 'NONE');

    const normalRules = resolveFeeRules({ db: pDb, accountId: 'acc', asOf: '20261113', code: '159558.SZ', kind: 'ETF' });
    const normalFee = calculateFees(100_000, 'buy', normalRules); // 1000元，不足5元按500分计
    assert.equal(normalFee.commission_cents, 500);

    const stockRules = resolveFeeRules({ db: pDb, accountId: 'acc', asOf: '20261113', code: '600519.SH', kind: 'STOCK' });
    const stockSellFee = calculateFees(1_000_000, 'sell', stockRules); // 1万元卖出：佣金500 + 印花税500 + 过户费10
    assert.equal(stockSellFee.commission_cents, 500);
    assert.equal(stockSellFee.stamp_duty_cents, 500);
    assert.equal(stockSellFee.transfer_fee_cents, 10);
  } finally {
    pDb.close();
  }
});

test('V3-3 marketRegime 双锚三档、两日滞回确认、极端暴跌当日直切与 20 日风格判别', () => {
  const days = weekdays('20260701', 85);
  const asOf = days.at(-1);
  const prevDay = days.at(-2);

  // A: 全面进攻 + 成长占优 (近20日成长涨幅显著高于价值 > +3%) + 倒数第1天广度单日下跌（触发滞回防抖，维持 OFFENSIVE）
  const { db: dbOff } = setupMarketDb('mr-off', days);
  try {
    seedIndexAndReports(dbOff, days, {
      valueSeries: (i) => 3500 + i * 5,
      csi500Series: (i) => 5000 + i * 35,
      chinextSeries: (i) => 2000 + i * 18,
    });
    const pctMap = Object.fromEntries(days.map(d => [d, 0.65]));
    const rPrev = evaluateMarketRegime(dbOff, prevDay, { hysteresisLookbackDays: 6, pctAboveMa60ByDate: pctMap });
    assert.equal(rPrev.regime, 'OFFENSIVE');
    assert.equal(rPrev.target_equity_bps, 8500);
    assert.equal(rPrev.style, 'GROWTH_LEADING');
    assert.ok(rPrev.style_spread_20d_pct > 3);

    const pctDropOnce = { ...pctMap, [asOf]: 0.38 };
    const rHeld = evaluateMarketRegime(dbOff, asOf, { hysteresisLookbackDays: 6, pctAboveMa60ByDate: pctDropOnce });
    assert.equal(rHeld.raw_regime, 'STRUCTURAL');
    assert.equal(rHeld.hysteresis_held, true);
    assert.equal(rHeld.regime, 'OFFENSIVE');
  } finally {
    dbOff.close();
  }

  // B: 价值占优风格 + 极端暴跌当日直接切换 DEFENSIVE（跳过两日滞回）
  const { db: dbCrash } = setupMarketDb('mr-crash', days);
  try {
    seedIndexAndReports(dbCrash, days, {
      valueSeries: (i) => (i === days.length - 1 ? (3000 + (i - 1) * 25) * 0.955 : 3000 + i * 25),
      csi500Series: (i) => (i === days.length - 1 ? (5000 + (i - 1) * 5) * 0.95 : 5000 + i * 5),
      chinextSeries: (i) => (i === days.length - 1 ? (2000 + (i - 1) * 2) * 0.95 : 2000 + i * 2),
      limitDownByDate: { [asOf]: 120 },
    });
    const pctMap = Object.fromEntries(days.map(d => [d, 0.60]));
    const rValueLead = evaluateMarketRegime(dbCrash, prevDay, { hysteresisLookbackDays: 6, pctAboveMa60ByDate: pctMap });
    assert.equal(rValueLead.regime, 'OFFENSIVE');
    assert.equal(rValueLead.style, 'VALUE_LEADING');
    assert.ok(rValueLead.style_spread_20d_pct < -3);

    const rCrash = evaluateMarketRegime(dbCrash, asOf, { hysteresisLookbackDays: 6, pctAboveMa60ByDate: pctMap });
    assert.equal(rCrash.crash_override, true);
    assert.equal(rCrash.regime, 'DEFENSIVE');
    assert.equal(rCrash.target_equity_bps, 1500);
  } finally {
    dbCrash.close();
  }
});

test('V3-4 159558.SZ 四批换马状态机：拆分、规则 A/B/C 与 EXECUTED 对账闭环', () => {
  assert.deepEqual(splitSharesIntoTranches(43900, 4), [11000, 11000, 11000, 10900]);

  const days = weekdays('20260701', 90);
  const novFirstIdx = days.findIndex(d => d.startsWith('202611'));
  const createdDay = days[novFirstIdx - 20];
  const dayAfter10 = days[novFirstIdx - 10];
  const dayAfterExec = days[novFirstIdx - 8];
  const dayFirstOfNov = days[novFirstIdx];
  const breakdownDay = days[novFirstIdx - 1];

  const { db: mDb } = setupMarketDb('dec-m', days, {
    '159558.SZ': (i) => {
      if (i < novFirstIdx - 10) return 0.819;
      if (i === novFirstIdx - 10) return 0.890; // +8.67% vs 0.819 -> Rule B (REBOUND_8PCT)
      if (i < novFirstIdx - 2) return 0.850;
      if (i === novFirstIdx - 2) return 0.780; // below MA60 (~0.83)
      if (i === novFirstIdx - 1) return 0.760; // 连续两日跌破 MA60 且当日跌幅 -2.56% < -1.5% -> Rule C
      return 0.850; // novFirst: +3.78% < +8% -> tests Rule A on independent account
    },
  });
  const pDb = openPortfolioDb(join(dir, 'dec-portfolio.sqlite'));
  try {
    const res = ensureDeconcentrationPlan(pDb, {
      account_id: 'acc-dec',
      ts_code: '159558.SZ',
      initial_shares: 58900,
      nav_cents: 6_860_690,
      target_keep_bps: 1791,
      anchor_price_milli: 819,
      total_tranches: 4,
      created_at: createdDay,
    });
    assert.equal(res.created, true);
    assert.equal(res.plan.status, 'ACTIVE');
    assert.deepEqual(res.tranches.map(t => t.planned_shares), [11000, 11000, 11000, 10900]);

    // Rule B: 未满20交易日，但较 0.819 反弹 +8.67% >= +8%
    const evB = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-dec',
      asOf: dayAfter10,
      currentShares: 58900,
      sellableShares: 58900,
      currentCloseMilli: 890,
      navCents: 7_000_000,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(evB.tranches.find(t => t.tranche_no === 1)?.status, 'TRIGGERED');
    assert.equal(evB.recommended_sell_shares, 11000);
    assert.equal(evB.active_trigger_reason, 'REBOUND_8PCT');
    persistDeconcentrationUpdates(pDb, evB);

    // 模拟真实减仓 11000 股 -> 第 1 批变为 EXECUTED
    const evExec = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-dec',
      asOf: dayAfterExec,
      currentShares: 47900,
      sellableShares: 47900,
      currentCloseMilli: 850,
      navCents: 7_000_000,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(evExec.tranches[0].status, 'EXECUTED');
    persistDeconcentrationUpdates(pDb, evExec);

    // Rule C: 空头防守档连续两日跌破 MA60 且当日跌幅 < -1.5%（触发剩余 3 批的一半向上取整=2批=22000股）
    const evC = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-dec',
      asOf: breakdownDay,
      currentShares: 47900,
      sellableShares: 47900,
      currentCloseMilli: 760,
      navCents: 6_500_000,
      marketRegime: 'DEFENSIVE',
    });
    assert.equal(evC.tranches.find(t => t.tranche_no === 2)?.status, 'TRIGGERED');
    assert.equal(evC.tranches.find(t => t.tranche_no === 3)?.status, 'TRIGGERED');
    assert.equal(evC.recommended_sell_shares, 22000);
    assert.equal(evC.active_trigger_reason, 'BREAKDOWN_MA60');

    // 另外独立账户测试 Rule A（月初首个交易日且距立项满 >=12 个交易日）
    ensureDeconcentrationPlan(pDb, {
      account_id: 'acc-dec-a',
      ts_code: '159558.SZ',
      initial_shares: 58900,
      nav_cents: 6_860_690,
      target_keep_bps: 1791,
      anchor_price_milli: 819,
      total_tranches: 4,
      created_at: createdDay,
    });
    const evA = evaluateDeconcentrationPlan({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-dec-a',
      asOf: dayFirstOfNov,
      currentShares: 58900,
      sellableShares: 58900,
      currentCloseMilli: 850, // +3.78% < +8%
      navCents: 6_860_690,
      marketRegime: 'STRUCTURAL',
    });
    assert.equal(evA.tranches.find(t => t.tranche_no === 1)?.status, 'TRIGGERED');
    assert.equal(evA.recommended_sell_shares, 11000);
    assert.equal(evA.active_trigger_reason, 'MONTHLY_SCHEDULE');
  } finally {
    pDb.close();
    mDb.close();
  }
});

test('V3-5 actionEngine：P0 15%熔断、P1 -8%硬止损与+15%保本转MA20、个股仓位器、及铁律2滞后不阻断日报', () => {
  // 1) 个股仓位器：100股整数手、单笔风险 <= 1.3% 总资产、单票上限 <= 18% 总资产
  const sized = sizeStockSwingOrder({
    navCents: 10_000_000, // 10 万元
    entryPriceMilli: 10_000, // 10 元
    hardStopPriceMilli: 9_200, // -8% -> 每股风险 0.80 元
    availableCashCents: 5_000_000,
  });
  assert.equal(sized.shares % 100, 0);
  assert.ok(sized.shares > 0);
  assert.ok(sized.risk_at_stop_cents <= 150_000);
  assert.ok(sized.weight_bps <= 1800);

  // 2) P0 -15% 总净值熔断 + P1 个股 -8% 硬止损 + +15% 保本上移与跌破 MA20 追踪止盈 + 铁律2滞后护栏
  const days = weekdays('20260701', 90);
  const novFirstIdx = days.findIndex(d => d.startsWith('202611'));
  const createdDay = days[novFirstIdx - 20];
  const midDay = days[novFirstIdx - 10];
  const asOf = days[novFirstIdx];
  const { db: mDb, path: marketPath } = setupMarketDb('ae-m', days, {
    '159558.SZ': (i) => (i <= novFirstIdx - 15 ? 0.819 : 0.850),
  });
  seedStocks(mDb, days, [
    // 600519.SH：买入成本 10.00，asOf 跌到 9.00 (-10% <= -8%) 触发 P1 硬止损
    { ts_code: '600519.SH', name: '贵州茅台测试', series: (i) => (i < novFirstIdx ? 10.00 : 9.00) },
    // 600036.SH：先从 10.00 涨到 12.00 (+20% >= +15%)，在 midDay 武装保本+MA20 追踪；于 asOf 跌到 11.20 < MA20 (~11.96)
    { ts_code: '600036.SH', name: '招商银行测试', series: (i) => (i < 60 ? 10.00 : i < novFirstIdx ? 12.00 : 11.20) },
  ]);
  seedIndexAndReports(mDb, days, {
    valueSeries: (i) => 3500 + i * 5,
    csi500Series: (i) => 5200 + i * 8,
    chinextSeries: (i) => 2000 + i * 3,
  });

  upsertRows(mDb, 'fund_nav', ['ts_code', 'ann_date', 'nav_date', 'unit_nav', 'accum_nav', 'adj_nav'], [
    ...days.map(d => ({ ts_code: '159241.SZ', ann_date: d, nav_date: d, unit_nav: 1.0, accum_nav: 1.0, adj_nav: 1.0 })),
    { ts_code: '513100.SH', ann_date: asOf, nav_date: asOf, unit_nav: 1.44, accum_nav: 1.44, adj_nav: 1.44 },
  ]);

  const pPath = join(dir, 'ae-portfolio.sqlite');
  const pDb = openPortfolioDb(pPath, { marketPath });
  try {
    // 场景 A：P0 -15% 熔断（HWM=10,000,000，当前总资产=8,400,000 -> -16% <= -15%）
    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run('initial_principal_cents:acc-p0', '10000000');
    const initP0 = evaluateStrategyRouter({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-p0',
      asOf: days[80],
      currentNavCents: 10_000_000,
      marketRegime: evaluateMarketRegime(mDb, days[80], { pctAboveMa60ByDate: { [days[80]]: 0.55 } }),
    });
    assert.equal(persistRiskAnchor(pDb, { ...initP0, should_persist_anchor: true }), true);
    const outP0 = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: 'acc-p0',
      asOf,
      holdings: [{
        ts_code: '159241.SZ', name: '航空航天ETF', quantity: 20000, sellable_quantity: 20000,
        weight: 0.25, market_value_cents: 2_000_000, price_milli: 1000, latest_bar_date: asOf, bar_quality: 'READY', ref_cost_milli: 1000,
      }],
      cashCents: 6_400_000,
      totalAssetsCents: 8_400_000,
      marketRegime: evaluateMarketRegime(mDb, asOf, { pctAboveMa60ByDate: { [asOf]: 0.55 } }),
    });
    assert.equal(outP0.router.circuit_breaker_status, 'L2_LOCKED');
    assert.equal(outP0.router.effective_regime, 'DEFENSIVE');
    const p0SellLeg = outP0.actions.flatMap(p => p.legs).find(l => l.side === 'SELL' && l.ts_code === '159241.SZ');
    assert.ok(p0SellLeg && p0SellLeg.quantity >= 7400 && (2_000_000 - p0SellLeg.quantity * 100) <= 8_400_000 * 0.15,
      'P0 -15% 熔断必须将权益强压至 <= 15%');
    assert.equal(outP0.actions.some(p => p.legs.some(l => l.side === 'BUY')), false);

    // 场景 B：真实账本 + 铁律2 滞后不阻断（159558 月度触发 + 600519 -10%硬止损 + 600036 破MA20止盈）
    const accId = 'real-main';
    const positions = [
      { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 58900, ref_price_milli: 850, ref_cost_milli: 819, market_value_cents: 5_006_500 },
      { ts_code: '600519.SH', name: '贵州茅台测试', quantity: 1000, ref_price_milli: 9000, ref_cost_milli: 10000, market_value_cents: 900_000 },
      { ts_code: '600036.SH', name: '招商银行测试', quantity: 1000, ref_price_milli: 11200, ref_cost_milli: 10000, market_value_cents: 1_120_000 },
    ];
    const secMv = 7_026_500;
    const cashCents = 154_447;
    const totalAssets = secMv + cashCents;
    importSnapshot(pDb, {
      snapshot_id: 'snap-v3-lag',
      as_of: asOf,
      source: 'synthetic-test',
      note: 'synthetic V3 E2E',
      warnings: [],
      is_current: false,
      positions,
      totals: { total_assets_cents: totalAssets, securities_mv_cents: secMv, cash_cents: cashCents, wealth_cents: 0, unrealized_pnl_cents: -200_000 },
    });
    initBaseline(pDb, accId, { asOf, snapshotId: 'snap-v3-lag' });
    markSnapshotCurrent(pDb, 'snap-v3-lag', { confirmedBy: 'test' });
    confirmRealAccount(pDb, accId, { confirm: true, note: 'test' });
    const lagThrough = days[novFirstIdx - 7];
    setAccountCompleteness(pDb, accId, {
      as_of: lagThrough,
      reported_events_through: lagThrough,
      unreported_trade_risk: false,
    }, { confirm: true, recordedBy: 'test' });

    pDb.prepare('INSERT OR REPLACE INTO account_meta(key, value) VALUES (?, ?)').run(`initial_principal_cents:${accId}`, '10000000');
    const initReal = evaluateStrategyRouter({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf: createdDay,
      currentNavCents: 7_000_000,
      marketRegime: evaluateMarketRegime(mDb, createdDay, { pctAboveMa60ByDate: { [createdDay]: 0.5 } }),
    });
    persistRiskAnchor(pDb, { ...initReal, should_persist_anchor: true });
    ensureDeconcentrationPlan(pDb, {
      account_id: accId,
      ts_code: '159558.SZ',
      initial_shares: 58900,
      nav_cents: 6_860_690,
      target_keep_bps: 1791,
      anchor_price_milli: 819,
      total_tranches: 4,
      created_at: createdDay,
    });

    // 先跑 midDay (600036.SH = 12.00 = +20%) 武装保本止损 + MA20 追踪（保留 159558.SZ 持仓以维持其四批计划为 PENDING）
    const midAe = runActionEngine({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      asOf: midDay,
      holdings: [
        { ts_code: '159558.SZ', name: '半导体设备ETF', quantity: 58900, sellable_quantity: 58900, weight: 0.70, market_value_cents: 5_006_500, price_milli: 850, latest_bar_date: midDay, bar_quality: 'READY', ref_cost_milli: 819 },
        { ts_code: '600036.SH', name: '招商银行测试', quantity: 1000, sellable_quantity: 1000, weight: 0.16, market_value_cents: 1_200_000, price_milli: 12000, latest_bar_date: midDay, bar_quality: 'READY', ref_cost_milli: 10000 },
      ],
      cashCents: 1_000_000,
      totalAssetsCents: 7_206_500,
      marketRegime: evaluateMarketRegime(mDb, midDay, { pctAboveMa60ByDate: { [midDay]: 0.55 } }),
    });
    syncAccountV3State(pDb, midAe);
    const armedTracker = pDb.prepare("SELECT * FROM position_stop_tracker WHERE account_id = ? AND ts_code = '600036.SH'").get(accId);
    assert.equal(armedTracker.trailing_ma20_armed, 1);
    assert.equal(armedTracker.current_stop_milli, 10000);

    // 运行 asOf 日报（铁律2 验证）
    const report = buildDailyReport({
      portfolioDb: pDb,
      marketDb: mDb,
      accountId: accId,
      snapshotId: 'snap-v3-lag',
      asOfTradeDate: asOf,
    });
    assert.equal(report.gate.satisfied, true);
    assert.equal(report.status, 'ACTIONABLE');
    assert.ok(report.gate.warnings.some(w => w.code === 'unreported_trade_lag_warning'));
    assert.equal(report.first_section.actions.length, 3);
    assert.ok(report.first_section.actions.every(a => a.legs.length > 0 && a.legs.every(l => l.executable === true)));

    const actionCodes = new Set(report.first_section.actions.flatMap(a => a.legs.map(l => l.ts_code)));
    assert.ok(actionCodes.has('600519.SH'), 'P1 -8% 硬止损应输出实操卖单');
    assert.ok(actionCodes.has('600036.SH'), 'P1 +15% 后跌破 MA20 应输出止盈卖单');
    assert.ok(actionCodes.has('159558.SZ'), 'P2 月度保底换马第1批应输出卖出 11,000 股');
    assert.ok(report.v3_cockpit, 'v3_cockpit 必须挂接在报告结构尾部');

    const rendered = renderDailyReport(report);
    assert.match(rendered.user, /159558\.SZ/);
    assert.match(rendered.user, /600519\.SH/);
    assert.match(rendered.user, /存在滞后提醒|补录/);
    assert.ok(rendered.attachment['15. 用户版内嵌数字'].v3_cockpit_numbers);
    assert.match(rendered.technical, /v3_cockpit_numbers/);
  } finally {
    pDb.close();
    mDb.close();
  }
});
