// goal-1106: hotspot pointer NULL payload + gzip ledger, opportunities cap,
// CLI summary, and hermes as a first-class journal source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { saveHotspotSnapshot, snapshotContentHash, loadHotspotVersion, loadHotspotVersionByHash,
  loadHotspotSnapshot, decodeLedgerPayload, encodeLedgerPayload, stableJson, isCurrentSnapshot } =
  await import('../build/ashare/hotspotSnapshots.js');
const { ensureHotspotSchema } = await import('../build/ashare/hotspotTables.js');
const { runAshareTool } = await import('../build/ashare/tools.js');
const { runCommand } = await import('../build/ashare/commands.js');
const { appendChatgptResearchRecord, parseIntakeArgs } = await import('../build/portfolio/chatgptIntake.js');
const { recordResearchJournal, readResearchJournal, JOURNAL_SOURCES } = await import('../build/portfolio/researchJournal.js');
const { appendCombinedResearch } = await import('../build/portfolio/combinedResearch.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { openAshareDb } = await import('../build/ashare/db.js');
const { initBaseline } = await import('../build/portfolio/ledger.js');
const { recordVpsResearchSnapshot } = await import('../build/portfolio/researchRecord.js');

/** A minimal but fully shaped V2 snapshot body with N stocks. */
function snapshot(overrides = {}, n = 3) {
  const stocks = Array.from({ length: n }, (_, i) => ({
    ts_code: `${String(600000 + i).padStart(6, '0')}.SH`, research_state: 'FOCUS',
  }));
  const view = {
    status: 'OK', as_of: '20261030', framework_version: 'technical-v2.0.0',
    implementation_fingerprint: 'sha256:impl-1', market_regime: 'range',
    families: [], contexts: [], coverage: {},
    research_universe: { as_of: '20261030', counts: { total: n, FOCUS: n }, stocks, daily_highlights: stocks.slice(0, 3).map(s => s.ts_code) },
    evidence_level: 'UNVERIFIED', research_only: true,
  };
  return {
    as_of: '20261030', framework: 'V2_ONLY', framework_version: 'technical-v2.0.0',
    implementation_fingerprint: 'sha256:impl-1', config_version: 'hotspot-config-1.0.0',
    content_hash: '', data_quality: 'READY', market_data_as_of: '20261030',
    generated_at: '2026-10-30T11:42:47.226Z',
    sectors: { as_of: '20261030', config_version: 'hotspot-config-1.0.0', sectors: [], selected: [], coverage: [] },
    technical_view: view, coverage: [],
    data_state: { version: 'data-readiness-1.0.0', as_of: '20261030', fingerprint: { bars: { daily: 1 } }, readiness: 'READY' },
    research_only: true, ...overrides,
  };
}

// ---------------------------------------------------------------- storage

test('storage: new pointer rows store NULL payload; ledger stores gzip and keeps the hash', () => {
  const db = new DatabaseSync(':memory:');
  const saved = saveHotspotSnapshot(db, snapshot({}, 60));
  const pointer = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get('20261030');
  assert.equal(pointer.payload, null, 'the pointer must not duplicate the ledger body');
  const ledger = db.prepare('SELECT payload, payload_format, content_hash FROM hotspot_snapshot_version WHERE version_no = 1').get();
  assert.equal(ledger.payload_format, 'gzip+json');
  assert.equal(new Uint8Array(ledger.payload)[0], 0x1f, 'stored bytes are gzip (magic) not JSON text');
  // content_hash is computed over the UNCOMPRESSED body: recompute it from the decoded row.
  const decoded = decodeLedgerPayload(ledger.payload, ledger.payload_format);
  assert.equal(snapshotContentHash(decoded), ledger.content_hash, 'the hash survived compression');
  assert.equal(saved.content_hash, ledger.content_hash);
  assert.equal(decodeLedgerPayload(ledger.payload, ledger.payload_format).technical_view.research_universe.stocks.length, 60);
  // Pointer resolution through the ledger.
  const viaPointer = loadHotspotSnapshot(db, '20261030');
  assert.equal(viaPointer.technical_view.research_universe.stocks.length, 60);
  assert.equal(viaPointer.version_no, 1);
  assert.equal(loadHotspotVersionByHash(db, saved.content_hash).technical_view.research_universe.stocks.length, 60);
  db.close();
});

test('storage: round-trip — gzip encode/decode returns the identical JSON body', () => {
  const json = stableJson({ b: 1, a: [1, 2, { d: 'x', c: 'y' }] });
  const enc = encodeLedgerPayload(json);
  assert.equal(enc.payload_format, 'gzip+json');
  assert.deepEqual(decodeLedgerPayload(enc.payload, enc.payload_format), JSON.parse(json));
});

test('storage: legacy uncompressed rows still read; pointer payload is preserved by the rebuild', () => {
  // A database as it existed before goal-1106: NOT NULL pointer, no
  // payload_format column, plain-JSON ledger rows.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE hotspot_snapshot (
    as_of TEXT NOT NULL, config_version TEXT NOT NULL, strategy_set_version TEXT,
    payload TEXT NOT NULL, content_hash TEXT, generated_at TEXT NOT NULL, coverage TEXT,
    version_no INTEGER, state TEXT, PRIMARY KEY (as_of, config_version))`);
  db.exec(`CREATE TABLE hotspot_snapshot_version (
    as_of TEXT NOT NULL, config_version TEXT NOT NULL, version_no INTEGER NOT NULL,
    content_hash TEXT NOT NULL, hash_basis TEXT NOT NULL DEFAULT 'v2',
    strategy_set_version TEXT, payload TEXT NOT NULL, coverage TEXT,
    generated_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PUBLISHED','SUPERSEDED','CORRECTION')),
    superseded_by INTEGER, correction_of INTEGER, readiness TEXT, data_state TEXT,
    first_cited_by TEXT, first_cited_at TEXT,
    PRIMARY KEY (as_of, config_version, version_no),
    UNIQUE (as_of, config_version, content_hash))`);
  const legacy = snapshot({}, 2);
  const legacyHash = snapshotContentHash(legacy);
  const body = stableJson({ ...legacy, content_hash: legacyHash, version_no: 1 });
  db.prepare(`INSERT INTO hotspot_snapshot_version
    (as_of, config_version, version_no, content_hash, hash_basis, strategy_set_version, payload, coverage,
     generated_at, recorded_at, state, superseded_by, correction_of, readiness, data_state)
    VALUES ('20261030','hotspot-config-1.0.0',1,?,'v3','fw',?,null,'2026-10-30T11:42:47.226Z','2026-10-30T11:42:47.226Z','PUBLISHED',null,null,'READY',null)`)
    .run(legacyHash, body);
  db.prepare(`INSERT INTO hotspot_snapshot (as_of, config_version, strategy_set_version, payload, content_hash, generated_at, coverage, version_no, state)
    VALUES ('20261030','hotspot-config-1.0.0','fw',?,?,'2026-10-30T11:42:47.226Z',null,1,'PUBLISHED')`)
    .run(body, legacyHash);

  ensureHotspotSchema(db);
  // The rebuild preserved the row verbatim; the ledger gained the marker column.
  const ptrRow = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get('20261030');
  assert.equal(ptrRow.payload.length > 100, true, 'legacy pointer payload preserved, not dropped');
  const ledgerCols = (db.prepare('PRAGMA table_info(hotspot_snapshot_version)').all()).map(c => c.name);
  assert.ok(ledgerCols.includes('payload_format'), 'additive column added on first ensure');
  // Old JSON rows decode without a marker, and the ledger row is read as json.
  const version = loadHotspotVersion(db, '20261030', 'hotspot-config-1.0.0', 1);
  assert.equal(version.technical_view.research_universe.stocks.length, 2);
  const viaPointer = loadHotspotSnapshot(db, '20261030');
  assert.equal(viaPointer.technical_view.research_universe.stocks.length, 2);
  // New saves on the migrated database write NULL pointers like fresh ones.
  const big = snapshot({}, 40);
  saveHotspotSnapshot(db, big);
  const newPointer = db.prepare('SELECT payload FROM hotspot_snapshot WHERE as_of = ?').get('20261030');
  assert.equal(newPointer.payload, null);
  const resolved = loadHotspotSnapshot(db, '20261030');
  assert.equal(resolved.technical_view.research_universe.stocks.length, 40);
  db.close();
});

// ---------------------------------------------------------------- opportunities cap

function marketDirWithSnapshot(n) {
  const dir = mkdtempSync(join(tmpdir(), 'hotspot-cap-'));
  const path = join(dir, 'ashare.sqlite');
  // The MCP read path (getAshareDb) requires the current market schema.
  const db = openAshareDb(path);
  saveHotspotSnapshot(db, snapshot({}, n));
  db.close();
  return dir;
}

test('opportunities: unfiltered default caps at 50 with truncation flags; filtered returns all matches', async () => {
  const prev = process.env.ASHARE_DATA_DIR;
  process.env.ASHARE_DATA_DIR = marketDirWithSnapshot(100);
  try {
    const parsed = async (args) => JSON.parse((await runAshareTool('ashare_hotspot_opportunities', args)).content[0].text);
    const def = await parsed({ date: '20261030' });
    assert.equal(def.total_matched, 100);
    assert.equal(def.returned, 50);
    assert.equal(def.stocks.length, 50);
    assert.equal(def.truncated, true);
    assert.equal(def.daily_highlights.length, 3, 'highlights are always included in full');
    const filtered = await parsed({ date: '20261030', research_state: 'FOCUS' });
    assert.equal(filtered.total_matched, 100);
    assert.equal(filtered.returned, 100, 'a filter defaults to all matches');
    assert.equal(filtered.truncated, false);
    const ten = await parsed({ date: '20261030', max_stocks: 10 });
    assert.equal(ten.returned, 10);
    assert.equal(ten.truncated, true);
    const clampedFiltered = await parsed({ date: '20261030', research_state: 'FOCUS', max_stocks: 99999 });
    assert.equal(clampedFiltered.returned, 100, 'still well under the 2000 filter cap');
    const clampedPlain = await parsed({ date: '20261030', max_stocks: 99999 });
    assert.equal(clampedPlain.returned, 100, 'unfiltered clamp at 500 does not cut 100 stocks');
    const none = await parsed({ date: '20261030', research_state: 'BLOCKED' });
    assert.equal(none.total_matched, 0);
    assert.equal(none.truncated, false);
  } finally {
    if (prev === undefined) delete process.env.ASHARE_DATA_DIR; else process.env.ASHARE_DATA_DIR = prev;
  }
});

// ---------------------------------------------------------------- CLI summary

test('CLI: hotspot-snapshot prints a summary by default and the full body with --full', async () => {
  const db = openAshareDb(':memory:');
  try {
    const printed = [];
    const h = {
      arg: () => undefined,
      flag: (name) => name === 'full',
      ymd: (v) => String(v),
      print: (v) => printed.push(v),
    };
    // Empty market tables so the pipeline reaches a real (NOT_READY) result.
    db.exec(`CREATE TABLE IF NOT EXISTS watchlist (trade_date TEXT, ts_code TEXT);
      INSERT INTO trade_cal (cal_date, is_open) VALUES ('20261030', 1);`);
    await runCommand(db, 'hotspot-snapshot', h);
    assert.equal(printed.length, 1);
    assert.ok(printed[0].snapshot, 'summary nests the snapshot fields the deploy-script jq reads');
    assert.equal(typeof printed[0].snapshot.as_of, 'string');
    assert.ok('counts' in (printed[0].snapshot.technical_view?.research_universe ?? {}),
      'backward-compatible counts path retained for run-hotspot-daily.sh');
    assert.ok('readiness' in printed[0]);
    // --full must print the whole snapshot (technical_view.stocks included).
    const full = [];
    await runCommand(db, 'hotspot-snapshot', { ...h, flag: (n) => n === 'full', print: (v) => full.push(v) });
    assert.ok(Array.isArray(full[0].snapshot.technical_view.research_universe.stocks),
      '--full prints the complete snapshot body');
  } finally { db.close(); }
});

// ---------------------------------------------------------------- hermes journal

const ACCOUNT = 'synthetic-hermes';
const dir = mkdtempSync(join(tmpdir(), 'hermes-journal-'));
const MARKET_DB = join(dir, 'ashare.sqlite');
const at = (ymd, hm = '12:00') => Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T${hm}:00+08:00`);
let seq = 0;
function fresh() {
  const file = join(dir, `portfolio-${seq += 1}.sqlite`);
  const imported = spawnSync(process.execPath, [join(process.cwd(), 'build', 'ashare', 'cli.js'), 'portfolio-import'], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: MARKET_DB, ASHARE_PORTFOLIO_DB_PATH: file },
  });
  assert.equal(imported.status, 0, imported.stderr);
  const db = openPortfolioDb(file, { marketPath: MARKET_DB });
  initBaseline(db, ACCOUNT, { asOf: '20261018', snapshotId: 'demo-2026-10-18' });
  return db;
}
function vps(db, asOf, reportId) {
  const ActualDate = globalThis.Date;
  const nowMs = at(asOf, '18:00');
  globalThis.Date = class extends ActualDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
  };
  try {
    recordVpsResearchSnapshot({ portfolioDb: db, accountId: ACCOUNT, bundle: { report_id: reportId, as_of_trade_date: asOf, status: 'READY', generated_at: `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6)}T18:00:00+08:00` } });
  } finally { globalThis.Date = ActualDate; }
  return db;
}
const body = (extra = {}) => ({
  report_id: 'RPT-1', as_of_trade_date: '20261022',
  independent_judgement: '独立判断', final_conclusion: '维持观察',
  additional_evidence: [],
  ...extra,
});
const NOW = at('20261022', '20:00');

test('journal sources include hermes as a first-class source', () => {
  assert.deepEqual([...JOURNAL_SOURCES], ['vps', 'chatgpt', 'hermes', 'combined']);
});

test('hermes append records source=hermes and provenance.author=hermes', () => {
  const db = vps(fresh(), '20261022', 'RPT-1');
  try {
    const first = appendChatgptResearchRecord(db, ACCOUNT, body({ source: 'hermes', idempotency_key: 'h1' }), NOW);
    assert.equal(first.created, true);
    assert.match(first.record_id, /^HERMES-20261022-/);
    const stored = readResearchJournal(db, first.record_id);
    assert.equal(stored.source, 'hermes');
    assert.equal(stored.provenance.author, 'hermes');
    // A caller that omits source still lands on chatgpt (historical default).
    const chatgpt = appendChatgptResearchRecord(db, ACCOUNT, body({ idempotency_key: 'c1' }), NOW);
    assert.match(chatgpt.record_id, /^CHATGPT-20261022-/);
    assert.equal(readResearchJournal(db, chatgpt.record_id).source, 'chatgpt');
    assert.equal(readResearchJournal(db, chatgpt.record_id).provenance.author, 'chatgpt');
    // Unknown sources are refused.
    assert.throws(() => parseIntakeArgs(body({ source: 'claude' }), NOW), /source must be chatgpt or hermes/);
  } finally { db.close(); }
});

test('corrections work across external sources; VPS records still cannot be corrected', () => {
  const db = vps(fresh(), '20261022', 'RPT-1');
  try {
    const chatgpt = appendChatgptResearchRecord(db, ACCOUNT, body({ idempotency_key: 'c1' }), NOW);
    // hermes correcting a chatgpt record is allowed (external-LLM correction).
    const fix = appendChatgptResearchRecord(db, ACCOUNT, body({ source: 'hermes', idempotency_key: 'h-fix', corrects_record_id: chatgpt.record_id, final_conclusion: '更正结论' }), NOW);
    assert.equal(fix.created, true);
    assert.equal(readResearchJournal(db, fix.record_id).correction_of, chatgpt.record_id);
    // VPS records are not correctable targets.
    const vpsId = db.prepare("SELECT record_id FROM research_journal WHERE source='vps'").get().record_id;
    assert.throws(() => appendChatgptResearchRecord(db, ACCOUNT, body({ source: 'hermes', idempotency_key: 'h2', corrects_record_id: vpsId }), NOW), /existing ChatGPT record/);
  } finally { db.close(); }
});

test('the daily external cap is shared across chatgpt and hermes', () => {
  const db = vps(fresh(), '20261022', 'RPT-1');
  try {
    appendChatgptResearchRecord(db, ACCOUNT, body({ idempotency_key: 'a' }), NOW, 1);
    assert.throws(() => appendChatgptResearchRecord(db, ACCOUNT, body({ source: 'hermes', idempotency_key: 'b' }), NOW, 1), /rate_limited/);
  } finally { db.close(); }
});

test('combined accepts a hermes parent and rejects a day with no external parent', () => {
  const db = vps(fresh(), '20261022', 'RPT-1');
  try {
    assert.throws(() => appendCombinedResearch(db, { accountId: ACCOUNT, asOf: '20261022', nowMs: NOW }),
      /combined_inputs_incomplete.*external/s);
    const hermes = appendChatgptResearchRecord(db, ACCOUNT, body({ source: 'hermes', idempotency_key: 'h1' }), NOW);
    const combined = appendCombinedResearch(db, { accountId: ACCOUNT, asOf: '20261022', nowMs: NOW });
    assert.equal(combined.created, true);
    assert.equal(combined.chatgpt_record_id, hermes.record_id);
    const stored = readResearchJournal(db, combined.record_id);
    assert.deepEqual(new Set(stored.parent_record_ids), new Set([combined.vps_record_id, hermes.record_id]));
  } finally { db.close(); }
});

test('journal-level combined record accepts vps+hermes parents', () => {
  const db = new DatabaseSync(':memory:');
  const provenance = { author: 'x', source_reference: 'y', obtained_at: '2026-10-01T21:45:00+08:00' };
  const rec = (id, source) => ({
    record_id: id, account_id: 'synthetic', source, as_of_trade_date: '20261001',
    bundle_id: 'bundle-1', generated_at: '2026-10-01T21:40:00+08:00', versions: { rules: 'v1' },
    judgement: { conclusion: 'observe' }, candidates: [], observations: [], evidence: [],
  });
  try {
    recordResearchJournal(db, rec('r1', 'vps'));
    recordResearchJournal(db, { ...rec('h1', 'hermes'), provenance });
    assert.equal(recordResearchJournal(db, { ...rec('c1', 'combined'), parent_record_ids: ['r1', 'h1'], provenance }).created, true);
  } finally { db.close(); }
});
