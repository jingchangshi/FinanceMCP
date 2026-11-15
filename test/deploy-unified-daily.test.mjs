import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT = join(process.cwd(), 'deploy/ashare/run-daily-unified.sh');
const TRADE_DATE = '20261113';

function setupHarness(t, { dailyPayloads, observeExit = 0, validationExists = true }) {
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
    writeFileSync(join(dir, `daily-${i + 1}.json`), JSON.stringify(dailyPayloads[i], null, 2));
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
        echo '{"status":"READY","recorded":true,"as_of_trade_date":"${TRADE_DATE}","private_output":"/private/research-bundles/VPS-BUNDLE-${TRADE_DATE}-mock.json"}'
        exit 0
        ;;
      *"cli.js portfolio-journal-review"*)
        echo '{"ok":true}'
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

  const run = (extraEnv = {}) =>
    spawnSync('sh', [SCRIPT, '--date', TRADE_DATE], {
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

  return {
    run,
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
      {
        report: { trade_date: TRADE_DATE, status: 'READY' },
        etf: { coverage: { [TRADE_DATE]: { missing: [] } } },
      },
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
      {
        report: { trade_date: TRADE_DATE, status: 'READY' },
        etf: { coverage: { [TRADE_DATE]: { missing: [] } } },
      },
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
      {
        report: { trade_date: TRADE_DATE, status: 'READY' },
        etf: { coverage: { [TRADE_DATE]: { missing: [] } } },
      },
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
