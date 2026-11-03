import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  saveHotspotSnapshot, snapshotContentHash,
  loadHotspotVersion, listHotspotVersions, loadHotspotSnapshot, isCurrentSnapshot,
} from '../build/ashare/hotspotSnapshots.js';
import { checkDataReadiness } from '../build/ashare/dataReadiness.js';

const save = saveHotspotSnapshot;
const hashOf = snapshotContentHash;

/** A minimal but fully shaped V2 snapshot body. */
function snapshot(overrides = {}) {
  const view = {
    status: 'OK',
    as_of: '20261030',
    framework_version: 'technical-v2.0.0',
    implementation_fingerprint: 'sha256:impl-1',
    market_regime: 'range',
    families: [],
    contexts: [],
    coverage: {},
    research_universe: { as_of: '20261030', counts: { total: 0 }, stocks: [], daily_highlights: [] },
    evidence_level: 'UNVERIFIED',
    research_only: true,
  };
  return {
    as_of: '20261030',
    framework: 'V2_ONLY',
    framework_version: 'technical-v2.0.0',
    implementation_fingerprint: 'sha256:impl-1',
    config_version: 'hotspot-config-1.0.0',
    content_hash: '',
    data_quality: 'READY',
    market_data_as_of: '20261030',
    generated_at: '2026-10-30T11:42:47.226Z',
    sectors: { as_of: '20261030', config_version: 'hotspot-config-1.0.0', sectors: [], selected: [], coverage: [] },
    technical_view: view,
    coverage: [],
    data_state: {
      version: 'data-readiness-1.0.0', as_of: '20261030', fingerprint: { bars: { daily: 1 } },
      readiness: 'READY',
    },
    research_only: true,
    ...overrides,
  };
}

/** Same snapshot with one extra research record — different content, same day. */
function withStock(code) {
  const base = snapshot();
  return snapshot({
    technical_view: {
      ...base.technical_view,
      research_universe: {
        ...base.technical_view.research_universe,
        counts: { total: 1, FOCUS: 1 },
        stocks: [{ ts_code: code, research_state: 'FOCUS' }],
        daily_highlights: [code],
      },
    },
  });
}

test('snapshot versioning: a repeated save is UNCHANGED and appends nothing', () => {
  const db = new DatabaseSync(':memory:');
  const first = save(db, snapshot());
  assert.equal(first.state, 'INSERTED');
  assert.equal(first.version_no, 1);
  const before = db.prepare('SELECT COUNT(*) c FROM hotspot_snapshot_version').get().c;
  const again = save(db, snapshot());
  assert.equal(again.state, 'UNCHANGED');
  assert.equal(again.version_no, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM hotspot_snapshot_version').get().c, before);
  assert.equal(listHotspotVersions(db, '20261030').length, 1, 'no version churn for identical content is only real if the ledger says so');
});

test('snapshot versioning: new content appends a version and supersedes the old one', () => {
  const db = new DatabaseSync(':memory:');
  save(db, snapshot());
  const second = save(db, withStock('600001.SH'));
  assert.equal(second.state, 'PUBLISHED');
  assert.equal(second.version_no, 2);
  assert.equal(second.superseded_version, 1);
  const rows = listHotspotVersions(db, '20261030');
  assert.equal(rows.length, 2);
  const v2 = rows.find(r => r.version_no === 2);
  const v1 = rows.find(r => r.version_no === 1);
  assert.equal(v2.state, 'PUBLISHED');
  assert.equal(v1.state, 'SUPERSEDED');
  assert.equal(v1.superseded_by, 2);
  // The superseded version is exactly what the ledger exists to preserve.
  const kept = loadHotspotVersion(db, '20261030', 'hotspot-config-1.0.0', 1);
  assert.ok(kept, 'version 1 payload must still be readable');
  assert.deepEqual(kept.technical_view.research_universe.stocks, [], 'the archived version keeps its own view');
  const pointer = loadHotspotSnapshot(db, '20261030');
  assert.equal(pointer.version_no, 2, 'the pointer must name the version it points at');
  assert.equal(pointer.content_hash, second.content_hash);
});

test('snapshot reads: position and state come from the row, not from the serialized payload', () => {
  const db = new DatabaseSync(':memory:');
  save(db, snapshot());
  save(db, withStock('600002.SH'));
  // The stored payload of version 1 says PUBLISHED because that is what it was
  // when written. The ledger now says SUPERSEDED, and the ledger wins.
  const v1 = loadHotspotVersion(db, '20261030', 'hotspot-config-1.0.0', 1);
  assert.equal(v1.state, 'SUPERSEDED', 'a superseded payload must not keep reporting PUBLISHED');
  assert.equal(v1.version_no, 1);
  const current = loadHotspotSnapshot(db, '20261030');
  assert.equal(current.state, 'PUBLISHED');
  assert.equal(current.version_no, 2);

  // A pointer row written before the ledger existed has no position. That is
  // reported as absent — never invented as version 1.
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE hotspot_snapshot (as_of TEXT NOT NULL, config_version TEXT NOT NULL,
    strategy_set_version TEXT, payload TEXT NOT NULL, content_hash TEXT, generated_at TEXT NOT NULL,
    coverage TEXT, version_no INTEGER, state TEXT, PRIMARY KEY (as_of, config_version))`);
  legacy.prepare(`INSERT INTO hotspot_snapshot VALUES ('20261030','cfg','ss','{"as_of":"20261030"}',NULL,'t',NULL,NULL,NULL)`).run();
  const old = loadHotspotSnapshot(legacy, '20261030');
  assert.equal(old.version_no, undefined, 'a pre-ledger row must not claim a ledger position');
  assert.equal(isCurrentSnapshot(old), false, 'a pre-V2 archive is not a current research view');
});

test('snapshot versioning: the ledger rejects edits and deletes', () => {
  const db = new DatabaseSync(':memory:');
  save(db, snapshot());
  assert.throws(
    () => db.prepare("UPDATE hotspot_snapshot_version SET payload = '{\"tampered\":true}' WHERE version_no = 1").run(),
    /immutable/,
  );
  assert.throws(() => db.prepare('DELETE FROM hotspot_snapshot_version WHERE version_no = 1').run(), /append-only/);
  // Lifecycle columns must still move, or supersession would be impossible.
  db.prepare("UPDATE hotspot_snapshot_version SET state = 'SUPERSEDED', superseded_by = 99 WHERE version_no = 1").run();
});

test('content_hash basis v3: the V2 view, the fingerprint and the data are the identity; the clock is not', () => {
  const base = snapshot();
  // Same content twice, and a second look at the clock: one identity.
  assert.equal(hashOf(base), hashOf(snapshot()));
  assert.equal(hashOf(base), hashOf(snapshot({ generated_at: '2026-10-30T23:59:59.000Z' })));
  assert.equal(
    hashOf(snapshot({ data_state: { ...base.data_state, checked_at: 'later' } })),
    hashOf(snapshot({ data_state: { ...base.data_state, checked_at: 'earlier' } })),
  );

  // Each identity component changes the hash.
  assert.notEqual(hashOf(withStock('600001.SH')), hashOf(base), 'the research view is part of the identity');
  assert.notEqual(hashOf(snapshot({ implementation_fingerprint: 'sha256:impl-2' })), hashOf(base), 'the compiled fingerprint is part of the identity');
  assert.notEqual(
    hashOf(snapshot({ data_state: { ...base.data_state, fingerprint: { bars: { daily: 2 } } } })),
    hashOf(base), 'the data fingerprint is part of the identity',
  );
  assert.notEqual(hashOf(snapshot({ framework_version: 'technical-v2.0.1' })), hashOf(base), 'the framework version is part of the identity');

  // The stored basis travels with the row so nobody can "prove" a change by rehashing.
  const db = new DatabaseSync(':memory:');
  const r = save(db, base);
  assert.equal(r.hash_basis, 'v3');
  assert.equal(listHotspotVersions(db, '20261030')[0].hash_basis, 'v3');
});

test('isCurrentSnapshot accepts only the V2 research shape', () => {
  assert.equal(isCurrentSnapshot(snapshot()), true);
  assert.equal(isCurrentSnapshot(null), false);
  assert.equal(isCurrentSnapshot(undefined), false);
  assert.equal(isCurrentSnapshot({ as_of: '20261030' }), false);
  assert.equal(isCurrentSnapshot({ framework: 'V1', technical_view: {} }), false);
  assert.equal(isCurrentSnapshot({ framework: 'V2_ONLY' }), false);
});

test('readiness gate: no bars means NOT_READY, and asking creates no tables', () => {
  const db = new DatabaseSync(':memory:');
  const r = checkDataReadiness(db, '20261030');
  assert.equal(r.status, 'NOT_READY');
  assert.equal(r.checks.bars_present, false);
  assert.match(r.reason, /no daily bars/);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.equal(tables.length, 0, 'the readiness check is read-only; it must not create the schema');
});
