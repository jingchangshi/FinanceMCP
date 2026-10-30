// goal-1031 §2.1: the entry layer's own content identity and its append-only
// freeze ledger. These are the guarantees the signal freeze cannot provide,
// because it deliberately excludes every entry module.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ENTRY_MODULES, ENTRY_IMPLEMENTATION_SCHEME, entryImplementationHash, entryIdentity,
} from '../build/ashare/entryIdentity.js';
import { ENTRY_RULES_VERSION } from '../build/ashare/entryAssessment.js';
import { RANKING_RULES_VERSION } from '../build/ashare/entryRanking.js';
import { runEntryCommand } from '../build/ashare/entryFreezeCli.js';

const sha256Hex = /^[a-f0-9]{64}$/;

/** A Shanghai-calendar date, `offsetDays` from today, as YYYYMMDD. */
function shanghaiDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400_000 + 8 * 3600_000);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

test('entry identity: a stable 64-hex hash over exactly the entry modules', () => {
  const hash = entryImplementationHash();
  assert.match(hash, sha256Hex, hash);
  assert.equal(entryImplementationHash(), hash, 'deterministic across calls');
  const id = entryIdentity();
  assert.equal(id.entry_scheme, ENTRY_IMPLEMENTATION_SCHEME);
  assert.equal(id.entry_hash, hash);
  assert.equal(id.entry_rules_version, ENTRY_RULES_VERSION);
  assert.equal(id.ranking_rules_version, RANKING_RULES_VERSION);
  assert.deepEqual(id.entry_modules, [...ENTRY_MODULES].sort());
  // The signal freeze must NOT contain any entry module: this is the whole
  // reason a separate identity exists.
  const signal = new Set(['analysis', 'bars', 'data', 'db', 'evaluation', 'fetch',
    'fundamentals', 'indicators', 'ingest', 'signals', 'validation', 'validationCli', 'watchlist']);
  for (const m of ENTRY_MODULES) assert.equal(signal.has(m), false, `${m} must not be in the signal freeze`);
});

test('entry identity: editing an entry module changes the hash, an unrelated one does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-identity-'));
  const src = new URL('../build/ashare/', import.meta.url);
  for (const name of ENTRY_MODULES) copyFileSync(new URL(`${name}.js`, src), join(dir, `${name}.js`));
  const base = entryImplementationHash({ ashare: dir });
  assert.equal(base, entryImplementationHash(), 'a byte-identical copy hashes the same');

  // An unrelated module is not read at all.
  writeFileSync(join(dir, 'shadowRun.js'), 'export const x = 1;\n');
  assert.equal(entryImplementationHash({ ashare: dir }), base);

  // Every entry module is load-bearing.
  for (const name of ENTRY_MODULES) {
    const file = join(dir, `${name}.js`);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}\n// touched\n`);
    assert.notEqual(entryImplementationHash({ ashare: dir }), base, `${name} must be part of the identity`);
    writeFileSync(file, original);
  }
});

function ledgerEnv() {
  const root = mkdtempSync(join(tmpdir(), 'entry-freeze-'));
  mkdirSync(join(root, 'research'), { recursive: true });
  return { source: join(root, 'market.sqlite'), research: join(root, 'research', 'validation.sqlite') };
}

test('entry freeze: recorded, content-addressed, and immutable once written', async () => {
  const env = ledgerEnv();
  const start = shanghaiDay(2);
  const out = await runEntryCommand(['freeze', '--source', env.source, '--research-db', env.research, '--start', start]);
  assert.equal(out.status, 'FROZEN_RESEARCH_ONLY');
  assert.match(out.id, /^EFRZ-[a-f0-9]{24}$/);
  assert.equal(out.start, start);
  assert.equal(out.entry_hash, entryImplementationHash());
  assert.match(out.signal_implementation_hash, sha256Hex, 'the entry layer records the signal side it sits on');

  const db = new DatabaseSync(env.research);
  try {
    // The ledger refuses every mutation: a frozen identity cannot be edited,
    // deleted or replaced. This is the property the production append needs.
    assert.throws(() => db.prepare("UPDATE entry_freeze SET protocol='{}'").run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM entry_freeze').run(), /immutable/);
    assert.throws(() => db.prepare('INSERT INTO entry_freeze(id,created_at,protocol,recorded_at) VALUES(?,?,?,?)')
      .run(out.id, 'x', '{}', 'x'), /immutable/);
  } finally { db.close(); }
});

test('entry freeze: a start day that is not in the future is refused', async () => {
  const env = ledgerEnv();
  await assert.rejects(
    runEntryCommand(['freeze', '--source', env.source, '--research-db', env.research, '--start', shanghaiDay(0)]),
    /future trading day|after the actual freeze day/);
  await assert.rejects(
    runEntryCommand(['freeze', '--source', env.source, '--research-db', env.research, '--start', '2026-11-02']),
    /Invalid freeze start/);
});

test('entry freeze status: read-only, and it never creates the ledger', async () => {
  const env = ledgerEnv();
  const empty = await runEntryCommand(['status', '--source', env.source, '--research-db', env.research]);
  assert.equal(empty.status, 'NO_ENTRY_FREEZE');
  const db = new DatabaseSync(env.research);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  db.close();
  assert.deepEqual(tables, [], 'a status read must not create a table');

  const start = shanghaiDay(2);
  await runEntryCommand(['freeze', '--source', env.source, '--research-db', env.research, '--start', start]);
  const listed = await runEntryCommand(['status', '--source', env.source, '--research-db', env.research, '--as-of', start]);
  assert.equal(listed.status, 'OK');
  assert.equal(listed.freezes.length, 1);
  const row = listed.freezes[0];
  assert.equal(row.identity_ok, true);
  assert.equal(row.recorded_before_start, true);
  assert.equal(row.active, true);
  assert.equal(row.entry_hash_matches_current, true);
  assert.equal(row.signal_implementation_matches_current, true);
});

test('entry freeze: the research ledger may not be the live market database', async () => {
  const env = ledgerEnv();
  await assert.rejects(
    runEntryCommand(['freeze', '--source', env.source, '--research-db', env.source, '--start', shanghaiDay(2)]),
    /同一文件|refuse/i);
});
