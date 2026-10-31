import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  saveHotspotSnapshot, snapshotContentHash,
  loadHotspotVersion, listHotspotVersions, loadHotspotSnapshot,
} from '../build/ashare/hotspotSnapshots.js';
import { checkDataReadiness } from '../build/ashare/dataReadiness.js';

const save = saveHotspotSnapshot;
const hashOf = snapshotContentHash;

function snapshot(overrides = {}) {
  return {
    as_of: '20261030',
    config_version: 'hotspot-config-1.0.0',
    strategy_set_version: 'strategy-set-1.0.0',
    content_hash: '',
    generated_at: '2026-10-30T11:42:47.226Z',
    sectors: {},
    candidates: [],
    counts: { raw_pool: 0, focus_pool: 0, excluded: 0, etf_candidates: 0, with_signals: 0 },
    coverage: [],
    research_only: true,
    ...overrides,
  };
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
  const second = save(db, snapshot({ content_hash: '', counts: { raw_pool: 0, focus_pool: 0, excluded: 0, etf_candidates: 0, with_signals: 7 } }));
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
  // The destroyed old version is exactly what the ledger exists to preserve.
  assert.ok(loadHotspotVersion(db, '20261030', 'hotspot-config-1.0.0', 1), 'version 1 payload must still be readable');
  const pointer = loadHotspotSnapshot(db, '20261030');
  assert.equal(pointer.version_no, 2, 'the pointer must name the version it points at');
  assert.equal(pointer.content_hash, second.content_hash);
});

test('snapshot reads: position and state come from the row, not from the serialized payload', () => {
  const db = new DatabaseSync(':memory:');
  save(db, snapshot());
  save(db, snapshot({ counts: { raw_pool: 0, focus_pool: 0, excluded: 0, etf_candidates: 0, with_signals: 3 } }));
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

test('content_hash basis: v1 ignores the new fields, v2 is pinned to the data state', () => {
  const base = snapshot();
  const withExtras = snapshot({
    entry_view: { generated: true, top10: [], counts: {} },
    data_state: { version: 'data-readiness-1.0.0', as_of: '20261030', fingerprint: { bars: { daily: 1 } }, entry_identity: null, checked_at: 'x' },
  });
  // v1 is the pre-2026-10-31 formula: it never saw these fields.
  assert.equal(hashOf(base, { basis: 'v1' }), hashOf(withExtras, { basis: 'v1' }));
  // v2 must change when the data changes …
  const other = snapshot({
    entry_view: withExtras.entry_view,
    data_state: { ...withExtras.data_state, fingerprint: { bars: { daily: 2 } } },
  });
  assert.notEqual(hashOf(withExtras, { basis: 'v2' }), hashOf(other, { basis: 'v2' }));
  // … and must NOT change just because we looked at the clock again.
  const laterLook = snapshot({
    entry_view: withExtras.entry_view,
    data_state: { ...withExtras.data_state, checked_at: 'y' },
  });
  assert.equal(hashOf(withExtras, { basis: 'v2' }), hashOf(laterLook, { basis: 'v2' }));
  // A v2 body is hashed as v2 by default; a body without data_state stays v1.
  assert.equal(hashOf(withExtras), hashOf(withExtras, { basis: 'v2' }));
  assert.equal(hashOf(base), hashOf(base, { basis: 'v1' }));
  // The stored basis travels with the row so nobody can "prove" a change by rehashing v1 rows.
  const db = new DatabaseSync(':memory:');
  const r = save(db, withExtras);
  assert.equal(r.hash_basis, 'v2');
  assert.equal(listHotspotVersions(db, '20261030')[0].hash_basis, 'v2');
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
