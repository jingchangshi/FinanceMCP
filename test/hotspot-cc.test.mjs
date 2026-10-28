// goal-1028 §P4 冠军-挑战者（Champion–Challenger）离线回归：
//
// 1. Champion 臂 = 既有 wl-1.0.0 观察池（watchlist 存储成员，按 rank 截 30）；
//    Challenger 臂 = 当日热点 FOCUS 池 —— 两者共用同一成本模型
//    （HOTSPOT_EXPERIMENT_COSTS ≡ EXPERIMENT_A_COSTS）与同一评估器，
//    本模块不新建任何回测/记账/统计引擎。
// 2. 前向窗口不完整的选择日必须整格跳过（window_incomplete），
//    绝不把截断窗口当作收益 —— 缺数据不会静默变成成功信号。
// 3. 空配对报告如实报 n=0 / mean_diff=null，research_only 恒为 true；
//    裁决读数不编造。
// 4. 挑战者候选先登记（spec hash）后记录结果；已登记 manifest 原地
//    改动必须被身份哈希拒绝（候选不得原地修改）。
//
// 全离线：合成 universe + 直接写入的 watchlist 行，无网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hotspot-cc-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { ensureHotspotSchema } = await import('../build/ashare/hotspotTables.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const {
  selectChampionPool, selectChallengerPool, runChampionChallenger,
  challengerManifest, registerChallenger, challengerSpecHash,
  adjudicateCcReport, recordChallengerRun,
  CHALLENGER_CANDIDATE_ID, CC_SUCCESS_CRITERIA, HOTSPOT_POOL_SIZE,
} = await import('../build/ashare/hotspotExperiments.js');
const { HOTSPOT_EXPERIMENT_COSTS, CHAMPION_ARM, CHALLENGER_ARM } =
  await import('../build/ashare/hotspotTypes.js');
const { EXPERIMENT_A_COSTS } = await import('../build/ashare/experimentA.js');
const { CandidateRegistry, CandidateRegistryError } = await import('../build/ashare/candidateRegistry.js');

const DATES = weekdays('20250901', 160);
const AS_OF = DATES.at(-1);

const db = openAshareDb();
ensureHotspotSchema(db);
seedReferenceUniverse(db, DATES);

// ---- 成本模型：挑战者绝不悄悄换用另一套成本 ----
test('CC arms share the exact EXPERIMENT_A cost model and pre-registered arms', () => {
  assert.deepEqual(HOTSPOT_EXPERIMENT_COSTS, EXPERIMENT_A_COSTS,
    'HOTSPOT_EXPERIMENT_COSTS 必须与既有 EXPERIMENT_A_COSTS 完全一致');
  assert.equal(CHAMPION_ARM, 'CHAMPION_WL_1_0_0');
  assert.equal(CHALLENGER_ARM, 'CHALLENGER_HOTSPOT_MULTISTRATEGY');
});

// ---- Champion 臂：watchlist 存储成员 ----
test('champion pool = stored watchlist membership, rank-ordered, cut to the shared size', () => {
  const none = selectChampionPool(db, AS_OF);
  assert.equal(none.pool.length, 0);
  assert.equal(none.note, 'no_watchlist_snapshot_on_or_before');

  // 35 行观察池（fixture 股票码），rank 1..35。
  upsertRows(db, 'watchlist',
    ['trade_date', 'ts_code', 'score', 'rank', 'industry', 'status', 'reason', 'entered_on'],
    Array.from({ length: 35 }, (_, i) => ({
      trade_date: AS_OF, ts_code: `${600000 + i}.SH`, score: 1 - i * 0.01,
      rank: i + 1, industry: '测试', status: 'watch', reason: 'fixture', entered_on: '20250101',
    })));
  const champ = selectChampionPool(db, AS_OF);
  assert.equal(champ.arm, CHAMPION_ARM);
  assert.equal(champ.universe_size, 35);
  assert.equal(champ.pool.length, HOTSPOT_POOL_SIZE, `截到共享池容量 ${HOTSPOT_POOL_SIZE}`);
  assert.deepEqual(champ.pool.slice(0, 3), ['600000.SH', '600001.SH', '600002.SH'], '按 rank 升序');
  assert.equal(champ.note, `watchlist@${AS_OF}`);
});

// ---- Challenger 臂：当日热点 FOCUS 快照 ----
test('challenger pool = hotspot FOCUS stocks from that date snapshot', () => {
  const empty = selectChallengerPool(db, AS_OF);
  assert.equal(empty.pool.length, 0);
  assert.equal(empty.note, 'no_hotspot_snapshot_on_date');

  // 真实管线落盘（无选中行业也可：市场龙头照常入 FOCUS）。
  const { saved } = runHotspotPipeline(db, AS_OF, { persist: true });
  assert.ok(saved, '管线应写入快照');

  const chall = selectChallengerPool(db, AS_OF);
  assert.equal(chall.arm, CHALLENGER_ARM);
  assert.ok(chall.pool.length > 0 && chall.pool.length <= HOTSPOT_POOL_SIZE);
  assert.equal(chall.note, `hotspot_focus@${AS_OF}`);
  assert.equal(new Set(chall.pool).size, chall.pool.length, '挑战者池无重复');
});

// ---- 前向窗口不完整 → 整格跳过，不编造收益 ----
test('incomplete forward windows are skipped whole; an empty report stays honest', () => {
  const report = runChampionChallenger(db, {
    start: AS_OF, end: AS_OF, observation_end: AS_OF, step_days: 1,
  });
  assert.equal(report.research_only, true);
  assert.equal(report.selection_dates.length, 1);
  // 当日两臂都有池 → 不计入 no_champion/no_challenger；但 5/10/20 三档
  // 的 horizon+maxExitDelay+2 前向窗口全部越过 observation_end。
  assert.equal(report.skipped.no_champion, 0);
  assert.equal(report.skipped.no_challenger, 0);
  assert.ok(report.skipped.window_incomplete >= 3, '三个 horizon 均因窗口不完整被跳过');
  assert.equal(report.per_horizon.length, 3);
  for (const h of report.per_horizon) {
    assert.deepEqual(h.paired, [], '不完整的前向窗口不得产生任何配对收益');
    assert.equal(h.mean_diff, null, '无配对 → 均值必须为 null，不得默认 0');
    assert.equal(h.inference.n, 0);
  }
  assert.deepEqual(report.cost_model, EXPERIMENT_A_COSTS);
});

// ---- 裁决：空报告不编造 ----
test('adjudicating an empty report yields readings of null, never invented wins', () => {
  const report = runChampionChallenger(db, {
    start: AS_OF, end: AS_OF, observation_end: AS_OF, step_days: 1,
  });
  const { outcome, readings } = adjudicateCcReport(report);
  assert.equal(readings.length, 3, '每 horizon 一条均值读数（无配对日期读数）');
  for (const r of readings) assert.equal(r.value, null);
  assert.equal(typeof outcome, 'string');
  // win_rate 门槛在空证据上不可能通过。
  assert.notEqual(outcome, 'pass', `空证据不得判为通过（outcome=${outcome}, min=${CC_SUCCESS_CRITERIA.min}）`);
});

// ---- 登记协议：spec 先于结果，manifest 不得原地改 ----
test('challenger registration is spec-before-results and forbids in-place edits', () => {
  const regPath = join(dir, 'candidate-registry.jsonl');
  const registry = new CandidateRegistry(regPath);
  const manifest = challengerManifest({
    researchWindow: { start: '20250901', end: '20260331' },
    formationWindow: { start: '20250901', end: '20260131' },
    holdoutWindow: { start: '20260201', end: '20260331' },
    forwardStart: '20260401',
    researchSnapshotId: 'test-snapshot',
    codeSha: createHash('sha256').update('goal-1028-cc-test').digest('hex'),
    createdAt: '2026-10-28T00:00:00Z',
  });
  assert.equal(manifest.candidate_id, CHALLENGER_CANDIDATE_ID);

  const first = registerChallenger(registry, manifest);
  assert.equal(first.created, true, '首次登记创建候选');
  const again = registerChallenger(registry, manifest);
  assert.equal(again.created, false, '同一 manifest 幂等重登记');
  assert.equal(again.identity_hash, first.identity_hash);
  assert.equal(challengerSpecHash(manifest), first.identity_hash, 'spec 哈希与身份哈希一致');

  // 原地改动已登记 manifest → 必须被拒绝（改协议 = 新 candidate_version）。
  const mutated = { ...manifest, signal_definition: { ...manifest.signal_definition, engine: 'tampered-1.0.0' } };
  assert.throws(() => registerChallenger(registry, mutated), CandidateRegistryError,
    '已登记 manifest 原地修改必须抛出身份哈希不符');

  // 结果记录发生在登记之后（记录空报告也如实记录 outcome/evidence）。
  const report = runChampionChallenger(db, {
    start: AS_OF, end: AS_OF, observation_end: AS_OF, step_days: 1,
  });
  const rec = recordChallengerRun(registry, manifest, report, 'cc-run-1');
  assert.equal(rec.recorded, true);
  assert.equal(typeof rec.outcome, 'string');
  assert.match(rec.evidence, /^[0-9a-f]{64}$/, 'evidence 为报告内容哈希');
});

test.after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});
