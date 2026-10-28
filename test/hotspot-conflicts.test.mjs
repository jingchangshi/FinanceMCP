// goal-1028 §P6.1 技术策略与冲突场景离线回归：
//
// 1. MACD 底背离（P6.1 点名场景）：既有 signals.ts 检测器 → rv_macd_divergence
//    策略事件首触于可证伪的确认根；前缀扫描绝不提前暴露（无未来函数）；
//    第二低不深于第一低的对照序列不触发（缺失/不满足不编造成信号）。
// 2. 同一股票多个策略触发：一条序列同时产生跨族 ≥3 个策略事件，且每个
//    strategy_id 至多发射一次（emit-once）；风险项绝不混入入场事件。
// 3. 多个策略信号冲突：多头事件与空头风险叠加（risk_events）在同一扫描中
//    并存互不吞没；池排名按 risk×5 惩罚冲突股并如实记录公式 —— 惩罚只降
//    priority，绝不由风险改写池资格（降级 ≠ 排除）。
// 4. 信号失效条件：W 底确认后破位 → 策略事件翻转为 invalidated 并带失效日
//    与原因；破位日之前保持 active（不预知未来）。
// 5. 候选数量不足：极小 universe 上管线不崩溃，计数自洽、research_only、
//    哈希可算。
//
// 全离线：合成序列 + 合成 universe，无网络，不写生产库。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hotspot-conflict-'));
process.env.ASHARE_DATA_DIR = dir;
process.env.ASHARE_DB_PATH = join(dir, 'market.sqlite');

const { openAshareDb } = await import('../build/ashare/db.js');
const { ensureHotspotSchema } = await import('../build/ashare/hotspotTables.js');
const { weekdays, seedReferenceUniverse } = await import('./ashare-fixture.mjs');
const { computeIndicators } = await import('../build/ashare/indicators.js');
const { detectSignals } = await import('../build/ashare/signals.js');
const { detectStrategyEvents } = await import('../build/ashare/strategies.js');
const { runHotspotPipeline } = await import('../build/ashare/hotspotPipeline.js');
const { buildHotspotPool } = await import('../build/ashare/hotspotPool.js');

const DATES = weekdays('20250901', 160);
const AS_OF = DATES.at(-1);

// ---------------------------------------------------------------- 合成序列

const mkBars = (close, open, vol) => ({
  dates: DATES.slice(0, close.length),
  open, high: close.map(c => c + 0.5), low: close.map(c => c - 0.5),
  close, vol, amount: vol.map(v => v * 10), rawOpen: open, rawClose: close,
  upLimit: close.map(c => c * 1.1), adjMissing: 0,
});

/**
 * 崩溃 → 修复 → 更深的第二低（价更低、DIF 更高）→ 反弹。
 * 探针实测（computeIndicators + detectSignals）：trend_up@69、
 * trend_breakdown@81（风险）、macd_bull_divergence@97、
 * rsi_oversold_rebound@100；扫描产出 tc_ma_trend + rv_macd_divergence +
 * rv_rsi_oversold 三条多头事件与一条风险叠加。
 * shallowSecond=true 时第二低抬高至 62：既不深于第一低（54），也不深于
 * 41 处反弹起点窗口（否则 i>100 时历史窗滑出第一低后会配出另一组合法
 * 的"更深低点"），全扫描背离不成立（对照臂）。
 */
function s1({ shallowSecond = false } = {}) {
  const close = [], open = [], vol = [];
  const trough = shallowSecond ? 62 : 54;
  for (let i = 0; i < 130; i++) {
    let c;
    if (i < 20) c = 100;
    else if (i <= 40) c = 100 - 2.25 * (i - 20);
    else if (i <= 70) c = 55 + (95 - 55) * (i - 40) / 30;
    else if (i <= 95) c = 95 - (95 - trough) * (i - 70) / 25;
    else c = trough + Math.min(30, 1.2 * (i - 95));
    close.push(+c.toFixed(4));
    const falling = (i >= 20 && i <= 40) || (i >= 71 && i <= 95);
    open.push(+(falling ? c + 1 : c - 0.8).toFixed(4));
    vol.push(100000);
  }
  const b = mkBars(close, open, vol);
  return { b, x: computeIndicators(b), dates: b.dates };
}

const sliceBars = (b, i) => ({
  ...b, dates: b.dates.slice(0, i + 1), open: b.open.slice(0, i + 1),
  high: b.high.slice(0, i + 1), low: b.low.slice(0, i + 1), close: b.close.slice(0, i + 1),
  vol: b.vol.slice(0, i + 1), amount: b.amount.slice(0, i + 1),
  rawOpen: b.rawOpen.slice(0, i + 1), rawClose: b.rawClose.slice(0, i + 1),
  upLimit: b.upLimit.slice(0, i + 1),
});

// ---------------------------------------------------------------- 1. MACD 底背离

test('MACD 底背离：确认根首触 97、前缀不提前暴露、对照序列不触发', () => {
  const { b, x, dates } = s1();
  let first = null;
  for (let i = 61; i < b.dates.length; i++) {
    if (detectSignals(b, x, i).includes('macd_bull_divergence')) { first = i; break; }
  }
  assert.equal(first, 97, '背离首触于 97（可证伪锚点，改动序列须同步此值）');

  // 扫描级：97 之前不可见，97 起可见且确认根落在 97。
  const to96 = detectStrategyEvents('600000.SH', b, x, new Map(), 96);
  assert.ok(!to96.events.some(e => e.strategy_id === 'rv_macd_divergence'),
    '确认根之前的截断扫描绝不得暴露背离事件');
  const to97 = detectStrategyEvents('600000.SH', b, x, new Map(), 97);
  const div = to97.events.find(e => e.strategy_id === 'rv_macd_divergence');
  assert.ok(div, '97 起事件可见');
  assert.equal(div.confirmed_on, dates[97], '确认日 = 首触根，不回填形成低点');
  assert.equal(div.evidence.source_signal, 'macd_bull_divergence', '与既有检测器同源');
  assert.equal(div.status, 'active');
  assert.equal(div.direction, 'bullish');

  // 前缀不变性：截断序列在同一根上给出完全相同的判定（无未来函数）。
  const cut = sliceBars(b, 97);
  const cutX = computeIndicators(cut);
  assert.deepEqual(detectSignals(cut, cutX, 97), detectSignals(b, x, 97),
    'i=97 的信号判定在前缀与全序列上必须一致');

  // 对照：第二低不深于第一低 → 全扫描无背离（不满足条件不得编造）。
  const ctrl = s1({ shallowSecond: true });
  const ctrlScan = detectStrategyEvents('600000.SH', ctrl.b, ctrl.x, new Map(),
    ctrl.b.dates.length - 1);
  assert.ok(!ctrlScan.events.some(e => e.strategy_id === 'rv_macd_divergence'),
    '第二低不深于第一低的对照序列不得触发背离');
});

// --------------------------------------------- 2. 多策略触发 + RSI 超卖反弹

test('同一股票多个策略触发：趋势延续 + MACD 背离 + RSI 超卖反弹并存，每策略至多一次', () => {
  const { b, x, dates } = s1();
  const scan = detectStrategyEvents('600000.SH', b, x, new Map(), b.dates.length - 1);
  const ids = scan.events.map(e => e.strategy_id);
  for (const want of ['tc_ma_trend', 'rv_macd_divergence', 'rv_rsi_oversold']) {
    assert.ok(ids.includes(want), `${want} 应在同一股票上触发（实际: ${ids.join(',')}）`);
  }
  assert.ok(new Set(ids).size >= 2, '同一股票多个策略触发');
  for (const id of new Set(ids)) {
    assert.equal(ids.filter(v => v === id).length, 1, `${id} 每策略至多发射一次（emit-once）`);
  }
  const oversold = scan.events.find(e => e.strategy_id === 'rv_rsi_oversold');
  assert.equal(oversold.confirmed_on, dates[100], 'RSI 超卖反弹首触于 100');
  assert.ok(scan.events.every(e => e.direction === 'bullish'),
    '入场事件全为 bullish，风险项不得混入 events');

  // 三个族至少覆盖两个（TREND_CONTINUATION + REVERSAL），证明跨族并存。
  const families = new Set(scan.events.map(e => e.family));
  assert.ok(families.size >= 2, `跨族触发（实际族: ${[...families].join(',')}）`);
});

// ------------------------------------------------- 3. 冲突并存 + 池惩罚

test('多策略冲突：风险叠加与多头事件并存互不吞没，池排名惩罚冲突股且只降权不改资格', () => {
  // 引擎侧：S1 同一扫描里多头事件 active、风险事件在场，双方互不吞没。
  const { b, x } = s1();
  const scan = detectStrategyEvents('600000.SH', b, x, new Map(), b.dates.length - 1);
  assert.ok(scan.risk_events.length >= 1, '风险叠加被采集');
  const breakdown = scan.risk_events.find(r => r.id === 'trend_breakdown');
  assert.ok(breakdown, '第二段下跌产生 trend_breakdown 风险');
  assert.ok(scan.events.length >= 1, '多头事件仍在场（风险不吞事件）');
  assert.ok(!scan.events.some(e => e.direction === 'risk'),
    '风险项绝不作为入场事件（strategy-spec §2）');

  // 池侧：同一 universe 两次构建，唯一差异 = 给 600000.SH 注入一条风险。
  const db = openAshareDb();
  ensureHotspotSchema(db);
  seedReferenceUniverse(db, DATES);

  const eventFor = code => ({
    ts_code: code, strategy_id: 'tc_pullback_resume', strategy_version: 'st-tc-1.0.0',
    family: 'TREND_CONTINUATION', direction: 'bullish',
    confirmed_on: '20250920', formed_on: '20250916', confirmation_lag: 4,
    evidence: { note: 'fixture' }, invalidation_conditions: 'close < MA60',
    invalidation: null, status: 'active', risk_flags: [],
  });
  const mkScan = risks => codes => ({
    as_of: AS_OF,
    versions: { strategy_set: 't', patterns: 't', signals: 't', rps: 't' },
    results: codes.map(code => ({
      ts_code: code, bars: DATES.length,
      events: [eventFor(code)],
      risk_events: risks[code] ?? [],
    })),
    coverage: { requested: codes.length, scanned: codes.length,
      skipped_adj_missing: 0, skipped_insufficient: 0 },
  });
  const sectorSnapshot = {
    as_of: AS_OF, config_version: 'hotspot-config-test', sectors: [],
    selected: [], coverage: [],
  };
  const opts = { etfConstituents: () => [], etfCodes: [] };
  const clean = buildHotspotPool(db, AS_OF, sectorSnapshot, null,
    { ...opts, signalScanProvider: mkScan({}) });
  // 对照与注入目标都从 clean 结果动态发现：池只含市场龙头等真实种子，
  // 不预设某只代码必然在池中。
  const rankable = clean.candidates
    .filter(c => c.instrument_type === 'STOCK' && c.priority !== null);
  assert.ok(rankable.length >= 2, `需 ≥2 个可排序股票候选（实际 ${rankable.length}）`);
  const X = rankable[0].ts_code;
  const Y = rankable[1].ts_code;
  const conflicted = buildHotspotPool(db, AS_OF, sectorSnapshot, null, {
    ...opts,
    signalScanProvider: mkScan({ [X]: [{ id: 'trend_breakdown', on: '20250910' }] }),
  });

  const cX = clean.candidates.find(c => c.ts_code === X);
  const rX = conflicted.candidates.find(c => c.ts_code === X);
  const cY = clean.candidates.find(c => c.ts_code === Y);
  const rY = conflicted.candidates.find(c => c.ts_code === Y);
  assert.ok(cX && rX && cY && rY, '两次构建都包含注入与对照候选');

  // 1 条风险事件恰好扣 5 分（与 1 条信号同权），公式如实记录在 priority_reason。
  assert.ok(Math.abs((cX.priority - rX.priority) - 5) < 1e-9,
    `冲突股优先级恰好降 5（clean=${cX.priority}, risk=${rX.priority}, reason=${rX.priority_reason}）`);
  assert.match(rX.priority_reason, /signals\(1\)\*5 - risk\(1\)\*5/, '惩罚公式可见');
  assert.match(cX.priority_reason, /signals\(1\)\*5 - risk\(0\)\*5/, '无风险公式同样可见');
  // 无风险对照股两次完全一致（确定性）。
  assert.equal(cY.priority, rY.priority, '未注入风险的代码优先级不变');

  // 风险标注如实投影；惩罚只降权，绝不由风险直接改写池资格。
  assert.deepEqual(rX.risk_events, [{ id: 'trend_breakdown', on: '20250910' }]);
  assert.deepEqual(cX.risk_events, []);
  if (rX.pool !== cX.pool) {
    // 降级只允许经既有截止口径移出 FOCUS，绝不能以风险本身为排除理由。
    assert.equal(rX.pool, 'EXCLUDED', '风险至多导致移出 FOCUS/RAW');
    assert.ok(['below_focus_cutoff', 'industry_cap'].includes(rX.exclusion_reason),
      `风险降级只能经既有截止口径（实际 reason=${rX.exclusion_reason}）`);
  } else {
    assert.equal(rX.exclusion_reason ?? null, cX.exclusion_reason ?? null,
      '同池时排除理由不受风险影响');
  }
});

// ------------------------------------------------------- 4. W 底失效翻转

test('信号失效条件：W 底确认事件破位后翻转 invalidated，破位前保持 active', () => {
  const n = 120;
  const dates = weekdays('20250901', n);
  const close = new Array(n).fill(100);
  const b = {
    dates, open: close.slice(), high: close.map(c => c + 0.5), low: close.map(c => c - 0.5),
    close: close.slice(), vol: new Array(n).fill(100000), amount: new Array(n).fill(1e6),
    rawOpen: close.slice(), rawClose: close.slice(), upLimit: close.map(c => c * 1.1),
    adjMissing: 0,
  };
  // 与 hotspot-patterns 的 difW(invalidate) 同形：A@40(-1.0) → 颈线 0.2@55 →
  // B@70(-0.9) → 75 上穿确认 → 100 破双底(-1.1)。
  const dif = new Array(n).fill(0);
  for (let i = 0; i <= 40; i++) dif[i] = -(i / 40);
  for (let i = 41; i <= 55; i++) dif[i] = -1 + 1.2 * ((i - 40) / 15);
  for (let i = 56; i <= 70; i++) dif[i] = 0.2 - 1.1 * ((i - 55) / 15);
  for (let i = 71; i < n; i++) dif[i] = -0.9 + (i - 70) * 0.05;
  dif[75] = 0.3; dif[74] = 0.15;
  for (let i = 76; i < n; i++) dif[i] = 0.3 + (i - 75) * 0.01;
  dif[100] = -1.1;
  for (let i = 101; i < n; i++) dif[i] = -1.0 + (i - 100) * 0.01;

  const nan = () => new Array(n).fill(NaN);
  const x = {
    dif, dea: nan(), ma5: nan(), ma20: nan(), ma60: nan(), rsi14: nan(), rsi6: nan(),
    cci14: nan(), volMa20: nan(), high20: nan(), bollUp: nan(), bollWidth: nan(),
  };

  // 破位不可见时（i=99）：事件 active、无失效记录（不预知 100 的破位）。
  const before = detectStrategyEvents('600000.SH', b, x, new Map(), 99);
  const ev99 = before.events.find(e => e.strategy_id === 'rv_macd_w_bottom');
  assert.ok(ev99, '75 颈线确认后事件在场');
  assert.equal(ev99.status, 'active');
  assert.equal(ev99.confirmed_on, dates[75], '确认日 = 颈线上穿根');
  assert.equal(ev99.formed_on, dates[70], '成形日 = 第二低');
  assert.equal(ev99.confirmation_lag, 5, '确认滞后 = 75 − 70');
  assert.equal(ev99.invalidation, null, '破位尚不可见 → 无失效记录');

  // 破位根存在后（i=119）：翻转 invalidated，带失效日与原因；emit-once 仍成立。
  const after = detectStrategyEvents('600000.SH', b, x, new Map(), 119);
  const wEvents = after.events.filter(e => e.strategy_id === 'rv_macd_w_bottom');
  assert.equal(wEvents.length, 1, '失效后不得重复发射');
  const ev119 = wEvents[0];
  assert.equal(ev119.status, 'invalidated');
  assert.ok(ev119.invalidation, '失效记录存在');
  assert.equal(ev119.invalidation.on, dates[100], '失效日 = 破位根');
  assert.match(ev119.invalidation.reason, /fell below/, '失效原因可读');
});

// --------------------------------------------------- 5. 候选数量不足

test('候选数量不足：极小 universe 上管线诚实降级，计数自洽、research_only', () => {
  const shortDir = mkdtempSync(join(tmpdir(), 'hotspot-short-'));
  const db2 = openAshareDb(join(shortDir, 'market.sqlite'));
  ensureHotspotSchema(db2);
  const dates = weekdays('20250901', 160);
  seedReferenceUniverse(db2, dates, { stocks: 3 });

  const res = runHotspotPipeline(db2, dates.at(-1), { persist: false });
  const snap = res.snapshot;
  const stocks = snap.candidates.filter(c => c.instrument_type === 'STOCK');
  const etfs = snap.candidates.filter(c => c.instrument_type === 'ETF');
  assert.ok(stocks.length <= 3, `股票候选不得超过 universe（${stocks.length}）`);
  assert.equal(snap.counts.etf_candidates, etfs.length, 'ETF 计数与候选数组一致');
  // raw(股票非排除) + excluded(任意类型排除) 必须覆盖全部股票候选加上
  // 被排除的 ETF（ETF 恒 RAW，但公式不依赖该实现细节）。
  assert.equal(snap.counts.raw_pool + snap.counts.excluded,
    stocks.length + etfs.filter(e => e.pool === 'EXCLUDED').length,
    '池计数自洽：raw + excluded 覆盖全部股票候选与被排除的 ETF');
  assert.ok(snap.counts.focus_pool <= snap.counts.raw_pool, 'FOCUS ⊆ RAW 口径');
  assert.equal(snap.research_only, true, '恒为研究产物，不是交易授权');
  assert.match(snap.content_hash, /^sha256:[0-9a-f]{64}$/, '内容哈希可算');
  for (const c of stocks) assert.ok(Array.isArray(c.risk_events), 'risk_events 字段随候选投影');
  assert.equal(res.saved, null, 'persist:false 不落盘');
  db2.close();
  rmSync(shortDir, { recursive: true, force: true });
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
