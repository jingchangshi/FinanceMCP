import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'research-bundle-continuity-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');
const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { seedMarket, weekdays } = await import('./ashare-fixture.mjs');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { DEMO_SNAPSHOT, importSnapshot, markSnapshotCurrent } = await import('../build/portfolio/account.js');
const { initBaseline, confirmRealAccount } = await import('../build/portfolio/ledger.js');
const {
  buildInvestmentResearchBundle, buildAccountVerification, accountNarrative,
  feeVerificationStatus, resolveSessionState,
  buildEtfPenetrationState, ETF_PENETRATION_BUNDLE_SCHEMA,
} = await import('../build/portfolio/researchBundle.js');
const {
  normalizeEvidence, registerEvidence, invalidateEvidence, deriveEvidenceStatus,
  highConfidenceSet, dedupeEvidence, summarizeEvidenceState, fromChatgptEvidence,
} = await import('../build/ashare/evidenceModel.js');

function fixture() {
  const market = openAshareDb(':memory:');
  const dates = weekdays('20260701', 80).filter(d => d <= '20261020');
  seedMarket(market, dates);
  for (const [d, o] of [['20261020', 1], ['20261021', 1], ['20261024', 0], ['20261025', 0]]) {
    market.prepare('INSERT OR REPLACE INTO trade_cal(cal_date,is_open) VALUES(?,?)').run(d, o);
  }
  if (!dates.includes('20261020')) throw new Error('fixture needs 20261020');
  for (const position of DEMO_SNAPSHOT.positions) {
    upsertRows(market, 'fund_basic', ['ts_code', 'name', 'market', 'status', 'fund_type', 'invest_type'], [
      { ts_code: position.ts_code, name: 'Synthetic ETF', market: 'E', status: 'L', fund_type: '股票型', invest_type: '被动指数型' }]);
    for (const date of dates) {
      const code = position.ts_code;
      upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'], [
        { ts_code: code, trade_date: date, open: 1, high: 1, low: 1, close: 1, pre_close: 1, pct_chg: 0, vol: 1000, amount: 10000 }]);
      upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code: code, trade_date: date, adj_factor: 1 }]);
      upsertRows(market, 'fund_share', ['ts_code', 'trade_date', 'fd_share'], [{ ts_code: code, trade_date: date, fd_share: 100000 }]);
    }
  }
  const privateDir = mkdtempSync(join(dir, 'account-'));
  const p = openPortfolioDb(join(privateDir, 'portfolio.sqlite'), { marketPath: join(dir, 'unrelated.sqlite') });
  const id = 'synthetic-bundle-baseline';
  importSnapshot(p, { ...DEMO_SNAPSHOT, snapshot_id: id, as_of: '2026-10-16', source: 'synthetic-test' });
  initBaseline(p, 'synthetic-account', { asOf: '20261016', snapshotId: id });
  markSnapshotCurrent(p, id, { confirmedBy: 'fixture' });
  confirmRealAccount(p, 'synthetic-account', { confirm: true });
  const path = join(dir, 'synthetic-report.json');
  writeFileSync(path, JSON.stringify({
    report_id: 'synthetic-market-report', as_of_trade_date: '20261020', status: 'READY', versions: { score: 'frozen-test', watchlist: 'frozen-wl' },
    market: { regime: 'range', regime_label: 'synthetic', breadth: {}, indices: [], judgement: [] },
    sectors: { top: [], bottom: [], all: [] },
    watchlist: { count: 40, members: [], added: [], removed: [], track_record: { mean_excess_pct: -1.68, hit_rate: 0.217 } },
    signals: { market_summary: [] },
  }));
  market.prepare('INSERT INTO report(report_id,trade_date,status,generated_at,path,run_mode) VALUES(?,?,?,?,?,?)')
    .run('synthetic-market-report', '20261020', 'READY', '2026-10-20T13:10:00Z', path, 'live');
  return { market, p };
}

function build(f, extra = {}) {
  return buildInvestmentResearchBundle({ portfolioDb: f.p, marketDb: f.market, now: new Date('2026-10-21T01:00:00Z'), ...extra });
}

// ---------------------------------------------------------------- §3.1 report_id 连续性

test('new §3.1/§3.2/§3.3 keys live outside the identity hash: report_id is stable across generation clocks', () => {
  const f = fixture();
  try {
    // 两个时钟必须落在上海同一收盘侧：09:00 与 10:30（20261021 收盘前）。
    // 若跨 15:00 收盘（如 01:00Z vs 09:30Z），目标交易日本身会从 20261020 漂到
    // 20261021——report_id 含 as_of 前缀，不同目标日本就该有不同 ID（不是身份泄漏）。
    const first = build(f, { now: new Date('2026-10-21T01:00:00Z') });
    const second = build(f, { now: new Date('2026-10-21T02:30:00Z') });
    assert.equal(first.report_id, second.report_id, 'identity must not depend on the new lineage fields');
    assert.match(first.report_id, /^BUNDLE-20261020-[0-9a-f]{20}$/);
    // The lineage block itself does vary with the clock — proving it is present but unhashed.
    assert.notEqual(first.data_lineage.record_generated_at, second.data_lineage.record_generated_at);
    assert.equal(first.data_lineage.target_trade_date, '20261020');
    assert.equal(first.data_lineage.shanghai_date, '20261021');
  } finally { f.market.close?.(); f.p.close?.(); }
});

test('identity hash input is byte-stable: same fixture, same report_id across independent builds', () => {
  const f = fixture();
  try {
    const ids = new Set([build(f).report_id, build(f).report_id, build(f).report_id]);
    assert.equal(ids.size, 1);
  } finally { f.market.close?.(); f.p.close?.(); }
});

// ---------------------------------------------------------------- §3.1 session 六态

const clockOf = (over = {}) => ({
  requested_trade_date: null, as_of_trade_date: '20261020', latest_closed_trade_date: '20261020',
  shanghai_date: '20261021', phase: 'AFTER_CLOSE', status: 'READY', reason: null, ...over,
});

test('six session states are explicitly distinguished, including historical_replay and mixed snapshot', () => {
  const now = new Date('2026-10-21T01:00:00Z'); // 上海 09:00 20261021
  // 1) 未收盘
  const pre = resolveSessionState({
    clock: clockOf({ phase: 'PRE_CLOSE', status: 'NOT_READY', reason: 'session_not_closed', as_of_trade_date: '20261021' }),
    now, coreReady: false, freshness: 'missing', snapshotAsOf: '2026-10-16', runMode: null,
  });
  assert.equal(pre.state, 'pre_close');
  assert.equal(pre.matched['未收盘'], true);
  // 2) 收盘后数据未就绪（目标日缺数据，绝不回退前一天）
  const notReady = resolveSessionState({
    clock: clockOf(), now, coreReady: false, freshness: 'missing', snapshotAsOf: '2026-10-16', runMode: null,
  });
  assert.equal(notReady.state, 'after_close_data_not_ready');
  assert.match(notReady.detail, /不回退前一交易日/);
  // 3) 正常交易日
  const ok = resolveSessionState({
    clock: clockOf(), now, coreReady: true, freshness: 'same_day', snapshotAsOf: '2026-10-20', runMode: 'live',
  });
  assert.equal(ok.state, 'trading_day');
  // 4) 非交易日（请求日是周末）
  const weekend = resolveSessionState({
    clock: clockOf({ status: 'NOT_READY', reason: 'requested_date_not_trading_day', requested_trade_date: '20261025', as_of_trade_date: null }),
    now, coreReady: false, freshness: 'missing', snapshotAsOf: null, runMode: null,
  });
  assert.equal(weekend.state, 'non_trading_day');
  assert.equal(weekend.matched['非交易日'], true);
  // 5) 历史快照重放：显式请求更早的交易日
  const replay = resolveSessionState({
    clock: clockOf({ requested_trade_date: '20261015', as_of_trade_date: '20261015' }),
    now, coreReady: true, freshness: 'same_day', snapshotAsOf: '2026-10-15', runMode: 'replay',
  });
  assert.equal(replay.state, 'historical_replay');
  assert.equal(replay.historical_replay, true);
  assert.equal(replay.matched['历史快照重放'], true);
  // 6) 当前行情与旧账户快照混用
  const mixed = resolveSessionState({
    clock: clockOf(), now, coreReady: true, freshness: 'same_day', snapshotAsOf: '2026-10-16', runMode: 'live',
  });
  assert.equal(mixed.state, 'mixed_current_market_and_stale_snapshot');
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.matched['当前行情与旧快照混用'], true);
});

test('bundle marks session_state and refuses prior-day substitution when target data is missing', () => {
  const f = fixture();
  try {
    // Remove the target-date report so core data is unavailable.
    f.market.prepare("DELETE FROM report WHERE trade_date='20261020'").run();
    const result = build(f);
    assert.equal(result.status, 'DATA_INSUFFICIENT');
    assert.equal(result.session_state.state, 'after_close_data_not_ready');
    assert.equal(result.market.available, false, 'market must not fall back to a prior day');
    // data_quality.market 报告的是**价格表**质量（checkQuality，HEAD 既有语义，本轮未改）：
    // 删 report 行不影响行情柱，此处如实 READY；"目标日报告缺失"由上面的
    // status=DATA_INSUFFICIENT、session_state、market.available=false 与下面的 gap 四处披露，
    // 不得混进价格数据质量字段。
    assert.equal(result.data_quality.market.status, 'READY');
    assert.ok(result.evidence_gaps.some(gap => gap.reason === 'target_date_report_unavailable'));
  } finally { f.market.close?.(); f.p.close?.(); }
});

// ---------------------------------------------------------------- §3.1 顶层血缘与逐结论数据版本

test('data_lineage and claim_versions are top-level, machine-readable, and reference real versions', () => {
  const f = fixture();
  try {
    const result = build(f);
    const lineage = result.data_lineage;
    assert.equal(lineage.target_trade_date, '20261020');
    assert.match(lineage.shanghai_date, /^\d{8}$/);
    assert.ok(lineage.ledger_cutoff, 'ledger cutoff must be disclosed');
    assert.equal(lineage.ledger_cutoff.snapshot_id, 'synthetic-bundle-baseline');
    assert.ok(lineage.dataset_last_updated_at === null || typeof lineage.dataset_last_updated_at === 'string');
    assert.equal(lineage.market_report_freshness, 'same_day');
    // 逐结论数据版本：每段结论都有 data_as_of + versions + status。
    const refs = result.claim_versions;
    for (const key of ['market', 'watchlist', 'signals', 'decision', 'benchmarks', 'candidates', 'fees', 'validation']) {
      assert.ok(refs[key], `claim_versions.${key} missing`);
      assert.ok('data_as_of' in refs[key] && 'versions' in refs[key] && 'status' in refs[key], `claim_versions.${key} incomplete`);
    }
    assert.equal(refs.market.versions.score, 'frozen-test');
    assert.equal(refs.watchlist.status, 'AVAILABLE');
  } finally { f.market.close?.(); f.p.close?.(); }
});

// ---------------------------------------------------------------- §3.2 八项状态 + 自然语言

const DIMENSION_KEYS = [
  'account_identity', 'ledger_complete', 'cash_verified', 'positions_verified',
  'sellable_verified', 'fees_verified', 'unreported_trade_risk', 'nav_performance_eligible',
];
const STATUSES = new Set(['VERIFIED', 'UNVERIFIED', 'UNCONFIRMED_RISK', 'UNKNOWN']);

test('account_verification exposes all eight dimensions as machine-readable states', () => {
  const f = fixture();
  try {
    const result = build(f);
    const verification = result.account_verification;
    assert.ok(verification, 'account_verification must be present when a snapshot exists');
    assert.equal(verification.account_id, 'synthetic-account');
    assert.deepEqual(Object.keys(verification.dimensions).sort(), [...DIMENSION_KEYS].sort());
    for (const [name, dimension] of Object.entries(verification.dimensions)) {
      assert.ok(STATUSES.has(dimension.status), `${name} has invalid status ${dimension.status}`);
      assert.equal(typeof dimension.detail, 'string');
      assert.ok(dimension.detail.length > 0, `${name} detail must explain the state`);
    }
    // 未做用户声明时，未上报交易风险必须是 UNCONFIRMED_RISK（保守方向）。
    assert.equal(verification.dimensions.unreported_trade_risk.status, 'UNCONFIRMED_RISK');
    assert.equal(verification.summary_status, 'DEGRADED');
  } finally { f.market.close?.(); f.p.close?.(); }
});

test('accountNarrative converts machine states to Chinese prose without leaking status codes', () => {
  const f = fixture();
  try {
    const result = build(f);
    const narrative = accountNarrative(result.account_verification);
    assert.ok(narrative.length > 0);
    for (const code of ['UNCONFIRMED_RISK', 'UNVERIFIED', 'REAL_ACCOUNT_PENDING', 'VERIFIED', 'UNKNOWN', 'gate', 'state_basis']) {
      assert.ok(!narrative.includes(code), `narrative must not leak internal code ${code}`);
    }
    assert.match(narrative, /重建/);
    assert.match(narrative, /参考/);
    assert.ok(narrative.split('。').filter(Boolean).length >= 3, 'narrative should be full sentences');
  } finally { f.market.close?.(); f.p.close?.(); }
});

test('feeVerificationStatus grades field evidence without inflating assumed fees to verified', () => {
  assert.equal(feeVerificationStatus(null), 'UNKNOWN');
  assert.equal(feeVerificationStatus({}), 'UNKNOWN');
  const allConfirmed = {
    fee_model: { evidence: { commission_rate: { level: 'CONFIRMED' }, commission_min_cents: { level: 'CONFIRMED' }, transfer_fee_rate: { level: 'CONFIRMED' }, stamp_duty_rate: { level: 'CONFIRMED' } } },
    commission_rate: 0.0001, commission_min_cents: 0,
  };
  assert.equal(feeVerificationStatus(allConfirmed), 'VERIFIED');
  const assumed = {
    fee_model: { evidence: { commission_rate: { level: 'ASSUMED' }, commission_min_cents: { level: 'ASSUMED' }, transfer_fee_rate: { level: 'PUBLIC_REFERENCE' }, stamp_duty_rate: { level: 'PUBLIC_REFERENCE' } } },
    commission_rate: 0.0001, commission_min_cents: 0,
  };
  assert.equal(feeVerificationStatus(assumed), 'UNVERIFIED');
  const unknown = { fee_model: { evidence: { commission_rate: { level: 'UNKNOWN' }, commission_min_cents: { level: 'ASSUMED' }, transfer_fee_rate: { level: 'ASSUMED' }, stamp_duty_rate: { level: 'ASSUMED' } } } };
  assert.equal(feeVerificationStatus(unknown), 'UNKNOWN');
});

test('market readiness never inflates account dimensions', () => {
  const f = fixture();
  try {
    const result = build(f);
    assert.equal(result.data_quality.market.status, 'READY', 'fixture precondition: market is ready');
    // 市场 READY 不代表账户可卖/费用/净值核验通过。
    assert.notEqual(result.account_verification.summary_status, 'VERIFIED');
    assert.notEqual(result.account_verification.dimensions.fees_verified.status, 'VERIFIED');
  } finally { f.market.close?.(); f.p.close?.(); }
});

// ---------------------------------------------------------------- §3.3 证据模型

const baseEvidence = over => ({
  evidence_id: 'EV-test-001',
  claim: '北方华创半年报营收增速快于利润增速',
  source_url: 'https://example.com/announcement/2026h1',
  publisher: '公司公告',
  published_at: '2026-10-20T16:00:00+08:00',
  retrieved_at: '2026-10-20T18:00:00+08:00',
  effective_as_of: '20260830',
  target: '159558.SZ',
  evidence_type: 'PRIMARY_FILING',
  evidence_direction: 'SUPPORTS',
  source_quality: 'HIGH',
  verification_status: 'VERIFIED',
  source_excerpt: '2026 年半年报第三节经营情况',
  supports_claim_ids: ['claim-north-inauc-q1'],
  contradicts_claim_ids: [],
  ...over,
});

test('normalizeEvidence enforces all 15 fields and rejects unverifiable inputs', () => {
  const { record, content_hash } = normalizeEvidence(baseEvidence(), new Date('2026-10-21T00:00:00Z'));
  assert.deepEqual(Object.keys(record).sort(), [
    'claim', 'contradicts_claim_ids', 'effective_as_of', 'evidence_direction', 'evidence_id',
    'evidence_type', 'published_at', 'publisher', 'retrieved_at', 'source_excerpt',
    'source_quality', 'source_url', 'supports_claim_ids', 'verification_status', 'target',
  ].sort()); // 两侧都排序：期望字面量按规范顺序书写，比较按码位序，不依赖书写顺序
  assert.equal(typeof content_hash, 'string');
  // 坏时间戳 / 非 http 来源 / 缺 claim 直接拒绝；仅日期的发布时间（intake 合法格式）保留。
  const dateOnly = normalizeEvidence(baseEvidence({ published_at: '2026-10-20' }), new Date('2026-10-21T00:00:00Z'));
  assert.equal(dateOnly.record.published_at, '2026-10-20');
  assert.throws(() => normalizeEvidence(baseEvidence({ published_at: '2026-10-20 16:00' })), /ISO 8601/);
  assert.throws(() => normalizeEvidence(baseEvidence({ source_url: 'ftp://x' })), /http/);
  assert.throws(() => normalizeEvidence(baseEvidence({ claim: '' })), /claim/);
  // 发布时间晚于检索时间（未来新闻）拒绝。
  assert.throws(() => normalizeEvidence(baseEvidence({ published_at: '2026-10-22T00:00:00+08:00' })), /retrieved_at/);
  // 内容指纹不因检索时间漂移。
  const later = normalizeEvidence(baseEvidence({ retrieved_at: '2026-10-21T09:00:00+08:00' }), new Date('2026-10-21T00:00:00Z'));
  assert.equal(later.content_hash, content_hash);
});

test('registration derives NEW / UPDATED / UNCHANGED / INVALIDATED deterministically', () => {
  const now = new Date('2026-10-20T20:00:00+08:00');
  const state = new Map();
  // 1) 首次登记 → NEW，计新证据。
  const first = registerEvidence(state, baseEvidence(), { now });
  assert.equal(first.outcome, 'NEW');
  assert.equal(first.counts_as_new_evidence, true);
  state.set(first.entry.evidence_id, first.entry);
  // 2) 同一资料再检索一次 → UNCHANGED，绝不计新证据。
  const repeat = registerEvidence(state, baseEvidence(), { now: new Date('2026-10-21T08:00:00+08:00') });
  assert.equal(repeat.outcome, 'UNCHANGED');
  assert.equal(repeat.counts_as_new_evidence, false);
  assert.equal(repeat.entry.context.citation_count, 2);
  state.set(repeat.entry.evidence_id, repeat.entry);
  // 3) 补充摘录/更正正文 → UPDATED，保留 first_seen。
  const corrected = registerEvidence(state, baseEvidence({ source_excerpt: '更正后的定位：第三节第 2 段' }), { now });
  assert.equal(corrected.outcome, 'UPDATED');
  assert.equal(corrected.counts_as_new_evidence, false);
  assert.equal(corrected.entry.context.first_seen_at, repeat.entry.context.first_seen_at);
  assert.equal(corrected.entry.revision, 1);
  state.set(corrected.entry.evidence_id, corrected.entry);
  // 4) 来源撤回 → INVALIDATED。
  const revoked = invalidateEvidence(state, 'EV-test-001', 'RETRACTED');
  state.set('EV-test-001', revoked);
  const after = registerEvidence(state, baseEvidence({ claim: '同一条主张再次出现' }), { now });
  assert.equal(after.outcome, 'INVALIDATED');
  assert.equal(after.counts_as_new_evidence, false);
  // 状态推导与登记结论一致。
  const statuses = deriveEvidenceStatus(state, '20261020');
  assert.equal(statuses.get('EV-test-001'), 'INVALIDATED');
});

test('evidence published after the research cutoff cannot count as established evidence', () => {
  const now = new Date('2026-10-23T08:00:00+08:00');
  const state = new Map();
  const late = registerEvidence(state, baseEvidence({
    evidence_id: 'EV-late', published_at: '2026-10-24T09:00:00+08:00', retrieved_at: '2026-10-24T10:00:00+08:00',
  }), { now });
  state.set(late.entry.evidence_id, late.entry);
  const statuses = deriveEvidenceStatus(state, '20261023');
  assert.equal(statuses.get('EV-late'), 'INVALIDATED');
  const { included, excluded } = highConfidenceSet(state.values(), { asOf: '20261023' });
  assert.equal(included.length, 0);
  assert.ok(excluded.some(row => row.reason === 'published_after_research_cutoff'));
});

test('high-confidence set excludes unverifiable sources and stale/background reuse', () => {
  const now = new Date('2026-10-20T20:00:00+08:00');
  const state = new Map();
  const good = registerEvidence(state, baseEvidence({ evidence_id: 'EV-good' }), { now });
  state.set(good.entry.evidence_id, good.entry);
  const noUrl = registerEvidence(state, baseEvidence({ evidence_id: 'EV-no-url', source_url: null, publisher: '媒体' }), { now });
  state.set(noUrl.entry.evidence_id, noUrl.entry);
  const unverified = registerEvidence(state, baseEvidence({ evidence_id: 'EV-unverified', source_quality: 'UNVERIFIED', verification_status: 'UNVERIFIED' }), { now });
  state.set(unverified.entry.evidence_id, unverified.entry);
  const { included, excluded } = highConfidenceSet(state.values(), { asOf: '20261020' });
  assert.deepEqual(included.map(entry => entry.evidence_id), ['EV-good']);
  const reasons = new Map(excluded.map(row => [row.evidence_id, row.reason]));
  assert.equal(reasons.get('EV-no-url'), 'no_source_url');
  assert.equal(reasons.get('EV-unverified'), 'verification_not_verified');
});

test('dedupe removes repeated citations of the same story and summary never counts them as new', () => {
  const now = new Date('2026-10-20T20:00:00+08:00');
  const state = new Map();
  const a = registerEvidence(state, baseEvidence({ evidence_id: 'EV-a' }), { now });
  state.set(a.entry.evidence_id, a.entry);
  const b = registerEvidence(state, baseEvidence({ evidence_id: 'EV-b' }), { now });
  state.set(b.entry.evidence_id, b.entry); // 同一 claim + 同一发布日 + 同一来源，不同 ID
  const { unique, duplicates } = dedupeEvidence(state.values());
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].duplicate_of, 'EV-a');
  const summary = summarizeEvidenceState(state, { asOf: '20261020' });
  assert.equal(summary.total, 1, '重复登记的同一份资料在汇总层只算一条');
  assert.equal(summary.duplicate_count, 1);
  assert.equal(summary.by_status.NEW, 1, '唯一一条在发布日当天首次出现，是 NEW');
  assert.equal(summary.new_evidence_count, 1, '重复引用不额外产生新证据计数');
});

test('chatgpt intake fragments map conservatively into the 15-field model', () => {
  const mapped = fromChatgptEvidence({
    claim: '半导体设备出口管制再收紧', kind: 'industry', source_url: 'https://example.com/news/1',
    published_at: '2026-10-22T10:00:00+08:00', role: 'counter',
  }, { retrievedAt: '2026-10-23T08:00:00+08:00', effectiveAsOf: '20261022' });
  assert.equal(mapped.evidence_type, 'INDUSTRY_BACKGROUND');
  assert.equal(mapped.evidence_direction, 'CONTRADICTS');
  assert.equal(mapped.source_quality, 'UNVERIFIED');
  assert.equal(mapped.verification_status, 'UNVERIFIED');
  assert.equal(mapped.context_novelty, 'BACKGROUND');
  const now = new Date('2026-10-23T08:00:00+08:00');
  const state = new Map();
  const first = registerEvidence(state, mapped, { now });
  assert.equal(first.outcome, 'NEW');
  assert.equal(first.counts_as_new_evidence, false, '追加协议不声明新颖性时不得计为新证据');
  state.set(first.entry.evidence_id, first.entry);
  const second = registerEvidence(state, mapped, { now });
  assert.equal(second.outcome, 'UNCHANGED');
  assert.equal(second.counts_as_new_evidence, false);
  const statuses = deriveEvidenceStatus(state, '20261023');
  assert.equal(statuses.get(first.entry.evidence_id), 'UNCHANGED');
  // 无来源 URL 的二手材料进不了高可信集合。
  const { included } = highConfidenceSet([first.entry], { asOf: '20261023' });
  assert.equal(included.length, 0);
});

// ---------------------------------------------------------------- §4 ETF 穿透接线

test('etf_penetration is wired at the top level with one entry per held ETF and never leaks into facts.gaps', () => {
  const f = fixture();
  try {
    const result = build(f);
    const block = result.etf_penetration;
    assert.ok(block, 'etf_penetration must exist as a top-level key');
    assert.equal(block.schema, ETF_PENETRATION_BUNDLE_SCHEMA);
    assert.equal(block.as_of_trade_date, '20261020');
    // market db 与 as_of 齐备 → 块级 OK；逐只状态在 etfs 内。
    assert.equal(block.status, 'OK');
    assert.equal(block.reason, null);
    // 持仓五只基金各一条（基金代码筛选：深 1 开头 / 沪 5 开头）。
    const codes = Object.keys(block.etfs).sort();
    assert.deepEqual(codes, ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH']);
    for (const code of codes) {
      const entry = block.etfs[code];
      assert.ok(entry.status === 'OK' || entry.status === 'UNAVAILABLE', `${code} has invalid status`);
      if (entry.status === 'OK') {
        assert.equal(entry.reason, null);
        assert.equal(entry.summary.etf.ts_code, code);
        assert.equal(entry.summary.as_of, '20261020');
        assert.ok(Array.isArray(entry.summary.gaps));
      } else {
        assert.equal(typeof entry.reason, 'string');
        assert.ok(entry.reason.length > 0, `${code} UNAVAILABLE must carry a machine-readable reason`);
        assert.equal(entry.summary, null, 'UNAVAILABLE must not attach a fabricated summary');
      }
    }
    assert.equal(block.collected + block.unavailable, codes.length);
    // fixture 无 index_weight/fund_portfolio 权重缓存 → 逐只 UNAVAILABLE（不伪造权重）。
    assert.equal(block.unavailable, codes.length);
    assert.equal(block.collected, 0);
    assert.ok(block.gaps.length > 0 && block.gaps.every(gap => gap.module === 'etf_penetration'));
    // 块内 gaps 不并入 facts.gaps：后者参与 report_id 身份哈希（20261023 回放冻结）。
    assert.ok(!result.evidence_gaps.some(gap => gap.module === 'etf_penetration'),
      'etf_penetration gaps must stay scoped to the block, never facts.gaps');
    // market db 缺失 → 块级降级为 UNAVAILABLE，不 throw、不伪造。
    const noDb = buildEtfPenetrationState({ db: null, asOf: '20261020', holdings: ['159558.SZ'] });
    assert.equal(noDb.status, 'UNAVAILABLE');
    assert.equal(noDb.reason, 'market_db_unavailable');
    assert.deepEqual(noDb.etfs, {});
  } finally { f.market.close?.(); f.p.close?.(); }
});
