import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const read = path => readFileSync(join(root, path), 'utf8');

test('the monthly timer fires daily after the weekly window and leaves month-end to the cadence', () => {
  const timer = read('deploy/ashare/finance-ashare-research-monthly.timer');
  const calendars = timer.split('\n').filter(line => line.startsWith('OnCalendar='));
  assert.deepEqual(calendars, ['OnCalendar=Mon..Fri *-*-* 22:15:00 Asia/Shanghai'],
    'exactly one daily 22:15 CST trigger, after the 21:50 weekly run');
  assert.match(timer, /Persistent=true/);
});

test('the monthly cadence gate is visible in the manual runner', () => {
  const runner = read('deploy/ashare/run-research-cadence.sh');
  assert.match(runner, /--force/, 'a manual out-of-window review needs an explicit override');
  assert.match(runner, /ASHARE_CADENCE_FORCE/);
  const syntax = spawnSync('sh', ['-n', join(root, 'deploy/ashare/run-research-cadence.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const bad = spawnSync('sh', [join(root, 'deploy/ashare/run-research-cadence.sh'), 'monthly', '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2, 'an unknown argument must be rejected before any docker call');
  assert.match(bad.stderr, /unknown argument/)
});

test('the retired account timer cannot be enabled alongside the unified timer', () => {
  const timer = read('deploy/ashare/finance-ashare-account-daily.timer');
  assert.match(timer, /RETIRED AS STANDALONE TIMER/, 'the retirement note must remain for manual reference');
  assert.doesNotMatch(timer, /^\[Install\]/m, 'no [Install] section: systemctl enable must fail');
  assert.doesNotMatch(timer, /WantedBy=timers\.target/);
  // upgrade.sh keeps it only as a backup input; it must not install or enable it.
  const upgrade = read('deploy/ashare/upgrade.sh');
  assert.doesNotMatch(upgrade, /systemctl[^\n]*enable[^\n]*finance-ashare-account-daily/);
  assert.doesNotMatch(upgrade, /cp\s+[^\n]*finance-ashare-account-daily\.timer[^\n]*\.config\/systemd/);
});

test('the schedule reporter describes the current windows instead of the retired 18:40/21:10 pair', () => {
  const script = read('deploy/ashare/check-schedule.sh');
  assert.match(script, /19:30:00 19:35:59/);
  assert.match(script, /22:15:00 22:20:59/);
  assert.match(script, /21:15:00/);
  assert.doesNotMatch(script, /18:40|21:10/);
  const syntax = spawnSync('sh', ['-n', join(root, 'deploy/ashare/check-schedule.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});
