// goal-1028 etf_weight_snapshot 存储测试：点时可见性、未发布排除、申赎篮子守卫、
// 多 ETF 反查、覆盖率。纯 :memory: 数据库，不访问网络。
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const {
  ETF_WEIGHT_SCHEMA,
  ensureEtfWeightSchema,
  snapshotVersionFor,
  writeWeightSnapshot,
  weightsAvailableAt,
  topConstituents,
  reverseLookupEtf,
  basketNotWeightGuard,
  weightCoverage,
} = await import('../build/ashare/etfWeightStore.js');

const ETF = '159558.SZ';
const AS_OF = '20261028';

function row(overrides = {}) {
  return {
    etf_code: ETF,
    index_code: '931743.CSI',
    stock_code: '688012.SH',
    weight: 10,
    source: 'index_weight',
    effective_date: '20260930',
    published_at: '20260930',
    available_from: '20260930',
    collected_at: '2026-10-28T00:00:00.000Z',
    quality_status: 'OK',
    ...overrides,
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureEtfWeightSchema(db);
  return db;
}

test('schema 含主键与 source/quality CHECK，snapshotVersionFor 确定', () => {
  assert.match(ETF_WEIGHT_SCHEMA, /etf_weight_snapshot/);
  assert.match(ETF_WEIGHT_SCHEMA, /index_weight','fund_portfolio/);
  assert.match(ETF_WEIGHT_SCHEMA, /NO_POINT_IN_TIME/);
  assert.equal(snapshotVersionFor(ETF, '20260930', 'index_weight'), `${ETF}-20260930-index_weight`);
  assert.equal(snapshotVersionFor(ETF, '20260930', 'index_weight'), snapshotVersionFor(ETF, '20260930', 'index_weight'));
});

test('index_weight: available_from = trade_date，当日前不可见，当日起可见', () => {
  const db = freshDb();
  assert.equal(writeWeightSnapshot(db, [row({ weight: 12 }), row({ stock_code: '002371.SZ', weight: 8 })]), 2);
  const before = weightsAvailableAt(db, ETF, '20260929');
  assert.equal(before.rows.length, 0);
  assert.equal(before.quality, 'UNAVAILABLE');
  assert.equal(before.reason, 'no_snapshot_available_at');
  const on = weightsAvailableAt(db, ETF, '20260930');
  assert.equal(on.quality, 'OK');
  assert.deepEqual(on.rows.map(r => r.stock_code), ['688012.SH', '002371.SZ']);
  assert.equal(on.rows[0].source, 'index_weight');
  assert.equal(on.rows[0].available_from, '20260930');
  db.close();
});

test('fund_portfolio: 报告期 end_date 不是可用日，ann_date 才是', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [row({
    source: 'fund_portfolio', index_code: null, effective_date: '20260630',
    published_at: '20260826', available_from: '20260826', stock_code: '600519.SH', weight: 6,
  })]);
  // 报告期已过但尚未披露：不可见
  assert.equal(weightsAvailableAt(db, ETF, '20260815').rows.length, 0);
  // 披露当日起可见，effective_date 仍是报告期
  const visible = weightsAvailableAt(db, ETF, '20260826');
  assert.equal(visible.rows.length, 1);
  assert.equal(visible.rows[0].effective_date, '20260630');
  assert.equal(visible.rows[0].published_at, '20260826');
  db.close();
});

test('fund_portfolio 无 ann_date（available_from 为空）拒绝入库', () => {
  const db = freshDb();
  assert.throws(
    () => writeWeightSnapshot(db, [row({
      source: 'fund_portfolio', index_code: null, effective_date: '20260630',
      published_at: null, available_from: '',
    })]),
    /available_from/,
  );
  const cov = weightCoverage(db, [ETF], AS_OF);
  assert.equal(cov[0].rows, 0);
  assert.equal(cov[0].quality, 'UNAVAILABLE');
  db.close();
});

test('未来可用的快照不返回：available_from 晚于 asOf', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [row({ effective_date: '20261101', published_at: '20261101', available_from: '20261101' })]);
  const res = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(res.rows.length, 0);
  assert.equal(res.quality, 'UNAVAILABLE');
  assert.equal(res.reason, 'no_snapshot_available_at');
  // 旧快照存在时，未来快照不混入该时点
  writeWeightSnapshot(db, [row({ effective_date: '20260930', published_at: '20260930', available_from: '20260930', stock_code: '600519.SH', weight: 5 })]);
  const res2 = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(res2.rows.length, 1);
  assert.equal(res2.rows[0].effective_date, '20260930');
  db.close();
});

test('published_at 缺失的行默认排除并计数，allowUnpublished 才返回', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [
    row({ stock_code: '600519.SH', weight: 9, published_at: null }),
    row({ stock_code: '000858.SZ', weight: 8, published_at: null }),
  ]);
  const def = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(def.rows.length, 0);
  assert.equal(def.quality, 'DEGRADED');
  assert.match(def.reason ?? '', /published_at_missing/);
  assert.match(def.reason ?? '', /excluded=2/);
  const allow = weightsAvailableAt(db, ETF, AS_OF, { allowUnpublished: true });
  assert.equal(allow.rows.length, 2);
  assert.equal(allow.quality, 'DEGRADED');
  assert.match(allow.reason ?? '', /published_at_missing/);
  db.close();
});

test('同一 ETF 多期：只返回 ≤ asOf 的最新一期', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [row({ effective_date: '20260630', published_at: '20260630', available_from: '20260630', stock_code: '600519.SH', weight: 10 })]);
  writeWeightSnapshot(db, [row({ effective_date: '20260930', published_at: '20260930', available_from: '20260930', stock_code: '000858.SZ', weight: 20 })]);
  const mid = weightsAvailableAt(db, ETF, '20260815');
  assert.equal(mid.rows.length, 1);
  assert.equal(mid.rows[0].effective_date, '20260630');
  const late = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(late.rows.length, 1);
  assert.equal(late.rows[0].effective_date, '20260930');
  db.close();
});

test('同键重采样 delete-then-insert：旧成分不残留', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [row({ stock_code: 'A.SH', weight: 10 }), row({ stock_code: 'B.SH', weight: 5 })]);
  writeWeightSnapshot(db, [row({ stock_code: 'A.SH', weight: 12 })]);
  const res = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].stock_code, 'A.SH');
  assert.equal(res.rows[0].weight, 12);
  db.close();
});

test('topConstituents 按权重降序且受 n 限制', () => {
  const db = freshDb();
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push(row({ stock_code: `6000${String(i).padStart(2, '0')}.SH`, weight: i }));
  }
  writeWeightSnapshot(db, rows);
  const top3 = topConstituents(db, ETF, AS_OF, 3);
  assert.equal(top3.length, 3);
  assert.deepEqual(top3.map(r => r.weight), [12, 11, 10]);
  const def = topConstituents(db, ETF, AS_OF);
  assert.equal(def.length, 10);
  assert.equal(def[0].weight, 12);
  db.close();
});

test('reverseLookupEtf: 多只 ETF 共同持有；最新一期已剔除该股的 ETF 不计入', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [
    // A：6/30 含 600519，9/30 起剔除
    row({ etf_code: '159558.SZ', effective_date: '20260630', published_at: '20260630', available_from: '20260630', stock_code: '600519.SH', weight: 5 }),
    row({ etf_code: '159558.SZ', effective_date: '20260930', published_at: '20260930', available_from: '20260930', stock_code: '000858.SZ', weight: 4 }),
    // B：6/30 含 600519，披露于 8/26
    row({
      etf_code: '516080.SH', source: 'fund_portfolio', index_code: null,
      effective_date: '20260630', published_at: '20260826', available_from: '20260826',
      stock_code: '600519.SH', weight: 3,
    }),
    // C：9/30 起含 600519
    row({ etf_code: '159241.SZ', effective_date: '20260930', published_at: '20260930', available_from: '20260930', stock_code: '600519.SH', weight: 2 }),
  ]);
  const late = reverseLookupEtf(db, '600519.SH', AS_OF).map(r => r.etf_code).sort();
  assert.deepEqual(late, ['159241.SZ', '516080.SH']);
  const mid = reverseLookupEtf(db, '600519.SH', '20260901').map(r => r.etf_code).sort();
  assert.deepEqual(mid, ['159558.SZ', '516080.SH']);
  const early = reverseLookupEtf(db, '600519.SH', '20260815').map(r => r.etf_code);
  assert.deepEqual(early, ['159558.SZ']);
  db.close();
});

test('basketNotWeightGuard 抛出约定信息', () => {
  assert.throws(
    () => basketNotWeightGuard(500),
    err => err instanceof Error && err.message === '申赎篮子数量不能作为投资权重',
  );
  assert.throws(() => basketNotWeightGuard(null), /申赎篮子数量不能作为投资权重/);
});

test('source CHECK：写入校验与表约束双重拒绝非法 source', () => {
  const db = freshDb();
  assert.throws(() => writeWeightSnapshot(db, [row({ source: 'etf_sz_cons' })]), /source/);
  assert.throws(() => {
    db.prepare(`INSERT INTO etf_weight_snapshot
      (etf_code, snapshot_version, stock_code, index_code, weight, source, effective_date, published_at, available_from, collected_at, quality_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ETF, 'v', '600519.SH', null, 1, 'basket_qty', '20260930', '20260930', '20260930',
      '2026-10-28T00:00:00.000Z', 'OK',
    );
  }, /CHECK/i);
  assert.equal(weightCoverage(db, [ETF], AS_OF)[0].rows, 0);
  db.close();
});

test('写入校验：weight 为 null 时不得为 OK；null weight + DEGRADED 合法', () => {
  const db = freshDb();
  assert.throws(() => writeWeightSnapshot(db, [row({ weight: null, quality_status: 'OK' })]), /weight/);
  assert.equal(writeWeightSnapshot(db, [row({ weight: null, quality_status: 'DEGRADED', published_at: '20260930' })]), 1);
  db.close();
});

test('weightCoverage 如实汇报 OK / UNAVAILABLE / DEGRADED', () => {
  const db = freshDb();
  writeWeightSnapshot(db, [row({ etf_code: '159558.SZ', stock_code: '600519.SH', weight: 5 })]);
  writeWeightSnapshot(db, [row({
    etf_code: '516080.SH', source: 'fund_portfolio', index_code: null, stock_code: '000858.SZ',
    weight: 4, effective_date: '20260630', published_at: null, available_from: '20260826',
  })]);
  const cov = weightCoverage(db, ['159558.SZ', '516080.SH', '560390.SH'], AS_OF);
  assert.equal(cov.length, 3);
  const byCode = new Map(cov.map(c => [c.dataset, c]));

  const ok = byCode.get('etf_weight:159558.SZ');
  assert.equal(ok.quality, 'OK');
  assert.equal(ok.rows, 1);

  const degraded = byCode.get('etf_weight:516080.SH');
  assert.equal(degraded.quality, 'DEGRADED');
  assert.equal(degraded.rows, 0);
  assert.match(degraded.reason ?? '', /published_at_missing/);

  const missing = byCode.get('etf_weight:560390.SH');
  assert.equal(missing.quality, 'UNAVAILABLE');
  assert.equal(missing.rows, 0);
  assert.equal(missing.reason, 'no_snapshot_available_at');
  db.close();
});

test('表不存在时读路径降级，不抛错、不建表', () => {
  const db = new DatabaseSync(':memory:');
  const res = weightsAvailableAt(db, ETF, AS_OF);
  assert.equal(res.quality, 'UNAVAILABLE');
  assert.equal(res.reason, 'no_snapshot_available_at');
  assert.deepEqual(reverseLookupEtf(db, '600519.SH', AS_OF), []);
  assert.deepEqual(topConstituents(db, ETF, AS_OF, 5), []);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'etf_weight_snapshot'`).all();
  assert.equal(tables.length, 0);
  db.close();
});
