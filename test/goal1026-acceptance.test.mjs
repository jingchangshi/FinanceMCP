import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// goal-1026 §10.1–10.4 验收断言（H-tests 第八部分；10.5 十场景见 report-golden.test.mjs）。
//
// 逐条覆盖任务书 §10 的 9（数据与账户）+ 10（研究与证据）+ 15（决策与费用）+ 9（历史研究）
// 共 43 项，每项一个具名 test，test 名以 `10.x-n` 开头，与任务书条目一一对应。
//
// 只用合成 fixture：临时市场缓存 + 临时账户库 + 合成日报。不读网络、不写生产库。
// 需要真实回放的条目（历史快照重放等）在断言体内以 t.diagnostic 标注回放命令，
// 并同时给出可离线验证的等价断言；不得伪造真实数据。
//
// 与 report-golden.test.mjs 的分工：golden 覆盖 §10.5 的十场景 × 九重点断言（渲染层）；
// 本文件覆盖 §10.1–10.4 的条目级语义（数据门控、证据模型、决策费用、前瞻评价）。
// 两者的 seedMarket/seedAccount 是各自独立的副本——node --test 按文件隔离、helper 不跨文件共享。
//
// 运行方式（由主控在统一测试窗口执行；编写期间不得构建）：
//   node --test --test-concurrency=1 test/goal1026-acceptance.test.mjs

const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
/** 尚未合流/构建的模块：返回 null，调用方按“待合流绑定”处理。 */
async function maybe(name) {
  try { return await load(name); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'goal1026-acc-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio-default.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;
delete process.env.ASHARE_PRIVATE_PORTFOLIO_TOKEN;

const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await import(pathToFileURL(join(root, 'portfolio/account.js')));
const ledger = await load('portfolio/ledger.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');
const { buildDecision, loadEtfQuote } = await load('portfolio/decision.js');
const { buildResearchSummary } = await load('portfolio/researchSummary.js');
const { resolveResearchDate } = await load('ashare/researchDate.js');
const { recordRiskPolicy, buildPortfolioRiskState } = await load('portfolio/riskPolicy.js');
const { adjustmentRatio, baseFactor } = await load('ashare/data.js');
const rules = await load('portfolio/rules.js');
const feesMod = await load('portfolio/fees.js');
const evidenceModel = await load('ashare/evidenceModel.js');
const penetration = await load('ashare/etfPenetration.js');
const forwardReview = await load('portfolio/forwardReview.js');
const researchJournal = await load('portfolio/researchJournal.js');
const researchRecord = await load('portfolio/researchRecord.js');
const chatgptIntake = await load('portfolio/chatgptIntake.js');
const benchmarks = await load('portfolio/benchmarks.js');
const researchBundle = await load('portfolio/researchBundle.js');
const evidenceStore = await load('portfolio/evidence.js');
const researchEval = await load('portfolio/researchEval.js');
const { weekdays, seedMarket: seedStockMarket } = await import('./ashare-fixture.mjs');

// ---------------------------------------------------------------- 时间与行情基线（与 golden 同口径）

const DAYS = weekdays('20261005', 10);   // 20261005..20261016（跳过周末）
const LAST = DAYS.at(-1);                 // 20261016（星期五）
const PREV = DAYS.at(-2);                 // 20261015

const BASE_CLOSE = {
  '159241.SZ': 1.005, '159278.SZ': 0.796, '159558.SZ': 0.935,
  '516080.SH': 0.636, '560390.SH': 0.742, '510300.SH': 4.0,
};
const HOLDING_CODES = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'];
const HOLDING_QTY = {
  '159241.SZ': 1000, '159278.SZ': 1000, '159558.SZ': 58900,
  '516080.SH': 10000, '560390.SH': 15000,
};
const BASIC = Object.entries(BASE_CLOSE).map(([ts_code]) => ({
  ts_code, name: ts_code === '510300.SH' ? '沪深300ETF' : `合成${ts_code}`,
  fund_type: '股票型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E',
}));

// ---------------------------------------------------------------- fixture：市场库 / 账户库

function reportFixture({ judgment = ['合成验收日报：结构与口径检查，不构成投资建议'],
  upRatio = 0.30, medianPct = -0.40, amountYi = 9000, amountMa20 = 12000,
  indexRet5 = -1.20, indexRet20 = -4.00, crash = false, rebound = false } = {}) {
  return {
    report_id: null,
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: LAST,
    generated_at: '2026-10-16T21:40:00+08:00',
    status: 'READY',
    run_mode: 'manual',
    market: {
      regime: 'range',
      regime_label: crash ? '下跌' : '震荡',
      tone: crash ? 'negative' : rebound ? 'positive' : 'negative',
      judgement: judgment,
      indices: [
        { ts_code: '000300.SH', name: '沪深300', close: 4020.11,
          pct_chg: crash ? -9.9 : rebound ? 5.5 : -0.08,
          ret5: indexRet5, ret20: indexRet20, amount_yi: amountYi,
          above_ma20: rebound, above_ma60: false },
      ],
      breadth: {
        stocks: 5000, up: Math.round(5000 * upRatio),
        down: 5000 - Math.round(5000 * upRatio) - 100, flat: 100,
        limit_up: crash ? 5 : 20, limit_down: crash ? 320 : 40,
        up_ratio: upRatio, median_pct_chg: medianPct,
        amount_yi: amountYi, amount_ma20_yi: amountMa20,
        pct_above_ma20: crash ? 6 : 18, pct_above_ma60: crash ? 12 : 30,
      },
    },
    sectors: {
      method: '合成测试数据',
      top: [{ industry: '出版业', rank: 1, strength: 1.0, stocks: 29, ret5_median_pct: 2.79, ret20_median_pct: 7.63, pct_above_ma20: 86.2 }],
      bottom: [{ industry: '铅锌', rank: 105, strength: 0.02, stocks: 14, ret5_median_pct: -8.69, ret20_median_pct: -18.15, pct_above_ma20: 0 }],
      all: [
        { industry: '半导体', rank: 90, strength: 0.1, ret5_median_pct: -3.0, ret20_median_pct: -8.0, pct_above_ma20: 10 },
        { industry: '国防军工', rank: 95, strength: 0.08, ret5_median_pct: -2.0, ret20_median_pct: -6.0, pct_above_ma20: 10 },
        { industry: '机械设备', rank: 70, strength: 0.3, ret5_median_pct: -1.0, ret20_median_pct: -3.0, pct_above_ma20: 25 },
        { industry: '医药生物', rank: 60, strength: 0.4, ret5_median_pct: 0.1, ret20_median_pct: -1.0, pct_above_ma20: 35 },
        { industry: '电力设备', rank: 65, strength: 0.35, ret5_median_pct: -0.2, ret20_median_pct: -2.0, pct_above_ma20: 30 },
      ],
    },
    disclaimer: '合成验收日报，不是投资建议。',
  };
}

/**
 * 场景专用市场库。
 * @param opts.staleCodes  目标日缺行情的代码
 * @param opts.missingDate 整个目标日无基金行情
 * @param opts.reportPatch reportFixture 覆盖
 * @param opts.priorDayReport 在 PREV 而不是 LAST 写一份 READY 日报（日期不一致场景）
 * @param opts.extraStocks 额外主板/科创板个股（权限场景）
 */
function seedMarket(name, opts = {}) {
  const { staleCodes = [], missingDate = false, reportPatch = {}, priorDayReport = false, extraStocks = [] } = opts;
  const file = join(dir, `market-${name}.sqlite`);
  const db = openAshareDb(file);
  seedStockMarket(db, DAYS);
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261017', is_open: 0, pretrade_date: LAST },
    { cal_date: '20261018', is_open: 0, pretrade_date: LAST },
    // 合成节假日：20261019（周一）在日历内但不开市（A1 节假日相位）。
    { cal_date: '20261019', is_open: 0, pretrade_date: LAST },
    { cal_date: '20261020', is_open: 1, pretrade_date: LAST },
  ]);
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], BASIC);
  for (const code of Object.keys(BASE_CLOSE)) {
    const barDates = missingDate ? DAYS.filter(d => d !== LAST) : DAYS;
    const rows = barDates.map(date => {
      const close = BASE_CLOSE[code];
      if (staleCodes.includes(code) && date === LAST) return null;
      const prevIdx = DAYS.indexOf(date) - 1;
      const prevDate = prevIdx >= 0 ? DAYS[prevIdx] : null;
      const preClose = prevDate && barDates.includes(prevDate) ? BASE_CLOSE[prevDate] ?? close : close;
      return { ts_code: code, trade_date: date, open: preClose, high: Math.max(close, preClose),
        low: Math.min(close, preClose), close, pre_close: preClose, vol: 1e6, amount: 1e5 };
    }).filter(Boolean);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], rows);
    const adjDates = barDates.filter(d => !(staleCodes.includes(code) && d === LAST));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      adjDates.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
    // baseFactor()（data.ts）读的是个股口径 adj_factor 表，不是 fund_adj；ETF qfq 基准同源，否则 A7 返回 null。
    upsertRows(db, 'adj_factor', ['ts_code', 'trade_date', 'adj_factor'],
      adjDates.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
    upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      adjDates.map(trade_date => ({ ts_code: code, trade_date, fd_share: 1e8, fund_type: '股票型', market: 'E' })));
  }
  for (const code of extraStocks) {
    upsertRows(db, 'stock_basic', ['ts_code', 'symbol', 'name', 'list_date', 'list_status'],
      [{ ts_code: code, symbol: code.slice(0, 6), name: `合成${code}`, list_date: '20010101', list_status: 'L' }]);
    upsertRows(db, 'daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      DAYS.map(d => ({ ts_code: code, trade_date: d, open: 10, high: 10, low: 10, close: 10, pre_close: 10, vol: 1, amount: 1 })));
    upsertRows(db, 'sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'],
      DAYS.map(d => ({ dataset: 'suspend_d', key: d, rows: 0, status: 'ok', message: '', synced_at: `${LAST}T00:00:00Z` })));
  }
  // 日报：默认写在目标日；priorDayReport 时写在上一交易日（日期不一致场景）。
  const reportDate = priorDayReport ? PREV : LAST;
  const reportId = `ASA-${reportDate}-${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  const fixture = { ...reportFixture(reportPatch), report_id: reportId, as_of_trade_date: reportDate };
  const reportDir = join(dir, 'reports', reportDate);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${reportId}.json`), JSON.stringify(fixture, null, 2));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(reportId, reportDate, 'READY', '2026-10-16T21:40:00+08:00', `reports/${reportDate}/${reportId}.json`, 'manual');
  db.close();
  return file;
}

/** 场景专用账户库（合成快照，不是真实账户）。参数语义与 golden 一致。 */
function seedAccount(name, opts = {}) {
  const { confirmed = true, completeness = true, unreportedRisk = false, current = true, extraPositions = null, cashCents = 141370,
    baselinePrev = false } = opts;
  const file = join(dir, `portfolio-${name}.sqlite`);
  const db = openPortfolioDb(file, { marketPath: join(dir, `market-${name}.sqlite`) });
  const id = `acc104-${name}`;
  const snapshotId = `synthetic-104-${name}`;
  const positions = (extraPositions ?? HOLDING_CODES.map(code => ({
    ts_code: code, name: `合成${code}`, quantity: HOLDING_QTY[code],
    ref_price_milli: Math.round(BASE_CLOSE[code] * 1000),
    ref_cost_milli: Math.round(BASE_CLOSE[code] * 1000),
    market_value_cents: Math.round((HOLDING_QTY[code] * Math.round(BASE_CLOSE[code] * 1000)) / 10),
  })));
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  const snapshot = {
    snapshot_id: snapshotId, as_of: LAST.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
    source: 'synthetic-test-fixture', note: '合成验收账户（不是真实账户）',
    warnings: ['synthetic_fixture'], is_current: false, positions,
    totals: {
      total_assets_cents: securities + cashCents, securities_mv_cents: securities,
      cash_cents: cashCents, wealth_cents: 0, unrealized_pnl_cents: 0,
    },
  };
  account.importSnapshot(db, snapshot);
  if (baselinePrev) {
    // T+1 用例（10.3-14）：recordOne 拒绝早于基线的事件、重放也排除基线之前的事件，
    // 前一日买入要入账，基线必须早于目标日。基线快照与目标日快照同内容（时点差一天），
    // 目标日快照随后由用例在记录事件后按账本对账更新。
    const prevSnapshot = {
      ...snapshot, snapshot_id: `${snapshotId}-prev`,
      as_of: PREV.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), is_current: false,
    };
    account.importSnapshot(db, prevSnapshot);
    ledger.initBaseline(db, id, { asOf: PREV, snapshotId: prevSnapshot.snapshot_id });
  }
  else {
    ledger.initBaseline(db, id, { asOf: snapshot.as_of.replace(/-/g, ''), snapshotId });
  }
  if (current) account.markSnapshotCurrent(db, snapshotId, { confirmedBy: 'test-fixture' });
  if (confirmed) ledger.confirmRealAccount(db, id, { confirm: true, note: 'synthetic fixture' });
  if (completeness) {
    ledger.setAccountCompleteness(db, id, {
      as_of: snapshot.as_of.replace(/-/g, ''),
      reported_events_through: snapshot.as_of.replace(/-/g, ''),
      unreported_trade_risk: unreportedRisk, note: 'synthetic fixture declaration',
    }, { confirm: true, recordedBy: 'test-fixture' });
  }
  db.close();
  return { file, id, snapshotId };
}

function build(name, opts = {}) {
  const marketFile = opts.marketFile ?? join(dir, `market-${name}.sqlite`);
  const portfolioFile = opts.portfolioFile ?? join(dir, `portfolio-${name}.sqlite`);
  const market = openAshareDb(marketFile);
  const portfolio = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    return buildDailyReport({
      portfolioDb: portfolio, marketDb: market,
      accountId: opts.accountId ?? `acc104-${name}`,
      asOfTradeDate: opts.asOf ?? LAST,
      generatedAt: opts.generatedAt ?? '2026-10-16T21:55:00+08:00',
      ...(opts.scenario ? { researchScenario: opts.scenario } : {}),
      ...(opts.input ?? {}),
    });
  } finally {
    market.close();
    portfolio.close();
  }
}

/** 在独立库上跑一次 buildDecision（同步执行后立即关句柄）。 */
function decide(name, opts = {}) {
  const marketFile = opts.marketFile ?? join(dir, `market-${name}.sqlite`);
  const portfolioFile = opts.portfolioFile ?? join(dir, `portfolio-${name}.sqlite`);
  const accountId = opts.accountId ?? `acc104-${name}`;
  const market = openAshareDb(marketFile);
  const portfolio = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    const snap = opts.snapshot ?? account.readSnapshot(portfolio, opts.snapshotId ?? `synthetic-104-${name}`);
    return buildDecision({
      account_id: accountId,
      snapshot: account.accountSummary(snap),
      as_of_trade_date: opts.asOf ?? LAST,
      market_db: market,
      portfolio_db: portfolio,
      action: opts.action ?? { type: 'NO_ACTION' },
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    });
  } finally {
    market.close();
    portfolio.close();
  }
}

/**
 * 把全局时钟钉到指定时刻（journal 的 recorded_at / received_at 由进程时钟盖章，
 * 不钉则分类随运行日期漂移）。经典继承式 patch：静态成员显式转发，
 * `new Date()` 无参构造与 `Date.now()` 都返回 nowMs，其余走真实 Date。
 */
function atClock(nowMs, fn) {
  const ActualDate = globalThis.Date;
  class PinnedDate extends ActualDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
    static parse(...a) { return ActualDate.parse(...a); }
    static UTC(...a) { return ActualDate.UTC(...a); }
  }
  globalThis.Date = PinnedDate;
  try { return fn(); } finally { globalThis.Date = ActualDate; }
}
const shMs = (ymd, hhmm) => Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hhmm}:00+08:00`);

// ================================================================ 10.1 数据与账户（9 项）

test('10.1-1 盘前、盘中、收盘后、周末和节假日五个会话相位', () => {
  seedMarket('session-phases');
  const marketFile = join(dir, 'market-session-phases.sqlite');
  const db = openAshareDb(marketFile);
  try {
    // 盘前：交易日 14:00 → PRE_CLOSE，最近收盘日 = 前一交易日。
    const pre = resolveResearchDate(db, undefined, new Date('2026-10-16T14:00:00+08:00'));
    assert.equal(pre.phase, 'PRE_CLOSE');
    assert.equal(pre.status, 'READY');
    assert.equal(pre.as_of_trade_date, PREV, '盘前必须用最近收盘日，不得把未收盘日当目标日');
    assert.equal(pre.latest_closed_trade_date, PREV);
    // 盘中/收盘后分界 = 15:00：15:00 起为 AFTER_CLOSE，目标日 = 当日。
    const after = resolveResearchDate(db, undefined, new Date('2026-10-16T15:00:00+08:00'));
    assert.equal(after.phase, 'AFTER_CLOSE');
    assert.equal(after.as_of_trade_date, LAST);
    assert.equal(after.latest_closed_trade_date, LAST);
    // 周末：非交易日相位，目标日仍锚定最近收盘日。
    const weekend = resolveResearchDate(db, undefined, new Date('2026-10-17T10:00:00+08:00'));
    assert.equal(weekend.phase, 'NON_TRADING_DAY');
    assert.equal(weekend.as_of_trade_date, LAST);
    // 节假日（合成 20261019 在日历内但 is_open=0）：工作日假日 = NON_TRADING_DAY，目标日回落最近收盘。
    const holiday = resolveResearchDate(db, undefined, new Date('2026-10-19T14:00:00+08:00'));
    assert.equal(holiday.phase, 'NON_TRADING_DAY');
    assert.equal(holiday.as_of_trade_date, LAST, '假日目标日必须是最近收盘交易日 20261016');
    assert.equal(holiday.latest_closed_trade_date, LAST);
    // 显式请求未收盘交易日 → NOT_READY + session_not_closed（不伪造收盘）。
    const notClosed = resolveResearchDate(db, '20261016', new Date('2026-10-16T14:00:00+08:00'));
    assert.equal(notClosed.status, 'NOT_READY');
    assert.equal(notClosed.reason, 'session_not_closed');
    // 请求非交易日 → requested_date_not_trading_day。
    const reqClosed = resolveResearchDate(db, '20261017', new Date('2026-10-17T10:00:00+08:00'));
    assert.equal(reqClosed.reason, 'requested_date_not_trading_day');
  } finally { db.close(); }
});

test('10.1-2 最新收盘市场数据缺失 → DATA_INSUFFICIENT，不把旧行情当新行情', () => {
  seedMarket('m1-missing', { missingDate: true });
  seedAccount('m1-missing');
  const report = build('m1-missing');
  assert.equal(report.status, 'DATA_INSUFFICIENT');
  assert.equal(report.actionable, false);
  const ready = report.data_quality.quotes.ready;
  for (const code of HOLDING_CODES) assert.ok(!ready.includes(code), `${code} 目标日无行情，不得计入 ready`);
  // 补齐条件必须点名缺失行情（目标交易日 fund_daily 收盘 bar），而不是空泛“等待”。
  const triggers = report.first_section.observation_triggers.join(' | ');
  assert.ok(triggers.includes('fund_daily') && triggers.includes('目标交易日 fund_daily 收盘 bar'),
    triggers);
  assert.ok(report.first_section.no_action_reason.includes('没有可校验的收盘行情'),
    report.first_section.no_action_reason);
  assert.equal(report.data_quality.tiers.etf_price.status, 'NOT_READY');
  assert.equal(report.data_quality.tiers.trade_plan_executability.status, 'NOT_EXECUTABLE');
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
});

test('10.1-3 市场日报与行情日期不一致 → freshness=prior_day、降级为 STALE 并进反证', () => {
  seedMarket('m1-report-mismatch', { priorDayReport: true });
  seedAccount('m1-report-mismatch');
  const report = build('m1-report-mismatch');
  // 日报在 PREV，目标日是 LAST：分层状态 STALE（不是 READY），detail 写明日期。
  const tier = report.data_quality.tiers.market_data;
  assert.equal(tier.status, 'STALE', JSON.stringify(tier));
  assert.equal(tier.as_of, PREV);
  // 日期不一致作为“反证”进入研究证据，而不是被静默当成同日。
  const contradiction = report.market_judgement.counter_evidence.find(e => e.id === 'data_freshness_report');
  assert.ok(contradiction, '日报日期不一致必须出现在反证列表');
  assert.equal(contradiction.as_of, PREV, '反证锚定旧日报的日期，不冒充目标日');
  assert.match(contradiction.statement, new RegExp(PREV), '反证陈述必须写出旧日报日期');
  assert.match(contradiction.source, /ashare_daily_report/, '反证必须可追溯到日报来源');
  assert.equal(report.market_judgement.research_status, 'UNVERIFIED');
});

test('10.1-4 ETF 行情不完整 → PARTIAL + WAIT + 研究窗口不新鲜', () => {
  seedMarket('m1-etf-partial', { staleCodes: ['159278.SZ'] });
  seedAccount('m1-etf-partial');
  const report = build('m1-etf-partial');
  assert.equal(report.data_quality.tiers.etf_price.status, 'PARTIAL');
  assert.ok(report.data_quality.quotes.not_ready.includes('159278.SZ')
    || report.data_quality.quotes.stale.includes('159278.SZ'));
  const stale = report.holdings.find(h => h.ts_code === '159278.SZ');
  assert.equal(stale.stance, 'WAIT');
  assert.equal(stale.research.data.fresh, false, '缺目标日行情的研究窗口必须标记不新鲜');
  assert.equal(stale.latest_bar_date !== LAST, true, '缺失行情不得冒充目标日行情');
  assert.notEqual(report.status, 'ACTIONABLE');
});

test('10.1-5 账户身份已确认但成交完整性未声明 → UNCONFIRMED_RISK + 门控阻塞', () => {
  seedMarket('m1-identity-incomplete');
  // confirmed=true（身份已确认）、completeness=false（未声明完整性）：
  // 档位分层必须区分二者——身份确认不等于成交完整。
  seedAccount('m1-identity-incomplete', { confirmed: true, completeness: false });
  const report = build('m1-identity-incomplete', {
    scenario: { sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100 },
  });
  assert.equal(report.data_quality.tiers.account_identity.status, 'REAL_ACCOUNT_VERIFIED');
  assert.equal(report.data_quality.tiers.account_identity.verified, true);
  assert.equal(report.data_quality.tiers.account_trade_completeness.status, 'UNCONFIRMED_RISK');
  assert.equal(report.gate.satisfied, false);
  assert.ok(report.gate.reasons.some(r => r.code === 'account_completeness_undeclared'),
    JSON.stringify(report.gate.reasons));
  assert.ok(report.gate.unreported_trade_risk === true);
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
});

test('10.1-6 现金、持仓及可卖数量不一致 → 对账差异三字段 + 决策降级', () => {
  seedMarket('m1-reconcile');
  seedAccount('m1-reconcile');
  const marketFile = join(dir, 'market-m1-reconcile.sqlite');
  const portfolioFile = join(dir, 'portfolio-m1-reconcile.sqlite');
  const id = 'acc104-m1-reconcile';
  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    const snap = account.readSnapshot(db, 'synthetic-104-m1-reconcile');
    // 基准 fixture：数量/现金/市值三线一致。
    const clean = ledger.reconcileAccountVsLedger(db, id, snap);
    assert.equal(clean.ok, true, JSON.stringify(clean.mismatches));
    // 制造不一致：对账逐字段比对（数量、现金、证券市值、总资产各自独立检查），
    // 只改数量/现金不会连带出市值与总资产差异（市值用账本数量×快照参考价重算，
    // 快照总资产字段与快照现金字段互不推导）——三个字段都要显式篡改。
    const tampered = {
      ...snap,
      positions: snap.positions.map(p => p.ts_code === '159241.SZ' ? { ...p, quantity: p.quantity + 7 } : p),
      totals: { ...snap.totals,
        cash_cents: snap.totals.cash_cents + 12345,
        securities_mv_cents: snap.totals.securities_mv_cents + 4321,
        total_assets_cents: snap.totals.total_assets_cents + 65430 },
    };
    const bad = ledger.reconcileAccountVsLedger(db, id, tampered);
    assert.equal(bad.ok, false);
    const fields = bad.mismatches.map(m => m.field);
    assert.ok(fields.includes('quantity'), `持仓不一致必须报出：${fields}`);
    assert.ok(fields.includes('cash_cents'), `现金不一致必须报出：${fields}`);
    assert.ok(fields.includes('securities_mv_cents') || fields.includes('total_assets_cents'),
      `市值/总资产不一致必须报出：${fields}`);
    // 决策层（不一致路径，证据级断言）：同日快照与账本对不上 → account_reconciliation_mismatch，
    // 属 DATA_BLOCKING 原因集：状态必须 DATA_INSUFFICIENT，绝不给可执行腿。
    // 用具体交易请求（而非 HOLD）：顶层 reasons 只在 tradeRequested 时并入门控原因，
    // 请求选项自身状态也由 statusOfReasons 重算——HOLD 硬编码 NO_ACTION，走不到 DATA_INSUFFICIENT。
    const tamperedDecide = decide('m1-reconcile', {
      snapshot: tampered,
      action: { type: 'SELL_AND_BUY', sell_code: '516080.SH', sell_shares: 1000, buy_code: '510300.SH', buy_kind: 'ETF' },
    });
    assert.ok(tamperedDecide.reasons.some(r => r.code === 'account_reconciliation_mismatch'),
      JSON.stringify(tamperedDecide.reasons));
    assert.equal(tamperedDecide.status, 'DATA_INSUFFICIENT', JSON.stringify(tamperedDecide.reasons));
    for (const option of tamperedDecide.options) assert.equal(option.executable, false);
    // 日报侧要看到同一批差异：日报的快照经 resolveAccountSnapshot 走账本基线快照
    // （source='ledger_baseline'，不看 is_current），必须篡改基线快照行本身。
    // positions 不能动——重放与对账同源引用基线快照行位，改了两边抵消、差异消失；
    // totals 三列不在重放里（现金基线冻结在 account_baseline.cash_cents），只改 totals 即可。
    // importSnapshot 有签名防篡改（内容不同直接抛错），这里用 SQL 更新本用例自己的临时库行。
    db.prepare(`UPDATE account_snapshot SET cash_cents = cash_cents + 12345,
      securities_mv_cents = securities_mv_cents + 4321, total_assets_cents = total_assets_cents + 65430
      WHERE snapshot_id = ?`).run(tampered.snapshot_id);
  } finally { db.close(); }
  const report = build('m1-reconcile');
  // 同一场景的日报侧：门控给出对账差异原因且不满足，状态不得是 ACTIONABLE。
  assert.ok(report.gate.reasons.some(r => r.code === 'account_reconciliation_mismatch'),
    JSON.stringify(report.gate.reasons));
  assert.equal(report.gate.satisfied, false);
  assert.notEqual(report.status, 'ACTIONABLE');
});

test('10.1-7 历史ETF拆分与复权：拆分事件保持市值、qfq 基准取 asOf 之前', () => {
  seedMarket('m1-split-adj');
  seedAccount('m1-split-adj');
  const marketFile = join(dir, 'market-m1-split-adj.sqlite');
  const portfolioFile = join(dir, 'portfolio-m1-split-adj.sqlite');
  const id = 'acc104-m1-split-adj';
  const market = openAshareDb(marketFile);
  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    // 复权：asOf 之前最后一个正因子做 qfq 基准；模式不同 → 比例不同；NaN 安全。
    const base = baseFactor(market, '159558.SZ', LAST);
    assert.ok(base && base.adj_factor > 0 && base.trade_date <= LAST, JSON.stringify(base));
    assert.equal(adjustmentRatio('hfq', 4, 2), 4);
    assert.equal(adjustmentRatio('qfq', 4, 2), 2);
    assert.equal(adjustmentRatio('none', 4, 2), 1);
    assert.ok(Number.isNaN(adjustmentRatio('qfq', Number.NaN, 2)), '缺因子必须 NaN，不得静默填 1');
    // 拆分事件：基准日之后 1 拆 2，重放数量翻倍、参考价不变 → 市值不变。
    ledger.recordEvent(db, {
      event_id: 'split-104-1', account_id: id, event_type: 'SPLIT', occurred_on: '20261020',
      ts_code: '159558.SZ', ratio_num: 2, ratio_den: 1, source: 'synthetic',
    });
    const before = ledger.replayAccount(db, id, { asOf: LAST });
    const after = ledger.replayAccount(db, id, { asOf: '20261020' });
    const pos = (r) => r.positions.find(p => p.ts_code === '159558.SZ');
    assert.equal(pos(before).quantity, HOLDING_QTY['159558.SZ']);
    assert.equal(pos(after).quantity, HOLDING_QTY['159558.SZ'] * 2, '1 拆 2 后重放数量翻倍');
    // 拆分不创造现金、不凭空加值：现金零变动，事件本身 fee/tax 均为 0。
    assert.equal(after.cash.balance_cents, before.cash.balance_cents, '拆分事件不得改变现金');
    assert.equal(ledger.validateLedger(db, id).ok, true, '拆分事件不得破坏账本不变量');
    // 份额字段不参与持仓估值：估值只看数量 × 参考价（份额仅用于研究窗口，见分层 detail）。
    assert.equal(typeof pos(after).sellable_quantity, 'number');
  } finally { market.close(); db.close(); }
});

test('10.1-8 行情缓存修订：修订后的收盘价立即可见，过期 bar 标 bar_not_latest', () => {
  seedMarket('m1-cache-revise', { staleCodes: ['159278.SZ'] });
  const marketFile = join(dir, 'market-m1-cache-revise.sqlite');
  const market = openAshareDb(marketFile);
  try {
    const before = loadEtfQuote(market, '510300.SH', LAST);
    assert.equal(before.available, true);
    assert.equal(before.price_milli, 4000);
    // 缓存修订：同一目标日的新收盘价覆盖写入后，研究侧立即读到修订值（bar 日期不变）。
    upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
      [{ ts_code: '510300.SH', trade_date: LAST, open: 4.1, high: 4.1, low: 4.1, close: 4.1, pre_close: 4.0, vol: 1e6, amount: 1e5 }]);
    const after = loadEtfQuote(market, '510300.SH', LAST);
    assert.equal(after.available, true);
    assert.equal(after.price_milli, 4100, '缓存修订必须反映到报价');
    assert.equal(after.trade_date, LAST, '修订不改变 bar 的交易日');
    // 过期 bar：目标日无 bar、只有上一交易日 → 明确 bar_not_latest_trade_day，不回落取旧价。
    const stale = loadEtfQuote(market, '159278.SZ', LAST);
    assert.equal(stale.available, false);
    assert.equal(stale.reason, 'bar_not_latest_trade_day', JSON.stringify(stale));
    // 同步日志随修订更新（append-only 同键覆盖：dataset+key 主键）：新版同步时间可见，
    // 研究侧的 quote_updated_at 由 fund_sync_log 推导，缓存修订因此对审计可见。
    upsertRows(market, 'fund_sync_log', ['dataset', 'key', 'rows', 'status', 'message', 'synced_at'],
      [{ dataset: 'fund_daily', key: LAST, rows: Object.keys(BASE_CLOSE).length, status: 'ok',
        message: 'revision: revised close 4.1', synced_at: '2026-10-16T22:30:00+08:00' }]);
    const sync = market.prepare("SELECT status, message, synced_at FROM fund_sync_log WHERE dataset='fund_daily' AND key=?")
      .get(LAST);
    assert.ok(sync, '缓存修订必须留同步日志');
    assert.equal(sync.status, 'ok');
    assert.match(sync.message, /revision/, '修订原因必须写进日志');
  } finally { market.close(); }
});

test('10.1-9 历史快照重放：历史目标日由账本重建降级执行，真实回放另有命令', t => {
  seedMarket('m1-replay');
  seedAccount('m1-replay');
  // (a) 决策日早于账本基线（基线=LAST，请求 PREV）：不回填，报 reconstruction 不可用。
  // 披露位置在 account_status.reasons：顶层 reasons 只在请求交易腿时并入门控原因
  // （decision.js evaluateAccountStatus 后的 tradeRequested 合并），HOLD 请求不交易，
  // 降级原因保留在 account_status 里；顶层 status 取所请求选项的状态，历史日绝不 ACTIONABLE。
  const past = decide('m1-replay', { asOf: PREV, action: { type: 'HOLD' } });
  assert.ok(past.account_status.reasons.some(r => r.code === 'account_reconstruction_unavailable'
    || r.code === 'account_snapshot_mismatch' || r.code === 'account_snapshot_stale'),
  JSON.stringify(past.account_status.reasons));
  assert.notEqual(past.status, 'ACTIONABLE', '历史日不得给出可执行结论');
  // (b) 决策日是周末：非交易日不进可执行计算。
  const weekend = decide('m1-replay', { asOf: '20261017', action: { type: 'HOLD' } });
  assert.ok(weekend.reasons.some(r => r.code === 'as_of_not_trading_day'), JSON.stringify(weekend.reasons));
  assert.equal(weekend.status, 'DATA_INSUFFICIENT');
  // (c) 同日重放基准（合成 fixture 的正例）：状态由账本重建，sellable 与基线一致。
  const sameDay = decide('m1-replay', { asOf: LAST, action: { type: 'HOLD' } });
  assert.equal(sameDay.status, 'NO_ACTION', JSON.stringify(sameDay.reasons));
  assert.equal(sameDay.account_status.state_basis, 'same_day_snapshot');
  // (d) 生产真实快照回放（数据驱动，不在本合成 fixture 内伪造）：
  t.diagnostic('真实回放（需宿主环境变量 ASHARE_DATA_DIR/ASHARE_PORTFOLIO_DB_PATH/ASHARE_VALIDATION_DB_PATH）：'
    + 'node build/ashare/cli.js portfolio-daily-report --account real-main --date 20261023');
});

// ================================================================ 10.2 研究与证据（10 项）

const NOW = new Date('2026-10-16T21:00:00+08:00');
const evBase = {
  evidence_id: 'EV-104-1', claim: '合成主张：半导体设备出口环比改善',
  evidence_type: 'PRIMARY_FILING', evidence_direction: 'SUPPORTS',
  source_quality: 'HIGH', verification_status: 'UNVERIFIED',
  source_url: 'https://example.com/filing/1', publisher: '合成公告源',
  published_at: '2026-10-16T08:00:00+08:00', retrieved_at: '2026-10-16T21:00:00+08:00',
  effective_as_of: LAST, target: '159558.SZ',
};

test('10.2-1 原始公告与二手报道分型登记，不互相冒充', () => {
  assert.ok(evidenceModel, 'ashare/evidenceModel 未构建（待合流绑定）');
  const primary = evidenceModel.registerEvidence(new Map(), evBase, { now: NOW });
  const secondary = evidenceModel.registerEvidence(new Map(), {
    ...evBase, evidence_id: 'EV-104-2', evidence_type: 'SECONDARY_NEWS',
    source_quality: 'MEDIUM', claim: '合成转载：某媒体转述同一事项',
  }, { now: NOW });
  assert.equal(primary.outcome, 'NEW');
  assert.equal(primary.entry.evidence_type, 'PRIMARY_FILING');
  assert.equal(secondary.outcome, 'NEW');
  assert.equal(secondary.entry.evidence_type, 'SECONDARY_NEWS');
  // 类型在清单内，且原始/二手不会因同 claim 被合并成一条（身份键不同）。
  assert.ok(evidenceModel.EVIDENCE_TYPES.includes('PRIMARY_FILING'));
  assert.ok(evidenceModel.EVIDENCE_TYPES.includes('SECONDARY_NEWS'));
  assert.notEqual(primary.entry.content_hash, secondary.entry.content_hash);
});

test('10.2-2 证据发布时间晚于研究截止 → 拒绝登记', () => {
  assert.throws(() => evidenceModel.normalizeEvidence({
    ...evBase, evidence_id: 'EV-104-LATE',
    published_at: '2026-10-17T09:00:00+08:00', // 晚于 retrieved_at
  }, NOW), /published_at must not be later than retrieved_at/);
  // 检索时间也必须可解析：无效时间不允许静默通过。
  assert.throws(() => evidenceModel.normalizeEvidence({
    ...evBase, evidence_id: 'EV-104-BADTIME', retrieved_at: 'not-a-time',
  }, NOW));
});

test('10.2-3 旧新闻重复出现 → UNCHANGED / BACKGROUND，不计新证据', () => {
  const first = evidenceModel.registerEvidence(new Map(), evBase, { now: NOW });
  assert.equal(first.outcome, 'NEW');
  assert.equal(first.counts_as_new_evidence, true);
  const again = evidenceModel.registerEvidence(new Map([[first.entry.evidence_id, first.entry]]), evBase, { now: NOW });
  assert.equal(again.outcome, 'UNCHANGED');
  assert.equal(again.counts_as_new_evidence, false, '重复引用旧闻不得计为新研究证据');
  const background = evidenceModel.registerEvidence(new Map(),
    { ...evBase, evidence_id: 'EV-104-BG', context_novelty: 'BACKGROUND' }, { now: NOW });
  assert.equal(background.outcome, 'NEW');
  assert.equal(background.counts_as_new_evidence, false, '历史背景材料即使首登也不计新证据');
});

test('10.2-4 来源无效或无法核验 → 非法链接拒绝、质量不自动升级', () => {
  assert.throws(() => evidenceModel.normalizeEvidence({
    ...evBase, evidence_id: 'EV-104-BADURL', source_url: 'javascript:alert(1)',
  }, NOW), /http\(s\) URL/);
  // 缺来源质量时默认 UNVERIFIED，绝不静默升为 HIGH/MEDIUM。
  const { record } = evidenceModel.normalizeEvidence({
    ...evBase, evidence_id: 'EV-104-NOQ', source_quality: undefined, source_url: null, publisher: null,
  }, NOW);
  assert.equal(record.source_quality, 'UNVERIFIED');
  assert.equal(record.source_url, null);
  assert.equal(record.publisher, null);
});

test('10.2-5 成分股权重过期 → STALE 标注 + 摘要缺口', () => {
  assert.ok(penetration, 'ashare/etfPenetration 未构建（待合流绑定）');
  const fresh = penetration.weightFreshness('20260930', '20261023');
  assert.equal(fresh.status, 'CURRENT');
  const stale = penetration.weightFreshness('20260131', '20261023');
  assert.equal(stale.status, 'STALE');
  assert.ok(stale.note.includes('过期权重'), stale.note);
  assert.equal(penetration.weightFreshness('20261101', '20261023').status, 'FUTURE_DATED');
  assert.equal(penetration.weightFreshness(null, '20261023').status, 'UNAVAILABLE');
  const rows = [
    { con_code: '688012.SH', weight: 15, name: '合成成分一', industry: '半导体' },
    { con_code: '002371.SZ', weight: 14, name: '合成成分二', industry: '半导体' },
  ];
  const summary = penetration.buildEtfPenetrationSummary({
    as_of: '20261023',
    etf: { ts_code: '159558.SZ', name: '合成半导体ETF', benchmark: '合成半导体指数' },
    weight: { source: 'index_weight', index_code: '931743.CSI', weight_date: '20260131', publication_date: null, rows },
  });
  assert.equal(summary.constituents.freshness.status, 'STALE');
  assert.ok(summary.gaps.some(g => g.code === 'weight_stale'), JSON.stringify(summary.gaps));
});

test('10.2-6 成分股覆盖率不足 → PARTIAL + 证据不足且不给伪精确加权数', () => {
  const rows = [
    { con_code: '688012.SH', weight: 15, name: '合成成分一', industry: '半导体' },
    { con_code: '002371.SZ', weight: 14, name: '合成成分二', industry: '半导体' },
    { con_code: '688072.SH', weight: 8, name: '合成成分三', industry: '半导体' },
  ];
  const fundamentals = Object.fromEntries(rows.map(r => [r.con_code, {
    end_date: '20260630', ann_date: '20260826', netprofit_yoy: 100, or_yoy: 30,
    grossprofit_margin: 40, ocf_to_profit: 90, roe: 10,
  }]));
  const base = {
    as_of: '20261023',
    etf: { ts_code: '159558.SZ', name: '合成半导体ETF', benchmark: '合成半导体指数' },
    benchmark_index_code: '931743.CSI',
    weight: { source: 'index_weight', index_code: '931743.CSI', weight_date: '20260930', publication_date: null, rows },
    fundamentals, valuations: {},
    etfPerformance: { start_date: '20260922', end_date: '20261023', window_sessions: 20, return_pct: 5.5, dividend_adjusted: true, note: null },
    benchmarkPerformance: { return_pct: 3.1, window_sessions: 20, note: null },
  };
  const full = penetration.buildEtfPenetrationSummary(base);
  assert.equal(full.coverage.components.find(c => c.component === 'fundamentals').status, 'COMPLETE');
  delete fundamentals['688072.SH'];
  const partial = penetration.buildEtfPenetrationSummary(base);
  const fin = partial.coverage.components.find(c => c.component === 'fundamentals');
  assert.equal(fin.status, 'PARTIAL');
  assert.equal(fin.covered, 2);
  assert.equal(partial.earnings.evidence_class, 'insufficient_evidence');
  assert.equal(partial.earnings.weighted, null, '覆盖不足不得输出伪精确加权数');
  assert.ok(partial.gaps.some(g => g.code === 'fundamentals_coverage'));
});

test('10.2-7 缺少盈利预测 → forecasts 证据不足 + 显式缺口', () => {
  const rows = [
    { con_code: '688012.SH', weight: 15, name: '合成成分一', industry: '半导体' },
    { con_code: '002371.SZ', weight: 14, name: '合成成分二', industry: '半导体' },
  ];
  const summary = penetration.buildEtfPenetrationSummary({
    as_of: '20261023',
    etf: { ts_code: '159558.SZ', name: '合成半导体ETF', benchmark: '合成半导体指数' },
    benchmark_index_code: '931743.CSI',
    weight: { source: 'index_weight', index_code: '931743.CSI', weight_date: '20260930', publication_date: null, rows },
    fundamentals: {
      '688012.SH': { end_date: '20260630', ann_date: '20260826', netprofit_yoy: 10, or_yoy: 5, grossprofit_margin: 30, ocf_to_profit: 80, roe: 8 },
      '002371.SZ': { end_date: '20260630', ann_date: '20260826', netprofit_yoy: -5, or_yoy: -2, grossprofit_margin: 25, ocf_to_profit: 70, roe: 6 },
    },
    forecasts: {},
  });
  const fc = summary.coverage.components.find(c => c.component === 'forecasts');
  assert.equal(fc.status, 'MISSING');
  assert.equal(summary.forecasts.evidence_class, 'insufficient_evidence');
  assert.ok(summary.gaps.some(g => g.code === 'forecasts_coverage'), JSON.stringify(summary.gaps));
});

test('10.2-8 研究判断与证据冲突 → 日期不一致进反证且判断不升级', () => {
  seedMarket('m2-conflict', { priorDayReport: true });
  seedAccount('m2-conflict');
  const market = openAshareDb(join(dir, 'market-m2-conflict.sqlite'));
  const portfolio = openPortfolioDb(join(dir, 'portfolio-m2-conflict.sqlite'), { marketPath: join(dir, 'market-m2-conflict.sqlite') });
  let summary;
  try {
    summary = buildResearchSummary({
      portfolioDb: portfolio, marketDb: market, accountId: 'acc104-m2-conflict', asOfTradeDate: LAST,
    });
  } finally { market.close(); portfolio.close(); }
  // 上一日日报 vs 目标日：新鲜度证据方向为 contradiction，与任何“市场正常”的判断并存时必须可见。
  const freshness = summary.market_evidence.contradiction.find(e => e.id === 'data_freshness_report');
  assert.ok(freshness, JSON.stringify(summary.market_evidence));
  // 冲突不改变研究状态：判断仍是 UNVERIFIED（不因证据冲突被“坐实”或删除）。
  assert.equal(summary.market_evidence.research_status, 'UNVERIFIED');
  assert.equal(summary.market_evidence.forward_validation_required, true);
  // 方向阈值是显式政策文本：不把固定阈值当“已确认”。
  assert.match(summary.market_evidence.threshold_policy, /前瞻检验|不把任何固定阈值/);
});

test('10.2-9 无新增研究证据 → 状态不升级、每条证据都带来源与日期', () => {
  seedMarket('m2-no-new');
  seedAccount('m2-no-new');
  const report = build('m2-no-new');
  assert.equal(report.market_judgement.research_status, 'UNVERIFIED');
  for (const item of [...report.market_judgement.counter_evidence, ...report.market_judgement.support_evidence]) {
    assert.ok(item.source, `${item.id} 缺 source`);
    if (item.as_of) assert.ok(String(item.as_of) <= LAST, `${item.id} 日期 ${item.as_of} 不得晚于目标交易日`);
  }
  // 注册层：无新增 = 重复登记返回 UNCHANGED（同 10.2-3 的机制，这里从“报告结论”角度收口）。
  const one = evidenceModel.registerEvidence(new Map(), evBase, { now: NOW });
  const two = evidenceModel.registerEvidence(new Map([[one.entry.evidence_id, one.entry]]), evBase, { now: NOW });
  assert.equal(two.counts_as_new_evidence, false);
});

test('10.2-10 正反证同时存在 → 两向并列且均不升级为事实', () => {
  seedMarket('m2-both', {
    reportPatch: { rebound: true, upRatio: 0.60, medianPct: 0.8, amountYi: 14000, amountMa20: 11000, indexRet5: 5.2, indexRet20: -1.0 },
  });
  seedAccount('m2-both');
  const report = build('m2-both');
  const ev = report.market_judgement;
  // 广度方向抬升（up_ratio 0.6、量能 14000/12000>1、5 日转正）→ 支持面有货。
  assert.ok(ev.support_evidence.length > 0, JSON.stringify(ev.support_evidence));
  // 20 日收益仍为负 + 20 日站上均线比例低（18% ≤30% 阈值）→ 反证不因此消失。
  assert.ok(ev.counter_evidence.length > 0, JSON.stringify(ev.counter_evidence));
  // 两向并存时不升级为已确认事实。
  assert.equal(ev.research_status, 'UNVERIFIED', '正反证并存不得升级为已验证结论');
  assert.equal(ev.fact_meta.claim_status, 'UNVERIFIED');
});

// ================================================================ 10.3 决策与费用（15 项）

const SCENARIO_FULL = { sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100 };

test('10.3-1..5 五方案（HOLD/REDUCE/ROTATE/DEFENSIVE/NO_ACTION）齐备且语义各归其位', () => {
  seedMarket('m3-five');
  seedAccount('m3-five');
  const report = build('m3-five', { scenario: SCENARIO_FULL });
  const by = Object.fromEntries(report.decision_comparison.options.map(o => [o.action, o]));
  assert.deepEqual(Object.keys(by).sort(), ['DEFENSIVE', 'HOLD', 'NO_ACTION', 'REDUCE', 'ROTATE']);
  // HOLD：无交易。
  assert.equal(by.HOLD.funding_status, 'NO_TRADE');
  assert.equal(by.HOLD.sell_plan, null);
  assert.equal(by.HOLD.rotation_plan, null);
  // REDUCE：显式研究数量可完成资金测算，但不是执行授权。
  assert.equal(by.REDUCE.funding_status, 'FUNDED');
  assert.equal(by.REDUCE.sell_plan.quantity, 1000);
  assert.equal(by.REDUCE.executable, false);
  // ROTATE：双边测算成立时给出轮动计划，优势仍是 UNVERIFIED。
  assert.equal(by.ROTATE.funding_status, 'FUNDED');
  assert.equal(by.ROTATE.rotation_plan.quantity, 100);
  assert.equal(by.ROTATE.rotation_plan.advantage_status, 'UNVERIFIED');
  // DEFENSIVE：权益清零压力对照，数量基础必须是压力对照而非交易计划。
  assert.equal(by.DEFENSIVE.funding_status, 'FUNDED');
  assert.equal(by.DEFENSIVE.quantity_basis, 'equity_liquidation_stress_only');
  // NO_ACTION：明确不操作。
  assert.equal(by.NO_ACTION.funding_status, 'NO_TRADE');
  // 决策依据分布：轮动=主动、减仓/防守=风险控制、持有/不操作=无交易。
  assert.deepEqual(['HOLD', 'REDUCE', 'ROTATE', 'DEFENSIVE', 'NO_ACTION'].map(a => by[a].decision_basis),
    ['NO_TRADE', 'RISK_CONTROL', 'ACTIVE_ROTATION', 'RISK_CONTROL', 'NO_TRADE']);
  // 未给研究数量时：REDUCE/ROTATE 不得凭空生成计划。
  const noQty = build('m3-five');
  const noBy = Object.fromEntries(noQty.decision_comparison.options.map(o => [o.action, o]));
  assert.equal(noBy.REDUCE.sell_plan, null);
  assert.equal(noBy.REDUCE.quantity_basis, 'not_provided');
  assert.equal(noBy.ROTATE.rotation_plan, null);
  assert.equal(noQty.status, 'NO_ACTION', JSON.stringify(noQty.reasons ?? noQty.status));
  for (const option of noQty.decision_comparison.options) assert.equal(option.executable, false);
});

test('10.3-6 风险约束触发与未触发都披露，且不产生自动卖量', () => {
  seedMarket('m3-risk');
  seedAccount('m3-risk');
  const portfolioFile = join(dir, 'portfolio-m3-risk.sqlite');
  const marketFile = join(dir, 'market-m3-risk.sqlite');
  const id = 'acc104-m3-risk';
  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    recordRiskPolicy(db, { account_id: id, approval_source: 'test-fixture', approved_on: LAST });
    // 未触发：回撤 3%（低于 L1 阈值 10%）→ 有政策、无预警。
    const quiet = buildPortfolioRiskState({
      portfolioDb: db, marketDb: null, accountId: id, asOf: LAST,
      drawdown: {
        status: 'AVAILABLE', reason: null, basis: 'verified_cashflow_adjusted_account_nav',
        current_drawdown_bps: 300, current_drawdown_pct: 3,
        peak_nav: 1, peak_date: PREV, current_nav: 0.97, current_date: LAST,
        max_drawdown_pct: 3, valuation_quality: 'exact', points_used: 2,
        scope: 'OBSERVATION_WINDOW_SINCE_BASELINE', full_history: false,
        window: { start: PREV, end: LAST }, max_drawdown_scope: 'OBSERVATION_WINDOW', excluded_bases: [],
      },
    });
    assert.ok(quiet, '政策生效必须可加载');
    assert.equal(quiet.warning.triggered, false, JSON.stringify(quiet.warning));
    // 触发：回撤 20% → L3 预警，但只触发复核。
    const triggered = buildPortfolioRiskState({
      portfolioDb: db, marketDb: null, accountId: id, asOf: LAST,
      drawdown: {
        status: 'AVAILABLE', reason: null, basis: 'verified_cashflow_adjusted_account_nav',
        current_drawdown_bps: 2000, current_drawdown_pct: 20,
        peak_nav: 1, peak_date: PREV, current_nav: 0.8, current_date: LAST,
        max_drawdown_pct: 20, valuation_quality: 'exact', points_used: 2,
        scope: 'OBSERVATION_WINDOW_SINCE_BASELINE', full_history: false,
        window: { start: PREV, end: LAST }, max_drawdown_scope: 'OBSERVATION_WINDOW', excluded_bases: [],
      },
    });
    assert.equal(triggered.warning.triggered, true);
    assert.equal(triggered.warning.level, 'L3');
    assert.equal(triggered.action_boundary.sell_quantity, null);
    assert.equal(triggered.action_boundary.auto_trade, false);
    assert.doesNotMatch(JSON.stringify(triggered), /"(sell_)?quantity":\s*[1-9]/);
    // 批准日之后才生效：历史目标日看不到政策。
    assert.equal(buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId: id, asOf: PREV }), null);
  } finally { db.close(); }
  // 日报侧随报告披露（触发态由 golden G12 用注入回撤复核；此处验证政策块出现）。
  const report = build('m3-risk');
  assert.ok(report.portfolio_risk, '政策生效时日报必须带 portfolio_risk 块');
});

test('10.3-7 Alpha 优势未验证 → 只落在 Alpha 轨，不阻塞风险轨', () => {
  seedMarket('m3-alpha');
  seedAccount('m3-alpha');
  const report = build('m3-alpha', { scenario: SCENARIO_FULL });
  const rotate = report.decision_comparison.options.find(o => o.action === 'ROTATE');
  assert.equal(rotate.rotation_plan.advantage_status, 'UNVERIFIED');
  assert.equal(rotate.alpha_track.status, 'NOT_SUPPLIED', JSON.stringify(rotate.alpha_track));
  assert.equal(rotate.alpha_track.reason, 'no_demonstrated_advantage');
  // 优势未验证落在轮动轨（rotation_plan.advantage_status + alpha_track），不混进风险轨。
  assert.ok(rotate.summary.length > 0);
  // §5.1：风险轨 blocked_by 只含账户/权限/费用/行情门控，绝不混入 Alpha 证据原因。
  for (const option of report.decision_comparison.options) {
    assert.equal(option.risk_track.blocked_by_alpha, false);
    assert.ok(!option.risk_track.blocked_by.some(c => /advantage|alpha|evidence|rotation/i.test(c)),
      `${option.action} 风险轨混入了 Alpha 原因：${JSON.stringify(option.risk_track.blocked_by)}`);
  }
  // 决策层同语义：无优势证据时 rotation reason 存在，但状态只降为 ILLUSTRATIVE/NO_ACTION。
  const d = decide('m3-alpha', {
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 1000, buy_code: '510300.SH', buy_kind: 'ETF' },
  });
  assert.ok(d.reasons.some(r => r.code === 'rotation_advantage_unverified' || r.code === 'no_demonstrated_advantage'),
    JSON.stringify(d.reasons));
  assert.notEqual(d.status, 'ACTIONABLE');
  assert.equal(d.decision_tracks.risk_track.blocked_by_alpha, false);
});

test('10.3-8 账户可卖数量未知 → SELLABILITY_UNKNOWN，绝不假设全部可卖', () => {
  seedMarket('m3-sellable');
  seedAccount('m3-sellable');
  const portfolioFile = join(dir, 'portfolio-m3-sellable.sqlite');
  // 账本基线缺失 → account_gate_unavailable → 可卖数量未提供 → 资金测算拒绝假设。
  const db = openPortfolioDb(portfolioFile, { marketPath: join(dir, 'market-m3-sellable.sqlite') });
  try {
    db.prepare('DELETE FROM account_baseline WHERE account_id=?').run('acc104-m3-sellable');
  } finally { db.close(); }
  const report = build('m3-sellable', { scenario: { sellCode: '159558.SZ', sellQuantity: 1000 } });
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  assert.equal(reduce.funding_status, 'SELLABILITY_UNKNOWN');
  assert.equal(reduce.sell_plan, null, '可卖数量未知时不得生成卖出计划');
  assert.match(reduce.summary, /账本未提供可卖数量/, reduce.summary);
  const defensive = report.decision_comparison.options.find(o => o.action === 'DEFENSIVE');
  assert.equal(defensive.funding_status, 'SELLABILITY_UNKNOWN');
  assert.ok(reduce.not_actionable_because.some(x => x.includes('可卖')));
  // 门控同时披露基线缺失。
  assert.ok(report.gate.reasons.some(r => r.code === 'account_gate_unavailable'),
    JSON.stringify(report.gate.reasons));
});

test('10.3-9 价格与交易日期失效 → PRICE_UNAVAILABLE / 非交易日拒绝', () => {
  seedMarket('m3-price-invalid', { staleCodes: ['159278.SZ'] });
  seedAccount('m3-price-invalid');
  // (a) 卖出标的缺目标日行情 → 价格失效，不出资金测算。
  const report = build('m3-price-invalid', { scenario: { sellCode: '159278.SZ', sellQuantity: 1000 } });
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  assert.equal(reduce.funding_status, 'PRICE_UNAVAILABLE');
  assert.equal(reduce.sell_plan, null);
  // (b) 防守对照同样拒绝失效价格。
  const defensive = report.decision_comparison.options.find(o => o.action === 'DEFENSIVE');
  assert.ok(['PRICE_UNAVAILABLE', 'SELLABILITY_UNKNOWN', 'NOT_SELLABLE'].includes(defensive.funding_status),
    defensive.funding_status);
  // (c) 决策层：目标日非交易日 → as_of_not_trading_day，不给可执行状态。
  const d = decide('m3-price-invalid', { asOf: '20261017', action: { type: 'HOLD' } });
  assert.ok(d.reasons.some(r => r.code === 'as_of_not_trading_day'), JSON.stringify(d.reasons));
  assert.equal(d.status, 'DATA_INSUFFICIENT');
});

test('10.3-10 真实费用与估算滑点分离，滑点不得标 CONFIRMED', () => {
  const { calculateFees, validateFeeProfile, saveFeeProfile, resolveFeeRules } = feesMod;
  const defaultRules = rules.DEFAULT_FEE_RULES;
  const gross = 100000; // 1000 元
  const breakdown = calculateFees(gross, 'sell', defaultRules);
  assert.equal(typeof breakdown.slippage_estimate_cents, 'number');
  assert.equal(typeof breakdown.actual_fee_estimate_cents, 'number');
  assert.equal(breakdown.total_cents,
    breakdown.actual_fee_estimate_cents + breakdown.slippage_estimate_cents,
    '总费用 = 实际费用估计 + 滑点估计，二者必须分列');
  assert.equal(breakdown.actual_fee_estimate_cents,
    breakdown.commission_cents + breakdown.transfer_fee_cents + breakdown.stamp_duty_cents);
  // 滑点永远是估算：CONFIRMED 级滑点被拒（fixture 必须先过 code/classification 校验）。
  assert.throws(() => validateFeeProfile({
    id: 'slip-confirmed', code: '159558.SZ', classification: 'NORMAL_ETF', effective_from: LAST,
    values: { slippage_rate_per_side: 0.001 },
    evidence: { slippage_rate_per_side: { level: 'CONFIRMED', source: 'broker' } },
  }), /Slippage is an estimate/);
  // 真实费用可以 CONFIRMED（佣金按成交回报校准）。
  const portfolioFile = join(dir, 'portfolio-m3-fees.sqlite');
  const marketFile = join(dir, 'market-m3-fees.sqlite');
  seedMarket('m3-fees');
  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    const { created, profile } = saveFeeProfile(db, 'acc104-m3-fees', {
      id: 'confirmed-comm', code: '159558.SZ', effective_from: LAST,
      values: { commission_rate: 0.0001, commission_min_cents: 0 },
      evidence: {
        commission_rate: { level: 'CONFIRMED', source: 'broker-fill-calibration' },
        commission_min_cents: { level: 'CONFIRMED', source: 'broker-fill-calibration' },
      },
    });
    assert.equal(created, true);
    const applied = resolveFeeRules({ db, accountId: 'acc104-m3-fees', asOf: LAST, code: '159558.SZ', kind: 'ETF' });
    assert.equal(applied.commission_rate, 0.0001, 'CONFIRMED 佣金必须生效');
    const fees = calculateFees(gross, 'sell', applied);
    assert.equal(fees.fee_model.evidence.commission_rate.level, 'CONFIRMED');
    assert.ok(fees.assumed === true || fees.fee_model.evidence.slippage_rate_per_side.level !== 'CONFIRMED',
      '滑点证据级别不得为 CONFIRMED');
  } finally { db.close(); }
});

test('10.3-11 SUPER_ETF 仅适用于明确确认的产品', () => {
  const { validateFeeProfile, feeRulesFor } = feesMod;
  // 6 开头的股票代码不得声明为 SUPER_ETF（非 ETF 产品）。
  assert.throws(() => validateFeeProfile({
    id: 'super-on-stock', code: '600519.SH', classification: 'SUPER_ETF', effective_from: LAST,
    values: { commission_rate: 0.00005 }, evidence: { commission_rate: { level: 'ASSUMED', source: 'observed' } },
  }), /SUPER_ETF code must identify an ETF/);
  // 未标记的普通 ETF 不得享受折扣档：折扣只作用于显式标记的代码。
  const mark = validateFeeProfile({
    id: 'super-marked', code: '159558.SZ', classification: 'SUPER_ETF', effective_from: LAST,
    values: { commission_rate: 0.00005, commission_min_cents: 0 },
    evidence: {
      commission_rate: { level: 'ASSUMED', source: 'observed discount tier on marked code' },
      commission_min_cents: { level: 'ASSUMED', source: 'observed fills on marked code' },
    },
  });
  assert.equal(mark.classification, 'SUPER_ETF');
  const context = { accountId: 'acc104-fee', asOf: LAST, profiles: [mark] };
  const marked = feeRulesFor(context, '159558.SZ', 'ETF');
  const unmarked = feeRulesFor(context, '516080.SH', 'ETF');
  assert.equal(marked.commission_rate, 0.00005, '标记代码享受折扣档');
  assert.equal(unmarked.commission_rate, rules.DEFAULT_FEE_RULES.commission_rate,
    '未标记 ETF 不得享受 SUPER_ETF 折扣');
  assert.equal(unmarked.commission_min_cents, rules.DEFAULT_FEE_RULES.commission_min_cents);
});

test('10.3-12 权限外个股不得进入可交易候选', () => {
  const { tradabilityOf } = rules;
  // 板块权限矩阵：ETF 放行；科创/创业/北交受限；身份未知 fail closed。
  assert.equal(tradabilityOf('159558.SZ', { kind: 'ETF' }).tradable, true);
  for (const code of ['688001.SH', '300750.SZ', '830799.BJ']) {
    const t = tradabilityOf(code, { kind: 'STOCK' });
    assert.equal(t.tradable, false, `${code} 必须受限`);
    assert.equal(t.reason, 'permission_restricted');
  }
  assert.equal(tradabilityOf('600519.SH', { kind: 'STOCK' }).tradable, true, '主板个股放行');
  const unknown = tradabilityOf('688001.SH', { kind: 'UNKNOWN' });
  assert.equal(unknown.tradable, false, '身份未知必须 fail closed');
  assert.equal(unknown.reason, 'instrument_unknown');
  // 决策层：把科创板个股放进轮动买入腿 → permission_restricted 硬阻塞，状态 NO_ACTION。
  seedMarket('m3-perm', { extraStocks: ['688001.SH'] });
  seedAccount('m3-perm');
  const d = decide('m3-perm', {
    action: { type: 'SELL_AND_BUY', sell_code: '159558.SZ', sell_shares: 1000, buy_code: '688001.SH', buy_kind: 'STOCK' },
  });
  assert.ok(d.reasons.some(r => r.code === 'permission_restricted'), JSON.stringify(d.reasons));
  assert.equal(d.status, 'NO_ACTION', JSON.stringify(d.reasons));
  const rotate = d.options.find(o => o.action === 'SELL_AND_BUY');
  assert.equal(rotate.executable, false, '权限受限的轮动腿不得可执行');
});

test('10.3-13 未确认风险规则不得自动执行', () => {
  seedMarket('m3-unconfirmed');
  seedAccount('m3-unconfirmed', { confirmed: true, completeness: true, unreportedRisk: true });
  const report = build('m3-unconfirmed', {
    scenario: { sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100 },
  });
  // 未上报交易风险（用户保留）→ 即使身份已确认、行情齐备，也不给执行腿。
  assert.equal(report.gate.unreported_trade_risk, true);
  assert.equal(report.gate.satisfied, false, JSON.stringify(report.gate.reasons));
  assert.ok(report.gate.reasons.some(r => r.code === 'unreported_trade_risk'), JSON.stringify(report.gate.reasons));
  assert.equal(report.data_quality.tiers.account_trade_completeness.status, 'UNCONFIRMED_RISK');
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  for (const leg of report.first_section.actions.flatMap(a => a.legs)) assert.equal(leg.executable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
  // 研究数量保留为研究参数（FUNDED 测算允许），但绝不升级为可执行。
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  assert.equal(reduce.executable, false);
  assert.equal(reduce.sell_plan.quantity, 1000);
});

test('10.3-14 T+1 可卖数量：当日买入不可卖、前一日买入在目标日已释放', () => {
  seedMarket('m3-t1');
  seedAccount('m3-t1', { baselinePrev: true });
  const portfolioFile = join(dir, 'portfolio-m3-t1.sqlite');
  const marketFile = join(dir, 'market-m3-t1.sqlite');
  const id = 'acc104-m3-t1';
  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    // 前一交易日买入 1000 份（目标日应已释放）+ 当日买入 500 份（目标日不可卖）。
    ledger.recordEvent(db, {
      event_id: 'buy-prev-104', account_id: id, event_type: 'TRADE_BUY', occurred_on: PREV,
      ts_code: '159558.SZ', quantity: 1000, price_milli: 935, fee_cents: 0, tax_cents: 0, source: 'synthetic',
    });
    ledger.recordEvent(db, {
      event_id: 'buy-today-104', account_id: id, event_type: 'TRADE_BUY', occurred_on: LAST,
      ts_code: '159558.SZ', quantity: 500, price_milli: 935, fee_cents: 0, tax_cents: 0, source: 'synthetic',
    });
    const replay = ledger.replayAccount(db, id, { asOf: LAST });
    const pos = replay.positions.find(p => p.ts_code === '159558.SZ');
    assert.equal(pos.quantity, HOLDING_QTY['159558.SZ'] + 1500, '重放数量含两笔买入');
    assert.equal(pos.sellable_quantity, HOLDING_QTY['159558.SZ'] + 1000, 'T+1：当日 500 份不可卖，前一日 1000 份已释放');
    assert.equal(pos.settlement_rule, 'T+1', '权益 ETF 按 T+1');
    // 录入事件会翻出"未上报交易风险"（recordOne 的保守默认）；两笔都已入账后按 r2-a4
    // 先例重新声明已核对到目标日，否则门控停在 UNCONFIRMED_RISK 与本用例主题无关。
    ledger.setAccountCompleteness(db, id, {
      as_of: LAST, reported_events_through: LAST, unreported_trade_risk: false, note: 'synthetic fixture declaration',
    }, { confirm: true, recordedBy: 'test-fixture' });
    // 目标日快照必须与账本一致（r2-a4 同款）：日报 holdings 取快照数量，
    // 卖量 == 快照数量才走到 NOT_SELLABLE 分支，否则先被 INVALID_QUANTITY 拦下。
    // importSnapshot 拒绝覆盖既有快照行 → 以对账后的快照 id 落库并切换为当前。
    const lastSnap = account.readSnapshot(db, 'synthetic-104-m3-t1');
    const buyCostCents = account.valueCents(1000, 935) + account.valueCents(500, 935);
    const positions = lastSnap.positions.map(p => p.ts_code === '159558.SZ'
      ? { ...p, quantity: p.quantity + 1500, market_value_cents: account.valueCents(p.quantity + 1500, p.ref_price_milli) }
      : p);
    const securitiesCents = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
    const cashCents = lastSnap.totals.cash_cents - buyCostCents;
    const wealthCents = lastSnap.totals.wealth_cents ?? 0;
    const reconciledId = 'synthetic-104-m3-t1-reconciled';
    account.importSnapshot(db, {
      ...lastSnap, snapshot_id: reconciledId, is_current: false, positions,
      totals: {
        ...lastSnap.totals, cash_cents: cashCents, securities_mv_cents: securitiesCents,
        total_assets_cents: securitiesCents + cashCents + wealthCents,
      },
    });
    account.markSnapshotCurrent(db, reconciledId, { confirmedBy: 'test-fixture' });
  } finally { db.close(); }
  // 研究卖量超过可卖 → NOT_SELLABLE，不生成计划。
  const report = build('m3-t1', { scenario: { sellCode: '159558.SZ', sellQuantity: HOLDING_QTY['159558.SZ'] + 1500 } });
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  assert.equal(reduce.funding_status, 'NOT_SELLABLE', JSON.stringify(reduce.summary));
  assert.equal(reduce.sell_plan, null);
  // sellable 映射如实披露数量与可卖数量的差。
  const entry = report.decision_comparison.sellable['159558.SZ'];
  assert.ok(entry, JSON.stringify(report.decision_comparison.sellable));
  assert.ok(entry.sellable_quantity < entry.quantity, '当日买入必须拉低可卖数量');
});

test('10.3-15 决策请求方案与门控：HOLD 请求在有效交易日上无硬阻塞', () => {
  seedMarket('m3-hold');
  seedAccount('m3-hold');
  const d = decide('m3-hold', { action: { type: 'HOLD' } });
  assert.equal(d.requested_action, 'HOLD');
  assert.equal(d.as_of_trade_date, LAST);
  // 同日已确认 fixture：无硬门控原因（不触发任何 NOT_EXECUTABLE 类硬编码）。
  const hard = ['permission_restricted', 'insufficient_sellable_position', 'lot_rule',
    'insufficient_position', 'instrument_not_tradable', 'instrument_suspended'];
  assert.ok(!d.reasons.some(r => hard.includes(r.code)), JSON.stringify(d.reasons));
  assert.equal(d.status, 'NO_ACTION', JSON.stringify(d.reasons));
  assert.equal(d.options.find(o => o.action === 'HOLD').status, 'NO_ACTION');
  assert.ok(d.decision_tracks.alpha_track.status === 'NOT_APPLICABLE' || d.decision_tracks.alpha_track.status === 'UNVERIFIED'
    || d.decision_tracks.alpha_track.status === 'NOT_SUPPLIED', d.decision_tracks.alpha_track.status);
});

// ================================================================ 10.4 历史研究（9 项）

// D9 = 20261022（TRUE_FORWARD_START）。VPS/ChatGPT 时钟钉在 D9 当天，分类不随运行日期漂移。
const D9 = '20261022';
const D9_MS = shMs(D9, '18:00');

function journalFixture(name) {
  const file = join(dir, `portfolio-journal-${name}.sqlite`);
  const db = openPortfolioDb(file);
  return { db, file, id: `acc104-journal-${name}` };
}

test('10.4-1 VPS前瞻记录：冻结日当天写入 → TRUE_FORWARD', () => {
  const { db, id } = journalFixture('vps');
  try {
    const result = atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-1', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    assert.equal(result.created, true);
    assert.ok(result.record.record_id.startsWith('VPS-BUNDLE-104-1-'));
    const record = researchJournal.readResearchJournal(db, result.record.record_id);
    assert.equal(record.source, 'vps');
    assert.equal(forwardReview.classifyRecord(record), 'TRUE_FORWARD');
  } finally { db.close(); }
});

test('10.4-2 ChatGPT前瞻记录：同日写回 → 幂等且 TRUE_FORWARD', () => {
  const { db, id } = journalFixture('gpt-fwd');
  try {
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-2', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    const args = {
      report_id: 'BUNDLE-104-2', as_of_trade_date: D9, idempotency_key: 'k-104-fwd',
      independent_judgement: '合成判断：本期无新增可执行线索。',
      final_conclusion: '合成结论：维持观察。',
      additional_evidence: [{ claim: '合成公告：产线检修完成', kind: 'industry', source_url: 'https://example.com/a/1', published_at: '2026-10-22T09:00:00+08:00' }],
      counter_evidence: [{ claim: '合成反证：出口数据走弱', kind: 'macro', source_url: 'https://example.com/b/1', published_at: '2026-10-21T09:00:00+08:00' }],
    };
    const first = atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, args, D9_MS));
    assert.equal(first.created, true);
    const record = researchJournal.readResearchJournal(db, first.record_id);
    assert.equal(record.source, 'chatgpt');
    assert.equal(forwardReview.classifyRecord(record), 'TRUE_FORWARD');
    assert.equal(first.evidence_class, 'TRUE_FORWARD');
  } finally { db.close(); }
});

test('10.4-3 ChatGPT补录：事后补写保留记录但不计入前瞻', () => {
  const { db, id } = journalFixture('gpt-late');
  try {
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-3', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    const args = {
      report_id: 'BUNDLE-104-3', as_of_trade_date: D9, idempotency_key: 'k-104-late',
      independent_judgement: '合成补录判断。',
      final_conclusion: '合成补录结论。',
    };
    // 次日（20261023 09:00）才补录：记录有效（created），但分类是 RETROSPECTIVE。
    const nextDayMs = shMs('20261023', '09:00');
    const late = atClock(nextDayMs, () => chatgptIntake.appendChatgptResearchRecord(db, id, args, nextDayMs));
    assert.equal(late.created, true);
    const record = researchJournal.readResearchJournal(db, late.record_id);
    assert.equal(forwardReview.classifyRecord(record), 'RETROSPECTIVE_RECORD', '事后补录不得冒充前瞻');
    assert.equal(late.evidence_class, 'RETROSPECTIVE_RECORD');
  } finally { db.close(); }
});

test('10.4-4 重复幂等键：同键同内容幂等，同键异内容冲突', () => {
  const { db, id } = journalFixture('gpt-idem');
  try {
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-4', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    const base = {
      report_id: 'BUNDLE-104-4', as_of_trade_date: D9, idempotency_key: 'k-104-idem',
      independent_judgement: '合成判断（幂等测试）。', final_conclusion: '合成结论（幂等测试）。',
    };
    const first = atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, base, D9_MS));
    const again = atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, base, D9_MS));
    assert.equal(first.created, true);
    assert.equal(again.created, false, '同键同内容必须幂等返回 created:false');
    assert.equal(again.record_id, first.record_id);
    assert.throws(
      () => atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, { ...base, final_conclusion: '内容被篡改' }, D9_MS)),
      /journal_id_conflict/,
      '同键不同内容必须拒绝，而不是覆盖',
    );
    // 未关联的 report_id 拒绝（不伪造关联）。
    assert.throws(
      () => atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, { ...base, idempotency_key: 'k-other', report_id: 'BUNDLE-NOPE' }, D9_MS)),
      /bundle_not_found|bundle_identity_mismatch|trade_date_mismatch|account_mismatch/,
    );
  } finally { db.close(); }
});

test('10.4-5 更正记录：新键追加 correction_of，原记录不可变', () => {
  const { db, id } = journalFixture('gpt-correction');
  try {
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-5', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    const body = {
      report_id: 'BUNDLE-104-5', as_of_trade_date: D9, idempotency_key: 'k-104-orig',
      independent_judgement: '合成判断（原文）。', final_conclusion: '合成结论（原文）。',
    };
    const original = atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, body, D9_MS));
    const fixed = atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, {
      ...body, idempotency_key: 'k-104-fixed', corrects_record_id: original.record_id,
      final_conclusion: '合成结论（更正后）。',
    }, D9_MS));
    assert.equal(fixed.created, true);
    assert.notEqual(fixed.record_id, original.record_id, '更正必须是新记录，不覆盖原文');
    const correction = researchJournal.readResearchJournal(db, fixed.record_id);
    assert.equal(correction.correction_of, original.record_id);
    const kept = researchJournal.readResearchJournal(db, original.record_id);
    // 期望值必须与提交原文逐字一致（含句号）：原文未被更正改动，这里比的是不可变性。
    assert.equal(kept.judgement.final_conclusion, '合成结论（原文）。', '原记录不可变');
    // 更正目标不存在或非本账户 ChatGPT 记录 → 拒绝。
    assert.throws(
      () => atClock(D9_MS, () => chatgptIntake.appendChatgptResearchRecord(db, id, {
        ...body, idempotency_key: 'k-104-badfix', corrects_record_id: 'CHATGPT-NOT-EXIST',
      }, D9_MS)),
      /corrects_record_id/,
    );
  } finally { db.close(); }
});

test('10.4-6 评价窗口未成熟 → PENDING，不产出改进结论', () => {
  seedMarket('m4-pending');
  seedAccount('m4-pending');
  const { db, id } = journalFixture('pending');
  const marketFile = join(dir, 'market-m4-pending.sqlite');
  try {
    // 记录在 D9（日历里 D9 之后的开市日不足 5 天：20261020 之后无数据）。
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-6', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
      observations: [{ ts_code: '159558.SZ', quantity: 100, direction: 'long' }],
    }));
    const evaluations = researchJournal.evaluateResearchJournal({
      portfolioDb: db, marketDb: null, accountId: id, asOf: '20261023', horizons: [5],
    });
    assert.ok(evaluations.length > 0);
    for (const e of evaluations) {
      assert.ok(['PENDING', 'UNAVAILABLE'].includes(e.status), JSON.stringify(e));
      if (e.status === 'PENDING') {
        assert.ok(['observation_window_not_mature', 'future_calendar_insufficient'].includes(e.reason), e.reason);
      }
    }
    const market = openAshareDb(marketFile);
    try {
      const review = forwardReview.buildForwardReview({ portfolioDb: db, marketDb: market, accountId: id, asOf: '20261023', horizons: [5] });
      assert.ok(['NO_MATURED_FORWARD_SAMPLE', 'INSUFFICIENT_FORWARD_SAMPLE'].includes(review.conclusion), review.conclusion);
      assert.match(review.statement, /不能说明研究有任何改进|不作改进结论/, review.statement);
      assert.equal(review.min_non_overlapping_windows, forwardReview.MIN_NON_OVERLAPPING_WINDOWS);
    } finally { market.close(); }
  } finally { db.close(); }
});

test('10.4-7 样本外策略评估：纸面观察不冒充成交，成熟样本不足不下结论', () => {
  seedMarket('m4-oos');
  seedAccount('m4-oos');
  const { db, id } = journalFixture('oos');
  const marketFile = join(dir, 'market-m4-oos.sqlite');
  try {
    atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-7', as_of_trade_date: D9, status: 'READY', generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
      // 100000 份 ≈ 9,350 元：初始预算须买得起基准 510300.SH 一手，否则观察全部 UNAVAILABLE。
      observations: [{ ts_code: '159558.SZ', quantity: 100000, direction: 'long' }],
    }));
    const market = openAshareDb(marketFile);
    try {
      // 日历铺 20261021..20270131：D9=20261022 自身必须是开市日（startOpen 检查）；
      // 门槛注入的 12 个窗口按 as_of 每 +7 天排到 20270107、成熟日 20270114（工作日 +5），
      // 日历与行情必须覆盖到最后一个成熟日，否则基准窗口 UNAVAILABLE、超额为 null。
      const calRows = [];
      const barDates = ['20261020'];   // 基线锚点窗口（20261016→20261022）经过 20261020
      const calEndMs = Date.parse('2027-01-31T00:00:00Z');
      for (let t = Date.parse('2026-10-21T00:00:00Z'); t <= calEndMs; t += 86400000) {
        const ymd = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
        const wd = new Date(t).getUTCDay();
        const open = wd !== 0 && wd !== 6;
        calRows.push({ cal_date: ymd, is_open: open ? 1 : 0, pretrade_date: null });
        if (open) barDates.push(ymd);
      }
      upsertRows(market, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], calRows);
      // 行情铺到成熟窗口：观察标的/沪深300 基准与初始五只基线在全部窗口区间内有 bar；
      // 多资产篮子三只新成分只给收盘 bar（loadSeries 无因子时按 raw close 计，不伪造因子）。
      const barOf = new Set([...HOLDING_CODES, '510300.SH']);
      const flat = code => BASE_CLOSE[code] ?? 1.0;
      const newBarDates = barDates.filter(d => !DAYS.includes(d));
      for (const code of barOf) {
        upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
          newBarDates.map(trade_date => ({ ts_code: code, trade_date, open: flat(code), high: flat(code), low: flat(code),
            close: flat(code), pre_close: flat(code), vol: 1e6, amount: 1e5 })));
        upsertRows(market, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
          newBarDates.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
      }
      for (const code of ['511010.SH', '518880.SH', '513100.SH']) {
        upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
          [{ ts_code: code, name: `合成${code}`, fund_type: '债券型', invest_type: '被动指数型', benchmark: '合成指数', status: 'L', market: 'E' }]);
        upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
          newBarDates.map(trade_date => ({ ts_code: code, trade_date, open: 1.0, high: 1.0, low: 1.0, close: 1.0, pre_close: 1.0, vol: 1e6, amount: 1e5 })));
      }
      // 费率识别：journalFeeEstimator 按元数据判品种（etfIdentity 要求名称/类型含 ETF 词样），
      // 合成名"合成159558.SZ"不匹配 → kind=null → estimator 返回 null → 观察全部
      // fee_rules_unavailable。只在本用例的市场库补 ETF 身份，不动其它用例的合成名。
      upsertRows(market, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'],
        [{ ts_code: '159558.SZ', name: '合成159558ETF', fund_type: '股票型', invest_type: '被动指数型',
          benchmark: '合成指数', status: 'L', market: 'E' }]);
      // 真实成熟窗口（20261022→20261029）必须有正超额：IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT
      // 要求各基准超额均值全 > 0，全平价下 excess≈0 会翻结论。观察标的窗口收盘上行，
      // 基准 510300 保持平价；记录 1..11 是注入的合成窗口，不受行情影响。
      upsertRows(market, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
        ['20261023', '20261026', '20261027', '20261028', '20261029'].map(trade_date =>
          ({ ts_code: '159558.SZ', trade_date, open: 1.0, high: 1.0, low: 1.0, close: 1.0, pre_close: 0.935, vol: 1e6, amount: 1e5 })));
      const feeEstimator = researchJournal.journalFeeEstimator(db, market, id);
      // 真实成熟窗口：EVALUATED 级观察（实际写入的评价，不是手工注入）。
      // 数量 100000 份 ≈ 9,350 元本金，初始预算须 ≥ 基准 510300.SH 一手（400 元），
      // 否则 benchmark_budget_below_one_lot 会让观察全部 UNAVAILABLE。
      const matured = researchJournal.evaluateResearchJournal({
        portfolioDb: db, marketDb: market, accountId: id, asOf: '20261030', horizons: [5], feeEstimator,
      });
      assert.ok(matured.length > 0);
      for (const e of matured) {
        assert.ok(['EVALUATED', 'UNAVAILABLE'].includes(e.status), JSON.stringify(e));
        for (const obs of e.observations) {
          assert.equal(obs.actual_trade, false, '纸面观察不得冒充实际成交');
          assert.equal(obs.execution_backtest, false, '观察不是回测执行');
          assert.equal(obs.realized_pnl_cents, null, '纸面观察没有已实现盈亏');
          if (obs.status === 'EVALUATED') {
            assert.equal(typeof obs.invested_cents, 'number');
            assert.equal(typeof obs.net_return_pct, 'number');
            assert.equal(typeof obs.excess_return_pct, 'number');
          }
        }
      }
      const evaled = matured.find(e => e.status === 'EVALUATED' && e.observations.some(o => o.status === 'EVALUATED'));
      assert.ok(evaled, `至少一条观察必须 EVALUATED：${JSON.stringify(matured.map(e => ({
        s: e.status, r: e.reason,
        obs: e.observations.map(o => ({ s: o.status, r: o.reason, code: o.ts_code })),
      })))}`);
      // 真实样本只有 1 条记录 → 独立窗口 < 12 → 只有“样本不足”，不下改进/无改进结论。
      const review = forwardReview.buildForwardReview({
        portfolioDb: db, marketDb: market, accountId: id, asOf: '20261030', horizons: [5],
        evaluations: matured,
      });
      assert.equal(review.conclusion, 'INSUFFICIENT_FORWARD_SAMPLE', JSON.stringify(review.by_source));
      assert.notEqual(review.conclusion, 'NO_IMPROVEMENT_DEMONSTRATED');
      assert.ok(review.limitations.some(l => /显著性|相关/.test(l)), JSON.stringify(review.limitations));
      // 门槛注入：再写 11 条真实日志记录，as_of 按自然日 +7 错开（20261029..20270107），
      // 成熟日 = as_of 后第 5 个工作日 = +7 自然日（合成日历只有周末休市）→ 窗口互不重叠，
      // 且独立窗口按 as_of 排序后逐个保留。步长不能用工作日序列：weekdays 索引 +7 是
      // 7 个工作日 ≈ 9-11 自然日，末条 as_of 会被推到 2027-02、越过日历与行情尾 20270131，
      // 该条不进评价、窗口掉到 11 < 12。评价数组是入参，允许在其上合成注入的成熟窗口，
      // 但 record_id 必须指向真实存在的记录（byId 查不到会崩溃）。
      const calAdd = (ymd, days) => new Date(Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`)
        + days * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      const forInjection = new Map();
      for (let i = 1; i < forwardReview.MIN_NON_OVERLAPPING_WINDOWS; i++) {
        const asOfI = calAdd('20261022', i * 7);
        const matI = weekdays(asOfI, 6)[5];
        const r = atClock(shMs(asOfI, '18:00'), () => researchRecord.recordVpsResearchSnapshot({
          portfolioDb: db, accountId: id,
          bundle: { report_id: `BUNDLE-104-7-INJ-${i}`, as_of_trade_date: asOfI, status: 'READY', generated_at: `${asOfI.slice(0, 4)}-${asOfI.slice(4, 6)}-${asOfI.slice(6, 8)}T18:00:00+08:00` },
          observations: [{ ts_code: '159558.SZ', quantity: 100000, direction: 'long' }],
        }));
        forInjection.set(r.record.record_id, matI);
      }
      // 写入后重新评价（matured 是写入前的快照，不含这 11 条），再在其上注入成熟窗口。
      const reevaluated = researchJournal.evaluateResearchJournal({
        portfolioDb: db, marketDb: market, accountId: id, asOf: '20270131', horizons: [5], feeEstimator,
      });
      const injected = reevaluated.map(e => {
        const mat = forInjection.get(e.record_id);
        if (mat === undefined) return e;
        return {
          ...e, status: 'EVALUATED', reason: null, maturity_date: mat,
          observations: e.observations.map(o => ({ ...o, status: 'EVALUATED', reason: null,
            invested_cents: 9350, fees_cents: 10, net_return_pct: 1.5, excess_return_pct: 0.8, max_drawdown_pct: -0.5 })),
        };
      });
      const gated = forwardReview.buildForwardReview({
        portfolioDb: db, marketDb: market, accountId: id, asOf: '20270131', horizons: [5],
        evaluations: injected,
      });
      assert.equal(gated.conclusion, 'IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT',
        `12 个成熟独立窗口全部为正也只能"观察到改进但不显著"：${gated.conclusion} ${JSON.stringify(gated.by_source)}`);
      const source = Object.keys(gated.by_source)[0];
      const hz = gated.by_source[source]?.['5'];
      assert.ok(hz, JSON.stringify(gated.by_source));
      assert.ok(hz.non_overlapping_windows >= forwardReview.MIN_NON_OVERLAPPING_WINDOWS, JSON.stringify(hz));
      assert.notEqual(gated.conclusion, 'NO_MATURED_FORWARD_SAMPLE', '注入后已有成熟样本');
      assert.match(gated.statement, /不构成前瞻有效性的证据|不作改进结论/, gated.statement);
    } finally { market.close(); }
  } finally { db.close(); }
});

test('10.4-8 历史数据泄漏：冻结日前记录与倒填生成时间都不进前瞻统计', () => {
  seedMarket('m4-leak');
  const { db, id } = journalFixture('leak');
  try {
    // (a) 冻结日（20261022）之前的记录：数据已被观察过 → PRE_FORWARD_HISTORICAL。
    const preMs = shMs('20261015', '18:00');
    const pre = atClock(preMs, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-PRE', as_of_trade_date: '20261015', status: 'READY', generated_at: '2026-10-15T18:00:00+08:00' },
    }));
    const preRecord = researchJournal.readResearchJournal(db, pre.record.record_id);
    assert.equal(forwardReview.classifyRecord(preRecord), 'PRE_FORWARD_HISTORICAL');
    // (b) 倒填生成时间：generated_at 晚于 as_of（伪装成“当天写入”）→ RETROSPECTIVE_RECORD。
    const spoof = atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: id,
      bundle: { report_id: 'BUNDLE-104-SPOOF', as_of_trade_date: D9, status: 'READY', generated_at: '2026-10-23T08:00:00+08:00' },
    }));
    const spoofRecord = researchJournal.readResearchJournal(db, spoof.record.record_id);
    assert.equal(forwardReview.classifyRecord(spoofRecord), 'RETROSPECTIVE_RECORD', '生成时间晚于研究日不得算前瞻');
    // (c) 分类汇总：非前瞻记录进 pre_forward_excluded，不参与任何前瞻统计。
    const market = openAshareDb(join(dir, 'market-m4-leak.sqlite'));
    try {
      const review = forwardReview.buildForwardReview({ portfolioDb: db, marketDb: market, accountId: id, asOf: '20261023', horizons: [5] });
      assert.ok(review.records.by_class.PRE_FORWARD_HISTORICAL >= 1, JSON.stringify(review.records));
      assert.ok(review.pre_forward_excluded.some(r => r.record_id === pre.record.record_id));
      assert.ok(review.pre_forward_excluded.some(r => r.record_id === spoof.record.record_id),
        '倒填记录必须出现在排除清单');
      assert.match(review.forward_rule, /已被观察过|只计数/, review.forward_rule);
    } finally { market.close(); }
  } finally { db.close(); }
});

test('10.4-9 基准版本变化：版本显式、可复现，历史规则不按结果调整', () => {
  seedMarket('m4-bench');
  const marketFile = join(dir, 'market-m4-bench.sqlite');
  const market = openAshareDb(marketFile);
  try {
    const a = benchmarks.buildBenchmarkComparison({ marketDb: market, start: '20261005', end: LAST });
    const b = benchmarks.buildBenchmarkComparison({ marketDb: market, start: '20261005', end: LAST });
    assert.equal(typeof a.definition_version, 'string');
    assert.ok(a.definition_version.length > 0);
    assert.equal(a.definition_version, b.definition_version, '同窗口同版本必须可复现');
    assert.deepEqual(a.benchmarks.map(x => x.id), b.benchmarks.map(x => x.id));
    // 窗口完整性：start > end 拒绝；日期格式非法拒绝。
    assert.throws(() => benchmarks.buildBenchmarkComparison({ marketDb: market, start: LAST, end: '20261001' }), /晚于/);
    assert.throws(() => benchmarks.buildBenchmarkComparison({ marketDb: market, start: '2026-10-01' }), /YYYYMMDD/);
    // 历史评价声明：基准与规则不按结果回改。
    const { db, id } = journalFixture('bench-note');
    try {
      const review = forwardReview.buildForwardReview({ portfolioDb: db, marketDb: market, accountId: id, asOf: '20261023', horizons: [5] });
      assert.ok(review.limitations.some(l => l.includes('历史规则、基准定义与版本不会按结果调整')),
        JSON.stringify(review.limitations));
      assert.ok(review.benchmarks.note.includes('基准'), '基准口径必须带说明');
    } finally { db.close(); }
  } finally { market.close(); }
});

// ================================================================ §11.2 数据迁移与兼容（交付要求）

test('11.2-1 旧库无新表：入口零失败、写路径幂等懒迁移、升级前研究日志逐字节不变', () => {
  // 升级首日的旧库形态：openPortfolioDb 只有核心表；research_evidence / research_thesis
  // 是本分支新增表（写路径 CREATE TABLE IF NOT EXISTS 懒建），升级前尚不存在。
  // 本用例在任务书入口对象上断言：bundle / 评价入口对缺表零失败，且迁移不触碰不可变日志。
  seedMarket('mig');
  const acc = seedAccount('mig');
  const marketFile = join(dir, 'market-mig.sqlite');
  const market = openAshareDb(marketFile);
  const db = openPortfolioDb(acc.file, { marketPath: marketFile });
  const exists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  try {
    assert.equal(exists('research_evidence'), false, '旧库不应预先存在 research_evidence');
    assert.equal(exists('research_thesis'), false, '旧库不应预先存在 research_thesis');

    // 升级前就有的一条历史研究日志（research_journal 同为写路径懒建），作为不可变基准。
    const journal = atClock(D9_MS, () => researchRecord.recordVpsResearchSnapshot({
      portfolioDb: db, accountId: acc.id,
      bundle: { report_id: 'BUNDLE-112-1', as_of_trade_date: D9, status: 'READY',
        generated_at: `${D9.slice(0, 4)}-${D9.slice(4, 6)}-${D9.slice(6, 8)}T18:00:00+08:00` },
    }));
    assert.equal(journal.created, true);
    const journalBefore = JSON.stringify(db.prepare('SELECT * FROM research_journal ORDER BY record_id').all());
    assert.ok(journalBefore.length > 0, '不可变基准需要既有日志行');

    const runBundle = () => researchBundle.buildInvestmentResearchBundle({
      portfolioDb: db, marketDb: market, accountId: acc.id,
      asOfTradeDate: LAST, now: new Date('2026-10-16T21:55:00+08:00'),
    });

    // 1) 旧库入口零失败：证据表缺失 → 空登记（sqlite_master 守卫提前返回），
    //    不抛 no such table，也不登记成 evidence_model 缺口——缺表是升级前的合法状态。
    const before = runBundle();
    assert.deepEqual(before.evidence_register.entries, []);
    assert.equal((before.evidence_gaps ?? []).filter(g => g.module === 'evidence_model').length, 0,
      '缺表不是数据质量缺陷，不应进 gaps');

    // 2) 评价入口：thesis 表缺失 → 空列表 + 结构化结果，不崩溃。
    assert.deepEqual(researchEval.listResearchThesis(db, { accountId: acc.id }), []);
    const evalBefore = researchEval.buildResearchEval({
      portfolioDb: db, marketDb: market, accountId: acc.id, asOf: '20261023', horizon: 5,
      feeEstimator: () => ({ total_cents: 10, estimated: true, version: 'synthetic-v1' }),
    });
    assert.ok(evalBefore && evalBefore.records, '评价入口在缺表时仍返回结构化结果');
    assert.doesNotMatch(JSON.stringify(evalBefore), /no such table/);

    // 3) 写路径懒迁移：首次写证据即建表；ensureEvidenceSchema 重复调用幂等。
    evidenceStore.recordResearchEvidence(db, {
      evidence_id: 'EV-112-1', kind: 'ROTATION', buy_code: '510300.SH', sell_code: '159558.SZ',
      strategy_id: 'goal1026-migration', as_of: LAST, valid_until: null, status: 'VERIFIED',
      recorded_by: 'migration-test', note: '§11.2 迁移用例', recorded_at: '2026-10-16T12:00:00.000Z',
    }, { confirm: true });
    assert.equal(exists('research_evidence'), true, '首次写入应懒建证据表');
    evidenceStore.ensureEvidenceSchema(db);
    evidenceStore.ensureEvidenceSchema(db); // 幂等：重复建表不抛错、不产生重复数据

    const afterEvidence = runBundle();
    assert.equal(afterEvidence.evidence_register.entries.length, 1,
      '迁移后既有证据行应经 fromResearchEvidenceProvenance 进入统一登记');
    assert.equal(afterEvidence.evidence_register.entries[0].claim, 'EV-112-1');
    assert.equal((afterEvidence.evidence_gaps ?? []).filter(g => g.module === 'evidence_model').length, 0);

    // 4) 判断单元同理懒建；同键同内容幂等，父记录分类由服务端推导。
    const thesisArgs = {
      parent_record_id: journal.record.record_id, target: '159558.SZ', direction: 'neutral',
      horizon: 'swing', baseline_assessment: '迁移验证：不形成方向性判断。', thesis_id: 'THESIS-112-1',
    };
    const t1 = researchEval.appendResearchThesis(db, acc.id, thesisArgs, D9_MS + 60000);
    assert.equal(t1.created, true);
    assert.equal(exists('research_thesis'), true, '首次追加判断应懒建判断表');
    assert.equal(t1.parent_evidence_class, 'TRUE_FORWARD');
    const t2 = researchEval.appendResearchThesis(db, acc.id, thesisArgs, D9_MS + 120000);
    assert.equal(t2.created, false, '同键同内容幂等（迁移不产生第二行）');

    // 5) 升级前研究日志逐字节不变：以上全部迁移/写入不触碰不可变日志。
    const journalAfter = JSON.stringify(db.prepare('SELECT * FROM research_journal ORDER BY record_id').all());
    assert.equal(journalAfter, journalBefore, 'schema 迁移与新表写入不得改动既有研究日志');
  } finally {
    db.close();
    market.close();
  }
});
