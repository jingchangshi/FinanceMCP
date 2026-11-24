// Eastmoney-shaped broker CSV import and the v1 -> v2 event_id compatibility
// path. The ledger facts are broker data, never estimates: fee columns are
// preserved exactly, and re-importing the same statement with/without --broker
// must not duplicate rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseTradeCsv } from '../build/portfolio/tradeImport.js';
import { PORTFOLIO_LEDGER_SCHEMA, PORTFOLIO_COMPLETENESS_SCHEMA } from '../build/portfolio/db.js';
import { importEvents, initBaseline, recordEvent } from '../build/portfolio/ledger.js';

const EASTMONEY_HEADER = '成交日期,业务名称,证券代码,成交数量,成交价格,成交金额,发生金额,佣金,规费,印花税,过户费,成交编号';
const EASTMONEY_BUY = '2026-10-19,证券买入,159999,100,1.250,125.00,-125.06,0.01,0.02,0,0.03,fill-1';
const EASTMONEY_SELL = '2026-10-20,证券卖出,159999,100,1.350,135.00,134.93,0.02,0.02,0.03,0,fill-2';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(PORTFOLIO_LEDGER_SCHEMA);
  db.exec(PORTFOLIO_COMPLETENESS_SCHEMA);
  db.exec(`CREATE TABLE account_snapshot(snapshot_id TEXT PRIMARY KEY, as_of TEXT,source TEXT,note TEXT,warnings TEXT,is_current INTEGER,total_assets_cents INTEGER,securities_mv_cents INTEGER,cash_cents INTEGER,wealth_cents INTEGER,unrealized_pnl_cents INTEGER,created_at TEXT);
    CREATE TABLE position(snapshot_id TEXT,ts_code TEXT,name TEXT,quantity INTEGER,ref_price_milli INTEGER,ref_cost_milli INTEGER,market_value_cents INTEGER);`);
  db.prepare('INSERT INTO account_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('baseline', '2026-10-16', 'synthetic', '', '[]', 0, 100000, 0, 100000, 0, 0, '2026-10-16');
  initBaseline(db, 'synthetic', { asOf: '20261016', snapshotId: 'baseline' });
  return db;
}

test('E1 Eastmoney columns with both 成交金额 and 发生金额 parse without ambiguity', () => {
  const { events } = parseTradeCsv(`${EASTMONEY_HEADER}\n${EASTMONEY_BUY}\n${EASTMONEY_SELL}\n`, {
    accountId: 'synthetic', brokerId: 'eastmoney',
  });
  const [buy, sell] = events;
  assert.equal(buy.gross_cents, 12500, 'gross comes from 成交金额');
  assert.equal(buy.cash_delta_cents, -12506, '发生金额 is the cash delta');
  assert.equal(buy.fee_cents, 6, 'commission + 规费 + 过户费 are preserved exactly');
  assert.equal(buy.tax_cents, 0);
  assert.match(buy.event_id, /^broker:v2:synthetic:eastmoney:20261019:TRADE_BUY:fill-1$/);
  const note = JSON.parse(buy.note);
  assert.equal(note.format, 'broker_csv/2');
  assert.equal(note.other_fee_cents, 2);
  assert.equal(sell.gross_cents, 13500);
  assert.equal(sell.cash_delta_cents, 13493);
  assert.equal(sell.fee_cents, 4);
  assert.equal(sell.tax_cents, 3);
});

test('E2 English column shape keeps working and the v2 id carries date and type', () => {
  const csv = 'event_id,occurred_on,event_type,ts_code,quantity,price,gross,fee,tax,cash_delta\n' +
    'x1,20261019,TRADE_BUY,159999.SZ,100,1.250,125.00,0.01,0,-125.01\n';
  const { events } = parseTradeCsv(csv, { accountId: 'synthetic' });
  assert.equal(events[0].event_id, 'broker:v2:synthetic:unspecified:20261019:TRADE_BUY:x1');
  assert.equal(events[0].fee_cents, 1);
});

test('E3 re-import with and without --broker does not duplicate rows', () => {
  const db = fixture();
  try {
    const csv = `${EASTMONEY_HEADER}\n${EASTMONEY_BUY}\n${EASTMONEY_SELL}\n`;
    const first = parseTradeCsv(csv, { accountId: 'synthetic', brokerId: 'eastmoney' }).events;
    assert.equal(importEvents(db, 'synthetic', first, { dedupeByContent: true }).counts.recorded, 2);

    // Same statement imported again without --broker: different event_id scheme
    // input, same broker facts -> DUPLICATE, no new rows.
    const second = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', second, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 0);
    assert.equal(result.counts.duplicate, 2);
    assert.equal(result.counts.conflict, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 2);

    // And with the broker again: the original v2 ids match by id.
    const third = parseTradeCsv(csv, { accountId: 'synthetic', brokerId: 'eastmoney' }).events;
    const again = importEvents(db, 'synthetic', third, { dedupeByContent: true });
    assert.equal(again.counts.duplicate, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 2);
  } finally { db.close(); }
});

test('E4 a row imported under the v1 id scheme is recognised by the v2 compatibility path', () => {
  const db = fixture();
  try {
    // Simulate a row written before this change: v1 id, same facts/fee columns.
    recordEvent(db, {
      event_id: 'broker:synthetic:unspecified:legacy-1',
      account_id: 'synthetic', event_type: 'TRADE_BUY', occurred_on: '20261019',
      ts_code: '159999.SZ', quantity: 100, price_milli: 1250,
      fee_cents: 6, tax_cents: 0, cash_delta_cents: -12506,
      source: 'broker_statement',
      note: JSON.stringify({ format: 'broker_csv/1', broker: null, source_id: 'legacy-1' }),
    });
    const csv = `${EASTMONEY_HEADER}\n2026-10-19,证券买入,159999,100,1.250,125.00,-125.06,0.01,0.02,0,0.03,legacy-1\n`;
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 0);
    assert.equal(result.counts.duplicate, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 1);
    assert.equal(db.prepare('SELECT event_id FROM account_event').get().event_id, 'broker:synthetic:unspecified:legacy-1');
  } finally { db.close(); }
});

test('E5 two genuinely distinct fills with identical fields are not collapsed', () => {
  const db = fixture();
  try {
    const header = '流水号,成交日期,业务名称,证券代码,成交数量,成交价格,成交金额,佣金,印花税,资金发生额';
    const csv = `${header}\n` +
      'f1,2026-10-19,买入,159999,100,1.250,125.00,0.01,0,-125.01\n' +
      'f2,2026-10-19,买入,159999,100,1.250,125.00,0.01,0,-125.01\n';
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 2, 'distinct broker source ids are distinct fills');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 2);
  } finally { db.close(); }
});

test('E6 a v2-id original can be reversed by a statement that names the raw broker id', () => {
  const db = fixture();
  try {
    const buy = parseTradeCsv(`${EASTMONEY_HEADER}\n${EASTMONEY_BUY}\n`, { accountId: 'synthetic' }).events;
    assert.equal(importEvents(db, 'synthetic', buy, { dedupeByContent: true }).counts.recorded, 1);
    const original = db.prepare('SELECT event_id FROM account_event').get().event_id;
    assert.match(original, /^broker:v2:/);

    const reverseCsv = '流水号,成交日期,业务名称,撤销流水号\nrev-1,2026-10-20,撤销,fill-1\n';
    const reverse = parseTradeCsv(reverseCsv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', reverse, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 1, JSON.stringify(result));
    const reversed = db.prepare('SELECT reversed_by FROM account_event WHERE event_id = ?').get(original);
    assert.ok(reversed.reversed_by, 'original row must be marked reversed');

    // Re-importing the same reversal must be a DUPLICATE, not an
    // already_reversed CONFLICT that aborts the batch.
    const again = importEvents(
      db, 'synthetic', parseTradeCsv(reverseCsv, { accountId: 'synthetic' }).events,
      { dedupeByContent: true },
    );
    assert.equal(again.counts.duplicate, 1, JSON.stringify(again));
    assert.equal(again.counts.conflict, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 2);
  } finally { db.close(); }
});

test('E7 a buy and its reversal in the same CSV resolve within the transaction', () => {
  const db = fixture();
  try {
    const header = '流水号,成交日期,业务名称,证券代码,成交数量,成交价格,成交金额,佣金,印花税,资金发生额,撤销流水号';
    const csv = `${header}\n` +
      'fill-1,2026-10-19,买入,159999,100,1.250,125.00,0.01,0,-125.01,\n' +
      'rev-1,2026-10-20,撤销,,,,,,,,fill-1\n';
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 2, JSON.stringify(result));
    assert.equal(result.counts.conflict, 0);
    const original = db.prepare("SELECT event_id, reversed_by FROM account_event WHERE event_type = 'TRADE_BUY'").get();
    assert.ok(original.reversed_by, 'reverse row must find the buy recorded earlier in the same batch');
  } finally { db.close(); }
});

test('E8 an ambiguous reversal target is rejected row-level, never first-match guessed', () => {
  const db = fixture();
  try {
    const note = JSON.stringify({ format: 'broker_csv/1', broker: null, source_id: 'dup-1' });
    for (const [id, date] of [['dup-a', '20261019'], ['dup-b', '20261020']]) {
      recordEvent(db, {
        event_id: id, account_id: 'synthetic', event_type: 'TRADE_BUY', occurred_on: date,
        ts_code: '159999.SZ', quantity: 100, price_milli: 1250,
        fee_cents: 1, tax_cents: 0, source: 'broker_statement', note,
      });
    }
    const reverseCsv = '流水号,成交日期,业务名称,撤销流水号\nrev-x,2026-10-21,撤销,dup-1\n';
    const events = parseTradeCsv(reverseCsv, { accountId: 'synthetic' }).events;
    const aborted = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(aborted.aborted, true);
    assert.match(aborted.abort_reason ?? '', /对应多笔事件/);
    assert.equal(aborted.counts.recorded, 0);
    assert.equal(aborted.results[0].status, 'CONFLICT');
    assert.match(aborted.results[0].reason, /reverse_target_unresolved/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_type = 'REVERSE'").get().n, 0);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM account_event_conflict').get().n >= 1, 'row error is left on record');

    // continue-on-conflict rejects only the bad row.
    const continued = importEvents(db, 'synthetic', events, { dedupeByContent: true, continueOnConflict: true });
    assert.equal(continued.counts.conflict, 1);
    assert.equal(continued.counts.recorded, 0);
  } finally { db.close(); }
});

test('E9 a manual record without broker/source id is never silently merged with a CSV trade', () => {
  const db = fixture();
  try {
    recordEvent(db, {
      event_id: 'manual-1', account_id: 'synthetic', event_type: 'TRADE_BUY', occurred_on: '20261019',
      ts_code: '159999.SZ', quantity: 100, price_milli: 1250,
      fee_cents: 6, tax_cents: 0, source: 'synthetic', note: '',
    });
    const csv = `${EASTMONEY_HEADER}\n2026-10-19,证券买入,159999,100,1.250,125.00,-125.06,0.01,0.02,0,0.03,fill-9\n`;
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 1, 'manual record must not be treated as the same broker fill');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event').get().n, 2);
  } finally { db.close(); }
});

test('E10 equal cash but a different gross/fee/tax split is not deduplicated', () => {
  const db = fixture();
  try {
    recordEvent(db, {
      event_id: 'broker:synthetic:unspecified:f1', account_id: 'synthetic', event_type: 'TRADE_BUY',
      occurred_on: '20261019', ts_code: '159999.SZ', quantity: 100, price_milli: 1250,
      fee_cents: 6, tax_cents: 0, source: 'broker_statement',
      note: JSON.stringify({ format: 'broker_csv/1', broker: null, source_id: 'f1' }),
    });
    // Same cash (-12506) but fee 5 / tax 1 instead of fee 6 / tax 0.
    const csv = `${EASTMONEY_HEADER}\n2026-10-19,证券买入,159999,100,1.250,125.00,-125.06,0.01,0.01,0.01,0.03,f1\n`;
    const events = parseTradeCsv(csv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.duplicate, 0, 'a different economic split is not the same fact');
    assert.equal(result.counts.recorded, 1);
  } finally { db.close(); }
});

function recordBrokerBuy(db, { id, date, sourceId, broker = null, code = '159999.SZ' }) {
  recordEvent(db, {
    event_id: id, account_id: 'synthetic', event_type: 'TRADE_BUY', occurred_on: date,
    ts_code: code, quantity: 100, price_milli: 1250,
    fee_cents: 1, tax_cents: 0, source: 'broker_statement',
    note: JSON.stringify({ format: 'broker_csv/1', broker, source_id: sourceId }),
  });
}

test('E11 old-day v1 X plus new-day v2 X is ambiguous, not an exact-id hit on the old row', () => {
  const db = fixture();
  try {
    // The synthesized CSV target id is exactly this old v1 row's id.
    recordBrokerBuy(db, { id: 'broker:synthetic:unspecified:X', date: '20261019', sourceId: 'X' });
    recordBrokerBuy(db, { id: 'broker:v2:synthetic:unspecified:20261020:TRADE_BUY:X', date: '20261020', sourceId: 'X' });
    const reverseCsv = '流水号,成交日期,业务名称,撤销流水号\nrev-X,2026-10-21,撤销,X\n';
    const events = parseTradeCsv(reverseCsv, { accountId: 'synthetic' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.aborted, true, JSON.stringify(result));
    assert.match(result.abort_reason ?? '', /对应多笔事件/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_event WHERE reversed_by IS NOT NULL').get().n, 0,
      'the old same-numbered v1 row must not be reversed by a bare number');
  } finally { db.close(); }
});

test('E12 --broker narrows a same-number reversal to that broker; without it the number is ambiguous', () => {
  const make = () => {
    const db = fixture();
    recordBrokerBuy(db, { id: 'brokerA-X', date: '20261019', sourceId: 'X', broker: 'brokerA' });
    recordBrokerBuy(db, { id: 'brokerB-X', date: '20261020', sourceId: 'X', broker: 'brokerB' });
    return db;
  };
  const reverseCsv = '流水号,成交日期,业务名称,撤销流水号\nrev-X,2026-10-21,撤销,X\n';
  const db = make();
  try {
    const withBroker = parseTradeCsv(reverseCsv, { accountId: 'synthetic', brokerId: 'brokerB' }).events;
    const ok = importEvents(db, 'synthetic', withBroker, { dedupeByContent: true });
    assert.equal(ok.counts.recorded, 1, JSON.stringify(ok));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_id = 'brokerB-X' AND reversed_by IS NOT NULL").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_id = 'brokerA-X' AND reversed_by IS NOT NULL").get().n, 0);
  } finally { db.close(); }

  const db2 = make();
  try {
    const withoutBroker = parseTradeCsv(reverseCsv, { accountId: 'synthetic' }).events;
    const ambiguous = importEvents(db2, 'synthetic', withoutBroker, { dedupeByContent: true });
    assert.equal(ambiguous.aborted, true);
    assert.match(ambiguous.abort_reason ?? '', /对应多笔事件/);
  } finally { db2.close(); }
});

test('E13 a same-CSV buy and reversal still resolves when --broker is supplied', () => {
  const db = fixture();
  try {
    const header = '流水号,成交日期,业务名称,证券代码,成交数量,成交价格,成交金额,佣金,印花税,资金发生额,撤销流水号';
    const csv = `${header}\n` +
      'fill-1,2026-10-19,买入,159999,100,1.250,125.00,0.01,0,-125.01,\n' +
      'rev-1,2026-10-20,撤销,,,,,,,,fill-1\n';
    const events = parseTradeCsv(csv, { accountId: 'synthetic', brokerId: 'eastmoney' }).events;
    const result = importEvents(db, 'synthetic', events, { dedupeByContent: true });
    assert.equal(result.counts.recorded, 2, JSON.stringify(result));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_type = 'TRADE_BUY' AND reversed_by IS NOT NULL").get().n, 1);
  } finally { db.close(); }
});

test('E14 a caller-provided full event id keeps exact-id semantics (no fuzzy resolution)', () => {
  const db = fixture();
  try {
    recordBrokerBuy(db, { id: 'full-buy-1', date: '20261019', sourceId: 'full-1' });
    const result = importEvents(db, 'synthetic', [{
      event_id: 'full-rev-1', account_id: 'synthetic', event_type: 'REVERSE',
      occurred_on: '20261020', reverses_event_id: 'full-buy-1', source: 'broker_statement',
    }], { dedupeByContent: true });
    assert.equal(result.counts.recorded, 1, JSON.stringify(result));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account_event WHERE event_id = 'full-buy-1' AND reversed_by IS NOT NULL").get().n, 1);
  } finally { db.close(); }
});
