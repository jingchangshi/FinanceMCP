import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// 全部为合成数据：验证摊薄成本的负成本舍入与现金分红扣减口径。
const dir = mkdtempSync(join(tmpdir(), 'ashare-diluted-cost-'));
const LIVE = join(dir, 'ashare.sqlite');
const PORTFOLIO = join(dir, 'portfolio.sqlite');
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = LIVE;
process.env.ASHARE_PORTFOLIO_DB_PATH = PORTFOLIO;

const { openAshareDb } = await import('../build/ashare/db.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { importDemoSnapshot } = await import('../build/portfolio/account.js');
const { initBaseline, recordEvent } = await import('../build/portfolio/ledger.js');
const { buildDilutedCostView } = await import('../build/portfolio/dilutedCost.js');

after(() => rmSync(dir, { recursive: true, force: true }));

const market = openAshareDb(LIVE);
market.close();
const db = openPortfolioDb(PORTFOLIO, { marketPath: LIVE });

function position(tsCode, name, quantity, priceMilli, costMilli) {
  return {
    ts_code: tsCode,
    name,
    quantity,
    ref_price_milli: priceMilli,
    ref_cost_milli: costMilli,
    market_value_cents: Math.round((quantity * priceMilli) / 10),
  };
}

function openAccount(id, asOf, cashCents, positions, isoDate) {
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  importDemoSnapshot(db, {
    snapshot_id: id,
    as_of: isoDate,
    source: 'synthetic-fixture',
    note: '合成测试快照，非真实账户',
    warnings: ['synthetic_fixture'],
    is_current: false,
    positions,
    totals: {
      total_assets_cents: cashCents + securities,
      securities_mv_cents: securities,
      cash_cents: cashCents,
      wealth_cents: 0,
      unrealized_pnl_cents: positions.reduce(
        (sum, p) => sum + (p.market_value_cents - (p.quantity * p.ref_cost_milli) / 10), 0,
      ),
    },
  });
  initBaseline(db, id, { asOf, snapshotId: id });
}

function rowOf(account, code, asOf) {
  return buildDilutedCostView(db, account, { asOf }).positions.find(p => p.ts_code === code);
}

test('摊薄成本负总成本按对称舍入换算整数分（-6995 厘 → -700 分，而非 -699）', () => {
  const account = 'syn-diluted-negative';
  const code = '159998.SZ';
  openAccount(account, '20261016', 1_000_000, [position(code, '合成ETF', 5, 1001, 1001)], '2026-10-16');
  // 5 × 1001 = 5005 厘；卖出 4 份 @ 3.000 元 = 12000 厘净所得 → 余 1 份、总成本 -6995 厘。
  recordEvent(db, {
    event_id: 'NEG-SELL',
    account_id: account,
    event_type: 'TRADE_SELL',
    occurred_on: '20261019',
    ts_code: code,
    quantity: 4,
    price_milli: 3000,
    source: 'synthetic',
  });
  const row = rowOf(account, code, '20261019');
  assert.equal(row.quantity, 1);
  assert.equal(row.events.at(-1).total_cost_milli_after, -6995);
  assert.equal(row.diluted_total_cost_cents, -700, '负成本必须远离零舍入，避免 1 分偏差');
  assert.equal(row.diluted_cost_per_share, -6.995, '均价仍按厘精确展示');
});

test('DIVIDEND 按东方财富摊薄口径冲减总成本，撤销分红时同额回退', () => {
  const account = 'syn-diluted-dividend';
  const code = '159997.SZ';
  openAccount(account, '20261016', 1_000_000, [position(code, '合成ETF', 10, 1000, 1000)], '2026-10-16');
  recordEvent(db, {
    event_id: 'DIV-CASH',
    account_id: account,
    event_type: 'DIVIDEND',
    occurred_on: '20261019',
    ts_code: code,
    cash_delta_cents: 250,
    source: 'synthetic',
  });

  const afterDividend = rowOf(account, code, '20261019');
  assert.equal(afterDividend.quantity, 10, '分红不改变份额');
  assert.equal(afterDividend.events.at(-1).cost_milli_delta, -2500, '2.50 元分红冲减 2500 厘成本');
  assert.equal(afterDividend.diluted_total_cost_cents, 750, '10.00 − 2.50 = 7.50 元');
  assert.equal(afterDividend.diluted_cost_per_share, 0.75);
  assert.equal(afterDividend.ledger_total_cost_cents, 1000, '账本平均成本法不受分红影响，便于并列核对');

  recordEvent(db, {
    event_id: 'DIV-REVERSE',
    account_id: account,
    event_type: 'REVERSE',
    occurred_on: '20261020',
    reverses_event_id: 'DIV-CASH',
    source: 'synthetic',
  });
  const reversed = rowOf(account, code, '20261020');
  assert.equal(reversed.events.at(-1).cost_milli_delta, 2500);
  assert.equal(reversed.diluted_total_cost_cents, 1000, '撤销分红恢复原总成本');
  assert.equal(reversed.diluted_cost_per_share, 1);
  assert.equal(reversed.quantity, 10);
});
