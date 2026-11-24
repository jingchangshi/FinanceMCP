import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ashare-v3-policy-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'ashare.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio.sqlite');
process.env.ASHARE_ACCOUNT_ID = 'real-main';
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

const ASOF = '20261120';

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

function privateAdmissionPath(name) {
  const admissionDir = join(dir, `private-${name}`);
  chmodSync(dir, 0o700);
  mkdirSync(admissionDir, { recursive: true, mode: 0o700 });
  chmodSync(admissionDir, 0o700);
  return join(admissionDir, 'admission.sqlite');
}

function grantRelease(store, release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0) {
  store.record('GRANT', release, {
    account: 'real-main',
    market: release.applicability.market,
    environment: release.applicability.environment,
  }, {
    reason: 'test grant',
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
  });
}

function suspendRelease(store, release = V3_OFFENSIVE_POLICY_RELEASE_V3_2_0) {
  store.record('SUSPEND', release, {
    account: 'real-main',
    market: release.applicability.market,
    environment: release.applicability.environment,
  }, { reason: 'test suspend' });
}

test('P1-3: 覆盖路径缺失回退内嵌签名版本（不阻断日报）；非法 JSON 仍抛错', () => {
  process.env.ASHARE_V3_POLICY_RELEASE_PATH = join(dir, 'does-not-exist.json');
  try {
    const fallback = loadApprovedV3Policy();
    assert.equal(fallback.content_hash, V3_POLICY_EXPECTED_HASH, '未部署覆盖文件时使用内嵌 v3.2.0');
    assert.equal(fallback.version, 'v3.2.0');

    const bad = join(dir, 'invalid.json');
    writeFileSync(bad, '{ this is not json');
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = bad;
    assert.throws(() => loadApprovedV3Policy(), /v3_policy_override_invalid_json/);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
  }
});

test('P1-3: 内容哈希被篡改或不在白名单时拒绝加载', () => {
  try {
    const tampered = { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, content_hash: 'f'.repeat(64) };
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('tampered-hash.json', tampered);
    assert.throws(() => loadApprovedV3Policy(), /invalid_strategy_release/);

    // 自洽文件也不行：未列入 ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES 的 v3.1.0 必须拒绝。
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v310.json', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0);
    assert.throws(() => loadApprovedV3Policy(), /v3_policy_override_hash_not_allowed/);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  }
});

test('P1-3: 内嵌 v3.2.0 无需覆盖即通过白名单校验', () => {
  const policy = loadApprovedV3Policy();
  assert.equal(policy.content_hash, V3_POLICY_EXPECTED_HASH);
  assert.equal(policy.version, 'v3.2.0');
  assert.equal(policy.runtime_can_open, true);
  assert.equal(policy.runtime_admission.configured, false);
});

test('P1-3: 命中白名单的覆盖文件按文件内容加载（v3.2.0 与 v3.1.0）', () => {
  try {
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v320.json', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0);
    const v320 = loadApprovedV3Policy();
    assert.equal(v320.version, 'v3.2.0');
    assert.equal(v320.content_hash, V3_POLICY_EXPECTED_HASH);

    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('v310-allowlisted.json', V3_OFFENSIVE_POLICY_RELEASE_V3_1_0);
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = `${V3_POLICY_EXPECTED_HASH},${V3_POLICY_V3_1_0_HASH}`;
    const v310 = loadApprovedV3Policy();
    assert.equal(v310.version, 'v3.1.0');
    assert.equal(v310.content_hash, V3_POLICY_V3_1_0_HASH);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  }
});

test('P1-3: 即使哈希可被白名单放行，策略 ID / 市场 / 环境不一致也必须拒绝', () => {
  try {
    const wrongStrategy = {
      ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0,
      strategy: { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.strategy, id: 'OTHER_STRATEGY' },
    };
    const strategyHash = resign(wrongStrategy);
    const strategyFile = writeRelease('wrong-strategy.json', { ...wrongStrategy, content_hash: strategyHash });
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = strategyFile;
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = strategyHash;
    assert.throws(() => loadApprovedV3Policy(), /v3_policy_override_strategy_mismatch/);

    const wrongMarket = {
      ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0,
      applicability: { ...V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability, market: 'US_EQ' },
    };
    const marketHash = resign(wrongMarket);
    process.env.ASHARE_V3_POLICY_RELEASE_PATH = writeRelease('wrong-market.json', { ...wrongMarket, content_hash: marketHash });
    process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES = marketHash;
    assert.throws(() => loadApprovedV3Policy(), /v3_policy_override_market_mismatch/);
  } finally {
    delete process.env.ASHARE_V3_POLICY_RELEASE_PATH;
    delete process.env.ASHARE_V3_POLICY_RELEASE_ALLOWED_HASHES;
  }
});

test('P1-3: 准入账本 GRANT/SUSPEND/RESUME/REVOKE 驱动 runtime_can_open', () => {
  const path = privateAdmissionPath('lifecycle');
  const store = new StrategyAdmissionStore(path, { create: true });
  try {
    grantRelease(store);
  } finally {
    store.close();
  }
  process.env.ASHARE_V3_ADMISSION_DB = path;
  try {
    const granted = loadApprovedV3Policy();
    assert.equal(granted.runtime_admission.store_available, true);
    assert.equal(granted.runtime_admission.latest_action, 'GRANT');
    assert.equal(granted.runtime_can_open, true);

    const writer = new StrategyAdmissionStore(path);
    try {
      suspendRelease(writer);
    } finally {
      writer.close();
    }
    const suspended = loadApprovedV3Policy();
    assert.equal(suspended.runtime_admission.latest_action, 'SUSPEND');
    assert.equal(suspended.runtime_admission.latest_in_validity, true);
    assert.equal(suspended.runtime_can_open, false);

    const resume = new StrategyAdmissionStore(path);
    try {
      resume.record('RESUME', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, {
        account: 'real-main',
        market: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.market,
        environment: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.environment,
      }, { reason: 'test resume' });
    } finally {
      resume.close();
    }
    assert.equal(loadApprovedV3Policy().runtime_can_open, true);

    const revoke = new StrategyAdmissionStore(path);
    try {
      revoke.record('REVOKE', V3_OFFENSIVE_POLICY_RELEASE_V3_2_0, {
        account: 'real-main',
        market: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.market,
        environment: V3_OFFENSIVE_POLICY_RELEASE_V3_2_0.applicability.environment,
      }, { reason: 'test revoke' });
    } finally {
      revoke.close();
    }
    const revoked = loadApprovedV3Policy();
    assert.equal(revoked.runtime_admission.latest_action, 'REVOKE');
    assert.equal(revoked.runtime_can_open, false);
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
    const noEvent = loadApprovedV3Policy();
    assert.equal(noEvent.runtime_can_open, true, '无事件不得阻断');
    assert.equal(noEvent.runtime_admission.latest_action, null);
  } finally {
    delete process.env.ASHARE_V3_ADMISSION_DB;
  }

  process.env.ASHARE_V3_ADMISSION_DB = join(dir, 'missing-admission.sqlite');
  try {
    const missing = loadApprovedV3Policy();
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
    suspendRelease(store);
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
    accountId: 'real-main',
    asOf: ASOF,
    holdings,
    cashCents: 9_100_000,
    totalAssetsCents: 10_000_000,
    marketRegime: regime,
    stockSwingScreen,
  });
  try {
    // 未配置准入库：行为与修复前一致，P3 个股买单正常出现。
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
