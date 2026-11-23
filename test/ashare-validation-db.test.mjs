import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { openValidationDb } = await import('../build/ashare/validation.js');

test('validation registry opens WAL with a 15s busy timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validation-pragma-'));
  const db = openValidationDb(join(dir, 'research.sqlite'), join(dir, 'market.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 15000);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
