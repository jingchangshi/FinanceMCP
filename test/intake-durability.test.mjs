import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

// Durability of the ChatGPT append path: a record survives a process restart, a failed insert leaves no partial
// row, and concurrent writers of one idempotency key from separate processes create exactly one record.
const ROOT = process.cwd();
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'intake-durability-'));
const MARKET = join(dir, 'market-unused.sqlite');
const CHILD = join(dir, 'append-child.mjs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { appendChatgptResearchRecord } = await import('../build/portfolio/chatgptIntake.js');
const { recordResearchJournal, readResearchJournal } = await import('../build/portfolio/researchJournal.js');

const ACCOUNT = 'synthetic-durability';
const AS_OF = '20261022';
const BUNDLE = 'BUNDLE-20261022-0123456789abcdef0123';
const NOW = Date.parse('2026-10-24T10:00:00+08:00');
const body = {
  as_of_trade_date: AS_OF, report_id: BUNDLE, idempotency_key: 'durability-1',
  independent_judgement: '独立判断：维持观察。', final_conclusion: '维持观察，不构成交易建议。',
  additional_evidence: [{ claim: '央行公开市场操作净投放', kind: 'macro', source_url: 'https://example.com/a', published_at: '2026-10-22' }],
};

// Separate process: opens the database fresh, appends once, and reports the result as JSON on stdout.
// The result goes to a file, not stdout: config.ts logs on import, so stdout is not a clean channel.
writeFileSync(CHILD, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, dbPath, marketPath, bodyJson, nowText, resultPath] = process.argv.slice(2);
const load = name => import(pathToFileURL(join(root, 'build', name)).href);
const { openPortfolioDb } = await load('portfolio/db.js');
const { appendChatgptResearchRecord } = await load('portfolio/chatgptIntake.js');
const db = openPortfolioDb(dbPath, { marketPath });
let outcome;
try {
  outcome = { ok: true, ...appendChatgptResearchRecord(db, ${JSON.stringify(ACCOUNT)}, JSON.parse(bodyJson), Number(nowText)) };
} catch (error) {
  outcome = { ok: false, message: String(error?.message ?? error) };
} finally { db.close(); }
writeFileSync(resultPath, JSON.stringify(outcome));
`);

// Each test gets its own database file so counts never leak between tests.
let seq = 0;
const newFile = () => join(dir, `portfolio-${seq += 1}.sqlite`);
function openDb(file) {
  return openPortfolioDb(file, { marketPath: MARKET });
}
// The VPS side is written through the journal's own writer; the scheduled-snapshot path is covered elsewhere.
function seedVps(db) {
  recordResearchJournal(db, {
    record_id: `VPS-${BUNDLE}`, account_id: ACCOUNT, source: 'vps', as_of_trade_date: AS_OF, bundle_id: BUNDLE,
    generated_at: '2026-10-22T10:00:00Z', versions: { bundle: 'durability-test' }, judgement: {}, candidates: [], observations: [], evidence: [],
  });
}
function chatgptCount(db) {
  return db.prepare("SELECT COUNT(*) n FROM research_journal WHERE source='chatgpt' AND account_id=?").get(ACCOUNT).n;
}
function totalCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM research_journal').get().n;
}
let resultSeq = 0;
async function appendInChild(file) {
  const resultPath = join(dir, `result-${resultSeq += 1}.json`);
  await run(process.execPath, [CHILD, ROOT, file, MARKET, JSON.stringify(body), String(NOW), resultPath], { encoding: 'utf8' });
  return JSON.parse(readFileSync(resultPath, 'utf8'));
}

test('a record appended in one process is found unchanged by a new process after reopen', async () => {
  const file = newFile();
  const db = openDb(file);
  try {
    seedVps(db);
    const first = appendChatgptResearchRecord(db, ACCOUNT, body, NOW);
    assert.equal(first.created, true);
  } finally { db.close(); }

  const again = await appendInChild(file);
  assert.equal(again.ok, true, again.message);
  assert.equal(again.created, false);

  const reopened = openDb(file);
  try {
    const stored = readResearchJournal(reopened, again.record_id);
    assert.ok(stored, 'record must still be present after reopen');
    assert.equal(stored.source, 'chatgpt');
    assert.equal(stored.content_hash, again.content_hash);
    assert.equal(chatgptCount(reopened), 1);
  } finally { reopened.close(); }
});

test('a write that fails inside the insert leaves no partial record, and a retry after the fault creates exactly one', () => {
  const db = openDb(newFile());
  try {
    seedVps(db);
    const before = totalCount(db);
    db.exec(`CREATE TRIGGER fail_chatgpt_insert BEFORE INSERT ON research_journal WHEN NEW.source='chatgpt'
      BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;`);
    assert.throws(() => appendChatgptResearchRecord(db, ACCOUNT, body, NOW), /simulated write failure/);
    assert.equal(chatgptCount(db), 0, 'a failed insert must not leave a ChatGPT row');
    assert.equal(totalCount(db), before, 'a failed insert must not change the journal');

    db.exec('DROP TRIGGER fail_chatgpt_insert');
    const retry = appendChatgptResearchRecord(db, ACCOUNT, body, NOW);
    assert.equal(retry.created, true);
    assert.equal(chatgptCount(db), 1);
    assert.equal(totalCount(db), before + 1);
  } finally { db.close(); }
});

test('concurrent appends of one idempotency key from separate processes create exactly one record', async () => {
  const file = newFile();
  const db = openDb(file);
  try { seedVps(db); } finally { db.close(); }

  const results = await Promise.all([0, 1, 2, 3].map(() => appendInChild(file)));
  for (const result of results) assert.equal(result.ok, true, result.message);
  assert.equal(results.filter(result => result.created).length, 1, 'exactly one process may create the record');
  assert.equal(new Set(results.map(result => result.record_id)).size, 1, 'every process must resolve the same record_id');

  const check = openDb(file);
  try {
    assert.equal(chatgptCount(check), 1);
  } finally { check.close(); }
});
