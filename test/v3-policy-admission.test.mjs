import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-policy-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
delete process.env.ASHARE_V3_ADMISSION_DB;

const { StrategyAdmissionStore } = await import('../build/ashare/strategyAdmission.js');
const {
  V3_OFFENSIVE_POLICY_RELEASE_V3_1_0,
  V3_OFFENSIVE_POLICY_RELEASE_V3_2_0,
  V3_POLICY_V3_1_0_HASH,
  V3_POLICY_EXPECTED_HASH,
  loadApprovedV3Policy,
} = await import('../build/portfolio/v3Policy.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { runActionEngine } = await import('../build/portfolio/actionEngine.js');

const ASOF = '20261231'; // 未来交易日：保证测试中“现在”记录的事件早于目标日北京时间收盘
const ACCOUNT = 'real-main';

const regime = {
  schema: 'ashare-market-regime/1.0',
  as_of_trade_date: ASOF,
  available: true,
  regime: 'OFFENSIVE',
  raw_regime: 'OFFENSIVE',
  target_equity_bps: 8500,
  target_equity_pct: 85,
  hysteresis_held: false,
  crash_override: false,
  style: 'GROWTH_LEADING',
  style_spread_20d_pct: null,
  value_anchor: {},
  growth_anchor: {},
  breadth: {},
  history: [],
  regime_label_zh: '进攻',
  style_label_zh: '成长占优',
  summary_zh: '',
  notes: [],
};

/** 与 strategyRelease.ts 相同的 canonical JSON 摘要，仅测试伪造“自洽但未批准”文件用。 */
function canonical(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function resign(release) {
  const { content_hash, ...payload } = release;
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}
function writeRelease(name, release) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(release));
  return path;
}
function load(options = {}) {
  return loadApprovedV3Policy({ accountId: ACCOUNT, asOf: ASOF, ...options });
}

function privateAdmissionPath(name) {
  const admissionDir = join(dir, `private-${name}`);
  chmodSync(dir, 0o700);
  mkdirSync(admissionDir, { recursive: true, mode: 0o700 });
  chmodSync(admissionDir, 0o700);
  return join(admissionDir, 'admission.sqlite');
}

function scopeOf(release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, account = ACCOUNT) {
  return {
    account,
    market: release.applicability.market,
    environment: release.applicability.environment,
  };
}

function grantRelease(store, release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0) {
  store.record('GRANT', release, scopeOf(release), {
    reason: 'test grant',
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
  });
}

function recordAction(path, action, release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0) {
  const store = new StrategyAdmissionStore(path);
  try {
    store.record(action, release, scopeOf(release), { reason: `test ${action}` });
  } finally {
    store.close();
  }
}

test('P1-3: 覆盖路径缺失/非法 JSON 回退内嵌基线并停新增买入，但不抛错', () => {
  try {
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = join(dir, 'does-not-exist.json');
    const missing = load();
    assert.equal(missing.content_hash, V3_POLICY_EXPECTED_HASH);
    assert.equal(missing.version, 'v3.2.0');
    assert.ok(missing.override_diagnostics.some(line => line.includes('v3_policy_override_missing')));
    assert.equal(missing.runtime_can_open, true, '未部署覆盖文件不得阻断');

    const bad = join(dir, 'invalid.json');
    writeFileSync(bad, '{ this is not json');
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = bad;
    const invalid = load();
    assert.equal(invalid.content_hash, V3_POLICY_EXPECTED_HASH, '坏文件回退内嵌签名基线');
    assert.ok(invalid.override_diagnostics.some(line => line.includes('v3_policy_override_invalid_json')));
    assert.equal(invalid.runtime_can_open, false, '坏覆盖文件只停新增买入');
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  }
});

test('P1-3: 篡改哈希/未列白名单/身份不符均回退内嵌基线并停新增买入', () => {
  try {
    const tampered = { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, content_hash: 'f'.repeat(64) };
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('tampered-hash.json', tampered);
    const tamperedPolicy = load();
    assert.equal(tamperedPolicy.content_hash, V3_POLICY_EXPECTED_HASH);
    assert.ok(tamperedPolicy.override_diagnostics.some(line => line.includes('v3_policy_override_invalid_release')));
    assert.equal(tamperedPolicy.runtime_can_open, false);

    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v310.json', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0);
    const notAllowed = load();
    assert.equal(notAllowed.content_hash, V3_POLICY_EXPECTED_HASH);
    assert.ok(notAllowed.override_diagnostics.some(line => line.includes('v3_policy_override_hash_not_allowed')));
    assert.equal(notAllowed.runtime_can_open, false);

    const wrongStrategy = {
      ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0,
      strategy: { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.strategy, id: 'OTHER_STRATEGY' },
    };
    const strategyHash = resign(wrongStrategy);
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('wrong-strategy.json', { ...wrongStrategy, content_hash: strategyHash });
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = strategyHash;
    const wrong = load();
    assert.equal(wrong.content_hash, V3_POLICY_EXPECTED_HASH);
    assert.ok(wrong.override_diagnostics.some(line => line.includes('v3_policy_override_strategy_mismatch')));
    assert.equal(wrong.runtime_can_open, false);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  }
});

test('P1-3: 内嵌 v3.2.0 无需覆盖即通过哈希校验', () => {
  const policy = load();
  assert.equal(policy.content_hash, V3_POLICY_EXPECTED_HASH);
  assert.equal(policy.version, 'v3.2.0');
  assert.deepEqual(policy.override_diagnostics, []);
  assert.equal(policy.runtime_can_open, true);
  assert.equal(policy.runtime_admission.configured, false);
});

test('P1-3: 命中白名单的覆盖文件按文件内容加载（v3.2.0 与 v3.1.0）', () => {
  try {
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v320.json', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0);
    const v320 = load();
    assert.equal(v320.version, 'v3.2.0');
    assert.equal(v320.content_hash, V3_POLICY_EXPECTED_HASH);
    assert.deepEqual(v320.override_diagnostics, []);
    assert.equal(v320.runtime_can_open, true);

    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v310-allowlisted.json', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0);
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = `${V3_POLICY_EXPECTED_HASH},${V3_POLICY_V3_1_0_HASH}`;
    const v310 = load();
    assert.equal(v310.version, 'v3.1.0');
    assert.equal(v310.content_hash, V3_POLICY_V3_1_0_HASH);
    assert.equal(v310.runtime_can_open, true);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  }
});

test('P1-3: 准入账本按实际 accountId/asOf 评估 GRANT/SUSPEND/RESUME/REVOKE', () => {
  const path = privateAdmissionPath('lifecycle');
  const store = new StrategyAdmissionStore(path, { create: true });
  try {
    grantRelease(store);
  } finally {
    store.close();
  }
  process.env.ASHARE_V3_ADMISSION_DB = path;
  try {
    const granted = load();
    assert.equal(granted.runtime_admission.store_available, true);
    assert.equal(granted.runtime_admission.latest_action, 'GRANT');
    assert.equal(granted.runtime_admission.evaluated_as_of, '2026-12-31T07:00:00.000Z');
    assert.equal(granted.runtime_can_open, true);

    recordAction(path, 'SUSPEND');
    const suspended = load();
    assert.equal(suspended.runtime_admission.latest_action, 'SUSPEND');
    assert.equal(suspended.runtime_admission.latest_in_validity, true);
    assert.equal(suspended.runtime_can_open, false);

    recordAction(path, 'RESUME');
    assert.equal(load().runtime_can_open, true);

    recordAction(path, 'REVOKE');
    const revoked = load();
    assert.equal(revoked.runtime_admission.latest_action, 'REVOKE');
    assert.equal(revoked.runtime_can_open, false);

    // 实际账户不同 → 该账户没有事件，不阻断。
    assert.equal(load({ accountId: 'other-account' }).runtime_can_open, true);
    // 未提供实际账户/日期 → 跳过准入评估，不使用环境变量或墙钟。
    assert.equal(loadApprovedV3Policy().runtime_can_open, true);
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
  }
});

test('P1-3: 准入按北京时间收盘评估，只取评估时刻前已记录的事件', () => {
  const path = privateAdmissionPath('time-travel');
  const store = new StrategyAdmissionStore(path, { create: true });
  store.close();
  const raw = new DatabaseSync(path);
  const release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0;
  const scope = scopeOf(release);
  const insert = raw.prepare(`
    INSERT INTO admission_events
      (action, strategy_id, version, release_hash, account, market, environment,
       valid_from, valid_until, recorded_at, uid, operator, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const add = (action, recordedAt) => insert.run(
    action, release.strategy.id, release.strategy.version, V3_POLICY_EXPECTED_HASH,
    scope.account, scope.market, scope.environment,
    '2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z',
    recordedAt, process.getuid?.() ?? 0, 'test', 'test fixture',
  );
  add('GRANT', '2026-01-01T00:00:00.000Z');
  add('SUSPEND', '2026-06-01T00:00:00.000Z');
  add('RESUME', '2026-12-15T00:00:00.000Z'); // 晚于 2026-11-20 收盘
  raw.close();

  process.env.ASHARE_V3_ADMISSION_DB = path;
  try {
    const before = load({ asOf: '20261120' });
    assert.equal(before.runtime_admission.evaluated_as_of, '2026-11-20T07:00:00.000Z', '应以北京时间 15:00 收盘评估');
    assert.equal(before.runtime_admission.latest_action, 'SUSPEND', '未来的 RESUME 不得解除昨日回放');
    assert.equal(before.runtime_can_open, false);

    const after = load({ asOf: '20261231' });
    assert.equal(after.runtime_admission.latest_action, 'RESUME');
    assert.equal(after.runtime_can_open, true);
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
  }
});

test('P1-3: 准入库不存在/无事件时不阻断新开仓', () => {
  const emptyPath = privateAdmissionPath('empty');
  const empty = new StrategyAdmissionStore(emptyPath, { create: true });
  empty.close();
  process.env.ASHARE_V3_ADMISSION_DB = emptyPath;
  try {
    const noEvent = load();
    assert.equal(noEvent.runtime_can_open, true, '无事件不得阻断');
    assert.equal(noEvent.runtime_admission.latest_action, null);
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
  }

  process.env.ASHARE_V3_ADMISSION_DB = join(dir, 'missing-admission.sqlite');
  try {
    const missing = load();
    assert.equal(missing.runtime_can_open, true, '库不存在不得阻断');
    assert.equal(missing.runtime_admission.store_available, false);
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
  }
});

test('P1-3: SUSPEND 只冻结新增买入，P1 止损卖单照常生成', () => {
  const path = privateAdmissionPath('engine');
  const store = new StrategyAdmissionStore(path, { create: true });
  try {
    grantRelease(store);
    store.record('SUSPEND', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, scopeOf(), { reason: 'test suspend' });
  } finally {
    store.close();
  }

  const db = openPortfolioDb(join(dir, 'admission-engine-portfolio.sqlite'), {
    marketPath: join(dir, 'admission-engine-market.sqlite'),
  });
  const holdings = [{
    ts_code: '600000.SH',
    name: '浦发银行测试',
    quantity: 1000,
    sellable_quantity: 1000,
    weight: 0.09,
    market_value_cents: 900_000,
    price_milli: 9000,
    latest_bar_date: ASOF,
    bar_quality: 'READY',
    ref_cost_milli: 10_000,
  }];
  const stockSwingScreen = {
    candidates: [{
      ts_code: '601001.SH',
      name: '测试回踩',
      trade_date: ASOF,
      entry_ref_price_milli: 10_000,
      hard_stop_price_milli: 9_200,
      entry_ref_price_cny: 10,
      max_chase_price_cny: 10.2,
      hard_stop_price_cny: 9.2,
      stop_loss_pct: -8,
      setup_label_zh: '缩量回踩 20 日均线',
      reasons_zh: ['测试候选'],
    }],
  };
  const run = () => runActionEngine({
    portfolioDb: db,
    marketDb: null,
    accountId: ACCOUNT,
    asOf: ASOF,
    holdings,
    cashCents: 9_100_000,
    totalAssetsCents: 10_000_000,
    marketRegime: regime,
    stockSwingScreen,
  });
  try {
    delete process.env.ASHARE_V3_ADMISSION_DB;
    const open = run();
    assert.equal(open.router.circuit_breaker_status, 'NORMAL');
    assert.ok(open.actions.some(a => a.code === 'P3-STOCK-SWING-BUY-601001.SH'), '准入未配置时必须保持原有买入行为');

    process.env.ASHARE_V3_ADMISSION_DB = path;
    const suspended = run();
    assert.ok(suspended.actions.some(a => a.code === 'P1-STOP-SELL-600000.SH'), 'SUSPEND 不得阻断止损卖单');
    assert.equal(
      suspended.actions.some(a => a.legs.some(leg => leg.side === 'BUY')),
      false,
      'SUSPEND 期间不得生成任何新增买入腿',
    );
    assert.ok(suspended.blockers.some(line => line.includes('策略准入')), '必须留下准入阻断说明');
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
    db.close();
  }
});
