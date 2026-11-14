import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.env.UPGRADE_BUILD_DIR ?? resolve('build');
const { screenEtfCandidates } = await import(pathToFileURL(resolve(root, 'ashare/etfUniverse.js')).href);
const code = '510300.SH';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fund_basic(ts_code TEXT PRIMARY KEY,name TEXT,fund_type TEXT,invest_type TEXT,benchmark TEXT,status TEXT,list_date TEXT,delist_date TEXT,market TEXT);
    CREATE TABLE fund_daily(ts_code TEXT,trade_date TEXT,close REAL,vol REAL,amount REAL,PRIMARY KEY(ts_code,trade_date));
    CREATE TABLE fund_adj(ts_code TEXT,trade_date TEXT,adj_factor REAL,PRIMARY KEY(ts_code,trade_date));
    CREATE TABLE fund_share(ts_code TEXT,trade_date TEXT,fd_share REAL);
    CREATE TABLE trade_cal(cal_date TEXT PRIMARY KEY,is_open INTEGER);
    CREATE TABLE index_daily(ts_code TEXT,trade_date TEXT,close REAL);`);
  db.prepare("INSERT INTO fund_basic VALUES (?, '沪深300ETF', '股票型', '被动指数型', NULL, 'L', '20200101', NULL, 'E')").run(code);
  const dates = [];
  for (let i = 0; dates.length < 65; i++) {
    const d = new Date(Date.UTC(2026, 5, 1 + i));
    const date = d.toISOString().slice(0, 10).replaceAll('-', '');
    const open = d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
    db.prepare('INSERT INTO trade_cal VALUES (?,?)').run(date, +open);
    if (!open) continue;
    dates.push(date);
    const price = 1 + dates.length * 0.001;
    db.prepare('INSERT INTO fund_daily VALUES (?,?,?,?,?)').run(code, date, price, 100, 50000);
    db.prepare('INSERT INTO fund_adj VALUES (?,?,1)').run(code, date);
    db.prepare('INSERT INTO index_daily VALUES (?,?,?)').run('000300.SH', date, price * 1000);
  }
  const friday = dates.at(-1);
  const saturday = new Date(Date.UTC(+friday.slice(0, 4), +friday.slice(4, 6) - 1, +friday.slice(6, 8) + 1)).toISOString().slice(0, 10).replaceAll('-', '');
  db.prepare('INSERT INTO trade_cal VALUES (?,0)').run(saturday);
  db.prepare('INSERT INTO fund_share VALUES (?,?,?)').run(code, friday, 100000);
  return { db, dates, friday, saturday };
}

const row = (db, asOf) => screenEtfCandidates(db, { asOf, heldCodes: [], limit: 100 }).candidates.find(r => r.ts_code === code);

test('完整窗口可计算，周末按最近开市日判断行情', () => {
  const { db, friday, saturday } = fixture();
  try {
    const result = screenEtfCandidates(db, { asOf: saturday, heldCodes: [], limit: 100 });
    const r = result.candidates.find(item => item.ts_code === code);
    assert.equal(result.data_coverage.expected_trade_date, friday);
    assert.ok(!r.status_reasons.includes('fund_daily_stale'));
    assert.equal(r.filters.risk.state, 'pass');
    assert.equal(r.filters.risk.threshold.min_bars, 21);
    assert.equal(r.filters.risk.bars_used, 60);
    assert.notEqual(r.filters.risk.realized_vol_pct, null);
    // 默认 limit 下，DEGRADED 观察行不能挤掉周末仍以最近开市日行情通过筛选的候选。
    const defaultLimit = screenEtfCandidates(db, { asOf: saturday, heldCodes: [] });
    assert.ok(defaultLimit.candidates.some(item => item.ts_code === code), 'OK 候选被 DEGRADED 行挤出展示');
  } finally { db.close(); }
});

test('窗口中间缺因子不会桥接收益，也不改变成交额窗口', () => {
  const { db, dates, friday } = fixture();
  try {
    const missing = dates.at(-10);
    db.prepare('UPDATE fund_daily SET amount=1 WHERE ts_code=? AND trade_date=?').run(code, missing);
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run(code, missing);
    const r = row(db, friday);
    assert.equal(r.filters.risk.state, 'unavailable');
    assert.equal(r.filters.risk.realized_vol_pct, null);
    assert.equal(r.filters.risk.max_drawdown_pct, null);
    // 只使用缺口之后的连续 9 根，8 个相邻收益；不把缺口两侧拼成一个收益。
    assert.equal(r.filters.risk.bars_used, 9);
    assert.equal(r.filters.tracking.observations, 8);
    assert.equal(r.filters.liquidity.mean_amount_kcy, (19 * 50000 + 1) / 20);
    assert.equal(r.data.latest_bar_date, friday);
    assert.equal(r.included, true);
    assert.equal(r.eligibility, 'research_only');
  } finally { db.close(); }
});

test('缺行情、缺最新因子及日历过期均不推断停牌或计算完整收益', () => {
  const { db, dates, friday, saturday } = fixture();
  try {
    db.prepare('DELETE FROM fund_daily WHERE ts_code=? AND trade_date=?').run(code, dates.at(-15));
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run(code, friday);
    let r = row(db, saturday);
    assert.equal(r.filters.risk.state, 'unavailable');
    assert.equal(r.data.latest_bar_date, friday);
    assert.ok(!r.status_reasons.includes('fund_daily_stale'));
    db.prepare('DELETE FROM trade_cal WHERE cal_date=?').run(saturday);
    r = row(db, saturday);
    assert.ok(r.status_reasons.includes('trade_calendar_unavailable'));
    assert.ok(!r.status_reasons.includes('fund_daily_stale'));
    assert.equal(r.eligibility, 'research_only');
  } finally { db.close(); }
});

test('21–59 根正常短历史仍可评估，不要求满 60 根', () => {
  const { db, dates, friday } = fixture();
  try {
    const keep = dates.slice(-30);
    const placeholders = keep.map(() => '?').join(',');
    db.prepare(`DELETE FROM fund_daily WHERE ts_code=? AND trade_date NOT IN (${placeholders})`).run(code, ...keep);
    db.prepare(`DELETE FROM fund_adj WHERE ts_code=? AND trade_date NOT IN (${placeholders})`).run(code, ...keep);
    const r = row(db, friday);
    assert.equal(r.filters.risk.state, 'pass');
    assert.equal(r.filters.risk.bars_used, 30);
    assert.notEqual(r.filters.risk.realized_vol_pct, null);
    assert.equal(r.filters.liquidity.window, 20);
  } finally { db.close(); }
});

test('缺口较早时只用缺口之后的连续区间，不跨缺口拼接', () => {
  const { db, dates, friday } = fixture();
  try {
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run(code, dates.at(-41));
    const r = row(db, friday);
    assert.equal(r.filters.risk.state, 'pass');
    assert.equal(r.filters.risk.bars_used, 40, '应只使用缺口之后的最近 40 根');
    assert.equal(r.filters.tracking.observations, 39);
    assert.equal(r.data.adj_missing_bars, 1);
    assert.notEqual(r.filters.risk.realized_vol_pct, null);
  } finally { db.close(); }
});

test('最近连续区间只有 20 根时不可评估，21 根时可评估', () => {
  const { db, dates, friday } = fixture();
  try {
    db.prepare('DELETE FROM fund_adj WHERE ts_code=? AND trade_date=?').run(code, dates.at(-21));
    let r = row(db, friday);
    assert.equal(r.filters.risk.state, 'unavailable');
    assert.equal(r.filters.risk.bars_used, 20);
    assert.equal(r.filters.risk.realized_vol_pct, null);
    db.prepare('INSERT INTO fund_adj VALUES (?,?,1)').run(code, dates.at(-21));
    r = row(db, friday);
    assert.equal(r.filters.risk.state, 'pass');
    assert.equal(r.filters.risk.bars_used, 60);
    assert.notEqual(r.filters.risk.realized_vol_pct, null);
  } finally { db.close(); }
});

test('缺身份或报价保留 included 兼容性但只能作为研究观察', () => {
  const { db, friday } = fixture();
  try {
    db.prepare('DELETE FROM fund_basic WHERE ts_code=?').run(code);
    let r = row(db, friday);
    assert.equal(r.included, true);
    assert.equal(r.eligibility, 'research_only');
    db.prepare('DELETE FROM fund_daily WHERE ts_code=?').run(code);
    r = row(db, friday);
    assert.equal(r.included, true);
    assert.equal(r.eligibility, 'research_only');
    assert.equal(r.data.latest_close_milli, null);
  } finally { db.close(); }
});
