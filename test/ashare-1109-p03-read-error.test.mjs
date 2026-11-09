import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// goal-1109 A07 + A16 (read-only investigation turned into regression tests).
// A07: DB error (disk full / I/O) must surface as READ_ERROR, never NOT_FOUND / NO_RECORDS.
// A16: record retrievable by as-of; immature windows are PENDING, never scored early.

const { recordResearchJournal, listResearchJournal, evaluateResearchJournal } = await import('../build/portfolio/researchJournal.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { getResearchSnapshot, listResearchSnapshots } = await import('../build/portfolio/researchSnapshot.js');
const { buildResearchEval, ResearchEvalReadError, isResearchEvalReadError, EVAL_LAYERS } = await import('../build/portfolio/researchEval.js');
const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');

const dir = mkdtempSync(join(tmpdir(), 'ashare-1109-p03-'));
const ACCOUNT = 'synthetic-1109';
let seq = 0;

function fullError() {
  const e = new Error('database or disk is full');
  e.code = 'SQLITE_FULL'; e.errcode = 28; e.errno = 28;
  return e;
}
/** Fault-injection stub: any prepare() throws SQLITE_FULL (journalTable probe included). */
const badDb = { prepare() { throw fullError(); } };

test('A07: getResearchSnapshot with disk-full returns READ_ERROR, never NOT_FOUND', () => {
  const r = getResearchSnapshot(badDb, { accountId: ACCOUNT, asOf: '20261022' });
  assert.equal(r.status, 'READ_ERROR');
  assert.notEqual(r.status, 'NOT_FOUND');
  assert.equal(r.snapshot, null);
  assert.equal(r.frozen_payload, null);
  assert.equal(r.error_code, 'SQLITE_FULL');
  assert.equal(r.error_errno, 28);
  assert.match(r.note, /read_error/);
  // error/log fields carry the code for operators; no payload, no Live Bundle substitution.
  assert.equal(r.payload_verification, null);
});

test('A07: listResearchSnapshots with disk-full returns READ_ERROR, never an empty FOUND', () => {
  const r = listResearchSnapshots(badDb, { accountId: ACCOUNT, asOf: '20261022' });
  assert.equal(r.status, 'READ_ERROR');
  assert.deepEqual(r.snapshots, []);
  assert.equal(r.error_code, 'SQLITE_FULL');
});

test('A07: save statement never claims the pre-fix not-found translation happened', () => {
  // Regression guard for the task-book wording: the note must say read_error, and the
  // structured status must not be the conflated SNAPSHOT_NOT_FOUND style.
  const r = getResearchSnapshot(badDb, { accountId: ACCOUNT, recordId: 'VPS-x' });
  assert.notEqual(r.status, 'NOT_FOUND');
  assert.equal(r.status, 'READ_ERROR');
  assert.ok(!('SNAPSHOT_NOT_FOUND' in r));
});

test('A07: healthy empty DB returns NOT_FOUND (query ran, no rows)', () => {
  const p = openPortfolioDb(join(dir, `p-${seq += 1}.sqlite`));
  try {
    const r = getResearchSnapshot(p, { accountId: ACCOUNT, asOf: '20261022' });
    assert.equal(r.status, 'NOT_FOUND');
    assert.equal(r.error_code, null);
    assert.equal(r.snapshot, null);
  } finally { p.close(); }
});

test('A07: buildResearchEval with DB error throws typed READ_ERROR (never returns NO_RECORDS)', () => {
  assert.throws(
    () => buildResearchEval({ portfolioDb: badDb, marketDb: null, accountId: ACCOUNT, asOf: '20261022' }),
    (err) => {
      assert.ok(isResearchEvalReadError(err), 'must be ResearchEvalReadError');
      assert.ok(err instanceof ResearchEvalReadError);
      assert.equal(err.status, 'READ_ERROR');
      assert.equal(err.sqlite_code, 'SQLITE_FULL');
      assert.equal(err.envelope.status, 'READ_ERROR');
      assert.equal(err.envelope.schema, 'research-eval/1.0');
      assert.notEqual(err.envelope.status, 'NO_RECORDS');
      assert.notEqual(err.envelope.status, 'NO_RECORDS');
      assert.ok(!('layers' in err.envelope), 'READ_ERROR envelope must not carry metric layers');
      return true;
    },
  );
});

test('A07: eval validation errors stay plain (not READ_ERROR)', () => {
  const p = openPortfolioDb(join(dir, `p-${seq += 1}.sqlite`));
  try {
    assert.throws(() => buildResearchEval({ portfolioDb: p, marketDb: null, accountId: ACCOUNT, asOf: '20261340' }), (err) => {
      assert.ok(!isResearchEvalReadError(err));
      return true;
    });
  } finally { p.close(); }
});

const at = (date, hm = '18:00') => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hm}:00+08:00`;
function weekdays(from, n) {
  const out = [];
  for (let d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`); out.length < n; d = new Date(+d + 86400000)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
}
function market(dates) {
  seq += 1;
  const db = openAshareDb(join(dir, `m-${seq}.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    dates.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: dates[i - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    ['510500.SH', '510300.SH'].map(ts_code => ({ ts_code, name: ts_code, fund_type: '股票型', invest_type: '被动指数型', benchmark: 'x', status: 'L', market: 'E' })));
  for (const ts_code of ['510500.SH', '510300.SH']) dates.forEach((trade_date, i) => {
    const close = 1 + 0.001 * i;
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code, trade_date, adj_factor: 1 }]);
  });
  return db;
}
const feeEstimator = () => ({ total_cents: 10, estimated: true, version: 'synthetic-v1' });
const entry = (id, date, extra = {}) => ({
  record_id: id, account_id: ACCOUNT, source: 'vps', as_of_trade_date: date, bundle_id: `b-${id}`,
  generated_at: at(date), versions: { rules: 'v1' },
  judgement: { c: 'observe' }, candidates: [], evidence: [],
  observations: [{ ts_code: '510500.SH', quantity: 10000, direction: 'observe', benchmark_code: '510300.SH' }],
  ...extra,
});

test('A16: record retrievable by as-of; immature 20-day window stays PENDING (not scored early)', () => {
  seq += 1;
  const p = openPortfolioDb(join(dir, `p-${seq}.sqlite`));
  const dates = weekdays('20261016', 30);
  const m = market(dates);
  try {
    recordResearchJournal(p, entry('fwd-1', '20261022'));
    // as-of retrieval
    const found = listResearchJournal(p, { accountId: ACCOUNT, asOf: '20261022' });
    assert.equal(found.length, 1);
    assert.equal(found[0].record_id, 'fwd-1');
    // 20-day window from 20261022 cannot be mature on 20261023.
    const evals = evaluateResearchJournal({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261023', horizons: [20], feeEstimator });
    assert.equal(evals.length, 1);
    assert.equal(evals[0].status, 'PENDING');
    assert.ok(!evals[0].observations.some(o => o.status === 'EVALUATED'), 'no observation may be EVALUATED before maturity');
    // Same via buildResearchEval: hermes layer exists (first-class since 1106), mature buckets stay PENDING.
    const res = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261023', horizon: 20, feeEstimator });
    assert.ok(EVAL_LAYERS.includes('hermes'));
    assert.ok(res.layers.hermes && res.layers.vps);
    const vpsMetrics = res.layers.vps;
    const statuses = Object.values(vpsMetrics).map(b => b.status);
    assert.ok(statuses.every(s => s === 'PENDING' || s === 'NO_RECORDS'), `immature buckets must be PENDING/NO_RECORDS, got ${statuses.join(',')}`);
  } finally { p.close(); m.close(); }
});

test('A16: hermes-sourced records land in the hermes layer (first-class)', () => {
  seq += 1;
  const p = openPortfolioDb(join(dir, `p-${seq}.sqlite`));
  const dates = weekdays('20261016', 30);
  const m = market(dates);
  try {
    recordResearchJournal(p, entry('hermes-1', '20261022', {
      source: 'hermes', provenance: { author: 'hermes', source_reference: 'mcp:e2e', obtained_at: at('20261022') },
    }));
    const res = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261023', horizon: 5, feeEstimator });
    assert.equal(res.records.by_source.hermes, 1);
    assert.ok(res.layers.hermes);
  } finally { p.close(); m.close(); }
});
