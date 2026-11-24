import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
  return { root, backups, cwd, data, privateDir, env, run, db };
}

test('backup-only creates verified backups with .ok sidecars and does not rotate existing copies', t => {
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
    assert.ok(files.includes(`${backup}.ok`), `missing ${label} .ok sidecar`);
    assert.equal(execFileSync('sqlite3', [join(f.backups, backup), 'SELECT value FROM sample;'], { encoding: 'utf8' }).trim(), 'hello');
  }
  for (let i = 0; i < 3; i++) assert.ok(files.includes(`ashare.old${i}.sqlite`));
});

test('a failed backup removes the partial target, its journal sibling and any sidecar', t => {
  const f = fixture(t);
  // A sqlite3 that leaves the artifacts a killed online copy can leave behind and
  // then fails. The cleanup trap must remove them, or the next rotation would count
  // a broken file as a restore point.
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'sqlite3');
  writeFileSync(fake, `#!/bin/sh
target=$(printf '%s' "$2" | sed -e "s/^VACUUM INTO '//" -e "s/^\\\\.backup '//" -e "s/';\\{0,1\\}$//" -e "s/'$//")
printf partial > "$target"
printf journal > "$target-journal"
printf wal > "$target-wal"
exit 1
`);
  chmodSync(fake, 0o755);
  const result = spawnSync(script, [], {
    cwd: f.cwd,
    env: { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(f.backups).filter(name => name.startsWith('ashare.')), [],
    'a failed backup must leave no target, journal/WAL sibling or .ok sidecar');
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
    f.db(path);
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

test('a corrupt backup is quarantined and cannot displace a good legacy backup', t => {
  const f = fixture(t);
  f.db(join(f.data, 'ashare.sqlite'));
  // Two valid legacy backups (no .ok sidecar) and one corrupt file that is newer
  // than both. Without verification the corrupt file would take the first KEEP
  // slot and one good backup would be deleted.
  for (let i = 0; i < 2; i++) {
    const path = join(f.backups, `portfolio.old${i}.sqlite`);
    f.db(path);
    utimesSync(path, 1000 + i, 1000 + i);
  }
  const corrupt = join(f.backups, 'portfolio.bad.sqlite');
  writeFileSync(corrupt, 'this is not a sqlite database');
  utimesSync(corrupt, 2000, 2000);

  const dry = f.run('--dry-run');
  assert.match(dry, /would quarantine corrupt backup: .*portfolio\.bad\.sqlite/);
  assert.ok(!dry.includes('would delete:'), 'a corrupt file must not consume a KEEP slot');
  assert.ok(readFileSync(corrupt, 'utf8').includes('not a sqlite'), 'dry-run must not rename anything');

  f.run();
  assert.ok(!readdirSync(f.backups).includes('portfolio.bad.sqlite'), 'the corrupt file must leave the candidate set');
  assert.ok(readdirSync(f.backups).includes('portfolio.bad.sqlite.corrupt'), 'the corrupt file must be quarantined');
  for (let i = 0; i < 2; i++) {
    const kept = join(f.backups, `portfolio.old${i}.sqlite`);
    assert.ok(readdirSync(f.backups).includes(`portfolio.old${i}.sqlite`), `good backup ${kept} must not be displaced`);
    assert.equal(execFileSync('sqlite3', [kept, 'SELECT value FROM sample;'], { encoding: 'utf8' }).trim(), 'hello');
  }
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
