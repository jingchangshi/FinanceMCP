import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { weekdays } from './ashare-fixture.mjs';
const { openPortfolioDb } = await import('../build/portfolio/db.js');

// The cadence is scheduled by a systemd unit that sets RESEARCH_CADENCE_ENABLED explicitly.
// These tests drive the real CLI process: a guard asserted only in a helper nobody calls is
// documentation, so the "disabled by default" and "no default account" rules are checked here.

const ROOT = process.cwd();
function cli(args, extraEnv = {}, seed = null) {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-cli-'));
  const env = { ...process.env, ASHARE_DATA_DIR: dir,
    ASHARE_DB_PATH: join(dir, 'market.sqlite'), ASHARE_PORTFOLIO_DB_PATH: join(dir, 'portfolio.sqlite'),
    ASHARE_RESEARCH_DB_PATH: join(dir, 'research.sqlite'), ...extraEnv };
  delete env.RESEARCH_CADENCE_ENABLED;
  Object.assign(env, extraEnv);
  if (seed) seed(dir);
  const r = spawnSync(process.execPath, [join(ROOT, 'build/ashare/cli.js'), 'research-cadence', ...args], { cwd: dir, env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json, dir };
}

/** A market calendar through 2024-02-29 and an empty account ledger.
 *
 * The calendar deliberately contains later February sessions, so 2024-02-26 is
 * provably not month end while 2024-02-29 is. The empty ledger is a legitimate
 * state for the monthly review (it reports NO_MATURED_FORWARD_SAMPLE). */
function seedCadenceDatabases(dir) {
  const market = new DatabaseSync(join(dir, 'market.sqlite'));
  market.exec('CREATE TABLE trade_cal (cal_date TEXT PRIMARY KEY, is_open INTEGER NOT NULL, pretrade_date TEXT)');
  const insert = market.prepare('INSERT OR REPLACE INTO trade_cal (cal_date,is_open) VALUES (?,1)');
  for (const day of [...weekdays('20240102', 40), '20240227', '20240228', '20240229']) insert.run(day);
  market.close();
  const ledger = openPortfolioDb(join(dir, 'portfolio.sqlite'), { writable: true, marketPath: join(dir, 'market.sqlite') });
  ledger.close();
}

test('C1 unset RESEARCH_CADENCE_ENABLED means disabled, and nothing is written', () => {
  const r = cli(['weekly', '--as-of', '20261023', '--account-id', 'real-main']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.skip_reason, 'disabled');
  assert.equal(r.json.produced, false);
  assert.equal(r.json.written_to, null);
  assert.deepEqual(readdirSync(r.dir), [], 'a disabled run must not create any file');
});

test('C2 there is no default account: omitting --account-id fails instead of defaulting', () => {
  const r = cli(['monthly', '--as-of', '20261023'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--account-id is required/);
});

test('C3 an unknown cadence and a malformed as-of are rejected', () => {
  assert.notEqual(cli(['daily', '--as-of', '20261023', '--account-id', 'x']).status, 0);
  const bad = cli(['weekly', '--as-of', '2026-10-23', '--account-id', 'x'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /YYYYMMDD or latest/);
});

test('C4 enabled but with no market cache, it reports an outage rather than a quiet week, and writes nothing', () => {
  const r = cli(['weekly', '--as-of', '20261023', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.produced, false);
  assert.equal(r.json.skip_reason, 'diagnosis_unavailable');
  assert.match(r.json.detail, /行情缓存不存在/);
  assert.equal(existsSync(join(r.dir, 'research-cadence')), false);
});

test('C5 --as-of latest with no cache is reported as unavailable, not resolved to a guess', () => {
  const r = cli(['weekly', '--as-of', 'latest', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'UNAVAILABLE');
  assert.equal(r.json.reason, 'no_market_cache_to_resolve_latest');
});

test('C6 monthly skips before the month\'s last trading day unless forced', () => {
  // The monthly unit fires daily; without the gate it would publish a review a
  // week early for months that end on the 29th-31st.
  const early = cli(['monthly', '--as-of', '20240226', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' }, seedCadenceDatabases);
  assert.equal(early.status, 0, early.stderr);
  assert.equal(early.json.produced, false);
  assert.equal(early.json.skip_reason, 'not_month_end');
  assert.match(early.json.detail, /20240229/, 'the skip must name the real month-end session');
  assert.equal(early.json.written_to, null, 'an early run must write nothing');

  // A deliberate manual review of an earlier date is still allowed, but only with
  // an explicit override — both the flag and the environment variable are accepted.
  const forced = cli(['monthly', '--as-of', '20240226', '--account-id', 'real-main', '--force'], { RESEARCH_CADENCE_ENABLED: '1' }, seedCadenceDatabases);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.json.skip_reason, null, `unexpected skip: ${forced.json.detail ?? ''}`);
  assert.equal(forced.json.produced, true);
  assert.ok(forced.json.written_to, 'a forced review must report where it was written');

  const envForced = cli(['monthly', '--as-of', '20240226', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1', ASHARE_CADENCE_FORCE: '1' }, seedCadenceDatabases);
  assert.equal(envForced.json.skip_reason, null, `environment override must work: ${envForced.json.detail ?? ''}`);
  assert.equal(envForced.json.produced, true);
});

test('C7 monthly produces on the month\'s last trading day without an override', () => {
  const r = cli(['monthly', '--as-of', '20240229', '--account-id', 'real-main'], { RESEARCH_CADENCE_ENABLED: '1' }, seedCadenceDatabases);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.skip_reason, null, `unexpected skip: ${r.json.detail ?? ''}`);
  assert.equal(r.json.produced, true);
});
