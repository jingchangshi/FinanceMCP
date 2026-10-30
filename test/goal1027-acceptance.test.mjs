import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// goal-1027 验收断言：P0-1 快照读取协议、P0-2 结构化判断与评价成熟、P0-3 Combined
// 联合判断、MCP 工具/scope、V3 提示词契约。
//
// 只用合成 fixture：临时市场缓存 + 临时账户库。不读网络、不写生产库。
// 关键时钟约束：classifyRecord 用服务端 recorded_at（真实现在时）判定补录，因此
// 前瞻用例的 as_of 必须 >= 今天的上海日期（fixture 日历延伸到未来合成交易日）。
//
// 运行（主控在统一测试窗口执行）：
//   node --test --test-concurrency=1 test/goal1027-acceptance.test.mjs

const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));

const dir = mkdtempSync(join(tmpdir(), 'goal1027-acc-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio-default.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const researchJournal = await load('portfolio/researchJournal.js');
const researchRecord = await load('portfolio/researchRecord.js');
const chatgptIntake = await load('portfolio/chatgptIntake.js');
const researchEval = await load('portfolio/researchEval.js');
const researchSnapshot = await load('portfolio/researchSnapshot.js');
const combinedResearch = await load('portfolio/combinedResearch.js');
const researchBundle = await load('portfolio/researchBundle.js');
const forwardReview = await load('portfolio/forwardReview.js');
const definitions = await load('ashare/definitions.js');
const { getPrivateToolList } = await load('dispatch.js');
const { weekdays } = await import('./ashare-fixture.mjs');

// ---------------------------------------------------------------- 时间与行情基线
// 今天（上海）随真实时钟变化；前瞻记录要求 recorded_at（服务端现在时）<= as_of。
const shanghaiToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const R = shanghaiToday;                       // 前瞻研究日 = 今天（上海）
// 合成日历：weekdays() 只产生工作日。整份用例要求研究日 = 上海今天——as_of 必须
// >= 服务端现在时才能是 TRUE_FORWARD，而 intake 又禁止 as_of > 今天。因此今天若
// 落在周末/节假日，就把今天作为"合成交易日"加进日历，而不是把研究日挪到未来。
// （20261031 是周六；旧写法 `assert.ok(DAYS.includes(R) || ...)` 会让整份文件在
// 每个周末必然失败，与用例自身的回退逻辑相矛盾。）
const DAYS = (() => {
  const base = weekdays('20261005', 30);       // 合成日历 20261005 起 30 个工作日
  return base.includes(R) ? base : [...base, R].sort();
})();
// 研究日之后至少 horizon 个交易日（不足则把 R 往前挪到日历内且 >= TRUE_FORWARD_START）。
const TRUE_FORWARD_START = '20261022';
let researchDay = R;
if (!DAYS.includes(researchDay) || DAYS.filter(d => d > researchDay).length < 5) {
  const candidates = DAYS.filter(d => d >= TRUE_FORWARD_START && DAYS.filter(x => x > d).length >= 5);
  // 服务端 now 固定为真实今天：只有 as_of >= 今天才可能是 TRUE_FORWARD。
  researchDay = candidates.at(-1) ?? DAYS.at(-6);
}
// 回退到过去的研究日就不再是前瞻，M2/M4 的 TRUE_FORWARD 断言会失去意义：
// 与其静默降级，不如明确失败并指出 fixture 需要延长到今天之后 5 个交易日。
assert.equal(researchDay, R,
  `fixture 日历需覆盖上海今天之后至少 5 个交易日：今天 ${R}，日历 ${DAYS[0]}..${DAYS.at(-1)}`);
const AS_OF = researchDay;                     // 评价记录 as_of
const EVAL_DATE = DAYS[DAYS.indexOf(AS_OF) + 5]; // 5 日窗口成熟后的评价截止日
const CODE = '159241.SZ';
const BENCH = '510300.SH';
const ACCOUNT = 'acc-1027';

const marketFile = join(dir, 'market.sqlite');
{
  const db = openAshareDb(marketFile);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    DAYS.map((d, i) => ({ cal_date: d, is_open: 1, pretrade_date: DAYS[i - 1] ?? null })));
  const codes = [CODE, BENCH, '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];
  for (const [k, date] of DAYS.entries()) {
    for (const [i, code] of codes.entries()) {
      // 标的（i=0）必须比基准贵：评价按"同初始资金预算买整手基准"计算，
      // 基准一手超出预算会整窗判 UNAVAILABLE（benchmark_budget_below_one_lot）。
      const close = Math.round((12 - i * 0.1 + k * 0.02) * 10000) / 10000;
      const open = Math.round(close * 0.999 * 10000) / 10000;
      upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
        [{ ts_code: code, trade_date: date, open, high: Math.round(close * 1.01 * 10000) / 10000,
          low: Math.round(close * 0.99 * 10000) / 10000, close, pre_close: close, pct_chg: 0, vol: 1e5, amount: 2e5 }]);
      upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
        [{ ts_code: code, trade_date: date, adj_factor: 1 }]);
    }
  }
  db.close();
}

function openPair(name) {
  const portfolioFile = join(dir, `portfolio-${name}.sqlite`);
  const market = openAshareDb(marketFile);
  const portfolio = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  return { portfolioFile, market, portfolio };
}

const feeEstimator = () => ({ total_cents: 100, estimated: true, version: 'test-fee-v1' });

function seedVps(db, { asOf = AS_OF, accountId = ACCOUNT, bundleId = `BUNDLE-${asOf}-seedvps`, recordId = null, payload = null, generatedAt = null } = {}) {
  const gen = generatedAt ?? `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6)}T13:15:00.000Z`;
  const body = payload ?? { report_id: bundleId, as_of_trade_date: asOf, generated_at: gen, frozen_marker: 'seed' };
  return researchJournal.recordResearchJournal(db, {
    record_id: recordId ?? `VPS-${bundleId}-seed`,
    account_id: accountId, source: 'vps', as_of_trade_date: asOf, bundle_id: bundleId,
    generated_at: gen, versions: { journal: 'test-v1', rules: 'seed' },
    judgement: 'NO_ACTION', candidates: [],
    observations: [{ ts_code: CODE, quantity: 100, direction: 'long' }],
    evidence: [], payload: body,
  });
}

// ================================================================ P0-1 快照读取协议

test('S1: 10-26 式身份漂移复现——live ID 变化后旧快照仍可按真实身份读取', () => {
  const { portfolio } = openPair('s1');
  try {
    seedVps(portfolio, { bundleId: `BUNDLE-${AS_OF}-oldcode` });
    // 升级模拟：live 重建得到不同 report_id（稳定哈希输入变化）。
    const liveId = `BUNDLE-${AS_OF}-newcode`;
    const status = researchBundle.persistedSnapshotStatus(portfolio, ACCOUNT, AS_OF, liveId);
    assert.equal(status.status, 'SNAPSHOT_NOT_FOUND', '不同身份的 Live Bundle 不得声称命中旧快照');
    const oldStatus = researchBundle.persistedSnapshotStatus(portfolio, ACCOUNT, AS_OF, `BUNDLE-${AS_OF}-oldcode`);
    assert.equal(oldStatus.status, 'PERSISTED');
    // 修复核心：按旧快照真实身份读取完整冻结内容。
    const got = researchSnapshot.getResearchSnapshot(portfolio, {
      accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-oldcode-seed`,
    });
    assert.equal(got.snapshot?.bundle_id, `BUNDLE-${AS_OF}-oldcode`);
    assert.equal(got.frozen_payload?.report_id, `BUNDLE-${AS_OF}-oldcode`);
    assert.equal(got.payload_verification?.status, 'VERIFIED');
  } finally { portfolio.close(); }
});

test('S2: 相同快照重复读取身份一致', () => {
  const { portfolio } = openPair('s2');
  try {
    seedVps(portfolio, {});
    const a = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    const b = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(a.snapshot.record_id, b.snapshot.record_id);
    assert.equal(a.snapshot.content_hash, b.snapshot.content_hash);
    assert.deepEqual(a.frozen_payload, b.frozen_payload);
  } finally { portfolio.close(); }
});

test('S3: 同日不同内容不会被错误绑定', () => {
  const { portfolio } = openPair('s3');
  try {
    seedVps(portfolio, { bundleId: `BUNDLE-${AS_OF}-aaa`, payload: { marker: 'A' } });
    seedVps(portfolio, { bundleId: `BUNDLE-${AS_OF}-bbb`, payload: { marker: 'B' } });
    const gotA = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-aaa-seed` });
    const gotB = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-bbb-seed` });
    assert.equal(gotA.frozen_payload.marker, 'A');
    assert.equal(gotB.frozen_payload.marker, 'B');
    assert.equal(gotA.same_date_snapshots.length, 2);
  } finally { portfolio.close(); }
});

test('S4: 跨版本仍能读取历史冻结事实（journal 版本字段原样保留）', () => {
  const { portfolio } = openPair('s4');
  try {
    const past = '20261022';
    seedVps(portfolio, { asOf: past, bundleId: `BUNDLE-${past}-hist` });
    const got = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, asOf: past });
    assert.equal(got.snapshot.as_of_trade_date, past);
    assert.equal(got.snapshot.versions.journal, 'test-v1');
    assert.equal(got.frozen_payload.frozen_marker, 'seed');
  } finally { portfolio.close(); }
});

test('S5: payload 缺失的历史记录如实报告不可恢复，不以 Live Bundle 回填', () => {
  const { portfolio } = openPair('s5');
  try {
    // 早期日志形态：只有摘要、没有完整 payload。
    researchJournal.recordResearchJournal(portfolio, {
      record_id: `VPS-BUNDLE-${AS_OF}-nopal`, account_id: ACCOUNT, source: 'vps',
      as_of_trade_date: AS_OF, bundle_id: `BUNDLE-${AS_OF}-nopal`,
      generated_at: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}T13:15:00.000Z`,
      versions: { journal: 'test-v1' }, judgement: 'DEGRADED',
      candidates: [], observations: [], evidence: [],
    });
    const got = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-nopal-seed`.replace('-seed', '') });
    assert.equal(got.snapshot?.payload_status, 'PAYLOAD_MISSING');
    assert.equal(got.frozen_payload, null);
    assert.equal(got.payload_verification.status, 'PAYLOAD_MISSING');
    assert.match(got.note, /不可恢复/);
  } finally { portfolio.close(); }
});

test('S6: 关闭并重开数据库后仍可读取（服务重启等价）', () => {
  const { portfolioFile } = openPair('s6');
  {
    const db = openPortfolioDb(portfolioFile, { writable: true });
    seedVps(db, {});
    db.close();
  }
  const db2 = openPortfolioDb(portfolioFile, { writable: false });
  try {
    const got = researchSnapshot.getResearchSnapshot(db2, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(got.snapshot?.payload_status, 'PAYLOAD_PRESENT');
  } finally { db2.close(); }
});

test('S7: 读取不修改旧日志（哈希与行数不变）', () => {
  const { portfolio } = openPair('s7');
  try {
    seedVps(portfolio, {});
    const before = portfolio.prepare('SELECT record_id, content_hash, content_json FROM research_journal').all();
    researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    researchSnapshot.listResearchSnapshots(portfolio, { accountId: ACCOUNT });
    const after = portfolio.prepare('SELECT record_id, content_hash, content_json FROM research_journal').all();
    assert.deepEqual(after, before);
  } finally { portfolio.close(); }
});

test('S8: 查询元数据与冻结内容分离，不把查询时刻泄漏进快照', () => {
  const { portfolio } = openPair('s8');
  try {
    seedVps(portfolio, {});
    const got = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-seedvps-seed` });
    assert.ok(got.query.retrieved_at, '查询时刻在 query 元数据里');
    assert.ok(!('retrieved_at' in got.frozen_payload), '冻结内容不含查询时刻');
    // 交易日不一致时拒绝错误绑定。
    const mismatch = researchSnapshot.getResearchSnapshot(portfolio, {
      accountId: ACCOUNT, recordId: `VPS-BUNDLE-${AS_OF}-seedvps-seed`, asOf: '20261020',
    });
    assert.equal(mismatch.snapshot, null);
    assert.match(mismatch.note, /trade_date_mismatch/);
  } finally { portfolio.close(); }
});

// ================================================================ P0-2 结构化研究与评价成熟

test('T1: ChatGPT 真实记录可关联 Thesis（资格从父记录推导）', () => {
  const { portfolio } = openPair('t1');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究：宏观流动性平稳，ETF 份额稳定。',
      final_conclusion: 'NO_ACTION；维持现有持仓，等待更明确信号。',
    }, Date.now());
    assert.equal(intake.created, true);
    const thesis = researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      benchmark: BENCH, baseline_assessment: '相对基准存在温和超额。',
    }, Date.now());
    assert.equal(thesis.created, true);
    assert.equal(thesis.parent_evidence_class, forwardReview.classifyRecord(
      researchJournal.readResearchJournal(portfolio, intake.record_id)));
  } finally { portfolio.close(); }
});

test('T2: 没有可量化判断时允许 0 条 Thesis，评价不崩溃', () => {
  const { portfolio, market } = openPair('t2');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '本期以定性宏观判断为主。',
      final_conclusion: 'NO_ACTION；证据不足以形成量化命题。',
    }, Date.now());
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    assert.equal(result.theses.total, 0);
    assert.ok(result.schema.startsWith('research-eval/'));
  } finally { portfolio.close(); market.close(); }
});

test('T3: 同键同内容幂等、同键不同内容拒绝', () => {
  const { portfolio } = openPair('t3');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    const args = {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      thesis_id: 'THESIS-IDEM-1', baseline_assessment: '基线判断 A',
    };
    const first = researchEval.appendResearchThesis(portfolio, ACCOUNT, args, Date.now());
    const second = researchEval.appendResearchThesis(portfolio, ACCOUNT, args, Date.now() + 1000);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.thesis_id, first.thesis_id);
    assert.throws(() => researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      ...args, baseline_assessment: '被篡改的判断 B',
    }, Date.now()), /thesis_id_conflict/);
  } finally { portfolio.close(); }
});

test('T4: 更正记录追加而不覆盖旧记录', () => {
  const { portfolio } = openPair('t4');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    const original = researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      baseline_assessment: '原判断',
    }, Date.now());
    const correction = researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bearish', horizon: 'swing',
      baseline_assessment: '更正后的判断', corrects_thesis_id: original.thesis_id,
    }, Date.now());
    assert.notEqual(correction.thesis_id, original.thesis_id);
    const old = researchEval.readResearchThesis(portfolio, original.thesis_id);
    assert.equal(old.direction, 'bullish', '旧判断单元不得被改写');
  } finally { portfolio.close(); }
});

test('T5: 补录（写入晚于交易日）不进入前瞻评价', () => {
  const { portfolio } = openPair('t5');
  try {
    const backDate = '20261023'; // 早于今天 → recorded_at（今天）> as_of → RETROSPECTIVE
    seedVps(portfolio, { asOf: backDate, bundleId: `BUNDLE-${backDate}-seedvps` });
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${backDate}-seedvps`, as_of_trade_date: backDate,
      independent_judgement: '补录研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    assert.equal(intake.evidence_class, 'RETROSPECTIVE_RECORD');
    const thesis = researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      baseline_assessment: '补录判断',
    }, Date.now());
    assert.equal(thesis.evaluation_eligibility, 'excluded_retrospective');
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: null, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5,
    });
    assert.ok(result.records.by_class.RETROSPECTIVE_RECORD >= 1);
    assert.equal(result.conclusion_by_layer.chatgpt, 'NO_TRUE_FORWARD_RECORDS');
  } finally { portfolio.close(); }
});

test('T6: 条件性/证据不足方向合法，且不进入方向统计', () => {
  const { portfolio } = openPair('t6');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '条件性判断', final_conclusion: 'CONDITIONAL',
    }, Date.now());
    for (const direction of ['conditional', 'evidence_insufficient', 'neutral']) {
      const t = researchEval.appendResearchThesis(portfolio, ACCOUNT, {
        parent_record_id: intake.record_id, target: CODE, direction, horizon: 'swing',
        baseline_assessment: `${direction} 判断`,
      }, Date.now());
      assert.equal(t.created, true);
    }
    assert.throws(() => researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'moonish', horizon: 'swing',
      baseline_assessment: '非法方向',
    }, Date.now()), /direction must be one of/);
  } finally { portfolio.close(); }
});

test('T7: 研究写入不产生任何订单/成交/账本事件', () => {
  const { portfolio } = openPair('t7');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      baseline_assessment: '判断',
    }, Date.now());
    const eventTables = portfolio.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('account_event','trade','order')").all();
    for (const { name } of eventTables) {
      const n = portfolio.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
      assert.equal(n, 0, `${name} 必须为空`);
    }
  } finally { portfolio.close(); }
});

test('T8: ChatGPT 层判断单元通过结构化方向窗口成熟（P0-2 核心）', () => {
  const { portfolio, market } = openPair('t8');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究看多该 ETF。', final_conclusion: 'CONDITIONAL_BULLISH',
    }, Date.now());
    researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      benchmark: BENCH, baseline_assessment: '相对 510300 存在超额。',
    }, Date.now());
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    const chatgpt = result.layers.chatgpt;
    const bucket = chatgpt.relative_return_effectiveness;
    assert.equal(bucket.status, 'EVALUATED', `ChatGPT 层应有成熟样本，实际 ${bucket.status} pending=${JSON.stringify(bucket.pending_reasons)}`);
    assert.equal(bucket.sample_size, 1);
    assert.notEqual(result.conclusion_by_layer.chatgpt, 'NO_RECORDS');
  } finally { portfolio.close(); market.close(); }
});

test('T9: 窗口未成熟返回 PENDING 及原因', () => {
  const { portfolio, market } = openPair('t9');
  try {
    seedVps(portfolio, {});
    const intake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
      independent_judgement: '独立研究', final_conclusion: 'BULLISH',
    }, Date.now());
    researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: intake.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      benchmark: BENCH, baseline_assessment: '判断',
    }, Date.now());
    // asOf = 研究日当天：窗口必然未成熟。
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: AS_OF, horizon: 5, feeEstimator,
    });
    const bucket = result.layers.chatgpt.relative_return_effectiveness;
    assert.ok(bucket.status === 'PENDING' || bucket.status === 'NO_RECORDS');
    if (bucket.status === 'PENDING') {
      assert.ok(Object.keys(bucket.pending_reasons).length > 0, 'PENDING 必须附原因');
    }
  } finally { portfolio.close(); market.close(); }
});

test('T10: 无合法反事实/未成熟时不计算增量价值', () => {
  const { portfolio, market } = openPair('t10');
  try {
    seedVps(portfolio, {});
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: AS_OF, horizon: 5, feeEstimator,
    });
    const inc = result.layers.vps.incremental_value_vs_hold;
    assert.notEqual(inc.status, 'EVALUATED', '窗口未成熟不得输出增量价值数值');
    if (inc.status === 'EVALUATED') assert.fail('不应 EVALUATED');
  } finally { portfolio.close(); market.close(); }
});

test('T11: 重叠窗口独立计数正确（independent <= evaluated）', () => {
  const { portfolio, market } = openPair('t11');
  try {
    seedVps(portfolio, {});
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    const inc = result.layers.vps.incremental_value_vs_hold;
    if (inc.status === 'EVALUATED') {
      assert.ok(inc.value.independent_windows <= inc.value.windows_evaluated);
    }
  } finally { portfolio.close(); market.close(); }
});

test('T12: 评价结果可追溯（evaluation_id / versions / by_source）', () => {
  const { portfolio, market } = openPair('t12');
  try {
    seedVps(portfolio, {});
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    assert.match(result.evaluation_id, /^RE-[0-9a-f]{24}$/);
    assert.ok(result.versions.journal);
    assert.ok(result.records.by_source.vps >= 1);
  } finally { portfolio.close(); market.close(); }
});

// ================================================================ P0-3 Combined 联合判断

test('C1: 仅 VPS 存在时不虚构联合判断', () => {
  const { portfolio } = openPair('c1');
  try {
    seedVps(portfolio, {});
    assert.throws(() => combinedResearch.appendCombinedResearch(portfolio, {
      accountId: ACCOUNT, asOf: AS_OF,
    }), /combined_inputs_incomplete.*chatgpt/s);
  } finally { portfolio.close(); }
});

test('C2: 仅 ChatGPT 存在时不虚构联合判断', () => {
  const { portfolio } = openPair('c2');
  try {
    researchJournal.recordResearchJournal(portfolio, {
      record_id: `CHATGPT-${AS_OF}-lonely`, account_id: ACCOUNT, source: 'chatgpt',
      as_of_trade_date: AS_OF, bundle_id: 'BUNDLE-x',
      generated_at: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}T13:20:00.000Z`,
      versions: { journal: 'test-v1' }, judgement: 'NO_ACTION',
      candidates: [], observations: [], evidence: [],
      provenance: { author: 'chatgpt', source_reference: 'mcp:test', obtained_at: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}T13:20:00.000Z` },
      payload: { final_conclusion: 'NO_ACTION' },
    });
    assert.throws(() => combinedResearch.appendCombinedResearch(portfolio, {
      accountId: ACCOUNT, asOf: AS_OF,
    }), /combined_inputs_incomplete.*vps/s);
  } finally { portfolio.close(); }
});

function seedBoth(db, { decision = 'NO_ACTION', theses = [] } = {}) {
  const vps = seedVps(db, {});
  const intake = chatgptIntake.appendChatgptResearchRecord(db, ACCOUNT, {
    report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF,
    independent_judgement: '独立研究', final_conclusion: decision,
  }, Date.now());
  const thesisRecords = theses.map(t => researchEval.appendResearchThesis(db, ACCOUNT, {
    parent_record_id: intake.record_id, ...t,
  }, Date.now()));
  return { vps, intake, thesisRecords };
}

test('C3: 两条真实父记录存在时生成联合判断，规则版本可追溯', () => {
  const { portfolio } = openPair('c3');
  try {
    seedBoth(portfolio, { theses: [{ target: CODE, direction: 'neutral', horizon: 'swing', baseline_assessment: '中性' }] });
    const result = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(result.created, true);
    assert.equal(result.rule_version, combinedResearch.COMBINED_RULE_VERSION);
    assert.equal(result.evidence_class, 'TRUE_FORWARD');
    const record = researchJournal.readResearchJournal(portfolio, result.record_id);
    assert.equal(record.source, 'combined');
    assert.deepEqual(new Set(record.parent_record_ids), new Set([result.vps_record_id, result.chatgpt_record_id]));
    assert.equal(record.versions.combined_rule, combinedResearch.COMBINED_RULE_VERSION);
    assert.equal(record.payload.rule_version, combinedResearch.COMBINED_RULE_VERSION);
    // 父记录校验：必须一 vps 一 chatgpt。
    const sources = record.parent_record_ids.map(id => researchJournal.readResearchJournal(portfolio, id).source);
    assert.ok(sources.includes('vps') && sources.includes('chatgpt'));
  } finally { portfolio.close(); }
});

test('C4: 同输入幂等，不产生重复组合；换父记录产生新组合', () => {
  const { portfolio } = openPair('c4');
  try {
    seedBoth(portfolio, {});
    const first = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    const replay = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.record_id, first.record_id);
    // 第二条 ChatGPT 记录：显式指定后生成新的组合记录（组合选择可审计）。
    const secondIntake = chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${AS_OF}-seedvps`, as_of_trade_date: AS_OF, idempotency_key: 'second',
      independent_judgement: '第二份独立研究', final_conclusion: 'NO_ACTION',
    }, Date.now());
    const other = combinedResearch.appendCombinedResearch(portfolio, {
      accountId: ACCOUNT, asOf: AS_OF, chatgptRecordId: secondIntake.record_id,
    });
    assert.equal(other.created, true);
    assert.notEqual(other.record_id, first.record_id);
  } finally { portfolio.close(); }
});

test('C5: 冲突意见可审计（行动性分歧 → 沿用 VPS 并记录分歧）', () => {
  const { portfolio } = openPair('c5');
  try {
    seedBoth(portfolio, { theses: [{
      target: CODE, direction: 'bullish', horizon: 'swing', baseline_assessment: '看多',
      decision_impact: '建议买入该 ETF 增加暴露',
    }] });
    const result = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(result.decision, 'FOLLOW_VPS_WITH_DIVERGENCE_NOTED');
    assert.ok(result.divergences.some(d => /action_divergence/.test(d)));
  } finally { portfolio.close(); }
});

test('C6: NO_ACTION 是合法联合决策', () => {
  const { portfolio } = openPair('c6');
  try {
    seedBoth(portfolio, { theses: [{ target: CODE, direction: 'neutral', horizon: 'swing', baseline_assessment: '无优势' }] });
    const result = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(result.decision, 'NO_ACTION');
  } finally { portfolio.close(); }
});

test('C7: 结果已知后追加历史日期组合 → 补录分类，不伪装前瞻', () => {
  const { portfolio } = openPair('c7');
  try {
    const past = '20261023';
    seedVps(portfolio, { asOf: past, bundleId: `BUNDLE-${past}-seedvps` });
    chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: `BUNDLE-${past}-seedvps`, as_of_trade_date: past,
      independent_judgement: '补录', final_conclusion: 'NO_ACTION',
    }, Date.now());
    const result = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: past });
    assert.equal(result.evidence_class, 'RETROSPECTIVE_RECORD');
  } finally { portfolio.close(); }
});

test('C8: Combined 层进入三层评价（有真实生成机制）', () => {
  const { portfolio, market } = openPair('c8');
  try {
    seedBoth(portfolio, { theses: [{ target: CODE, direction: 'bullish', horizon: 'swing', benchmark: BENCH, baseline_assessment: '看多相对基准' }] });
    const combined = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    // 联合判断单元挂在 combined 记录下。
    researchEval.appendResearchThesis(portfolio, ACCOUNT, {
      parent_record_id: combined.record_id, target: CODE, direction: 'bullish', horizon: 'swing',
      benchmark: BENCH, baseline_assessment: '联合后的方向判断',
    }, Date.now());
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    assert.ok(result.records.by_source.combined >= 1);
    assert.ok(result.theses.by_layer.combined >= 1);
    assert.ok(result.layers.combined, 'combined 层必须存在');
    assert.notEqual(result.conclusion_by_layer.combined, 'NO_RECORDS');
  } finally { portfolio.close(); market.close(); }
});

// ================================================================ MCP 工具与 scope

test('M1: tools/list 私有工具集包含全部应可用工具（含新增两个）', () => {
  process.env.ASHARE_PORTFOLIO_ENABLED = '1';
  try {
    const list = getPrivateToolList();
    const names = new Set(list.map(t => t.name));
    for (const expected of [
      'ashare_investment_research_bundle', 'ashare_portfolio_daily_report',
      'ashare_etf_candidates', 'ashare_portfolio_benchmarks',
      'ashare_chatgpt_research_record_append', 'ashare_research_thesis_append',
      'ashare_research_eval', 'ashare_research_snapshot_get', 'ashare_research_combined_append',
    ]) assert.ok(names.has(expected), `tools/list 缺少 ${expected}`);
    // 快照工具声明读 scope；combined 追加声明写 scope。
    const snapshot = list.find(t => t.name === 'ashare_research_snapshot_get');
    assert.deepEqual(snapshot.securitySchemes[0].scopes, ['portfolio:read']);
    const combined = list.find(t => t.name === 'ashare_research_combined_append');
    assert.ok(combined.securitySchemes[0].scopes.includes('research:append'));
  } finally { delete process.env.ASHARE_PORTFOLIO_ENABLED; }
});

test('M2: OAuth 读写 scope 工具集隔离正确', () => {
  const write = definitions.WRITE_SCOPE_TOOL_NAMES;
  assert.ok(write.has('ashare_chatgpt_research_record_append'));
  assert.ok(write.has('ashare_research_thesis_append'));
  assert.ok(write.has('ashare_research_combined_append'));
  assert.ok(!write.has('ashare_research_snapshot_get'), '快照读取不得要求写 scope');
  assert.ok(!write.has('ashare_research_eval'));
  assert.ok(!write.has('ashare_investment_research_bundle'));
});

test('M3: 写入失败真实披露（错误不被吞掉）', () => {
  const { portfolio } = openPair('m3');
  try {
    assert.throws(() => chatgptIntake.appendChatgptResearchRecord(portfolio, ACCOUNT, {
      report_id: 'BUNDLE-nonexistent', as_of_trade_date: AS_OF,
      independent_judgement: 'x', final_conclusion: 'y',
    }, Date.now()), /bundle_not_found|bundle_identity_mismatch/);
    assert.throws(() => combinedResearch.appendCombinedResearch(portfolio, {
      accountId: ACCOUNT, asOf: 'not-a-date',
    }), /YYYYMMDD/);
  } finally { portfolio.close(); }
});

test('M4: NO_ACTION 全链路可通过（intake → thesis → combined → eval）', () => {
  const { portfolio, market } = openPair('m4');
  try {
    const { intake } = seedBoth(portfolio, {
      decision: 'NO_ACTION；研究性维持',
      theses: [{ target: CODE, direction: 'neutral', horizon: 'swing', baseline_assessment: '无交易优势' }],
    });
    assert.equal(intake.created, true);
    const combined = combinedResearch.appendCombinedResearch(portfolio, { accountId: ACCOUNT, asOf: AS_OF });
    assert.equal(combined.decision, 'NO_ACTION');
    const result = researchEval.buildResearchEval({
      portfolioDb: portfolio, marketDb: market, accountId: ACCOUNT, asOf: EVAL_DATE, horizon: 5, feeEstimator,
    });
    assert.ok(result.records.total >= 3);
  } finally { portfolio.close(); market.close(); }
});

// ================================================================ V3 提示词契约（文档级）

test('P1: V3 提示词文档存在且满足 21:45 / A–H / 禁词 / 新流程契约', async () => {
  const docPath = join(new URL('../../AShareInvestor/docs/v1/', import.meta.url).pathname, 'V1_CHATGPT_DAILY_TASK_V3.md');
  if (!existsSync(docPath)) {
    assert.fail(`V3 提示词文档缺失：${docPath}`);
  }
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(docPath, 'utf8');
  assert.match(doc, /21:45/);
  assert.ok(!/21:40/.test(doc.match(/```text[\s\S]*?```/)?.[0] ?? ''), 'V3 正文不得再写 21:40');
  for (const section of ['A. 今日结论', 'B. 下一交易日关注重点', 'C. 我的账户', 'D. 市场发生了什么',
    'E. 我的五只持仓', 'F. 是否有更好的选择', 'G. 风险与情景', 'H. 接下来验证什么']) {
    assert.ok(doc.includes(section), `V3 缺少 ${section}`);
  }
  for (const step of ['ashare_research_snapshot_get', 'ashare_research_combined_append',
    'ashare_research_thesis_append', 'ashare_research_eval']) {
    assert.ok(doc.includes(step), `V3 流程缺少 ${step}`);
  }
});

// ================================================================ 快照与 Live Bundle 一致性回归

test('R1: recordVpsResearchSnapshot 写入的快照可被 snapshot_get 按身份读取', () => {
  const { portfolio } = openPair('r1');
  try {
    const bundle = { report_id: `BUNDLE-${AS_OF}-recorded`, as_of_trade_date: AS_OF,
      generated_at: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}T13:15:00.000Z`, payload_marker: 42 };
    const rec = researchRecord.recordVpsResearchSnapshot({
      portfolioDb: portfolio, accountId: ACCOUNT, bundle,
    });
    assert.equal(rec.created, true);
    const got = researchSnapshot.getResearchSnapshot(portfolio, { accountId: ACCOUNT, recordId: rec.record.record_id });
    assert.equal(got.frozen_payload.payload_marker, 42);
    assert.equal(got.snapshot.bundle_id, `BUNDLE-${AS_OF}-recorded`);
  } finally { portfolio.close(); }
});
