import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const build = resolve(process.env.NEWS_TEST_BUILD ?? 'build');
const { openNewsEvidenceDb, importNewsEvidence, listNewsEvidence, validateNewsEvidence } = await import(pathToFileURL(join(build, 'ashare/newsEvidence.js')));
const { marketBreadth } = await import(pathToFileURL(join(build, 'ashare/market.js')));
const item = { id: 'one', source_url: 'https://example.org/filing', publisher: 'Example', published_at: '2025-01-01T08:00:00+08:00', fetched_at: '2025-01-02T08:00:00+08:00', entity_codes: ['000001.SZ'], kind: 'NEWS', stance: 'NEUTRAL', title: 'Title', content_hash: 'a'.repeat(64) };

test('atomic import is idempotent, rejects conflicts and protects append-only rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-test-'));
  const path = join(dir, 'private', 'evidence.sqlite');
  const db = openNewsEvidenceDb(path);
  try {
    assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(importNewsEvidence(db, [item]), { inserted: 1, existing: 0 });
    assert.deepEqual(importNewsEvidence(db, [item]), { inserted: 0, existing: 1 });
    assert.throws(() => importNewsEvidence(db, [{ ...item, id: 'two', content_hash: 'b'.repeat(64) }, { ...item, title: 'changed' }]), /conflict/);
    assert.throws(() => importNewsEvidence(db, [{ ...item, id: 'two' }]), /conflict/);
    assert.equal(db.prepare('SELECT count(*) n FROM news_evidence').get().n, 1);
    assert.throws(() => db.exec("UPDATE news_evidence SET title='changed'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM news_evidence'), /append-only/);
    assert.throws(() => db.exec("INSERT OR REPLACE INTO news_evidence SELECT * FROM news_evidence"), /append-only/);
    assert.equal(listNewsEvidence(db, '20250101', ['000001.SZ']).length, 0);
    assert.equal(listNewsEvidence(db, '20250102', ['000001.SZ']).length, 1);
    assert.equal(listNewsEvidence(db, '20250102', ['other']).length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('validates URL and timestamps including future and impossible dates', () => {
  for (const source_url of ['file:///etc/passwd', 'https://', 'https://user:secret@example.org']) assert.throws(() => validateNewsEvidence({ ...item, source_url }));
  for (const published_at of ['2025-02-30T00:00:00Z', '2025-01-01', '2099-01-01T00:00:00Z']) assert.throws(() => validateNewsEvidence({ ...item, published_at }));
  assert.throws(() => validateNewsEvidence({ ...item, fetched_at: '2099-01-01T00:00:00Z' }));
  assert.throws(() => validateNewsEvidence({ ...item, fetched_at: '2024-12-31T00:00:00Z' }));
});

test('sentiment facts preserve missing and partial inputs as null', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE trade_cal (cal_date TEXT, is_open INTEGER);
      CREATE TABLE daily (ts_code TEXT, trade_date TEXT, pct_chg REAL, amount REAL, close REAL);
      CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL);
      INSERT INTO trade_cal VALUES ('20250102', 1);
      INSERT INTO daily VALUES ('A','20250102',1,100,10),('B','20250102',NULL,NULL,10);
      INSERT INTO stk_limit VALUES ('A','20250102',10,8);`);
    const partial = marketBreadth(db, '20250102').sentiment_facts;
    assert.equal(partial.quality.status, 'partial');
    for (const key of ['limit_up', 'limit_down', 'limit_up_ratio', 'limit_down_ratio', 'median_pct_chg', 'amount_vs_ma20']) assert.equal(partial[key], null, key);
    const missing = marketBreadth(db, '20250103').sentiment_facts;
    assert.equal(missing.quality.status, 'missing');
    assert.equal(missing.limit_up, null);
    assert.equal(missing.median_pct_chg, null);
  } finally { db.close(); }
});

test('complete sentiment facts use real limits, median and prior 20-day amount', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE trade_cal (cal_date TEXT, is_open INTEGER); CREATE TABLE daily (ts_code TEXT, trade_date TEXT, pct_chg REAL, amount REAL, close REAL); CREATE TABLE stk_limit (ts_code TEXT, trade_date TEXT, up_limit REAL, down_limit REAL)');
    for (let i = 1; i <= 21; i++) {
      const date = `202501${String(i).padStart(2, '0')}`;
      db.prepare('INSERT INTO trade_cal VALUES (?,1)').run(date);
      db.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('A', date, 2, i === 21 ? 200 : 100, 10);
      db.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('B', date, -1, i === 21 ? 200 : 100, 8);
      db.prepare('INSERT INTO stk_limit VALUES (?,?,?,?)').run('A', date, 10, 8);
      db.prepare('INSERT INTO stk_limit VALUES (?,?,?,?)').run('B', date, 10, 8);
    }
    const facts = marketBreadth(db, '20250121').sentiment_facts;
    assert.equal(facts.quality.status, 'complete');
    assert.equal(facts.limit_up, 1);
    assert.equal(facts.limit_down, 1);
    assert.equal(facts.limit_up_ratio, 0.5);
    assert.equal(facts.median_pct_chg, 0.5);
    assert.equal(facts.amount_vs_ma20, 2);
  } finally { db.close(); }
});
