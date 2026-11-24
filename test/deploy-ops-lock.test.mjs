// deploy/ashare/ops-lock.sh — shared non-interactive lock.
//
// The real hazard is an operator upgrade rebuilding the container while the
// 19:30 daily run is syncing. Every entry script must therefore fail fast (73)
// when another task holds the lock. These tests hold the lock for real with
// flock(1) and drive the actual scripts; nothing touches production.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const DATA_DIR = 'data';
const LOCK_ENV = 'ASHARE_OPS_LOCK';

function fakeDocker(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\n[ "$1" = info ] && exit 0\nexit 0\n');
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

async function withHeldLock(t, lockPath) {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  const holder = spawn('flock', [lockPath, 'sleep', '20'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch { /* already gone */ } });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = spawnSync('flock', ['-n', lockPath, 'true'], { encoding: 'utf8' });
    if (probe.status !== 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('could not acquire the test lock holder');
}

function runScript(script, dir, env = {}) {
  return spawnSync('/bin/sh', [join(ROOT, script)], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      ASHARE_SG_REEXEC: '1',
      ASHARE_DOCKER_WAIT_SECONDS: '1',
      ASHARE_HOST_DATA_DIR: join(dir, DATA_DIR),
      ASHARE_PRIVATE_HOST_DIR: join(dir, 'private'),
      [LOCK_ENV]: join(dir, DATA_DIR, 'ops.lock'),
      ...env,
    },
  });
}

for (const script of [
  'deploy/ashare/run-daily.sh',
  'deploy/ashare/run-hotspot-daily.sh',
  'deploy/ashare/run-account-daily.sh',
  'deploy/ashare/run-daily-unified.sh',
]) {
  test(`${script} refuses to start while the shared ops lock is held`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-lock-'));
    t.after(() => { /* temp dir is small; OS cleans it */ });
    fakeDocker(dir);
    const lockPath = join(dir, DATA_DIR, 'ops.lock');
    await withHeldLock(t, lockPath);
    const res = runScript(script, dir);
    assert.equal(res.status, 73, `${script} must exit 73; stderr=${res.stderr}`);
    assert.match(res.stderr, /ops lock busy/);
  });
}

function makeUpgradeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-repo-'));
  mkdirSync(join(dir, 'deploy', 'ashare'), { recursive: true });
  cpSync(join(ROOT, 'deploy/ashare/upgrade.sh'), join(dir, 'deploy/ashare/upgrade.sh'));
  cpSync(join(ROOT, 'deploy/ashare/ops-lock.sh'), join(dir, 'deploy/ashare/ops-lock.sh'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-m', 'init').status, 0);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { dir, head };
}

test('upgrade.sh refuses while finance-ashare-daily.service is active, before touching docker', t => {
  const repo = makeUpgradeRepo(t);
  const bin = join(repo.dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // A systemctl that reports the daily service as active.
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker must not run" >> "$DOCKER_CALLS"\nexit 1\n');
  chmodSync(join(bin, 'docker'), 0o755);
  const calls = join(repo.dir, 'docker.log');
  const res = spawnSync('bash', [join(repo.dir, 'deploy/ashare/upgrade.sh'), '--revision', repo.head], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DOCKER_CALLS: calls,
      ASHARE_STATE_DIR: join(repo.dir, 'state'),
      [LOCK_ENV]: join(repo.dir, 'ops.lock'),
    },
  });
  assert.equal(res.status, 73, res.stderr);
  assert.match(res.stderr, /finance-ashare-daily\.service is active; refusing to upgrade/);
  assert.equal(spawnSync('test', ['-f', calls]).status, 1, 'no docker command may run');
});

test('upgrade.sh refuses while another ops task holds the lock', t => {
  const repo = makeUpgradeRepo(t);
  const bin = join(repo.dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // Not active: the service check must fall through to the lock check.
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  const lockPath = join(repo.dir, 'ops.lock');
  mkdirSync(join(repo.dir, 'state'), { recursive: true });
  const holder = spawn('flock', [lockPath, 'sleep', '20'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch { /* already gone */ } });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnSync('flock', ['-n', lockPath, 'true']).status !== 0) break;
    spawnSync('sleep', ['0.05']);
  }
  const res = spawnSync('bash', [join(repo.dir, 'deploy/ashare/upgrade.sh'), '--revision', repo.head], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ASHARE_STATE_DIR: join(repo.dir, 'state'),
      [LOCK_ENV]: lockPath,
    },
  });
  assert.equal(res.status, 73, res.stderr);
  assert.match(res.stderr, /ops lock busy/);
});
