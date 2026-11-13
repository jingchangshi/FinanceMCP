import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/ashare/backup-rotation.sh', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ashare backup '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state'), data = join(root, 'data'), privateDir = join(root, 'private');
  const backups = join(state, 'backups'), cwd = join(root, 'cwd');
  for (const dir of [backups, data, privateDir, cwd, join(data, 'research-validation')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ASHARE_STATE_DIR: state, ASHARE_HOST_DATA_DIR: data, ASHARE_PRIVATE_HOST_DIR: privateDir, ASHARE_BACKUP_KEEP: '2' };
  function run(...args) { return execFileSync(script, args, { cwd, env, encoding: 'utf8' }); }
  function db(path) { execFileSync('sqlite3', [path, 'CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'hello\');']); }
  return { root, backups, cwd, data, privateDir, run, db };
}

test('backup-only creates verified backups and does not rotate existing copies', t => {
  const f = fixture(t);
  const sources = [join(f.data, 'ashare.sqlite'), join(f.privateDir, 'portfolio.sqlite'), join(f.privateDir, 'oauth.sqlite'), join(f.data, 'research.sqlite'), join(f.data, 'research-validation', 'validation.sqlite')];
  for (const source of sources) f.db(source);
  for (let i = 0; i < 3; i++) writeFileSync(join(f.backups, `ashare.old${i}.sqlite`), 'old');
  const output = f.run('--backup-only');
  assert.match(output, /backup-only: rotation skipped/);
  const files = readdirSync(f.backups);
  for (const label of ['ashare', 'portfolio', 'oauth', 'research', 'validation']) {
    const backup = files.find(name => new RegExp(`^${label}\\.\\d{8}T\\d{6}Z\\.sqlite$`).test(name));
    assert.ok(backup, `missing ${label} backup`);
    assert.equal(execFileSync('sqlite3', [join(f.backups, backup), 'SELECT value FROM sample;'], { encoding: 'utf8' }).trim(), 'hello');
  }
  for (let i = 0; i < 3; i++) assert.ok(files.includes(`ashare.old${i}.sqlite`));
});

test('empty matches never rotate files in the working directory', t => {
  const f = fixture(t);
  f.db(join(f.data, 'ashare.sqlite'));
  for (let i = 0; i < 5; i++) writeFileSync(join(f.cwd, `unrelated${i}`), `content${i}`);
  const output = f.run();
  assert.match(output, /portfolio: no backups found/);
  for (let i = 0; i < 5; i++) assert.equal(readFileSync(join(f.cwd, `unrelated${i}`), 'utf8'), `content${i}`);
});

test('rotation preserves baseline, symlinks and restore checks; dry-run changes nothing', t => {
  const f = fixture(t);
  f.db(join(f.data, 'ashare.sqlite'));
  for (let i = 0; i < 3; i++) {
    const path = join(f.backups, `portfolio.old ${i}.sqlite`);
    writeFileSync(path, 'old');
    utimesSync(path, 1000 + i, 1000 + i);
  }
  const baseline = join(f.backups, 'ashare.pre-v1.0.sqlite');
  const restore = join(f.backups, 'portfolio.restore-check.old.sqlite');
  writeFileSync(baseline, 'baseline');
  writeFileSync(restore, 'restore');
  symlinkSync(resolve(f.backups, 'portfolio.old 0.sqlite'), join(f.backups, 'portfolio.link.sqlite'));
  const before = readdirSync(f.backups);
  assert.match(f.run('--dry-run'), /would delete:/);
  assert.deepEqual(readdirSync(f.backups), before);
  f.run();
  const after = readdirSync(f.backups);
  assert.ok(!after.includes('portfolio.old 0.sqlite'));
  for (const name of ['portfolio.old 1.sqlite', 'portfolio.old 2.sqlite', 'portfolio.link.sqlite', 'portfolio.restore-check.old.sqlite', 'ashare.pre-v1.0.sqlite', 'ashare.latest.sqlite']) assert.ok(after.includes(name), name);
});

test('dry-run combined with backup-only creates no backups and skips rotation', t => {
  const f = fixture(t);
  f.db(join(f.data, 'ashare.sqlite'));
  writeFileSync(join(f.backups, 'ashare.old.sqlite'), 'old');
  const before = readdirSync(f.backups);
  const output = f.run('--dry-run', '--backup-only');
  assert.match(output, /dry-run: would back up/);
  assert.match(output, /backup-only: rotation skipped/);
  assert.deepEqual(readdirSync(f.backups), before);
});
