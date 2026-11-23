import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT = join(process.cwd(), 'deploy/ashare/run-daily-unified.sh');
const TRADE_DATE = '20261113';
// Mirrors ETF_UNIVERSE from src/ashare/etfDeclarations.ts. The daily JSON carries
// its own `expected` set; these tests feed the same shape the pipeline emits.
const ETF_CODES = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];

function readyEtf(date = TRADE_DATE) {
  return {
    etf: {
      coverage: {
        [date]: {
          date, expected: [...ETF_CODES], ready: [...ETF_CODES],
          no_upstream_bar: [], missing: [], errors: [],
        },
      },
      fund_nav: {
        dates: [date], rows: 120, per_date: { [date]: 120 }, fallback_codes: [], errors: [],
      },
      errors: [],
    },
  };
}

function setupHarness(t, { dailyPayloads, observeExit = 0, validationExists = true, recordExit = 0, recordAsOf = TRADE_DATE }) {
  const dir = mkdtempSync(join(tmpdir(), 'unified-daily-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const binDir = join(dir, 'bin');
  const dataDir = join(dir, 'data');
  const privateDir = join(dir, 'private');
  const bundlesDir = join(privateDir, 'research-bundles');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bundlesDir, { recursive: true });

  const bundleHostPath = join(bundlesDir, `VPS-BUNDLE-${TRADE_DATE}-mock.json`);
  writeFileSync(bundleHostPath, JSON.stringify({ as_of_trade_date: TRADE_DATE }));

  const feishuConfig = join(dir, 'feishu-config.json');
  writeFileSync(feishuConfig, JSON.stringify({ enabled: true }));

  const counterFile = join(dir, 'daily-count');
  writeFileSync(counterFile, '0');
  const dockerLog = join(dir, 'docker.log');
  const pythonLog = join(dir, 'python.log');

  for (let i = 0; i < dailyPayloads.length; i += 1) {
    const payload = dailyPayloads[i];
    writeFileSync(
      join(dir, `daily-${i + 1}.json`),
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    );
  }
  writeFileSync(
    join(dir, 'observe.json'),
    JSON.stringify(
      observeExit === 0
        ? { id: 'OBS-1', type: 'TRUE_FORWARD_OBSERVATION' }
        : { status: 'UNAVAILABLE', reason: 'matching_active_freeze_unavailable', mismatched: ['implementation_hash'] },
    ),
  );

  writeFileSync(
    join(binDir, 'docker'),
    `#!/bin/sh
echo "$*" >> "${dockerLog}"
case "$1" in
  info) exit 0 ;;
  inspect) echo "running/healthy"; exit 0 ;;
  exec)
    shift; shift
    case "$*" in
      "test -f "*) exit ${validationExists ? 0 : 1} ;;
      *"cli.js daily"*)
        c=$(cat "${counterFile}")
        c=$((c + 1))
        printf '%s' "$c" > "${counterFile}"
        f="${dir}/daily-$c.json"
        if [ ! -f "$f" ]; then f="${dir}/daily-${dailyPayloads.length}.json"; fi
        cat "$f"
        exit 0
        ;;
      *"cli.js research-validation observe"*)
        cat "${dir}/observe.json"
        exit 0
        ;;
      *"cli.js hotspot-sync"*)
        echo '{"ok":true}'
        exit 0
        ;;
      *"cli.js hotspot-snapshot"*)
        echo '{"snapshot":{"as_of":"${TRADE_DATE}"},"readiness":{"status":"READY"}}'
        exit 0
        ;;
      *"cli.js investment-research-record"*)
        echo '{"status":"READY","recorded":true,"as_of_trade_date":"${recordAsOf}","private_output":"/private/research-bundles/VPS-BUNDLE-${TRADE_DATE}-mock.json"}'
        exit ${recordExit}
        ;;
      *"cli.js portfolio-journal-review"*)
        echo '{"ok":true}'
        exit 0
        ;;
      *"cli.js investment-research-bundle"*)
        echo '{"as_of_trade_date":"${TRADE_DATE}"}'
        exit 0
        ;;
    esac
    ;;
esac
exit 0
`,
  );
  chmodSync(join(binDir, 'docker'), 0o755);

  const mockPython = join(binDir, 'mock-python');
  writeFileSync(
    mockPython,
    `#!/bin/sh
echo "$*" >> "${pythonLog}"
echo '{"status":"ok","trade_date":"${TRADE_DATE}","publish":{"document_url":"https://my.feishu.cn/docx/mock"},"notify":{"status":"sent"}}'
exit 0
`,
  );
  chmodSync(mockPython, 0o755);

  const runScript = (args = ['--date', TRADE_DATE], extraEnv = {}) =>
    spawnSync('sh', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ASHARE_SG_REEXEC: '1',
        ASHARE_DOCKER_WAIT_SECONDS: '1',
        ASHARE_HOST_DATA_DIR: dataDir,
        ASHARE_PRIVATE_HOST_DIR: privateDir,
        ASHARE_FEISHU_CONFIG: feishuConfig,
        ASHARE_PYTHON_BIN: mockPython,
        ASHARE_READINESS_POLL_SECONDS: '1',
        ASHARE_NOW_HM_OVERRIDE: '1725',
        ASHARE_READINESS_DEADLINE_HM: '2115',
        ...extraEnv,
      },
    });
  const run = (extraEnv = {}) => runScript(['--date', TRADE_DATE], extraEnv);

  return {
    dir,
    binDir,
    dataDir,
    run,
    runScript,
    readDockerLog: () => (existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''),
    readPythonLog: () => (existsSync(pythonLog) ? readFileSync(pythonLog, 'utf8') : ''),
    getDailyCalls: () => Number(readFileSync(counterFile, 'utf8')),
  };
}

test('U1 non-trading day exits 0 immediately without hotspot, account or Feishu', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ trade_date: TRADE_DATE, skipped: true, reason: '非交易日' }],
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /SKIPPED: non-trading day/);
  assert.doesNotMatch(h.readDockerLog(), /hotspot-sync|investment-research-record/);
  assert.equal(h.readPythonLog(), '');
});

test('U2 READY on first pass runs all stages sequentially without sleeping or delay flag', t => {
  const h = setupHarness(t, {
    dailyPayloads: [
      { report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() },
    ],
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(h.getDailyCalls(), 1);
  assert.match(res.stdout, /Stage 1 READY on attempt 1/);
  assert.match(res.stdout, /finance-ashare feishu ok:/);

  const dockerCalls = h.readDockerLog();
  const idxDaily = dockerCalls.indexOf('cli.js daily');
  const idxHotspot = dockerCalls.indexOf('cli.js hotspot-sync');
  const idxAcct = dockerCalls.indexOf('cli.js investment-research-record');
  const idxReview = dockerCalls.indexOf('cli.js portfolio-journal-review');
  assert.ok(idxDaily >= 0 && idxHotspot > idxDaily && idxAcct > idxHotspot && idxReview > idxAcct);

  const pyCalls = h.readPythonLog();
  assert.match(pyCalls, /publish_and_notify\.py/);
  assert.doesNotMatch(pyCalls, /--data-delayed/);
});

test('U3 NOT_READY retries within poll window and proceeds once READY', t => {
  const h = setupHarness(t, {
    dailyPayloads: [
      {
        report: { trade_date: TRADE_DATE, status: 'NOT_READY' },
        etf: { coverage: { [TRADE_DATE]: { missing: ['510300.SH'] } } },
      },
      { report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() },
    ],
  });
  const res = h.run({ ASHARE_NOW_HM_OVERRIDE: '1800' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(h.getDailyCalls(), 2);
  assert.match(res.stderr, /waiting for readiness \(attempt=1/);
  assert.match(res.stdout, /Stage 1 READY on attempt 2/);
  assert.doesNotMatch(h.readPythonLog(), /--data-delayed/);
});

test('U4 observe exit 79 does not block hotspot, account-daily or Feishu push when market is READY', t => {
  const h = setupHarness(t, {
    dailyPayloads: [
      { report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() },
    ],
    observeExit: 79,
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /closed-loop observe exited 79/);
  assert.match(h.readDockerLog(), /hotspot-snapshot/);
  assert.match(h.readDockerLog(), /investment-research-record/);
  assert.match(h.readPythonLog(), /publish_and_notify\.py/);
});

test('U5 polling triggers one-shot delay alert at configured attempt then publishes without delay flag when READY', t => {
  const h = setupHarness(t, {
    dailyPayloads: [
      { report: { trade_date: TRADE_DATE, status: 'NOT_READY' }, etf: { coverage: { [TRADE_DATE]: { missing: [] } } } },
      { report: { trade_date: TRADE_DATE, status: 'NOT_READY' }, etf: { coverage: { [TRADE_DATE]: { missing: [] } } } },
      { report: { trade_date: TRADE_DATE, status: 'NOT_READY' }, etf: { coverage: { [TRADE_DATE]: { missing: [] } } } },
      { report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() },
    ],
  });
  const delayScript = join(h.dir, 'mock-delay-alert.py');
  writeFileSync(delayScript, '#!/usr/bin/env python3\n');
  chmodSync(delayScript, 0o755);

  const res = h.run({
    ASHARE_DELAY_ALERT_ATTEMPT: '2',
    ASHARE_DELAY_ALERT_SCRIPT: delayScript,
    ASHARE_READINESS_POLL_SECONDS: '0',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(h.getDailyCalls(), 4);

  const pyLines = h.readPythonLog().trim().split('\n').filter(Boolean);
  const delayCalls = pyLines.filter(l => l.includes('mock-delay-alert.py'));
  const publishCalls = pyLines.filter(l => l.includes('publish_and_notify.py'));
  assert.equal(delayCalls.length, 1, h.readPythonLog());
  assert.match(delayCalls[0], new RegExp(`--trade-date ${TRADE_DATE} --status NOT_READY --attempt 2`));
  assert.equal(publishCalls.length, 1, h.readPythonLog());
  assert.doesNotMatch(publishCalls[0], /--data-delayed/);
  assert.equal(existsSync(join(h.dir, 'data', 'logs', `delay-alert-${TRADE_DATE}.sent`)), true);
});

test('U6 deadline reached without daily JSON logs warning and falls back to live bundle with --data-delayed', t => {
  const h = setupHarness(t, {
    dailyPayloads: [],
  });
  const crashDaily = join(h.dir, 'crash-daily.sh');
  writeFileSync(crashDaily, '#!/bin/sh\necho "upstream timeout" >&2\nexit 1\n');
  chmodSync(crashDaily, 0o755);

  const noBundleAccount = join(h.dir, 'no-bundle-account.sh');
  writeFileSync(noBundleAccount, '#!/bin/sh\necho "no account bundle written"\nexit 0\n');
  chmodSync(noBundleAccount, 0o755);

  const res = h.run({
    ASHARE_DAILY_SCRIPT: crashDaily,
    ASHARE_ACCOUNT_SCRIPT: noBundleAccount,
    ASHARE_MAX_WAIT_ATTEMPTS: '1',
    ASHARE_READINESS_POLL_SECONDS: '0',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /deadline reached without daily JSON/);
  assert.match(h.readDockerLog(), /investment-research-bundle/);
  const publishLine = h.readPythonLog().trim().split('\n').find(l => l.includes('publish_and_notify.py')) ?? '';
  assert.match(publishLine, /--data-delayed/);
});

function notReadyRun(t, payload, extraEnv = {}) {
  const h = setupHarness(t, { dailyPayloads: [payload] });
  const res = h.run({ ASHARE_MAX_WAIT_ATTEMPTS: '1', ...extraEnv });
  assert.equal(res.status, 0, res.stderr);
  const publishLine = h.readPythonLog().trim().split('\n').find(l => l.includes('publish_and_notify.py')) ?? '';
  assert.match(publishLine, /--data-delayed/, `expected a delayed banner: ${res.stderr}`);
  return { h, res, publishLine };
}

test('U7 missing ETF coverage entry is not READY (empty/missing must never pass)', t => {
  const { res } = notReadyRun(t, {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: { coverage: {}, errors: [] },
  });
  assert.match(res.stderr, /etf_state=coverage_entry_missing/);
});

test('U8 no_upstream_bar/ready-set incompleteness are not READY', t => {
  const suspended = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: {
      coverage: {
        [TRADE_DATE]: {
          date: TRADE_DATE, expected: [...ETF_CODES], ready: [...ETF_CODES],
          no_upstream_bar: ['159278.SZ'], missing: [], errors: [],
        },
      },
      fund_nav: { dates: [TRADE_DATE], rows: 1, per_date: { [TRADE_DATE]: 1 }, fallback_codes: [], errors: [] },
      errors: [],
    },
  };
  const { res } = notReadyRun(t, suspended);
  assert.match(res.stderr, /etf_state=no_upstream_bar/);

  const h2 = setupHarness(t, {
    dailyPayloads: [{
      report: { trade_date: TRADE_DATE, status: 'READY' },
      ...readyEtf(),
    }],
  });
  const incomplete = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: {
      coverage: {
        [TRADE_DATE]: {
          date: TRADE_DATE, expected: [...ETF_CODES],
          ready: ETF_CODES.slice(0, 4), no_upstream_bar: [], missing: [], errors: [],
        },
      },
      fund_nav: { dates: [TRADE_DATE], rows: 1, per_date: { [TRADE_DATE]: 1 }, fallback_codes: [], errors: [] },
      errors: [],
    },
  };
  writeFileSync(join(h2.dir, 'daily-1.json'), JSON.stringify(incomplete));
  const res2 = h2.run({ ASHARE_MAX_WAIT_ATTEMPTS: '1' });
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stderr, /etf_state=ready_set_incomplete/);
  assert.match(h2.readPythonLog(), /--data-delayed/);
});

test('U9 ETF sync errors/fatal and fund_nav failures force the delayed banner', t => {
  const withErrors = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    ...readyEtf(),
  };
  withErrors.etf.errors = ['fund_adj 159241.SZ: 无数据或请求失败'];
  const { res } = notReadyRun(t, withErrors);
  assert.match(res.stderr, /etf_state=etf_errors/);

  const crashed = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: { coverage: {}, errors: ['ETF 同步失败（已隔离）: exploded'], fatal: 'exploded' },
  };
  const h2 = setupHarness(t, { dailyPayloads: [crashed] });
  const res2 = h2.run({ ASHARE_MAX_WAIT_ATTEMPTS: '1' });
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stderr, /etf_state=(coverage_entry_missing|etf_fatal)/);
  assert.match(h2.readPythonLog(), /--data-delayed/);
});

test('U10 malformed daily JSON is never accepted as READY', t => {
  const { res } = notReadyRun(t, '{ this is not json');
  assert.match(res.stderr, /etf_state=(jq_failed|daily_json_missing)/);
});

test('U11 account-daily failure is not published as a normal report', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
    recordExit: 1,
  });
  const res = h.run();
  // The unit stays visibly failed (account stage exit), but the user still gets
  // the fallback report with an explicit delay banner - never a "normal" one.
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /account-daily exited 1 \(RC=1\); forcing the delayed-data banner/);
  assert.match(h.readDockerLog(), /investment-research-bundle/);
  const publishLine = h.readPythonLog().trim().split('\n').find(l => l.includes('publish_and_notify.py')) ?? '';
  assert.match(publishLine, /--data-delayed/);
});

test('U12 account bundle for a different trade date is not used; fallback bundle is delayed', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
    recordAsOf: '20261112',
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /account bundle is not for 20261113/);
  assert.match(h.readDockerLog(), /investment-research-bundle/);
  const publishLine = h.readPythonLog().trim().split('\n').find(l => l.includes('publish_and_notify.py')) ?? '';
  assert.match(publishLine, /--data-delayed/);
});

test('U13 without --date the most recent closed trading day from trade_cal is used and passed to daily', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
  });
  writeFileSync(join(h.dataDir, 'ashare.sqlite'), '');
  writeFileSync(join(h.binDir, 'sqlite3'), '#!/bin/sh\nprintf "20261113\\n"\nexit 0\n');
  chmodSync(join(h.binDir, 'sqlite3'), 0o755);
  const res = h.runScript([], {
    ASHARE_TODAY_OVERRIDE: '20261114',
    ASHARE_NOW_HM_OVERRIDE: '1725',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /expected date: 20261113/);
  assert.match(h.readDockerLog(), /cli\.js daily --date 20261113/);
  assert.match(res.stdout, /Stage 1 READY on attempt 1/);
  assert.doesNotMatch(h.readPythonLog(), /--data-delayed/);
});
