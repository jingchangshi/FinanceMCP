import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSnapshotReadiness } from '../build/portfolio/bundleRecordCli.js';

const date = '20261113';
const ready = () => ({ as_of_trade_date: date,
  data_quality: { market: { status: 'READY', as_of_trade_date: date } },
  data_lineage: { market_report_freshness: 'same_day' }, market: {},
  hotspot_research: { status: 'OK', as_of_trade_date: date,
    snapshot: { as_of: date, market_data_as_of: date }, data_state: { readiness: 'READY' } } });

test('target-date readiness rejects stale, missing and unready upstream snapshots', () => {
  assert.deepEqual(currentSnapshotReadiness(ready()), { marketReady: true, hotspotReady: true });
  for (const mutate of [
    b => { b.data_quality.market.status = 'NOT_READY'; },
    b => { b.data_quality.market.as_of_trade_date = '20261112'; },
    b => { b.data_lineage.market_report_freshness = 'missing'; },
    b => { b.market.reason = 'target_market_data_unavailable'; },
  ]) { const b = ready(); mutate(b); assert.equal(currentSnapshotReadiness(b).marketReady, false); }
  for (const mutate of [
    b => { b.hotspot_research.status = 'NOT_READY'; },
    b => { b.hotspot_research.snapshot.as_of = '20261112'; },
    b => { b.hotspot_research.snapshot.market_data_as_of = '20261112'; },
    b => { b.hotspot_research.data_state.readiness = 'NOT_READY'; },
    b => { b.hotspot_research = null; },
  ]) { const b = ready(); mutate(b); assert.equal(currentSnapshotReadiness(b).hotspotReady, false); }
  const degraded = ready();
  degraded.data_quality.market.status = 'DEGRADED';
  degraded.hotspot_research.data_state.readiness = 'DEGRADED';
  assert.deepEqual(currentSnapshotReadiness(degraded), { marketReady: true, hotspotReady: true });
});

function run(recordCode, reviewCode, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'account-daily-test-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nif [ "$1" = info ]; then exit 0; fi\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in\n  *investment-research-record*) [ -n "\${RECORD_JSON:-}" ] && printf '%s\\n' "$RECORD_JSON"; exit ${recordCode} ;;\n  *portfolio-daily-report*) exit \${BRIEF_CODE:-0} ;;\n  *portfolio-journal-review*) exit ${reviewCode} ;;\nesac\nexit 99\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const result = spawnSync('/bin/sh', [join(process.cwd(), 'deploy/ashare/run-account-daily.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, ASHARE_PRIVATE_HOST_DIR: dir, ASHARE_SG_REEXEC: '1', ...extraEnv },
  });
  return { result, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}

test('scheduled record failure still runs forward review and reports record failure', () => {
  const { result, calls } = run(1, 0);
  assert.equal(result.status, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /investment-research-record --require-current-snapshots/);
  assert.match(calls[1], /portfolio-journal-review --record --confirm/);
  // Structured handoff: unified must use this exact path and exit code, never
  // a newest-file guess that could pick up a previous day.
  assert.match(result.stdout, /^ACCOUNT_OUT=.*account-daily-.*\.json$/m);
  assert.match(result.stdout, /^RC=1$/m);
});

test('review failure is reported after successful record', () => {
  const { result, calls } = run(0, 9);
  assert.equal(result.status, 77);
  assert.equal(calls.length, 2);
  assert.match(result.stdout, /^RC=0$/m);
});

test('an explicit expected trade date is passed to investment-research-record and daily brief', () => {
  const { result, calls } = run(0, 0, { ASHARE_EXPECTED_TRADE_DATE: '20261113' });
  assert.equal(result.status, 0);
  assert.match(calls[0], /investment-research-record --require-current-snapshots --date 20261113/);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /portfolio-daily-report --account real-main --date 20261113 --format brief --output \/private\/daily-briefs\/20261113\.json/);
  assert.match(calls[2], /portfolio-journal-review --record --confirm/);
  assert.match(result.stdout, /daily brief ok \(date 20261113/);
});

test('a failed daily brief is disclosed but does not fail account-daily or the review', () => {
  const { result, calls } = run(0, 0, { ASHARE_EXPECTED_TRADE_DATE: '20261113', BRIEF_CODE: '1' });
  assert.equal(result.status, 0);
  assert.equal(calls.length, 3);
  assert.match(result.stderr, /daily brief FAILED \(exit 1\)/);
  assert.match(result.stdout, /^RC=0$/m);
});
