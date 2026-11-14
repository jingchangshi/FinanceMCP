import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAshareDb } from '../build/ashare/db.js';
import { generateReport } from '../build/ashare/report.js';
import { seedMarket, weekdays } from './ashare-fixture.mjs';
import { marketBreadth } from '../build/ashare/market.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE trade_cal (cal_date TEXT, is_open INTEGER);
    CREATE TABLE daily (ts_code TEXT, trade_date TEXT, pct_chg REAL, amount REAL, close REAL);
    CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);
    INSERT INTO trade_cal VALUES ('20261112', 1), ('20261113', 1);
    INSERT INTO daily VALUES ('A', '20261112', 2, 100000, 10),
      ('A', '20261113', 1, 200000, 10), ('B', '20261113', 0, 0, 10);
  `);
  return db;
}

test('market breadth exposes same-day descriptive facts with source and coverage', () => {
  const db = fixture();
  try {
    const facts = marketBreadth(db, '20261113').environment_facts;
    assert.equal(facts.as_of, '20261113');
    assert.equal(facts.source, 'daily');
    assert.equal(facts.research_status, 'unvalidated');
    assert.match(facts.scope, /缺失行情/);
    assert.deepEqual(facts.quality, { status: 'complete', rows: 2, pct_chg_rows: 2, amount_rows: 2 });
    assert.equal(facts.up_ratio, 0.5);
    assert.equal(facts.median_pct_chg, 0.5);
    assert.equal(marketBreadth(db, '20261113').median_pct_chg, 1, 'legacy upper median remains unchanged');
    assert.equal(facts.amount_yi, 2);
  } finally { db.close(); }
});

test('ready daily report carries the market environment facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-environment-'));
  const oldDir = process.env.ASHARE_DATA_DIR;
  process.env.ASHARE_DATA_DIR = dir;
  const db = openAshareDb(':memory:');
  try {
    const dates = weekdays('20260105', 100);
    seedMarket(db, dates);
    const date = dates.at(-1);
    const { report } = generateReport(db, date, 'live');
    assert.notEqual(report.status, 'NOT_READY');
    assert.deepEqual(report.market.breadth.environment_facts, marketBreadth(db, date).environment_facts);
    assert.equal(report.market.breadth.environment_facts.research_status, 'unvalidated');
  } finally {
    db.close();
    if (oldDir === undefined) delete process.env.ASHARE_DATA_DIR;
    else process.env.ASHARE_DATA_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial inputs and missing dates do not become zero or stale facts', () => {
  const db = fixture();
  try {
    db.exec("UPDATE daily SET pct_chg = NULL, amount = NULL WHERE ts_code = 'B' AND trade_date = '20261113'");
    const partial = marketBreadth(db, '20261113').environment_facts;
    assert.deepEqual(partial.quality, { status: 'partial', rows: 2, pct_chg_rows: 1, amount_rows: 1 });
    assert.equal(partial.up_ratio, null);
    assert.equal(partial.median_pct_chg, null);
    assert.equal(partial.amount_yi, null);
    const missing = marketBreadth(db, '20261114').environment_facts;
    assert.equal(missing.as_of, '20261114');
    assert.equal(missing.quality.status, 'missing');
    assert.equal(missing.up_ratio, null);
    assert.equal(missing.amount_yi, null);
    db.exec("UPDATE daily SET pct_chg = 0, amount = 0 WHERE trade_date = '20261113'");
    const zero = marketBreadth(db, '20261113').environment_facts;
    assert.equal(zero.up_ratio, 0);
    assert.equal(zero.median_pct_chg, 0);
    assert.equal(zero.amount_yi, 0);
  } finally { db.close(); }
});
