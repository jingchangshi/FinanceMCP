import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// goal-1026 §10.5 用户日报 Golden Tests（十场景）。
//
// 只用合成 fixture：临时市场缓存 + 临时账户库 + 合成市场日报。不读网络、不写
// 生产库。每个场景独立建库，用例之间互不污染，可单独用 --test-name-pattern 运行。
//
// 双层结构（任务书 §8.3）：renderDailyReport(result, {now}) 一次性产出
// { user（A–H 中文 markdown）, technical（技术附件 markdown，内嵌 JSON 块）}；
// 用户版渲染内已执行 assertUserReportClean，本文件再独立复核一遍禁词（不依赖
// 渲染层自检），并对附件做数值交叉核对与可追溯断言。
//
// 九条重点断言（任务书 10.5）的落点：
//   正文不泄露工程术语 → 每个 render 场景 assertNoBannedTerms(user)
//   旧行情不写成新行情 → G3 / G6
//   推断不写成事实     → G7 / G8 / G10
//   旧闻不冒充催化剂   → G7（evidenceModel 重复登记 = UNCHANGED，不计新证据）
//   不遗漏关键反证     → G1 / G8 / G9
//   不生成未授权交易数量 → G1 / G4 / G9 / G10
//   附件与正文数值一致 → 每个 render 场景 assertNumbersConsistent
//   重要数字可追溯     → 每个 render 场景 untraceable() === 0
//   NO_ACTION 不忽略风险约束 → G4 / G9 / G12
//
// 运行方式（由主控在统一测试窗口执行；编写期间不得构建）：
//   node --test --test-concurrency=1 test/report-golden.test.mjs

const root = process.env.FINANCE_TEST_BUILD ?? new URL('../build/', import.meta.url).pathname;
const load = name => import(pathToFileURL(join(root, name)));
/** 尚未合流/构建的模块：返回 null，调用方按“待合流绑定”处理。 */
async function maybe(name) {
  try { return await load(name); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const renderer = await maybe('portfolio/reportRenderer.js');
const scenarios = await maybe('portfolio/scenarios.js');
const evidenceModel = await maybe('ashare/evidenceModel.js');

const dir = mkdtempSync(join(tmpdir(), 'report-golden-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market-default.sqlite');
process.env.ASHARE_PORTFOLIO_DB_PATH = join(dir, 'portfolio-default.sqlite');
delete process.env.ASHARE_PORTFOLIO_ENABLED;

const { openAshareDb, upsertRows } = await load('ashare/db.js');
const { openPortfolioDb } = await load('portfolio/db.js');
const account = await import(pathToFileURL(join(root, 'portfolio/account.js')));
const ledger = await load('portfolio/ledger.js');
const { buildDailyReport } = await load('portfolio/dailyReport.js');
const { buildInvestmentResearchBundle } = await load('portfolio/researchBundle.js');
const { recordRiskPolicy, buildPortfolioRiskState } = await load('portfolio/riskPolicy.js');
const { weekdays, seedMarket: seedStockMarket } = await import('./ashare-fixture.mjs');

// ---------------------------------------------------------------- 时间与行情基线

const DAYS = weekdays('20261005', 10);   // 20261005..20261016（跳过周末）
const LAST = DAYS.at(-1);                 // 20261016（星期五，收盘目标日）
const PREV = DAYS.at(-2);                 // 20261015

/** 五只持仓 + 宽基参照的基准收盘价（合成；结构对齐 PRD §3，数值不是真实账户）。 */
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

// ---------------------------------------------------------------- 市场日报 fixture

/**
 * 合成市场日报（写入 reports/<date>/ 与 report 表，供 researchSummary 读取）。
 * tone 固定 negative、up_ratio 恒 <= 0.60：本 fixture 不制造“普涨 + 门控全绿”的
 * 局面，避免与“未授权不得给出交易腿”的断言相互矛盾。
 */
function reportFixture({
  judgment = ['合成测试日报：结构与口径检查，不构成投资建议'],
  upRatio = 0.30, medianPct = -0.40, amountYi = 9000, amountMa20 = 12000,
  indexRet5 = -1.20, indexRet20 = -4.00, crash = false, rebound = false,
} = {}) {
  return {
    report_id: null, // 写入时按场景填
    schema: 'ashare-report-1.0.0',
    as_of_trade_date: LAST,
    generated_at: '2026-10-16T21:40:00+08:00',
    status: 'READY',
    run_mode: 'manual',
    market: {
      regime: 'range',
      regime_label: crash ? '下跌' : '震荡',
      tone: 'negative',
      judgement: judgment,
      indices: [
        { ts_code: '000300.SH', name: '沪深300', close: 4020.11,
          pct_chg: crash ? -9.9 : rebound ? 5.5 : -0.08,
          ret5: indexRet5, ret20: indexRet20, amount_yi: amountYi,
          above_ma20: false, above_ma60: false },
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
    disclaimer: '合成测试日报，不是投资建议。',
  };
}

/**
 * 建一个场景专用市场库。
 * @param opts.staleCodes    目标日缺行情的持仓代码（ETF 行情不完整）
 * @param opts.missingDate   整个目标日都没有基金行情（行情未就绪）
 * @param opts.reportPatch   reportFixture 覆盖参数
 * @param opts.fundRowsPatch (code, date, close) => close（逐日改价：暴跌/反弹）
 */
function seedMarket(name, opts = {}) {
  const { staleCodes = [], missingDate = false, reportPatch = {}, fundRowsPatch = null } = opts;
  const file = join(dir, `market-${name}.sqlite`);
  const db = openAshareDb(file);
  // 股票侧全量合成数据（daily/adj_factor/daily_basic/stk_limit/核心指数/日历），
  // 满足 checkQuality 的 READY 判定；基金侧按场景缺省。
  seedStockMarket(db, DAYS);
  // 补周末与下一交易日（周末报告与 expected_next_trade_date 场景需要）。
  upsertRows(db, 'trade_cal', ['cal_date', 'is_open', 'pretrade_date'], [
    { cal_date: '20261017', is_open: 0, pretrade_date: LAST },
    { cal_date: '20261018', is_open: 0, pretrade_date: LAST },
    { cal_date: '20261020', is_open: 1, pretrade_date: LAST },
  ]);
  upsertRows(db, 'fund_basic', ['ts_code', 'name', 'fund_type', 'invest_type', 'benchmark', 'status', 'market'], BASIC);
  for (const code of Object.keys(BASE_CLOSE)) {
    const barDates = missingDate ? DAYS.filter(d => d !== LAST) : DAYS;
    const apply = d => (fundRowsPatch ? fundRowsPatch(code, d, BASE_CLOSE[code]) : BASE_CLOSE[code]);
    const rows = barDates.map(date => {
      const close = apply(date);
      const prevIdx = DAYS.indexOf(date) - 1;
      const prevDate = prevIdx >= 0 ? DAYS[prevIdx] : null;
      const preClose = prevDate && barDates.includes(prevDate) ? apply(prevDate) : close;
      if (staleCodes.includes(code) && date === LAST) return null;
      return {
        ts_code: code, trade_date: date,
        open: preClose, high: Math.max(close, preClose), low: Math.min(close, preClose),
        close, pre_close: preClose, vol: 1e6, amount: 1e5,
      };
    }).filter(Boolean);
    upsertRows(db, 'fund_daily', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'], rows);
    const adjDates = barDates.filter(d => !(staleCodes.includes(code) && d === LAST));
    upsertRows(db, 'fund_adj', ['ts_code', 'trade_date', 'adj_factor'],
      adjDates.map(trade_date => ({ ts_code: code, trade_date, adj_factor: 2 })));
    upsertRows(db, 'fund_share', ['ts_code', 'trade_date', 'fd_share', 'fund_type', 'market'],
      adjDates.map(trade_date => ({ ts_code: code, trade_date, fd_share: 1e8, fund_type: '股票型', market: 'E' })));
  }
  // 场景专属市场日报（report_id 与文件路径互不覆盖）。
  const reportId = `ASR-${LAST}-${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  const fixture = { ...reportFixture(reportPatch), report_id: reportId };
  const reportDir = join(dir, 'reports', LAST);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${reportId}.json`), JSON.stringify(fixture, null, 2));
  db.prepare('INSERT OR REPLACE INTO report (report_id, trade_date, status, generated_at, path, run_mode) VALUES (?,?,?,?,?,?)')
    .run(reportId, LAST, 'READY', '2026-10-16T21:40:00+08:00', `reports/${LAST}/${reportId}.json`, 'manual');
  db.close();
  return file;
}

// ---------------------------------------------------------------- 账户 fixture

/**
 * 场景专用账户库（合成快照，不是真实账户）。
 * @param opts.confirmed      是否 confirmRealAccount（身份核验）
 * @param opts.completeness   是否声明完整性（false = 从未声明 → 未上报交易风险）
 * @param opts.unreportedRisk 声明里是否保留“存在未上报交易风险”
 * @param opts.current        是否 markSnapshotCurrent（同日执行路径的前提）
 */
function seedAccount(name, opts = {}) {
  const { confirmed = true, completeness = true, unreportedRisk = false, current = true } = opts;
  const file = join(dir, `portfolio-${name}.sqlite`);
  const db = openPortfolioDb(file, { marketPath: join(dir, `market-${name}.sqlite`) });
  const id = `golden-${name}`;
  const snapshotId = `synthetic-golden-${name}`;
  const positions = HOLDING_CODES.map(code => ({
    ts_code: code, name: `合成${code}`, quantity: HOLDING_QTY[code],
    ref_price_milli: Math.round(BASE_CLOSE[code] * 1000),
    ref_cost_milli: Math.round(BASE_CLOSE[code] * 1000),
    market_value_cents: Math.round((HOLDING_QTY[code] * Math.round(BASE_CLOSE[code] * 1000)) / 10),
  }));
  const securities = positions.reduce((sum, p) => sum + p.market_value_cents, 0);
  const snapshot = {
    snapshot_id: snapshotId, as_of: LAST.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
    source: 'synthetic-test-fixture', note: '合成测试账户（不是真实账户）',
    warnings: ['synthetic_fixture'], is_current: false, positions,
    totals: {
      total_assets_cents: securities + 141370, securities_mv_cents: securities,
      cash_cents: 141370, wealth_cents: 0, unrealized_pnl_cents: 0,
    },
  };
  account.importSnapshot(db, snapshot);
  // 快照日期与基线日期必须一致（initBaseline 校验）。
  ledger.initBaseline(db, id, { asOf: snapshot.as_of.replace(/-/g, ''), snapshotId });
  // 同日快照路径（evaluateAccountStatus 的 same_day + is_current 前提）。
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
      accountId: opts.accountId ?? `golden-${name}`,
      asOfTradeDate: opts.asOf ?? LAST,
      generatedAt: '2026-10-16T21:55:00+08:00',
      ...(opts.scenario ? { researchScenario: opts.scenario } : {}),
      ...(opts.input ?? {}),
    });
  } finally {
    market.close();
    portfolio.close();
  }
}

function bundle(name, opts = {}) {
  const marketFile = opts.marketFile ?? join(dir, `market-${name}.sqlite`);
  const portfolioFile = opts.portfolioFile ?? join(dir, `portfolio-${name}.sqlite`);
  const market = openAshareDb(marketFile);
  const portfolio = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    return buildInvestmentResearchBundle({
      portfolioDb: portfolio, marketDb: market,
      accountId: opts.accountId ?? `golden-${name}`,
      ...(opts.asOf !== undefined ? { asOfTradeDate: opts.asOf } : {}),
      now: opts.now ?? new Date('2026-10-16T21:56:00+08:00'),
    });
  } finally {
    market.close();
    portfolio.close();
  }
}

// ---------------------------------------------------------------- 渲染与断言工具

/** 从技术附件 markdown 解析 ```json 块，得到附件的结构化数值集合。 */
function jsonBlocksOf(technical) {
  const blocks = [];
  for (const match of technical.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    try { blocks.push(JSON.parse(match[1])); } catch { /* 非 JSON 块跳过 */ }
  }
  return blocks;
}

/**
 * 调用 renderDailyReport 把同一份事实渲染成（正文, 技术附件）。
 * 契约：renderDailyReport(result, bundleOrOptions) → { user, technical }。
 * 第二参是兼容探测口：RenderOptions 形状（含 now）被当作选项；bundle 结果被安全
 * 忽略或用于附件绑定（主控合流决策）。renderer 缺位时返回 null，调用方跳过渲染断言。
 */
function render(report, opts = {}) {
  if (!renderer) return null;
  const fn = renderer.renderDailyReport ?? renderer.render ?? renderer.default;
  if (typeof fn !== 'function') return null;
  const out = fn(report, { now: opts.now ?? '2026-10-16T21:58:00+08:00', bundle: opts.bundle ?? null });
  const user = out?.user ?? out?.body ?? out?.user_markdown ?? null;
  assert.equal(typeof user, 'string', 'renderDailyReport 必须返回用户版正文字符串');
  assert.ok(user.length > 0, '用户版正文不得为空');
  const technical = out?.technical ?? out?.attachment ?? null;
  assert.equal(typeof technical, 'string', 'renderDailyReport 必须返回技术附件');
  const blocks = jsonBlocksOf(technical);
  assert.ok(blocks.length > 0, '技术附件必须内嵌 JSON 块（供数值核对）');
  const attachment = out?.attachment ?? blocks;
  return { user, technical, attachment, attachmentText: JSON.stringify(attachment) };
}

/** 任务书 8.1 禁词全表（只许出现在技术附件，不许出现在用户版正文）。 */
const BANNED = [
  ['DEGRADED', /DEGRADED/],
  ['UNVERIFIED', /UNVERIFIED/],
  ['NOT_EXECUTABLE', /NOT_EXECUTABLE/],
  ['REAL_ACCOUNT_VERIFIED', /REAL_ACCOUNT_VERIFIED/],
  ['persisted_snapshot', /persisted_snapshot/],
  ['evidence_status', /evidence_status/],
  ['report_id', /report_id/],
  ['schema', /schema/],
  ['OAuth', /OAuth/],
  ['API', /\bAPI\b/],
  ['idempotency_key', /idempotency_key/],
  ['content_hash', /content_hash/],
  // 内部状态码 / 层名（8.1 类目一：正文不展示内部状态码）。
  ['account_trade_completeness', /account_trade_completeness/],
  ['trade_plan_executability', /trade_plan_executability/],
  ['日报状态码', /\b(DATA_INSUFFICIENT|ILLUSTRATIVE|ACTIONABLE|NOT_READY|UNCONFIRMED_RISK)\b/],
  ['内部键 unreported_trade_risk', /unreported_trade_risk/],
  // 数据库表名（8.1 类目三：正文不得出现表名）。
  ['数据库表名', /\b(account_snapshot|account_event|account_baseline|account_meta|fund_daily|fund_adj|fund_basic|fund_share|research_journal|research_evidence|portfolio_risk_policy|plan_tracking|trade_cal|index_daily|daily_basic|stk_limit|quality_check|sync_log)\b/],
  // 内部模块 / 包标识（8.1 类目三：内部模块名称）。
  ['内部模块名', /\b(reportRenderer|researchBundle|dailyReport|evidenceModel|scenarios|researchSummary|portfolio\/[a-zA-Z]+)\b/],
  ['内部报告 ID', /\b(BUNDLE-[0-9a-f]{6,}|ASR-\d{8}-[A-Z0-9]{4,})\b/],
  // 规则版本号与运行标识前缀（8.1 类目四）。
  ['规则版本号', /(portfolio-drawdown-policy-\d|r1-industry-map-|r1-asset-stress-|chatgpt-intake-\d|research-journal-\d|ashare-[a-z-]+\/\d|FRZ-[0-9a-f]{6,}|render-[\d.]+|-1\.\d+\.\d+)/],
  ['环境变量前缀', /ASHARE_/],
];

function assertNoBannedTerms(user, label) {
  // 合流决策：renderer 导出的 forbiddenHits 是权威实现（其表正确处理
  // VERIFIED ⊂ UNVERIFIED 的子串双重命中问题），构建后优先使用；
  // renderer 缺位时退回本文件的离线镜像表（BANNED）。
  if (typeof renderer?.forbiddenHits === 'function') {
    const hits = renderer.forbiddenHits(user);
    assert.deepEqual(hits, [], `${label} 用户版正文泄露工程术语：${JSON.stringify(hits)}`);
    return;
  }
  for (const [name, pattern] of BANNED) {
    const hit = user.match(pattern);
    assert.equal(hit, null, `${label} 用户版正文泄露工程术语「${name}」：${hit?.[0] ?? ''}`);
  }
}

// 20261023 真实回放的 BUNDLE ID 占位常量（主控合流决策）：dailyReport 的
// decision_comparison 新增 risk_track/alpha_track/scenario_matrix 后，回放 report_id
// 的内容哈希会变；旧值 BUNDLE-20261023-89c7364f50fe48a016dd 已作废，任何金样断言都不得
// 硬编旧值。合流点 1 主控实际回放拿到新值后统一替换（或经 GOAL1026_REAL_BUNDLE_ID 注入）。
const REAL_REPLAY_BUNDLE_ID = process.env.GOAL1026_REAL_BUNDLE_ID ?? 'BUNDLE-20261023-37c7e373dad524da8f0a'; // 2026-10-26 真实回放值（v1-verify-final 构建）

/** 正文里的“重要数字”（带单位的钱与百分比）。 */
function importantNumbers(text) {
  const out = [];
  // 捕获前导负号（G9：正文「-9.50%」须与附件 §15 的 -9.5 对上）；不取绝对值——
  // 否则正文写正、附件写负的真符号错误也会放行，削弱一致性断言。
  for (const m of text.matchAll(/(-?)(\d[\d,]*(?:\.\d+)?)(万元|亿元|元|%|％)/g)) {
    const mag = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(mag)) continue;
    const scaled = m[3] === '万元' ? mag * 1e4 : m[3] === '亿元' ? mag * 1e8 : mag;
    out.push({ raw: m[0], value: m[1] ? -scaled : scaled, unit: m[3] });
  }
  return out;
}

/** 递归收集附件里的全部有限数值。 */
function attachmentNumbers(value, out = []) {
  if (Array.isArray(value)) { value.forEach(v => attachmentNumbers(v, out)); return out; }
  if (value && typeof value === 'object') { Object.values(value).forEach(v => attachmentNumbers(v, out)); return out; }
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  return out;
}

/** 量级变体匹配：容纳 毫/分/万元/百分比 口径差。 */
function numberMatches(userValue, attachmentValue) {
  const tol = v => Math.max(0.01, Math.abs(v) * 0.005);
  const scales = [1, 100, 1000, 1e4, 1e6, 0.01, 0.001, 1e-4, 1e-6];
  return scales.some(s => Math.abs(attachmentValue * s - userValue) <= tol(userValue));
}

/** 正文重要数字必须能在附件里找到出处（可追溯）；返回未匹配清单。 */
function untraceable(user, attachment) {
  const nums = attachmentNumbers(attachment);
  return importantNumbers(user).filter(n => !nums.some(a => numberMatches(n.value, a)));
}

function assertNumbersConsistent(user, attachment, label) {
  const missing = untraceable(user, attachment);
  assert.deepEqual(missing.map(n => n.raw), [],
    `${label} 正文数字在附件中找不到出处（不一致或不可追溯）：${missing.map(n => n.raw).join(', ')}`);
}

/** 十场景矩阵（任务书 10.5），供报告与文件头对照。 */
export const GOLDEN_SCENARIOS = [
  { id: 1, name: '正常交易日', fixture: 'normal' },
  { id: 2, name: '周末报告', fixture: 'weekend' },
  { id: 3, name: '市场数据未就绪', fixture: 'market-not-ready' },
  { id: 4, name: '账户未对账', fixture: 'account-unreconciled' },
  { id: 5, name: '五只ETF全部有行情', fixture: 'five-quotes' },
  { id: 6, name: '单只ETF缺行情', fixture: 'one-quote-missing' },
  { id: 7, name: '没有新增产业证据', fixture: 'no-new-evidence' },
  { id: 8, name: '重大财报公布', fixture: 'earnings-release' },
  { id: 9, name: '市场极端下跌', fixture: 'market-crash' },
  { id: 10, name: '市场快速反弹', fixture: 'market-rebound' },
];

// ================================================================ 场景 1：正常交易日

test('G1 正常交易日：结构完整、事实带来源、无未授权交易数量、渲染过禁词与可追溯', () => {
  seedMarket('normal');
  seedAccount('normal', { confirmed: true, completeness: true });
  const report = build('normal');
  assert.equal(report.as_of_trade_date, LAST);
  // buildActions 当前恒返回空动作（优势未验证不授权交易）：状态只能是
  // NO_ACTION / DATA_INSUFFICIENT / ILLUSTRATIVE，绝不能声称可执行。
  assert.ok(['NO_ACTION', 'ILLUSTRATIVE', 'DATA_INSUFFICIENT'].includes(report.status),
    `正常交易日不应直接可执行：${report.status}`);
  assert.equal(report.actionable, report.status === 'ACTIONABLE');
  assert.ok(report.first_section.count <= 3);
  // 每条事实都带来源与主张分类（推断不得伪装成事实）。
  for (const fact of report.fact_register) {
    assert.ok(fact.source, `${fact.id} 缺 source`);
    assert.ok(['FACT', 'UNVERIFIED'].includes(fact.claim_status));
  }
  // 持仓五只齐全，逐只给立场与反证（不遗漏反证）。
  assert.equal(report.holdings.length, 5);
  for (const holding of report.holdings) {
    assert.ok(['HOLD', 'REDUCE', 'ROTATE', 'WAIT'].includes(holding.stance));
    assert.ok(holding.counter_evidence.length > 0, `${holding.ts_code} 缺反证`);
    assert.ok(holding.reasons.length > 0, `${holding.ts_code} 缺理由`);
    assert.ok(holding.research.counter_thesis.length > 0 || holding.counter_evidence.length > 0,
      `${holding.ts_code} 研究切片缺反证`);
  }
  // 不生成未经授权的交易数量：未提供 researchScenario 时 REDUCE/ROTATE 不得带计划。
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  const rotate = report.decision_comparison.options.find(o => o.action === 'ROTATE');
  assert.equal(reduce.sell_plan, null, '未提供研究数量时不得凭空生成卖出计划');
  assert.equal(rotate.rotation_plan, null, '未提供研究数量时不得凭空生成轮动计划');
  assert.equal(reduce.quantity_basis, 'not_provided');
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  for (const leg of report.first_section.actions.flatMap(a => a.legs)) assert.equal(leg.executable, false);

  // Golden 渲染：禁词 + 数值一致 + 可追溯（renderer 构建后生效）。
  // bundle 经第二参兼容探测口传入：同一份事实同时供正文与附件绑定。
  const rendered = render(report, { bundle: bundle('normal') });
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G1');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G1');
  } else {
    assert.ok(true, '待合流绑定：reportRenderer 未构建，渲染断言见 G-W1-skip');
  }
});

test('G0 真实回放 report_id 走占位常量：旧 BUNDLE ID 作废，金样不硬编', () => {
  // 合流决策：decision_comparison 扩展（risk_track/alpha_track/scenario_matrix）后
  // 20261023 回放的 report_id 内容哈希会变。断言占位机制本身，防止旧值回流。
  assert.notEqual(REAL_REPLAY_BUNDLE_ID, 'BUNDLE-20261023-89c7364f50fe48a016dd',
    '旧回放 BUNDLE ID 已作废，不得作为金样断言值');
  assert.match(REAL_REPLAY_BUNDLE_ID, /^BUNDLE-20261023-/, REAL_REPLAY_BUNDLE_ID);
});

test('G-W1-skip 渲染与情景断言待合流绑定（reportRenderer / scenarios）', t => {
  if (renderer && scenarios) { t.skip('renderer 与 scenarios 已合入，G* 渲染断言生效'); return; }
  const missing = [!renderer && 'portfolio/reportRenderer.js', !scenarios && 'portfolio/scenarios.js'].filter(Boolean);
  t.skip(`待合流绑定：缺少 ${missing.join('、')}`);
});

// ================================================================ 场景 2：周末报告

test('G2 周末报告：会话判定为非交易日、目标日不前移、标题标明周末研究', () => {
  seedMarket('weekend');
  seedAccount('weekend', { confirmed: true, completeness: true });
  const weekendNow = new Date('2026-10-17T10:00:00+08:00'); // 周六
  const b = bundle('weekend', { now: weekendNow });
  // 会话判定为非交易日（周六日历行 is_open=0）。
  assert.equal(b.session.phase, 'NON_TRADING_DAY', JSON.stringify(b.session));
  // 目标日锚定最近收盘日，不前移到周末、不伪造周六为交易日。
  assert.equal(b.as_of_trade_date, LAST, '周末不得把目标日移到非交易日');
  const report = build('weekend', { asOf: LAST });
  assert.equal(report.as_of_trade_date, LAST);
  // 周末渲染：标题必须标“周末研究”，不得伪装成交易日收盘日报。
  const rendered = render(report, { now: '2026-10-17T10:00:00+08:00', bundle: b });
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G2');
    assert.match(rendered.user, /周末研究/, '周末报告必须标明“周末研究”');
    assert.doesNotMatch(rendered.user, /研究日报｜\d+月\d+日收盘/,
      '周末不得使用交易日收盘日报标题');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G2');
  }
});

// ================================================================ 场景 3：市场数据未就绪

test('G3 市场数据未就绪：旧行情不冒充新行情、DATA_INSUFFICIENT、不沿用上期动作', () => {
  seedMarket('market-not-ready', { missingDate: true });
  seedAccount('market-not-ready', { confirmed: true, completeness: true });
  const report = build('market-not-ready');
  assert.equal(report.status, 'DATA_INSUFFICIENT');
  assert.equal(report.actionable, false);
  assert.deepEqual(report.first_section.actions, []);
  assert.ok(report.first_section.observation_triggers.length >= 1, '数据不足必须给出补齐行情的触发条件');
  // 不把旧行情写成新行情：目标日没有基金行情就没有 ready 报价。
  assert.ok(!report.data_quality.quotes.ready.includes('159558.SZ'),
    `159558.SZ 在 ${LAST} 无行情，不得计入 ready`);
  assert.ok(
    report.data_quality.quotes.not_ready.includes('159558.SZ')
    || report.data_quality.quotes.missing.includes('159558.SZ')
    || report.data_quality.quotes.stale.includes('159558.SZ'),
    JSON.stringify(report.data_quality.quotes),
  );
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);

  // Bundle：核心行情缺失 → 状态非 READY，登记缺口，动作数为 0。
  const b = bundle('market-not-ready');
  assert.notEqual(b.status, 'READY', b.status);
  assert.ok(b.evidence_gaps.some(gap => ['etf_price', 'market_quality', 'session', 'market_report'].includes(gap.module)),
    JSON.stringify(b.evidence_gaps));
  assert.equal(b.portfolio.first_section.count, 0, '目标行情不可用时不得给出动作');
  const rendered = render(report, { bundle: b });
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G3');
    assert.match(rendered.user, /数据补齐前不给交易结论|未就绪|不足|无法/,
      '数据未就绪必须向用户明说');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G3');
  }
});

// ================================================================ 场景 4：账户未对账

test('G4 账户未对账：身份已确认但成交不完整 → 门控阻塞、风险披露不被吞掉', () => {
  seedMarket('account-unreconciled');
  // 身份已确认，但从未声明完整性（成交尚未核对）。
  seedAccount('account-unreconciled', { confirmed: true, completeness: false });
  const report = build('account-unreconciled', {
    scenario: { sellCode: '159558.SZ', sellQuantity: 1000, buyCode: '510300.SH', buyQuantity: 100 },
  });
  // 门控如实反映未对账，不粉饰。
  assert.equal(report.gate.satisfied, false, JSON.stringify(report.gate.reasons));
  assert.equal(report.gate.unreported_trade_risk, true);
  assert.ok(report.gate.reasons.some(r => r.code === 'account_completeness_undeclared'
    || r.code === 'unreported_trade_risk'),
  JSON.stringify(report.gate.reasons));
  // 即使用户给了研究数量，也不能成为可执行数量。
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  for (const leg of report.first_section.actions.flatMap(a => a.legs)) assert.equal(leg.executable, false);
  assert.notEqual(report.status, 'ACTIONABLE');
  // 风险维度以独立状态披露：结论哪怕 NO_ACTION 也不吞掉“未确认”。
  assert.equal(report.data_quality.tiers.account_trade_completeness.status, 'UNCONFIRMED_RISK');
  assert.equal(report.data_quality.tiers.trade_plan_executability.status, 'NOT_EXECUTABLE');

  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G4');
    // 隐藏术语 ≠ 隐藏风险：必须以自然语言披露未对账。
    assert.match(rendered.user, /成交核对未完成|尚未|核对|对账/,
      '账户未对账必须以自然语言披露，而不是省略');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G4');
  }
});

// ================================================================ 场景 5：五只 ETF 全部有行情

test('G5 五只ETF全部有行情：逐只带目标日日期与收盘价，附件与正文数值一致', () => {
  seedMarket('five-quotes');
  seedAccount('five-quotes', { confirmed: true, completeness: true });
  const report = build('five-quotes');
  const ready = new Set(report.data_quality.quotes.ready);
  for (const code of HOLDING_CODES) assert.ok(ready.has(code), `${code} 应有目标日行情`);
  assert.equal(report.holdings.length, 5);
  for (const holding of report.holdings) {
    assert.equal(holding.latest_bar_date, LAST, `${holding.ts_code} 行情日期必须等于目标交易日`);
    assert.ok(holding.price_milli > 0);
    assert.ok(holding.fact_meta.as_of, `${holding.ts_code} 缺 as_of`);
    assert.equal(holding.fact_meta.as_of, LAST, `${holding.ts_code} 事实日期必须是目标交易日`);
    assert.equal(holding.bar_quality, 'READY');
  }
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G5');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G5');
    // 正文引用的每只收盘价都能在附件定位（附件 §15 内嵌 etf_close_cny）。
    const embedded = rendered.attachment?.find?.(b => b && '15. 用户版内嵌数字' in b)?.['15. 用户版内嵌数字']
      ?? (Array.isArray(rendered.attachment) ? null : rendered.attachment?.['15. 用户版内嵌数字']);
    if (embedded) {
      const closes = embedded.etf_close_cny ?? [];
      assert.equal(closes.length, 5, '附件必须内嵌五只收盘价');
      for (const holding of report.holdings) {
        const price = holding.price_milli / 1000;
        assert.ok(closes.some(c => c !== null && numberMatches(price, c)),
          `${holding.ts_code} 收盘价 ${price} 在附件内嵌数字中缺失`);
      }
    }
  }
});

// ================================================================ 场景 6：单只 ETF 缺行情

test('G6 单只ETF缺行情：缺的那只标 WAIT 并点名，不把旧行情当日行情', () => {
  seedMarket('one-quote-missing', { staleCodes: ['159278.SZ'] });
  seedAccount('one-quote-missing', { confirmed: true, completeness: true });
  const report = build('one-quote-missing');
  assert.equal(report.status, 'DATA_INSUFFICIENT', '行情缺失不等于已证明继续持有最优');
  const stale = report.holdings.find(h => h.ts_code === '159278.SZ');
  assert.equal(stale.stance, 'WAIT');
  assert.notEqual(stale.latest_bar_date, LAST, '缺失行情不得冒充目标日行情');
  assert.ok(report.data_quality.tiers.etf_price.status === 'PARTIAL'
    || report.data_quality.quotes.not_ready.includes('159278.SZ'),
  JSON.stringify(report.data_quality.tiers.etf_price));
  // 其余四只照常列出，不整体静默。
  const others = report.holdings.filter(h => h.ts_code !== '159278.SZ');
  assert.equal(others.length, 4);
  for (const other of others) assert.ok(['HOLD', 'REDUCE', 'ROTATE', 'WAIT'].includes(other.stance));
  assert.deepEqual(report.first_section.actions, []);
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G6');
    assert.ok(rendered.user.includes('159278'), '缺行情的持仓必须点名披露');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G6');
  }
});

// ================================================================ 场景 7：没有新增产业证据

test('G7 没有新增产业证据：旧闻不冒充新证据、结论不升级', () => {
  seedMarket('no-new-evidence');
  seedAccount('no-new-evidence', { confirmed: true, completeness: true });
  const report = build('no-new-evidence');
  // 没有新证据 → 研究状态保持 UNVERIFIED（不升级为已验证事实）。
  assert.equal(report.market_judgement.research_status, 'UNVERIFIED');
  // 每条市场证据都带 as_of 与来源：旧闻只能以自己的日期出现。
  for (const item of [...report.market_judgement.counter_evidence, ...report.market_judgement.support_evidence]) {
    assert.ok(item.source, `${item.id} 缺 source`);
    if (item.as_of) assert.ok(String(item.as_of) <= LAST, `${item.id} 日期 ${item.as_of} 不得晚于目标交易日`);
  }
  // evidenceModel（A agent）：同一身份重复登记 → UNCHANGED，不计新证据；
  // novelty=BACKGROUND 的首登也不计新证据（重复旧闻不冒充催化剂）。
  if (evidenceModel?.registerEvidence) {
    const input = {
      evidence_id: 'EV-GOLDEN-OLDNEWS', claim: '合成旧闻：某公司此前披露的业绩预告',
      evidence_type: 'SECONDARY_NEWS', published_at: '2026-10-15T08:00:00+08:00',
      effective_as_of: PREV, target: '159558.SZ', source_url: 'https://example.com/news/old',
      retrieved_at: `${LAST.slice(0, 4)}-${LAST.slice(4, 6)}-${LAST.slice(6, 8)}T09:00:00+08:00`,
      context_novelty: 'NEW',
    };
    const now = new Date('2026-10-16T09:00:00+08:00');
    const first = evidenceModel.registerEvidence(new Map(), input, { now });
    assert.equal(first.outcome, 'NEW');
    const second = evidenceModel.registerEvidence(new Map([[first.entry.evidence_id, first.entry]]), input, { now });
    assert.equal(second.outcome, 'UNCHANGED', '同一旧闻重复检索不得计为新证据');
    assert.equal(second.counts_as_new_evidence, false);
    const background = evidenceModel.registerEvidence(new Map(),
      { ...input, evidence_id: 'EV-GOLDEN-BG', context_novelty: 'BACKGROUND' }, { now });
    assert.equal(background.counts_as_new_evidence, false, '历史背景材料不计新证据');
  } else {
    assert.ok(true, '待合流绑定：ashare/evidenceModel 未构建，状态推导断言未绑定');
  }
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G7');
    assert.doesNotMatch(rendered.user, /新增催化剂|全新利好|首次出现/, '无新增证据时不得宣称新催化剂');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G7');
  }
});

// ================================================================ 场景 8：重大财报公布

test('G8 重大财报公布：事实与推断分离、反证不省略、晚到公告不计入本期', () => {
  seedMarket('earnings-release', {
    reportPatch: { judgment: ['合成财报日：个股业绩披露集中，方向仍待验证'] },
  });
  seedAccount('earnings-release', { confirmed: true, completeness: true });
  const report = build('earnings-release');
  // 财报事实可以进 fact_register，但研究结论保持 UNVERIFIED（推断≠事实）。
  assert.equal(report.market_judgement.research_status, 'UNVERIFIED');
  for (const fact of report.fact_register) {
    assert.ok(['FACT', 'UNVERIFIED'].includes(fact.claim_status));
  }
  assert.equal(report.market_judgement.fact_meta.claim_status, 'UNVERIFIED',
    '市场判断整体是研究主张，不是已验证事实');
  // 持仓反证必须保留（8.5：不允许为了简洁省略关键反证）。
  const focus = report.holdings.find(h => h.ts_code === '159558.SZ');
  assert.ok(focus.counter_evidence.length > 0, '财报日更不得省略反证');
  assert.ok(focus.research.counter_thesis.length > 0 || focus.counter_evidence.length > 0);

  // evidenceModel 合流后：发布/检索时间晚于研究截止 → 拒绝或不计本期新证据。
  if (evidenceModel?.normalizeEvidence) {
    assert.throws(() => evidenceModel.normalizeEvidence({
      evidence_id: 'EV-GOLDEN-LATE', claim: '晚到公告', evidence_type: 'PRIMARY_FILING',
      published_at: '2026-10-17T08:00:00+08:00', // 晚于检索时刻
      retrieved_at: '2026-10-16T21:00:00+08:00',
    }, new Date('2026-10-16T21:00:00+08:00')),
    /published_at must not be later than retrieved_at/,
    '晚于研究截止的公告不得伪装成本期已取得的证据');
  } else {
    assert.ok(true, '待合流绑定：ashare/evidenceModel 未构建，发布时间门槛断言未绑定');
  }
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G8');
    assert.match(rendered.user, /显示|披露|公告|数据/, '财报事实应以事实措辞呈现');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G8');
  }
});

// ================================================================ 场景 9：市场极端下跌

test('G9 市场极端下跌：风险与反证不因 NO_ACTION 被忽略、压力损失不写成预测', () => {
  seedMarket('market-crash', {
    reportPatch: { crash: true, upRatio: 0.08, medianPct: -7.5, amountYi: 16000, amountMa20: 10000, indexRet5: -9.5, indexRet20: -12 },
    fundRowsPatch: (code, date, close) => (date === LAST ? Math.round(close * 0.905 * 1000) / 1000 : close),
  });
  seedAccount('market-crash', { confirmed: true, completeness: true });
  const report = build('market-crash');
  // 五只持仓仍逐只给出，反证/风险一条不少。
  assert.equal(report.holdings.length, 5);
  for (const holding of report.holdings) {
    assert.ok(holding.counter_evidence.length > 0, `${holding.ts_code} 极端下跌日必须给出反证/风险`);
    assert.ok(holding.reasons.length > 0);
  }
  assert.ok(report.market_judgement.counter_evidence.length > 0
    || report.holdings.every(h => h.counter_evidence.length > 0));
  // 极端下跌不得触发未经授权的卖出数量。
  const reduce = report.decision_comparison.options.find(o => o.action === 'REDUCE');
  assert.equal(reduce.sell_plan, null, '极端下跌不得触发未经授权的卖出计划');
  for (const option of report.decision_comparison.options) {
    assert.equal(option.executable, false);
    // 压力数字属于声明式假设：note 必须写明非预测。
    if (option.stress_after) assert.match(option.stress_after.note, /非预测|假设|声明式/);
  }
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G9');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G9');
    assert.match(rendered.user, /风险|回撤|下跌|压力/, '极端下跌日必须保留风险叙述');
  }
});

// ================================================================ 场景 10：市场快速反弹

test('G10 市场快速反弹：反弹是行情事实，不得写成优势已验证或自动轮动', () => {
  seedMarket('market-rebound', {
    reportPatch: { rebound: true, upRatio: 0.60, medianPct: 0.8, amountYi: 14000, amountMa20: 11000, indexRet5: 5.2, indexRet20: -1.0 },
    fundRowsPatch: (code, date, close) => (date === LAST ? Math.round(close * 1.06 * 1000) / 1000 : close),
  });
  seedAccount('market-rebound', { confirmed: true, completeness: true });
  const report = build('market-rebound');
  // 即便大涨，无相对优势证据仍不产生可执行动作、不自动生成轮动数量。
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  const rotate = report.decision_comparison.options.find(o => o.action === 'ROTATE');
  assert.equal(rotate.rotation_plan, null, '反弹不等于轮动优势，未给研究数量不得生成轮动计划');
  assert.equal(rotate.quantity_basis, 'not_provided');
  for (const leg of report.first_section.actions.flatMap(a => a.legs)) assert.equal(leg.executable, false);
  // 反弹日的行情事实带目标日日期（READY 的持仓必须锚定目标日）。
  for (const holding of report.holdings) {
    if (holding.bar_quality === 'READY') {
      assert.equal(holding.latest_bar_date, LAST, `${holding.ts_code} 行情事实缺目标日日期`);
      assert.equal(holding.fact_meta.as_of, LAST);
    }
  }
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G10');
    assert.doesNotMatch(rendered.user, /已验证优势|确认买入|建议立即/, '反弹日不得把推断写成事实或给出未授权指令');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G10');
  }
});

// ================================================================ 七情景 × 五方案矩阵（B agent scenarios 模块）

test('G11 七情景 × 五方案矩阵：五方案逐列同指标、全部假设非预测', () => {
  if (!scenarios) { assert.ok(true, '待合流绑定：src/portfolio/scenarios.ts 未构建'); return; }
  const rows = scenarios.SCENARIO_ROWS ?? [];
  assert.equal(rows.length, 7, '任务书 5.2 要求七个具名情景');
  for (const row of rows) {
    assert.equal(row.assumed, true, `${row.name} 的幅度必须声明为假设`);
    assert.ok(/不是预测|预固定|假设/.test(`${row.magnitude_basis}${row.assumption_note}`),
      `${row.name} 必须声明非预测`);
  }
  // 五方案 × 七情景矩阵：五方案逐列同指标（十列），费用分列，全部不可执行语义。
  const pos = ts_code => ({ ts_code, value: Math.round(BASE_CLOSE[ts_code] * HOLDING_QTY[ts_code] * 100), asset_class: 'EQUITY', theme: 'semiconductor_equipment', industry: '半导体' });
  const baseline = HOLDING_CODES.map(pos);
  const optionState = action => ({
    action, positions: baseline, cash_cents: 141370, wealth_cents: 0,
    funding_status: 'NO_TRADE', fee_breakdowns: [], cash_sufficient_for_one_lot: true,
    invalidation_conditions: ['合成失效条件'], unverified_information: ['合成未验证信息'],
  });
  const matrix = scenarios.buildScenarioMatrix({
    as_of_trade_date: LAST, baseline_positions: baseline,
    baseline_cash_cents: 141370, wealth_cents: 0,
    options: ['HOLD', 'REDUCE', 'ROTATE', 'DEFENSIVE', 'NO_ACTION'].map(optionState),
  });
  assert.equal(matrix.scenarios.length, 7);
  const required = ['total_assets_and_cash', 'equity_exposure', 'industry_concentration', 'hhi',
    'declared_stress_loss', 'upside_participation', 'trading_fees', 'funding_availability',
    'invalidation_conditions', 'unverified_information'];
  for (const row of matrix.scenarios) {
    assert.equal(row.assumed, true);
    for (const action of ['HOLD', 'REDUCE', 'ROTATE', 'DEFENSIVE', 'NO_ACTION']) {
      assert.ok(row.options[action], `${row.scenario_id} 缺方案 ${action}`);
      for (const field of required) assert.ok(field in row.options[action],
        `${row.scenario_id}/${action} 缺指标 ${field}`);
      // 费用分列：真实费用估计与滑点估计不得混为一谈。
      assert.ok('slippage_estimate_cents' in row.options[action].trading_fees);
      assert.ok('actual_fee_estimate_cents' in row.options[action].trading_fees);
    }
  }
  assert.match(matrix.magnitude_disclaimer, /不是预测/);
});

// ================================================================ 风险约束（10.3）

test('G12 NO_ACTION 不忽略已确认风险约束：政策触发/未触发都披露且绝不生成卖量', () => {
  seedMarket('risk-policy');
  seedAccount('risk-policy', { confirmed: true, completeness: true });
  const marketFile = join(dir, 'market-risk-policy.sqlite');
  const portfolioFile = join(dir, 'portfolio-risk-policy.sqlite');
  const id = 'golden-risk-policy';

  const db = openPortfolioDb(portfolioFile, { marketPath: marketFile });
  try {
    // 已确认政策：批准日 ≤ 目标日 → 加载；批准日 > 目标日 → 历史报告不可见。
    recordRiskPolicy(db, { account_id: id, approval_source: 'test-fixture', approved_on: LAST });
    const active = buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId: id, asOf: LAST });
    assert.ok(active, '批准日 ≤ 目标日时必须加载风险政策');
    assert.equal(active.action_boundary.sell_quantity, null);
    assert.equal(active.action_boundary.auto_trade, false);
    assert.equal(active.policy.auto_reduce, false);
    assert.equal(active.policy.auto_liquidate, false);
    assert.equal(buildPortfolioRiskState({ portfolioDb: db, marketDb: null, accountId: id, asOf: PREV }), null,
      '批准日之前的历史报告不得出现政策字段');
    // 回撤达到 L3 阈值 → 触发预警，但只触发复核，不产生卖出数量。
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
    assert.equal(triggered.warning.level, 'L3');
    assert.equal(triggered.warning.triggered, true);
    assert.equal(triggered.action_boundary.sell_quantity, null, '预警只触发研究复核，绝不生成卖出数量');
    assert.equal(triggered.action_boundary.auto_trade, false);
    assert.doesNotMatch(JSON.stringify(triggered), /"(sell_)?quantity":\s*[1-9]/);
  } finally { db.close(); }

  // 日报侧：NO_ACTION 不得吞掉风险披露（政策批准日 = 目标日，日报可加载）。
  const report = build('risk-policy');
  assert.ok(report.portfolio_risk, '政策生效时日报必须带 portfolio_risk 块');
  assert.ok(report.portfolio_risk.warning, '风险预警必须随报告披露，即使 status 是 NO_ACTION');
  assert.equal(report.portfolio_risk.action_boundary.sell_quantity, null);
  assert.notEqual(report.status, 'ACTIONABLE');
  for (const option of report.decision_comparison.options) assert.equal(option.executable, false);
  // 渲染层把风险块带进附件与正文（附件 §9 技术风险）。
  const rendered = render(report);
  if (rendered) {
    assertNoBannedTerms(rendered.user, 'G12');
    assertNumbersConsistent(rendered.user, rendered.attachment, 'G12');
    assert.match(rendered.user, /风险|回撤/, '已确认风险约束必须出现在正文');
  }
});
