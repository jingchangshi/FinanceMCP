import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/ashare/check-schedule.sh', import.meta.url));
const unit = 'finance-ashare-daily.service';
const monthlyUnit = 'finance-ashare-research-monthly.service';
const line = (time, message) => `2026-10-19T${time}+0800 host systemd[123]: ${message}\n`;
const start = time => line(time, 'Starting A-share daily...');
const finish = time => line(time, 'Finished A-share daily.');
const fail = time => line(time, `${unit}: Failed with result 'exit-code'.`);
const monthlyStart = time => line(time, 'Starting A-share monthly forward review...');
const monthlyFinish = time => line(time, 'Finished A-share monthly forward review.');

function run(t, journal, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-schedule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'journal');
  const monthlyLog = join(dir, 'monthly-journal');
  writeFileSync(log, journal);
  writeFileSync(monthlyLog, options.monthlyJournal ?? '');
  for (const [name, content] of Object.entries({
    journalctl: `#!/bin/sh
case "$*" in
  *${monthlyUnit}*) [ "\${MONTHLY_JOURNAL_FAIL:-0}" = 0 ] || exit 1; exec /bin/cat "$MONTHLY_JOURNAL_FIXTURE" ;;
  *) [ "\${JOURNAL_FAIL:-0}" = 0 ] || exit 1; exec /bin/cat "$JOURNAL_FIXTURE" ;;
esac
`,
    systemctl: '#!/bin/sh\n[ "${SYSTEMCTL_FAIL:-0}" = 0 ] || exit 1\nprintf "LastTriggerUSec=Mon 2026-10-19 21:10:00 CST\\n"\n',
  })) {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  return spawnSync(script, [options.date ?? '20261019'], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`,
      JOURNAL_FIXTURE: log, MONTHLY_JOURNAL_FIXTURE: monthlyLog,
      JOURNAL_FAIL: options.journalFail ? '1' : '0',
      MONTHLY_JOURNAL_FAIL: options.monthlyJournalFail ? '1' : '0',
      SYSTEMCTL_FAIL: options.systemctlFail ? '1' : '0',
    },
  });
}

test('window starts and their own finishes are observed, but timer origin stays unknown', t => {
  const result = run(t, start('19:30:00') + finish('19:45:00'), {
    monthlyJournal: monthlyStart('22:15:00') + monthlyFinish('22:20:00'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run_1930=yes outcome_1930=success deadline_2115=met run_2215=yes outcome_2215=success trigger_source=unknown schedule=UNKNOWN/);
});

test('a run finishing after the 21:15 readiness deadline is reported as exceeded', t => {
  const result = run(t, start('19:30:00') + finish('21:20:00'));
  assert.match(result.stdout, /run_1930=yes outcome_1930=success deadline_2115=exceeded/);
});

test('unrelated finishes cannot prove incomplete window starts succeeded', t => {
  const result = run(t, start('10:00:00') + finish('10:01:00') + start('12:00:00') + finish('12:01:00') + start('19:31:00'), {
    monthlyJournal: start('22:16:00'),
  });
  assert.match(result.stdout, /run_1930=yes outcome_1930=unknown deadline_2115=unknown/);
  assert.match(result.stdout, /run_2215=yes outcome_2215=unknown/);
  assert.doesNotMatch(result.stdout, /outcome_1930=success|outcome_2215=success|schedule=PASS/);
});

test('failed, unfinished and out-of-window runs remain distinct', t => {
  const failed = run(t, start('19:35:59') + fail('19:36:00'));
  assert.match(failed.stdout, /run_1930=yes outcome_1930=failed/);
  const outside = run(t, start('19:29:59') + finish('19:30:05') + start('19:36:00') + finish('19:37:00'), {
    monthlyJournal: monthlyStart('22:14:00') + monthlyFinish('22:15:00'),
  });
  assert.match(outside.stdout, /run_1930=no outcome_1930=unknown deadline_2115=unknown run_2215=no outcome_2215=unknown/);
});

test('multiple or overlapping starts cannot be matched confidently', t => {
  const duplicate = run(t, start('19:30:00') + finish('19:31:00') + start('19:32:00') + finish('19:33:00'));
  assert.match(duplicate.stdout, /run_1930=yes outcome_1930=ambiguous/);
  const overlap = run(t, start('19:29:00') + start('19:30:00') + finish('19:31:00'));
  assert.match(overlap.stdout, /run_1930=yes outcome_1930=ambiguous/);
});

test('unavailable journal, unavailable timer and invalid dates are explicit', t => {
  const unavailable = run(t, '', { journalFail: true });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /journal=unavailable journal_monthly=unknown run_1930=unknown outcome_1930=unknown deadline_2115=unknown run_2215=unknown outcome_2215=unknown/);
  const timer = run(t, start('19:30:00') + finish('19:31:00'), { systemctlFail: true });
  assert.match(timer.stdout, /timer_status=unavailable/);
  assert.match(timer.stdout, /outcome_1930=success/);
  const invalid = run(t, '', { date: '20260230' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /invalid date/);
});

test('an unavailable monthly journal leaves the daily evidence intact', t => {
  const result = run(t, start('19:30:00') + finish('19:31:00'), { monthlyJournalFail: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /journal=available journal_monthly=unavailable run_1930=yes outcome_1930=success deadline_2115=met run_2215=unknown outcome_2215=unknown/);
});
