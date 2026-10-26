import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// goal-1026 §7.1/§7.2/§7.3：结构化研究判断单元与三层×六指标评价。
// fixture 覆盖：重复幂等键、补录（retrospective）单独分层、评价窗口未成熟（PENDING），
// 呼应任务书 §10.4。不运行构建，全部基于 build/ 已有产物。

const { openAshareDb, upsertRows } = await import('../build/ashare/db.js');
const { recordResearchJournal, listResearchJournal } = await import('../build/portfolio/researchJournal.js');
const { openPortfolioDb } = await import('../build/portfolio/db.js');
const { initBaseline } = await import('../build/portfolio/ledger.js');
const { classifyRecord, TRUE_FORWARD_START } = await import('../build/portfolio/forwardReview.js');
const {
  appendResearchThesis, listResearchThesis, buildResearchEval,
  THESIS_APPEND_TOOL, THESIS_EVAL_TOOL, EVAL_METRIC_IDS, EVAL_LAYERS, RESEARCH_EVAL_SCHEMA,
} = await import('../build/portfolio/researchEval.js');
const { RESEARCH_PRIVATE_TOOLS, runPortfolioResearchTool } = await import('../build/portfolio/researchTools.js');
const { portfolioToolDefinitions, WRITE_SCOPE_TOOL_NAMES, PORTFOLIO_TOOL_NAMES } = await import('../build/ashare/definitions.js');
const { getAvailableToolList, getPrivateToolList } = await import('../build/dispatch.js');

const dir = mkdtempSync(join(tmpdir(), 'research-eval-'));
const ACCOUNT = 'synthetic-eval';
const feeEstimator = () => ({ total_cents: 10, estimated: true, version: 'synthetic-v1' });

let seq = 0;
function weekdays(from, n) {
  const out = [];
  for (let d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`); out.length < n; d = new Date(+d + 86400000)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
}
const BENCH = ['510300.SH', '511010.SH', '518880.SH', '513100.SH'];
const ALL_CODES = [...new Set(['510500.SH', ...BENCH])];

function market(dates, growth = () => 0.001) {
  const db = openAshareDb(join(dir, `m-${seq += 1}.sqlite`));
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'],
    dates.map((cal_date, i) => ({ cal_date, is_open: 1, pretrade_date: dates[i - 1] ?? null })));
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
    ALL_CODES.map(ts_code => ({ ts_code, name: `合成${ts_code}`, fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' })));
  for (const ts_code of ALL_CODES) dates.forEach((trade_date, i) => {
    const close = 1 * (1 + growth(ts_code) * i);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code, trade_date, open: close, high: close, low: close, close, pre_close: close, vol: 1e6, amount: 1e6 }]);
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'], [{ ts_code, trade_date, adj_factor: 1 }]);
  });
  return db;
}

const at = (date, hm = '18:00') => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hm}:00+08:00`;
function atClock(nowMs, fn) {
  const Actual = globalThis.Date;
  globalThis.Date = class extends Actual {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return Actual.parse(nowMs); }
  };
  try { return fn(); } finally { globalThis.Date = Actual; }
}
const entry = (id, date, extra = {}) => ({
  record_id: id, account_id: ACCOUNT, source: 'vps', as_of_trade_date: date, bundle_id: `b-${id}`,
  generated_at: at(date), versions: { rules: 'v1' },
  judgement: { c: 'observe' }, candidates: [], evidence: [],
  observations: [
    { ts_code: '510500.SH', quantity: 10000, direction: 'observe',
      trigger_price_milli: 500, invalidation_price_milli: 500, benchmark_code: '510300.SH' },
  ], ...extra,
});
const journal = (db, input, when) => atClock(when, () => recordResearchJournal(db, input));

/** 每个测试独立的库对：账户库（研究日志+判断单元）与行情库。 */
function fixture({ dates = weekdays('20261016', 30), withBaseline = true } = {}) {
  const p = openPortfolioDb(join(dir, `p-${seq += 1}.sqlite`));
  if (withBaseline) initBaseline(p, ACCOUNT, { asOf: '20261018', cashCents: 100000 });
  const m = market(dates);
  return { p, m, dates };
}

const thesisBody = (extra = {}) => ({
  parent_record_id: 'fwd', target: '510500.SH', direction: 'neutral', horizon: 'swing',
  baseline_assessment: '成交量未确认，维持观察，不形成方向性判断。', ...extra,
});

// ---------------------------------------------------------------- 7.2 判断单元：append-only + 幂等

test('结构化判断单元只追加：同键同内容幂等、同键不同内容拒绝、未知字段整次拒绝', () => {
  const { p, m } = fixture();
  try {
    journal(p, entry('fwd', '20261022'), at('20261022'));
    const nowMs = Date.parse('2026-10-22T20:00:00+08:00');
    const args = { ...thesisBody(), thesis_id: 'THESIS-A' };
    const first = appendResearchThesis(p, ACCOUNT, args, nowMs);
    assert.equal(first.created, true);
    assert.equal(first.parent_evidence_class, 'TRUE_FORWARD');
    assert.equal(first.evaluation_eligibility, 'eligible');
    // 重复幂等键：同 id 同内容 → created:false，不产生第二行。
    const replay = appendResearchThesis(p, ACCOUNT, args, nowMs + 1000);
    assert.equal(replay.created, false);
    assert.equal(replay.content_hash, first.content_hash);
    assert.equal(listResearchThesis(p, { accountId: ACCOUNT }).length, 1);
    // 同 id 不同内容 → 拒绝（更正必须走新 id + corrects_thesis_id）。
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...args, direction: 'bullish' }, nowMs), /thesis_id_conflict/);
    // 未知字段（含任何凭证形状的字段、任何服务端字段）→ 整次拒绝，而不是静默忽略。
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...args, access_token: 'hunter2' }, nowMs), /not accepted/);
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...args, created_at: '2026-10-22T00:00:00Z' }, nowMs), /not accepted/);
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...args, evaluation_eligibility: 'eligible' }, nowMs), /not accepted/);
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...args, parent_evidence_class: 'TRUE_FORWARD' }, nowMs), /not accepted/);
    // 落库内容里搜不到任何凭证形状的值。
    const rows = listResearchThesis(p, { accountId: ACCOUNT });
    assert.doesNotMatch(JSON.stringify(rows), /hunter2|password/i);
    // 父记录不存在 → 拒绝（不伪造关联）。
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...thesisBody(), parent_record_id: 'missing' }, nowMs), /existing research journal/);
    // 研究日志本身原封未动：分类与条数不变（§7.1）。
    const records = listResearchJournal(p, { accountId: ACCOUNT });
    assert.equal(records.length, 1);
    assert.equal(classifyRecord(records[0]), 'TRUE_FORWARD');
  } finally { p.close(); m.close(); }
});

test('补录记录的判断单元永远是 excluded_retrospective，不能被改判为前瞻', () => {
  const { p, m } = fixture();
  try {
    // 写入时间晚于研究交易日 → RETROSPECTIVE_RECORD（同 2026-10-23 ChatGPT 记录的补录属性）。
    journal(p, entry('late', '20261022', { source: 'chatgpt', provenance: { author: 'chatgpt', source_reference: 'mcp:x', obtained_at: '2026-10-30T10:00:00+08:00' } }), '2026-10-30T10:00:00+08:00');
    const record = listResearchJournal(p, { accountId: ACCOUNT }).find(r => r.record_id === 'late');
    assert.equal(classifyRecord(record), 'RETROSPECTIVE_RECORD');
    const res = appendResearchThesis(p, ACCOUNT, { ...thesisBody(), parent_record_id: 'late' }, Date.parse('2026-10-30T10:05:00+08:00'));
    assert.equal(res.parent_evidence_class, 'RETROSPECTIVE_RECORD');
    assert.equal(res.evaluation_eligibility, 'excluded_retrospective');
    // 证据分类是服务端推导的，调用方无法声明。
    const [unit] = listResearchThesis(p, { accountId: ACCOUNT });
    assert.equal(unit.parent_evidence_class, 'RETROSPECTIVE_RECORD');
    // 评价读取时按补录分桶：excluded 计数，绝不进入统计值，也不算作"待成熟"。
    const r = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261029', horizon: 5, feeEstimator });
    assert.equal(r.records.by_class.RETROSPECTIVE_RECORD, 1);
    assert.equal(r.records.by_class.TRUE_FORWARD, 0);
    for (const id of EVAL_METRIC_IDS) {
      const b = r.layers.chatgpt[id];
      assert.equal(b.status, 'NO_RECORDS', id);
      assert.equal(b.sample_size, 0);
      assert.equal(b.by_class.RETROSPECTIVE_RECORD.sample_size, 0, id);
      assert.equal(b.by_class.RETROSPECTIVE_RECORD.excluded, 1, id);
      assert.equal(b.by_class.RETROSPECTIVE_RECORD.pending, 0, id);
    }
    assert.equal(r.statement, '只有补录或规则冻结前的记录，前瞻层没有真实样本；补录不与前瞻合并统计。');
    assert.equal(r.theses.by_class.RETROSPECTIVE_RECORD, 1);
    assert.equal(r.theses.by_layer.chatgpt, 1);
  } finally { p.close(); m.close(); }
});

// ---------------------------------------------------------------- 7.3 评价窗口未成熟 → PENDING

test('评价窗口未成熟的前瞻层六指标全部 PENDING，并带原因；不是 NO_RECORDS 也不是 NO_IMPROVEMENT', () => {
  const { p, m } = fixture();
  try {
    journal(p, entry('fwd', '20261022'), at('20261022'));
    appendResearchThesis(p, ACCOUNT, thesisBody(), Date.parse('2026-10-22T20:00:00+08:00'));
    // asOf 只过了 2 天，5 日期限窗口尚未成熟。
    const r = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261024', horizon: 5, feeEstimator });
    assert.equal(r.schema, RESEARCH_EVAL_SCHEMA);
    assert.equal(r.true_forward_start, TRUE_FORWARD_START);
    assert.equal(r.records.by_class.TRUE_FORWARD, 1);
    assert.equal(r.conclusion_by_layer.vps, 'NO_MATURED_FORWARD_SAMPLE');
    assert.equal(r.layers.chatgpt.fact_prediction_accuracy.status, 'NO_RECORDS');
    for (const id of EVAL_METRIC_IDS) {
      const b = r.layers.vps[id];
      assert.equal(b.status, 'PENDING', id);
      assert.equal(b.sample_size, 0, id);
      assert.ok(b.pending >= 1, id);
      assert.ok(Object.keys(b.pending_reasons).length >= 1, id);
      assert.equal(b.value, null, id);
      // 分层保留：补录/历史分桶不并入。
      assert.equal(b.by_class.TRUE_FORWARD.sample_size, 0);
      assert.equal(b.by_class.RETROSPECTIVE_RECORD.excluded, 0);
    }
    assert.equal(r.layers.vps.fact_prediction_accuracy.pending_reasons.observation_window_not_mature, 1);
    // 评价是纯读：不写任何评价行。注意不能断言"表不存在"——research_journal 与
    // research_journal_evaluation 在同一 SCHEMA 包里，fixture 的 recordResearchJournal
    // 一落库两张表就都建好了；纯读的不变量是**零行**，不是表缺失。
    assert.equal(p.prepare('SELECT COUNT(*) n FROM research_journal_evaluation').get().n, 0);
    // 同库同参数 → 确定性 JSON。
    const again = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261024', horizon: 5, feeEstimator });
    assert.equal(JSON.stringify(r), JSON.stringify(again));
  } finally { p.close(); m.close(); }
});

test('成熟窗口下六指标出 EVALUATED 值，前瞻与补录仍分开统计', () => {
  const dates = weekdays('20261016', 30);
  const { p, m } = fixture({ dates });
  try {
    journal(p, entry('fwd', '20261022'), at('20261022'));
    journal(p, entry('late', '20261022', { source: 'chatgpt', provenance: { author: 'chatgpt', source_reference: 'mcp:x', obtained_at: '2026-10-30T10:00:00+08:00' } }), '2026-10-30T10:00:00+08:00');
    appendResearchThesis(p, ACCOUNT, thesisBody({ direction: 'bullish' }), Date.parse('2026-10-22T20:00:00+08:00'));
    const asOf = dates.at(-1);
    const r = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf, horizon: 5, feeEstimator });
    assert.equal(r.records.by_class.TRUE_FORWARD, 1);
    assert.equal(r.records.by_class.RETROSPECTIVE_RECORD, 1);
    const vps = r.layers.vps;
    assert.equal(vps.relative_return_effectiveness.status, 'EVALUATED');
    assert.equal(vps.relative_return_effectiveness.sample_size, 1);
    assert.equal(vps.counterfactual_portfolio_return.status, 'EVALUATED');
    assert.equal(vps.after_fee_risk_adjusted_return.status, 'EVALUATED');
    // 触发/失效条件可检验 → 事实与风险指标可算。
    assert.equal(vps.fact_prediction_accuracy.status, 'EVALUATED');
    assert.equal(vps.risk_prediction_effectiveness.status, 'EVALUATED');
    assert.equal(vps.incremental_value_vs_hold.status, 'EVALUATED');
    assert.ok(Number.isFinite(vps.relative_return_effectiveness.value.by_benchmark.csi300_etf_buy_hold.mean_excess_pct_points));
    // 样本不足 12 个独立窗口 → 结论保持"样本不足"，不宣称改进。
    assert.equal(r.conclusion_by_layer.vps, 'INSUFFICIENT_SAMPLE');
    // chatgpt/combined 层没有真实前瞻记录：保持 NO_RECORDS，绝不用补录的表现填充统计。
    assert.equal(r.layers.chatgpt.relative_return_effectiveness.status, 'NO_RECORDS');
    assert.equal(r.layers.chatgpt.relative_return_effectiveness.sample_size, 0);
    assert.equal(r.layers.chatgpt.relative_return_effectiveness.by_class.RETROSPECTIVE_RECORD.excluded, 1);
    assert.equal(r.layers.combined.relative_return_effectiveness.status, 'NO_RECORDS');
    // 判断单元随成熟窗口有评价视角。
    assert.equal(r.theses.with_matured_window, 1);
    assert.equal(r.theses.pending, 0);
    assert.match(r.theses.confidence_note, /未校准/);
    assert.ok(r.limitations.some(t => /一次方向判断正确/.test(t)));
    // 风险调整比率要么有值要么有原因，不静默。
    const ra = vps.after_fee_risk_adjusted_return.value.risk_adjusted;
    assert.ok('reason' in ra);
    if (ra.reason !== null) assert.equal(ra.sharpe_ratio, null);
  } finally { p.close(); m.close(); }
});

test('无任何记录时输出 NO_RECORDS 且不补造历史表现', () => {
  const { p, m } = fixture({ withBaseline: false });
  try {
    const r = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261029', horizon: 5, feeEstimator });
    assert.equal(r.records.total, 0);
    assert.equal(r.theses.total, 0);
    assert.equal(r.statement, '没有任何研究记录，无从评价；不补造历史表现。');
    for (const layer of EVAL_LAYERS) for (const id of EVAL_METRIC_IDS) {
      assert.equal(r.layers[layer][id].status, 'NO_RECORDS', `${layer}/${id}`);
      assert.equal(r.layers[layer][id].value, null);
      assert.match(r.layers[layer][id].note, /不补造/);
    }
  } finally { p.close(); m.close(); }
});

test('允许中性、证据不足与条件性判断；confidence 只接受 [0,1] 且不当精确概率', () => {
  const { p, m } = fixture();
  try {
    journal(p, entry('fwd', '20261022'), at('20261022'));
    const now = Date.parse('2026-10-22T20:00:00+08:00');
    for (const direction of ['neutral', 'evidence_insufficient', 'conditional']) {
      const res = appendResearchThesis(p, ACCOUNT, { ...thesisBody(), direction, thesis_id: `T-${direction}` }, now);
      assert.equal(res.created, true, direction);
    }
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...thesisBody(), direction: 'long' }, now), /direction must be/);
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...thesisBody(), confidence: 1.5 }, now), /\[0,1\]/);
    assert.throws(() => appendResearchThesis(p, ACCOUNT, { ...thesisBody(), confidence: -0.1 }, now), /\[0,1\]/);
    const ok = appendResearchThesis(p, ACCOUNT, { ...thesisBody(), thesis_id: 'T-conf', confidence: 0.6 }, now);
    assert.equal(ok.created, true);
    const units = listResearchThesis(p, { accountId: ACCOUNT, parentRecordId: 'fwd' });
    assert.ok(units.length >= 4);
    // 自然语言与结构化字段共存：baseline_assessment 保留供审计。
    assert.match(units[0].baseline_assessment, /维持观察/);
    // 评价层输出携带"confidence 非概率"的显式提示。
    const r = buildResearchEval({ portfolioDb: p, marketDb: m, accountId: ACCOUNT, asOf: '20261024', horizon: 5, feeEstimator });
    assert.match(r.theses.confidence_note, /禁止当作精确概率/);
    assert.ok(r.limitations.some(t => /增量价值/.test(t)));
  } finally { p.close(); m.close(); }
});

// ---------------------------------------------------------------- 工具面与协议兼容

test('两个新工具进 RESEARCH_PRIVATE_TOOLS 与定义清单；append 声明写 scope，eval 只读', () => {
  assert.ok(RESEARCH_PRIVATE_TOOLS.has(THESIS_APPEND_TOOL));
  assert.ok(RESEARCH_PRIVATE_TOOLS.has(THESIS_EVAL_TOOL));
  assert.ok(PORTFOLIO_TOOL_NAMES.has(THESIS_APPEND_TOOL));
  assert.ok(PORTFOLIO_TOOL_NAMES.has(THESIS_EVAL_TOOL));
  const append = portfolioToolDefinitions.find(t => t.name === THESIS_APPEND_TOOL);
  const evalTool = portfolioToolDefinitions.find(t => t.name === THESIS_EVAL_TOOL);
  assert.deepEqual(append.annotations, { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true });
  assert.equal(evalTool.annotations.readOnlyHint, true);
  assert.deepEqual(append.securitySchemes, [{ type: 'oauth2', scopes: ['portfolio:read', 'research:append'] }]);
  // 写 scope 门控按工具集判定：两个追加类工具都在集合里，eval 不在。
  assert.ok(WRITE_SCOPE_TOOL_NAMES.has(THESIS_APPEND_TOOL));
  assert.ok(WRITE_SCOPE_TOOL_NAMES.has('ashare_chatgpt_research_record_append'));
  assert.ok(!WRITE_SCOPE_TOOL_NAMES.has(THESIS_EVAL_TOOL));
  // 既有 intake 的注解语义不变（r0/r1 断言依赖这两条）。
  const intake = portfolioToolDefinitions.find(t => t.name === 'ashare_chatgpt_research_record_append');
  assert.equal(intake.annotations.readOnlyHint, false);
  assert.equal(intake.annotations.idempotentHint, true);
});

test('工具端点：写工具可写、读工具只读、公网清单永不包含', () => {
  const saved = { ...process.env };
  try {
    process.env.ASHARE_PORTFOLIO_ENABLED = '1';
    process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'tool-p.sqlite');
    process.env.ASHARE_DB_PATH = join(dir, 'tool-m.sqlite');
    process.env.FINANCE_TOOL_PROFILE = 'ashare_daily';
    // 最小真实形状的账户库与行情库。
    const p = openPortfolioDb(process.env.ASHARE_PORTFOLIO_DB_PATH);
    initBaseline(p, ACCOUNT, { asOf: '20261018', cashCents: 100000 });
    journal(p, entry('fwd', '20261022'), at('20261022'));
    p.close();
    const m = market(weekdays('20261016', 30));
    m.close();

    const appended = JSON.parse(runPortfolioResearchTool(THESIS_APPEND_TOOL, {
      account_id: ACCOUNT, ...thesisBody(), thesis_id: 'TOOL-1',
    }).content[0].text);
    assert.equal(appended.created, true);
    assert.equal(appended.parent_evidence_class, 'TRUE_FORWARD');

    const evaluated = JSON.parse(runPortfolioResearchTool(THESIS_EVAL_TOOL, {
      account_id: ACCOUNT, as_of_trade_date: '20261024', horizon: 5,
    }).content[0].text);
    assert.equal(evaluated.schema, RESEARCH_EVAL_SCHEMA);
    assert.equal(evaluated.account_id, ACCOUNT);
    assert.equal(evaluated.layers.vps.fact_prediction_accuracy.status, 'PENDING');

    // 公网/本地清单：两个新工具都不得出现（账户/研究工具只在私有端点）。
    const pub = getAvailableToolList().map(t => t.name);
    assert.ok(!pub.includes(THESIS_APPEND_TOOL));
    assert.ok(!pub.includes(THESIS_EVAL_TOOL));
    const priv = getPrivateToolList().map(t => t.name);
    assert.ok(priv.includes(THESIS_APPEND_TOOL));
    assert.ok(priv.includes(THESIS_EVAL_TOOL));
    // 私有清单上的写工具恰好是两个追加类工具（intake + thesis）。
    const writers = getPrivateToolList().filter(t => t.annotations.readOnlyHint !== true).map(t => t.name).sort();
    assert.deepEqual(writers, ['ashare_chatgpt_research_record_append', THESIS_APPEND_TOOL].sort());
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('源码静态约束：researchTools 不直接写研究日志，新模块只追加且无凭证字段', () => {
  const tools = readFileSync('src/portfolio/researchTools.ts', 'utf8');
  assert.doesNotMatch(tools, /recordResearchJournal|research_journal/, 'researchTools must not call a journal write directly');
  assert.match(tools, /appendChatgptResearchRecord/);
  assert.match(tools, /appendResearchThesis/);
  assert.match(tools, /buildResearchEval/);
  const evalSrc = readFileSync('src/portfolio/researchEval.ts', 'utf8');
  assert.doesNotMatch(evalSrc, /recordResearchJournal|recordJournalEvaluations/, 'researchEval must be read-only over the journal');
  assert.doesNotMatch(evalSrc, /DELETE\s+FROM\s+research_journal|UPDATE\s+research_journal/i, 'research journal must never be mutated');
  assert.doesNotMatch(evalSrc, /\bapi[_-]?key\b|\bpassword\b|\bbearer\b/i, 'no credential-shaped fields in the eval module');
  // 判断单元表同样是追加不可变的。
  assert.match(evalSrc, /research_thesis_no_update/);
  assert.match(evalSrc, /research_thesis_no_delete/);
});
