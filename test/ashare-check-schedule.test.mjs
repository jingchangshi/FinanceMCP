import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/ashare/check-schedule.sh', import.meta.url));
const unit = 'finance-ashare-daily.service';
const line = (time, message) => `2026-10-19T${time}+0800 host systemd[123]: ${message}\n`;
const start = time => line(time, 'Starting A-share daily...');
const finish = time => line(time, 'Finished A-share daily.');
const fail = time => line(time, `${unit}: Failed with result 'exit-code'.`);

function run(t, journal, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-schedule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'journal');
  writeFileSync(log, journal);
  for (const [name, content] of Object.entries({
    journalctl: '#!/bin/sh\n[ "${JOURNAL_FAIL:-0}" = 0 ] || exit 1\nexec /bin/cat "$JOURNAL_FIXTURE"\n',
    systemctl: '#!/bin/sh\n[ "${SYSTEMCTL_FAIL:-0}" = 0 ] || exit 1\nprintf "LastTriggerUSec=Mon 2026-10-19 21:10:00 CST\\n"\n',
  })) {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  return spawnSync(script, [options.date ?? '20261019'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, JOURNAL_FIXTURE: log, JOURNAL_FAIL: options.journalFail ? '1' : '0', SYSTEMCTL_FAIL: options.systemctlFail ? '1' : '0' },
  });
}

test('window starts and their own finishes are observed, but timer origin stays unknown', t => {
  const result = run(t, start('18:40:00') + finish('18:50:00') + start('21:15:59') + finish('21:20:00'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run_1840=yes outcome_1840=success run_2110=yes outcome_2110=success trigger_source=unknown schedule=UNKNOWN/);
});

test('unrelated finishes cannot prove incomplete window starts succeeded', t => {
  const result = run(t, start('10:00:00') + finish('10:01:00') + start('12:00:00') + finish('12:01:00') + start('18:41:00') + start('21:11:00'));
  assert.match(result.stdout, /run_1840=yes outcome_1840=ambiguous run_2110=yes outcome_2110=ambiguous/);
  assert.doesNotMatch(result.stdout, /outcome_1840=success|outcome_2110=success|schedule=PASS/);
});

test('failed, unfinished and out-of-window runs remain distinct', t => {
  const failed = run(t, start('18:45:59') + fail('18:46:00') + start('21:10:00'));
  assert.match(failed.stdout, /run_1840=yes outcome_1840=failed run_2110=yes outcome_2110=unknown/);
  const outside = run(t, start('18:39:59') + finish('18:40:05') + start('21:16:00') + finish('21:17:00'));
  assert.match(outside.stdout, /run_1840=no outcome_1840=unknown run_2110=no outcome_2110=unknown/);
});

test('multiple or overlapping starts cannot be matched confidently', t => {
  const duplicate = run(t, start('18:40:00') + finish('18:41:00') + start('18:42:00') + finish('18:43:00'));
  assert.match(duplicate.stdout, /run_1840=yes outcome_1840=ambiguous/);
  const overlap = run(t, start('18:39:00') + start('18:40:00') + finish('18:41:00'));
  assert.match(overlap.stdout, /run_1840=yes outcome_1840=ambiguous/);
});

test('unavailable journal, unavailable timer and invalid dates are explicit', t => {
  const unavailable = run(t, '', { journalFail: true });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /journal=unavailable run_1840=unknown outcome_1840=unknown/);
  const timer = run(t, start('18:40:00') + finish('18:41:00'), { systemctlFail: true });
  assert.match(timer.stdout, /timer_status=unavailable/);
  assert.match(timer.stdout, /outcome_1840=success/);
  const invalid = run(t, '', { date: '20260230' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /invalid date/);
});
