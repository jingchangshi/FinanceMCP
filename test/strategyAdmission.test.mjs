import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { StrategyAdmissionStore } from '../build/ashare/strategyAdmission.js';
import { handleStrategyAdmission } from '../build/ashare/strategyAdmissionCli.js';

const canonical = x => typeof x === 'string' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
function release() {
  const x = JSON.parse(readFileSync(new URL('./fixtures/strategy-release.json', import.meta.url)));
  const fill = v => typeof v === 'string' ? (v === 'UNKNOWN' ? 'known' : v) : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, fill(value)])) : v;
  const r = fill(x); r.research_status = 'FROZEN'; r.strategy.implementation_sha256 = 'a'.repeat(64);
  const { content_hash, ...payload } = r;
  r.content_hash = createHash('sha256').update(canonical(payload)).digest('hex');
  return r;
}
const scope = r => ({ account: 'acct', market: r.applicability.market, environment: r.applicability.environment });
const dates = { reason: 'reviewed', validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z' };
function setup(t) { const dir = mkdtempSync(join(tmpdir(), 'admission-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, path: join(dir, 'admission.sqlite') }; }

test('grant binds real validated release, scope, implementation and state transitions', t => {
  const { path } = setup(t); const r = release(); const s = scope(r);
  const db = new StrategyAdmissionStore(path, { create: true }); t.after(() => db.close());
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), false);
  db.record('GRANT', r, s, dates);
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), true);
  assert.equal(db.check(r, { ...s, account: 'other' }, r.strategy.implementation_sha256), false);
  assert.equal(db.check(r, s, 'b'.repeat(64)), false);
  const altered = structuredClone(r); altered.rules[0] += 'tamper';
  assert.equal(db.check(altered, s, r.strategy.implementation_sha256), false);
  const changed = structuredClone(r); changed.rules[0] += 'new release';
  const { content_hash, ...payload } = changed;
  changed.content_hash = createHash('sha256').update(canonical(payload)).digest('hex');
  assert.equal(db.check(changed, s, r.strategy.implementation_sha256), false);
  assert.throws(() => db.record('GRANT', changed, s, dates));
  assert.throws(() => db.record('GRANT', r, s, dates));
  db.record('SUSPEND', r, s, { reason: 'pause' });
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), false);
  db.record('RESUME', r, s, { reason: 'resume' });
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), true);
  db.record('REVOKE', r, s, { reason: 'withdraw' });
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), false);
  assert.throws(() => db.record('RESUME', r, s, { reason: 'retry' }));
  assert.throws(() => db.record('GRANT', r, s, dates));
  assert.deepEqual(db.history().map(x => x.action), ['GRANT', 'SUSPEND', 'RESUME', 'REVOKE']);
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  assert.throws(() => raw.exec('DELETE FROM admission_events'));
  assert.throws(() => raw.exec('INSERT OR REPLACE INTO admission_events SELECT * FROM admission_events WHERE seq=1'));
  assert.throws(() => raw.exec("UPDATE admission_events SET reason='changed'"));
});

test('rejects invalid eligibility, expired periods and untrusted filesystem permissions', t => {
  const { dir, path } = setup(t); const r = release(); const s = scope(r);
  const db = new StrategyAdmissionStore(path, { create: true });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => db.record('GRANT', r, s, { ...dates, validUntil: '2021-01-01T00:00:00.000Z' }));
  const tampered = structuredClone(r); tampered.research_status = 'DRAFT';
  assert.throws(() => db.record('GRANT', tampered, s, dates));
  db.record('GRANT', r, s, { ...dates, validFrom: '2098-01-01T00:00:00.000Z' });
  assert.equal(db.check(r, s, r.strategy.implementation_sha256), false);
  const expired = scope(r); expired.account = 'expired';
  const raw = new DatabaseSync(path);
  raw.prepare('INSERT INTO admission_events(action,strategy_id,version,release_hash,account,market,environment,valid_from,valid_until,recorded_at,uid,operator,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('GRANT', r.strategy.id, r.strategy.version, r.content_hash, expired.account, expired.market, expired.environment, '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', process.getuid(), 'test', 'expired');
  raw.close();
  assert.equal(db.check(r, expired, r.strategy.implementation_sha256), false);
  db.close(); chmodSync(path, 0o644);
  assert.throws(() => new StrategyAdmissionStore(path));
  chmodSync(path, 0o600); chmodSync(dir, 0o755);
  assert.throws(() => new StrategyAdmissionStore(path));
});

test('CLI requires explicit confirmation and status fails closed', t => {
  const { dir, path } = setup(t); const r = release(); const file = join(dir, 'release.json'); writeFileSync(file, JSON.stringify(r));
  const s = scope(r); const base = ['--db', path, '--release', file, '--account', s.account, '--market', s.market, '--environment', s.environment];
  assert.deepEqual(handleStrategyAdmission(['status', ...base]), { admitted: false });
  const grant = ['grant', ...base, '--note', 'reviewed', '--valid-from', dates.validFrom, '--valid-until', dates.validUntil];
  assert.throws(() => handleStrategyAdmission(grant));
  assert.deepEqual(handleStrategyAdmission([...grant, '--confirm']), { recorded: 'grant' });
  assert.deepEqual(handleStrategyAdmission(['status', ...base]), { admitted: true });
  handleStrategyAdmission(['revoke', ...base, '--note', 'withdraw']);
  assert.deepEqual(handleStrategyAdmission(['status', ...base]), { admitted: false });
});

test('main CLI routes admission and feedback without opening account databases', t => {
  const { dir, path } = setup(t);
  const r = release(); const file = join(dir, 'release.json'); writeFileSync(file, JSON.stringify(r));
  const s = scope(r); const cli = new URL('../build/ashare/cli.js', import.meta.url).pathname;
  const denied = spawnSync(process.execPath, [cli, 'portfolio-strategy-admission', 'status', '--db', path, '--release', file, '--account', s.account, '--market', s.market, '--environment', s.environment], { encoding: 'utf8' });
  assert.equal(denied.status, 1, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).admitted, false);
  const feedback = spawnSync(process.execPath, [cli, 'portfolio-strategy-feedback', 'import', '--db', join(dir, 'feedback.sqlite'), '--file', file], { encoding: 'utf8' });
  assert.notEqual(feedback.status, 0);
  assert.match(feedback.stderr, /confirm/);
});
