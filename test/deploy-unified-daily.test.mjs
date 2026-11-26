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

function setupHarness(t, { dailyPayloads, observeExit = 0, validationExists = true, recordExit = 0, recordAsOf = TRADE_DATE, bundleFileAsOf = TRADE_DATE, liveBundleAsOf = TRADE_DATE }) {
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
  writeFileSync(bundleHostPath, JSON.stringify({ as_of_trade_date: bundleFileAsOf }));

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
        echo '{"as_of_trade_date":"${liveBundleAsOf}"}'
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

test('U2b DEGRADED on first pass counts as ready (isolated defects disclose, they do not hold the pipeline)', t => {
  const h = setupHarness(t, {
    dailyPayloads: [
      {
        report: { trade_date: TRADE_DATE, status: 'DEGRADED' },
        ...readyEtf(),
      },
    ],
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(h.getDailyCalls(), 1);
  assert.match(res.stdout, /Stage 1 DEGRADED on attempt 1/);
  assert.match(res.stdout, /finance-ashare feishu ok:/);

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

test('U8 a confirmed no-upstream-bar ETF is verified with a warning, not a blocker', t => {
  const suspended = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: {
      coverage: {
        [TRADE_DATE]: {
          date: TRADE_DATE, expected: [...ETF_CODES],
          ready: ETF_CODES.filter(c => c !== '159278.SZ'),
          no_upstream_bar: ['159278.SZ'], missing: [], errors: [],
        },
      },
      errors: [],
    },
  };
  const h = setupHarness(t, { dailyPayloads: [suspended] });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Stage 1 READY on attempt 1 .*etf_state=ready_with_suspended/);
  assert.match(res.stderr, /WARNING: confirmed no upstream bar .*159278\.SZ/);
  assert.doesNotMatch(h.readPythonLog(), /--data-delayed/);
});

test('U8b an incomplete verified set (ready + confirmed) is not READY', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
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
      errors: [],
    },
  };
  writeFileSync(join(h.dir, 'daily-1.json'), JSON.stringify(incomplete));
  const res = h.run({ ASHARE_MAX_WAIT_ATTEMPTS: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /etf_state=verified_set_incomplete/);
  assert.match(h.readPythonLog(), /--data-delayed/);
});

test('U9 only report-date/held-code ETF errors block; historical and fund_nav errors do not', t => {
  const heldError = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    ...readyEtf(),
  };
  heldError.etf.errors = ['fund_adj 159241.SZ: 无数据或请求失败'];
  const { res } = notReadyRun(t, heldError);
  assert.match(res.stderr, /etf_state=etf_errors/);

  const historicalOnly = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    ...readyEtf(),
  };
  historicalOnly.etf.errors = [
    'fund_daily_history 159555.SH: upstream timeout',
    'fund_nav 20261112: request failed',
    'fund_basic: permission denied',
  ];
  const h2 = setupHarness(t, { dailyPayloads: [historicalOnly] });
  const res2 = h2.run();
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stdout, /Stage 1 READY on attempt 1/);
  assert.doesNotMatch(h2.readPythonLog(), /--data-delayed/);

  const crashed = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: { coverage: {}, errors: ['ETF 同步失败（已隔离）: exploded'], fatal: 'exploded' },
  };
  const h3 = setupHarness(t, { dailyPayloads: [crashed] });
  const res3 = h3.run({ ASHARE_MAX_WAIT_ATTEMPTS: '1' });
  assert.equal(res3.status, 0, res3.stderr);
  assert.match(res3.stderr, /etf_state=coverage_entry_missing/);
  assert.match(h3.readPythonLog(), /--data-delayed/);
});

test('U9b missing/empty fund_nav does not block Stage 1 (NAV is disclosed, QDII buys gated later)', t => {
  const noNav = {
    report: { trade_date: TRADE_DATE, status: 'READY' },
    etf: {
      coverage: {
        [TRADE_DATE]: {
          date: TRADE_DATE, expected: [...ETF_CODES], ready: [...ETF_CODES],
          no_upstream_bar: [], missing: [], errors: [],
        },
      },
      errors: [],
    },
  };
  const h = setupHarness(t, { dailyPayloads: [noNav] });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Stage 1 READY on attempt 1/);
  assert.doesNotMatch(h.readPythonLog(), /--data-delayed/);

  const navErrors = JSON.parse(JSON.stringify(noNav));
  navErrors.etf.fund_nav = { dates: [TRADE_DATE], per_date: { [TRADE_DATE]: 0 }, fallback_codes: [], errors: ['fund_nav 159241.SZ: timeout'] };
  const h2 = setupHarness(t, { dailyPayloads: [navErrors] });
  const res2 = h2.run();
  assert.equal(res2.status, 0, res2.stderr);
  assert.match(res2.stdout, /Stage 1 READY on attempt 1/);
  assert.match(res2.stderr, /fund_nav reported 1 error/);
  assert.doesNotMatch(h2.readPythonLog(), /--data-delayed/);
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

test('U14 the expected date is passed to account generation and fallback bundle, and the bundle file date is validated', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
    bundleFileAsOf: '20261112',
  });
  const res = h.run();
  assert.equal(res.status, 0, res.stderr);
  // Account generation is pinned to the expected trade date.
  assert.match(h.readDockerLog(), /investment-research-record --require-current-snapshots --date 20261113/);
  // The receipt says 20261113 but the actual bundle is for another day: not used.
  assert.match(res.stderr, /account bundle as_of=20261112 != 20261113/);
  // The fallback bundle is generated for the expected date too.
  assert.match(h.readDockerLog(), /investment-research-bundle --account real-main --date 20261113/);
  assert.match(h.readPythonLog(), /--data-delayed/);
});

test('U15 a fallback bundle for another day is refused, never published as today', t => {
  const h = setupHarness(t, {
    dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
    recordExit: 1,
    liveBundleAsOf: '20261112',
  });
  const res = h.run();
  assert.equal(res.status, 74, res.stderr);
  assert.match(res.stderr, /fallback bundle as_of=20261112 != 20261113; refusing to publish another day as today/);
  assert.equal(h.readPythonLog(), '', 'no publish attempt for the wrong-date bundle');
});

test('U16 Stage 2 hotspot failure or exit 78 discloses CATALOG_UNAVAILABLE/DATA_DELAYED without blocking daily', t => {
  for (const code of [78, 13]) {
    const h = setupHarness(t, {
      dailyPayloads: [{ report: { trade_date: TRADE_DATE, status: 'READY' }, ...readyEtf() }],
    });
    const hotspotScript = join(h.dir, `mock-hotspot-${code}.sh`);
    writeFileSync(hotspotScript, `#!/bin/sh\necho "hotspot failed (${code})" >&2\nexit ${code}\n`);
    chmodSync(hotspotScript, 0o755);

    const res = h.run({ ASHARE_HOTSPOT_SCRIPT: hotspotScript });
    assert.equal(res.status, 0, `expected unified exit 0 when hotspot exits ${code}, stderr=${res.stderr}`);
    assert.match(res.stderr, new RegExp(`hotspot exited ${code}.*CATALOG_UNAVAILABLE / DATA_DELAYED`));
    assert.match(h.readDockerLog(), /investment-research-record/);
    const publishLine = h.readPythonLog().trim().split('\n').find(l => l.includes('publish_and_notify.py')) ?? '';
    assert.match(publishLine, /--data-delayed/);
  }
});
