// deploy/ashare/run-hotspot-daily.sh — the failure code must survive the `if`.
//
// A previous version wrote `if ! docker exec …; then code=$?` — inside that
// branch `$?` is the status of `!`, i.e. 0, so a failed sync was reported as a
// successful exit, and systemd saw `OnSuccess=` where it should have seen a
// failed unit. This test drives the real script against a fake `docker` so the
// regression cannot come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'deploy', 'ashare', 'run-hotspot-daily.sh');

/**
 * A fake docker that answers `info`, `inspect`, and `exec`. The exec command
 * name selects a canned exit code and a canned JSON body.
 */
function fakeDocker({ syncCode = 0, snapshotCode = 0, readiness = 'READY' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const body = (payload) => `cat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`;
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  inspect) echo "running/healthy"; exit 0 ;;
  exec)
    shift 3   # exec <container> <program> <script>
    case "$2" in
      hotspot-sync) ${syncCode === 0 ? body({ ok: true }) : `echo "sync failed" >&2; exit ${syncCode}`} ;;
      hotspot-snapshot) ${snapshotCode === 0
    ? body({
      snapshot: {
        as_of: '20261102',
        technical_view: { research_universe: { counts: { FOCUS: 2, WATCH: 1, total: 3 } } },
      },
      readiness: { status: readiness, reason: null },
      saved: { content_hash: 'sha256:abc', version_no: 1, state: 'INSERTED' },
    })
    : `echo "snapshot failed" >&2; exit ${snapshotCode}`} ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
}

function run(dockerDir) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hotspot-data-'));
  const res = spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${dockerDir}:${process.env.PATH}`,
      ASHARE_SG_REEXEC: '1',
      ASHARE_HOST_DATA_DIR: dataDir,
      ASHARE_DOCKER_WAIT_SECONDS: '1',
      ASHARE_HOTSPOT_FORCE: '0',
    },
  });
  return { ...res, dataDir };
}

test('a failed hotspot-sync exits with its own code, not 0', () => {
  const r = run(fakeDocker({ syncCode: 13 }));
  assert.equal(r.status, 13, `expected exit 13, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /hotspot-sync FAILED \(exit 13\)/);
  // No snapshot is attempted after a failed sync.
  assert.doesNotMatch(r.stdout, /hotspot ok:/);
});

test('a failed hotspot-snapshot exits with its own code', () => {
  const r = run(fakeDocker({ snapshotCode: 9 }));
  assert.equal(r.status, 9, `expected exit 9, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /hotspot-snapshot FAILED \(exit 9\)/);
});

test('a successful run exits 0 and reports the persisted identity and states', () => {
  const r = run(fakeDocker());
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /hotspot-sync ok/);
  assert.match(r.stdout, /hotspot ok: as_of=20261102/);
  assert.match(r.stdout, /version=1/);
  assert.match(r.stdout, /"FOCUS":2/);
});

test('a NOT_READY result is published as a failure (exit 78), not as "ok"', () => {
  const r = run(fakeDocker({ readiness: 'NOT_READY' }));
  assert.equal(r.status, 78, `expected exit 78, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /NOT PUBLISHED/);
});

test('the log directory is created under the configured data dir', () => {
  const r = run(fakeDocker());
  assert.equal(r.status, 0);
  const files = readdirSync(join(r.dataDir, 'logs')).filter(f => f.startsWith('hotspot-'));
  assert.ok(files.length >= 2, `expected sync/snapshot logs, got ${files.join(',')}`);
  const snapLog = files.find(f => f.startsWith('hotspot-snapshot-') && f.endsWith('.json'));
  assert.ok(JSON.parse(readFileSync(join(r.dataDir, 'logs', snapLog), 'utf8')).snapshot);
});
