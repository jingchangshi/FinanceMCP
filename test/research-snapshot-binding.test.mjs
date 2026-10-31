import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// goal-1032 follow-up: every research record that cites hotspot facts must be
// bound to the snapshot version it cites — not only the VPS bundle.
//
// ChatGPT (chatgptIntake) and combined (combinedResearch) records used to be
// written with no binding at all: the pointer resolution lived inside
// bundleRecordCli. This pins the shared resolver at all three writers, plus the
// "no snapshot, no binding" rule that keeps an unknown version unknown.

const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));

const dir = mkdtempSync(join(tmpdir(), 'binding-test-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const researchJournal = await load('portfolio/researchJournal.js');
const chatgptIntake = await load('portfolio/chatgptIntake.js');
const combinedResearch = await load('portfolio/combinedResearch.js');

const ACCOUNT = 'real-main';

function pair(name) {
  const market = openAshareDb(join(dir, `market-${name}.sqlite`));
  const portfolio = openPortfolioDb(join(dir, `portfolio-${name}.sqlite`), { writable: true });
  return { market, portfolio };
}

/** The pointer table as production has it. Only the columns the resolver reads. */
function seedSnapshot(market, rows) {
  market.exec(`CREATE TABLE IF NOT EXISTS hotspot_snapshot (
    as_of TEXT NOT NULL, config_version TEXT NOT NULL, payload TEXT NOT NULL,
    content_hash TEXT, generated_at TEXT NOT NULL, coverage TEXT,
    version_no INTEGER, state TEXT, PRIMARY KEY (as_of, config_version))`);
  const insert = market.prepare('INSERT INTO hotspot_snapshot (as_of, config_version, payload, content_hash, generated_at, version_no, state) VALUES (?,?,?,?,?,?,?)');
  for (const r of rows) insert.run(r.as_of, r.config_version, '{}', r.content_hash, '2026-10-30T10:22:04.000Z', r.version_no, 'PUBLISHED');
}

function seedVps(db, { asOf, bundleId }) {
  return researchJournal.recordResearchJournal(db, {
    record_id: `VPS-${bundleId}`, account_id: ACCOUNT, source: 'vps',
    as_of_trade_date: asOf, bundle_id: bundleId,
    generated_at: `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6)}T13:16:00.000Z`,
    versions: { journal: 'test-v1', rules: 'seed' }, judgement: 'NO_ACTION',
    candidates: [], observations: [], evidence: [], payload: { report_id: bundleId },
  });
}

const bindingOf = (db, recordId) =>
  db.prepare('SELECT * FROM research_hotspot_binding WHERE record_id=?').get(recordId) ?? null;

test('ChatGPT record is bound to the snapshot version it cites', () => {
  const { market, portfolio } = pair('chatgpt');
  try {
    seedSnapshot(market, [{ as_of: '20261030', config_version: 'hotspot-config-1.0.0', content_hash: 'sha256:aaa', version_no: 1 }]);
    seedVps(portfolio, { asOf: '20261030', bundleId: 'BUNDLE-20261030-a' });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-20261030-a', as_of_trade_date: '20261030',
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now(), undefined, { market });
    assert.equal(intake.created, true);
    const row = bindingOf(portfolio, intake.record_id);
    assert.ok(row, 'ChatGPT record must carry a binding');
    assert.equal(row.as_of_trade_date, '20261030');
    assert.equal(row.hotspot_as_of, '20261030');
    assert.equal(row.config_version, 'hotspot-config-1.0.0');
    assert.equal(row.version_no, 1);
    assert.equal(row.content_hash, 'sha256:aaa');
    assert.equal(row.binding_basis, 'BUNDLE');
  } finally { portfolio.close(); market.close(); }
});

test('combined record is bound to the same snapshot version', () => {
  const { market, portfolio } = pair('combined');
  try {
    seedSnapshot(market, [{ as_of: '20261030', config_version: 'hotspot-config-1.0.0', content_hash: 'sha256:bbb', version_no: 3 }]);
    const vps = seedVps(portfolio, { asOf: '20261030', bundleId: 'BUNDLE-20261030-b' });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-20261030-b', as_of_trade_date: '20261030',
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now(), undefined, { market });
    const combined = combinedResearch.appendCombinedResearch(portfolio, {
      accountId: ACCOUNT, asOf: '20261030', vpsRecordId: vps.record.record_id,
      chatgptRecordId: intake.record_id, market,
    });
    assert.equal(combined.created, true);
    const row = bindingOf(portfolio, combined.record_id);
    assert.ok(row, 'combined record must carry a binding');
    assert.equal(row.version_no, 3);
    assert.equal(row.content_hash, 'sha256:bbb');
    assert.equal(row.binding_basis, 'BUNDLE');
  } finally { portfolio.close(); market.close(); }
});

test('the binding names the version readers would select (highest config_version)', () => {
  const { market, portfolio } = pair('latest');
  try {
    seedSnapshot(market, [
      { as_of: '20261030', config_version: 'hotspot-config-0.9.0', content_hash: 'sha256:old', version_no: 1 },
      { as_of: '20261030', config_version: 'hotspot-config-1.0.0', content_hash: 'sha256:new', version_no: 2 },
    ]);
    seedVps(portfolio, { asOf: '20261030', bundleId: 'BUNDLE-20261030-c' });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-20261030-c', as_of_trade_date: '20261030',
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now(), undefined, { market });
    const row = bindingOf(portfolio, intake.record_id);
    assert.equal(row.config_version, 'hotspot-config-1.0.0');
    assert.equal(row.version_no, 2);
    assert.equal(row.content_hash, 'sha256:new');
  } finally { portfolio.close(); market.close(); }
});

test('no snapshot pointer: the record is written and stays unbound (never guessed)', () => {
  const { market, portfolio } = pair('unbound');
  try {
    seedVps(portfolio, { asOf: '20261030', bundleId: 'BUNDLE-20261030-d' });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-20261030-d', as_of_trade_date: '20261030',
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now(), undefined, { market });
    assert.equal(intake.created, true);
    assert.equal(bindingOf(portfolio, intake.record_id), null);
  } finally { portfolio.close(); market.close(); }
});

test('no market handle (tool called without a market DB): unbound, not an error', () => {
  const { market, portfolio } = pair('nomarket');
  try {
    seedSnapshot(market, [{ as_of: '20261030', config_version: 'hotspot-config-1.0.0', content_hash: 'sha256:ccc', version_no: 1 }]);
    seedVps(portfolio, { asOf: '20261030', bundleId: 'BUNDLE-20261030-e' });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-20261030-e', as_of_trade_date: '20261030',
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    assert.equal(intake.created, true);
    assert.equal(bindingOf(portfolio, intake.record_id), null);
  } finally { portfolio.close(); market.close(); }
});
